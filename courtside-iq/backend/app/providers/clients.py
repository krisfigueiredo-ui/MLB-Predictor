"""Concrete provider clients against documented endpoints.

BALLDONTLIE  https://docs.balldontlie.io  (header `Authorization: <key>`)
  NBA   /v1/teams, /v1/players/active, /v1/games?dates[]=, /v1/stats?game_ids[]=, /v1/player_injuries
  NCAAB /ncaab/v1/teams, /ncaab/v1/games?dates[]=   (requires an NCAAB-enabled tier)
The Odds API v4  https://the-odds-api.com/liveapi/guides/v4/  (query parameter `apiKey`)
  /v4/sports/{basketball_nba|basketball_ncaab}/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american
  /v4/sports/{sport}/events/{id}/odds?markets=totals_h1,team_totals,alternate_spreads,player_points,...
  /v4/sports/{sport}/scores?daysFrom=1
  Usage is reported in the `x-requests-remaining` header.
SportsDataIO is supported for configuration/health only; endpoint mapping is left for a
subscriber to complete against their plan's feed documentation.
"""
from __future__ import annotations

from ..config import get_settings
from .base import Provider

SPORT_KEYS = {"NBA": "basketball_nba", "CBB": "basketball_ncaab"}
PROP_MARKETS = {"player_points": "pts", "player_rebounds": "reb", "player_assists": "ast", "player_threes": "fg3m",
                "player_steals": "stl", "player_blocks": "blk", "player_points_rebounds_assists": "pra"}


class BallDontLie(Provider):
    name = "balldontlie"
    base_url = "https://api.balldontlie.io"
    per_minute = 60  # free tier is lower (5/min); paid tiers allow 60-600/min

    def headers(self):
        return {"Authorization": self.api_key or ""}

    def prefix(self, league: str) -> str:
        return "/v1" if league == "NBA" else "/ncaab/v1"

    def games(self, league: str, date_iso: str):
        return self.get(f"{self.prefix(league)}/games", [("dates[]", date_iso), ("per_page", 100)], ttl=15)["data"]

    def teams(self, league: str):
        return self.get(f"{self.prefix(league)}/teams", ttl=86400)["data"]

    def active_players(self, cursor: int | None = None):
        p = [("per_page", 100)] + ([("cursor", cursor)] if cursor else [])
        return self.get("/v1/players/active", p, ttl=3600)

    def _paged(self, path: str, params: list, ttl: int, max_pages: int = 20) -> list:
        """Cursor pagination (meta.next_cursor)."""
        out, cursor = [], None
        for _ in range(max_pages):
            page = self.get(path, params + ([("cursor", cursor)] if cursor else []), ttl=ttl)
            out += page.get("data", [])
            cursor = (page.get("meta") or {}).get("next_cursor")
            if not cursor:
                break
        return out

    def stats(self, game_id: int):
        return self._paged("/v1/stats", [("game_ids[]", game_id), ("per_page", 100)], ttl=60)

    def injuries(self):
        return self._paged("/v1/player_injuries", [("per_page", 100)], ttl=600)


class OddsAPI(Provider):
    name = "the_odds_api"
    base_url = "https://api.the-odds-api.com"
    per_minute = 30

    def params(self):
        return {"apiKey": self.api_key or ""}

    def odds(self, league: str):
        s = get_settings()
        return self.get(f"/v4/sports/{SPORT_KEYS[league]}/odds",
                        {"regions": s.odds_api_regions, "markets": "h2h,spreads,totals", "oddsFormat": "american",
                         "bookmakers": s.odds_api_bookmakers}, ttl=120)

    def event_odds(self, league: str, event_id: str, markets: str):
        s = get_settings()
        return self.get(f"/v4/sports/{SPORT_KEYS[league]}/events/{event_id}/odds",
                        {"regions": s.odds_api_regions, "markets": markets, "oddsFormat": "american",
                         "bookmakers": s.odds_api_bookmakers}, ttl=300)

    def scores(self, league: str, days_from: int = 1):
        return self.get(f"/v4/sports/{SPORT_KEYS[league]}/scores", {"daysFrom": days_from}, ttl=30)


class SportsDataIO(Provider):
    name = "sportsdataio"
    base_url = "https://api.sportsdata.io"

    def headers(self):
        return {"Ocp-Apim-Subscription-Key": self.api_key or ""}


def clients():
    s = get_settings()
    return dict(balldontlie=BallDontLie(s.balldontlie_api_key), the_odds_api=OddsAPI(s.odds_api_key),
                sportsdataio=SportsDataIO(s.sportsdataio_api_key))
