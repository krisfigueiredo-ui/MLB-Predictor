# Test Coverage Analysis — MLB Predictor

## Current state: 0%

There is no test infrastructure in this repository at all:

- No `package.json`, no test runner, no CI config (`.github/workflows` doesn't exist).
- No `*test*` or `*spec*` files anywhere.
- The entire application is a single static file, `mlb-predictor-fixed.html` (4,857 lines), with one
  `<script>` block (line 585 to end, ~4,270 lines) containing ~318 top-level functions.

So "coverage" isn't low, it's nonexistent. That's the headline finding. Everything below is about
*where* to start, since you can't improve 318 functions at once.

## Why this is riskier than it looks

This isn't a static dashboard — it computes real prediction probabilities and sizes real-money bets:

- `kellyStake()` (line 4026) and `mlToDecimal`/`decimalToML` (4023-4024) turn a win probability and
  American odds into a dollar stake via `bankroll*f*frac`.
- `sweepBetLog()` (4057) and `simWhatIf()` (4047) grade bets against real final scores and compound a
  simulated bankroll, tracking max drawdown.
- The most recent commit is literally *"Fix model overfitting"* — i.e., a scoring/weight bug already
  shipped once and had to be patched after the fact, with nothing in place to catch a regression.

A silent sign error or off-by-one in any of this doesn't throw — it just quietly recommends the wrong
side or the wrong stake.

## Structural blocker

All logic lives as global `function`/`var` declarations inside one inline `<script>` tag, closing over
shared mutable state (`MODEL_W`, `PWR`, `SP`, `ELO`, `GAMES30`, `LS`, ...). Nothing is a module, so
nothing can be `require`/`import`ed into a test file today. Before writing tests, the highest-leverage
step is extracting the pure logic into standalone `<script src>` files (e.g. `js/model.js`,
`js/betting.js`, `js/calibration.js`, `js/espn-parse.js`) that the HTML still loads directly — this
keeps the single-page deploy but makes the same files importable from Node/Vitest. This can be done
incrementally, file-group by file-group, without behavior changes.

## Priority areas, ranked by risk × current coverage (all at 0%)

### 1. Core prediction model — highest priority
`predictFull` (953), `poissonModel` (1060), `eloProbHome`/`eloApply`/`buildElo` (888-926),
`learnFromGame` (1080), `recencyForm` (934).

This is the logit blend of ~19 terms (`terms=[c.power,c.elo,c.hfa,...]`, line 1029) that produces the
win probability everything else is built on. It has already had one shipped overfitting bug. Needs:
unit tests pinning `predictFull`'s output for fixed inputs, boundary tests on the clamps in
`learnFromGame` (`STEP_CAP_FRAC`, weight clamp ranges at 1107-1110), and Elo update tests (K-factor,
margin-of-victory scaling, HFA) against hand-computed expected deltas.

### 2. Betting / money math — highest priority
`kellyStake` (4026), `mlToDecimal`/`decimalToML` (4023-4024), the `betEdge` threshold logic (repeated
in 4 places: 1312, 1426, 1456, 3506, all using a hardcoded `0.04` edge cutoff), `simWhatIf` (4047),
`sweepBetLog` (4057).

This code decides which side to bet and how much. It's pure arithmetic (easy to test) but has zero
coverage despite directly producing dollar amounts. Worth calling out: the `0.04` edge threshold and
the flat-stake formula (`ml>0?ml:10000/(-ml)`) are duplicated across 4 call sites — tests would also
catch drift if one copy gets tweaked and the others don't.

### 3. Calibration / self-assessment statistics
`calibrationReport` (2619), `wilsonCI` (2609), `logLossAt` (2615), Brier score / BSS / ECE calc inline
in `calibrationReport`, `applyRecalibration` (2642).

This machinery *rewrites* `MODEL_W.shrink` and persists it back to `localStorage`
(`applyRecalibration` → `recomputeAll()`), so a bug here doesn't just mis-report accuracy, it feeds
back into future predictions. Brier score, log-loss, and Wilson CI are well-known formulas — cheap to
unit test against known reference values.

### 4. Situational/adjustment modifiers
`gameSituational` (3473), `injuryImpact` (3586), `umpTeamFit` (694), `wxWinPct`/`wxCategory`
(646, 712), `streakNudge` (1848).

Lots of magic-number thresholds and hard caps (`adj=Math.max(-0.05,Math.min(0.05,adj))`,
`adj=Math.max(-0.06,adj)`, tier-based injury weights 0.035/0.020/0.010/0.005). These are exactly the
kind of thing that silently breaks when someone tweaks one number — good candidates for table-driven
boundary tests (streak of exactly 3 vs 4, record of exactly 5-1, tier 1 vs 2 injury, etc.).

### 5. External data parsing (ESPN API)
`buildGamesFromESPN` (1255), `applyRealPitcher` (1217), `applyRealRecord` (1237),
`realOddsFromESPN` (1181), `parseInjuries` (3558), `ourAbbrFromEspn` (1153), `weatherFromESPN` (1166).

This is the code most exposed to things outside your control — a third-party JSON shape that can
change, omit fields, or represent a postponed/suspended game. It's full of defensive `||` chains
(`comp.venue&&comp.venue.weather`, `homeC.probables&&homeC.probables[0]`, etc.) that are exactly the
kind of code that looks safe but silently returns wrong data instead of crashing. This needs
fixture-based tests: save a handful of real ESPN scoreboard responses (normal game, postponed game,
game with missing odds/probable pitcher, suspended game) and assert the parsed output.

### 6. Persistence layer
`loadWeights`/`saveWeights` (853-865, with schema migration via `WEIGHTS_SCHEMA`), `btLoad`/`btSave`
(3430-3432, with `BT_SCHEMA`), and the `LS` shim itself (line 585, which falls back to an in-memory
object when `localStorage` throws, e.g. private browsing / storage disabled).

Needs tests for: corrupt/non-JSON stored value, old-schema value (should reset to defaults, not
crash), and the private-browsing fallback path actually persisting within a session.

### 7. Rendering / DOM — lower priority for unit tests
`renderCalib`, `renderToday`, `strikeZoneSVG`, `logoBox`, etc. These are canvas/DOM-heavy and change
often for cosmetic reasons. Don't chase unit coverage here — a small number of jsdom or Playwright
smoke tests (tab switching works, a game card renders without throwing, toggling situational factors
re-renders) gives most of the value for a fraction of the maintenance cost.

## Suggested path forward

1. Add `package.json` + Vitest (fast, no config needed for plain JS) + jsdom for the few DOM tests.
2. Extract areas 1-4 above (pure math, no DOM/network) into standalone modules loaded via
   `<script src>` — no behavior change, just moving code so it's importable.
3. Write unit tests for those modules first — highest bug-catching value per hour, since it's all
   deterministic arithmetic with no mocking required.
4. Add fixture-based tests for the ESPN parsing layer using a few saved real responses, including
   malformed/edge-case ones.
5. Add lightweight tests for the persistence layer with a mocked/in-memory `localStorage`.
6. Add a handful of smoke tests for the rendering layer.
7. Wire a GitHub Actions workflow to run the suite on every push/PR.

Steps 1-3 alone would cover the pieces most likely to produce a silent, dollar-denominated bug.
