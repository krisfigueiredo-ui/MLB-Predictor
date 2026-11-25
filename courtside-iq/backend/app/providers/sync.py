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
        start = g.get("datetime") or g.get("date")
        start_dt = datetime.fromisoformat(str(start).replace("Z", "+00:00")) if start else datetime.combine(day, datetime.min.time(), timezone.utc)
        if start_dt.tzinfo is None:
            start_dt = start_dt.replace(tzinfo=timezone.utc)
        row = find_existing_game(db, league, ht.id, at.id, start_dt, "balldontlie", pid)
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
        if "T" in str(start or "") and row.status == "scheduled":
            row.start_time = start_dt  # provider tip time is authoritative before tip-off
        # first-half score from per-quarter fields when the feed includes them (optional)
        q = {k: g.get(k) for k in ("home_q1", "home_q2", "visitor_q1", "visitor_q2")}
        if all(v is not None for v in q.values()) and (row.period or 0) >= 3 or (row.status == "final" and all(v is not None for v in q.values())):
            row.home_h1 = int(q["home_q1"]) + int(q["home_q2"])
            row.away_h1 = int(q["visitor_q1"]) + int(q["visitor_q2"])
        n += 1
    db.commit()
    return n


def find_existing_game(db: Session, league: str, home_id: int, away_id: int, start: datetime, provider: str,
                       provider_id: str | None) -> m.Game | None:
    """One row per real game across providers: match by provider id, else by teams within ±18h."""
    cands = db.scalars(select(m.Game).where(m.Game.league == league, m.Game.home_team_id == home_id, m.Game.away_team_id == away_id,
                                            m.Game.is_demo.is_(False))).all()
    if provider_id:
        for x in cands:
            if (x.provider_ids or {}).get(provider) == provider_id:
                return x
    for x in cands:
        st = x.start_time if x.start_time.tzinfo else x.start_time.replace(tzinfo=timezone.utc)
        if abs((st - start).total_seconds()) <= 18 * 3600:
            if provider_id:
                x.provider_ids = {**(x.provider_ids or {}), provider: provider_id}
            return x
    return None


def _minutes(v) -> float:
    """BALLDONTLIE `min` arrives as "34", "34:12" or a number."""
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    sv = str(v)
    if ":" in sv:
        mm, ss = sv.split(":", 1)
        return float(mm or 0) + float(ss or 0) / 60
    try:
        return float(sv)
    except ValueError:
        return 0.0


def sync_box_scores(db: Session, game: m.Game, client: BallDontLie | None = None) -> int:
    """Player box scores for one final NBA game -> PlayerGameStat, aggregated into TeamGameStat.

    Field names follow the BALLDONTLIE stat object (min, fgm, fga, fg3m, fg3a, ftm, fta, oreb,
    dreb, reb, ast, stl, blk, turnover, pts, player, team); `tov` is accepted as an alias.
    """
    client = client or BallDontLie(None)
    bid = (game.provider_ids or {}).get("balldontlie")
    if not bid or game.league != "NBA":
        return 0
    if db.scalar(select(m.TeamGameStat.id).where(m.TeamGameStat.game_id == game.id)):
        return 0
    rows = client.stats(int(bid))
    if not rows:
        return 0
    matcher = TeamMatcher(db, "NBA")
    totals: dict[int, dict] = {}
    n = 0
    for r in rows:
        t = r.get("team") or {}
        team = matcher.match(t.get("full_name"), t.get("abbreviation"))
        if team is None or team.id not in (game.home_team_id, game.away_team_id):
            continue
        mins = _minutes(r.get("min"))
        g = lambda k, *alts: int(next((r[x] for x in (k, *alts) if r.get(x) is not None), 0) or 0)  # noqa: E731
        line = dict(fgm=g("fgm"), fga=g("fga"), fg3m=g("fg3m"), fg3a=g("fg3a"), ftm=g("ftm"), fta=g("fta"), oreb=g("oreb"),
                    dreb=g("dreb"), reb=g("reb"), ast=g("ast"), stl=g("stl"), blk=g("blk"), tov=g("turnover", "tov"), pts=g("pts"))
        tt = totals.setdefault(team.id, {k: 0 for k in line})
        for k, v in line.items():
            tt[k] += v
        p = r.get("player") or {}
        if mins <= 0 or not p:
            continue
        pl = _upsert_player(db, p, team)
        db.add(m.PlayerGameStat(game_id=game.id, player_id=pl.id, team_id=team.id, started=False, minutes=mins, pts=line["pts"],
                                reb=line["reb"] or line["oreb"] + line["dreb"], ast=line["ast"], fg3m=line["fg3m"], fg3a=line["fg3a"],
                                fga=line["fga"], fta=line["fta"], stl=line["stl"], blk=line["blk"], tov=line["tov"]))
        n += 1
    if len(totals) == 2:
        for tid, tt in totals.items():
            home = tid == game.home_team_id
            poss = tt["fga"] - tt["oreb"] + tt["tov"] + 0.44 * tt["fta"]
            db.add(m.TeamGameStat(game_id=game.id, team_id=tid, is_home=home,
                                  points=game.home_score if home and game.home_score is not None else (game.away_score if not home and game.away_score is not None else tt["pts"]),
                                  h1_points=game.home_h1 if home else game.away_h1, fgm=tt["fgm"], fga=tt["fga"], fg3m=tt["fg3m"],
                                  fg3a=tt["fg3a"], ftm=tt["ftm"], fta=tt["fta"], oreb=tt["oreb"], dreb=tt["dreb"], tov=tt["tov"],
                                  ast=tt["ast"], possessions=poss))
    db.commit()
    return n


def _upsert_player(db: Session, p: dict, team: m.Team) -> m.Player:
    pid = p.get("id")
    full = f"{p.get('first_name', '')} {p.get('last_name', '')}".strip()
    pl = next((x for x in db.scalars(select(m.Player).where(m.Player.league == "NBA", m.Player.full_name == full))), None)
    if pl is None:
        pl = m.Player(league="NBA", full_name=full, first_name=p.get("first_name", ""), last_name=p.get("last_name", ""),
                      position=p.get("position") or None, provider_ids={"balldontlie": pid})
        db.add(pl)
        db.flush()
    if pid and (pl.provider_ids or {}).get("balldontlie") != pid:
        pl.provider_ids = {**(pl.provider_ids or {}), "balldontlie": pid}
    return pl


INJURY_STATUS = {"out": "out", "out for season": "out", "doubtful": "doubtful", "questionable": "questionable",
                 "day-to-day": "questionable", "day to day": "questionable", "probable": "probable"}
INJURY_WEIGHT = {"out": 1.0, "doubtful": 0.75, "questionable": 0.35, "probable": 0.1}


def sync_injuries(db: Session, client: BallDontLie | None = None) -> dict:
    """Upsert the current NBA injury report; reports no longer listed are marked cleared."""
    client = client or BallDontLie(None)
    data = client.injuries()
    matcher = TeamMatcher(db, "NBA")
    now = datetime.now(timezone.utc)
    seen: set[int] = set()
    n = 0
    for r in data:
        p = r.get("player") or {}
        team_info = r.get("team") or p.get("team") or {}
        team = matcher.match(team_info.get("full_name"), team_info.get("abbreviation"))
        if team is None and p.get("team_id"):
            team = next((t for t in matcher.by_abbr.values() if (t.provider_ids or {}).get("balldontlie") == p.get("team_id")), None)
        if team is None:
            continue
        pl = _upsert_player(db, p, team)
        status = INJURY_STATUS.get(str(r.get("status", "")).strip().lower(), "questionable")
        cur = db.scalar(select(m.Injury).where(m.Injury.player_id == pl.id, m.Injury.cleared_at.is_(None), m.Injury.source == "balldontlie"))
        desc = (r.get("description") or "")[:200] or None
        if cur is None or cur.status != status or cur.description != desc:
            if cur is not None:
                cur.cleared_at = now  # keep history: close the old report, open a new one
            db.add(m.Injury(player_id=pl.id, team_id=team.id, status=status, description=desc, reported_at=now, source="balldontlie"))
        seen.add(pl.id)
        n += 1
    cleared = 0
    for inj in db.scalars(select(m.Injury).where(m.Injury.cleared_at.is_(None), m.Injury.source == "balldontlie")):
        if inj.player_id not in seen:
            inj.cleared_at = now
            cleared += 1
    db.commit()
    return {"reports": n, "cleared": cleared}


def refresh_pregame_context(db: Session, now: datetime | None = None, hours: int = 36) -> int:
    """Write knowable-before-tip information into `pregame_context` for upcoming real games:
    injury impact = sum over listed players of (recent minutes / 48) x status weight x 4 pts/100,
    and lineup_change when a regular (>= 24 min) is out or doubtful. Timestamped with known_at."""
    import pandas as pd

    now = now or datetime.now(timezone.utc)
    games = db.scalars(select(m.Game).where(m.Game.is_demo.is_(False), m.Game.status == "scheduled", m.Game.start_time > now,
                                            m.Game.start_time <= now + pd.Timedelta(hours=hours))).all()
    if not games:
        return 0
    active = db.scalars(select(m.Injury).where(m.Injury.cleared_at.is_(None))).all()
    by_team: dict[int, list] = {}
    for inj in active:
        by_team.setdefault(inj.team_id, []).append(inj)
    mins_cache: dict[int, float] = {}

    def recent_minutes(pid: int) -> float:
        if pid not in mins_cache:
            q = (select(m.PlayerGameStat.minutes).join(m.Game, m.Game.id == m.PlayerGameStat.game_id)
                 .where(m.PlayerGameStat.player_id == pid).order_by(m.Game.start_time.desc()).limit(10))
            xs = [x for (x,) in db.execute(q).all()]
            mins_cache[pid] = float(sum(xs) / len(xs)) if xs else 0.0
        return mins_cache[pid]

    n = 0
    for g in games:
        ctx = dict(g.pregame_context or {})
        for side, tid in (("home", g.home_team_id), ("away", g.away_team_id)):
            lst = by_team.get(tid, [])
            impact = sum(recent_minutes(i.player_id) / 48 * INJURY_WEIGHT.get(i.status, 0.35) * 4.0 for i in lst)
            change = any(i.status in ("out", "doubtful") and recent_minutes(i.player_id) >= 24 for i in lst)
            ctx[side] = {**(ctx.get(side) or {}), "injury_impact": round(impact, 2), "lineup_change": change,
                         "injuries": [dict(player_id=i.player_id, status=i.status) for i in lst]}
        ctx["known_at"] = now.isoformat()
        g.pregame_context = ctx
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
        g = find_existing_game(db, league, ht.id, at.id, start, "the_odds_api", ev["id"])
        if g is None:
            g = m.Game(league=league, season=f"{start.year if start.month > 7 else start.year - 1}-{str((start.year if start.month > 7 else start.year - 1) + 1)[-2:]}",
                       start_time=start, home_team_id=ht.id, away_team_id=at.id, source="the_odds_api",
                       provider_ids={"the_odds_api": ev["id"]}, is_demo=False)
            db.add(g)
            db.flush()
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
    markets = "totals_h1,team_totals,alternate_spreads,alternate_totals" + ("," + ",".join(PROP_MARKETS) if league == "NBA" else "")
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
            elif mk["key"] in ("alternate_spreads", "alternate_totals"):
                for oc in mk["outcomes"]:
                    if mk["key"] == "alternate_spreads":
                        side = "home" if oc.get("name") == ev["home_team"] else "away" if oc.get("name") == ev["away_team"] else None
                    else:
                        side = oc.get("name", "").lower() if oc.get("name", "").lower() in ("over", "under") else None
                    if side is None or oc.get("point") is None:
                        continue
                    db.add(m.OddsSnapshot(game_id=game.id, sportsbook_id=book.id, market=mk["key"], outcome=side, line=float(oc["point"]),
                                          price_american=int(oc["price"]), captured_at=ts, source="the_odds_api"))
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
