from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timedelta, timezone

import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import models as m
from ..ai import assistant, rag
from ..config import get_settings
from ..data_mgmt import exporter, importer
from ..db import SessionLocal, get_db
from ..services import diagnostics, market, modeling, performance, settlement, trends
from .common import clear_asset_cache, game_out, iso, player_out, require_admin, team_out

router = APIRouter(prefix="/api")


def _now():
    return datetime.now(timezone.utc)


def _clean(x):
    """Make numpy/pandas values JSON safe."""
    import math

    import numpy as np

    if isinstance(x, dict):
        return {str(k): _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean(v) for v in x]
    if isinstance(x, (np.floating, float)):
        return None if math.isnan(float(x)) or math.isinf(float(x)) else float(x)
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, (pd.Timestamp, datetime)):
        return iso(x)
    return x


# ---------------- status ----------------
@router.get("/health")
def health():
    return dict(ok=True, time=iso(_now()))


@router.get("/status")
def status(db: Session = Depends(get_db)):
    s = get_settings()
    from ..providers.base import cache

    health = {}
    for prov in ("balldontlie", "the_odds_api", "sportsdataio"):
        h = db.scalar(select(m.ProviderHealth).where(m.ProviderHealth.provider == prov).order_by(m.ProviderHealth.id.desc()))
        health[prov] = dict(configured=bool(getattr(s, {"balldontlie": "balldontlie_api_key", "the_odds_api": "odds_api_key",
                                                         "sportsdataio": "sportsdataio_api_key"}[prov])),
                            last_check=iso(h.checked_at) if h else None, ok=h.ok if h else None, message=h.message if h else None,
                            latency_ms=h.latency_ms if h else None, rate_limit_remaining=h.rate_limit_remaining if h else None)
    last_odds = db.scalar(select(func.max(m.OddsSnapshot.captured_at)))
    last_game = db.scalar(select(func.max(m.Game.updated_at)))
    models = [dict(league=mv.league, name=mv.name, version=mv.version, data_source=mv.data_source, trained_at=iso(mv.trained_at))
              for mv in db.scalars(select(m.ModelVersion).where(m.ModelVersion.is_active.is_(True)))]
    return dict(mode="demo" if s.demo_mode else "live", demo=s.demo_mode, providers=health, ai_enabled=assistant.available(),
                ai_model=s.anthropic_model if assistant.available() else None, cache_backend=cache().backend,
                database=db.bind.dialect.name, freshness=dict(odds=iso(last_odds), games=iso(last_game)), models=models,
                server_time=iso(_now()), refresh=dict(live_seconds=s.live_poll_seconds, odds_seconds=s.odds_poll_seconds),
                logos=("licensed CDN" if s.licensed_logo_base_url else "original crest renderer (no licensed logo source configured)"))


# ---------------- registry ----------------
@router.get("/teams")
def teams(league: str | None = None, db: Session = Depends(get_db)):
    q = select(m.Team).order_by(m.Team.location)
    if league:
        q = q.where(m.Team.league == league.upper())
    return [team_out(db, t) for t in db.scalars(q)]


@router.get("/teams/{team_id}")
def team_detail(team_id: int, db: Session = Depends(get_db)):
    t = db.get(m.Team, team_id)
    if not t:
        raise HTTPException(404)
    roster = db.execute(select(m.Player, m.RosterMembership).join(m.RosterMembership)
                        .where(m.RosterMembership.team_id == team_id, m.RosterMembership.end_date.is_(None))).all()
    upcoming = db.scalars(select(m.Game).where(or_(m.Game.home_team_id == team_id, m.Game.away_team_id == team_id),
                                               m.Game.status != "final", m.Game.is_historical_sim.is_(False)).order_by(m.Game.start_time).limit(5))
    return _clean(dict(team=team_out(db, t), roster=[player_out(db, p, rm) for p, rm in roster],
                       upcoming=[game_out(db, g) for g in upcoming], trends=trends.team_trends(db, team_id)))


@router.get("/conferences")
def conferences(db: Session = Depends(get_db)):
    out = []
    for c in db.scalars(select(m.Conference).where(m.Conference.league == "CBB")):
        ts = db.scalars(select(m.Team).where(m.Team.conference_id == c.id).order_by(m.Team.location)).all()
        out.append(dict(id=c.id, name=c.name, short=c.short_name, strength=c.strength, teams=[team_out(db, t, brief=True) for t in ts]))
    return out


@router.get("/players")
def players(league: str | None = None, team_id: int | None = None, q: str | None = None, db: Session = Depends(get_db)):
    stmt = select(m.Player, m.RosterMembership).join(m.RosterMembership).where(m.RosterMembership.end_date.is_(None))
    if league:
        stmt = stmt.where(m.Player.league == league.upper())
    if team_id:
        stmt = stmt.where(m.RosterMembership.team_id == team_id)
    if q:
        stmt = stmt.where(m.Player.full_name.ilike(f"%{q}%"))
    return [player_out(db, p, rm) for p, rm in db.execute(stmt.order_by(m.Player.last_name)).all()]


@router.get("/players/{player_id}")
def player_detail(player_id: int, db: Session = Depends(get_db)):
    p = db.get(m.Player, player_id)
    if not p:
        raise HTTPException(404)
    po = player_out(db, p)
    tr = trends.player_trends(db, player_id)
    nxt, proj = None, None
    if po["team"]:
        tid = po["team"]["id"]
        g = db.scalar(select(m.Game).where(or_(m.Game.home_team_id == tid, m.Game.away_team_id == tid), m.Game.status == "scheduled",
                                           m.Game.is_historical_sim.is_(False)).order_by(m.Game.start_time))
        if g:
            nxt = game_out(db, g)
            proj = next((x for x in modeling.project_props(db, g, n_sims=6000) if x["player_id"] == player_id), None)
    inj = db.scalar(select(m.Injury).where(m.Injury.player_id == player_id, m.Injury.cleared_at.is_(None)).order_by(m.Injury.reported_at.desc()))
    return _clean(dict(player=po, trends=tr, next_game=nxt, projection=proj,
                       injury=dict(status=inj.status, description=inj.description, reported_at=iso(inj.reported_at), source=inj.source) if inj else None))


class AssetIn(BaseModel):
    entity_type: str = Field(pattern="^(team|player)$")
    entity_id: int
    kind: str = Field(pattern="^(logo|portrait)$")
    url: str
    license: str = Field(min_length=3)
    source: str
    verified: bool = False


@router.get("/assets")
def assets(db: Session = Depends(get_db)):
    return [dict(id=a.id, entity_type=a.entity_type, entity_id=a.entity_id, kind=a.kind, url=a.url, license=a.license, source=a.source,
                 verified=a.verified) for a in db.scalars(select(m.Asset))]


@router.post("/assets", dependencies=[Depends(require_admin)])
def add_asset(body: AssetIn, db: Session = Depends(get_db)):
    ent = db.get(m.Team if body.entity_type == "team" else m.Player, body.entity_id)
    if ent is None:
        raise HTTPException(404, f"{body.entity_type} {body.entity_id} not found")
    a = m.Asset(**body.model_dump())
    db.add(a)
    db.commit()
    clear_asset_cache()
    return dict(id=a.id)


# ---------------- games ----------------
@router.get("/games")
def games(league: str | None = None, day: date | None = Query(default=None, alias="date"), status: str | None = None,
          days: int = 1, db: Session = Depends(get_db)):
    d0 = datetime.combine(day or _now().date(), datetime.min.time(), timezone.utc) - timedelta(hours=6)
    q = select(m.Game).where(m.Game.start_time >= d0, m.Game.start_time < d0 + timedelta(days=days, hours=0), m.Game.is_historical_sim.is_(False))
    if league:
        q = q.where(m.Game.league == league.upper())
    if status:
        q = q.where(m.Game.status == status)
    return [game_out(db, g) for g in db.scalars(q.order_by(m.Game.start_time))]


def _ticker(db: Session, league: str | None):
    now = _now()
    q = select(m.Game).where(m.Game.is_historical_sim.is_(False), m.Game.start_time >= now - timedelta(hours=14),
                             m.Game.start_time <= now + timedelta(hours=20))
    if league:
        q = q.where(m.Game.league == league.upper())
    gs = db.scalars(q.order_by(m.Game.start_time)).all()
    order = {"live": 0, "scheduled": 1, "final": 2}
    gs = sorted(gs, key=lambda g: (order.get(g.status, 3), g.start_time))[:60]
    out = []
    for g in gs:
        d = game_out(db, g)
        pred = db.scalar(select(m.Prediction).where(m.Prediction.game_id == g.id, m.Prediction.market == "moneyline").order_by(m.Prediction.created_at.desc()))
        if pred:
            ph = pred.details.get("win_prob_home")
            d["model"] = dict(win_prob_home=ph, projected_margin=pred.predicted_value)
        out.append(d)
    return out


@router.get("/ticker")
def ticker(league: str | None = None, db: Session = Depends(get_db)):
    return dict(generated_at=iso(_now()), demo=get_settings().demo_mode, games=_ticker(db, league))


@router.get("/stream/ticker")
async def ticker_stream(request: Request, league: str | None = None):
    async def gen():
        last = None
        while True:
            if await request.is_disconnected():
                break
            with SessionLocal() as db:
                payload = json.dumps(dict(generated_at=iso(_now()), demo=get_settings().demo_mode, games=_ticker(db, league)), default=str)
            if payload != last:
                yield f"event: ticker\ndata: {payload}\n\n"
                last = payload
            else:
                yield ": keep-alive\n\n"
            await asyncio.sleep(max(5, get_settings().live_poll_seconds // 2))

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/games/{game_id}")
def game_detail(game_id: int, n_sims: int = Query(default=10000, ge=1000, le=100000), db: Session = Depends(get_db)):
    g = db.get(m.Game, game_id)
    if not g:
        raise HTTPException(404)
    proj = modeling.project_game(db, g, n_sims=n_sims)
    events = [dict(seq=e.sequence, period=e.period, clock=e.clock, type=e.event_type, description=e.description, home=e.home_score,
                   away=e.away_score, t=iso(e.created_at)) for e in db.scalars(select(m.GameEvent).where(m.GameEvent.game_id == g.id).order_by(m.GameEvent.sequence))]
    preds = [dict(id=p.id, created_at=iso(p.created_at), market=p.market, selection=p.selection, prob=p.predicted_prob, line=p.line,
                  value=p.predicted_value, price=p.price_american, result=p.result, actual=p.actual_value, player_id=p.player_id,
                  model_version=p.model_version.version, data_as_of=iso(p.data_as_of))
             for p in db.scalars(select(m.Prediction).where(m.Prediction.game_id == g.id).order_by(m.Prediction.created_at.desc()))]
    box = {("home" if s.is_home else "away"): {c.name: getattr(s, c.name) for c in m.TeamGameStat.__table__.columns}
           for s in db.scalars(select(m.TeamGameStat).where(m.TeamGameStat.game_id == g.id))}
    live = None
    if g.status == "live" and proj:
        live = _live_projection(g, proj)
    return _clean(dict(game=game_out(db, g), projection=proj, movement=market.movement(db, g.id), events=events, predictions=preds,
                       box=box, live=live, context=g.pregame_context))


def _live_projection(g: m.Game, proj: dict) -> dict:
    """Blend pre-game projection with the current score in proportion to time remaining."""
    from scipy.stats import norm

    nper, plen = (4, 12) if g.league == "NBA" else (2, 20)
    mins_total = nper * plen
    mm, ss = (g.clock or "0:00").split(":") if g.clock and ":" in g.clock else ("0", "0")
    elapsed = ((g.period or 1) - 1) * plen + (plen - int(mm) - int(ss) / 60)
    rem = max(0.0, 1 - elapsed / mins_total)
    pre_m, pre_t = proj["projected"]["margin"], proj["projected"]["total"]
    cur_m = (g.home_score or 0) - (g.away_score or 0)
    cur_t = (g.home_score or 0) + (g.away_score or 0)
    pace_ratio = (cur_t / max(1e-6, pre_t * (1 - rem))) if rem < 0.95 else 1.0
    proj_total = cur_t + pre_t * rem * (0.5 + 0.5 * min(1.4, max(0.7, pace_ratio)))
    proj_margin = cur_m + pre_m * rem
    sd = proj["simulation"]["margin"]["sd"] * max(0.05, rem) ** 0.5
    wp = float(norm.cdf(proj_margin / sd)) if sd > 0 else float(cur_m > 0)
    return dict(minutes_elapsed=elapsed, fraction_remaining=rem, live_projected_total=proj_total, live_projected_margin=proj_margin,
                live_win_prob_home=wp, pace_vs_projection=pace_ratio, current_total=cur_t, current_margin=cur_m,
                method="pre-game projection scaled by time remaining, total adjusted for observed scoring pace")


@router.get("/games/{game_id}/props")
def game_props(game_id: int, db: Session = Depends(get_db)):
    g = db.get(m.Game, game_id)
    if not g:
        raise HTTPException(404)
    props = modeling.project_props(db, g)
    pl = {p.id: p for p in db.scalars(select(m.Player).where(m.Player.id.in_([x["player_id"] for x in props])))}
    for x in props:
        x["player"] = player_out(db, pl[x["player_id"]])
    return _clean(props)


# ---------------- market boards ----------------
def _upcoming(db: Session, league: str | None, hours: int = 36, include_live: bool = True):
    now = _now()
    q = select(m.Game).where(m.Game.is_historical_sim.is_(False), m.Game.start_time <= now + timedelta(hours=hours),
                             m.Game.start_time >= now - timedelta(hours=3))
    q = q.where(m.Game.status.in_(["scheduled", "live"] if include_live else ["scheduled"]))
    if league:
        q = q.where(m.Game.league == league.upper())
    return db.scalars(q.order_by(m.Game.start_time).limit(80)).all()


@router.get("/board")
def board(league: str | None = None, hours: int = 36, db: Session = Depends(get_db)):
    rows = []
    for g in _upcoming(db, league, hours):
        p = modeling.project_game(db, g, n_sims=5000, explain=False)
        if not p:
            continue
        feats = p.pop("features", {}) or {}
        p["projected"]["possessions"] = feats.get("exp_pace")
        p["projected"]["home_pace"] = feats.get("h_pace")
        p["projected"]["away_pace"] = feats.get("a_pace")
        for k in ("margin_hist", "total_hist"):
            p["simulation"].pop(k, None)
        if g.status == "live":
            p["live"] = _live_projection(g, p)
        rows.append(dict(game=game_out(db, g), projected=p["projected"], simulation=p["simulation"], vs_market=p["vs_market"], live=p.get("live"),
                         market={k: v for k, v in p["market"].items() if k != "by_book"}, by_book=p["market"].get("by_book", []),
                         model_version=p["model_version"], model_data_source=p["model_data_source"]))
    return _clean(dict(generated_at=iso(_now()), demo=get_settings().demo_mode, games=rows))


@router.get("/props")
def props_board(league: str = "NBA", hours: int = 30, db: Session = Depends(get_db)):
    out = []
    for g in _upcoming(db, league, hours, include_live=False)[:12]:
        for x in modeling.project_props(db, g, n_sims=4000):
            x["game"] = game_out(db, g)
            x["player"] = player_out(db, db.get(m.Player, x["player_id"]))
            out.append(x)
    return _clean(dict(generated_at=iso(_now()), props=out))


@router.get("/odds/{game_id}/movement")
def odds_movement(game_id: int, db: Session = Depends(get_db)):
    mv = market.movement(db, game_id)
    preds = [dict(t=iso(p.created_at), data_as_of=iso(p.data_as_of), market=p.market, prob=p.predicted_prob, value=p.predicted_value)
             for p in db.scalars(select(m.Prediction).where(m.Prediction.game_id == game_id, m.Prediction.market.in_(["moneyline", "spread", "total"]))
                                 .order_by(m.Prediction.created_at))]
    return _clean(dict(**mv, model_history=preds))


# ---------------- trends ----------------
@router.get("/trends/team/{team_id}")
def team_trends(team_id: int, db: Session = Depends(get_db)):
    return _clean(trends.team_trends(db, team_id))


@router.get("/trends/player/{player_id}")
def player_trends(player_id: int, db: Session = Depends(get_db)):
    return _clean(trends.player_trends(db, player_id))


@router.get("/trends/league/{league}")
def league_trends(league: str, db: Session = Depends(get_db)):
    rows = trends.league_table(db, league.upper())
    return _clean(dict(rows=rows, n_teams=len(rows), source="team_game_stats (season to date)"))


@router.get("/trends/correlations/{league}")
def correlations(league: str, db: Session = Depends(get_db)):
    ff = modeling.features_cache.get(db, league.upper())
    ff = ff[ff["y_margin"].notna() & ~ff["is_historical_sim"]] if "is_historical_sim" in ff else ff
    if len(ff) < 30:
        ff = modeling.features_cache.get(db, league.upper()).dropna(subset=["y_margin"]).tail(800)
    cols = ["net_diff", "exp_pace", "h_rest", "a_rest", "h_travel", "a_travel", "h_injury", "a_injury", "naive_margin", "naive_total", "y_margin", "y_total"]
    c = ff[cols].corr().round(3)
    return dict(columns=cols, matrix=c.values.tolist(), n=int(len(ff)))


# ---------------- predictions & performance ----------------
@router.get("/predictions")
def predictions(league: str | None = None, market_: str | None = Query(default=None, alias="market"), result: str | None = None,
                limit: int = 200, settled: bool = False, games_only: bool = False, player_id: int | None = None,
                db: Session = Depends(get_db)):
    q = (select(m.Prediction, m.Game).join(m.Game).order_by(m.Game.start_time.desc(), m.Prediction.created_at.desc()))
    if league:
        q = q.where(m.Prediction.league == league.upper())
    if market_:
        q = q.where(m.Prediction.market.like(f"{market_}%"))
    if result:
        q = q.where(m.Prediction.result == result)
    if settled:
        q = q.where(m.Prediction.result != "pending")
    if games_only:
        q = q.where(m.Prediction.player_id.is_(None))
    if player_id:
        q = q.where(m.Prediction.player_id == player_id)
    players = {p.id: p.full_name for p in db.scalars(select(m.Player))}
    rows = []
    for p, g in db.execute(q.limit(limit)).all():
        rows.append(dict(id=p.id, created_at=iso(p.created_at), data_as_of=iso(p.data_as_of), league=p.league, game_id=g.id,
                         start_time=iso(g.start_time), home=team_out(db, g.home_team, True), away=team_out(db, g.away_team, True),
                         player=players.get(p.player_id), player_id=p.player_id, model_version=p.model_version.version, market=p.market,
                         selection=p.selection, predicted_value=p.predicted_value, predicted_prob=p.predicted_prob, line=p.line,
                         sportsbook=p.sportsbook.name if p.sportsbook else (p.details or {}).get("book"), price=p.price_american,
                         actual=p.actual_value, result=p.result, settled_at=iso(p.settled_at), is_demo=p.is_demo, mode=(p.details or {}).get("mode")))
    return _clean(rows)


@router.get("/performance/summary")
def perf_summary(league: str | None = None, db: Session = Depends(get_db)):
    return _clean(performance.summary(db, league.upper() if league else None))


@router.get("/performance/breakdown")
def perf_breakdown(by: str = "market", league: str | None = None, min_n: int = 5, db: Session = Depends(get_db)):
    if by not in ("team", "player", "conference", "market"):
        raise HTTPException(400, "by must be team|player|conference|market")
    return _clean(performance.breakdown(db, by, league.upper() if league else None, min_n))


@router.get("/diagnostics")
def diag(league: str | None = None, db: Session = Depends(get_db)):
    return _clean(diagnostics.analyze(db, league.upper() if league else None))


# ---------------- picks journal ----------------
class PickIn(BaseModel):
    pick_date: date
    league: str = Field(pattern="^(NBA|CBB)$")
    game_id: int | None = None
    player_id: int | None = None
    description: str = Field(min_length=2, max_length=200)
    market: str
    selection: str
    line: float | None = None
    predicted_outcome: str | None = None
    sportsbook: str | None = None
    price_american: int | None = None
    confidence_notes: str | None = None
    stake_units: float | None = Field(default=None, ge=0, le=100)


class PickPatch(BaseModel):
    status: str | None = Field(default=None, pattern="^(win|loss|push|void|pending)$")
    actual_result: str | None = None
    confidence_notes: str | None = None


def _pick_out(p: m.UserPick):
    from ..services.odds_math import profit_units

    d = {c.name: getattr(p, c.name) for c in m.UserPick.__table__.columns}
    d["profit_units"] = profit_units(p.status, p.price_american, p.stake_units or 1.0) if p.price_american else None
    return _clean(d)


@router.get("/picks")
def list_picks(db: Session = Depends(get_db)):
    picks = db.scalars(select(m.UserPick).order_by(m.UserPick.pick_date.desc(), m.UserPick.created_at.desc())).all()
    rows = [_pick_out(p) for p in picks]
    dec = [p for p in picks if p.status in ("win", "loss")]
    wins = sum(p.status == "win" for p in dec)
    units = sum(r["profit_units"] or 0 for r in rows)
    staked = sum((p.stake_units or 1.0) for p in picks if p.status in ("win", "loss", "push") and p.price_american)
    return dict(picks=rows, summary=dict(total=len(picks), wins=wins, losses=len(dec) - wins, pushes=sum(p.status == "push" for p in picks),
                                         pending=sum(p.status == "pending" for p in picks), win_pct=wins / len(dec) if dec else None,
                                         units=units, roi=units / staked if staked else None))


@router.post("/picks")
def create_pick(body: PickIn, db: Session = Depends(get_db)):
    if body.price_american is not None and -100 < body.price_american < 100:
        raise HTTPException(422, "American odds must be <= -100 or >= +100")
    if body.game_id and not db.get(m.Game, body.game_id):
        raise HTTPException(404, "game not found")
    p = m.UserPick(**body.model_dump())
    db.add(p)
    db.commit()
    g = db.get(m.Game, p.game_id) if p.game_id else None
    if g and g.status == "final":
        settlement.settle_game(db, g)
    return _pick_out(p)


@router.patch("/picks/{pick_id}")
def update_pick(pick_id: str, body: PickPatch, db: Session = Depends(get_db)):
    p = db.get(m.UserPick, pick_id)
    if not p:
        raise HTTPException(404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(p, k, v)
    if body.status and body.status != "pending":
        p.settled_at = _now()
        db.add(m.Settlement(pick_id=p.id, result=body.status, rule="manual settlement by user", source="user"))
    db.commit()
    return _pick_out(p)


@router.delete("/picks/{pick_id}")
def delete_pick(pick_id: str, db: Session = Depends(get_db)):
    p = db.get(m.UserPick, pick_id)
    if not p:
        raise HTTPException(404)
    db.query(m.Settlement).filter(m.Settlement.pick_id == pick_id).delete()
    db.delete(p)
    db.commit()
    return dict(deleted=pick_id)


# ---------------- models ----------------
@router.get("/models")
def list_models(db: Session = Depends(get_db)):
    return _clean([dict(id=mv.id, league=mv.league, name=mv.name, version=mv.version, algorithm=mv.algorithm, trained_at=iso(mv.trained_at),
                        train_start=iso(mv.train_start), train_end=iso(mv.train_end), n_train=mv.n_train, data_source=mv.data_source,
                        is_active=mv.is_active, metrics=mv.metrics, params=mv.params, features=mv.features)
                   for mv in db.scalars(select(m.ModelVersion).order_by(m.ModelVersion.id.desc()))])


@router.post("/models/train", dependencies=[Depends(require_admin)])
def train(league: str, db: Session = Depends(get_db)):
    out = modeling.train_league(db, league.upper())
    rag.index_core(db)
    return out


@router.post("/models/tune", dependencies=[Depends(require_admin)])
def tune(league: str, trials: int = Query(default=15, ge=3, le=100), db: Session = Depends(get_db)):
    from ..ml.game_model import tune_lightgbm

    ff = modeling.features_cache.get(db, league.upper())
    return tune_lightgbm(ff[ff["is_historical_sim"] | (ff["status"] == "final")], league.upper(), trials)


@router.get("/simulate/{game_id}")
def simulate(game_id: int, n: int = Query(default=10000, ge=1000, le=200000), seed: int | None = None, db: Session = Depends(get_db)):
    g = db.get(m.Game, game_id)
    mv = modeling.active_version(db, g.league) if g else None
    if not g or not mv:
        raise HTTPException(404)
    p = modeling.project_game(db, g, n_sims=n, explain=False)
    return _clean(dict(game_id=game_id, n=n, seed=p["seed"], simulation=p["simulation"], projected=p["projected"], model_version=mv.version))


# ---------------- data management ----------------
@router.post("/data/import")
async def data_import(file: UploadFile = File(...), kind: str | None = Form(default=None), league: str | None = Form(default=None),
                      timezone_name: str = Form(default="America/New_York"), db: Session = Depends(get_db)):
    content = await file.read()
    if len(content) > 25 * 1024 * 1024:
        raise HTTPException(413, "file exceeds 25 MB")
    try:
        ds = importer.run_import(db, file.filename or "upload.csv", content, kind or None, (league or None) and league.upper(), timezone_name)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return _dataset_out(db, ds)


def _dataset_out(db: Session, ds: m.ImportedDataset, rows: int = 200):
    recs = db.scalars(select(m.ImportRecord).where(m.ImportRecord.dataset_id == ds.id).order_by(m.ImportRecord.row_index).limit(rows)).all()
    logs = db.scalars(select(m.CleaningLog).where(m.CleaningLog.dataset_id == ds.id).order_by(m.CleaningLog.id).limit(500)).all()
    return _clean(dict(id=ds.id, filename=ds.filename, kind=ds.kind, status=ds.status, uploaded_at=iso(ds.uploaded_at), sha256=ds.raw_sha256,
                       mapping=ds.column_mapping, scorecard=ds.scorecard,
                       records=[dict(row=r.row_index, status=r.status, issues=r.issues, cleaned=r.cleaned, raw=r.raw) for r in recs],
                       log=[dict(row=lg.row_index, field=lg.field, action=lg.action, before=lg.before, after=lg.after,
                                 destructive=lg.destructive, approved=lg.approved) for lg in logs]))


@router.get("/data/imports")
def imports(db: Session = Depends(get_db)):
    return [dict(id=d.id, filename=d.filename, kind=d.kind, status=d.status, uploaded_at=iso(d.uploaded_at), rows=d.n_rows, valid=d.n_valid,
                 quarantined=d.n_quarantined, duplicates=d.n_duplicates, quality=(d.scorecard or {}).get("quality_score"))
            for d in db.scalars(select(m.ImportedDataset).order_by(m.ImportedDataset.id.desc()))]


@router.get("/data/imports/{ds_id}")
def import_detail(ds_id: int, db: Session = Depends(get_db)):
    ds = db.get(m.ImportedDataset, ds_id)
    if not ds:
        raise HTTPException(404)
    return _dataset_out(db, ds)


class ApproveIn(BaseModel):
    approve_destructive: bool = False
    release_rows: list[int] = []


@router.post("/data/imports/{ds_id}/approve")
def import_approve(ds_id: int, body: ApproveIn, db: Session = Depends(get_db)):
    ds = db.get(m.ImportedDataset, ds_id)
    if not ds:
        raise HTTPException(404)
    return importer.approve(db, ds, body.approve_destructive, body.release_rows)


@router.post("/data/imports/{ds_id}/commit")
def import_commit(ds_id: int, db: Session = Depends(get_db)):
    ds = db.get(m.ImportedDataset, ds_id)
    if not ds:
        raise HTTPException(404)
    try:
        out = importer.commit(db, ds)
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    modeling.features_cache._data.clear()
    return out


@router.get("/data/export/{dataset}")
def export(dataset: str, format: str = "csv", league: str | None = None, dataset_id: int | None = None, db: Session = Depends(get_db)):
    if dataset not in exporter.DATASETS:
        raise HTTPException(404, f"dataset must be one of {exporter.DATASETS}")
    df = exporter.frame(db, dataset, league.upper() if league else None, dataset_id)
    try:
        body, ctype = exporter.render(df, format, dataset)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    stamp = _now().strftime("%Y%m%d-%H%M")
    return Response(body, media_type=ctype, headers={"Content-Disposition": f'attachment; filename="courtside-{dataset}-{stamp}.{format}"'})


@router.get("/data/quality")
def data_quality(db: Session = Depends(get_db)):
    """Platform-wide data health: row counts, freshness, provenance mix, integrity checks."""
    counts = {t: db.scalar(select(func.count()).select_from(getattr(m, t))) for t in
              ("Game", "TeamGameStat", "PlayerGameStat", "OddsSnapshot", "PropLine", "Prediction", "UserPick", "Player", "Team")}
    src = db.execute(select(m.Game.source, func.count()).group_by(m.Game.source)).all()
    finals_no_box = db.scalar(select(func.count(m.Game.id)).where(m.Game.status == "final", ~m.Game.id.in_(select(m.TeamGameStat.game_id))))
    unverified = db.scalar(select(func.count(m.RosterMembership.id)).where(m.RosterMembership.verified.is_(False), m.RosterMembership.end_date.is_(None)))
    late_preds = db.scalar(select(func.count(m.Prediction.id)).join(m.Game).where(m.Prediction.data_as_of > m.Game.start_time))
    return dict(counts=counts, game_sources={s: n for s, n in src}, checks=dict(finals_without_box_score=finals_no_box,
                unverified_roster_memberships=unverified, predictions_with_data_after_tipoff=late_preds))


# ---------------- AI ----------------
class AskIn(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    history: list[dict] = []
    context: dict | None = None


@router.get("/ai/status")
def ai_status():
    s = get_settings()
    return dict(enabled=assistant.available(), model=s.anthropic_model, effort=s.ai_effort, tools=[t["name"] for t in assistant.tools.TOOLS])


@router.post("/ai/ask")
def ai_ask(body: AskIn, db: Session = Depends(get_db)):
    return _clean(assistant.ask(db, body.question, body.history, body.context))


@router.get("/ai/search")
def ai_search(q: str, k: int = 6, db: Session = Depends(get_db)):
    return rag.search(db, q, k)


@router.post("/admin/refresh", dependencies=[Depends(require_admin)])
def refresh(db: Session = Depends(get_db)):
    from ..scheduler import run_cycle

    return run_cycle(force_odds=True)
