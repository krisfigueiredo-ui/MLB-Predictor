# COURTSIDE IQ — AI Basketball Intelligence Terminal

NBA and NCAA men's basketball analytics: live scoreboard, league-specific machine-learning projections, Monte Carlo simulation, model-vs-sportsbook comparison, player-prop distributions, a trends lab, a permanent prediction archive with grading, a data import/cleaning centre, and a Claude-powered research assistant that cites the records it uses.

> Research software. Forecasts are probabilistic estimates, not guarantees. The platform never places wagers and nothing in it is betting or financial advice.

```
courtside-iq/
├── backend/            FastAPI · SQLAlchemy · LightGBM/CatBoost/XGBoost · SHAP · Optuna · Claude
│   ├── app/
│   │   ├── models.py          normalized schema (26 tables, provenance on every external row)
│   │   ├── registry/          30 NBA franchises, 83 D-I schools / 8 conferences, seed NBA roster
│   │   ├── providers/         BALLDONTLIE + The Odds API clients, rate limiting, retries, health, sync
│   │   ├── ml/                features (point-in-time), game model, props model, simulator, metrics
│   │   ├── services/          modeling, market math, settlement, performance, trends, diagnostics, demo feed
│   │   ├── data_mgmt/         import → map → clean → validate → quarantine → approve → commit; exports
│   │   ├── ai/                RAG (pgvector), read-only tools, Claude tool-use loop
│   │   ├── api/routes.py      REST + Server-Sent Events ticker
│   │   ├── scheduler.py       background refresh / forecast freezing / settlement
│   │   └── cli.py             operations CLI
│   ├── alembic/        migrations
│   └── tests/          32 tests (run on SQLite and PostgreSQL + pgvector)
├── frontend/           Next.js 15 · TypeScript · Tailwind · Radix (shadcn-style) · Framer Motion · ECharts · TanStack
└── docker-compose.yml  Postgres+pgvector, Redis, API, worker, web
```

## Quick start

### Docker (recommended)

```bash
cd courtside-iq
cp .env.example .env        # add provider / Anthropic keys if you have them
docker compose up --build
```

Web: http://localhost:3000 · API: http://localhost:8000/docs. First boot builds the demo dataset and trains both leagues' models (≈2 minutes) when no provider keys are set.

### Local development

```bash
# backend
cd courtside-iq/backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000        # SQLite by default (DATABASE_URL to override)

# frontend (second terminal)
cd courtside-iq/frontend
npm ci
npm run dev                                      # proxies /api/* to BACKEND_URL (default http://localhost:8000)
```

### Tests

```bash
cd backend && python -m pytest -q                                            # SQLite
TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost/courtside python -m pytest -q   # Postgres + pgvector (runs Alembic)
cd frontend && npm run typecheck && npm test && npm run build
```

CI (`.github/workflows/courtside-iq.yml`) runs the backend suite on both databases, the frontend typecheck/tests/build, and both Docker builds.

## Demo mode vs live mode

Without any provider key the platform runs in **demo mode** and says so everywhere: a top-bar banner, `DEMO` badges on every game, odds row, chart and model card, and `is_demo=true` on every row and export.

Demo data comes from a possession-level **league simulator** (`app/ml/synthetic.py`). It models latent team strength, pace, four factors, rest, travel, injuries, overtime, player game logs and a sharp synthetic betting market. It produces four NBA seasons and four college seasons of history, plus a 2026-27 season revealed in real time by `services/demo_feed.py`: games go live, scores advance, odds snapshots post on schedule and results settle. **Accuracy figures in demo mode describe performance on simulated basketball, not the real sport**, and models trained on it are tagged `data_source=synthetic_demo`.

With keys configured, the scheduler pulls real games, scores and odds, freezes forecasts as markets move, and settles them. Import real historical results in Data Management and retrain to replace the synthetic history.

## Data providers (verified against public docs)

| Provider | Env var | What is wired | Notes |
|---|---|---|---|
| BALLDONTLIE | `BALLDONTLIE_API_KEY` | `/v1/games?dates[]=` (live status, period, clock, scores), `/v1/players/active` (roster sync → `verified=true`), `/v1/stats`, `/v1/player_injuries`, `/ncaab/v1/games` | `Authorization: <key>` header. NCAAB and some endpoints need paid tiers; free tier is ~5 req/min (client limiter defaults to 60/min). |
| The Odds API v4 | `ODDS_API_KEY` | `/v4/sports/{basketball_nba,basketball_ncaab}/odds` (h2h, spreads, totals), `/events/{id}/odds` (`totals_h1`, `team_totals`, player props) | `x-requests-remaining` is tracked in provider health. Only bookmakers returned by the feed are shown (DraftKings, FanDuel, BetMGM, Caesars = `williamhill_us` by default). |
| SportsDataIO | `SPORTSDATAIO_API_KEY` | configuration + health only | Endpoint mapping depends on your subscription; left for a subscriber to complete. |

Rate limiting (token bucket), exponential backoff on 429/5xx, response caching (Redis or in-memory), and a `provider_health` log are in `providers/base.py`. Mapping onto the schema, with name-based team matching for both leagues, is in `providers/sync.py`; it's tested against recorded payload shapes.

## Identity: teams, schools, players, logos, portraits

- **Teams/schools**: all 30 NBA franchises (conference, division, arena, coordinates for travel) and 83 Division I programs in 8 conferences, including Miami, Duke, UNC, Kansas, Kentucky, Florida and West Virginia, with 2024-25 realignment. Colors are published team colors.
- **Players**: the NBA seed roster lists 48 real players with their **2025-26** teams. Rosters change, so every seeded membership is `verified=false` and shows a *seed roster · unverified* badge until `python -m app.cli sync-rosters` confirms it against BALLDONTLIE. A move closes the old membership and keeps its history. **No college players are bundled**: CBB rosters turn over every year and come only from a provider.
- **Logos**: NBA and NCAA marks are trademarks and are **not bundled**. Every crest is resolved through one asset registry (`assets` table + `TeamCrest`), so a team can only ever show its own mark. Without a licensed asset, an original crest is drawn from the team's colors and abbreviation. Register licensed assets in Settings → Asset registry, or point `LICENSED_LOGO_BASE_URL` at a licensed CDN.
- **Portraits**: illustrated likenesses of real athletes need publicity and image rights, so the app ships a consistent **original illustrated avatar** for each player: a stylized silhouette in the team's uniform colors with the verified jersey number. Licensed portraits registered in the asset registry replace it automatically.

## Modelling

**Features** (`ml/features.py`) are built strictly in chronological order. Each game's features come from team state *before* that game, and a test asserts that changing a later result never changes an earlier game's features. Feature families:
- opponent-adjusted offensive and defensive efficiency, pace, and both-ends four factors (eFG%, TOV%, ORB%, FTr)
- last-5/10 form, home and road splits, rest and back-to-backs, travel miles, pre-game injury impact, lineup changes, strength of schedule
- for CBB: conference strength, non-conference performance, neutral sites, roster continuity, and empirical-Bayes shrinkage toward a conference prior for small samples

**Game model** (`ml/game_model.py`), one per league:
1. A structural baseline: pace × opponent-adjusted points per possession.
2. LightGBM and CatBoost learn the residual on top of it; their average is the projection for margin, total and first-half total. XGBoost is trained as a benchmark only.
3. Monte Carlo: by default 10,000 draws from a bivariate normal on (margin, total), with SDs and correlation estimated on an out-of-sample calibration fold. Scores are integer-rounded, ties go to simulated overtime, and seeds are fixed per game.
4. Cover, push and over/under probabilities are counted from the draws; win probability is isotonic-calibrated.

**Market-informed probabilities.** The first walk-forward backtest showed spread probabilities averaging 61% but hitting 45%: the model was overconfident wherever it disagreed with the market. Spread and total probabilities now come from `w·model + (1−w)·market line`. `w` is fit by MSE on the calibration fold; the test fold is never used. The pure model line is still what's shown next to Vegas, and Model Intelligence reports model-only vs blended Brier, log loss and ECE side by side.

**Validation**: a 70/15/15 chronological train/calibration/test split plus four expanding-window walk-forward folds. Metrics: MAE, RMSE, Brier, log loss, ECE, hit rate with Wilson intervals, and reliability diagrams. Optuna tuning (`POST /api/models/tune`) uses a chronological validation fold. Model versions are kept, and MLflow logging switches on when `MLFLOW_TRACKING_URI` is set and `mlflow` is installed.

**Current demo results** (held-out test fold, synthetic data):

| League | n test | Margin MAE (ours / XGBoost / baseline) | Total MAE (ours / XGBoost / baseline) | Win Brier | ECE | Fitted w (spread, total) |
|---|---|---|---|---|---|---|
| NBA | 689 | 14.15 / 14.41 / 14.34 | 14.47 / 14.99 / 14.57 | 0.222 | 0.050 | 0.00, 0.00 |
| CBB | 485 | 11.09 / 11.33 / 11.24 | 11.88 / 12.24 / 11.94 | 0.223 | 0.032 | 0.08, 0.55 |

The ensemble beats both benchmarks, but the simulated market is sharp: for NBA spreads and totals the fitted weight on the model is ≈0. In other words, the model adds no information beyond the closing line, and the platform reports that rather than tuning it away. Real-data performance can only be known after real history is imported.

**Player props** (`ml/props_model.py`):
1. LightGBM predicts minutes from recent and season minutes, rest, blowout risk (|projected spread|), teammate injuries and sample size.
2. Per-minute rates are shrunk toward the season rate and adjusted for pace and opponent defense.
3. Negative Binomial draws share a game-flow multiplier, so points, assists and threes are positively correlated; PRA is summed per draw.

When a book line exists the mean is anchored 50/50 to the line. That weight is a documented prior, not a fitted value: there's no historical prop-line archive yet, and `details.model_only_mean` is archived so it can be refit later.

## Prediction archive and grading

- `predictions` is append-only. Every row stores its ID, timestamp, `data_as_of`, league, game, player, model version, market, selection, probability, line, price and sportsbook.
- Settlement writes a separate `settlements` row with the rule applied: moneyline includes OT, an exact landing is a push, first-half markets use first-half scores, and a prop on a player who didn't play is void.
- Performance only counts the latest forecast made **before tip-off** for each game, market and player.
- On first boot in demo mode, the current season is backfilled as a walk-forward backtest. The model is trained before the season starts, and market inputs are limited to snapshots ≥1 hour before tip, so closing lines never leak into earlier forecasts.
- Diagnostics aggregate errors: pace and total bias, margin bias, calibration by market, minutes surprises on props, conference errors, and injury-news splits. Each finding carries its sample size and a 2·SE test. Models are never changed automatically.

## Data Management

Upload CSV, XLSX or JSON for games, player logs, odds, predictions or picks. The pipeline:
1. Preserves the raw bytes with a SHA-256 hash.
2. Normalizes and maps columns through a synonym dictionary.
3. Coerces types, converts naive timestamps from a chosen time zone to UTC, and resolves teams, schools and players to registry IDs.
4. Checks for duplicates within the file and against the database, missing values, invalid or tied scores, probability ranges, decimal-vs-American odds, odds captured after tip-off, out-of-range player stats, and player–team affiliation conflicts.
5. Quarantines unresolved rows. Destructive fixes (dropping duplicates, rescaling percentages) wait for approval before commit, and every decision goes to `cleaning_log`.

Results show in a Data Quality Scorecard. Exports cover 10 datasets in CSV, styled XLSX (header styling, frozen panes, filters, number formats, README sheet) and JSON with licensing notes.

## COURTSIDE AI

`ai/assistant.py` runs a Messages API tool-use loop with `claude-opus-5-5`, effort `medium` and server-side refusal fallbacks. The loop is self-hosted because its 10 tools are **read-only** queries against this app's own database: projections with SHAP drivers, odds movement, efficiency tables, player trends, performance breakdowns, largest market disagreements, diagnostics, recent results, and document search.

Every tool result carries citations (table, ID, timestamp), and the system prompt forbids stating any number a tool didn't return. Retrieval uses pgvector cosine distance on Postgres (Python cosine on SQLite) over methodology docs and model cards. Embeddings are local feature-hashing, so no extra API is needed; `voyageai` is an optional upgrade. Set `ANTHROPIC_API_KEY` to enable it; without a key the panel shows a clear disabled state.

## Configuration

See `.env.example`. Secrets are read only on the server, and the browser never receives a key. Setting `ADMIN_TOKEN` protects retrain, tune, refresh and asset registration.

## What is blocked or out of scope here

- **Live data, real odds, prop lines, injuries and lineups**: wired and tested against payload shapes, but they need your BALLDONTLIE and The Odds API subscriptions. NCAAB live data needs a BALLDONTLIE tier with NCAAB access.
- **Official logos and real-likeness portraits**: need licenses from the NBA, schools or rights holders; the registry is ready for them.
- **COURTSIDE AI answers**: need an Anthropic API key. The tool loop, citations and refusal handling are covered by tests with a mocked client.
- **Shot charts**: need shot coordinates from a provider that supplies them; none of the integrated feeds do on standard tiers.
- **PyMC**: the CBB small-sample problem uses conjugate empirical-Bayes shrinkage. Full PyMC models are an optional extra (`requirements-optional.txt`).
- **Authentication**: the app targets single-user or self-hosted deployments, and mutating admin endpoints are token-protected. Put it behind your SSO or reverse proxy for multi-user use.

See `docs/DEPLOYMENT.md` for production deployment.
