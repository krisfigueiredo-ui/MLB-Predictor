"""League-specific game models.

Primary: LightGBM + CatBoost regressors (averaged) for margin, total and first-half total.
Benchmark: XGBoost (same targets), reported but never served.
Probabilities: Monte Carlo over a bivariate normal on (margin, total) whose covariance is
estimated from out-of-sample residuals, then win probability is isotonic-calibrated on a
held-out chronological calibration fold.
Validation: strict chronological split + rolling walk-forward folds.
"""
from __future__ import annotations

import json
import logging
import pickle
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm
from sklearn.isotonic import IsotonicRegression

from . import metrics as M
from .features import feature_names

log = logging.getLogger(__name__)
ARTIFACT_DIR = Path(__file__).resolve().parents[2] / "artifacts"

LGB_PARAMS = dict(n_estimators=250, learning_rate=0.02, num_leaves=7, min_child_samples=60,
                  subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=2.0, verbose=-1)
CAT_PARAMS = dict(iterations=300, learning_rate=0.03, depth=4, l2_leaf_reg=10, verbose=False, allow_writing_files=False)
XGB_PARAMS = dict(n_estimators=400, learning_rate=0.04, max_depth=4, subsample=0.8, colsample_bytree=0.8, reg_lambda=2.0)


def _lgb(params=None):
    import lightgbm as lgb

    return lgb.LGBMRegressor(**{**LGB_PARAMS, **(params or {})})


def _cat(seed):
    from catboost import CatBoostRegressor

    return CatBoostRegressor(**CAT_PARAMS, random_seed=seed)


def _xgb(seed):
    import xgboost as xgb

    return xgb.XGBRegressor(**XGB_PARAMS, random_state=seed)


@dataclass
class GameModelBundle:
    league: str
    version: str
    features: list[str]
    models: dict  # target -> {"lgb": m, "cat": m}
    sigma_margin: float
    sigma_total: float
    rho: float
    sigma_h1: float
    calibrator: IsotonicRegression | None
    metrics: dict
    trained_at: str
    data_source: str
    train_start: str
    train_end: str
    n_train: int
    blend: dict | None = None  # market-informed posterior weights (see train_game_model)

    # ---------- inference ----------
    def point(self, X: pd.DataFrame) -> dict[str, np.ndarray]:
        return {tgt: _pred_pair(ms, X[self.features], tgt) for tgt, ms in self.models.items()}

    def calibrate(self, p_raw: np.ndarray) -> np.ndarray:
        if self.calibrator is None:
            return p_raw
        return np.clip(self.calibrator.predict(np.asarray(p_raw)), 0.01, 0.99)

    def posterior(self, mu_margin: float, mu_total: float, mu_h1: float, spread_home: float | None,
                  total_line: float | None) -> dict:
        """Combine the model projection with the market line: mu = w*model + (1-w)*market.
        Weights and residual SDs were fit on the out-of-sample calibration fold."""
        b = self.blend or {}
        out = dict(margin=mu_margin, total=mu_total, h1_total=mu_h1, sigma_margin=self.sigma_margin,
                   sigma_total=self.sigma_total, w_margin=1.0, w_total=1.0, market_informed=False)
        if b.get("w_margin") is not None and spread_home is not None:
            w = b["w_margin"]
            out.update(margin=w * mu_margin + (1 - w) * (-spread_home), sigma_margin=b["sigma_margin"], w_margin=w, market_informed=True)
        if b.get("w_total") is not None and total_line is not None:
            w = b["w_total"]
            t = w * mu_total + (1 - w) * total_line
            out.update(total=t, h1_total=mu_h1 * t / mu_total if mu_total else mu_h1, sigma_total=b["sigma_total"], w_total=w,
                       market_informed=True)
        return out

    def simulate(self, mu_margin: float, mu_total: float, mu_h1: float, n: int, seed: int,
                 sigma_margin: float | None = None, sigma_total: float | None = None) -> dict:
        rng = np.random.default_rng(seed)
        sm, st = sigma_margin or self.sigma_margin, sigma_total or self.sigma_total
        cov = [[sm**2, self.rho * sm * st], [self.rho * sm * st, st**2]]
        mt = rng.multivariate_normal([mu_margin, mu_total], cov, size=n)
        home = np.rint((mt[:, 1] + mt[:, 0]) / 2)
        away = np.rint((mt[:, 1] - mt[:, 0]) / 2)
        # resolve ties with an overtime period (~ 5 min) at league scoring rates
        ot_mu = 10.5 if self.league == "NBA" else 8.0
        tie = home == away
        while tie.any():
            k = int(tie.sum())
            home[tie] += rng.poisson(ot_mu, k)
            away[tie] += rng.poisson(ot_mu, k)
            tie = home == away
        h1 = np.rint(rng.normal(mu_h1, self.sigma_h1, n))
        return dict(home=home, away=away, margin=home - away, total=home + away, h1_total=h1)


def summarize_sims(s: dict, spread_home: float | None, total_line: float | None, h1_line: float | None,
                   calibrator=None) -> dict:
    margin, total = s["margin"], s["total"]
    p_home_raw = float((margin > 0).mean())
    p_home = float(calibrator.predict([p_home_raw])[0]) if calibrator is not None else p_home_raw
    p_home = float(np.clip(p_home, 0.01, 0.99))

    def dist(x):
        lo, hi = np.percentile(x, [5, 95])
        q25, q75 = np.percentile(x, [25, 75])
        return dict(mean=float(np.mean(x)), median=float(np.median(x)), sd=float(np.std(x)),
                    p05=float(lo), p25=float(q25), p75=float(q75), p95=float(hi))

    out = dict(
        n_sims=int(len(margin)),
        win_prob_home=p_home, win_prob_home_raw=p_home_raw, win_prob_away=1 - p_home,
        home_score=dist(s["home"]), away_score=dist(s["away"]), margin=dist(margin), total=dist(total),
        h1_total=dist(s["h1_total"]),
        margin_hist=_hist(margin, 2), total_hist=_hist(total, 3),
    )
    if spread_home is not None:
        adj = margin + spread_home
        out["spread"] = dict(line_home=spread_home, p_home_cover=float((adj > 0).mean()),
                             p_push=float((adj == 0).mean()), p_away_cover=float((adj < 0).mean()))
    if total_line is not None:
        out["totals"] = dict(line=total_line, p_over=float((total > total_line).mean()),
                             p_push=float((total == total_line).mean()), p_under=float((total < total_line).mean()))
    if h1_line is not None:
        h1 = s["h1_total"]
        out["h1"] = dict(line=h1_line, p_over=float((h1 > h1_line).mean()),
                         p_push=float((h1 == h1_line).mean()), p_under=float((h1 < h1_line).mean()))
    return out


def _fair_decimal(p_win: float, p_push: float) -> float | None:
    """Break-even decimal odds for a bet that wins w.p. p_win and pushes (stake back) w.p. p_push."""
    p_loss = 1 - p_win - p_push
    return None if p_win <= 0 else 1 + p_loss / p_win


def ladder(s: dict, center_spread: float, center_total: float, extra_spreads=(), extra_totals=()) -> dict:
    """Price alternate lines straight from the simulated outcomes.

    spreads: home line L (home covers when margin + L > 0); the away side is -L.
    totals:  line T (over when total > T). Integer lines carry push probability.
    """
    margin, total = s["margin"], s["total"]
    c_s = round(center_spread * 2) / 2
    c_t = round(center_total * 2) / 2
    s_lines = sorted({c_s + k for k in np.arange(-6, 6.5, 1.0)} | {float(x) for x in extra_spreads})
    t_lines = sorted({c_t + k for k in np.arange(-10, 10.5, 2.0)} | {float(x) for x in extra_totals})
    spreads = []
    for L in s_lines:
        adj = margin + L
        ph, pp = float((adj > 0).mean()), float((adj == 0).mean())
        pa = 1 - ph - pp
        spreads.append(dict(line_home=float(L), p_home=ph, p_push=pp, p_away=pa,
                            fair_home=_fair_decimal(ph, pp), fair_away=_fair_decimal(pa, pp)))
    totals = []
    for T in t_lines:
        po, pp = float((total > T).mean()), float((total == T).mean())
        pu = 1 - po - pp
        totals.append(dict(line=float(T), p_over=po, p_push=pp, p_under=pu,
                           fair_over=_fair_decimal(po, pp), fair_under=_fair_decimal(pu, pp)))
    return dict(spreads=spreads, totals=totals)


def _hist(x: np.ndarray, width: int) -> list[dict]:
    lo, hi = np.floor(np.percentile(x, 0.5)), np.ceil(np.percentile(x, 99.5))
    edges = np.arange(lo, hi + width, width)
    c, e = np.histogram(x, bins=edges)
    return [dict(x=float(e[i]), count=int(c[i]), p=float(c[i] / len(x))) for i in range(len(c))]


# ---------------- training ----------------

# GBMs learn the residual on top of a structural efficiency baseline (pace x opponent-adjusted
# points per possession). This keeps them anchored on small samples and lets trees focus on
# rest/travel/injury/matchup effects.
BASELINE = {"margin": "naive_margin", "total": "naive_total", "h1_total": "naive_h1"}


def _fit_pair(X, y, seed, tgt):
    r = y.values - X[BASELINE[tgt]].values
    a = _lgb({"random_state": seed}).fit(X, r)
    b = _cat(seed).fit(X, r)
    return {"lgb": a, "cat": b}


def _pred_pair(ms, X, tgt):
    return X[BASELINE[tgt]].values + (ms["lgb"].predict(X) + ms["cat"].predict(X)) / 2


def walk_forward(df: pd.DataFrame, feats: list[str], n_folds: int = 4, seed: int = 0) -> list[dict]:
    """Expanding-window walk-forward: train on everything before each fold's start date."""
    df = df.sort_values("start_time")
    n = len(df)
    start = int(n * 0.5)
    fold_size = (n - start) // n_folds
    out = []
    for k in range(n_folds):
        a, b = start + k * fold_size, start + (k + 1) * fold_size if k < n_folds - 1 else n
        tr, te = df.iloc[:a], df.iloc[a:b]
        if te.empty:
            continue
        m = _lgb({"random_state": seed}).fit(tr[feats], tr["y_margin"] - tr["naive_margin"])
        t = _lgb({"random_state": seed}).fit(tr[feats], tr["y_total"] - tr["naive_total"])
        pm = te["naive_margin"].values + m.predict(te[feats])
        pt = te["naive_total"].values + t.predict(te[feats])
        sig = float(np.std(tr["y_margin"] - tr["naive_margin"] - m.predict(tr[feats])) * 1.05)
        pw = norm.cdf(pm / max(sig, 1e-6))
        out.append(dict(fold=k + 1, train_end=str(tr["start_time"].max()), test_start=str(te["start_time"].min()),
                        test_end=str(te["start_time"].max()), n_train=len(tr), n_test=len(te),
                        margin=M.regression_metrics(pm, te["y_margin"].values),
                        total=M.regression_metrics(pt, te["y_total"].values),
                        win=M.classification_metrics(pw, te["y_home_win"].values)))
    return out


def season_backtest(df: pd.DataFrame, feats: list[str], seed: int = 0) -> list[dict]:
    """Performance across seasons: for each season after the first, train the residual learners on
    every earlier season only and evaluate on that whole season."""
    if "season" not in df:
        return []
    seasons = sorted(df["season"].dropna().unique())
    out = []
    for i in range(1, len(seasons)):
        tr, te = df[df["season"] < seasons[i]], df[df["season"] == seasons[i]]
        if len(tr) < 200 or len(te) < 50:
            continue
        mm = _lgb({"random_state": seed}).fit(tr[feats], tr["y_margin"] - tr["naive_margin"])
        mt = _lgb({"random_state": seed}).fit(tr[feats], tr["y_total"] - tr["naive_total"])
        pm = te["naive_margin"].values + mm.predict(te[feats])
        pt = te["naive_total"].values + mt.predict(te[feats])
        sig = float(np.std(tr["y_margin"] - tr["naive_margin"] - mm.predict(tr[feats])))
        out.append(dict(season=str(seasons[i]), n_train=int(len(tr)), n_test=int(len(te)),
                        margin=M.regression_metrics(pm, te["y_margin"].values),
                        total=M.regression_metrics(pt, te["y_total"].values),
                        baseline_margin=M.regression_metrics(te["naive_margin"].values, te["y_margin"].values),
                        win=M.classification_metrics(norm.cdf(pm / max(sig, 1e-6)), te["y_home_win"].values)))
    return out


def train_game_model(df: pd.DataFrame, league: str, data_source: str, seed: int = 7,
                     lgb_overrides: dict | None = None) -> GameModelBundle:
    """df: output of build_features joined with start_time; must contain targets."""
    feats = feature_names(league)
    df = df.dropna(subset=["y_margin", "y_total"]).sort_values("start_time").reset_index(drop=True)
    # drop the first few games of each team's history (cold-start noise) from training only
    df = df[(df["h_games"] >= 3) & (df["a_games"] >= 3)].reset_index(drop=True)
    n = len(df)
    if n < 300:
        raise ValueError(f"need >=300 completed games to train a {league} model, have {n}")
    i_tr, i_cal = int(n * 0.70), int(n * 0.85)
    tr, cal, te = df.iloc[:i_tr], df.iloc[i_tr:i_cal], df.iloc[i_cal:]
    log.info("training %s game model: train=%d cal=%d test=%d", league, len(tr), len(cal), len(te))

    if lgb_overrides:
        LGB_PARAMS.update(lgb_overrides)
    models = {
        "margin": _fit_pair(tr[feats], tr["y_margin"], seed, "margin"),
        "total": _fit_pair(tr[feats], tr["y_total"], seed, "total"),
    }
    h1 = tr.dropna(subset=["y_h1_total"])
    models["h1_total"] = _fit_pair(h1[feats], h1["y_h1_total"], seed, "h1_total")

    # residual structure from calibration fold (out of sample)
    rm = cal["y_margin"].values - _pred_pair(models["margin"], cal[feats], "margin")
    rt = cal["y_total"].values - _pred_pair(models["total"], cal[feats], "total")
    calh = cal.dropna(subset=["y_h1_total"])
    rh = calh["y_h1_total"].values - _pred_pair(models["h1_total"], calh[feats], "h1_total")
    sm, st, sh = float(np.std(rm)), float(np.std(rt)), float(np.std(rh))
    rho = float(np.corrcoef(rm, rt)[0, 1])
    # ---- market-informed blend: fit w on calibration rows that have a pre-game market line ----
    blend = _fit_blend(cal, _pred_pair(models["margin"], cal[feats], "margin"), _pred_pair(models["total"], cal[feats], "total"))
    mu_cal = _pred_pair(models["margin"], cal[feats], "margin")
    sd_cal = np.full(len(cal), sm)
    if blend:
        has = cal["mkt_spread_home"].notna().values
        mu_cal = np.where(has, blend["w_margin"] * mu_cal + (1 - blend["w_margin"]) * (-cal["mkt_spread_home"].fillna(0).values), mu_cal)
        sd_cal = np.where(has, blend["sigma_margin"], sm)
    p_cal_raw = norm.cdf(mu_cal / sd_cal)
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.01, y_max=0.99).fit(p_cal_raw, cal["y_home_win"].values)

    # ---- held-out test evaluation (never used for fitting) ----
    pm, pt = _pred_pair(models["margin"], te[feats], "margin"), _pred_pair(models["total"], te[feats], "total")
    teh = te.dropna(subset=["y_h1_total"])
    ph = _pred_pair(models["h1_total"], teh[feats], "h1_total")
    p_raw = norm.cdf(pm / sm)
    p_cal = np.clip(iso.predict(p_raw), 0.01, 0.99)
    y_win = te["y_home_win"].values
    # benchmark: XGBoost
    xm = _xgb(seed).fit(tr[feats], tr["y_margin"]).predict(te[feats])
    xt = _xgb(seed).fit(tr[feats], tr["y_total"]).predict(te[feats])
    # baseline: naive efficiency formula (no ML)
    metrics = dict(
        split=dict(train=[str(tr.start_time.min()), str(tr.start_time.max())],
                   calibration=[str(cal.start_time.min()), str(cal.start_time.max())],
                   test=[str(te.start_time.min()), str(te.start_time.max())],
                   n_train=len(tr), n_cal=len(cal), n_test=len(te)),
        test=dict(
            margin=M.regression_metrics(pm, te["y_margin"].values),
            total=M.regression_metrics(pt, te["y_total"].values),
            h1_total=M.regression_metrics(ph, teh["y_h1_total"].values),
            win_raw=M.classification_metrics(p_raw, y_win),
            win_calibrated=M.classification_metrics(p_cal, y_win),
            reliability=M.reliability(p_cal, y_win),
        ),
        benchmarks=dict(
            xgboost=dict(margin=M.regression_metrics(xm, te["y_margin"].values),
                         total=M.regression_metrics(xt, te["y_total"].values)),
            naive_efficiency=dict(margin=M.regression_metrics(te["naive_margin"].values, te["y_margin"].values),
                                  total=M.regression_metrics(te["naive_total"].values, te["y_total"].values)),
        ),
        residuals=dict(sigma_margin=sm, sigma_total=st, sigma_h1=sh, rho=rho),
        market_blend=dict(fit=blend, test=_blend_eval(te, pm, pt, sm, st, blend)),
        walk_forward=walk_forward(df, feats, seed=seed),
        by_season=season_backtest(df, feats, seed=seed),
        feature_importance=_importance(models, feats),
    )
    now = datetime.now(timezone.utc)
    version = f"{league.lower()}-game-{now.strftime('%Y%m%d%H%M%S')}"
    return GameModelBundle(
        league=league, version=version, features=feats, models=models, sigma_margin=sm, sigma_total=st,
        rho=rho, sigma_h1=sh, calibrator=iso, metrics=metrics, trained_at=now.isoformat(),
        data_source=data_source, train_start=str(tr.start_time.min()), train_end=str(tr.start_time.max()), n_train=len(tr),
        blend=blend,
    )


def _fit_blend(cal: pd.DataFrame, pm: np.ndarray, pt: np.ndarray, min_rows: int = 100) -> dict | None:
    if "mkt_spread_home" not in cal:
        return None
    has_m, has_t = cal["mkt_spread_home"].notna().values, cal["mkt_total"].notna().values
    if has_m.sum() < min_rows or has_t.sum() < min_rows:
        return None
    grid = np.linspace(0, 1, 41)
    ym, mm = cal["y_margin"].values[has_m], -cal["mkt_spread_home"].values[has_m]
    yt, mt = cal["y_total"].values[has_t], cal["mkt_total"].values[has_t]
    em = [np.mean((w * pm[has_m] + (1 - w) * mm - ym) ** 2) for w in grid]
    et = [np.mean((w * pt[has_t] + (1 - w) * mt - yt) ** 2) for w in grid]
    wm, wt = float(grid[int(np.argmin(em))]), float(grid[int(np.argmin(et))])
    return dict(w_margin=wm, w_total=wt, sigma_margin=float(np.sqrt(min(em))), sigma_total=float(np.sqrt(min(et))),
                n_margin=int(has_m.sum()), n_total=int(has_t.sum()),
                note="w = weight on the model; 1-w on the pre-game market line. Fit by MSE on the calibration fold.")


def _blend_eval(te: pd.DataFrame, pm, pt, sm, st, blend) -> dict | None:
    """Against-the-spread / over-under calibration on the test fold: model-only vs market-informed."""
    if "mkt_spread_home" not in te:
        return None
    out = {}
    hm = te["mkt_spread_home"].notna().values
    if hm.sum() >= 30:
        line = te["mkt_spread_home"].values[hm]
        y = te["y_margin"].values[hm] + line
        keep = y != 0
        yc = (y[keep] > 0).astype(float)
        p_model = norm.cdf((pm[hm][keep] + line[keep]) / sm)
        out["spread_model_only"] = M.classification_metrics(p_model, yc)
        if blend:
            mu = blend["w_margin"] * pm[hm] + (1 - blend["w_margin"]) * (-line)
            out["spread_market_informed"] = M.classification_metrics(norm.cdf((mu[keep] + line[keep]) / blend["sigma_margin"]), yc)
    ht = te["mkt_total"].notna().values
    if ht.sum() >= 30:
        line = te["mkt_total"].values[ht]
        y = te["y_total"].values[ht] - line
        keep = y != 0
        yo = (y[keep] > 0).astype(float)
        out["total_model_only"] = M.classification_metrics(norm.cdf((pt[ht][keep] - line[keep]) / st), yo)
        if blend:
            mu = blend["w_total"] * pt[ht] + (1 - blend["w_total"]) * line
            out["total_market_informed"] = M.classification_metrics(norm.cdf((mu[keep] - line[keep]) / blend["sigma_total"]), yo)
    return out or None


def _importance(models, feats) -> list[dict]:
    imp = np.zeros(len(feats))
    for tgt in ("margin", "total"):
        g = models[tgt]["lgb"].booster_.feature_importance(importance_type="gain")
        imp += g / max(1e-9, g.sum())
    order = np.argsort(-imp)
    return [dict(feature=feats[i], importance=float(imp[i] / 2)) for i in order]


def explain(bundle: GameModelBundle, X: pd.DataFrame, target: str = "margin", top: int = 10) -> list[dict]:
    """Per-game SHAP contributions from the LightGBM member (TreeExplainer)."""
    try:
        import shap

        expl = shap.TreeExplainer(bundle.models[target]["lgb"])
        vals = expl.shap_values(X[bundle.features])[0]
        base = float(np.ravel(expl.expected_value)[0])
    except Exception as exc:  # pragma: no cover - fallback if shap unavailable
        log.warning("SHAP unavailable (%s); using LightGBM pred_contrib", exc)
        contrib = bundle.models[target]["lgb"].predict(X[bundle.features], pred_contrib=True)[0]
        vals, base = contrib[:-1], float(contrib[-1])
    order = np.argsort(-np.abs(vals))[:top]
    baseline_col = BASELINE[target]
    structural = float(X.iloc[0][baseline_col])
    return [dict(feature=bundle.features[i], value=float(X.iloc[0][bundle.features[i]]),
                 contribution=float(vals[i]), base=base, structural_baseline=structural,
                 note=f"contribution to the ML adjustment on top of {baseline_col}") for i in order]


def tune_lightgbm(df: pd.DataFrame, league: str, n_trials: int = 20, seed: int = 7) -> dict:
    """Optuna search on the LightGBM residual (margin) learner, scored by MAE on a chronological validation fold."""
    import optuna

    feats = feature_names(league)
    df = df.dropna(subset=["y_margin"]).sort_values("start_time")
    n = len(df)
    tr, va = df.iloc[: int(n * 0.7)], df.iloc[int(n * 0.7): int(n * 0.85)]

    def objective(trial):
        params = dict(num_leaves=trial.suggest_int("num_leaves", 7, 63),
                      learning_rate=trial.suggest_float("learning_rate", 0.01, 0.1, log=True),
                      min_child_samples=trial.suggest_int("min_child_samples", 10, 120),
                      n_estimators=trial.suggest_int("n_estimators", 150, 900),
                      reg_lambda=trial.suggest_float("reg_lambda", 0.0, 10.0))
        # tune the residual learner exactly as it is used in production (target = y - baseline)
        m = _lgb({**params, "random_state": seed}).fit(tr[feats], tr["y_margin"] - tr["naive_margin"])
        return float(np.mean(np.abs(va["naive_margin"].values + m.predict(va[feats]) - va["y_margin"].values)))

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="minimize", sampler=optuna.samplers.TPESampler(seed=seed))
    study.optimize(objective, n_trials=n_trials)
    return dict(best_params=study.best_params, best_mae=study.best_value, n_trials=n_trials)


def save_bundle(bundle) -> str:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    path = ARTIFACT_DIR / f"{bundle.version}.pkl"
    with open(path, "wb") as f:
        pickle.dump(bundle, f)
    (ARTIFACT_DIR / f"{bundle.version}.metrics.json").write_text(json.dumps(bundle.metrics, default=str, indent=1))
    _mlflow_log(bundle)
    return str(path)


def load_bundle(path: str):
    with open(path, "rb") as f:
        return pickle.load(f)


def _mlflow_log(bundle) -> None:
    from ..config import get_settings

    uri = get_settings().mlflow_tracking_uri
    if not uri:
        return
    try:  # optional dependency
        import mlflow

        mlflow.set_tracking_uri(uri)
        mlflow.set_experiment(f"courtside-{bundle.league.lower()}")
        with mlflow.start_run(run_name=bundle.version):
            mlflow.log_params({"league": bundle.league, "data_source": bundle.data_source, "n_train": bundle.n_train})
            t = bundle.metrics.get("test", {})
            for k, v in t.items():
                if isinstance(v, dict):
                    for mk in ("mae", "rmse", "brier", "log_loss", "ece"):
                        if mk in v:
                            mlflow.log_metric(f"{k}_{mk}", v[mk])
    except Exception as exc:  # pragma: no cover
        log.warning("MLflow logging skipped: %s", exc)
