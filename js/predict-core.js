// Core math underlying predictFull(): regression-to-mean + clamping for noisy
// small-sample pitcher stats, W-L record parsing, Pythagorean win expectation,
// and the final "combine every signal into one probability" step. Pulled out
// of the inline script so this arithmetic is unit testable without the
// PARK/TEAM_SPLITS/H2H/PVT/MODEL_W game-state globals predictFull also reads.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// Regress two small-sample values toward a league average by `regressionFactor`
// (0..1, where 1 = no regression), then return the clamped home-vs-away
// difference. Used so a noisy last-3-starts pitcher sample can't hijack the
// whole prediction. Note the league average cancels out of the difference,
// so this is equivalent to regressionFactor*(awayVal-homeVal), clamped -- the
// regression step compresses the raw gap before the clamp bites, it doesn't
// change where the two values are centered.
function regressAndClampDiff(homeVal, awayVal, leagueAvg, regressionFactor, bound) {
  var hE = leagueAvg + (homeVal - leagueAvg) * regressionFactor;
  var aE = leagueAvg + (awayVal - leagueAvg) * regressionFactor;
  return Math.max(-bound, Math.min(bound, aE - hE));
}

// Parse a "W-L" record summary into a win percentage, with a fallback for a
// missing/malformed/scoreless (0-0) record.
function recordWinPct(summary, fallback) {
  var parts = ("" + (summary || "0-0")).split("-");
  var w = parseInt(parts[0]) || 0, l = parseInt(parts[1]) || 0;
  return (w + l) > 0 ? w / (w + l) : fallback;
}

// Last-10-games win fraction from a split's l10 summary (e.g. "7-3" -> 0.7).
function l10Pct(l10Summary) {
  if (!l10Summary) return 0.5;
  var p = ("" + l10Summary).split("-");
  return parseInt(p[0]) / 10;
}

// Overall team win% from a season record, falling back to a PWR-derived
// estimate (clamped to a realistic 30-70% band) when there's no real record yet.
function teamWinPctCore(recSummary, pwr) {
  if (recSummary) {
    var p = ("" + recSummary).split("-");
    var w = parseInt(p[0]), l = parseInt(p[1]);
    if (!isNaN(w) && !isNaN(l) && (w + l) > 0) return w / (w + l);
  }
  var pw = pwr == null ? 60 : pwr;
  return Math.max(0.30, Math.min(0.70, 0.35 + (pw - 50) * 0.0094));
}

// Pythagorean ("Pythagenpat"-ish, exponent 1.83) win expectation from a team's
// run differential -- catches a team whose W-L record is lucky/unlucky
// relative to how many runs they actually score and allow. Falls back to
// teamWinPctCore's estimate when there isn't a usable record/run-diff yet.
function pythagExpCore(recSummary, rdSummary, pwr) {
  var fallback = function() { return teamWinPctCore(recSummary, pwr); };
  if (!recSummary || rdSummary == null) return fallback();
  var p = ("" + recSummary).split("-");
  var g = parseInt(p[0]) + parseInt(p[1]);
  if (!g) return 0.5;
  var rd = parseFloat(("" + rdSummary).replace("+", ""));
  if (isNaN(rd)) return fallback();
  var lg = 4.5; // league avg runs/game
  var rs = lg + (rd / g) / 2, ra = lg - (rd / g) / 2; if (ra < 0.1) ra = 0.1;
  var e = 1.83;
  return Math.pow(rs, e) / (Math.pow(rs, e) + Math.pow(ra, e));
}

// Sum a list of model-feature contributions into a single logit, treating any
// non-numeric (NaN/undefined/null) entry as 0 so one bad input can't poison
// the whole prediction.
function combineLogitTerms(terms) {
  var logit = 0;
  for (var i = 0; i < terms.length; i++) {
    var tv = terms[i];
    if (typeof tv === "number" && !isNaN(tv)) logit += tv;
  }
  return logit;
}

// Turn a raw logit into a final probability: logistic transform, shrink
// toward 0.5 by `shrink` (the model's self-calibration factor), a NaN safety
// net, and a hard honesty ceiling/floor (no single MLB game is a lock).
function applyShrinkAndClamp(logit, shrink, lo, hi) {
  if (lo == null) lo = 0.20; if (hi == null) hi = 0.80;
  var p = 1 / (1 + Math.exp(-logit));
  p = 0.5 + (p - 0.5) * shrink;
  if (isNaN(p)) p = 0.5;
  return Math.min(hi, Math.max(lo, p));
}

return {
  regressAndClampDiff: regressAndClampDiff,
  recordWinPct: recordWinPct,
  l10Pct: l10Pct,
  teamWinPctCore: teamWinPctCore,
  pythagExpCore: pythagExpCore,
  combineLogitTerms: combineLogitTerms,
  applyShrinkAndClamp: applyShrinkAndClamp
};

});
