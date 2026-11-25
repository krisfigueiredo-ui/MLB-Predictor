"""Snapshot export/load round trip into a fresh database."""
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app import models as m
from app.data_mgmt import snapshot
from app.db import Base


def test_snapshot_round_trip(db, tmp_path):
    man = snapshot.export(db, tmp_path, description="test")
    assert man["tables"]["games"]["rows"] == db.scalar(select(func.count(m.Game.id)))
    assert (tmp_path / "manifest.json").exists()
    # byte-for-byte reproducible export
    again = snapshot.export(db, tmp_path / "again")
    assert all(man["tables"][t]["sha256"] == again["tables"][t]["sha256"] for t in snapshot.LOAD_TABLES)

    eng = create_engine(f"sqlite:///{tmp_path}/fresh.db")
    Base.metadata.create_all(eng)
    fresh = sessionmaker(bind=eng)()
    counts = snapshot.load(fresh, tmp_path)
    for t in snapshot.LOAD_TABLES:
        assert counts[t] == man["tables"][t]["rows"], t
    g0 = db.scalar(select(m.Game).where(m.Game.status == "final").order_by(m.Game.id))
    g1 = fresh.get(m.Game, g0.id)
    assert (g1.home_team_id, g1.away_team_id, g1.home_score, g1.away_score, g1.is_demo) == (g0.home_team_id, g0.away_team_id, g0.home_score, g0.away_score, g0.is_demo)
    assert g1.pregame_context == g0.pregame_context
    assert g1.start_time.replace(tzinfo=None) == g0.start_time.replace(tzinfo=None)
    o0 = db.scalar(select(m.OddsSnapshot).order_by(m.OddsSnapshot.id))
    o1 = fresh.get(m.OddsSnapshot, o0.id)
    assert (o1.market, o1.outcome, o1.line, o1.price_american) == (o0.market, o0.outcome, o0.line, o0.price_american)
    # refuses to load over existing data
    try:
        snapshot.load(fresh, tmp_path)
        raised = False
    except ValueError:
        raised = True
    assert raised


def test_snapshot_checksum_is_verified(db, tmp_path):
    import gzip

    snapshot.export(db, tmp_path)
    p = tmp_path / "teams.csv.gz"
    rows = gzip.decompress(p.read_bytes()).decode().splitlines()
    rows[1] = rows[1].replace("Atlanta", "Atlantis")
    p.write_bytes(gzip.compress("\n".join(rows).encode()))
    eng = create_engine(f"sqlite:///{tmp_path}/fresh2.db")
    Base.metadata.create_all(eng)
    try:
        snapshot.load(sessionmaker(bind=eng)(), tmp_path)
        raised = False
    except ValueError as e:
        raised = "checksum" in str(e)
    assert raised
