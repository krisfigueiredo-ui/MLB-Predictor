from __future__ import annotations

from datetime import timezone

from fastapi import Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from ..config import get_settings


def require_admin(x_admin_token: str | None = Header(default=None)):
    tok = get_settings().admin_token
    if tok and x_admin_token != tok:
        raise HTTPException(401, "admin token required")


def iso(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


_asset_cache: dict[tuple, dict | None] = {}


def asset(db: Session, entity_type: str, entity_id: int, kind: str) -> dict | None:
    key = (entity_type, entity_id, kind)
    if key not in _asset_cache:
        a = db.scalar(select(m.Asset).where(m.Asset.entity_type == entity_type, m.Asset.entity_id == entity_id, m.Asset.kind == kind)
                      .order_by(m.Asset.verified.desc(), m.Asset.id.desc()))
        if a is None and kind == "logo":
            base = get_settings().licensed_logo_base_url
            if base:
                t = db.get(m.Team, entity_id)
                _asset_cache[key] = dict(url=f"{base.rstrip('/')}/{t.slug}.svg", license="licensed CDN (configured)", source="LICENSED_LOGO_BASE_URL", verified=False)
                return _asset_cache[key]
        _asset_cache[key] = dict(url=a.url, license=a.license, source=a.source, verified=a.verified) if a else None
    return _asset_cache[key]


def clear_asset_cache():
    _asset_cache.clear()


def team_out(db: Session, t: m.Team, brief: bool = False) -> dict:
    d = dict(id=t.id, league=t.league, slug=t.slug, abbr=t.abbreviation, location=t.location, nickname=t.nickname,
             name=t.display_name, primary=t.primary_color, secondary=t.secondary_color,
             conference=t.conference.short_name if t.conference else None, logo=asset(db, "team", t.id, "logo"))
    if not brief:
        d.update(division=t.division, venue=t.venue, conference_name=t.conference.name if t.conference else None)
    return d


def player_out(db: Session, p: m.Player, rm: m.RosterMembership | None = None) -> dict:
    if rm is None:
        rm = db.scalar(select(m.RosterMembership).where(m.RosterMembership.player_id == p.id, m.RosterMembership.end_date.is_(None)))
    return dict(id=p.id, league=p.league, name=p.full_name, first=p.first_name, last=p.last_name, position=p.position,
                jersey=rm.jersey_number if rm else None, team=team_out(db, rm.team, brief=True) if rm else None,
                roster=dict(verified=rm.verified, source=rm.source, season=rm.season, verified_at=iso(rm.verified_at)) if rm else None,
                portrait=asset(db, "player", p.id, "portrait"))


def game_out(db: Session, g: m.Game) -> dict:
    return dict(id=g.id, league=g.league, season=g.season, start_time=iso(g.start_time), status=g.status, period=g.period, clock=g.clock,
                home=team_out(db, g.home_team, brief=True), away=team_out(db, g.away_team, brief=True), home_score=g.home_score,
                away_score=g.away_score, home_h1=g.home_h1, away_h1=g.away_h1, neutral=g.neutral_site, is_demo=g.is_demo,
                source=g.source, updated_at=iso(g.updated_at))
