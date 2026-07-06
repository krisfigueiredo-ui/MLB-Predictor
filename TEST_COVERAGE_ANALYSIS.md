# Test Coverage Analysis — MLB Predictor

## Progress so far

Started from 0% with no test infrastructure at all. Since then:

- Added Vitest + `npm test` + a GitHub Actions workflow (`.github/workflows/test.yml`) that runs the
  suite on every push/PR.
- Extracted the pure math underlying the highest-risk areas out of the monolithic inline `<script>`
  into standalone, importable modules under `js/`, each loaded via `<script src>` right before the main
  script so the browser build's behavior doesn't change. Each extraction was verified two ways: a Node
  syntax check of the remaining inline script, and a real headless-Chromium load (Playwright) asserting
  the page still renders `GAMES30` and computes predictions with zero console/page errors.
- **107 unit tests, all passing**, across 6 modules:
  - `js/betting.js` — odds conversion, Kelly staking, the shared bet-edge-threshold rule (17 tests)
  - `js/calibration.js` — Wilson CI, log loss, Brier/ECE/BSS decomposition (12 tests)
  - `js/poisson.js` — Poisson PMF, pitcher suppression, win-probability core (13 tests)
  - `js/elo.js` — Elo seeding, ratings→win-prob, margin-of-victory rating change (12 tests)
  - `js/situational.js` — recent form/streaks/venue splits, recency-weighted form decay (18 tests)
  - `js/injuries.js` — star-tier matching, out-status classification, injury impact (11 tests)

### Real bugs found and fixed along the way

1. **Sharpness metric was measuring the wrong thing** (`js/calibration.js`). The "Model Health" tab
   labels a stat "Sharpness — spread from 50/50", but the code computed standard deviation around the
   sample's *own mean* prediction, not distance from 0.5. A model that's always confidently at ~90%
   has zero spread around its own mean, so it silently reported ~0 sharpness (looking timid) instead of
   ~0.4 (maximally bold). Fixed to measure RMS distance from 0.5 as documented and labeled.
2. **Voided games were leaking into Elo as fake ties** (`buildElo`, now `js/elo.js` + inline glue). The
   backtest-store branch was missing the `hs!==as` guard that the user-history branch already had. The
   app's own stated rule elsewhere is that an equal-score "final" means the game was postponed/
   suspended and never really happened — but such an entry would still get replayed into Elo as a tie
   (`homeWon=0.5`), quietly nudging both teams' ratings from a game that didn't occur.
3. **`"Illness"` was misclassified as an injured-list absence** (`js/injuries.js`). The out-status check
   used `status.indexOf("il")===0`, a bare prefix match meant to catch abbreviated statuses like
   `"IL-10"`/`"IL"`. It also matches any status starting with those two letters — including
   `"Illness"` — even though the code's own comment says only out/IL/suspended should count, not
   day-to-day. A sick-but-possibly-playing star was being silently treated as unavailable, docking that
   team's win probability (and its bet edge) for no real reason. Fixed with a word-boundary check.

### Other cleanups

- De-duplicated the "does either side clear the betting edge threshold" rule, which was hand-copied
  identically across **5** call sites (not 4, as first estimated — a 5th turned up in `applyTrained`),
  into one tested `pickBetSide()` function.
- Removed a dead, name-colliding inline `pitchSuppress(sp,side)` wrapper that had no remaining callers
  after `poissonModel` started calling the extracted core directly — left in place, it would have
  silently shadowed the real `js/poisson.js` export instead of erroring.

## What's still at 0% (unchanged priority, renumbered)

### 1. The core logit blend + online learning — highest remaining priority
`predictFull` and `learnFromGame` in the main inline script. This is the ~19-term logistic blend
(`terms=[c.power,c.elo,c.hfa,...]`) that combines Elo, Poisson, park factors, splits, injuries,
situational, umpire, and weather adjustments into the final win probability, plus the online
gradient-descent weight update after each game resolves. Not yet extracted: it's the most deeply
global-state-coupled function in the app (reads `PARK`, `PWR`, `TEAM_SPLITS`, `H2H`, `PVT`, `MODEL_W`,
`PLAYED_YDAY`, `WX_PERF` directly) and the highest-effort extraction of the batch. Given it already
shipped one overfitting bug (per the pre-existing commit history), this is where the next unit of test
work should go — likely via targeted pure-function extraction of sub-terms (the way `poissonModel` and
`eloProbHome` were peeled off) rather than one big-bang rewrite, plus boundary tests on `learnFromGame`'s
weight clamps (`STEP_CAP_FRAC`, per-weight clamp ranges).

### 2. External data parsing (ESPN API) — untouched
`buildGamesFromESPN`, `applyRealPitcher`, `applyRealRecord`, `realOddsFromESPN`, `parseInjuries`,
`ourAbbrFromEspn`, `weatherFromESPN`. Full of defensive `||` chains that silently return wrong/partial
data instead of crashing on an unexpected real-world API shape (postponed game, missing probable
pitcher, missing odds). Needs fixture-based tests: save a handful of real ESPN scoreboard responses
(normal, postponed, missing-odds, missing-pitcher, suspended) and assert the parsed output field by
field.

### 3. Persistence layer — untouched
`loadWeights`/`saveWeights` (schema migration via `WEIGHTS_SCHEMA`), `btLoad`/`btSave` (`BT_SCHEMA`),
and the `LS` shim itself (falls back to an in-memory object when `localStorage` throws — private
browsing / storage disabled). Needs tests for corrupt/non-JSON values, stale-schema values, and that
the in-memory fallback actually persists within a session.

### 4. Rendering / DOM — lower priority, unchanged
`renderCalib`, `renderToday`, `strikeZoneSVG`, `logoBox`, etc. Canvas/DOM-heavy, changes often for
cosmetic reasons. A handful of jsdom/Playwright smoke tests (tab switching, a game card renders without
throwing, toggling situational factors re-renders) covers this better than unit tests would.

## Remaining small items noticed but not yet acted on

- `umpTeamFit` / `wxCategory` — smaller, not yet extracted; reasonable next quick win alongside the
  ESPN-parsing fixtures.
- `wxWinPct` always returns `null` behind an explicit "HONESTY GATE" comment (the underlying `WX_PERF`
  table was fabricated, never measured) — intentional, not a bug, left as-is. The dead `WX_PERF` table
  and the 3 call sites that depend on `wxCategory`+`wxWinPct` together are vestigial as a result, but
  removing them is a product decision (re-enabling with real data vs. deleting), not a test-coverage
  concern.
- `poissonModel(home,away,sp,gid)` and `gameSituational(home,away,startMs)` both carry a parameter
  (`gid`, `startMs` respectively) that's accepted but never read in the body — harmless, not fixed,
  noted here in case it's a sign a caller expected them to matter.
