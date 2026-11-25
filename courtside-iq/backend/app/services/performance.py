"""Prediction-archive analytics. Only settled, pre-game ("official") forecasts are scored:
for each (game, market, player) the latest prediction whose data_as_of precedes tip-off."""
from __future__ import annotations

from collections import defaultdict
from datetime import timezone

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from ..ml import metrics as M
from .odds_math import profit_units


def official_predictions(db: Session, league: str | None = None, include_pending: bool = False) -> pd.DataFrame:
    q = (select(m.Prediction, m.Game, m.ModelVersion.version)
         .join(m.Game, m.Game.id == m.Prediction.game_id)
         .join(m.ModelVersion, m.ModelVersion.id == m.Prediction.model_version_id))
    if league:
        q = q.where(m.Prediction.league == league)
    teams = {t.id: t for t in db.scalars(select(m.Team))}
    players = {p.id: p.full_name for p in db.scalars(select(m.Player))}
    confs = {c.id: c.short_name for c in db.scalars(select(m.Conference))}
    rows = []
    for p, g, ver in db.execute(q).all():
        st = g.start_time if g.start_time.tzinfo else g.start_time.replace(tzinfo=timezone.utc)
        da = p.data_as_of if p.data_as_of.tzinfo else p.data_as_of.replace(tzinfo=timezone.utc)
        if da > st:
            continue  # not a pre-game forecast
        ht, at = teams[g.home_team_id], teams[g.away_team_id]
        sel_team = ht if p.selection == "home" else at if p.selection == "away" else None
        rows.append(dict(
            id=p.id, created_at=p.created_at, data_as_of=da, start_time=st, league=p.league, game_id=g.id,
            market=p.market, market_group="prop" if p.market.startswith("prop_") else p.market,
            selection=p.selection, line=p.line, predicted_prob=p.predicted_prob, predicted_value=p.predicted_value,
            price=p.price_american, result=p.result, actual_value=p.actual_value, model_version=ver,
            player_id=p.player_id, player=players.get(p.player_id), home=ht.abbreviation, away=at.abbreviation,
            home_team_id=ht.id, away_team_id=at.id, selection_team=sel_team.abbreviation if sel_team else None,
            home_conf=confs.get(ht.conference_id), away_conf=confs.get(at.conference_id), is_demo=p.is_demo,
            mode=(p.details or {}).get("mode"),
        ))
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df = df.sort_values("data_as_of").groupby(["game_id", "market", "player_id"], dropna=False).tail(1)
    if not include_pending:
        df = df[df["result"].isin(["win", "loss", "push"])]
    return df


def _block(d: pd.DataFrame) -> dict:
    dec = d[d["result"].isin(["win", "loss"])]
    n, w = len(dec), int((dec["result"] == "win").sum())
    y = (dec["result"] == "win").astype(float).values
    p = dec["predicted_prob"].values
    lo, hi = M.wilson_interval(w, n)
    priced = d[d["price"].notna()]
    units = float(sum(profit_units(r, int(pr)) for r, pr in zip(priced["result"], priced["price"])))
    out = dict(n=int(len(d)), decided=n, wins=w, losses=n - w, pushes=int((d["result"] == "push").sum()),
               win_pct=w / n if n else None, win_pct_ci=[lo, hi], avg_pred_prob=float(p.mean()) if n else None,
               brier=M.brier(p, y) if n else None, log_loss=M.log_loss(p, y) if n else None,
               ece=M.ece(p, y) if n >= 20 else None, priced_n=int(len(priced)),
               units=units if len(priced) else None, roi=units / len(priced) if len(priced) else None)
    return out


def summary(db: Session, league: str | None = None) -> dict:
    df = official_predictions(db, league)
    allp = official_predictions(db, league, include_pending=True)
    if df.empty:
        return dict(total=dict(n=0), pending=int(len(allp)), by_market={}, note="No settled pre-game predictions yet.")
    out = dict(total=_block(df), pending=int((allp["result"] == "pending").sum()) if not allp.empty else 0,
               by_market={k: _block(v) for k, v in df.groupby("market_group")},
               by_market_detail={k: _block(v) for k, v in df.groupby("market")},
               by_league={k: _block(v) for k, v in df.groupby("league")},
               over_under={k: _block(v) for k, v in df[df["selection"].isin(["over", "under"])].groupby("selection")},
               is_demo=bool(df["is_demo"].any()))
    dec = df[df["result"].isin(["win", "loss"])]
    out["calibration"] = M.reliability(dec["predicted_prob"].values, (dec["result"] == "win").astype(float).values)
    by_month = dec.assign(month=dec["start_time"].dt.strftime("%Y-%m")).groupby("month")
    out["monthly"] = [dict(month=k, **_block(v)) for k, v in by_month]
    dec = dec.sort_values("start_time")
    hits = (dec["result"] == "win").astype(float)
    win = max(30, min(300, len(dec) // 8))
    roll = hits.rolling(win, min_periods=max(10, win // 3)).mean()
    step = max(1, len(dec) // 120)
    out["rolling_window"] = win
    out["rolling"] = [dict(t=str(t), rate=float(r), n=int(i + 1)) for i, (t, r) in enumerate(zip(dec["start_time"], roll)) if not np.isnan(r)][::step]
    cum = np.cumsum([profit_units(r, int(p)) if p == p and p is not None else 0 for r, p in zip(dec["result"], dec["price"])])
    out["cumulative_units"] = [dict(t=str(t), units=float(u)) for t, u in zip(dec["start_time"], cum)][::step]
    return out


def breakdown(db: Session, by: str, league: str | None = None, min_n: int = 5) -> list[dict]:
    df = official_predictions(db, league)
    if df.empty:
        return []
    groups: dict[str, pd.DataFrame] = {}
    if by == "team":
        g = df[df["market_group"] != "prop"]
        keys = defaultdict(list)
        for idx, r in g.iterrows():
            keys[r["home"]].append(idx)
            keys[r["away"]].append(idx)
        groups = {k: g.loc[v] for k, v in keys.items()}
    elif by == "player":
        groups = dict(tuple(df[df["player"].notna()].groupby("player")))
    elif by == "conference":
        g = df[df["league"] == "CBB"]
        keys = defaultdict(list)
        for idx, r in g.iterrows():
            for c in {r["home_conf"], r["away_conf"]}:
                if c:
                    keys[c].append(idx)
        groups = {k: g.loc[v] for k, v in keys.items()}
    elif by == "market":
        groups = dict(tuple(df.groupby("market")))
    rows = [dict(key=k, **_block(v)) for k, v in groups.items() if len(v) >= min_n]
    return sorted(rows, key=lambda r: -(r["n"]))


def recent(db: Session, limit: int = 30, league: str | None = None) -> list[dict]:
    df = official_predictions(db, league, include_pending=True)
    if df.empty:
        return []
    df = df.sort_values("start_time", ascending=False).head(limit)
    return [{k: (v.isoformat() if hasattr(v, "isoformat") else (None if isinstance(v, float) and np.isnan(v) else v))
             for k, v in r.items()} for r in df.to_dict("records")]


def clv_report(db: Session, league: str | None = None) -> dict:
    """Closing line value of archived pre-game forecasts vs the final pre-tip consensus.

    spread: points gained on the selected side (archived line - closing line for that side)
    total:  over -> close - archived; under -> archived - close
    moneyline: closing no-vig probability of the side minus the implied probability of the
               archived price (positive = the price was better than the close)
    """
    from .market import consensus
    from .odds_math import implied_prob

    df = official_predictions(db, league, include_pending=True)
    if df.empty:
        return dict(markets={}, n=0)
    df = df[df["market"].isin(["spread", "total", "moneyline"])]
    closes: dict[int, dict] = {}
    rows = []
    for r in df.itertuples():
        if r.game_id not in closes:
            closes[r.game_id] = consensus(db, r.game_id, as_of=r.start_time)
        c = closes[r.game_id]
        clv = None
        if r.market == "spread" and r.line is not None and c.get("spread_home") is not None:
            close_side = c["spread_home"] if r.selection == "home" else -c["spread_home"]
            clv = r.line - close_side
        elif r.market == "total" and r.line is not None and c.get("total") is not None:
            clv = (c["total"] - r.line) if r.selection == "over" else (r.line - c["total"])
        elif r.market == "moneyline" and r.price == r.price and r.price is not None and c.get("no_vig_home") is not None:
            p_close = c["no_vig_home"] if r.selection == "home" else c["no_vig_away"]
            clv = p_close - implied_prob(int(r.price))
        if clv is not None:
            rows.append(dict(market=r.market, clv=float(clv), result=r.result, start=r.start_time))
    d = pd.DataFrame(rows)
    if d.empty:
        return dict(markets={}, n=0)
    out = {}
    for mk, g in d.groupby("market"):
        se = float(g["clv"].std(ddof=1) / np.sqrt(len(g))) if len(g) > 1 else None
        out[mk] = dict(n=int(len(g)), avg_clv=float(g["clv"].mean()), se=se, beat_close=float((g["clv"] > 0).mean()),
                       matched_close=float((g["clv"] == 0).mean()), unit="probability" if mk == "moneyline" else "points")
    return dict(markets=out, n=int(len(d)),
                note="Forecast lines are frozen before tip-off; the closing line is the consensus of each book's last pre-tip snapshot.")
