# Deploying COURTSIDE IQ

## Topology

| Service | Image | Notes |
|---|---|---|
| `db` | `pgvector/pgvector:pg16` | PostgreSQL 16 with the `vector` extension (created by the first migration). |
| `redis` | `redis:7` | Provider response cache. Optional: the app falls back to an in-process cache. |
| `api` | `backend/Dockerfile` | Runs `alembic upgrade head`, then `uvicorn`. Set `ENABLE_SCHEDULER=false` when a separate worker runs. |
| `worker` | `backend/Dockerfile` | `python -m app.scheduler`: live polling, odds snapshots, forecast freezing, settlement. Run **exactly one**. |
| `web` | `frontend/Dockerfile` | Next.js standalone server; proxies `/api/*` to `BACKEND_URL`. |

`docker compose up --build` starts the whole stack locally. For production, run the same images on your orchestrator (ECS, Cloud Run, Kubernetes, Fly):

1. **Database**: a managed Postgres 15+ with pgvector (RDS, Cloud SQL, Neon and Supabase all support it). Set `DATABASE_URL=postgresql+psycopg://…`.
2. **Secrets**: keep `BALLDONTLIE_API_KEY`, `ODDS_API_KEY`, `ANTHROPIC_API_KEY`, `ADMIN_TOKEN` and `POSTGRES_PASSWORD` in your secret manager and inject them as env vars into `api` and `worker` only. The web container needs none.
3. **Migrations**: run automatically on `api` start; for a dedicated release step, run `alembic upgrade head`.
4. **Persistent volumes**: `artifacts/` (trained model files referenced by `model_versions.artifact_path`) and `data/raw/` (original import files). On ephemeral platforms, mount object storage or a shared volume.
5. **CORS / origin**: the web app proxies the API, so browsers only talk to one origin. If you expose the API directly, set `CORS_ORIGINS`, and `NEXT_PUBLIC_API_URL` at web build time.
6. **SSE**: `/api/stream/ticker` is a long-lived response. Disable proxy buffering (the API sends `X-Accel-Buffering: no`) and allow idle timeouts above 60s. The frontend falls back to 20s polling automatically.
7. **Scaling**: the API is stateless apart from an in-process feature cache; scale it horizontally. Keep one worker so forecasts aren't frozen twice.

## Demo data

In demo mode an empty database is populated from `backend/data/demo_snapshot` on first start (see [DATA.md](DATA.md)). Set `USE_DEMO_SNAPSHOT=false` to regenerate the data with the simulator instead.

## Switching from demo to live data

1. Set provider keys and restart. `/api/status` reports `mode: live`, and provider health appears in Settings.
2. `python -m app.cli sync-rosters` verifies NBA rosters.
3. Import real historical results (Data Management → games with box-score columns), then `python -m app.cli train --league NBA` (and CBB). New models are tagged with their data source. Demo predictions remain in the archive, flagged `is_demo`, and can be filtered or exported separately.

## Observability

- Structured JSON logs on stdout, with `X-Response-Time-ms` on every response.
- `/api/health` for liveness, `/api/status` for mode, provider health, data freshness and active model versions.
- `provider_health` table: latency, errors and remaining request quota per provider call.
- `/api/data/quality`: integrity checks, including predictions with data timestamps after tip-off (should always be 0).

## Backups

Back up the Postgres database (predictions, settlements and picks are the irreplaceable records) and the `artifacts/` volume. Raw import files in `data/raw/` are content-addressed by SHA-256.
