"""Market views over immutable odds snapshots: consensus, best prices, movement."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from statistics import median

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from .odds_math import implied_prob, no_vig_two_way


def _aware(dt):
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def latest_by_book(db: Session, game_id: int, as_of: datetime | None = None) -> dict:
    q = select(m.OddsSnapshot).where(m.OddsSnapshot.game_id == game_id)
    if as_of is not None:
        q = q.where(m.OddsSnapshot.captured_at <= as_of)
    latest: dict[tuple, m.OddsSnapshot] = {}
    for s in db.scalars(q.order_by(m.OddsSnapshot.captured_at)):
        latest[(s.sportsbook_id, s.market, s.outcome)] = s
    return latest


def consensus(db: Session, game_id: int, as_of: datetime | None = None) -> dict:
    latest = latest_by_book(db, game_id, as_of)
    if not latest:
        return {}
    books = {b.id: b for b in db.scalars(select(m.Sportsbook))}
    by = defaultdict(list)
    for (bid, mk, oc), s in latest.items():
        by[(mk, oc)].append(s)
    out: dict = {"captured_at": max(_aware(s.captured_at) for s in latest.values()), "books": sorted({books[b].name for b, _, _ in latest}),
                 "is_demo": any(s.is_demo for s in latest.values())}

    def med(mk, oc, attr="line"):
        v = [getattr(s, attr) for s in by.get((mk, oc), []) if getattr(s, attr) is not None]
        return float(median(v)) if v else None

    def best(mk, oc):
        c = by.get((mk, oc), [])
        if not c:
            return None
        s = max(c, key=lambda x: x.price_american if x.price_american > 0 else -10000 / x.price_american)
        return dict(price=s.price_american, book=books[s.sportsbook_id].name, book_id=s.sportsbook_id, line=s.line)

    ml_h, ml_a = med("h2h", "home", "price_american"), med("h2h", "away", "price_american")
    out.update(
        ml_home=int(ml_h) if ml_h else None, ml_away=int(ml_a) if ml_a else None,
        best_ml_home=best("h2h", "home"), best_ml_away=best("h2h", "away"),
        spread_home=_half(med("spreads", "home")), spread_price_home=_int(med("spreads", "home", "price_american")),
        spread_price_away=_int(med("spreads", "away", "price_american")),
        total=_half(med("totals", "over")), total_price_over=_int(med("totals", "over", "price_american")),
        total_price_under=_int(med("totals", "under", "price_american")),
        h1_total=_half(med("h1_totals", "over")),
        team_total_home=_half(med("team_totals", "home_over")), team_total_away=_half(med("team_totals", "away_over")),
    )
    if out["ml_home"] and out["ml_away"]:
        out["no_vig_home"], out["no_vig_away"] = no_vig_two_way(out["ml_home"], out["ml_away"])
        out["implied_home"], out["implied_away"] = implied_prob(out["ml_home"]), implied_prob(out["ml_away"])
    out["by_book"] = _by_book(latest, books)
    return out


def _half(x):
    return None if x is None else round(x * 2) / 2


def _int(x):
    return None if x is None else int(round(x))


def _by_book(latest, books) -> list[dict]:
    rows = defaultdict(dict)
    for (bid, mk, oc), s in latest.items():
        r = rows[bid]
        r["book"] = books[bid].name
        r["captured_at"] = max(_aware(s.captured_at), r.get("captured_at") or _aware(s.captured_at))
        r[f"{mk}_{oc}"] = dict(line=s.line, price=s.price_american)
    return list(rows.values())


def movement(db: Session, game_id: int) -> dict:
    snaps = db.scalars(select(m.OddsSnapshot).where(m.OddsSnapshot.game_id == game_id).order_by(m.OddsSnapshot.captured_at)).all()
    books = {b.id: b.name for b in db.scalars(select(m.Sportsbook))}
    series = defaultdict(list)
    for s in snaps:
        if (s.market, s.outcome) in (("spreads", "home"), ("totals", "over"), ("h2h", "home")):
            series[f"{s.market}"].append(dict(t=_aware(s.captured_at).isoformat(), book=books[s.sportsbook_id],
                                              line=s.line, price=s.price_american))
    game = db.get(m.Game, game_id)
    start = _aware(game.start_time) if game else None
    started = bool(start and start <= datetime.now(timezone.utc))
    summary = {}
    for mk, pts in series.items():
        key = "price" if mk == "h2h" else "line"
        first, last = pts[0], pts[-1]
        pre = [p for p in pts if start is None or datetime.fromisoformat(p["t"]) <= start]
        summary[mk] = dict(open=first[key], current=last[key], move=(last[key] - first[key]) if first[key] is not None else None,
                           opened_at=first["t"], last_at=last["t"], n_snapshots=len(pts),
                           close=pre[-1][key] if (started and pre) else None, closed=started)
    return dict(series=series, summary=summary, n=len(snaps))


def prop_lines(db: Session, game_id: int, as_of: datetime | None = None) -> dict:
    q = select(m.PropLine).where(m.PropLine.game_id == game_id)
    if as_of is not None:
        q = q.where(m.PropLine.captured_at <= as_of)
    books = {b.id: b.name for b in db.scalars(select(m.Sportsbook))}
    out = {}
    for p in db.scalars(q.order_by(m.PropLine.captured_at)):
        out[(p.player_id, p.market)] = dict(line=p.line, over_price=p.over_price, under_price=p.under_price,
                                            book=books[p.sportsbook_id], captured_at=_aware(p.captured_at).isoformat(),
                                            is_demo=p.is_demo)
    return out
