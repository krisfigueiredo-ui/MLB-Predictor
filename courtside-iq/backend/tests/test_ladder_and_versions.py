"""Alternate-line ladder, version comparison, season backtest and dynamic RAG indexing."""
from datetime import timedelta

import numpy as np
from sqlalchemy import select

from app import models as m
from app.ml.game_model import ladder


def test_ladder_math():
    rng = np.random.default_rng(0)
    margin = np.rint(rng.normal(4, 12, 40000))
    total = np.rint(rng.normal(220, 18, 40000))
    lad = ladder({"margin": margin, "total": total}, center_spread=-4.0, center_total=220.0, extra_spreads=[-9.5], extra_totals=[231.5])
    sp = {r["line_home"]: r for r in lad["spreads"]}
    assert -9.5 in sp and -4.0 in sp
    # integer line carries push mass, half-point line does not; probabilities sum to 1
    assert sp[-4.0]["p_push"] > 0 and sp[-9.5]["p_push"] == 0
    for r in lad["spreads"]:
        assert abs(r["p_home"] + r["p_away"] + r["p_push"] - 1) < 1e-9
    # giving the home side more points can only raise its cover probability
    lines = sorted(sp)
    assert all(sp[a]["p_home"] <= sp[b]["p_home"] + 1e-12 for a, b in zip(lines, lines[1:]))
    tot = {r["line"]: r for r in lad["totals"]}
    assert 231.5 in tot and tot[231.5]["p_over"] < tot[220.0]["p_over"]
    # fair decimal odds make the bet break-even (EV 0) once pushes are accounted for
    r = sp[-4.0]
    d = r["fair_home"]
    assert abs(r["p_home"] * (d - 1) - (1 - r["p_home"] - r["p_push"])) < 1e-9


def test_alt_prices_reach_the_ladder(trained, db):
    from app.services import market, modeling

    g = db.scalar(select(m.Game).where(m.Game.league == "NBA", m.Game.status == "scheduled", m.Game.is_historical_sim.is_(False)))
    book = db.scalar(select(m.Sportsbook).where(m.Sportsbook.key == "draftkings"))
    t = (g.start_time if g.start_time.tzinfo else g.start_time.replace(tzinfo=__import__("datetime").timezone.utc)) - timedelta(hours=40)
    db.add_all([m.OddsSnapshot(game_id=g.id, sportsbook_id=book.id, market="alternate_spreads", outcome="home", line=-12.5, price_american=+320,
                               captured_at=t, source="test", is_demo=True),
                m.OddsSnapshot(game_id=g.id, sportsbook_id=book.id, market="alternate_totals", outcome="over", line=250.5, price_american=+400,
                               captured_at=t, source="test", is_demo=True)])
    db.commit()
    alts = market.alt_prices(db, g.id)
    assert alts[("spread", -12.5, "home")]["price"] == 320
    # alternate markets must not leak into the main-line consensus
    assert all(not k[1].startswith("alternate") for k in market.latest_by_book(db, g.id))
    p = modeling.project_game(db, g, n_sims=4000, explain=False)
    rung = next(r for r in p["simulation"]["ladder"]["spreads"] if r["line_home"] == -12.5)
    assert rung["book_home"]["price"] == 320 and "ev" in rung["book_home"]
    rung_t = next(r for r in p["simulation"]["ladder"]["totals"] if r["line"] == 250.5)
    assert rung_t["book_over"]["book"] == "DraftKings"


def test_season_backtest_and_version_comparison(trained, db, client):
    from app.services import modeling

    mv = modeling.active_version(db, "CBB")
    seasons = mv.metrics["by_season"]
    assert seasons and all(r["n_test"] > 0 and r["margin"]["mae"] > 0 for r in seasons)
    assert [r["season"] for r in seasons] == sorted(r["season"] for r in seasons)
    before = client.get("/api/models/compare?league=CBB").json()["versions"]
    modeling.train_league(db, "CBB")  # a challenger version
    after = client.get("/api/models/compare?league=CBB").json()["versions"]
    assert len(after) == len(before) + 1
    assert sum(v["is_active"] for v in after) == 1 and after[-1]["is_active"]
    old = after[0]
    assert old["archived"] and old["archived"]["decided"] > 0  # archived forecasts stay attributed to the version that made them
    assert old["test"]["margin_mae"] is not None


def test_dynamic_rag_documents(trained, db):
    from app.ai import rag

    n = rag.index_dynamic(db)
    assert n > 0
    kinds = {d.source_type for d in db.scalars(select(m.AIDocument))}
    assert {"daily_digest", "game_recap", "league_leaders"} <= kinds
    recap = db.scalar(select(m.AIDocument).where(m.AIDocument.source_type == "game_recap"))
    assert recap.url.startswith("/games/") and "Final" in recap.content
