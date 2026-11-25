"""Live-mode completeness: box scores, injuries, pre-game context, cross-provider de-duplication,
score-only finals, fitted prop weights and closing line value. No network (fake clients)."""
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
from sqlalchemy import select

from app import models as m
from app.providers import sync


def _team(db, abbr):
    return db.scalar(select(m.Team).where(m.Team.league == "NBA", m.Team.abbreviation == abbr))


class FakeOddsThenBDL:
    """Same real game reported by both providers: must end up as ONE row."""

    def odds(self, league):
        return [{"id": "evt-mia-chi", "commence_time": "2026-12-02T00:00:00Z", "home_team": "Miami Heat", "away_team": "Chicago Bulls",
                 "bookmakers": [{"key": "fanduel", "title": "FanDuel", "last_update": "2026-12-01T15:00:00Z", "markets": [
                     {"key": "totals", "last_update": "2026-12-01T15:00:00Z", "outcomes": [
                         {"name": "Over", "price": -110, "point": 221.5}, {"name": "Under", "price": -110, "point": 221.5}]}]}]}]

    def games(self, league, d):
        return [{"id": 777001, "date": "2026-12-01", "datetime": "2026-12-02T00:10:00Z", "season": 2026, "status": "Final", "period": 4,
                 "time": "Final", "home_team_score": 108, "visitor_team_score": 101,
                 "home_q1": 30, "home_q2": 25, "home_q3": 27, "home_q4": 26, "visitor_q1": 22, "visitor_q2": 28, "visitor_q3": 25, "visitor_q4": 26,
                 "home_team": {"full_name": "Miami Heat", "abbreviation": "MIA"}, "visitor_team": {"full_name": "Chicago Bulls", "abbreviation": "CHI"}}]

    def stats(self, game_id):
        rows = []
        for team, abbr, pts_total in (("Miami Heat", "MIA", 108), ("Chicago Bulls", "CHI", 101)):
            for i in range(8):
                rows.append({"min": "30:30" if i < 5 else "18", "fgm": 5, "fga": 11, "fg3m": 1, "fg3a": 4, "ftm": 2, "fta": 3, "oreb": 1, "dreb": 4,
                             "reb": 5, "ast": 3, "stl": 1, "blk": 0, "turnover": 2, "pts": 13 if i < 4 else 14,
                             "player": {"id": 9000 + i + (0 if abbr == "MIA" else 100), "first_name": f"{abbr}Player", "last_name": str(i), "position": "G"},
                             "team": {"full_name": team, "abbreviation": abbr}})
            rows.append({"min": "0", "pts": 0, "player": {"id": 1, "first_name": "DNP", "last_name": abbr}, "team": {"full_name": team, "abbreviation": abbr}})
        return rows

    def injuries(self):
        return [{"player": {"id": 9001, "first_name": "MIAPlayer", "last_name": "1", "team_id": None}, "team": {"full_name": "Miami Heat", "abbreviation": "MIA"},
                 "status": "Out", "description": "Ankle", "return_date": "Dec 10"}]


def test_cross_provider_dedupe_box_scores_and_h1(db):
    f = FakeOddsThenBDL()
    sync.sync_odds(db, "NBA", f)
    sync.sync_games(db, "NBA", date(2026, 12, 1), f)
    mia, chi = _team(db, "MIA"), _team(db, "CHI")
    games = db.scalars(select(m.Game).where(m.Game.home_team_id == mia.id, m.Game.away_team_id == chi.id, m.Game.is_demo.is_(False))).all()
    assert len(games) == 1, "odds feed and score feed must resolve to one game row"
    g = games[0]
    assert {"the_odds_api", "balldontlie"} <= set(g.provider_ids)
    assert g.status == "final" and (g.home_h1, g.away_h1) == (55, 50)
    n = sync.sync_box_scores(db, g, f)
    assert n == 16  # DNP rows skipped
    box = {s.is_home: s for s in db.scalars(select(m.TeamGameStat).where(m.TeamGameStat.game_id == g.id))}
    assert box[True].fga == 88 and box[True].tov == 16 and box[True].points == 108
    assert abs(box[True].possessions - (88 - 8 + 16 + 0.44 * 24)) < 1e-9
    starter = db.scalar(select(m.PlayerGameStat).join(m.Player).where(m.PlayerGameStat.game_id == g.id, m.Player.full_name == "MIAPlayer 0"))
    assert abs(starter.minutes - 30.5) < 1e-9  # "30:30" parsed
    assert sync.sync_box_scores(db, g, f) == 0  # idempotent


def test_injuries_and_pregame_context(db):
    f = FakeOddsThenBDL()
    out = sync.sync_injuries(db, f)
    assert out["reports"] == 1
    inj = db.scalar(select(m.Injury).join(m.Player).where(m.Player.full_name == "MIAPlayer 1", m.Injury.cleared_at.is_(None)))
    assert inj is not None and inj.status == "out"
    # an upcoming real MIA game picks up the injury impact (player averaged 30.5 minutes)
    mia, bos = _team(db, "MIA"), _team(db, "BOS")
    now = datetime.now(timezone.utc)
    g = m.Game(league="NBA", season="2026-27", start_time=now + timedelta(hours=10), home_team_id=mia.id, away_team_id=bos.id,
               status="scheduled", source="balldontlie", is_demo=False, provider_ids={})
    db.add(g)
    db.commit()
    assert sync.refresh_pregame_context(db, now) >= 1
    db.refresh(g)
    assert abs(g.pregame_context["home"]["injury_impact"] - round(30.5 / 48 * 1.0 * 4.0, 2)) < 1e-9
    assert g.pregame_context["home"]["lineup_change"] is True and "known_at" in g.pregame_context
    # report disappears from the feed -> cleared, history kept
    class Empty:
        def injuries(self):
            return []
    assert sync.sync_injuries(db, Empty())["cleared"] >= 1
    assert db.scalar(select(m.Injury).where(m.Injury.id == inj.id)).cleared_at is not None


def test_score_only_finals_update_features():
    """Imported results without box scores still move team efficiency and provide targets."""
    from app.ml.features import build_features

    t0 = pd.Timestamp("2026-01-01", tz="UTC")
    rows = []
    for i in range(6):
        rows.append(dict(id=i + 1, start_time=t0 + pd.Timedelta(days=2 * i), season="2025-26", home_team_id=1, away_team_id=2,
                         neutral_site=False, status="final_no_box", pregame_context={},
                         home_points=130.0, away_points=95.0, home_h1_points=np.nan, away_h1_points=np.nan,
                         **{f"{s}_{k}": np.nan for s in ("home", "away") for k in ("fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "tov", "possessions")}))
    games = pd.DataFrame(rows)
    teams = pd.DataFrame([dict(id=1, lat=40.0, lon=-74.0, conference=None, conf_strength=None), dict(id=2, lat=42.0, lon=-71.0, conference=None, conf_strength=None)])
    f = build_features(games, teams, "NBA").set_index("id")
    assert f.loc[1, "y_margin"] == 35 and f["y_total"].notna().all()
    assert f.loc[6, "h_adj_ortg"] > f.loc[1, "h_adj_ortg"]  # efficiency learned from scores alone
    assert f.loc[6, "h_pace"] == f.loc[1, "h_pace"]  # pace untouched without possession data


def test_fitted_prop_weights_and_clv(trained, db):
    from app.services import modeling, performance

    modeling.backfill_current_season(db, "NBA", max_games=400)
    from app.services import settlement

    settlement.settle_all(db)
    fit = modeling.fit_prop_blend(db, "NBA", min_n=30)
    assert fit["weights"], fit
    for stat, w in fit["weights"].items():
        assert 0.0 <= w <= 1.0
        ev = fit["evaluation"][stat]
        assert "decision" in ev and ev["n_holdout"] > 0
    mv = modeling.active_version(db, "NBA", "props")
    db.refresh(mv)
    assert mv.params["prop_blend"]["weights"] == fit["weights"]
    clv = performance.clv_report(db, "NBA")
    assert clv["n"] > 0
    for mk, v in clv["markets"].items():
        assert v["n"] > 0 and 0 <= v["beat_close"] <= 1
