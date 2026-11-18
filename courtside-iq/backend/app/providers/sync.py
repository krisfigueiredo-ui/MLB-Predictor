"""Map provider payloads onto the canonical schema (teams, players, games, odds)."""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from .base import ProviderError
from .clients import PROP_MARKETS, BallDontLie, OddsAPI

log = logging.getLogger(__name__)

ALIASES = {"la clippers": "los angeles clippers", "miami (fl) hurricanes": "miami hurricanes", "uconn huskies": "connecticut huskies",
           "ole miss rebels": "mississippi rebels", "nc state wolfpack": "north carolina state wolfpack"}


def norm(s: str) -> str:
    s = s.lower().replace("&", "and").replace(".", "").replace("'", "")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


class TeamMatcher:
    def __init__(self, db: Session, league: str):
        self.by_name: dict[str, m.Team] = {}
        self.by_abbr: dict[str, m.Team] = {}
        for t in db.scalars(select(m.Team).where(m.Team.league == league)):
            for n in (f"{t.location} {t.nickname}", t.location, t.nickname if league == "NBA" else None):
                if n:
                    self.by_name[norm(n)] = t
            self.by_abbr[t.abbreviation.upper()] = t
        for a, b in ALIASES.items():
            if norm(b) in self.by_name:
                self.by_name[norm(a)] = self.by_name[norm(b)]

    def match(self, name: str | None = None, abbr: str | None = None) -> m.Team | None:
        if name:
            n = norm(name)
            if n in self.by_name:
                return self.by_name[n]
            if n.startswith("miami ") and "fl" in n:
                return self.by_name.get("miami hurricanes")
            # strip mascot words progressively: "Duke Blue Devils" -> "duke"
            parts = n.split()
            for k in range(len(parts) - 1, 0, -1):
                cand = " ".join(parts[:k])
                if cand in self.by_name:
                    return self.by_name[cand]
        if abbr and abbr.upper() in self.by_abbr:
            return self.by_abbr[abbr.upper()]
        return None


def _status(bdl_status: str) -> str:
    s = (bdl_status or "").lower()
    if s == "final":
        return "final"
    if re.match(r"^\d{4}-\d{2}-\d{2}t", s) or s in ("", "scheduled"):
        return "scheduled"
    return "live"


def sync_games(db: Session, league: str, day: date, client: BallDontLie | None = None) -> int:
    client = client or BallDontLie(None)
    data = client.games(league, day.isoformat())
    matcher = TeamMatcher(db, league)
    n = 0
    for g in data:
        ht = matcher.match(g["home_team"].get("full_name"), g["home_team"].get("abbreviation"))
        at = matcher.match(g["visitor_team"].get("full_name"), g["visitor_team"].get("abbreviation"))
        if not ht or not at:
            log.warning("unmatched teams in provider game %s", g.get("id"))
            continue
        pid = str(g["id"])
        row = next((x for x in db.scalars(select(m.Game).where(m.Game.league == league, m.Game.home_team_id == ht.id,
                                                                m.Game.away_team_id == at.id, m.Game.is_demo.is_(False)))
                    if (x.provider_ids or {}).get("balldontlie") == pid), None)
        start = g.get("datetime") or g.get("date")
        start_dt = datetime.fromisoformat(str(start).replace("Z", "+00:00")) if start else datetime.combine(day, datetime.min.time(), timezone.utc)
        if start_dt.tzinfo is None:
            start_dt = start_dt.replace(tzinfo=timezone.utc)
        if row is None:
            row = m.Game(league=league, season=f"{g.get('season', day.year)}-{str(int(g.get('season', day.year)) + 1)[-2:]}",
                         start_time=start_dt, home_team_id=ht.id, away_team_id=at.id, source="balldontlie",
                         provider_ids={"balldontlie": pid}, is_demo=False)
            db.add(row)
        row.status = _status(g.get("status", ""))
        row.period = g.get("period") or None
        row.clock = (g.get("time") or "").strip() or None
        row.home_score = g.get("home_team_score")
        row.away_score = g.get("visitor_team_score")
        n += 1
    db.commit()
    return n


def sync_odds(db: Session, league: str, client: OddsAPI | None = None) -> int:
    client = client or OddsAPI(None)
    events = client.odds(league)
    matcher = TeamMatcher(db, league)
    books = {b.key: b for b in db.scalars(select(m.Sportsbook))}
    n = 0
    for ev in events:
        ht, at = matcher.match(ev["home_team"]), matcher.match(ev["away_team"])
        if not ht or not at:
            continue
        start = datetime.fromisoformat(ev["commence_time"].replace("Z", "+00:00"))
        g = db.scalar(select(m.Game).where(m.Game.home_team_id == ht.id, m.Game.away_team_id == at.id,
                                           m.Game.start_time.between(start.replace(hour=0, minute=0), start.replace(hour=23, minute=59))))
        if g is None:
            g = m.Game(league=league, season=f"{start.year if start.month > 7 else start.year - 1}-{str((start.year if start.month > 7 else start.year - 1) + 1)[-2:]}",
                       start_time=start, home_team_id=ht.id, away_team_id=at.id, source="the_odds_api",
                       provider_ids={"the_odds_api": ev["id"]}, is_demo=False)
            db.add(g)
            db.flush()
        else:
            g.provider_ids = {**(g.provider_ids or {}), "the_odds_api": ev["id"]}
        for bk in ev.get("bookmakers", []):
            book = books.get(bk["key"])
            if book is None:
                book = m.Sportsbook(key=bk["key"], name=bk["title"], region="us")
                db.add(book)
                db.flush()
                books[bk["key"]] = book
            for mk in bk.get("markets", []):
                ts = datetime.fromisoformat((mk.get("last_update") or bk["last_update"]).replace("Z", "+00:00"))
                for oc in mk.get("outcomes", []):
                    outcome = _outcome(mk["key"], oc, ev)
                    if outcome is None:
                        continue
                    db.add(m.OddsSnapshot(game_id=g.id, sportsbook_id=book.id, market=mk["key"], outcome=outcome,
                                          line=oc.get("point"), price_american=int(oc["price"]), captured_at=ts,
                                          source="the_odds_api", is_demo=False))
                    n += 1
    db.commit()
    return n


def _outcome(market: str, oc: dict, ev: dict) -> str | None:
    name = oc.get("name", "")
    if market in ("h2h", "spreads"):
        return "home" if name == ev["home_team"] else "away" if name == ev["away_team"] else None
    if market in ("totals", "totals_h1"):
        return name.lower() if name.lower() in ("over", "under") else None
    return None


def sync_event_markets(db: Session, league: str, game: m.Game, client: OddsAPI | None = None) -> int:
    """First-half totals, team totals and player props for one event (costs extra API credits)."""
    client = client or OddsAPI(None)
    eid = (game.provider_ids or {}).get("the_odds_api")
    if not eid:
        return 0
    markets = "totals_h1,team_totals" + ("," + ",".join(PROP_MARKETS) if league == "NBA" else "")
    try:
        ev = client.event_odds(league, eid, markets)
    except ProviderError as exc:
        log.warning("event odds unavailable: %s", exc)
        return 0
    books = {b.key: b for b in db.scalars(select(m.Sportsbook))}
    players = {norm(p.full_name): p for p in db.scalars(select(m.Player).where(m.Player.league == league))}
    n = 0
    for bk in ev.get("bookmakers", []):
        book = books.get(bk["key"])
        if not book:
            continue
        for mk in bk.get("markets", []):
            ts = datetime.fromisoformat(mk["last_update"].replace("Z", "+00:00"))
            if mk["key"] == "totals_h1":
                for oc in mk["outcomes"]:
                    db.add(m.OddsSnapshot(game_id=game.id, sportsbook_id=book.id, market="h1_totals", outcome=oc["name"].lower(),
                                          line=oc.get("point"), price_american=int(oc["price"]), captured_at=ts, source="the_odds_api"))
                    n += 1
            elif mk["key"] == "team_totals":
                for oc in mk["outcomes"]:
                    side = "home" if oc.get("description") == ev["home_team"] else "away"
                    db.add(m.OddsSnapshot(game_id=game.id, sportsbook_id=book.id, market="team_totals",
                                          outcome=f"{side}_{oc['name'].lower()}", line=oc.get("point"),
                                          price_american=int(oc["price"]), captured_at=ts, source="the_odds_api"))
                    n += 1
            elif mk["key"] in PROP_MARKETS:
                pairs: dict[tuple, dict] = {}
                for oc in mk["outcomes"]:
                    pairs.setdefault((oc.get("description"), oc.get("point")), {})[oc["name"].lower()] = oc["price"]
                for (pname, point), prices in pairs.items():
                    pl = players.get(norm(pname or ""))
                    if pl and "over" in prices and "under" in prices:
                        db.add(m.PropLine(game_id=game.id, player_id=pl.id, sportsbook_id=book.id, market=PROP_MARKETS[mk["key"]],
                                          line=float(point), over_price=int(prices["over"]), under_price=int(prices["under"]),
                                          captured_at=ts, source="the_odds_api"))
                        n += 1
    db.commit()
    return n


def sync_rosters(db: Session, client: BallDontLie | None = None) -> int:
    """Confirm or replace NBA roster memberships from BALLDONTLIE /players/active."""
    client = client or BallDontLie(None)
    matcher = TeamMatcher(db, "NBA")
    now = datetime.now(timezone.utc)
    season = f"{now.year if now.month > 7 else now.year - 1}-{str((now.year if now.month > 7 else now.year - 1) + 1)[-2:]}"
    cursor, n = None, 0
    while True:
        page = client.active_players(cursor)
        for p in page["data"]:
            team = matcher.match(p["team"].get("full_name"), p["team"].get("abbreviation"))
            if not team:
                continue
            full = f"{p['first_name']} {p['last_name']}"
            pl = db.scalar(select(m.Player).where(m.Player.league == "NBA", m.Player.full_name == full))
            if pl is None:
                pl = m.Player(league="NBA", full_name=full, first_name=p["first_name"], last_name=p["last_name"],
                              position=p.get("position"), provider_ids={"balldontlie": p["id"]})
                db.add(pl)
                db.flush()
            pl.provider_ids = {**(pl.provider_ids or {}), "balldontlie": p["id"]}
            cur = db.scalar(select(m.RosterMembership).where(m.RosterMembership.player_id == pl.id, m.RosterMembership.end_date.is_(None)))
            if cur and cur.team_id != team.id:
                cur.end_date = now.date()  # traded / moved: close the old membership, keep history
                cur = None
            if cur is None:
                cur = m.RosterMembership(player_id=pl.id, team_id=team.id, season=season, source="balldontlie")
                db.add(cur)
            cur.jersey_number = p.get("jersey_number") or cur.jersey_number
            cur.verified, cur.verified_at, cur.source = True, now, "balldontlie"
            n += 1
        cursor = page.get("meta", {}).get("next_cursor")
        if not cursor:
            break
    db.commit()
    return n
