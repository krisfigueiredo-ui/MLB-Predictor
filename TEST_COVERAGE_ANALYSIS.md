# Test Coverage Analysis — MLB Predictor

## Progress so far

Started from 0% with no test infrastructure at all — no `package.json`, no test runner, no CI, nothing.
Since then:

- Added Vitest + `npm test` + a GitHub Actions workflow (`.github/workflows/test.yml`) that runs the
  suite on every push/PR.
- Extracted the pure math underlying every high-risk area — including the core `predictFull` logit
  blend and the `learnFromGame` online-learning step — out of the monolithic inline `<script>` into 10
  standalone, importable modules under `js/`, each loaded via `<script src>` right before the main
  script so the browser build's behavior doesn't change. Every extraction was verified three ways: a
  Node syntax check of the remaining inline script, a real headless-Chromium load (Playwright)
  asserting the page still renders `GAMES30`/computes predictions with zero console/page errors, and
  for the riskiest one (`predictFull`) a byte-for-byte before/after diff of its output across every game
  in `GAMES30`.
- **179 unit tests, all passing**, across 11 modules:
  - `js/betting.js` — odds conversion, Kelly staking, the shared bet-edge-threshold rule (17 tests)
  - `js/calibration.js` — Wilson CI, log loss, Brier/ECE/BSS decomposition (12 tests)
  - `js/poisson.js` — Poisson PMF, pitcher suppression, win-probability core (13 tests)
  - `js/elo.js` — Elo seeding, ratings→win-prob, margin-of-victory rating change (12 tests)
  - `js/situational.js` — recent form/streaks/venue splits, recency-weighted form decay, the
    point-in-time date filter (23 tests)
  - `js/injuries.js` — star-tier matching, out-status classification, injury impact (11 tests)
  - `js/persistence.js` — schema migration / corrupt-JSON handling for weights + backtest store (10 tests)
  - `js/espn-parse.js` — team-abbreviation mapping, weather/odds/pitcher/record parsing from real
    ESPN response shapes (25 tests)
  - `js/predict-core.js` — pitcher-stat regression/clamping, W-L record parsing, Pythagorean win
    expectation, the final logit→probability combine step, and the online-learning gradient-input
    computation (32 tests)
  - `js/ml-train.js` — standardization, batch logistic regression, ROC-AUC/ROC curve, confusion-matrix
    precision/recall/F1 (24 tests)

## Machine-learning-focused pass

After the initial coverage push, focus shifted specifically to the ML/data-quality side: the
"Model Training" tab's batch logistic regression (`trainModel`), k-fold cross-validation
(`crossValidate`), and the learning-curve tool (`learningCurve`) — previously untested and, it turned
out, hiding a real methodology bug plus a much bigger structural one.

### Bug: data leakage in `trainModel()`'s train/test split

`trainModel()` computed feature standardization (mean/std) on the **full** dataset, then split into
train/test and used those same full-dataset statistics for both. That's textbook leakage: the held-out
test set's own feature distribution influenced how training features were scaled, biasing the reported
"honest out-of-sample eval" optimistic. `crossValidate()` already did this correctly (fit on each fold's
train split only, per its own comment) — `trainModel` was the one path that didn't match. Fixed by moving
the split before standardization; `crossValidate`/`learningCurve` were already correct and are now
sharing the same tested `js/ml-train.js` primitives instead of three separately hand-rolled copies of the
same gradient-descent loop.

### Bigger finding: look-ahead bias in backtest grading (partially fixed, mostly documented)

While tracing how `trainModel`'s `g.feat`/`g.y` training examples get created (`loadBacktest`), found
something more significant: grading a historical game calls `predictFull` using **today's** `TEAM_SPLITS`
(win/loss record, home/away split, L10), `ELO` ratings, `H2H`, `PVT`, and `INJURIES` — not a snapshot of
what those looked like as of that game's actual date. Since those tables reflect the full season to date,
grading a game from 3 weeks ago still sees standings and Elo ratings shaped by everything that happened
*after* it. That inflates every accuracy/AUC/calibration number the app computes from backtest data
(win-rate tracking, `crossValidate`, `calibrationReport`) versus what the model would actually achieve
predicting forward in real time.

This is a genuinely different class of problem than everything else found in this pass — not a
localized formula bug, but a mismatch between the data architecture (single current-state tables) and
what point-in-time backtesting requires (historical snapshots). A full fix means storing
`TEAM_SPLITS`/`ELO`/`H2H`/`PVT`/`INJURIES` as they stood on every date in range, which the free ESPN feeds
mostly don't expose for arbitrary past dates anyway. That's a real architecture project, not a bug fix —
so rather than attempt a partial rewrite that might create false confidence, the response here was:

1. **Fixed the one channel that was actually tractable**: `recencyForm` (the recency-weighted run-diff
   signal) is built from a team's own per-game-dated log, which the app already has for every backtest
   game. Added an optional `beforeDate` cutoff threaded through `teamGameLog` → `recencyForm` →
   `predictFull`, and wired `loadBacktest` to pass each graded game's own date. Verified in a browser with
   a synthetic team on a hot streak through 6/6 then a cold streak from 6/10 on: grading a game as of 6/10
   now correctly reads "maximally hot" (all that had happened by then), instead of being diluted/reversed
   by the future cold streak. Regression-tested in `js/situational.js` (`filterBeforeDate`).
   `gameSituational`/`withSit` turned out not to be called during backtest grading at all, so they weren't
   in scope for this fix.
2. **Documented the rest plainly rather than pretending it's fixed**: a code comment at the `predictFull`
   call site in `loadBacktest` naming exactly which tables still leak, and a visible disclaimer banner on
   the Model tab (next to the training/CV results) telling users the accuracy/AUC numbers are an upper
   bound, not a live-performance guarantee. This matches the codebase's own existing "HONESTY GATE"
   culture (the `wxWinPct`/umpire-feature disclaimers already there) rather than introducing a new pattern.

### Real bugs found and fixed along the way

1. **`learnFromGame` was training weights on features that never voted** (`js/predict-core.js`,
   `learningRawFeatures`). This is the big one. `predictFull` only lets `xfip`/`whip` vote when both
   pitchers have a real ERA/WHIP overlay (`realQ`), only lets `xwoba`/`barrel` vote when both have
   curated-DB data (`realX`), and permanently zeroes `bullpen` "fatigue" (explicitly pseudo-random per
   its own comment). But the online-learning step computed gradients for all of these from whatever
   values happened to be on the pitcher object regardless of those gates — and since `genPitcher`'s
   default output is `realQ:false, realX:false`, that meant most graded (ESPN-built, non-curated) games
   were training `xfip`/`whip`/`xwoba`/`barrel`/`bullpen` on synthetic, PWR-derived noise that had zero
   influence on the very prediction being graded. This directly matches the kind of instability the
   repo's own prior "Fix model overfitting" commit was patching around — `STEP_CAP_FRAC`/`L2_ONLINE`
   dampen the *symptom* of noisy weight swings; this was a root cause. Verified in a real browser: a
   curated game with real pitcher data updates `xfip`/`whip`/`xwoba`/`barrel` as before; a fully
   synthetic game now only updates `power`/`elo`/`park` (previously it also moved
   `xfip`/`whip`/`xwoba`/`barrel`/`bullpen`).
2. **Sharpness metric was measuring the wrong thing** (`js/calibration.js`). The "Model Health" tab
   labels a stat "Sharpness — spread from 50/50", but the code computed standard deviation around the
   sample's *own mean* prediction, not distance from 0.5. A model that's always confidently at ~90% has
   zero spread around its own mean, so it silently reported ~0 sharpness (looking timid) instead of ~0.4
   (maximally bold). Fixed to measure RMS distance from 0.5 as documented and labeled.
3. **Voided games were leaking into Elo as fake ties** (`buildElo`, now `js/elo.js` + inline glue). The
   backtest-store branch was missing the `hs!==as` guard that the user-history branch already had. The
   app's own stated rule elsewhere is that an equal-score "final" means the game was postponed/
   suspended and never really happened — but such an entry would still get replayed into Elo as a tie
   (`homeWon=0.5`), quietly nudging both teams' ratings from a game that didn't occur.
4. **`"Illness"` was misclassified as an injured-list absence** (`js/injuries.js`). The out-status check
   used `status.indexOf("il")===0`, a bare prefix match meant to catch abbreviated statuses like
   `"IL-10"`/`"IL"`. It also matches any status starting with those two letters — including `"Illness"`
   — even though the code's own comment says only out/IL/suspended should count, not day-to-day. A
   sick-but-possibly-playing star was being silently treated as unavailable, docking that team's win
   probability (and its bet edge) for no real reason. Fixed with a word-boundary check.
5. **Data leakage in `trainModel()`'s standardization** and **look-ahead bias in backtest grading** — see
   the "Machine-learning-focused pass" section above for the full writeup.

### Other cleanups

- De-duplicated the "does either side clear the betting edge threshold" rule, which was hand-copied
  identically across **5** call sites (not 4, as first estimated — a 5th turned up in `applyTrained`),
  into one tested `pickBetSide()` function.
- Removed a dead, name-colliding inline `pitchSuppress(sp,side)` wrapper that had no remaining callers
  after `poissonModel` started calling the extracted core directly — left in place, it would have
  silently shadowed the real `js/poisson.js` export instead of erroring.
- Removed a genuinely dead `ESPN_ABBR` lookup table with zero readers anywhere in the file
  (`ourAbbrFromEspn` has always used its own separate reverse map).

## What's left

### 1. Point-in-time data architecture — the biggest remaining item, and it's not a small one
As described above: `TEAM_SPLITS`/`ELO`/`H2H`/`PVT`/`INJURIES` all reflect "right now," not "as of the
date being graded." `recencyForm` is fixed; the rest aren't, and can't be without either (a) an
ESPN-independent historical-standings/injury archive, or (b) storing daily snapshots of these tables
going forward so future backtests at least don't leak *recent* history (older backtest runs would still
be affected retroactively). This is a genuine product/architecture decision, not something to just
patch — flagged prominently (code comment + UI disclaimer) rather than half-fixed.

### 2. Rendering / DOM — the only sizable *testing* gap remaining
`renderCalib`, `renderToday`, `strikeZoneSVG`, `logoBox`, etc. Canvas/DOM-heavy, changes often for
cosmetic reasons, and genuinely lower value to unit-test than the math was. A handful of jsdom or
Playwright smoke tests (tab switching works, a game card renders without throwing, toggling situational
factors re-renders) would cover this better than unit tests — deliberately not attempted yet.

### 2. `umpTeamFit` / `wxCategory` — display-only, low priority
Confirmed while working on `predictFull`: the umpire feature is permanently gated to 0 in the actual
model (`c.ump=0`, explicit "HONESTY GATE" comment — real umpire assignments aren't in the free feeds,
so a randomly-projected one contributes nothing to any prediction). `umpTeamFit` only generates display
narrative text, never a number that reaches a prediction or a bet. Not extracted/tested — the ROI here
is much lower than everywhere else covered above.

## Small items noticed but intentionally left alone

- `wxWinPct` always returns `null` behind an explicit "HONESTY GATE" comment (the underlying `WX_PERF`
  table was fabricated, never measured) — intentional, not a bug. The dead `WX_PERF` table and the 3
  call sites that depend on `wxCategory`+`wxWinPct` together are vestigial as a result, but removing them
  is a product decision (re-enable with real data vs. delete), not a test-coverage concern.
- `poissonModel(home,away,sp,gid)` and `gameSituational(home,away,startMs)` both carry a parameter
  (`gid`, `startMs` respectively) that's accepted but never read in the body — harmless, not fixed,
  noted here in case it's a sign a caller expected them to matter.

## If more time goes into this

The math is now well-covered; the marginal next step would be a small jsdom/Playwright smoke-test layer
for the rendering path (tab nav, game-card render, toggle-and-rerender), plus wiring a real ESPN sample
payload (saved once, checked in as a fixture) through `buildGamesFromESPN` end-to-end as an integration
test on top of the already-tested parsing units.
