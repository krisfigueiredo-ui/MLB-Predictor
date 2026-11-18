"""Model registry, training orchestration, game/prop projections and the prediction archive."""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from ..config import get_settings
from ..ml import game_model as GM
from ..ml import props_model as PM
from . import market
from .dataset import feature_frame
from .odds_math import expected_value, fair_american, no_vig_two_way

log = logging.getLogger(__name__)
_cache: dict[int, object] = {}
_lock = threading.Lock()


def _data_source(df: pd.DataFrame) -> str:
    if "is_historical_sim" in df and df["is_historical_sim"].all():
        return "synthetic_demo"
    return "mixed" if "is_historical_sim" in df and df["is_historical_sim"].any() else "real"


def player_logs(db: Session, league: str) -> pd.DataFrame:
    q = (select(m.PlayerGameStat, m.Game.start_time, m.Game.home_team_id, m.Game.season)
         .join(m.Game, m.Game.id == m.PlayerGameStat.game_id).where(m.Game.league == league))
    rows = []
    for s, st, home, season in db.execute(q).all():
        d = {c: getattr(s, c) for c in ("game_id", "player_id", "team_id", "minutes", "pts", "reb", "ast", "fg3m", "stl", "blk")}
        d.update(start_time=pd.Timestamp(st) if st.tzinfo else pd.Timestamp(st).tz_localize("UTC"), home_team_id=home, season=season)
        rows.append(d)
    return pd.DataFrame(rows)


def train_league(db: Session, league: str, cutoff: datetime | None = None) -> dict:
    """Train game (+props when player logs exist) models on games completed before `cutoff`.

    The default cutoff is the start of the current season so the current season can be
    evaluated prospectively (walk-forward) with no leakage.
    """
    ff = feature_frame(db, league)
    if ff.empty:
        raise ValueError(f"no {league} games available")
    if cutoff is None:
        cur = ff[~ff["is_historical_sim"]]
        cutoff = cur["start_time"].min() if not cur.empty and ff["is_historical_sim"].any() else ff["start_time"].max()
    train_df = ff[(ff["start_time"] < pd.Timestamp(cutoff)) & ff["y_margin"].notna()]
    src = _data_source(train_df)
    gb = GM.train_game_model(train_df, league, src)
    path = GM.save_bundle(gb)
    with _lock:
        for mv in db.scalars(select(m.ModelVersion).where(m.ModelVersion.league == league, m.ModelVersion.name == "game")):
            mv.is_active = False
        mv = m.ModelVersion(league=league, name="game", version=gb.version,
                            algorithm="LightGBM+CatBoost residual ensemble on efficiency baseline; MC bivariate-normal; isotonic win calibration",
                            train_start=pd.Timestamp(gb.train_start).to_pydatetime(), train_end=pd.Timestamp(gb.train_end).to_pydatetime(),
                            n_train=gb.n_train, data_source=src, metrics=_jsonable(gb.metrics),
                            params=dict(lgb=GM.LGB_PARAMS, cat=GM.CAT_PARAMS, xgb_benchmark=GM.XGB_PARAMS),
                            features=gb.features, artifact_path=path, is_active=True)
        db.add(mv)
        db.commit()
        _cache[mv.id] = gb
    out = {"game": gb.version, "data_source": src, "n_train": gb.n_train}
    logs = player_logs(db, league)
    if not logs.empty and len(logs) > 500:
        pf = PM.player_frame(logs, ff, league)
        pf = pf[pf["start_time"] < pd.Timestamp(cutoff)]
        pb = PM.train_props_model(pf, league, src)
        ppath = GM.save_bundle(pb)
        for old in db.scalars(select(m.ModelVersion).where(m.ModelVersion.league == league, m.ModelVersion.name == "props")):
            old.is_active = False
        pmv = m.ModelVersion(league=league, name="props", version=pb.version,
                             algorithm="LightGBM minutes -> shrunk per-minute rates -> NegBin MC with shared game-flow",
                             n_train=pb.n_train, data_source=src, metrics=_jsonable(pb.metrics),
                             params=dict(dispersion=pb.dispersion, sigma_minutes=pb.sigma_minutes, flow_k=pb.flow_k),
                             features=PM.MIN_FEATURES, artifact_path=ppath, is_active=True)
        db.add(pmv)
        db.commit()
        _cache[pmv.id] = pb
        out["props"] = pb.version
    return out


def _jsonable(x):
    if isinstance(x, dict):
        return {k: _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_jsonable(v) for v in x]
    if isinstance(x, (np.floating, np.integer)):
        return x.item()
    if isinstance(x, (pd.Timestamp, datetime)):
        return x.isoformat()
    return x


def active_version(db: Session, league: str, name: str = "game") -> m.ModelVersion | None:
    return db.scalar(select(m.ModelVersion).where(m.ModelVersion.league == league, m.ModelVersion.name == name,
                                                  m.ModelVersion.is_active.is_(True)).order_by(m.ModelVersion.id.desc()))


def load(mv: m.ModelVersion):
    with _lock:
        if mv.id not in _cache:
            _cache[mv.id] = GM.load_bundle(mv.artifact_path)
        return _cache[mv.id]


# ---------------- projections ----------------

class FeatureCache:
    """Feature frames are recomputed when the set of final games changes."""

    def __init__(self):
        self._data: dict[str, tuple[int, pd.DataFrame]] = {}

    def get(self, db: Session, league: str) -> pd.DataFrame:
        from sqlalchemy import func

        key = db.scalar(select(func.count(m.Game.id)).where(m.Game.league == league, m.Game.status == "final")) or 0
        hit = self._data.get(league)
        if hit and hit[0] == key:
            return hit[1]
        ff = feature_frame(db, league)
        self._data[league] = (key, ff)
        return ff


features_cache = FeatureCache()


def project_game(db: Session, game: m.Game, n_sims: int | None = None, explain: bool = True,
                 as_of: datetime | None = None) -> dict | None:
    mv = active_version(db, game.league)
    if mv is None:
        return None
    bundle = load(mv)
    ff = features_cache.get(db, game.league)
    row = ff[ff["id"] == game.id]
    if row.empty:
        return None
    pt = bundle.point(row)
    settings = get_settings()
    n = n_sims or settings.monte_carlo_sims
    cons = market.consensus(db, game.id, as_of=as_of)
    post = bundle.posterior(float(pt["margin"][0]), float(pt["total"][0]), float(pt["h1_total"][0]),
                            cons.get("spread_home"), cons.get("total")) if hasattr(bundle, "posterior") else None
    if post:
        sims = bundle.simulate(post["margin"], post["total"], post["h1_total"], n, seed=settings.random_seed + game.id,
                               sigma_margin=post["sigma_margin"], sigma_total=post["sigma_total"])
    else:
        sims = bundle.simulate(float(pt["margin"][0]), float(pt["total"][0]), float(pt["h1_total"][0]), n,
                               seed=settings.random_seed + game.id)
    summary = GM.summarize_sims(sims, cons.get("spread_home"), cons.get("total"), cons.get("h1_total"), bundle.calibrator)
    tt = {}
    for side in ("home", "away"):
        ln = cons.get(f"team_total_{side}")
        if ln is not None:
            x = sims[side]
            tt[side] = dict(line=ln, mean=float(x.mean()), p_over=float((x > ln).mean()), p_under=float((x < ln).mean()),
                            p_push=float((x == ln).mean()))
    summary["team_totals"] = tt
    out = dict(
        game_id=game.id, model_version=mv.version, model_data_source=mv.data_source, seed=settings.random_seed + game.id,
        projected=dict(margin=float(pt["margin"][0]), total=float(pt["total"][0]), h1_total=float(pt["h1_total"][0]),
                       home_score=float((pt["total"][0] + pt["margin"][0]) / 2),
                       away_score=float((pt["total"][0] - pt["margin"][0]) / 2),
                       spread_home=-float(pt["margin"][0])),
        simulation=summary, market=cons, posterior=post,
        features={k: float(row.iloc[0][k]) for k in bundle.features},
    )
    out["vs_market"] = market_comparison(out, cons)
    if explain:
        out["explain"] = dict(margin=GM.explain(bundle, row, "margin"), total=GM.explain(bundle, row, "total"))
    return out


def market_comparison(proj: dict, cons: dict) -> dict:
    s = proj["simulation"]
    res = {}
    if cons.get("ml_home") and cons.get("ml_away"):
        fair_h, fair_a = no_vig_two_way(cons["ml_home"], cons["ml_away"])
        res["moneyline"] = dict(
            market_home_price=cons["ml_home"], market_away_price=cons["ml_away"], no_vig_home=fair_h, no_vig_away=fair_a,
            model_home=s["win_prob_home"], model_away=s["win_prob_away"], diff_home=s["win_prob_home"] - fair_h,
            fair_home=fair_american(s["win_prob_home"]), fair_away=fair_american(s["win_prob_away"]),
            ev_home=expected_value(s["win_prob_home"], cons["best_ml_home"]["price"]) if cons.get("best_ml_home") else None,
            ev_away=expected_value(s["win_prob_away"], cons["best_ml_away"]["price"]) if cons.get("best_ml_away") else None,
        )
    if "spread" in s:
        sp = s["spread"]
        price_h, price_a = cons.get("spread_price_home", -110), cons.get("spread_price_away", -110)
        nv_h, _ = no_vig_two_way(price_h, price_a)
        res["spread"] = dict(market_line_home=sp["line_home"], model_line_home=proj["projected"]["spread_home"],
                             line_diff=proj["projected"]["spread_home"] - sp["line_home"],
                             p_home_cover=sp["p_home_cover"], p_away_cover=sp["p_away_cover"], p_push=sp["p_push"],
                             market_no_vig_home=nv_h,
                             ev_home=expected_value(sp["p_home_cover"], price_h, sp["p_push"]),
                             ev_away=expected_value(sp["p_away_cover"], price_a, sp["p_push"]))
    if "totals" in s:
        t = s["totals"]
        po, pu = cons.get("total_price_over", -110), cons.get("total_price_under", -110)
        res["total"] = dict(market_line=t["line"], model_total=proj["projected"]["total"],
                            line_diff=proj["projected"]["total"] - t["line"], p_over=t["p_over"], p_under=t["p_under"],
                            p_push=t["p_push"], ev_over=expected_value(t["p_over"], po, t["p_push"]),
                            ev_under=expected_value(t["p_under"], pu, t["p_push"]))
    if "h1" in s:
        h = s["h1"]
        res["h1_total"] = dict(market_line=h["line"], model_total=proj["projected"]["h1_total"], p_over=h["p_over"],
                               p_under=h["p_under"], p_push=h["p_push"])
    return res


def project_props(db: Session, game: m.Game, as_of: datetime | None = None, n_sims: int = 10000) -> list[dict]:
    mv = active_version(db, game.league, "props")
    if mv is None:
        return []
    pb = load(mv)
    ff = features_cache.get(db, game.league)
    grow = ff[ff["id"] == game.id]
    if grow.empty:
        return []
    g = grow.iloc[0]
    # build point-in-time player rows from completed logs before this game
    logs = player_logs(db, game.league)
    if logs.empty:
        return []
    start = pd.Timestamp(game.start_time) if game.start_time.tzinfo else pd.Timestamp(game.start_time).tz_localize("UTC")
    hist = logs[logs["start_time"] < start]
    members = db.execute(select(m.RosterMembership).where(m.RosterMembership.team_id.in_([game.home_team_id, game.away_team_id]),
                                                          m.RosterMembership.end_date.is_(None))).scalars().all()
    lines = market.prop_lines(db, game.id, as_of=as_of)
    out = []
    for rm in members:
        ph = hist[hist["player_id"] == rm.player_id]
        if ph.empty:
            continue
        # append a synthetic "upcoming" row and compute its point-in-time features
        up = dict(game_id=game.id, player_id=rm.player_id, team_id=rm.team_id, minutes=0, pts=0, reb=0, ast=0,
                  fg3m=0, stl=0, blk=0, start_time=start, home_team_id=game.home_team_id, season=game.season)
        pf = PM.player_frame(pd.concat([ph, pd.DataFrame([up])], ignore_index=True), ff, game.league)
        row = pf.iloc[-1].to_dict()
        if pd.isna(row.get("min_ewm")):
            continue
        injured = db.scalar(select(m.Injury).where(m.Injury.player_id == rm.player_id, m.Injury.cleared_at.is_(None),
                                                   m.Injury.status == "out"))
        anchors = {stat: v["line"] for (pid_, stat), v in lines.items() if pid_ == rm.player_id}
        proj = pb.project(row, n_sims, seed=get_settings().random_seed + game.id * 1000 + rm.player_id, anchors=anchors)
        markets = {}
        for stat in PM.STATS + ["pra"]:
            ln = lines.get((rm.player_id, stat))
            summ = PM.summarize(proj["sims"][stat], ln["line"] if ln else None)
            summ["model_only_mean"] = proj["model_means"].get(stat)
            if ln:
                summ.update(book=ln["book"], over_price=ln["over_price"], under_price=ln["under_price"],
                            captured_at=ln["captured_at"],
                            ev_over=expected_value(summ["p_over"], ln["over_price"], summ["p_push"]),
                            ev_under=expected_value(summ["p_under"], ln["under_price"], summ["p_push"]))
            markets[stat] = summ
        out.append(dict(player_id=rm.player_id, team_id=rm.team_id, model_version=mv.version, injury_out=bool(injured),
                        minutes=dict(mean=proj["mu_minutes"], sd=pb.sigma_minutes,
                                     p10=float(np.percentile(proj["sims"]["min"], 10)),
                                     p90=float(np.percentile(proj["sims"]["min"], 90))),
                        blowout_risk=float(g["naive_margin"]), markets=markets,
                        correlation=_corr(proj["sims"])))
    return out


def _corr(sims: dict) -> dict:
    keys = ["pts", "reb", "ast", "fg3m"]
    c = np.corrcoef(np.vstack([sims[k] for k in keys]))
    return dict(keys=keys, matrix=[[float(x) for x in row] for row in c])


# ---------------- archive ----------------

def archive_game_predictions(db: Session, game: m.Game, as_of: datetime | None = None, mode: str = "live") -> list[m.Prediction]:
    """Freeze the model's view of a game into immutable prediction rows.

    `as_of` restricts market data to snapshots captured at or before that instant (used for
    walk-forward backtests so closing lines never leak into earlier forecasts).
    """
    as_of = as_of or datetime.now(timezone.utc)
    proj = project_game(db, game, explain=False, as_of=as_of)
    if proj is None:
        return []
    mv = active_version(db, game.league)
    cons, vs, s = proj["market"], proj["vs_market"], proj["simulation"]
    data_as_of = cons.get("captured_at") or as_of
    base = dict(league=game.league, game_id=game.id, model_version_id=mv.id, data_as_of=data_as_of,
                is_demo=game.is_demo)
    rows = []
    ph = s["win_prob_home"]
    side = "home" if ph >= 0.5 else "away"
    best = cons.get(f"best_ml_{side}")
    rows.append(m.Prediction(**base, market="moneyline", selection=side, predicted_value=proj["projected"]["margin"],
                             predicted_prob=ph if side == "home" else 1 - ph, sportsbook_id=best["book_id"] if best else None,
                             price_american=best["price"] if best else None,
                             details=dict(mode=mode, win_prob_home=ph, n_sims=s["n_sims"])))
    if "spread" in vs:
        sp = vs["spread"]
        sel = "home" if sp["p_home_cover"] >= sp["p_away_cover"] else "away"
        line = sp["market_line_home"] if sel == "home" else -sp["market_line_home"]
        rows.append(m.Prediction(**base, market="spread", selection=sel, predicted_value=proj["projected"]["margin"],
                                 predicted_prob=sp["p_home_cover"] if sel == "home" else sp["p_away_cover"], line=line,
                                 price_american=cons.get(f"spread_price_{sel}"),
                                 details=dict(mode=mode, p_push=sp["p_push"], model_line_home=sp["model_line_home"])))
    for key, mk in (("total", "total"), ("h1_total", "h1_total")):
        if key in vs:
            t = vs[key]
            sel = "over" if t["p_over"] >= t["p_under"] else "under"
            rows.append(m.Prediction(**base, market=mk, selection=sel, predicted_value=t["model_total"],
                                     predicted_prob=t[f"p_{sel}"], line=t["market_line"],
                                     price_american=cons.get(f"total_price_{sel}") if mk == "total" else None,
                                     details=dict(mode=mode, p_push=t["p_push"])))
    # team totals: probabilities counted from the same (market-informed) simulation
    for team_side, t in s.get("team_totals", {}).items():
        sel = "over" if t["p_over"] >= t["p_under"] else "under"
        rows.append(m.Prediction(**base, market=f"team_total_{team_side}", selection=sel, predicted_value=proj["projected"][f"{team_side}_score"],
                                 predicted_prob=t[f"p_{sel}"], line=t["line"], details=dict(mode=mode, p_push=t["p_push"])))
    # props
    pmv = active_version(db, game.league, "props")
    if pmv:
        for pp in project_props(db, game, as_of=as_of, n_sims=4000):
            if pp["injury_out"]:
                continue
            for stat, sm in pp["markets"].items():
                if "line" not in sm:
                    continue
                sel = "over" if sm["p_over"] >= sm["p_under"] else "under"
                rows.append(m.Prediction(league=game.league, game_id=game.id, player_id=pp["player_id"],
                                         model_version_id=pmv.id, data_as_of=pd.Timestamp(sm["captured_at"]).to_pydatetime(),
                                         is_demo=game.is_demo, market=f"prop_{stat}", selection=sel,
                                         predicted_value=sm["mean"], predicted_prob=sm[f"p_{sel}"], line=sm["line"],
                                         price_american=sm["over_price"] if sel == "over" else sm["under_price"],
                                         details=dict(mode=mode, p_push=sm["p_push"], minutes=pp["minutes"]["mean"],
                                                      model_only_mean=sm.get("model_only_mean"),
                                                      book=sm.get("book"))))
    db.add_all(rows)
    db.commit()
    return rows


def _norm_cdf(z: float) -> float:
    from math import erf, sqrt

    return 0.5 * (1 + erf(z / sqrt(2)))


def backfill_current_season(db: Session, league: str, max_games: int | None = None) -> int:
    """Walk-forward backtest over completed current-season games using only pre-game data.

    The model was trained with a cutoff at the season start, team features are point-in-time,
    and market inputs are restricted to snapshots captured >= 1 hour before tip-off.
    """
    games = db.scalars(select(m.Game).where(m.Game.league == league, m.Game.is_historical_sim.is_(False),
                                            m.Game.status == "final").order_by(m.Game.start_time)).all()
    done = {gid for (gid,) in db.execute(select(m.Prediction.game_id).distinct())}
    n = 0
    for g in games:
        if g.id in done:
            continue
        rows = archive_game_predictions(db, g, as_of=_aware(g.start_time) - timedelta(hours=1), mode="backtest")
        n += len(rows)
        if max_games and n >= max_games:
            break
    return n


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
