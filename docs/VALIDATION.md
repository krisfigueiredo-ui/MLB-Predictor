# Validation and methodology audit

## Problems found in the inherited application

1. Historical backtests could reconstruct older games with current team context, creating point-in-time leakage.
2. Randomized cross-validation was presented more prominently than chronological evaluation.
3. Calibration and model-weight evaluation were not tied to an immutable pregame record.
4. Existing logs did not contain a complete feature, contribution, model-version, and market snapshot.
5. Published and experimental probabilities were not clearly separated in the interface.
6. Market availability and data-quality gaps were difficult to audit from one place.
7. The monolithic UI encouraged repeated cards and obscured the matchup comparison workflow.
8. The original GitHub Pages workflow copied only top-level `js/*.js`, which would omit new nested modules and CSS.
9. A live refresh could recreate the Ballpark renderer instead of updating the current scene in place.
10. Documentation claimed third-party CORS relays were unused even though fallback routes remained in the application.

Earlier repository tests had already corrected standardization leakage in batch training and prevented the online learner from updating features that were not allowed to vote. Those protections remain covered.

## Methodology changes

- Added rolling-origin splits as the primary validation utility.
- Fit normalization and logistic weights using each training fold only.
- Added prior-only calibration with an explicit minimum sample and training count.
- Separated raw, calibrated-shadow, and published probabilities.
- Added normalized weight handling when one base model is unavailable.
- Added model-dispersion and agreement diagnostics.
- Added chronological walk-forward feature ablation.
- Added deeply immutable, versioned pregame snapshots.
- Kept incomplete historical records labeled `LEGACY` instead of reconstructing them.
- Added a forward model-version table without retrospectively selecting a winner.

## Current evidence

The supplied inherited diagnostic covered 199 games and reported 57.8% accuracy, approximately 0.2505 Brier score, and 0.6959 log loss. Because log loss was slightly worse than the 0.6931 coin-flip reference and higher-confidence groups were overconfident, these figures are shown only as a legacy audit benchmark.

No historical confidence band is hard-coded and no probability ceiling was introduced. The new calibrated ensemble remains a shadow path until enough genuinely prospective snapshots exist.

## Forward validation required

The following questions require future games captured by the new schema:

- whether calibration shrinkage improves out-of-time log loss and Brier score;
- whether the three-model ensemble beats the existing published probability;
- whether online learning is stable against a frozen comparator;
- which correlated feature groups add out-of-time value;
- whether apparent market edge survives closing-line and paper-P/L evaluation;
- whether performance is stable by confidence band, team, park, and data-quality level.

Promotion should be based primarily on out-of-time log loss and Brier score, then calibration error, with accuracy as a secondary descriptive metric. No shadow model should be promoted on a tiny sample.

## Known limitations

- Browser local storage is not a shared database; exports are required for durable cross-device collection.
- The current public feeds do not guarantee complete xERA, velocity-trend, pitch-mix, bullpen-availability, lineup, weather, umpire, or closing-line fields for every game.
- Missing legitimate inputs remain neutral rather than estimated.
- Market snapshots preserve only fields present in the upstream odds object; opening and closing lines cannot be claimed when the provider does not publish them.
- The 3D pitch curve uses a measured plate endpoint but schematic interpolation when full trajectory vectors are unavailable.
- Six parks have configured official dimension markers; other parks use a labeled schematic geometry.
- Visual browser QA of the local preview can be limited by the host application's localhost security policy; source-level responsive checks and automated fallback tests remain in CI.

## Test result

At the completion of this rebuild: **210 tests passed across 15 test files**. Run `npm test` to reproduce the suite.
