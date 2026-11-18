import os
import tempfile

import pytest

_tmp = tempfile.mkdtemp(prefix="courtside-test-")
# Set TEST_DATABASE_URL (e.g. postgresql+psycopg://...) to run the suite against PostgreSQL + pgvector.
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{_tmp}/test.db"
os.environ["ENABLE_SCHEDULER"] = "false"
for k in ("BALLDONTLIE_API_KEY", "ODDS_API_KEY", "SPORTSDATAIO_API_KEY", "ANTHROPIC_API_KEY", "REDIS_URL", "ADMIN_TOKEN"):
    os.environ.pop(k, None)


@pytest.fixture(scope="session")
def db():
    from app.db import Base, SessionLocal, engine, init_db
    from app.services import seed

    if engine.dialect.name == "postgresql":  # fresh schema via Alembic migrations
        import subprocess
        import sys

        Base.metadata.drop_all(engine)
        with engine.begin() as c:
            c.exec_driver_sql("DROP TABLE IF EXISTS alembic_version")
        subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True, cwd=os.path.dirname(os.path.dirname(__file__)))
    init_db()
    s = SessionLocal()
    seed.seed_registry(s)
    seed.generate_demo_data(s, seed=1234)
    yield s
    s.close()


@pytest.fixture(scope="session")
def trained(db):
    from app.services import modeling, settlement

    out = {lg: modeling.train_league(db, lg) for lg in ("NBA", "CBB")}
    modeling.backfill_current_season(db, "CBB", max_games=150)
    settlement.settle_all(db)
    from app.ai import rag

    rag.index_core(db)
    return out


@pytest.fixture(scope="session")
def client(trained):
    import app.main as main
    from fastapi.testclient import TestClient

    main.bootstrap = lambda: {}
    with TestClient(main.app) as c:
        yield c
