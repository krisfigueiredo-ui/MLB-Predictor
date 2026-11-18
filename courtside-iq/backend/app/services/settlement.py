"""Reconciliation: settle predictions and user picks against final results.

Rules
- Moneyline includes overtime. Spreads/totals: exact landing on the line is a push.
- First-half totals use first-half scores only (no OT).
- Player props settle on the player's final stat line; a player who did not play => void.
- Settlement writes a `settlements` row and fills result columns; the forecast is untouched.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from .odds_math import settle_moneyline, settle_spread, settle_total

PROP_FIELD = {"pts": "pts", "reb": "reb", "ast": "ast", "fg3m": "fg3m", "stl": "stl", "blk": "blk"}


def _margin(g: m.Game, side: str) -> float:
    d = g.home_score - g.away_score
    return d if side == "home" else -d


def evaluate(market: str, selection: str, line: float | None, g: m.Game, stat_line: m.PlayerGameStat | None):
    if market == "moneyline":
        return settle_moneyline(_margin(g, selection)), float(g.home_score - g.away_score), "moneyline incl. OT"
    if market == "spread":
        return settle_spread(_margin(g, selection), line), float(g.home_score - g.away_score), "spread incl. OT; push on exact"
    if market == "total":
        t = g.home_score + g.away_score
        return settle_total(t, line, selection), float(t), "full game incl. OT; push on exact"
    if market == "h1_total":
        if g.home_h1 is None:
            return None
        t = g.home_h1 + g.away_h1
        return settle_total(t, line, selection), float(t), "first half only"
    if market.startswith("team_total_"):
        side = market.rsplit("_", 1)[1]
        t = g.home_score if side == "home" else g.away_score
        return settle_total(t, line, selection), float(t), "team points incl. OT"
    if market.startswith("prop_"):
        stat = market[5:]
        if stat_line is None or stat_line.minutes <= 0:
            return "void", None, "player did not play => void"
        v = stat_line.pts + stat_line.reb + stat_line.ast if stat == "pra" else getattr(stat_line, PROP_FIELD[stat])
        return settle_total(v, line, selection), float(v), f"player {stat} incl. OT"
    return None


def settle_game(db: Session, g: m.Game) -> int:
    if g.status != "final" or g.home_score is None:
        return 0
    n = 0
    now = datetime.now(timezone.utc)
    lines = {s.player_id: s for s in db.scalars(select(m.PlayerGameStat).where(m.PlayerGameStat.game_id == g.id))}
    for p in db.scalars(select(m.Prediction).where(m.Prediction.game_id == g.id, m.Prediction.result == "pending")):
        r = evaluate(p.market, p.selection, p.line, g, lines.get(p.player_id))
        if r is None:
            continue
        p.result, p.actual_value, p.settled_at = r[0], r[1], now
        db.add(m.Settlement(prediction_id=p.id, result=r[0], actual_value=r[1], rule=r[2], source=g.source))
        n += 1
    for pk in db.scalars(select(m.UserPick).where(m.UserPick.game_id == g.id, m.UserPick.status == "pending")):
        sel = pk.selection.lower()
        if pk.market in ("moneyline", "spread") and sel not in ("home", "away"):
            sel = "home" if sel in (g.home_team.abbreviation.lower(), g.home_team.nickname.lower()) else (
                "away" if sel in (g.away_team.abbreviation.lower(), g.away_team.nickname.lower()) else sel)
        r = evaluate(pk.market, sel, pk.line, g, lines.get(pk.player_id))
        if r is None or sel not in ("home", "away", "over", "under"):
            continue
        pk.status, pk.actual_result, pk.settled_at = r[0], f"{g.away_team.abbreviation} {g.away_score} @ {g.home_team.abbreviation} {g.home_score}", now
        db.add(m.Settlement(pick_id=pk.id, result=r[0], actual_value=r[1], rule=r[2], source=g.source))
        n += 1
    db.commit()
    return n


def settle_all(db: Session) -> int:
    ids = {gid for (gid,) in db.execute(select(m.Prediction.game_id).where(m.Prediction.result == "pending").distinct())}
    ids |= {gid for (gid,) in db.execute(select(m.UserPick.game_id).where(m.UserPick.status == "pending", m.UserPick.game_id.is_not(None)).distinct())}
    total = 0
    for g in db.scalars(select(m.Game).where(m.Game.id.in_(ids), m.Game.status == "final")):
        total += settle_game(db, g)
    return total
