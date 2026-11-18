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
_state = dict(last_odds=0.0, last_cycle=None, errors=0)


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
        out["archived"] = archive_due(db, now)
        out["settled"] = settlement.settle_all(db)
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
