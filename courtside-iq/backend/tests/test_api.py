"""API integration tests (demo mode, no external credentials)."""
from datetime import date


def test_status_reports_demo_mode(client):
    r = client.get("/api/status").json()
    assert r["mode"] == "demo" and r["demo"] is True
    assert r["ai_enabled"] is False
    assert all(not p["configured"] for p in r["providers"].values())


def test_registry_identity(client):
    nba = client.get("/api/teams?league=NBA").json()
    assert len(nba) == 30
    assert {t["abbr"] for t in nba} >= {"BOS", "LAL", "GSW", "OKC"}
    cbb = client.get("/api/teams?league=CBB").json()
    names = {t["location"] for t in cbb}
    for school in ("Miami", "Duke", "North Carolina", "Kansas", "Kentucky", "Florida", "West Virginia"):
        assert school in names
    players = client.get("/api/players?league=NBA").json()
    curry = next(p for p in players if p["name"] == "Stephen Curry")
    assert curry["team"]["abbr"] == "GSW" and curry["jersey"] == "30"
    assert curry["roster"]["verified"] is False  # seed roster flagged until provider sync


def test_ticker_and_game_detail(client):
    t = client.get("/api/ticker").json()
    assert t["demo"] is True and t["games"]
    g = t["games"][0]
    assert {"home", "away", "status", "home_score"} <= g.keys()
    d = client.get(f"/api/games/{g['id']}?n_sims=2000").json()
    assert d["game"]["id"] == g["id"]
    if d["projection"]:
        assert d["projection"]["simulation"]["n_sims"] == 2000
        assert d["projection"]["explain"]["margin"]


def test_board_and_perf(client):
    b = client.get("/api/board?league=CBB&hours=48").json()
    assert "games" in b
    s = client.get("/api/performance/summary?league=CBB").json()
    assert s["total"]["n"] > 0
    assert client.get("/api/performance/breakdown?by=conference&league=CBB").status_code == 200
    assert client.get("/api/performance/breakdown?by=bogus").status_code == 400
    d = client.get("/api/diagnostics?league=CBB").json()
    assert "findings" in d


def test_picks_journal_crud_and_validation(client):
    bad = client.post("/api/picks", json=dict(pick_date=str(date.today()), league="NBA", description="x", market="spread",
                                             selection="home", price_american=50))
    assert bad.status_code == 422
    r = client.post("/api/picks", json=dict(pick_date=str(date.today()), league="NBA", description="BOS -4.5", market="spread",
                                           selection="home", line=-4.5, price_american=-110, stake_units=1.5,
                                           confidence_notes="rest edge"))
    assert r.status_code == 200
    pid = r.json()["id"]
    u = client.patch(f"/api/picks/{pid}", json=dict(status="win")).json()
    assert u["status"] == "win" and abs(u["profit_units"] - 1.5 * 100 / 110) < 1e-6
    lst = client.get("/api/picks").json()
    assert lst["summary"]["wins"] >= 1
    assert client.delete(f"/api/picks/{pid}").status_code == 200


def test_pick_auto_settles_on_final_game(client, db):
    from sqlalchemy import select

    from app import models as m

    g = db.scalar(select(m.Game).where(m.Game.status == "final", m.Game.is_historical_sim.is_(False)))
    line = g.home_score + g.away_score - 0.5
    r = client.post("/api/picks", json=dict(pick_date=str(date.today()), league=g.league, game_id=g.id, description="over",
                                           market="total", selection="over", line=line, price_american=-110)).json()
    assert r["id"]
    lst = {p["id"]: p for p in client.get("/api/picks").json()["picks"]}
    assert lst[r["id"]]["status"] == "win"


def test_import_endpoint_and_export(client):
    csv = b"date,player,team,minutes,pts,reb,ast\n2026-11-10,Stephen Curry,GSW,35,30,5,6\n"
    r = client.post("/api/data/import", files={"file": ("p.csv", csv, "text/csv")})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "player_stats" and body["scorecard"]["rows"] == 1
    assert client.get(f"/api/data/imports/{body['id']}").status_code == 200
    for fmt in ("csv", "xlsx", "json"):
        e = client.get(f"/api/data/export/predictions?format={fmt}&league=CBB")
        assert e.status_code == 200 and "attachment" in e.headers["content-disposition"]
    assert client.get("/api/data/export/nope").status_code == 404


def test_ai_disabled_without_key(client):
    r = client.post("/api/ai/ask", json=dict(question="Why does the model like the over?")).json()
    assert r["answer"] is None and "ANTHROPIC_API_KEY" in r["error"]
    docs = client.get("/api/ai/search?q=monte carlo simulation").json()
    assert docs and docs[0]["source_type"] in ("methodology", "model_card")


def test_ai_tools_return_citations(trained, db):
    from app.ai import tools

    out = tools.run(db, "league_efficiency_table", {"league": "CBB", "limit": 5})
    assert out["rows"] and out["citations"]
    out = tools.run(db, "model_performance", {"league": "CBB", "breakdown": "market"})
    assert "summary" in out and out["citations"]
    out = tools.run(db, "player_trends", {"player": "Jokic"})
    assert out["trends"]["player"]["team"] == "Denver Nuggets"
    assert tools.run(db, "nope", {})["error"]
