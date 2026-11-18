from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select

from . import models as m
from .config import get_settings
from .db import SessionLocal, init_db

logging.basicConfig(level=logging.INFO, format='{"t":"%(asctime)s","lvl":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}')
log = logging.getLogger("courtside")


def bootstrap() -> dict:
    """Create schema, seed registries, and (in demo mode) build demo data + models."""
    from .ai import rag
    from .services import modeling, seed

    s = get_settings()
    init_db()
    out = {}
    with SessionLocal() as db:
        seed.seed_registry(db)
        if s.demo_mode:
            out["demo"] = seed.generate_demo_data(db, s.random_seed)
            from .services import demo_feed

            demo_feed.tick(db)
        for league in ("NBA", "CBB"):
            if modeling.active_version(db, league) is None:
                try:
                    out[f"train_{league}"] = modeling.train_league(db, league)
                except ValueError as exc:
                    out[f"train_{league}"] = f"skipped: {exc}"
                    continue
            if s.demo_mode:
                t0 = time.time()
                out[f"backtest_{league}"] = modeling.backfill_current_season(db, league)
                log.info("backtest %s in %.1fs", league, time.time() - t0)
        from .services import settlement

        out["settled"] = settlement.settle_all(db)
        out["indexed"] = rag.index_core(db)
    return out


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    log.info("bootstrap: %s", bootstrap())
    stop = None
    if s.enable_scheduler:
        from . import scheduler

        stop = scheduler.start()
    yield
    if stop:
        stop.set()


app = FastAPI(title="COURTSIDE IQ API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in get_settings().cors_origins.split(",")], allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def timing(request: Request, call_next):
    t0 = time.perf_counter()
    try:
        resp = await call_next(request)
    except Exception:
        log.exception("unhandled error on %s", request.url.path)
        return JSONResponse({"detail": "internal error"}, status_code=500)
    resp.headers["X-Response-Time-ms"] = f"{(time.perf_counter() - t0) * 1000:.1f}"
    return resp


from .api.routes import router  # noqa: E402

app.include_router(router)
