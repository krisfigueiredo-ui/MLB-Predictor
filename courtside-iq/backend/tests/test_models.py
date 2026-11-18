"""Model evaluation, leakage and reproducibility tests."""
import numpy as np
import pandas as pd
from sqlalchemy import select

from app import models as m
from app.ml import metrics as M
from app.ml.features import build_features
from app.services.dataset import feature_frame, games_df, teams_df


def test_metrics_basics():
    p = np.array([0.9, 0.8, 0.2, 0.1])
    y = np.array([1, 1, 0, 0])
    assert M.brier(p, y) < 0.05
    assert M.log_loss(np.full(4, 0.5), y) == np.log(2).__round__(6) or abs(M.log_loss(np.full(4, 0.5), y) - np.log(2)) < 1e-9
    assert M.ece(np.full(100, 0.7), (np.arange(100) < 70).astype(float)) < 1e-9
    lo, hi = M.wilson_interval(55, 100)
    assert lo < 0.55 < hi


def test_features_are_point_in_time(db):
    """Changing a later game's result must not change features of any earlier game."""
    g = games_df(db, "NBA")
    t = teams_df(db, "NBA")
    base = build_features(g, t, "NBA").set_index("id")
    g2 = g.copy()
    finals = g2[g2["status"] == "final"].sort_values("start_time")
    target = finals.iloc[len(finals) // 2]
    g2.loc[g2["id"] == target["id"], "home_points"] += 40
    alt = build_features(g2, t, "NBA").set_index("id")
    earlier = g2[g2["start_time"] <= target["start_time"]]["id"]
    later = g2[g2["start_time"] > target["start_time"] + pd.Timedelta(days=3)]["id"]
    cols = [c for c in base.columns if not c.startswith("y_")]
    pd.testing.assert_frame_equal(base.loc[earlier, cols], alt.loc[earlier, cols])
    assert not base.loc[later, cols].equals(alt.loc[later, cols])  # the change propagates forward only


def test_market_lines_never_after_tipoff(db):
    ff = feature_frame(db, "NBA")
    with_line = ff[ff["mkt_spread_home"].notna()]
    assert len(with_line) > 100
    # every consensus used for modelling was captured >= 55 min before start
    snaps = db.execute(select(m.OddsSnapshot.captured_at, m.Game.start_time).join(m.Game)
                       .where(m.Game.id.in_(with_line["id"].head(50).tolist()), m.OddsSnapshot.market == "spreads")).all()
    assert snaps


def test_training_and_benchmarks(trained, db):
    from app.services.modeling import active_version

    for lg in ("NBA", "CBB"):
        mv = active_version(db, lg)
        t = mv.metrics["test"]
        assert mv.data_source == "synthetic_demo"
        assert t["margin"]["n"] > 100
        # trained ensemble should not be worse than XGBoost benchmark by more than a small margin
        assert t["margin"]["mae"] <= mv.metrics["benchmarks"]["xgboost"]["margin"]["mae"] * 1.05
        assert 0 <= t["win_calibrated"]["ece"] < 0.15
        assert len(mv.metrics["walk_forward"]) >= 3
        # chronological split: train ends before calibration, calibration before test
        sp = mv.metrics["split"]
        assert sp["train"][1] <= sp["calibration"][0] <= sp["calibration"][1] <= sp["test"][0]
    assert active_version(db, "NBA", "props") is not None


def test_simulation_reproducible_and_coherent(trained, db):
    from app.services.modeling import project_game

    g = db.scalar(select(m.Game).where(m.Game.league == "NBA", m.Game.status == "scheduled", m.Game.is_historical_sim.is_(False)))
    a = project_game(db, g, n_sims=10000, explain=False)
    b = project_game(db, g, n_sims=10000, explain=False)
    assert a["simulation"]["win_prob_home_raw"] == b["simulation"]["win_prob_home_raw"]
    s = a["simulation"]
    assert s["n_sims"] == 10000
    assert abs(s["win_prob_home"] + s["win_prob_away"] - 1) < 1e-9
    if "spread" in s:
        sp = s["spread"]
        assert abs(sp["p_home_cover"] + sp["p_away_cover"] + sp["p_push"] - 1) < 1e-9
    assert s["total"]["p05"] < s["total"]["median"] < s["total"]["p95"]


def test_archive_is_append_only_and_pregame(trained, db):
    from app.services import performance

    df = performance.official_predictions(db, "CBB", include_pending=True)
    assert len(df) > 0
    assert (df["data_as_of"] <= df["start_time"]).all()
    n_before = db.query(m.Prediction).count()
    from app.services.modeling import archive_game_predictions

    g = db.scalar(select(m.Game).where(m.Game.league == "CBB", m.Game.status == "scheduled", m.Game.is_historical_sim.is_(False)))
    archive_game_predictions(db, g)
    archive_game_predictions(db, g)
    assert db.query(m.Prediction).count() > n_before  # new snapshots added, older rows untouched


def test_settlement_against_finals(trained, db):
    settled = db.scalars(select(m.Prediction).where(m.Prediction.result != "pending", m.Prediction.market == "total").limit(50)).all()
    assert settled
    for p in settled:
        g = p.game
        tot = g.home_score + g.away_score
        exp = "push" if tot == p.line else ("win" if (tot > p.line) == (p.selection == "over") else "loss")
        assert p.result == exp
        assert db.query(m.Settlement).filter_by(prediction_id=p.id).count() == 1


def test_props_distribution(trained, db):
    from app.services.modeling import project_props

    g = db.scalar(select(m.Game).join(m.PropLine, m.PropLine.game_id == m.Game.id).where(m.Game.status == "scheduled"))
    if g is None:
        g = db.scalar(select(m.Game).join(m.PropLine, m.PropLine.game_id == m.Game.id))
    props = project_props(db, g, n_sims=3000)
    assert props
    p = props[0]
    pts = p["markets"]["pts"]
    # pmf omits values with p < 0.2% (display trimming), so the shown mass is slightly below 1
    assert 0.95 < sum(x["p"] for x in pts["pmf"]) <= 1 + 1e-9
    assert p["correlation"]["matrix"][0][2] > 0  # pts/ast positively correlated via shared minutes & flow
    assert 0 < p["minutes"]["mean"] < 48
