"""Model diagnostics: where and why forecasts missed.

Findings are aggregated (never from single games) and each carries its sample size and a
standard-error based flag. They inform feature engineering and retraining decisions; the
system never auto-modifies models from these results.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from ..ml import metrics as M
from .performance import official_predictions

MIN_N = 25


def _flag(errors: np.ndarray, label: str, unit: str) -> dict:
    n = len(errors)
    mean = float(np.mean(errors)) if n else 0.0
    se = float(np.std(errors, ddof=1) / np.sqrt(n)) if n > 1 else float("inf")
    sig = n >= MIN_N and abs(mean) > 2 * se
    return dict(label=label, n=n, mean_error=mean, se=se, systematic=bool(sig), unit=unit,
                verdict=("systematic bias (|mean| > 2·SE) — candidate for feature/calibration work" if sig else
                         "insufficient sample" if n < MIN_N else "consistent with noise"))


def analyze(db: Session, league: str | None = None) -> dict:
    df = official_predictions(db, league)
    if df.empty:
        return dict(findings=[], note="No settled predictions to diagnose yet.")
    findings = []
    games = df[df["market"].isin(["total", "spread", "moneyline"])]
    # pace / total errors
    tot = df[df["market"] == "total"].dropna(subset=["actual_value"])
    if len(tot):
        err = (tot["predicted_value"] - tot["actual_value"]).values
        findings.append(dict(kind="total_bias", question="Was the projected total (pace × efficiency) too high or low?",
                             **_flag(err, "Full-game total: projected − actual", "pts")))
        gids = tot["game_id"].tolist()
        pace = _pace_errors(db, gids)
        if pace is not None and len(pace):
            findings.append(dict(kind="pace", question="Did teams play faster/slower than projected?",
                                 **_flag(pace, "Projected pace − actual possessions", "poss")))
    sp = df[df["market"] == "spread"].dropna(subset=["actual_value"])
    if len(sp):
        err = (sp["predicted_value"] - sp["actual_value"]).values
        findings.append(dict(kind="margin_bias", question="Is the projected margin biased toward home teams?",
                             **_flag(err, "Projected home margin − actual", "pts")))
    # calibration by market
    for mk, g in df.groupby("market_group"):
        dec = g[g["result"].isin(["win", "loss"])]
        if len(dec) >= MIN_N:
            p, y = dec["predicted_prob"].values, (dec["result"] == "win").astype(float).values
            gap = float(p.mean() - y.mean())
            se = float(np.sqrt(y.mean() * (1 - y.mean()) / len(y))) or 1e-9
            findings.append(dict(kind="calibration", label=f"{mk}: mean predicted − observed hit rate", n=len(dec), mean_error=gap,
                                 se=se, ece=M.ece(p, y), systematic=bool(abs(gap) > 2 * se), unit="prob",
                                 question="Was the predicted distribution poorly calibrated?",
                                 verdict="overconfident" if gap > 2 * se else "underconfident" if gap < -2 * se else "consistent with noise"))
    # props: minutes surprises
    pr = df[df["market_group"] == "prop"]
    if len(pr):
        mins = _minutes_errors(db, pr)
        if mins is not None and len(mins):
            findings.append(dict(kind="minutes", question="Did unexpected minutes drive prop misses?",
                                 **_flag(mins["err"].values, "Projected − actual minutes", "min"),
                                 miss_share_large_minutes_error=float(((mins["abs_err"] > 6) & (mins["result"] == "loss")).sum() / max(1, (mins["result"] == "loss").sum()))))
    # conference breakdown (CBB)
    cbb = games[games["league"] == "CBB"].dropna(subset=["actual_value"])
    conf_rows = []
    for conf in sorted(set(cbb["home_conf"].dropna()) | set(cbb["away_conf"].dropna())):
        g = cbb[(cbb["home_conf"] == conf) | (cbb["away_conf"] == conf)]
        g = g[g["market"] == "total"]
        if len(g) >= 5:
            e = (g["predicted_value"] - g["actual_value"]).values
            conf_rows.append(dict(conference=conf, n=len(g), mae=float(np.mean(np.abs(e))), bias=float(np.mean(e)),
                                  flag=_flag(e, conf, "pts")["verdict"]))
    # injuries assumption check (games with reported injury impact)
    inj = _injury_split(db, tot) if len(tot) else None
    return dict(findings=findings, conference_errors=sorted(conf_rows, key=lambda r: -r["mae"]), injury_split=inj,
                min_sample=MIN_N, policy="Diagnostics inform research only; models are never changed automatically from individual losses or small samples.")


def _pace_errors(db: Session, game_ids: list[int]):
    preds = {p.game_id: p for p in db.scalars(select(m.Prediction).where(m.Prediction.game_id.in_(game_ids), m.Prediction.market == "total"))}
    stats = db.scalars(select(m.TeamGameStat).where(m.TeamGameStat.game_id.in_(game_ids), m.TeamGameStat.is_home.is_(True))).all()
    from .modeling import features_cache

    out = []
    leagues = {g.id: g.league for g in db.scalars(select(m.Game).where(m.Game.id.in_(game_ids)))}
    frames = {lg: features_cache.get(db, lg).set_index("id") for lg in set(leagues.values())}
    for s in stats:
        f = frames[leagues[s.game_id]]
        if s.game_id in f.index and s.game_id in preds:
            out.append(float(f.loc[s.game_id, "exp_pace"]) - s.possessions)
    return np.array(out)


def _minutes_errors(db: Session, pr: pd.DataFrame):
    rows = []
    for r in pr.itertuples():
        p = db.get(m.Prediction, r.id)
        st = db.scalar(select(m.PlayerGameStat).where(m.PlayerGameStat.game_id == r.game_id, m.PlayerGameStat.player_id == r.player_id))
        if st and p.details and "minutes" in p.details:
            e = p.details["minutes"] - st.minutes
            rows.append(dict(err=e, abs_err=abs(e), result=r.result))
    return pd.DataFrame(rows) if rows else None


def _injury_split(db: Session, tot: pd.DataFrame):
    rows = []
    for r in tot.itertuples():
        g = db.get(m.Game, r.game_id)
        ctx = g.pregame_context or {}
        inj = (ctx.get("home", {}) or {}).get("injury_impact", 0) + (ctx.get("away", {}) or {}).get("injury_impact", 0)
        rows.append(dict(inj=inj > 0, abs_err=abs(r.predicted_value - r.actual_value)))
    d = pd.DataFrame(rows)
    if d.empty:
        return None
    return {("with_injury_news" if k else "no_injury_news"): dict(n=len(v), mae=float(v["abs_err"].mean())) for k, v in d.groupby("inj")}
