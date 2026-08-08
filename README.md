# Diamond Signal

Diamond Signal is a browser-based MLB intelligence and model-audit workspace. It combines a feature-weighted logistic model, a Poisson run model, and Elo ratings; compares forecasts with verified market prices; freezes point-in-time predictions; and provides an immersive procedural view of the selected home park.

**Live application:** https://krisfigueiredo-ui.github.io/MLB-Predictor/

> Research and paper-trading software only. It does not promise predictive accuracy or investment returns.

## Product structure

- **Slate** — a compact, sortable daily table with model probability, market probability, edge, projected runs, source coverage, and a persistent matchup inspector.
- **Game** — matchup evidence, feature contributions, base-model disagreement, probability flow, a non-destructive Model Lab, and measured pitch locations when available.
- **Ballpark** — lazy-loaded park-specific Three.js geometry, low-poly spectators and players, six camera presets, live score and win-probability overlays, an event timeline, and a 2D SVG fallback.
- **Model** — prospective metrics, raw-versus-calibrated output, model dispersion, rolling-origin methodology, shadow-model status, and feature-ablation readiness.
- **Performance** — forward snapshot metrics, calibration bands, bankroll curve, model-version comparison, and the paper-trading log.
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

### Point-in-time snapshots

Within 30 minutes of a verified first pitch, the browser stores a deeply immutable snapshot containing:

- model, weight, and calibration versions;
- training cutoff and prediction timestamp;
- raw, calibrated, published, Elo, Poisson, and feature probabilities;
- raw features and weighted contributions;
- data-quality flags and the available market record;
- matchup and first-pitch identifiers.

The record is graded only after a verified final score. The original analytical inputs are never recomputed with present-day data. Snapshots can be downloaded from the Data page.

## Ballpark architecture

The 3D bundle is requested only after the user enters Ballpark. Shared procedural components create the diamond, bases, grass, foul lines, walls, warning track, seating, crowd, stylized players, defensive overlays, and scoreboard. The crowd uses instanced heads, torsos, and arms; players use recognizable baseball silhouettes instead of position cylinders. The renderer draws only when a view changes or a pitch animation is active, pauses when hidden or outside the viewport, and disposes GPU resources on exit.

Six parks include detailed wall profiles:

- Fenway Park
- Yankee Stadium
- Wrigley Field
- Dodger Stadium
- Great American Ball Park
- Rogers Centre

Every other club receives a named home-park profile with its own corner and center-field distances, surface/roof context, distinctive architectural cue, and official club ballpark link. The visualization is an original stylized broadcast model rather than a photogrammetric replica. Intermediate wall segments remain procedural. Pitch endpoints come from the MLB live feed; the connecting 3D arc is labeled as a derived interpolation.

Quality modes are High, Medium, and Low, with Low selected automatically on mobile. If Three.js, WebGL, or the CDN is unavailable, the same game renders as an analytical SVG field while the score, game state, probability, timeline, and provenance remain accessible as HTML.

## Data policy

Live schedules, scores, posted starters, standings, injuries, weather, odds, and pitch locations are displayed only when a source returns them. Unavailable model inputs stay neutral and render as `—`. The application does not manufacture betting lines, injuries, bullpen fatigue, umpire assignments, weather, pitch movement, hit trajectories, or historical snapshots.

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

The test suite currently contains **212 tests across 15 files**. It covers the existing prediction, Elo, Poisson, betting, calibration, persistence, injury, situational, ESPN parsing, and training modules plus the probability pipeline, rolling-origin validation, prior-only calibration, immutable snapshots, all-club stadium resolution, responsive application shell, deployment packaging, and 2D fallback.

Key directories:

```text
css/             Diamond Signal tokens, shell, page layouts, motion, and responsive modes
js/data/         Point-in-time snapshot schema and migration helpers
js/model/        Ensemble, calibration, walk-forward validation, ablation
js/three/        Stadium configurations and lazy procedural renderer
js/ui/           Slate, Game, Model, Performance, Data, and Ballpark views
tests/           Vitest coverage for original and rebuilt modules
```

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system map and [VALIDATION.md](docs/VALIDATION.md) for the methodology audit, known limitations, and forward-validation plan.

## Deployment

Every push to `main` runs unit tests and packages `index.html`, `css/`, and the complete `js/` tree for GitHub Pages. The Three.js module remains external and lazy-loaded from a pinned CDN version.
