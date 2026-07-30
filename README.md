# MLB Predictor

Two dashboards live in this repo:

| App | What it is |
|---|---|
| [`index.html`](index.html) | **MLB Predictor** — the original single-sport dashboard, with pitcher-level detail |
| [`sports.html`](sports.html) | **All-Sports Predictor** — every league on the ESPN API, with live win probability, news, and per-league backtested models |

A single-page MLB game-prediction dashboard: it blends an Elo rating engine, a Poisson run model,
and a feature-weighted logistic model into daily win probabilities, compares them against real
betting lines, and grades itself honestly against real results.

**Live site:** https://krisfigueiredo-ui.github.io/MLB-Predictor/
(all-sports dashboard: https://krisfigueiredo-ui.github.io/MLB-Predictor/sports.html)

> Paper analysis only — not betting advice. The betting tools track *paper* stakes against real
> lines to measure whether the model's edge is real. No accuracy or ROI is promised.

## What it does

- **Daily slate** — win probability for games returned by the verified ESPN scoreboard feed, with
  verified starters, standings, injuries, weather, and real market lines added when available.
  No substitute schedule, projected score, or manufactured betting line is shown when a feed fails.
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
- **Portable log** — completed predictions are stored locally and can be downloaded as CSV or as a
  restorable JSON backup from the Log tab.

## Running it

It's a static site — no build step.

```bash
# any static server works; from the repo root:
python3 -m http.server 8000
# then open http://localhost:8000/
```

Opening `index.html` directly as a `file://` URL is not recommended because browsers can block live
data requests. When the official feed is unavailable, the dashboard shows a clear unavailable-data
state and retries automatically; it does not display sample games.

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
npm test        # runs the whole repo suite (Vitest); also runs in CI on every push/PR
```

The MLB modules above account for 185 of those tests; the rest cover the all-sports app documented
below.

`TEST_COVERAGE_ANALYSIS.md` documents the testing effort, the nine real bugs it found (including
two ML-methodology issues: standardization leakage in the batch trainer, and the online learner
training weights on features that never voted), and the known remaining limitation (backtest
grading uses current-day team tables rather than point-in-time snapshots — flagged in the UI).

## Data sources

ESPN public scoreboard, standings, and injury feeds (requested directly, with an optional
same-origin development proxy) plus the MLB Stats API for supported splits. Third-party CORS
relays and substitute datasets are not used. No API keys are required.

---

# All-Sports Predictor (`sports.html`)

Every sport ESPN publishes, in one dashboard: ratings, per-league backtested models, live
play-by-play win probability, and a merged news feed.

**Live site:** https://krisfigueiredo-ui.github.io/MLB-Predictor/sports.html

> Paper analysis only — not betting advice. Probabilities come from ratings and models fitted to
> whatever history the ESPN feed returns. No accuracy or return is promised.

## What it does

- **Every league, including out-of-season ones.** A curated catalog of ~170 leagues across 17
  sports ships with tuned priors (home advantage, Elo K, expected scoring). On load the app also
  reads ESPN's own sport/league directory and merges in anything it didn't already know, so leagues
  ESPN adds later appear without a code change. When a league has no fixtures today, ESPN's
  calendar is used to jump to the next matchday, and carried-over power ratings are shown instead
  of a blank page.
- **A model per competition kind**, because "who wins" means different things per sport:

  | Kind | Sports | Model |
  |---|---|---|
  | Two-team | NBA, NFL, MLB, NHL, college, … | Elo prior blended with a logistic model on 12 features |
  | Draw possible | soccer, rugby, field hockey | Davidson three-way + bivariate Poisson (Dixon-Coles) for 1X2, BTTS, totals, correct score |
  | Head-to-head | tennis, MMA, boxing | Tennis runs a full point → game → set → match hierarchy driven off the rating gap |
  | Field event | golf, F1, NASCAR, IndyCar | Plackett-Luce over entrant ratings, with seeded-simulation top-5/top-10 |

- **Live play analysis.** In-game win probability after every play, charted against ESPN's own line
  where they publish one, plus leverage ("how much would the next score swing this?"), momentum
  over the last N plays, a ranked biggest-swings list, and the full play feed. The in-game model
  is sport-specific: a Brownian bridge on the margin for clock sports, a Poisson race over the
  minutes remaining for soccer, and a negative-binomial run model over the innings remaining
  (with base-out run expectancy, and an exact walk-off path) for baseball.
- **Backtesting that doesn't cheat.** Completed games over the chosen window are replayed in date
  order; each game's features are built from state containing *only earlier games*, and the result
  is folded in afterwards. Train/test is chronological, standardization is fitted on the training
  slice alone, and there is an expanding-window walk-forward evaluation alongside the single split.
- **A model that has to earn its vote.** The fitted logistic model is only blended into the Elo
  prior if it beat Elo-alone on held-out data; otherwise it gets zero weight and the UI says so.
- **News feed** merged across the leagues of the current sport, deduped by id and by normalised
  headline (the same wire story appears under several leagues), grouped into Today / Yesterday /
  Earlier.
- **Logos, crests and flags** for teams, leagues and countries. Each image carries an ordered list
  of ESPN CDN candidates and walks it on error, ending at a generated inline-SVG monogram — so a
  missing crest degrades to a clean lettermark rather than a broken image.

## Honesty properties

These are deliberate, and visible in the UI:

- Every request the app makes is logged in the footer with its outcome. A failed feed produces an
  explicit "the feed did not return" state, never a substitute slate.
- Calibration is measured on picked-side confidence over held-out games, and the shrink factor it
  suggests is applied to predictions.
- Confidence labels state how many prior games actually back each matchup.
- The paper-betting backtest runs on held-out games only, at a 4% minimum edge, and reports zero
  bets rather than inventing a line when ESPN carried no moneyline.

## Known limitations

- Backtest depth is whatever the ESPN scoreboard returns for the window; a thinly covered league
  trains on thin data, and the counts on the Model tab say so.
- Play-by-play exists for the US majors and little else — the win-probability chart falls back to
  a clear "no play list" message for leagues ESPN covers with scores only.
- Field events (golf, motorsport) rate entrants from head-to-head-style Elo over the loaded window,
  which is a weaker signal than a proper strokes-gained or lap-time model.
- Per-play baseball win probability is evaluated at the start of each half-inning, because ESPN
  does not carry base-out state on individual plays.

## Modules

| Module | What's in it |
|---|---|
| `js/ms-leagues.js` | League catalog, ESPN endpoint builders, runtime league discovery |
| `js/ms-espn.js` | Sport-agnostic scoreboard/event/odds/news/standings/season parsing |
| `js/ms-logos.js` | Team/league/country image candidate chains, inline-SVG monogram fallback |
| `js/ms-ratings.js` | Elo, Davidson three-way, Poisson/Dixon-Coles goals, tennis hierarchy, Plackett-Luce, odds maths |
| `js/ms-features.js` | Point-in-time team state and the 12-feature vector |
| `js/ms-backtest.js` | Leak-free replay, chronological/walk-forward splits, grading, paper-bet backtest |
| `js/ms-model.js` | Per-league train/predict/persist, blending, market edges |
| `js/ms-live.js` | Live situation/plays parsing and the in-game win-probability models |
| `js/ms-news.js` | Multi-league news merge, dedupe, grouping |
| `js/ms-app.js` | Dashboard shell: fetching, state, rendering, SVG charts |

```bash
npm install
npm test        # 519 unit tests across both apps
```
