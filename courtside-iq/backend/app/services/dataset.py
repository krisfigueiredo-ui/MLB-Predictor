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
                # final score without a box score (e.g. imported results): points only
                r[f"{side}_points"] = float(g.home_score if home else g.away_score)
                h1 = g.home_h1 if home else g.away_h1
                r[f"{side}_h1_points"] = float(h1) if h1 is not None else float("nan")
        rows.append(r)
    df = pd.DataFrame(rows)
    if not df.empty:
        # a final with no box score can't update four-factor state; treat as unplayed for features
        no_box = (df["status"] == "final") & df["home_fga"].isna()
        df.loc[no_box, "status"] = "final_no_box"
    return df


def market_lines(db: Session, league: str, lead_minutes: int = 55) -> pd.DataFrame:
    """Pre-game consensus (median across books of each book's latest snapshot captured at least
    `lead_minutes` before tip-off) for the home spread and the full-game total."""
    q = (select(m.OddsSnapshot.game_id, m.OddsSnapshot.sportsbook_id, m.OddsSnapshot.market, m.OddsSnapshot.line,
                m.OddsSnapshot.captured_at, m.Game.start_time)
         .join(m.Game, m.Game.id == m.OddsSnapshot.game_id)
         .where(m.Game.league == league, m.OddsSnapshot.line.is_not(None),
                ((m.OddsSnapshot.market == "spreads") & (m.OddsSnapshot.outcome == "home"))
                | ((m.OddsSnapshot.market == "totals") & (m.OddsSnapshot.outcome == "over"))))
    df = pd.DataFrame(db.execute(q).all(), columns=["id", "book", "market", "line", "captured_at", "start_time"])
    if df.empty:
        return pd.DataFrame(columns=["id", "mkt_spread_home", "mkt_total"])
    cap = pd.to_datetime(df["captured_at"], utc=True)
    st = pd.to_datetime(df["start_time"], utc=True)
    df = df[cap <= st - pd.Timedelta(minutes=lead_minutes)].assign(captured_at=cap)
    df = df.sort_values("captured_at").groupby(["id", "book", "market"]).tail(1)
    piv = df.groupby(["id", "market"])["line"].median().unstack()
    piv = piv.rename(columns={"spreads": "mkt_spread_home", "totals": "mkt_total"}).reset_index()
    for c in ("mkt_spread_home", "mkt_total"):
        if c not in piv:
            piv[c] = float("nan")
    return piv[["id", "mkt_spread_home", "mkt_total"]]


def feature_frame(db: Session, league: str) -> pd.DataFrame:
    from ..ml.features import build_features

    g = games_df(db, league)
    if g.empty:
        return g
    f = build_features(g, teams_df(db, league), league)
    f = f.merge(g[["id", "start_time", "season", "status", "is_historical_sim", "home_team_id", "away_team_id"]], on="id")
    # market lines are NOT model features; they are used only for the market-informed blend
    return f.merge(market_lines(db, league), on="id", how="left")
