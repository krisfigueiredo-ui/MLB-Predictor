# Diamond Signal

Diamond Signal is a browser-based MLB intelligence and model-audit workspace. It combines a feature-weighted logistic model, a Poisson run model, and Elo ratings; compares forecasts with verified market prices; freezes point-in-time predictions; and provides an immersive, park-specific view of the selected home venue.

**Live application:** https://krisfigueiredo-ui.github.io/MLB-Predictor/

> Research and paper-trading software only. It does not promise predictive accuracy or investment returns.

## Product structure

- **Slate** — a dense, sortable baseball board with compact mobile rows, model probability, market state, projected runs, source coverage, and a persistent desktop matchup inspector.
- **Live** — active and completed games with score, inning, count, outs, base occupancy, live win-probability context, and the latest verified moment once a game feed is loaded.
- **Picks** — ranked upcoming selections, frozen pregame probabilities, live tracking, explicit outcomes, and historical result windows backed only by stored prediction records.
- **Standings** — MLB, league, and wild-card boards with division position, home/road records, last 10, streak, games back, and run differential.
- **Players** — an on-demand directory populated from verified game rosters. Player drawers show bio, core season batting or pitching, recent hitting windows, and explicit unavailable states for unsupported advanced fields.
- **Teams** — a club workspace for standings context, season offense, season pitching, current provider-returned availability, and today’s matchup.
- **Game** — a full research workspace with Overview, Lineups, Matchup, Ballpark, Play-by-play, Moments, Model, and Market modes. Confirmed orders, bench/bullpen roles, verified events, and derived win-probability swings stay attached to the selected matchup.
- **Ballpark Live** — a canvas-first, park-specific Three.js broadcast view with occupied stands, regulation-scale field geometry, eight camera presets, score and win-probability overlays, an event timeline, and a 2D SVG fallback.
- **Model** — a research-led pipeline view with prospective metrics, raw-versus-calibrated output, model dispersion, rolling-origin methodology, shadow-model status, and feature-ablation readiness.
- **Performance** — a chart-led research view with selectable rolling metrics, calibration bands, bankroll curve, model-version comparison, and the paper-trading log.
- **Market** — verified moneyline coverage, edge comparison, Kelly sizing, paper P/L, CLV readiness, and downloadable records. Risk controls live in one settings drawer.
- **Data** — feed coverage, provenance, immutable prediction snapshots, legacy-history labeling, and snapshot export.

## Modeling and validation

The production probability remains separate from experimental shadow output. A three-model shadow path combines available Elo, Poisson, and feature probabilities, reports base-model dispersion, then applies a simple calibration shrinkage fitted only on prior graded snapshots. It does not silently promote itself over the published model.

The primary validation utilities use rolling-origin splits:

1. Sort games chronologically.
2. Fit normalization and logistic weights on the earlier window.
3. Evaluate only on the later unseen window.
4. Advance the cutoff and repeat.
5. Report accuracy, Brier score, log loss, ROC-AUC, and ECE.

Randomized cross-validation remains visible only as a legacy educational comparison. Existing history without complete pregame features is labeled `LEGACY` and is not mixed into prospective claims.

### Diamond Signal Score

The Picks page uses a deterministic 0–10 ranking score. It does not change the underlying game probability.

- With a verified market: 32% market edge, 20% model confidence, 20% base-model agreement, 18% data quality, and 10% starting-pitching contribution.
- Without a market: 36% model confidence, 28% agreement, 24% data quality, and 12% starting pitching.

Each input is normalized and capped to 0–1 before weighting. A missing moneyline cannot create an edge or qualify a wager.

### Point-in-time snapshots

The first verified pregame view is stored immediately as a deeply immutable snapshot containing:

- model, weight, and calibration versions;
- training cutoff and prediction timestamp;
- raw, calibrated, published, Elo, Poisson, and feature probabilities;
- raw features and weighted contributions;
- data-quality flags and the available market record;
- selected side, selected-side probability, projected score, Signal Score components, starters, and lineup state;
- matchup and first-pitch identifiers.

The record is graded only after a verified final score. The original analytical inputs are never recomputed with present-day data. Snapshots can be downloaded from the Data page.

## Ballpark architecture

The 3D bundle is requested only after the user enters Ballpark Live. One scene unit equals one foot: bases are 90 feet apart, the mound is 60.5 feet from home, and player figures are approximately six feet tall. Shared primitives create field surfaces, wall segments, seating decks, scoreboards, landmarks, crowds, players, and overlays, while each of the 30 parks supplies a separate assembly, outfield profile, seating plan, scoreboard placement, bullpen, batter eye, camera framing, and environmental treatment.

All 30 clubs resolve to a validated, uniquely fingerprinted assembly. Signature configurations explicitly preserve Fenway's Monster and deep-center kink, Yankee Stadium's short right field and center-field monuments, Wrigley's ivy/bleachers/manual board, Citizens Bank Park's Monty's Angle and Liberty Bell, Oracle Park's Triples Alley and cove, PNC Park's two-deck river opening, and Petco Park's Western Metal building.

Quality modes are High, Medium, and Low, with Low selected automatically on mobile. If Three.js, WebGL, or the CDN is unavailable, the same game renders as an analytical SVG field while the score, game state, probability, timeline, and provenance remain accessible as HTML.

## Data policy

Live schedules, scores, posted starters, standings, lineups, player/team season statistics, play-by-play, injuries, weather, odds, and pitch locations are displayed only when a source returns them. Unavailable model inputs stay neutral and render as `—`. The application does not manufacture betting lines, players, lineups, injuries, bullpen fatigue, umpire assignments, weather, pitch movement, hit trajectories, advanced metrics, or historical snapshots.

MLB game feeds are normalized into stable game, lineup, player, play, moment, and win-probability records in `js/data/baseball-intel.js`. The client in `js/data/mlb-intel-client.js` caches verified standings, game feeds, player stats, and team stats for the current browser session. Win-probability points are clearly labeled as local derivatives of the frozen pregame model plus verified inning and score state; they are not represented as an MLB-provided metric.

The app first requests official ESPN and MLB endpoints directly or through the included same-origin development server. Some browser-only paths retain third-party CORS relay fallbacks for availability; source status and provenance remain visible, and relay responses are still parsed as the original provider's payload. No API key is required.

## Run locally

The application is static and has no build step.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. A local HTTP server is recommended because browsers commonly restrict feed requests from `file://` pages.

## Development

```bash
npm install
npm test
```

The test suite currently contains **218 tests across 16 files**. It covers the existing prediction, Elo, Poisson, betting, calibration, persistence, injury, situational, ESPN parsing, and training modules plus the probability pipeline, rolling-origin validation, prior-only calibration, immutable snapshots, lineup/player/play normalization, recent-form aggregation, standings honesty, signal ranking, 30 explicit stadium assemblies, responsive application shell, deployment packaging, and 2D fallback. The required browser review captures are indexed in [Visual QA](docs/VISUAL-QA.md).

Key directories:

```text
css/             Diamond Signal tokens, shell, page layouts, motion, and responsive modes
js/data/         Snapshot schema plus MLB standings/game/player/team adapters
js/model/        Ensemble, calibration, walk-forward validation, ablation
js/three/        Park-owned assemblies and shared stadium construction primitives
js/ui/           Slate, Live, Picks, Standings, Players, Teams, Game, Model, Performance, Data, and Ballpark views
tests/           Vitest coverage for original and rebuilt modules
```

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system map and [VALIDATION.md](docs/VALIDATION.md) for the methodology audit, known limitations, and forward-validation plan.

## Deployment

Every push to `main` runs unit tests and packages `index.html`, `css/`, and the complete `js/` tree for GitHub Pages. The Three.js module remains external and lazy-loaded from a pinned CDN version.
