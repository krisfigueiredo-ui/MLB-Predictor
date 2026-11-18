"""Provider mapping tests with recorded payload shapes (no network)."""
from datetime import date

from sqlalchemy import select

from app import models as m
from app.providers import sync
from app.providers.base import Provider, ProviderError


def test_team_matcher(db):
    nba = sync.TeamMatcher(db, "NBA")
    assert nba.match("Los Angeles Lakers").abbreviation == "LAL"
    assert nba.match("LA Clippers").abbreviation == "LAC"
    assert nba.match(None, "okc").nickname == "Thunder"
    cbb = sync.TeamMatcher(db, "CBB")
    assert cbb.match("Duke Blue Devils").location == "Duke"
    assert cbb.match("Miami (FL) Hurricanes").location == "Miami"
    assert cbb.match("West Virginia Mountaineers").location == "West Virginia"
    assert cbb.match("Kentucky Wildcats").location == "Kentucky"


def test_unconfigured_provider_raises():
    p = Provider(None)
    try:
        p.get("/x")
        assert False
    except ProviderError as e:
        assert "not configured" in str(e)


class FakeOdds:
    def odds(self, league):
        return [{"id": "evt1", "commence_time": "2026-11-20T00:30:00Z", "home_team": "Boston Celtics", "away_team": "New York Knicks",
                 "bookmakers": [{"key": "draftkings", "title": "DraftKings", "last_update": "2026-11-19T18:00:00Z", "markets": [
                     {"key": "spreads", "last_update": "2026-11-19T18:00:00Z", "outcomes": [
                         {"name": "Boston Celtics", "price": -110, "point": -3.5}, {"name": "New York Knicks", "price": -110, "point": 3.5}]},
                     {"key": "totals", "last_update": "2026-11-19T18:00:00Z", "outcomes": [
                         {"name": "Over", "price": -108, "point": 224.5}, {"name": "Under", "price": -112, "point": 224.5}]}]}]}]


class FakeBDL:
    def games(self, league, d):
        return [{"id": 99001, "date": "2026-11-21", "datetime": "2026-11-22T00:00:00Z", "season": 2026, "status": "3rd Qtr", "period": 3,
                 "time": "5:12", "home_team_score": 70, "visitor_team_score": 66,
                 "home_team": {"full_name": "Denver Nuggets", "abbreviation": "DEN"},
                 "visitor_team": {"full_name": "Phoenix Suns", "abbreviation": "PHX"}}]


def test_sync_odds_and_games_map_to_schema(db):
    n = sync.sync_odds(db, "NBA", FakeOdds())
    assert n == 4
    g = db.scalar(select(m.Game).where(m.Game.source == "the_odds_api"))
    assert g.home_team.abbreviation == "BOS" and g.is_demo is False
    snaps = db.scalars(select(m.OddsSnapshot).where(m.OddsSnapshot.game_id == g.id)).all()
    assert {(s.market, s.outcome) for s in snaps} == {("spreads", "home"), ("spreads", "away"), ("totals", "over"), ("totals", "under")}
    assert sync.sync_games(db, "NBA", date(2026, 11, 21), FakeBDL()) == 1
    live = db.scalar(select(m.Game).where(m.Game.source == "balldontlie"))
    assert live.status == "live" and live.period == 3 and live.home_score == 70
    # idempotent
    sync.sync_games(db, "NBA", date(2026, 11, 21), FakeBDL())
    assert db.query(m.Game).filter(m.Game.source == "balldontlie").count() == 1
