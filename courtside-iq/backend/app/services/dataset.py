"""Load games + box scores from the database into modelling DataFrames (any data source)."""
from __future__ import annotations

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m

BOX = ["points", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "tov", "possessions", "h1_points"]


def teams_df(db: Session, league: str) -> pd.DataFrame:
    rows = db.execute(select(m.Team, m.Conference).join(m.Conference, isouter=True).where(m.Team.league == league)).all()
    return pd.DataFrame([dict(id=t.id, lat=t.lat, lon=t.lon, conference=c.short_name if c else None,
                              conf_strength=c.strength if c else None) for t, c in rows])


def games_df(db: Session, league: str, include_demo: bool = True) -> pd.DataFrame:
    q = select(m.Game).where(m.Game.league == league)
    if not include_demo:
        q = q.where(m.Game.is_demo.is_(False))
    games = db.scalars(q).all()
    stats = db.scalars(select(m.TeamGameStat).join(m.Game).where(m.Game.league == league)).all()
    by = {(s.game_id, s.is_home): s for s in stats}
    rows = []
    for g in games:
        r = dict(id=g.id, start_time=pd.Timestamp(g.start_time).tz_localize("UTC") if g.start_time.tzinfo is None else pd.Timestamp(g.start_time),
                 season=g.season, home_team_id=g.home_team_id, away_team_id=g.away_team_id,
                 neutral_site=g.neutral_site, status=g.status, pregame_context=g.pregame_context or {},
                 is_demo=g.is_demo, is_historical_sim=g.is_historical_sim)
        for side, home in (("home", True), ("away", False)):
            s = by.get((g.id, home))
            for k in BOX:
                r[f"{side}_{k}"] = float(getattr(s, k)) if (s is not None and getattr(s, k) is not None) else float("nan")
            if s is None and g.status == "final" and g.home_score is not None:
                # final score without a box score (e.g. imported results) — points only
                r[f"{side}_points"] = float(g.home_score if home else g.away_score)
        rows.append(r)
    df = pd.DataFrame(rows)
    if not df.empty:
        # a final with no box score can't update four-factor state; treat as unplayed for features
        no_box = (df["status"] == "final") & df["home_fga"].isna()
        df.loc[no_box, "status"] = "final_no_box"
    return df


def feature_frame(db: Session, league: str) -> pd.DataFrame:
    from ..ml.features import build_features

    g = games_df(db, league)
    if g.empty:
        return g
    f = build_features(g, teams_df(db, league), league)
    return f.merge(g[["id", "start_time", "season", "status", "is_historical_sim", "home_team_id", "away_team_id"]], on="id")
