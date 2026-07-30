# All-Sports Predictor

Predictions, live win probability and news for **every league on the ESPN API** — around 170
competitions across 17 sports, in one installable dashboard. No build step, no API keys, no server.

**Live site:** https://krisfigueiredo-ui.github.io/all-sports-predictor/

> **Paper analysis only — not betting advice.** Probabilities come from ratings and models fitted to
> whatever history the ESPN feed returns. No accuracy or return is promised.

---

## What it does

### Every league, including ones whose season hasn't started

A curated catalog of ~170 leagues ships with tuned priors per competition — home advantage, Elo K,
expected scoring. On load the app *also* reads ESPN's own sport/league directory and merges in
anything it didn't already know, so leagues ESPN adds later appear without a code change.

When a league has no fixtures today, ESPN's calendar is used to offer the next matchday, and
carried-over power ratings are shown instead of a blank page.

### A different model per competition kind

"Who wins" isn't one question, so it isn't one model:

| Kind | Sports | Model |
|---|---|---|
| **Two-team** | NBA, NFL, MLB, NHL, college, … | Elo prior blended with a logistic model on 12 features |
| **Draw possible** | soccer, rugby, field hockey | Davidson three-way + bivariate Poisson (Dixon–Coles) for 1X2, BTTS, totals, correct score |
| **Head-to-head** | tennis, MMA, boxing | Tennis runs a full point → game → set → match hierarchy driven off the rating gap |
| **Field event** | golf, F1, NASCAR, IndyCar | Plackett–Luce over entrant ratings, with seeded-simulation top-5/top-10 |

### Live play analysis

In-game win probability after every play, charted against ESPN's own line where they publish one,
plus leverage ("how much would the next score swing this?"), momentum over recent plays, a ranked
biggest-swings list, and the full play feed.

The in-game model is sport-specific, because the physics differ:

- **Clock sports** — a Brownian bridge on the margin. At tip-off it reproduces the pregame
  probability exactly; as the clock runs out it collapses to whoever is ahead.
- **Soccer** — a Poisson race over the minutes that remain, giving exact live 1X2 probabilities.
- **Baseball** — a negative-binomial run model over the innings that remain, with base-out run
  expectancy and an exact walk-off path. (Run scoring is both skewed and over-dispersed; a normal
  approximation gets high-run-expectancy states badly wrong.)

### Backtesting that doesn't cheat

Completed games over the chosen window are replayed in date order. Each game's features are built
from state containing **only earlier games**, and the result is folded in afterwards. The train/test
split is **chronological**, never random, standardization is fitted on the training slice alone, and
there's an expanding-window walk-forward evaluation alongside the single split.

The fitted model is blended into the Elo prior **only if it beat Elo-alone on held-out data**.
Otherwise it gets zero weight and the UI says so.

### Also

- **News feed** merged across the current sport's leagues, deduped by id *and* by normalised
  headline (the same wire story appears under several leagues), grouped Today / Yesterday / Earlier.
- **Logos, crests and flags** for teams, leagues and countries. Each image walks an ordered list of
  ESPN CDN candidates and ends at a generated inline-SVG monogram, so a missing crest degrades to a
  clean lettermark rather than a broken image.
- **Power ratings and standings** per league.
- **Market comparison** — no-vig probabilities from ESPN's odds block, with edges flagged at 4%+,
  and a held-out paper-betting backtest.

---

## Install it as an app

This is a progressive web app: it installs to a phone home screen, a desktop dock, or a Windows or
Linux app list. No store, no build step.

- **Android / Chrome / Edge / desktop Chrome** — an **Install app** button appears in the header.
- **iPhone / iPad** — Safari's *Share → Add to Home Screen*. iOS gives no programmatic install, so
  the button opens the instructions instead of silently doing nothing.
- **Long-press the installed icon** for shortcuts straight to *Live now*, *News* or *Model*.

Installed, it opens full-screen with its own icon, respects the notch, and starts from the cached
shell rather than a blank page.

### What works offline, and what deliberately doesn't

| | Offline |
|---|---|
| App shell — page, all modules, icons | ✅ cached, opens instantly |
| Team crests and league logos | ✅ cached after first sight |
| Scores, odds, standings, news | ❌ **never cached, by design** |

Live data is the one thing a sports app must not serve stale. A cached scoreboard would show a
finished game as if it were still in progress, so [`sw.js`](sw.js) routes every API host as
network-only. Offline, the app opens, says plainly that it's offline and why — on *every* tab, so
none of them can blame an empty state on the wrong cause — and shows nothing it can't stand behind.
It reloads itself when the connection returns.

Cache names are versioned (`ms-shell-v1`, `ms-img-v1`); bumping `VERSION` in
[`js/ms-pwa.js`](js/ms-pwa.js) evicts the old ones on activation. The image cache is capped at 400
entries.

---

## Honesty properties

These are deliberate and visible in the UI:

- **Every request is logged** in the footer with its outcome. A failed feed produces an explicit
  "the feed did not return" state — never a substitute slate, projected score, or invented line.
- **Calibration** is measured on picked-side confidence over held-out games, and the shrink factor
  it suggests is applied to predictions.
- **Confidence labels** state how many prior games actually back each matchup.
- **The paper-betting backtest** runs on held-out games only, at a 4% minimum edge, and reports zero
  bets rather than inventing a line when ESPN carried no moneyline.

## Known limitations

- Backtest depth is whatever the ESPN scoreboard returns for the window. A thinly covered league
  trains on thin data, and the counts on the Model tab say so.
- Play-by-play exists for the US majors and little else; the win-probability chart falls back to a
  clear "no play list" message for leagues ESPN covers with scores only.
- Field events (golf, motorsport) rate entrants from Elo over the loaded window, a weaker signal
  than a proper strokes-gained or lap-time model.
- Per-play baseball win probability is evaluated at the start of each half-inning, because ESPN
  does not carry base-out state on individual plays.

---

## Running it locally

It's a static site — no build step. A server is needed (not `file://`) because service workers and
cross-origin data requests don't work from the filesystem.

```bash
npm install
npm run serve      # python3 -m http.server 8000
# then open http://localhost:8000/
```

```bash
npm test           # 404 unit tests (Vitest); also runs in CI on every push and PR
```

Deploys are automatic: every push to `main` publishes to GitHub Pages via
[`.github/workflows/pages.yml`](.github/workflows/pages.yml), which fails the deploy if any
precached asset is missing, any `<script>` tag has no file, or the manifest doesn't parse.

## Modules

All the maths lives in small, dependency-free modules that are unit tested in Node and loaded by
`index.html` as plain script tags. Each is namespaced under `MS.*` rather than flattened onto the
global scope.

| Module | What's in it |
|---|---|
| [`js/ms-leagues.js`](js/ms-leagues.js) | League catalog, ESPN endpoint builders, runtime league discovery |
| [`js/ms-espn.js`](js/ms-espn.js) | Sport-agnostic scoreboard/event/odds/news/standings/season parsing |
| [`js/ms-logos.js`](js/ms-logos.js) | Team/league/country image candidate chains, inline-SVG monogram fallback |
| [`js/ms-ratings.js`](js/ms-ratings.js) | Elo, Davidson three-way, Poisson/Dixon–Coles goals, tennis hierarchy, Plackett–Luce, odds maths |
| [`js/ms-features.js`](js/ms-features.js) | Point-in-time team state and the 12-feature vector |
| [`js/ms-backtest.js`](js/ms-backtest.js) | Leak-free replay, chronological and walk-forward splits, grading, paper-bet backtest |
| [`js/ms-model.js`](js/ms-model.js) | Per-league train/predict/persist, blending, market edges |
| [`js/ms-live.js`](js/ms-live.js) | Live situation/plays parsing and the in-game win-probability models |
| [`js/ms-news.js`](js/ms-news.js) | Multi-league news merge, dedupe, grouping |
| [`js/ms-pwa.js`](js/ms-pwa.js) | Install/offline policy — which requests may be cached, and which must never be |
| [`js/ms-app.js`](js/ms-app.js) | Dashboard shell: fetching, state, rendering, SVG charts |
| [`js/ml-train.js`](js/ml-train.js) | Logistic-regression trainer, standardization, ROC-AUC, CV metrics |
| [`js/calibration.js`](js/calibration.js) | Wilson CI, log loss, Brier/ECE/sharpness calibration report |
| [`sw.js`](sw.js) | Service worker applying the caching policy |

The service worker's routing policy lives in `js/ms-pwa.js` rather than inside `sw.js` specifically
so it can be unit tested in Node — including the rule that live-data hosts are never cached.

## Data sources

ESPN's public scoreboard, summary, standings, teams, news and league-directory endpoints, requested
directly from the browser. No API keys, no third-party CORS relays, no substitute datasets.

## Related

Sibling project: **[MLB Predictor](https://github.com/krisfigueiredo-ui/MLB-Predictor)** — a
single-sport dashboard with pitcher-level detail this one doesn't attempt.
