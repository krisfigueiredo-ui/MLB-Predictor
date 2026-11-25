"""Point-in-time feature engineering for game models.

Leakage guarantees
- Games are processed in strict chronological order. A game's features are computed from
  team state BEFORE the game's result is folded in, so only games completed earlier are used.
- Upcoming games (no result) receive features from the latest state and never update it.
- Pre-game context (injuries, lineup changes) comes from `pregame_context`, which records
  information knowable before tip-off.

Feature families: opponent-adjusted efficiency (ORtg/DRtg), pace, four factors (eFG%, TOV%,
ORB%, FTr) on both ends, recent form (last 5/10), home/away splits, rest, travel, injuries,
lineup changes, strength of schedule, and — for CBB — conference strength, nonconference
performance, neutral sites, roster continuity and sample-size-aware Bayesian shrinkage.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .synthetic import haversine_miles

LEAGUE_AVG = {"NBA": dict(ortg=113.0, pace=99.0, efg=0.54, tov=0.13, orb=0.25, ftr=0.25),
              "CBB": dict(ortg=104.0, pace=68.0, efg=0.50, tov=0.17, orb=0.29, ftr=0.32)}
# prior strength (pseudo-games) for empirical-Bayes shrinkage toward the prior mean
SHRINK_K = {"NBA": 6.0, "CBB": 9.0}
ALPHA = {"NBA": 0.06, "CBB": 0.08}  # EWMA weight


@dataclass
class TeamState:
    league: str
    prior_net: float = 0.0
    n: int = 0
    ortg: float = 0.0
    drtg: float = 0.0
    pace: float = 0.0
    efg: float = 0.0
    tov: float = 0.0
    orb: float = 0.0
    ftr: float = 0.0
    d_efg: float = 0.0
    d_tov: float = 0.0
    d_orb: float = 0.0
    d_ftr: float = 0.0
    opp_net_sum: float = 0.0
    home_net: float = 0.0
    home_n: int = 0
    away_net: float = 0.0
    away_n: int = 0
    nonconf_net: float = 0.0
    nonconf_n: int = 0
    h1_share: float = 0.49
    recent: deque = field(default_factory=lambda: deque(maxlen=10))
    last_date: pd.Timestamp | None = None
    last_loc: tuple[float, float] | None = None

    def init(self):
        a = LEAGUE_AVG[self.league]
        self.ortg = self.drtg = a["ortg"]
        self.pace = a["pace"]
        self.efg = self.d_efg = a["efg"]
        self.tov = self.d_tov = a["tov"]
        self.orb = self.d_orb = a["orb"]
        self.ftr = self.d_ftr = a["ftr"]
        return self

    @property
    def raw_net(self) -> float:
        return self.ortg - self.drtg

    def shrunk_net(self) -> float:
        k = SHRINK_K[self.league]
        w = self.n / (self.n + k)
        return w * self.raw_net + (1 - w) * self.prior_net

    @property
    def sos(self) -> float:
        return self.opp_net_sum / self.n if self.n else 0.0


def four_factors(r: dict, opp: dict) -> dict:
    fga = max(1, r["fga"])
    poss = max(1.0, r["possessions"])
    return dict(
        ortg=100 * r["points"] / poss,
        efg=(r["fgm"] + 0.5 * r["fg3m"]) / fga,
        tov=r["tov"] / poss,
        orb=r["oreb"] / max(1, r["oreb"] + opp["dreb"]),
        ftr=r["fta"] / fga,
        pace=poss,
    )


FEATURES_COMMON = [
    "h_adj_ortg", "h_adj_drtg", "a_adj_ortg", "a_adj_drtg", "h_net_shrunk", "a_net_shrunk", "net_diff",
    "h_pace", "a_pace", "exp_pace", "h_efg", "a_efg", "h_d_efg", "a_d_efg", "h_tov", "a_tov", "h_d_tov", "a_d_tov",
    "h_orb", "a_orb", "h_ftr", "a_ftr", "h_last5", "a_last5", "h_last10", "a_last10",
    "h_home_net", "a_away_net", "h_rest", "a_rest", "h_b2b", "a_b2b", "h_travel", "a_travel",
    "h_injury", "a_injury", "h_lineup_change", "a_lineup_change", "h_sos", "a_sos", "h_games", "a_games",
    "neutral", "naive_margin", "naive_total", "naive_h1", "h1_share",
]
FEATURES_CBB = ["h_conf_strength", "a_conf_strength", "h_nonconf_net", "a_nonconf_net",
                "h_continuity", "a_continuity", "same_conf"]


def feature_names(league: str) -> list[str]:
    return FEATURES_COMMON + (FEATURES_CBB if league == "CBB" else [])


def build_features(games: pd.DataFrame, teams: pd.DataFrame, league: str) -> pd.DataFrame:
    """games: one row per game with columns
    id, start_time, season, home_team_id, away_team_id, neutral_site, status, pregame_context,
    home_* / away_* box columns (points, fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, tov,
    possessions, h1_points) — NaN for unplayed games.
    teams: id, lat, lon, conference, conf_strength.
    Returns one row per game: id + features + targets (NaN for unplayed).
    """
    avg = LEAGUE_AVG[league]
    tinfo = teams.set_index("id").to_dict("index")
    states: dict[int, TeamState] = {}
    season_of: dict[int, str] = {}
    out = []
    games = games.sort_values(["start_time", "id"]).reset_index(drop=True)
    alpha = ALPHA[league]

    def state(tid: int, season: str) -> TeamState:
        st = states.get(tid)
        if st is None:
            st = TeamState(league).init()
            cs = tinfo.get(tid, {}).get("conf_strength") or 0.0
            st.prior_net = (cs - 7.0) * 0.8 if league == "CBB" else 0.0
            states[tid] = st
            season_of[tid] = season
        elif season_of[tid] != season:
            # season rollover: regress toward prior, keep partial memory
            keep = 0.6 if league == "NBA" else 0.4
            new = TeamState(league).init()
            new.prior_net = keep * st.shrunk_net() + (1 - keep) * st.prior_net
            new.ortg = avg["ortg"] + new.prior_net / 2
            new.drtg = avg["ortg"] - new.prior_net / 2
            new.pace = keep * st.pace + (1 - keep) * avg["pace"]
            states[tid] = st = new
            season_of[tid] = season
        return st

    for g in games.itertuples(index=False):
        h = state(g.home_team_id, g.season)
        a = state(g.away_team_id, g.season)
        ctx = g.pregame_context if isinstance(g.pregame_context, dict) else {}
        hc, ac = ctx.get("home", {}) or {}, ctx.get("away", {}) or {}
        hi, ai = tinfo.get(g.home_team_id, {}), tinfo.get(g.away_team_id, {})
        ts = pd.Timestamp(g.start_time)

        def rest(st: TeamState, c: dict) -> float:
            if "rest_days" in c:
                return float(c["rest_days"])
            return float(min(7, (ts - st.last_date).days)) if st.last_date is not None else 3.0

        def travel(st: TeamState, c: dict, dest: tuple) -> float:
            if "travel_miles" in c:
                return float(c["travel_miles"])
            if st.last_loc is None or dest[0] is None:
                return 0.0
            return haversine_miles(st.last_loc[0], st.last_loc[1], dest[0], dest[1])

        dest = (hi.get("lat"), hi.get("lon"))
        h_rest, a_rest = rest(h, hc), rest(a, ac)

        def adj(st: TeamState):
            # opponent adjustment: credit offence for facing good defences (positive SOS)
            k = SHRINK_K[league]
            w = st.n / (st.n + k)
            prior_o = avg["ortg"] + st.prior_net / 2
            prior_d = avg["ortg"] - st.prior_net / 2
            o = w * (st.ortg + st.sos / 2) + (1 - w) * prior_o
            d = w * (st.drtg - st.sos / 2) + (1 - w) * prior_d
            return o, d

        ho, hd = adj(h)
        ao, ad = adj(a)
        exp_pace = (h.pace + a.pace) / 2
        hca = 0.0 if g.neutral_site else (2.4 if league == "NBA" else 3.3)
        h_ppp = (ho + ad - avg["ortg"]) / 100
        a_ppp = (ao + hd - avg["ortg"]) / 100
        naive_margin = exp_pace * (h_ppp - a_ppp) + hca
        naive_total = exp_pace * (h_ppp + a_ppp)
        f = dict(
            id=g.id,
            h_adj_ortg=ho, h_adj_drtg=hd, a_adj_ortg=ao, a_adj_drtg=ad,
            h_net_shrunk=h.shrunk_net(), a_net_shrunk=a.shrunk_net(), net_diff=h.shrunk_net() - a.shrunk_net(),
            h_pace=h.pace, a_pace=a.pace, exp_pace=exp_pace,
            h_efg=h.efg, a_efg=a.efg, h_d_efg=h.d_efg, a_d_efg=a.d_efg,
            h_tov=h.tov, a_tov=a.tov, h_d_tov=h.d_tov, a_d_tov=a.d_tov,
            h_orb=h.orb, a_orb=a.orb, h_ftr=h.ftr, a_ftr=a.ftr,
            h_last5=float(np.mean(list(h.recent)[-5:])) if h.recent else 0.0,
            a_last5=float(np.mean(list(a.recent)[-5:])) if a.recent else 0.0,
            h_last10=float(np.mean(h.recent)) if h.recent else 0.0,
            a_last10=float(np.mean(a.recent)) if a.recent else 0.0,
            h_home_net=h.home_net if h.home_n else 0.0, a_away_net=a.away_net if a.away_n else 0.0,
            h_rest=h_rest, a_rest=a_rest, h_b2b=float(h_rest <= 1), a_b2b=float(a_rest <= 1),
            h_travel=travel(h, hc, dest), a_travel=travel(a, ac, dest),
            h_injury=float(hc.get("injury_impact", 0.0)), a_injury=float(ac.get("injury_impact", 0.0)),
            h_lineup_change=float(bool(hc.get("lineup_change", False))),
            a_lineup_change=float(bool(ac.get("lineup_change", False))),
            h_sos=h.sos, a_sos=a.sos, h_games=float(h.n), a_games=float(a.n),
            neutral=float(bool(g.neutral_site)), naive_margin=naive_margin, naive_total=naive_total,
            h1_share=(h.h1_share + a.h1_share) / 2,
            naive_h1=naive_total * (h.h1_share + a.h1_share) / 2,
        )
        if league == "CBB":
            f.update(
                h_conf_strength=float(hi.get("conf_strength") or 0.0),
                a_conf_strength=float(ai.get("conf_strength") or 0.0),
                h_nonconf_net=h.nonconf_net if h.nonconf_n else 0.0,
                a_nonconf_net=a.nonconf_net if a.nonconf_n else 0.0,
                h_continuity=float(hc.get("roster_continuity", 0.5)),
                a_continuity=float(ac.get("roster_continuity", 0.5)),
                same_conf=float(hi.get("conference") is not None and hi.get("conference") == ai.get("conference")),
            )
        has_score = not (isinstance(g.home_points, float) and math.isnan(g.home_points))
        score_only = g.status == "final_no_box" and has_score  # final score known, box score not
        played = (g.status == "final" and has_score) or score_only
        if played:
            f.update(
                y_margin=g.home_points - g.away_points, y_total=g.home_points + g.away_points,
                y_home=g.home_points, y_away=g.away_points,
                y_h1_total=(g.home_h1_points + g.away_h1_points) if not pd.isna(g.home_h1_points) else np.nan,
                y_home_win=float(g.home_points > g.away_points),
            )
        out.append(f)
        if not played:
            continue
        # ---- fold the result into team state (after features were recorded) ----
        hr = {k: getattr(g, f"home_{k}") for k in ("points", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "tov", "possessions", "h1_points")}
        ar = {k: getattr(g, f"away_{k}") for k in hr}
        if score_only:
            # No box score: efficiency from points over the possessions both teams were expected to
            # play; pace and the four factors are left unchanged (no information about them).
            poss_est = exp_pace
            hf = dict(ortg=100 * hr["points"] / poss_est)
            af = dict(ortg=100 * ar["points"] / poss_est)
        else:
            hf, af = four_factors(hr, ar), four_factors(ar, hr)
        for st, mine, theirs, is_home, opp_st in ((h, hf, af, True, a), (a, af, hf, False, h)):
            pre_opp_net = opp_st.shrunk_net()
            st.ortg += alpha * (mine["ortg"] - st.ortg) * (1 if st.n > 3 else 3)
            st.drtg += alpha * (theirs["ortg"] - st.drtg) * (1 if st.n > 3 else 3)
            if not score_only:
                st.pace += alpha * (mine["pace"] - st.pace) * (1 if st.n > 3 else 2)
                for key in ("efg", "tov", "orb", "ftr"):
                    setattr(st, key, getattr(st, key) + alpha * (mine[key] - getattr(st, key)))
                    dk = f"d_{key}"
                    setattr(st, dk, getattr(st, dk) + alpha * (theirs[key] - getattr(st, dk)))
            net = mine["ortg"] - theirs["ortg"]
            st.recent.append(net)
            st.opp_net_sum += pre_opp_net
            st.n += 1
            if not g.neutral_site:
                if is_home:
                    st.home_n += 1
                    st.home_net += (net - st.home_net) / st.home_n
                else:
                    st.away_n += 1
                    st.away_net += (net - st.away_net) / st.away_n
            if league == "CBB":
                myconf = tinfo.get(st is h and g.home_team_id or g.away_team_id, {}).get("conference")
                oppconf = tinfo.get(st is h and g.away_team_id or g.home_team_id, {}).get("conference")
                if myconf != oppconf:
                    st.nonconf_n += 1
                    st.nonconf_net += (net - st.nonconf_net) / st.nonconf_n
            pts = hr["points"] if is_home else ar["points"]
            h1 = hr["h1_points"] if is_home else ar["h1_points"]
            if pts and h1 and not pd.isna(h1):
                st.h1_share += 0.05 * (h1 / pts - st.h1_share)
            st.last_date = ts
            st.last_loc = (hi.get("lat"), hi.get("lon")) if hi.get("lat") is not None else st.last_loc
    return pd.DataFrame(out)
