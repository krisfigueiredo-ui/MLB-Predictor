"""Player prop model: minutes -> opportunity/rates -> correlated count distributions.

1. Minutes: LightGBM regression on point-in-time features (recent/season minutes, rest,
   blowout risk from the projected spread, teammate injuries, sample size).
2. Opportunity: per-minute production rates (EWMA, shrunk toward the player's long-run rate),
   adjusted for projected pace and opponent defensive efficiency.
3. Outcomes: Monte Carlo with minutes ~ truncated Normal, a shared game-flow Gamma multiplier
   (induces positive correlation between points/assists/threes), and Negative Binomial counts
   with dispersion fitted on training residuals. Combos (PRA) are summed per simulation,
   so their distribution respects the correlation.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import metrics as M

STATS = ["pts", "reb", "ast", "fg3m", "stl", "blk"]
FLOW_STATS = {"pts", "ast", "fg3m"}
MIN_FEATURES = ["min_ewm", "min_last5", "min_season", "games", "rest", "blowout_risk", "team_injury", "is_home"]
LEAGUE_PACE = {"NBA": 99.0, "CBB": 68.0}
LEAGUE_ORTG = {"NBA": 113.0, "CBB": 104.0}
# Weight on the model when a sportsbook line exists: mean = w*model + (1-w)*line. This is a
# documented prior (no historical prop-line archive to fit it on yet); refit it once enough
# settled prop predictions exist (details.model_only_mean is archived for that purpose).
PROP_MODEL_WEIGHT = 0.5


def player_frame(logs: pd.DataFrame, game_feats: pd.DataFrame, league: str) -> pd.DataFrame:
    """logs: player_game_stats joined with games (start_time, home_team_id, season).
    game_feats: build_features output (id, exp_pace, naive_margin, h_adj_drtg, a_adj_drtg, h_injury, a_injury).
    Returns point-in-time features per player-game (computed from strictly earlier games)."""
    gf = game_feats.set_index("id")
    rows = []
    for pid, grp in logs.sort_values("start_time").groupby("player_id"):
        ewm_min, ewm_rate = None, {}
        tot_min, tot = 0.0, {s: 0.0 for s in STATS}
        mins_hist: list[float] = []
        last_t, season = None, None
        n = 0
        for r in grp.itertuples(index=False):
            if r.season != season:
                season, n, tot_min, tot = r.season, 0, 0.0, {s: 0.0 for s in STATS}
                mins_hist = mins_hist[-5:]
            g = gf.loc[r.game_id] if r.game_id in gf.index else None
            is_home = r.team_id == r.home_team_id
            feat = dict(player_id=pid, game_id=r.game_id, start_time=r.start_time, team_id=r.team_id, season=r.season,
                        min_ewm=ewm_min if ewm_min is not None else np.nan,
                        min_last5=float(np.mean(mins_hist[-5:])) if mins_hist else np.nan,
                        min_season=tot_min / n if n else np.nan, games=float(n),
                        rest=float(min(7, (r.start_time - last_t).days)) if last_t is not None else 3.0,
                        is_home=float(is_home))
            if g is not None:
                feat["exp_pace"] = float(g["exp_pace"])
                feat["blowout_risk"] = abs(float(g["naive_margin"]))
                feat["opp_drtg"] = float(g["a_adj_drtg"] if is_home else g["h_adj_drtg"])
                feat["team_injury"] = float(g["h_injury"] if is_home else g["a_injury"])
            for s in STATS:
                feat[f"rate_{s}"] = ewm_rate.get(s, np.nan)
                feat[f"rate_season_{s}"] = tot[s] / tot_min if tot_min else np.nan
                feat[f"y_{s}"] = float(getattr(r, s))
            feat["y_min"] = float(r.minutes)
            rows.append(feat)
            # update after recording (point-in-time)
            mn = float(r.minutes)
            ewm_min = mn if ewm_min is None else 0.75 * ewm_min + 0.25 * mn
            mins_hist.append(mn)
            if mn > 0:
                for s in STATS:
                    rt = getattr(r, s) / mn
                    ewm_rate[s] = rt if s not in ewm_rate else 0.85 * ewm_rate[s] + 0.15 * rt
            tot_min += mn
            for s in STATS:
                tot[s] += getattr(r, s)
            n += 1
            last_t = r.start_time
    df = pd.DataFrame(rows)
    return df


def _rates(row, league: str) -> dict:
    out = {}
    w = row["games"] / (row["games"] + 5)
    pace_f = (row.get("exp_pace") or LEAGUE_PACE[league]) / LEAGUE_PACE[league]
    opp_f = (row.get("opp_drtg") or LEAGUE_ORTG[league]) / LEAGUE_ORTG[league]
    for s in STATS:
        e, lt = row.get(f"rate_{s}"), row.get(f"rate_season_{s}")
        e = lt if pd.isna(e) else e
        lt = e if pd.isna(lt) else lt
        base = w * e + (1 - w) * lt if not pd.isna(e) else np.nan
        out[s] = base * pace_f * (opp_f if s in ("pts", "fg3m", "ast") else 1.0)
    return out


@dataclass
class PropsBundle:
    league: str
    version: str
    minutes_model: object
    sigma_minutes: float
    dispersion: dict
    flow_k: float
    metrics: dict
    trained_at: str
    data_source: str
    n_train: int

    def project(self, row: dict, n: int, seed: int, anchors: dict | None = None, w_model: float = PROP_MODEL_WEIGHT) -> dict:
        X = pd.DataFrame([{k: row.get(k, np.nan) for k in MIN_FEATURES}])
        mu_min = float(np.clip(self.minutes_model.predict(X)[0], 0, 46))
        rates = _rates(row, self.league)
        rng = np.random.default_rng(seed)
        mins = np.clip(rng.normal(mu_min, self.sigma_minutes, n), 0, 48)
        flow = rng.gamma(self.flow_k, 1 / self.flow_k, n)
        sims, model_means = {}, {}
        for s in STATS:
            rt = rates[s] if not pd.isna(rates[s]) else 0.0
            model_means[s] = rt * mu_min
            scale = 1.0
            if anchors and s in anchors and model_means[s] > 0.05:
                scale = (w_model * model_means[s] + (1 - w_model) * anchors[s]) / model_means[s]
            mu = np.maximum(1e-3, rt * scale * mins * (flow if s in FLOW_STATS else 1.0))
            r = self.dispersion[s]
            sims[s] = rng.negative_binomial(r, r / (r + mu))
        sims["pra"] = sims["pts"] + sims["reb"] + sims["ast"]
        sims["min"] = mins
        model_means["pra"] = model_means["pts"] + model_means["reb"] + model_means["ast"]
        return dict(mu_minutes=mu_min, sims=sims, rates=rates, model_means=model_means)


def summarize(sims: np.ndarray, line: float | None) -> dict:
    out = dict(mean=float(np.mean(sims)), median=float(np.median(sims)), sd=float(np.std(sims)),
               p10=float(np.percentile(sims, 10)), p90=float(np.percentile(sims, 90)))
    vals, counts = np.unique(np.rint(sims).astype(int), return_counts=True)
    out["pmf"] = [dict(x=int(v), p=float(c / len(sims))) for v, c in zip(vals, counts) if c / len(sims) >= 0.002]
    if line is not None:
        out.update(line=line, p_over=float((sims > line).mean()), p_under=float((sims < line).mean()),
                   p_push=float((sims == line).mean()))
    return out


def train_props_model(pf: pd.DataFrame, league: str, data_source: str, seed: int = 11) -> PropsBundle:
    import lightgbm as lgb

    df = pf.dropna(subset=["min_ewm"]).sort_values("start_time").reset_index(drop=True)
    if len(df) < 500:
        raise ValueError(f"need >=500 player-games for a props model, have {len(df)}")
    cut = int(len(df) * 0.8)
    tr, te = df.iloc[:cut], df.iloc[cut:]
    mm = lgb.LGBMRegressor(n_estimators=250, learning_rate=0.03, num_leaves=15, min_child_samples=40, verbose=-1,
                           random_state=seed).fit(tr[MIN_FEATURES], tr["y_min"])
    sig_min = float(np.std(tr["y_min"] - mm.predict(tr[MIN_FEATURES])))
    # dispersion per stat from training residuals given predicted minutes (method of moments)
    pm_tr = mm.predict(tr[MIN_FEATURES])
    disp = {}
    for s in STATS:
        rt = np.array([_rates(r, league)[s] for r in tr.to_dict("records")])
        mu = np.nan_to_num(rt) * pm_tr
        y = tr[f"y_{s}"].values
        ok = mu > 0.05
        var_excess = np.mean((y[ok] - mu[ok]) ** 2 - mu[ok])
        r = float(np.clip(np.mean(mu[ok] ** 2) / max(var_excess, 1e-3), 1.5, 60.0))
        disp[s] = r
    bundle = PropsBundle(league, f"{league.lower()}-props-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}", mm,
                         sig_min, disp, 12.0, {}, datetime.now(timezone.utc).isoformat(), data_source, len(tr))
    # ---- held-out evaluation: MAE of mean projection & calibration of P(over floor(mean)+0.5) ----
    ev = {"minutes": M.regression_metrics(mm.predict(te[MIN_FEATURES]), te["y_min"].values)}
    sample = te.sample(min(400, len(te)), random_state=seed)
    for s in STATS + ["pra"]:
        preds, probs, ys = [], [], []
        for i, r in enumerate(sample.to_dict("records")):
            pr = bundle.project(r, 1500, seed + i)
            x = pr["sims"][s]
            y = r["y_pts"] + r["y_reb"] + r["y_ast"] if s == "pra" else r[f"y_{s}"]
            line = float(np.floor(np.mean(x)) + 0.5)
            preds.append(float(np.mean(x)))
            probs.append(float((x > line).mean()))
            ys.append(float(y > line))
            r[f"_y_{s}"] = y
        yv = np.array([r for r in (sample["y_pts"] + sample["y_reb"] + sample["y_ast"] if s == "pra" else sample[f"y_{s}"])])
        ev[s] = dict(**M.regression_metrics(np.array(preds), yv), over=M.classification_metrics(np.array(probs), np.array(ys)))
    bundle.metrics = dict(test=ev, n_test=len(te), n_eval_sample=len(sample), sigma_minutes=sig_min, dispersion=disp,
                          split=dict(train_end=str(tr.start_time.max()), test=[str(te.start_time.min()), str(te.start_time.max())]))
    return bundle
