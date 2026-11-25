"""Synthetic basketball league simulator (demo mode only).

Generates internally consistent schedules, possession-level box scores, injuries,
player game logs and sportsbook-style markets from latent team strengths, so that every
pipeline (features → training → simulation → archive → settlement → diagnostics) can run
end-to-end without paid data. Everything produced here is flagged `is_demo=True`, and
models trained on it are tagged `data_source="synthetic_demo"`. Metrics reported for these
models describe performance on synthetic data, NOT on real basketball.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

import numpy as np

LEAGUE_PARAMS = {
    "NBA": dict(pace=99.0, p2=0.540, p3=0.364, par3=0.42, ftr=0.25, ft=0.785, tov=0.130, orb=0.25,
                rating_sd=4.2, pace_sd=2.2, hca=2.4, pace_noise=2.6, b2b=-1.6, minutes=48,
                season_start=(10, 21), season_end=(4, 12), games_per_team=82),
    "CBB": dict(pace=68.0, p2=0.512, p3=0.341, par3=0.39, ftr=0.32, ft=0.715, tov=0.170, orb=0.29,
                rating_sd=6.0, pace_sd=3.0, hca=3.3, pace_noise=2.4, b2b=-0.8, minutes=40,
                season_start=(11, 3), season_end=(3, 15), games_per_team=31),
}


def haversine_miles(lat1, lon1, lat2, lon2) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


@dataclass
class SimTeam:
    team_id: int
    conf: str | None
    lat: float
    lon: float
    off: float  # pts/100 above league average
    deff: float  # pts/100 prevented vs league average (positive = good defence)
    pace: float
    conf_strength: float = 0.0
    continuity: float = 0.7
    last_game: date | None = None
    last_loc: tuple[float, float] | None = None


@dataclass
class SimPlayer:
    player_id: int
    team_id: int
    profile: dict
    talent: float  # multiplicative
    injured_until: date | None = None


@dataclass
class SimGame:
    league: str
    season: str
    start: datetime
    home: int
    away: int
    neutral: bool
    result: dict = field(default_factory=dict)
    context: dict = field(default_factory=dict)
    true_margin: float = 0.0
    true_total: float = 0.0
    player_lines: list = field(default_factory=list)


def _season_label(start_year: int) -> str:
    return f"{start_year}-{str(start_year + 1)[-2:]}"


class LeagueSimulator:
    def __init__(self, league: str, teams: list[dict], seed: int, players: list[dict] | None = None):
        self.league = league
        self.p = LEAGUE_PARAMS[league]
        self.rng = np.random.default_rng(seed)
        self.teams: dict[int, SimTeam] = {}
        for t in teams:
            cs = t.get("conf_strength", 0.0) or 0.0
            base = self.rng.normal(0, self.p["rating_sd"])
            split = self.rng.normal(0, self.p["rating_sd"] * 0.45)
            league_adj = (cs - 7.0) * 0.8 if league == "CBB" else 0.0
            self.teams[t["id"]] = SimTeam(
                team_id=t["id"], conf=t.get("conf"), lat=t["lat"], lon=t["lon"],
                off=base / 2 + split + league_adj / 2, deff=base / 2 - split + league_adj / 2,
                pace=self.p["pace"] + self.rng.normal(0, self.p["pace_sd"]), conf_strength=cs,
            )
        self.players = [
            SimPlayer(pl["id"], pl["team_id"], pl["profile"], float(self.rng.normal(1.0, 0.05)))
            for pl in (players or [])
        ]

    # ---------------- season mechanics ----------------
    def _new_season(self, first: bool):
        sd = self.p["rating_sd"]
        for t in self.teams.values():
            keep = 0.65 if self.league == "NBA" else 0.45  # CBB rosters turn over more
            if not first:
                t.off = keep * t.off + self.rng.normal(0, sd * 0.55)
                t.deff = keep * t.deff + self.rng.normal(0, sd * 0.55)
                t.pace = 0.6 * t.pace + 0.4 * self.p["pace"] + self.rng.normal(0, self.p["pace_sd"] * 0.6)
            t.continuity = float(np.clip(self.rng.normal(0.72 if self.league == "NBA" else 0.5, 0.15), 0.1, 0.98))
            t.last_game, t.last_loc = None, None

    def _drift(self):
        s = 0.12 if self.league == "NBA" else 0.18
        for t in self.teams.values():
            t.off += self.rng.normal(0, s)
            t.deff += self.rng.normal(0, s)

    def _schedule_day(self, day: date, phase: str) -> list[tuple[int, int, bool]]:
        ids = list(self.teams)
        self.rng.shuffle(ids)
        games = []
        if self.league == "NBA":
            n = int(self.rng.integers(4, 12))
            avail = [i for i in ids if self.teams[i].last_game is None or (day - self.teams[i].last_game).days >= 1]
            for k in range(0, min(len(avail) - 1, n * 2), 2):
                games.append((avail[k], avail[k + 1], False))
        else:
            avail = [i for i in ids if self.teams[i].last_game is None or (day - self.teams[i].last_game).days >= 2]
            share = 0.42
            if phase == "nonconf":
                for k in range(0, int(len(avail) * share) - 1, 2):
                    neutral = bool(self.rng.random() < 0.12)
                    games.append((avail[k], avail[k + 1], neutral))
            else:
                by_conf: dict[str, list[int]] = {}
                for i in avail:
                    by_conf.setdefault(self.teams[i].conf or "", []).append(i)
                for members in by_conf.values():
                    m = members[: int(len(members) * 0.5) // 2 * 2]
                    for k in range(0, len(m) - 1, 2):
                        games.append((m[k], m[k + 1], False))
        return games

    # ---------------- a single game ----------------
    def _team_box(self, att: SimTeam, dfn: SimTeam, poss: float, edge: float) -> dict:
        p, r = self.p, self.rng
        q = edge / 100.0  # pts/100 advantage -> efficiency shift
        p2 = np.clip(p["p2"] + q * 0.55 + r.normal(0, 0.012), 0.3, 0.75)
        p3 = np.clip(p["p3"] + q * 0.45 + r.normal(0, 0.015), 0.15, 0.6)
        tov = np.clip(p["tov"] - q * 0.12 + r.normal(0, 0.012), 0.05, 0.3)
        orb = np.clip(p["orb"] + q * 0.1 + r.normal(0, 0.03), 0.08, 0.5)
        ftr = np.clip(p["ftr"] + r.normal(0, 0.04), 0.05, 0.7)
        par3 = np.clip(p["par3"] + r.normal(0, 0.03), 0.15, 0.65)
        TOV = int(round(poss * tov))
        fga = poss - TOV
        for _ in range(3):
            fta = fga * ftr
            miss = fga * (1 - (p2 * (1 - par3) + p3 * par3))
            oreb = miss * orb
            fga = poss - TOV - 0.44 * fta + oreb
        FGA = max(20, int(round(fga)))
        FG3A = int(round(FGA * par3))
        FTA = int(round(FGA * ftr))
        FG3M = int(r.binomial(FG3A, p3))
        FG2M = int(r.binomial(FGA - FG3A, p2))
        FTM = int(r.binomial(FTA, p["ft"]))
        OREB = int(round(oreb))
        DREB = int(round((FGA - FG2M - FG3M) * (1 - p["orb"]) * 0.0 + r.normal(33 if self.league == "NBA" else 24, 3)))
        pts = 2 * FG2M + 3 * FG3M + FTM
        return dict(points=pts, fgm=FG2M + FG3M, fga=FGA, fg3m=FG3M, fg3a=FG3A, ftm=FTM, fta=FTA,
                    oreb=OREB, dreb=max(10, DREB), tov=TOV, ast=int(round((FG2M + FG3M) * r.uniform(0.5, 0.68))))

    def play(self, home_id: int, away_id: int, start: datetime, neutral: bool, season: str) -> SimGame:
        p, r = self.p, self.rng
        h, a = self.teams[home_id], self.teams[away_id]
        day = start.date()
        ctx: dict = {"known_at": (start - timedelta(hours=2)).isoformat()}
        eff: dict[int, float] = {}
        for side, t in (("home", h), ("away", a)):
            rest = (day - t.last_game).days if t.last_game else 3
            origin = t.last_loc or (t.lat, t.lon)
            dest = (a.lat, a.lon) if (neutral and side == "home") else (h.lat, h.lon)
            travel = haversine_miles(origin[0], origin[1], dest[0], dest[1])
            inj = float(r.choice([0, 0, 0, 0, 0, 1.0, 2.0, 3.5]) * (1 if self.league == "NBA" else 0.8))
            lineup_change = bool(inj > 0 or r.random() < 0.08)
            ctx[side] = dict(rest_days=int(min(rest, 7)), travel_miles=round(travel, 1), injury_impact=inj,
                             lineup_change=lineup_change, roster_continuity=round(t.continuity, 3))
            e = (p["b2b"] if rest <= 1 else 0.0) - travel / 1000 * 0.45 - inj
            eff[t.team_id] = e
        hca = 0.0 if neutral else p["hca"]
        poss = (h.pace + a.pace) / 2 + r.normal(0, p["pace_noise"])
        h_edge = h.off - a.deff + hca / 2 + eff[h.team_id]
        a_edge = a.off - h.deff - hca / 2 + eff[a.team_id]
        hb = self._team_box(h, a, poss, h_edge)
        ab = self._team_box(a, h, poss, a_edge)
        # overtime
        ot = 0
        while hb["points"] == ab["points"]:
            ot += 1
            hb["points"] += int(r.poisson(10 if self.league == "NBA" else 8))
            ab["points"] += int(r.poisson(10 if self.league == "NBA" else 8))
        for b in (hb, ab):
            b["h1_points"] = int(round(b["points"] * np.clip(r.normal(0.49 if ot == 0 else 0.45, 0.035), 0.35, 0.62)))
            b["possessions"] = round(poss, 1)
        g = SimGame(self.league, season, start, home_id, away_id, neutral, context=ctx)
        g.result = dict(home=hb, away=ab, ot=ot)
        base = self._baseline_ppp()
        g.true_margin = poss * ((h_edge - a_edge) / 100)
        g.true_total = ((h.pace + a.pace) / 2) * (2 * base + (h_edge + a_edge) / 100)
        for t, was_home in ((h, True), (a, False)):
            t.last_game = day
            t.last_loc = (h.lat, h.lon) if not neutral else ((h.lat + a.lat) / 2, (h.lon + a.lon) / 2)
        g.player_lines = self._player_lines(g, poss)
        return g

    def _baseline_ppp(self) -> float:
        # league points per possession implied by the shooting parameters (empirically checked in tests)
        return 1.13 if self.league == "NBA" else 1.04

    def _player_lines(self, g: SimGame, poss: float) -> list[dict]:
        r = self.rng
        out = []
        margin = g.result["home"]["points"] - g.result["away"]["points"]
        for pl in self.players:
            if pl.team_id not in (g.home, g.away):
                continue
            if pl.injured_until and g.start.date() <= pl.injured_until:
                continue
            if r.random() < 0.035:  # new injury
                pl.injured_until = g.start.date() + timedelta(days=int(r.integers(3, 21)))
                continue
            prof = pl.profile
            blowout = max(0.0, abs(margin) - 15) * 0.25
            mins = float(np.clip(r.normal(prof["min"] - blowout, 3.2), 8, 46))
            pace_f = poss / self.p["pace"]
            f = mins / 36 * pace_f * pl.talent
            flow = r.gamma(30, 1 / 30)  # shared game-flow multiplier => stat correlation
            line = dict(player_id=pl.player_id, team_id=pl.team_id, minutes=round(mins, 1), started=True)
            for k in ("pts", "reb", "ast", "fg3m", "stl", "blk", "fga", "fta", "tov"):
                mu = max(0.05, prof[k] * f * (flow if k in ("pts", "ast", "fga", "fg3m") else 1.0))
                disp = 30.0 if k in ("pts", "fga") else 12.0
                line[k] = int(r.negative_binomial(disp, disp / (disp + mu)))
            line["fg3a"] = max(line["fg3m"], int(round(line["fg3m"] / 0.36 + r.normal(0, 1))))
            team_fga = (g.result["home"] if pl.team_id == g.home else g.result["away"])["fga"]
            line["usage"] = round(min(0.45, (line["fga"] + 0.44 * line["fta"] + line["tov"]) / max(1, team_fga * mins / 48 + 1e-9) * 0.2), 3)
            out.append(line)
        return out

    # ---------------- markets ----------------
    def market(self, g: SimGame) -> dict:
        """Sharp-ish closing market: true expectation plus small noise."""
        r = self.rng
        spread_home = -round((g.true_margin + r.normal(0, 1.2)) * 2) / 2
        total = round((g.true_total + r.normal(0, 2.0)) * 2) / 2
        return dict(spread_home=spread_home, total=total, h1_total=round(total * 0.49 * 2) / 2)

    # ---------------- seasons ----------------
    def season(self, start_year: int, first: bool, until: date | None = None):
        self._new_season(first)
        p = self.p
        label = _season_label(start_year)
        d = date(start_year, *p["season_start"])
        end = date(start_year + 1, *p["season_end"])
        conf_start = date(start_year, 12, 30)
        played: dict[int, int] = {i: 0 for i in self.teams}
        while d <= end:
            phase = "nonconf" if (self.league == "NBA" or d < conf_start) else "conf"
            for hid, aid, neutral in self._schedule_day(d, phase):
                if played[hid] >= p["games_per_team"] or played[aid] >= p["games_per_team"]:
                    continue
                hour = int(self.rng.choice([23, 0, 1, 2, 3])) if self.league == "NBA" else int(self.rng.choice([16, 18, 23, 0, 1, 2]))
                start = datetime(d.year, d.month, d.day, tzinfo=timezone.utc) + timedelta(hours=hour + (24 if hour < 12 else 0), minutes=int(self.rng.choice([0, 30])))
                g = self.play(hid, aid, start, neutral, label)
                played[hid] += 1
                played[aid] += 1
                yield g
            self._drift()
            d += timedelta(days=1)
