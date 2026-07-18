# MLB Predictor

A single-page MLB game-prediction dashboard: it blends an Elo rating engine, a Poisson run model,
and a feature-weighted logistic model into daily win probabilities, compares them against real
betting lines, and grades itself honestly against real results.

**Live site:** https://krisfigueiredo-ui.github.io/MLB-Predictor/

> Paper analysis only — not betting advice. The betting tools track *paper* stakes against real
> lines to measure whether the model's edge is real. No accuracy or ROI is promised.

## What it does

- **Daily slate** — win probability for every MLB game on today's schedule (live ESPN data when
  reachable, built-in fallback schedule otherwise), with starting pitchers, park factors, injuries,
  weather, and situational trends factored in.
- **Ensemble model** — a logistic blend of ~19 features (Elo, power ratings, pitcher quality,
  home/away splits, Pythagorean expectation, recent form, rest, head-to-head, …) combined with an
  independent Poisson run model. Honesty gates keep synthesized or pseudo-random inputs (fake
  bullpen fatigue, projected umpires, invented weather splits) from ever voting.
- **Self-training** — online gradient descent after each real result, plus a batch trainer
  (logistic regression with train/test split and 5-fold cross-validation) over the backtest store.
- **Model health** — calibration curve, Brier decomposition, ECE, sharpness, ROC-AUC, and a
  recalibration (shrink) tool.
- **Betting tools** — edge detection vs real moneylines (4% minimum), Kelly stake sizing, a parlay
  builder, paper-trading P/L tracking, and closing-line-value measurement.
- **Live mode** — in-game win probability, leverage index, and fair-line comparison while games
  are in progress.

## Running it

It's a static site — no build step.

```bash
# any static server works; from the repo root:
python3 -m http.server 8000
# then open http://localhost:8000/
```

Opening `index.html` directly as a `file://` URL also works, but the browser will block live ESPN
requests (CORS), so you'll see the built-in fallback schedule instead of today's real games.

Deploys happen automatically: every push to `main` publishes `index.html` + `js/` to GitHub Pages
via `.github/workflows/pages.yml`.

## Development

The prediction/betting/ML math lives in small, tested modules under `js/`, loaded by `index.html`
as plain script tags and imported directly by the test suite:

| Module | What's in it |
|---|---|
| `js/predict-core.js` | Core prediction math: stat regression/clamping, Pythagorean expectation, logit combine |
| `js/elo.js` | Elo seeding, ratings → win probability, margin-of-victory updates |
| `js/poisson.js` | Poisson run model (PMF, pitcher suppression, win-probability core) |
| `js/ml-train.js` | Logistic regression trainer, standardization, ROC-AUC, cross-validation metrics |
| `js/calibration.js` | Wilson CI, log loss, Brier/ECE/sharpness calibration report |
| `js/betting.js` | Odds conversion, Kelly staking, bet-edge threshold rule |
| `js/situational.js` | Recent form, streaks, venue splits, point-in-time date filtering |
| `js/injuries.js` | Injury-report classification and capped win-probability impact |
| `js/espn-parse.js` | ESPN scoreboard/odds/pitcher/record response parsing |
| `js/persistence.js` | localStorage schema migration and corrupt-data handling |

```bash
npm install
npm test        # 179 unit tests (Vitest); also runs in CI on every push/PR
```

`TEST_COVERAGE_ANALYSIS.md` documents the testing effort, the nine real bugs it found (including
two ML-methodology issues: standardization leakage in the batch trainer, and the online learner
training weights on features that never voted), and the known remaining limitation (backtest
grading uses current-day team tables rather than point-in-time snapshots — flagged in the UI).

## Data sources

ESPN public scoreboard/standings/injury feeds (fetched from the browser, with public CORS relays
as fallback) and the MLB Stats API for platoon/day-night splits. All free, no keys required.
