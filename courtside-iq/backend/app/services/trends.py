"""Trends Lab computations. Every series carries sample size and data source.

Streaks are descriptive: the API attaches a significance note comparing the window to the
season baseline with a simple standard-error check, and never treats them as predictive.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .. import models as m
from .market import consensus


def team_games(db: Session, team_id: int, season: str | None = None) -> pd.DataFrame:
    q = (select(m.Game).where(or_(m.Game.home_team_id == team_id, m.Game.away_team_id == team_id),
                              m.Game.status == "final").order_by(m.Game.start_time))
    if season:
        q = q.where(m.Game.season == season)
    games = db.scalars(q).all()
    stats = {(s.game_id, s.team_id): s for s in db.scalars(select(m.TeamGameStat).where(m.TeamGameStat.game_id.in_([g.id for g in games])))}
    teams = {t.id: t.abbreviation for t in db.scalars(select(m.Team))}
    rows = []
    for g in games:
        home = g.home_team_id == team_id
        opp = g.away_team_id if home else g.home_team_id
        me, them = stats.get((g.id, team_id)), stats.get((g.id, opp))
        pts = g.home_score if home else g.away_score
        opp_pts = g.away_score if home else g.home_score
        r = dict(game_id=g.id, date=g.start_time.isoformat(), season=g.season, home=home, neutral=g.neutral_site,
                 opponent=teams[opp], opponent_id=opp, pts=pts, opp_pts=opp_pts, margin=pts - opp_pts, total=pts + opp_pts,
                 h1_total=(g.home_h1 + g.away_h1) if g.home_h1 is not None else None, source=g.source, is_demo=g.is_demo)
        if me and them:
            poss = (me.possessions + them.possessions) / 2
            r.update(pace=poss, ortg=100 * me.points / poss, drtg=100 * them.points / poss,
                     efg=(me.fgm + 0.5 * me.fg3m) / max(1, me.fga), tov=me.tov / poss, orb=me.oreb / max(1, me.oreb + them.dreb),
                     ftr=me.fta / max(1, me.fga))
        c = consensus(db, g.id, as_of=g.start_time)
        if c.get("spread_home") is not None:
            line = c["spread_home"] if home else -c["spread_home"]
            adj = r["margin"] + line
            r["spread_line"] = line
            r["ats"] = "push" if adj == 0 else ("cover" if adj > 0 else "fail")
        if c.get("total") is not None:
            r["total_line"] = c["total"]
            r["ou"] = "push" if r["total"] == c["total"] else ("over" if r["total"] > c["total"] else "under")
        rows.append(r)
    return pd.DataFrame(rows)


def _note(window: pd.Series, base: pd.Series) -> dict:
    n = len(window)
    if n < 3 or len(base) < 10:
        return dict(n=n, significant=False, note="sample too small for any inference")
    se = base.std(ddof=1) / np.sqrt(n)
    z = (window.mean() - base.mean()) / se if se > 0 else 0.0
    return dict(n=n, z=float(z), significant=bool(abs(z) > 2),
                note=("difference vs season baseline exceeds ~2 standard errors; still not evidence of future persistence"
                      if abs(z) > 2 else "within normal variation of the season baseline"))


def team_trends(db: Session, team_id: int) -> dict:
    df = team_games(db, team_id)
    if df.empty:
        return dict(team_id=team_id, games=[], windows={})
    cur = df[df["season"] == df["season"].iloc[-1]]
    out = dict(team_id=team_id, season=cur["season"].iloc[-1], n_season=len(cur), source=sorted(df["source"].unique().tolist()),
               is_demo=bool(df["is_demo"].any()))
    windows = {}
    for w in (5, 10, 20):
        sub = cur.tail(w)
        blk = dict(n=len(sub))
        for col in ("ortg", "drtg", "pace", "pts", "opp_pts", "margin", "total", "h1_total", "efg", "tov", "orb", "ftr"):
            if col in sub and sub[col].notna().any():
                blk[col] = float(sub[col].mean())
        if "ats" in sub:
            a = sub["ats"].dropna()
            blk["ats"] = dict(cover=int((a == "cover").sum()), fail=int((a == "fail").sum()), push=int((a == "push").sum()))
        if "ou" in sub:
            o = sub["ou"].dropna()
            blk["ou"] = dict(over=int((o == "over").sum()), under=int((o == "under").sum()), push=int((o == "push").sum()))
        if "margin" in sub:
            blk["margin_vs_season"] = _note(sub["margin"], cur["margin"])
        windows[str(w)] = blk
    out["windows"] = windows
    splits = {}
    for name, mask in (("home", cur["home"] & ~cur["neutral"]), ("away", ~cur["home"] & ~cur["neutral"]), ("neutral", cur["neutral"])):
        s = cur[mask]
        if len(s):
            splits[name] = dict(n=len(s), margin=float(s["margin"].mean()), total=float(s["total"].mean()),
                                ortg=float(s["ortg"].mean()) if "ortg" in s else None)
    out["splits"] = splits
    roll = cur.copy()
    for col in ("ortg", "drtg", "pace", "total", "margin"):
        if col in roll:
            roll[f"{col}_r5"] = roll[col].rolling(5, min_periods=1).mean()
    out["games"] = roll.replace({np.nan: None}).to_dict("records")
    return out


def player_trends(db: Session, player_id: int) -> dict:
    q = (select(m.PlayerGameStat, m.Game).join(m.Game, m.Game.id == m.PlayerGameStat.game_id)
         .where(m.PlayerGameStat.player_id == player_id).order_by(m.Game.start_time))
    teams = {t.id: t.abbreviation for t in db.scalars(select(m.Team))}
    rows = []
    for s, g in db.execute(q).all():
        home = s.team_id == g.home_team_id
        rows.append(dict(game_id=g.id, date=g.start_time.isoformat(), season=g.season, home=home,
                         opponent=teams[g.away_team_id if home else g.home_team_id], minutes=s.minutes, pts=s.pts, reb=s.reb,
                         ast=s.ast, fg3m=s.fg3m, fg3a=s.fg3a, fga=s.fga, fta=s.fta, stl=s.stl, blk=s.blk, tov=s.tov,
                         usage=s.usage, pra=s.pts + s.reb + s.ast, source=g.source, is_demo=g.is_demo))
    df = pd.DataFrame(rows)
    if df.empty:
        return dict(player_id=player_id, games=[], windows={})
    cur = df[df["season"] == df["season"].iloc[-1]]
    if len(cur) < 5:
        cur = df.tail(20)
    stats = ["minutes", "pts", "reb", "ast", "fg3m", "fg3a", "fga", "stl", "blk", "usage", "pra"]
    windows = {str(w): dict(n=len(cur.tail(w)), **{k: float(cur.tail(w)[k].mean()) for k in stats}) for w in (5, 10, 20)}
    windows["season"] = dict(n=len(cur), **{k: float(cur[k].mean()) for k in stats})
    splits = {k: dict(n=len(v), **{s: float(v[s].mean()) for s in ("minutes", "pts", "reb", "ast")})
              for k, v in (("home", cur[cur["home"]]), ("away", cur[~cur["home"]])) if len(v)}
    by_opp = cur.groupby("opponent").agg(n=("pts", "size"), pts=("pts", "mean"), reb=("reb", "mean"), ast=("ast", "mean")).reset_index()
    g = df.tail(40).copy()
    for s in ("pts", "reb", "ast", "minutes"):
        g[f"{s}_r5"] = g[s].rolling(5, min_periods=1).mean()
        g[f"{s}_r10"] = g[s].rolling(10, min_periods=1).mean()
    pts_note = _note(cur.tail(10)["pts"], cur["pts"])
    # prop outcome history from archived predictions
    props = [dict(date=p.created_at.isoformat(), market=p.market, line=p.line, selection=p.selection, prob=p.predicted_prob,
                  projection=p.predicted_value, actual=p.actual_value, result=p.result)
             for p in db.scalars(select(m.Prediction).where(m.Prediction.player_id == player_id).order_by(m.Prediction.created_at.desc()).limit(60))]
    return dict(player_id=player_id, windows=windows, splits=splits, by_opponent=by_opp.to_dict("records"),
                games=g.replace({np.nan: None}).to_dict("records"), pts_last10_vs_season=pts_note, prop_history=props,
                source=sorted(df["source"].unique().tolist()), is_demo=bool(df["is_demo"].any()))


def league_table(db: Session, league: str) -> list[dict]:
    """Season-to-date efficiency table for every team (current season)."""
    season = db.scalar(select(m.Game.season).where(m.Game.league == league, m.Game.status == "final").order_by(m.Game.start_time.desc()))
    if not season:
        return []
    stats = db.execute(select(m.TeamGameStat, m.Game).join(m.Game).where(m.Game.league == league, m.Game.season == season)).all()
    per_game: dict[int, dict] = {}
    for s, g in stats:
        per_game.setdefault(g.id, {})[s.team_id] = s
    agg: dict[int, dict] = {}
    for gid, d in per_game.items():
        if len(d) != 2:
            continue
        (t1, s1), (t2, s2) = d.items()
        for me, them, tid in ((s1, s2, t1), (s2, s1, t2)):
            a = agg.setdefault(tid, dict(n=0, pts=0, opp=0, poss=0.0, fgm=0, fg3m=0, fga=0, tov=0, w=0))
            a["n"] += 1
            a["pts"] += me.points
            a["opp"] += them.points
            a["poss"] += (me.possessions + them.possessions) / 2
            a["fgm"] += me.fgm
            a["fg3m"] += me.fg3m
            a["fga"] += me.fga
            a["tov"] += me.tov
            a["w"] += int(me.points > them.points)
    teams = {t.id: t for t in db.scalars(select(m.Team).where(m.Team.league == league))}
    confs = {c.id: c.short_name for c in db.scalars(select(m.Conference))}
    rows = []
    for tid, a in agg.items():
        t = teams[tid]
        o, d = 100 * a["pts"] / a["poss"], 100 * a["opp"] / a["poss"]
        rows.append(dict(team_id=tid, abbr=t.abbreviation, name=t.display_name, conference=confs.get(t.conference_id), games=a["n"],
                         wins=a["w"], losses=a["n"] - a["w"], ortg=o, drtg=d, net=o - d, pace=a["poss"] / a["n"],
                         efg=(a["fgm"] + 0.5 * a["fg3m"]) / a["fga"], tov=a["tov"] / a["poss"], season=season))
    return sorted(rows, key=lambda r: -r["net"])
