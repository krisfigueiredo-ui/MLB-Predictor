"""Registry seeding and DEMO-mode data generation."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import numpy as np
from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session

from .. import models as m
from ..ml.synthetic import LeagueSimulator
from ..registry.nba import NBA_TEAMS
from ..registry.ncaa import CONFERENCES, SCHOOLS
from ..registry.players import ARCHETYPES, NBA_SEED, SEED_SEASON, SEED_SOURCE

log = logging.getLogger(__name__)

BOOKS = [("draftkings", "DraftKings"), ("fanduel", "FanDuel"), ("betmgm", "BetMGM"), ("williamhill_us", "Caesars")]
DEMO_SOURCE = "demo_simulator"
CURRENT_SEASON_START = {"NBA": 2026, "CBB": 2026}
HISTORY_START = {"NBA": 2022, "CBB": 2023}


def seed_registry(db: Session) -> None:
    if db.scalar(select(func.count(m.Team.id))):
        return
    east = m.Conference(league="NBA", name="Eastern Conference", short_name="East")
    west = m.Conference(league="NBA", name="Western Conference", short_name="West")
    db.add_all([east, west])
    confs = {}
    for short, (name, strength) in CONFERENCES.items():
        c = m.Conference(league="CBB", name=name, short_name=short, strength=strength)
        db.add(c)
        confs[short] = c
    db.flush()
    for abbr, loc, nick, conf, div, c1, c2, arena, lat, lon in NBA_TEAMS:
        db.add(m.Team(league="NBA", slug=f"nba-{abbr.lower()}", abbreviation=abbr, location=loc, nickname=nick,
                      conference_id=(east if conf == "East" else west).id, division=div, primary_color=c1,
                      secondary_color=c2, venue=arena, lat=lat, lon=lon, provider_ids={}))
    for slug, abbr, school, nick, conf, c1, c2, lat, lon in SCHOOLS:
        db.add(m.Team(league="CBB", slug=f"cbb-{slug}", abbreviation=abbr, location=school, nickname=nick,
                      conference_id=confs[conf].id, primary_color=c1, secondary_color=c2, lat=lat, lon=lon,
                      provider_ids={}))
    for key, name in BOOKS:
        db.add(m.Sportsbook(key=key, name=name, region="us"))
    db.flush()
    nba = {t.abbreviation: t for t in db.scalars(select(m.Team).where(m.Team.league == "NBA"))}
    for abbr, name, pos, num, arche in NBA_SEED:
        first, _, last = name.partition(" ")
        p = m.Player(league="NBA", full_name=name, first_name=first, last_name=last, position=pos,
                     provider_ids={"archetype": arche})
        db.add(p)
        db.flush()
        db.add(m.RosterMembership(player_id=p.id, team_id=nba[abbr].id, season=SEED_SEASON, jersey_number=num,
                                  source=SEED_SOURCE, verified=False))
    db.commit()
    log.info("seeded registry: %d teams", db.scalar(select(func.count(m.Team.id))))


def _team_rows(db: Session, league: str) -> list[dict]:
    rows = db.execute(select(m.Team, m.Conference).join(m.Conference, isouter=True).where(m.Team.league == league)).all()
    return [dict(id=t.id, lat=t.lat, lon=t.lon, conf=c.short_name if c else None,
                 conf_strength=(c.strength if c and c.strength is not None else 0.0)) for t, c in rows]


def _player_rows(db: Session, league: str, seed: int) -> list[dict]:
    rng = np.random.default_rng(seed)
    out = []
    q = select(m.Player, m.RosterMembership).join(m.RosterMembership).where(m.Player.league == league,
                                                                            m.RosterMembership.end_date.is_(None))
    for p, rm in db.execute(q).all():
        base = ARCHETYPES[p.provider_ids.get("archetype", "wing_scorer")]
        prof = {k: float(v * rng.normal(1.0, 0.06)) for k, v in base.items()}
        out.append(dict(id=p.id, team_id=rm.team_id, profile=prof))
    return out


def generate_demo_data(db: Session, seed: int, now: datetime | None = None) -> dict:
    """Generate synthetic history + current demo season for both leagues (idempotent)."""
    if db.scalar(select(func.count(m.Game.id)).where(m.Game.is_demo.is_(True))):
        return {"status": "exists"}
    now = now or datetime.now(timezone.utc)
    books = {b.key: b.id for b in db.scalars(select(m.Sportsbook))}
    summary = {}
    next_id = (db.scalar(select(func.max(m.Game.id))) or 0) + 1
    for li, league in enumerate(("NBA", "CBB")):
        sim = LeagueSimulator(league, _team_rows(db, league), seed + li * 101, _player_rows(db, league, seed + li))
        games, tstats, pstats, odds, outcomes, props = [], [], [], [], [], []
        cur = CURRENT_SEASON_START[league]
        last_hist = cur - 1
        for yr in range(HISTORY_START[league], cur + 1):
            for g in sim.season(yr, first=(yr == HISTORY_START[league])):
                gid = next_id
                next_id += 1
                mk = sim.market(g)
                is_hist = yr < cur
                end_time = g.start + timedelta(hours=2, minutes=15)
                revealed = is_hist or end_time <= now
                hb, ab = g.result["home"], g.result["away"]
                games.append(dict(
                    id=gid, league=league, season=g.season, start_time=g.start, home_team_id=g.home,
                    away_team_id=g.away, neutral_site=g.neutral, status="final" if revealed else "scheduled",
                    period=None, clock=None, home_score=hb["points"] if revealed else None,
                    away_score=ab["points"] if revealed else None,
                    home_h1=hb["h1_points"] if revealed else None, away_h1=ab["h1_points"] if revealed else None,
                    is_demo=True, is_historical_sim=is_hist, source=DEMO_SOURCE, provider_ids={},
                    pregame_context=g.context, updated_at=now))
                if revealed:
                    for b, tid, home in ((hb, g.home, True), (ab, g.away, False)):
                        tstats.append(dict(game_id=gid, team_id=tid, is_home=home, **b))
                    for pl in g.player_lines:
                        pstats.append(dict(game_id=gid, **pl))
                if not is_hist:
                    all_props = _demo_props(gid, g, books, sim, datetime.max.replace(tzinfo=timezone.utc))
                    due = [r for r in all_props if r["captured_at"] <= now]
                    later = [dict(r, captured_at=r["captured_at"].isoformat()) for r in all_props if r["captured_at"] > now]
                    outcomes.append(dict(game_id=gid, payload=dict(
                        home=hb, away=ab, ot=g.result["ot"], players=g.player_lines, market=mk,
                        ot_periods=g.result["ot"], pending_props=later)))
                    odds += _demo_odds(gid, g.start, mk, books, sim.rng, now)
                    props += due
                elif yr == last_hist:
                    odds += _demo_odds(gid, g.start, mk, {"draftkings": books["draftkings"]}, sim.rng, now, closing_only=True)
        for chunk in _chunks(games, 2000):
            db.execute(insert(m.Game), chunk)
        for chunk in _chunks(tstats, 4000):
            db.execute(insert(m.TeamGameStat), chunk)
        for chunk in _chunks(pstats, 4000):
            db.execute(insert(m.PlayerGameStat), chunk)
        for chunk in _chunks(odds, 5000):
            db.execute(insert(m.OddsSnapshot), chunk)
        for chunk in _chunks(props, 5000):
            db.execute(insert(m.PropLine), chunk)
        for chunk in _chunks(outcomes, 2000):
            db.execute(insert(m.DemoOutcome), chunk)
        db.commit()
        summary[league] = dict(games=len(games), team_stats=len(tstats), player_stats=len(pstats), odds=len(odds))
        log.info("demo %s: %s", league, summary[league])
    return summary


def _chunks(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i: i + n]


SNAP_OFFSETS_H = [30, 12, 4, 1, 0.15]


def spread_to_ml(spread_home: float, sigma: float) -> tuple[float, float]:
    from scipy.stats import norm

    p = float(norm.cdf(-spread_home / sigma))
    return p, 1 - p


def _price(p: float, vig: float = 0.045) -> int:
    from .odds_math import decimal_to_american

    p = min(0.97, max(0.03, p * (1 + vig / 2)))
    return decimal_to_american(1 / p)


def _demo_odds(gid, start, mk, books: dict, rng, now, closing_only=False) -> list[dict]:
    rows = []
    sigma = 12.0 if mk["total"] > 180 else 10.0
    opens = dict(spread=mk["spread_home"] + rng.normal(0, 1.0), total=mk["total"] + rng.normal(0, 1.8))
    offsets = [1] if closing_only else SNAP_OFFSETS_H
    for i, off in enumerate(offsets):
        t = start - timedelta(hours=off)
        if t > now:
            continue
        w = 1.0 if closing_only else i / (len(offsets) - 1)
        sp = opens["spread"] * (1 - w) + mk["spread_home"] * w
        tot = opens["total"] * (1 - w) + mk["total"] * w
        for key, bid in books.items():
            bs = round((sp + rng.normal(0, 0.35)) * 2) / 2
            bt = round((tot + rng.normal(0, 0.5)) * 2) / 2
            h1 = round(bt * 0.49 * 2) / 2
            ph, pa = spread_to_ml(bs, sigma)
            j = lambda: int(rng.choice([-112, -110, -110, -108, -105, -115]))  # noqa: E731
            base = dict(game_id=gid, sportsbook_id=bid, captured_at=t, source=DEMO_SOURCE, is_demo=True)
            rows += [
                dict(base, market="h2h", outcome="home", line=None, price_american=_price(ph)),
                dict(base, market="h2h", outcome="away", line=None, price_american=_price(pa)),
                dict(base, market="spreads", outcome="home", line=bs, price_american=j()),
                dict(base, market="spreads", outcome="away", line=-bs, price_american=j()),
                dict(base, market="totals", outcome="over", line=bt, price_american=j()),
                dict(base, market="totals", outcome="under", line=bt, price_american=j()),
            ]
            if not closing_only:
                rows += [dict(base, market="h1_totals", outcome="over", line=h1, price_american=j()),
                         dict(base, market="h1_totals", outcome="under", line=h1, price_american=j())]
                tt_h = round(((bt - bs) / 2) * 2) / 2
                tt_a = round(((bt + bs) / 2) * 2) / 2
                rows += [dict(base, market="team_totals", outcome="home_over", line=tt_h, price_american=j()),
                         dict(base, market="team_totals", outcome="home_under", line=tt_h, price_american=j()),
                         dict(base, market="team_totals", outcome="away_over", line=tt_a, price_american=j()),
                         dict(base, market="team_totals", outcome="away_under", line=tt_a, price_american=j())]
    return rows


PROP_MARKETS = ["pts", "reb", "ast", "fg3m", "stl", "blk", "pra"]


def _demo_props(gid, g, books: dict, sim: LeagueSimulator, now) -> list[dict]:
    rows = []
    t = g.start - timedelta(hours=4)
    if t > now:
        return rows
    rng = sim.rng
    for pl in sim.players:
        if pl.team_id not in (g.home, g.away):
            continue
        prof = pl.profile
        f = prof["min"] / 36 * pl.talent
        means = {k: prof[k] * f for k in ("pts", "reb", "ast", "fg3m", "stl", "blk")}
        means["pra"] = means["pts"] + means["reb"] + means["ast"]
        for mk in PROP_MARKETS:
            mu = means[mk] * rng.normal(1.0, 0.05)
            line = max(0.5, np.floor(mu) + 0.5)
            for key in ("draftkings", "fanduel"):
                rows.append(dict(game_id=gid, player_id=pl.player_id, sportsbook_id=books[key], market=mk, line=float(line),
                                 over_price=int(rng.choice([-115, -110, -105, 100])),
                                 under_price=int(rng.choice([-115, -110, -105, -120])),
                                 captured_at=t, source=DEMO_SOURCE, is_demo=True))
    return rows
