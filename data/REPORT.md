# Backfill + optimization report

Generated 2026-09-23T02:59:56.410Z from ESPN's public API. Every metric below is walk-forward (trained only on games before each date).

## Season coverage

- Regular-season games in ESPN's schedule (to date, incl. upcoming): **2374**
- Completed: **2351**; with a walk-forward prediction: **2351** (100.0%)
- Past games without a prediction (all with logged reasons): **27** — see `coverage/coverage.json`
- Scoreboard dates that failed to fetch: **0**
- Box scores parsed (for bullpen history): **2351** of 2351

## Historical odds

| Month | Final games | With opening line | With closing line | Any real price |
|---|---|---|---|---|
| 202603 | 76 | 76 | 76 | 76 |
| 202604 | 392 | 392 | 392 | 392 |
| 202605 | 419 | 419 | 419 | 419 |
| 202606 | 394 | 394 | 394 | 394 |
| 202607 | 372 | 372 | 372 | 372 |
| 202608 | 417 | 417 | 417 | 417 |
| 202609 | 281 | 281 | 281 | 281 |
| **Total** | 2351 | 2351 | 2351 | 2351 |

Per-game availability is in `coverage/odds.json`. CLV needs both a pick-time (opening) and a closing price; ROI and the market blend use only games with a real price.

## Features

- `elo`: derived: Elo ratings from ESPN final scores (2025 season + 2026 games before first pitch)
- `rd`: derived: recency-weighted run differential per game from ESPN final scores before first pitch (half-life tuned)
- `wp`: derived: recency-weighted win% from ESPN final scores before first pitch (half-life tuned)
- `rest`: ESPN schedule: days since each team's previous game (capped at 3)
- `bp3`: ESPN box scores of earlier games: bullpen innings pitched over the previous 3 days
- `sept`: calendar: September roster-expansion flag
- `septRd`: interaction: September flag × recency-weighted run differential
- `spRa9`: live only: ESPN pregame probable starter × his earned runs per 9 in earlier ESPN box scores (regressed)
- `spPc`: live only: ESPN pregame probable starter × his mean pitch count over his last 3 starts
- `rested`: live only: regulars (most starts in the prior 14 days) missing from ESPN's posted pregame lineup

Null in every backfilled row (cannot be reconstructed as of pregame; not approximated): `spRa9`, `spPc`, `rested`. They are recorded on live `frozen_pregame` rows only and are not in the fitted model until enough live rows exist.

## Optimization loop

- Tuning set: season start → 20260901; locked holdout: 20260902 → 20260922 (last 21 days)
- Configs tried: **50** in 5 rounds; stop: 3 consecutive rounds improved log loss by < 0.001
- Rejected for calibration slope outside 0.8–1.2: 23
- Winner: `cfg-1cf05144` `{"featureSet":"elo","hl":30,"members":"elo","lambda":10,"trainHl":60,"calMethod":"platt","calWindow":60,"w0":0.7}`
- Why: simplest config (complexity 3.5) within 0.002 of the best tuning log loss (0.6874); 27 configs were in that band

Objective: walk-forward log loss of the calibrated model probability (the market weight w is tuned separately at every refit).

| Rank | Version | Model LL | Brier | Slope | final_p LL | Complexity | Config |
|---|---|---|---|---|---|---|---|
| 1 | cfg-1cf05144 | 0.6874 | 0.2471 | 1.125 | 0.6837 | 3.5 | elo/elo hl=30 λ=10 trainHl=60 platt win=60 w0=0.7 |
| 2 | cfg-a9d50cfd | 0.6874 | 0.2471 | 1.125 | 0.6837 | 3.5 | elo/elo hl=45 λ=100 trainHl=120 platt win=60 w0=0.7 |
| 3 | cfg-c74915c8 | 0.6877 | 0.2473 | 1.020 | 0.6839 | 5.5 | strength/blend50 hl=14 λ=3 trainHl=120 shrink win=60 w0=0.7 |
| 4 | cfg-8d59eeee | 0.6880 | 0.2474 | 0.937 | 0.6837 | 5.5 | strength/blend75 hl=45 λ=10 trainHl=60 shrink win=60 w0=0.7 |
| 5 | cfg-f51b0b7b | 0.6880 | 0.2474 | 0.949 | 0.6838 | 5.5 | strength/blend50 hl=14 λ=100 trainHl=120 shrink win=45 w0=0.7 |
| 6 | cfg-d3e0ef0b | 0.6880 | 0.2474 | 1.200 | 0.6839 | 4 | elo/blend50 hl=30 λ=10 trainHl=0 platt win=60 w0=0.5 |
| 7 | cfg-9ec8aecd | 0.6881 | 0.2475 | 0.937 | 0.6840 | 3.5 | elo/blend75 hl=30 λ=10 trainHl=60 shrink win=60 w0=0.7 |
| 8 | cfg-7e790d21 | 0.6881 | 0.2475 | 1.182 | 0.6838 | 4.5 | elo/blend50 hl=45 λ=10 trainHl=60 platt win=60 w0=0.9 |
| 9 | cfg-dd28ad1f | 0.6881 | 0.2475 | 1.182 | 0.6839 | 4.5 | elo/blend50 hl=45 λ=10 trainHl=60 platt win=60 w0=0.6 |
| 10 | cfg-d519430b | 0.6882 | 0.2476 | 1.130 | 0.6840 | 6.5 | strength/blend50 hl=60 λ=10 trainHl=60 platt win=45 w0=0.6 |

## Before / after (walk-forward, out of sample)

"Before" = the raw ensemble probability with no calibration layer; "calibrated" = model after the auto-calibrator; "final" = market-anchored final_p. Market rows are restricted to games with a real price.

### Tuning set

| Probability | n | Log loss | Brier | Slope | Max bucket err (n≥30) |
|---|---|---|---|---|---|
| raw (before) | 2085 | 0.6874 | 0.2471 | 0.709 | 5.1% |
| calibrated model | 2085 | 0.6874 | 0.2471 | 1.125 | 8.5% |
| final_p | 2085 | 0.6837 | 0.2453 | 0.978 | 3.3% |
| final_p — games with odds | 2085 | 0.6837 | 0.2453 | 0.978 | 3.3% |
| calibrated model — games with odds | 2085 | 0.6874 | 0.2471 | 1.125 | 8.5% |
| **market baseline** — games with odds | 2085 | 0.6839 | 0.2454 | 0.864 | 2.5% |

CLV (all leans): 0.37 pts over 2085 games · flagged bets: 160, ROI 2.7% flat / 0.6% Kelly-weighted, bet CLV 0.94 pts (160)

### Locked holdout

| Probability | n | Log loss | Brier | Slope | Max bucket err (n≥30) |
|---|---|---|---|---|---|
| raw (before) | 266 | 0.6682 | 0.2379 | 1.285 | 6.3% |
| calibrated model | 266 | 0.6705 | 0.2389 | 1.909 | 2.6% |
| final_p | 266 | 0.6610 | 0.2344 | 1.472 | 4.8% |
| final_p — games with odds | 266 | 0.6610 | 0.2344 | 1.472 | 4.8% |
| calibrated model — games with odds | 266 | 0.6705 | 0.2389 | 1.909 | 2.6% |
| **market baseline** — games with odds | 266 | 0.6610 | 0.2344 | 1.472 | 4.8% |

CLV (all leans): 0.55 pts over 266 games · flagged bets: 0, ROI — flat / — Kelly-weighted, bet CLV n/a (0)

## Calibrator status

- Method **platt**, n=786, window 60d, half-life 21d, fit 2026-09-13T16:09:00.000Z
- Version cal-v60 (30 versions kept), cap [0.42, 0.6], w=1 (w* 1), paused=true, drift **red** (slope 2.424 outside 0.7–1.3; paused: no edge vs market; 14-day model Brier 0.2325 > market 0.231; bucket error 0.0539 > 0.05)

## Edge vs the market

Holdout final_p log loss minus market log loss on 266 priced games: **0.0000** (identical to the market: w was 1.0, so final_p is the market price).

The model on its own (calibrated, no market): 0.6705 vs market 0.6610 (+0.0095; the model alone is less accurate than the market).

Average CLV on holdout leans: 0.55 pts over 266 games.
