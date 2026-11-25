"""Background jobs: live data refresh, odds snapshots, pre-game forecast archiving, settlement.

Runs in a daemon thread inside the API process (single-node). For multi-node deployments run
`python -m app.scheduler` as a dedicated worker and set ENABLE_SCHEDULER=false on API pods.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from . import models as m
from .config import get_settings
from .db import SessionLocal

log = logging.getLogger("courtside.scheduler")
_state = dict(last_odds=0.0, last_injuries=0.0, last_cycle=None, errors=0)
INJURY_SECONDS = 1800       # injury report refresh
EVENT_MARKET_SECONDS = 3600  # per-game props / 1H / team totals (costs extra Odds API credits)
EVENT_MARKET_WINDOW_H = 12


def _aware(dt):
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def archive_due(db, now: datetime) -> int:
    """Freeze a forecast for each game starting within 30h when its newest odds snapshot is
    newer than its newest prediction (i.e. information changed)."""
    from .services import modeling

    n = 0
    games = db.scalars(select(m.Game).where(m.Game.status == "scheduled", m.Game.is_historical_sim.is_(False),
                                            m.Game.start_time > now, m.Game.start_time <= now + timedelta(hours=30))).all()
    for g in games:
        last_odds = db.scalar(select(func.max(m.OddsSnapshot.captured_at)).where(m.OddsSnapshot.game_id == g.id))
        last_pred = db.scalar(select(func.max(m.Prediction.created_at)).where(m.Prediction.game_id == g.id))
        if last_odds is None:
            continue
        if last_pred is None or _aware(last_pred) < _aware(last_odds):
            try:
                n += len(modeling.archive_game_predictions(db, g, as_of=now, mode="live"))
            except Exception:
                log.exception("archive failed for game %s", g.id)
    return n


def _live_extras(db, c, now: datetime, force: bool) -> dict:
    """Live-mode enrichment: box scores for finished games, injury reports, pre-game context
    and per-event markets (first-half totals, team totals, player props)."""
    from .providers import sync
    from .providers.base import ProviderError

    out: dict = {}
    if c["balldontlie"].configured:
        finals = db.scalars(select(m.Game).where(m.Game.is_demo.is_(False), m.Game.status == "final", m.Game.league == "NBA",
                                                 m.Game.start_time >= now - timedelta(days=3),
                                                 ~m.Game.id.in_(select(m.TeamGameStat.game_id)))).all()
        for g in finals[:10]:
            try:
                out[f"box_{g.id}"] = sync.sync_box_scores(db, g, c["balldontlie"])
            except ProviderError as exc:
                out[f"box_{g.id}_error"] = str(exc)
        if force or time.time() - _state["last_injuries"] > INJURY_SECONDS:
            try:
                out["injuries"] = sync.sync_injuries(db, c["balldontlie"])
                _state["last_injuries"] = time.time()
            except ProviderError as exc:
                out["injuries_error"] = str(exc)
    out["pregame_context"] = sync.refresh_pregame_context(db, now)
    if c["the_odds_api"].configured:
        soon = db.scalars(select(m.Game).where(m.Game.is_demo.is_(False), m.Game.status == "scheduled", m.Game.start_time > now,
                                               m.Game.start_time <= now + timedelta(hours=EVENT_MARKET_WINDOW_H))).all()
        for g in soon:
            last = (g.provider_ids or {}).get("event_markets_at")
            if not force and last and (now - datetime.fromisoformat(last)).total_seconds() < EVENT_MARKET_SECONDS:
                continue
            out[f"event_markets_{g.id}"] = sync.sync_event_markets(db, g.league, g, c["the_odds_api"])
            g.provider_ids = {**(g.provider_ids or {}), "event_markets_at": now.isoformat()}
        db.commit()
    return out


def run_cycle(force_odds: bool = False) -> dict:
    from .providers import sync
    from .providers.base import ProviderError
    from .providers.clients import clients
    from .services import demo_feed, settlement

    s = get_settings()
    now = datetime.now(timezone.utc)
    out: dict = {}
    with SessionLocal() as db:
        if s.demo_mode:
            out["demo"] = demo_feed.tick(db, now)
        else:
            c = clients()
            for league in ("NBA", "CBB"):
                if c["balldontlie"].configured:
                    for d in (now.date() - timedelta(days=1), now.date()):
                        try:
                            out[f"games_{league}_{d}"] = sync.sync_games(db, league, d, c["balldontlie"])
                        except ProviderError as exc:
                            out[f"games_{league}_error"] = str(exc)
                if c["the_odds_api"].configured and (force_odds or time.time() - _state["last_odds"] > s.odds_poll_seconds):
                    try:
                        out[f"odds_{league}"] = sync.sync_odds(db, league, c["the_odds_api"])
                    except ProviderError as exc:
                        out[f"odds_{league}_error"] = str(exc)
            if c["the_odds_api"].configured and (force_odds or time.time() - _state["last_odds"] > s.odds_poll_seconds):
                _state["last_odds"] = time.time()
            out.update(_live_extras(db, c, now, force_odds))
        out["archived"] = archive_due(db, now)
        out["settled"] = settlement.settle_all(db)
        if out["settled"] or time.time() - _state.get("last_index", 0) > 3600:
            from .ai import rag

            out["indexed"] = rag.index_dynamic(db)
            _state["last_index"] = time.time()
    _state["last_cycle"] = now.isoformat()
    return out


def loop(stop: threading.Event):
    s = get_settings()
    while not stop.is_set():
        try:
            r = run_cycle()
            d = r.get("demo") or {}
            if any(v for k, v in r.items() if k != "demo") or d.get("final") or d.get("snapshots"):
                log.info("cycle: %s", r)
        except Exception:
            _state["errors"] += 1
            log.exception("scheduler cycle failed")
        stop.wait(s.live_poll_seconds)


def start() -> threading.Event:
    stop = threading.Event()
    threading.Thread(target=loop, args=(stop,), daemon=True, name="courtside-scheduler").start()
    return stop


if __name__ == "__main__":  # dedicated worker
    logging.basicConfig(level=logging.INFO)
    ev = threading.Event()
    loop(ev)
