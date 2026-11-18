"""DEMO live feed: reveals pre-simulated games as wall-clock time passes.

Emulates what a live provider would push (status, period, clock, running score, events,
odds snapshots). Every row it touches is flagged is_demo and sourced `demo_simulator`.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from .seed import DEMO_SOURCE, SNAP_OFFSETS_H, _demo_odds

GAME_WALL = {"NBA": timedelta(hours=2, minutes=15), "CBB": timedelta(hours=2)}
PERIODS = {"NBA": (4, 12), "CBB": (2, 20)}


def _aware(dt):
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def live_state(league: str, start: datetime, now: datetime, final_home: int, final_away: int, h1_home: int, h1_away: int, seed: int):
    """Deterministic in-game state at `now` for a game with known final score."""
    elapsed = (now - start) / GAME_WALL[league]
    if elapsed <= 0:
        return None
    if elapsed >= 1:
        return dict(status="final", period=None, clock="FINAL", home=final_home, away=final_away)
    nper, plen = PERIODS[league]
    frac = min(0.999, elapsed)
    period = int(frac * nper) + 1
    in_period = frac * nper - (period - 1)
    secs = int((1 - in_period) * plen * 60)
    rng = np.random.default_rng(seed + int(frac * 1000))
    if frac <= 0.5:
        f = frac / 0.5
        h, a = h1_home * f, h1_away * f
    else:
        f = (frac - 0.5) / 0.5
        h = h1_home + (final_home - h1_home) * f
        a = h1_away + (final_away - h1_away) * f
    h = int(max(0, round(h + rng.normal(0, 1.2))))
    a = int(max(0, round(a + rng.normal(0, 1.2))))
    return dict(status="live", period=period, clock=f"{secs // 60}:{secs % 60:02d}", home=h, away=a, frac=frac)


def tick(db: Session, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    window_start = now - timedelta(hours=3)
    changed = dict(live=0, final=0, snapshots=0)
    games = db.scalars(select(m.Game).where(m.Game.is_demo.is_(True), m.Game.is_historical_sim.is_(False),
                                            m.Game.status != "final", m.Game.start_time <= now,
                                            m.Game.start_time >= window_start - timedelta(days=2))).all()
    for g in games:
        out = db.get(m.DemoOutcome, g.id)
        if out is None:
            continue
        p = out.payload
        st = live_state(g.league, _aware(g.start_time), now, p["home"]["points"], p["away"]["points"],
                        p["home"]["h1_points"], p["away"]["h1_points"], g.id)
        if st is None:
            continue
        prev = (g.home_score, g.away_score)
        g.status, g.period, g.clock, g.home_score, g.away_score = st["status"], st["period"], st["clock"], st["home"], st["away"]
        if st["status"] == "live" and st.get("frac", 0) > 0.5:
            g.home_h1, g.away_h1 = p["home"]["h1_points"], p["away"]["h1_points"]
        if st["status"] == "final":
            g.home_h1, g.away_h1 = p["home"]["h1_points"], p["away"]["h1_points"]
            _write_final_boxes(db, g, p)
            changed["final"] += 1
        else:
            changed["live"] += 1
        if prev != (g.home_score, g.away_score):
            seq = (db.query(m.GameEvent).filter(m.GameEvent.game_id == g.id).count()) + 1
            db.add(m.GameEvent(game_id=g.id, sequence=seq, period=g.period or 0, clock=g.clock or "", event_type="score",
                               description=f"Score update {g.away_team.abbreviation} {g.away_score} – {g.home_team.abbreviation} {g.home_score}",
                               home_score=g.home_score, away_score=g.away_score))
    # odds snapshots whose scheduled capture time has now passed
    books = {b.key: b.id for b in db.scalars(select(m.Sportsbook))}
    upcoming = db.scalars(select(m.Game).where(m.Game.is_demo.is_(True), m.Game.is_historical_sim.is_(False),
                                               m.Game.start_time > now - timedelta(minutes=30),
                                               m.Game.start_time <= now + timedelta(hours=max(SNAP_OFFSETS_H))))
    for g in upcoming:
        have = {_aware(t) for (t,) in db.execute(select(m.OddsSnapshot.captured_at).where(m.OddsSnapshot.game_id == g.id).distinct())}
        due = [_aware(g.start_time) - timedelta(hours=o) for o in SNAP_OFFSETS_H]
        if all(d > now or d in have for d in due):
            continue
        out = db.get(m.DemoOutcome, g.id)
        rng = np.random.default_rng(g.id)
        rows = [r for r in _demo_odds(g.id, _aware(g.start_time), out.payload["market"], books, rng, now) if _aware(r["captured_at"]) not in have]
        for r in rows:
            db.add(m.OddsSnapshot(**r))
        changed["snapshots"] += len(rows)
    db.commit()
    return changed


def _write_final_boxes(db: Session, g: m.Game, p: dict) -> None:
    if db.scalar(select(m.TeamGameStat.id).where(m.TeamGameStat.game_id == g.id)):
        return
    for side, tid, home in (("home", g.home_team_id, True), ("away", g.away_team_id, False)):
        db.add(m.TeamGameStat(game_id=g.id, team_id=tid, is_home=home, **p[side]))
    for pl in p.get("players", []):
        db.add(m.PlayerGameStat(game_id=g.id, **pl))
    g.source = DEMO_SOURCE
