// Betting math: American/decimal odds conversion, Kelly stake sizing, and
// the shared "which side has the betting edge" rule used by every game-list
// render path. Pulled out of the inline script so it can be unit tested.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

function mlToDecimal(ml) { return ml > 0 ? (ml / 100) + 1 : (100 / (-ml)) + 1; }
function decimalToML(dec) { var b = dec - 1; return b >= 1 ? Math.round(b * 100) : Math.round(-100 / b); }

// Kelly fraction of bankroll: f* = (b*p - q)/b, b=decimal odds-1, p=win prob, q=1-p
function kellyStake(p, decOdds, bankroll, frac) {
  var b = decOdds - 1; if (b <= 0) return 0;
  var f = (b * p - (1 - p)) / b;
  if (f <= 0) return 0;
  return bankroll * f * frac;
}

// Minimum model-vs-market edge (in probability points) required to call a side a "bet".
var EDGE_THRESHOLD = 0.04;

// Shared rule for "does either side clear the betting threshold, and if so which one".
// homeEdge/awayEdge are (modelProb - marketImpliedProb) for each side.
// Returns {pick:"home"|"away"|"", edge:number}.
function pickBetSide(homeEdge, awayEdge) {
  if (homeEdge >= awayEdge && homeEdge > EDGE_THRESHOLD) return { pick: "home", edge: homeEdge };
  if (awayEdge > homeEdge && awayEdge > EDGE_THRESHOLD) return { pick: "away", edge: awayEdge };
  return { pick: "", edge: 0 };
}

// Replays logged bets in stake-order, sizing each as a fraction of the CURRENT
// bankroll (compounding). bets[i].kStake is a dollar stake computed against a
// fixed $1000 baseline bankroll, so kStake/1000 recovers the effective fraction
// (already inclusive of the fractional-Kelly multiplier) to apply to `start`.
function simWhatIf(bets, start) {
  var bank = start, peak = start, maxDD = 0, played = 0;
  bets.forEach(function(b) {
    var f = (b.kStake || 0) / 1000; if (f <= 0) return;
    var stake = bank * f; var dec = mlToDecimal(b.ml);
    bank += b.won ? stake * (dec - 1) : -stake; played++;
    if (bank > peak) peak = bank; var dd = peak > 0 ? (peak - bank) / peak : 0; if (dd > maxDD) maxDD = dd;
  });
  return { final: bank, profit: bank - start, maxDD: maxDD, played: played };
}

return {
  mlToDecimal: mlToDecimal,
  decimalToML: decimalToML,
  kellyStake: kellyStake,
  EDGE_THRESHOLD: EDGE_THRESHOLD,
  pickBetSide: pickBetSide,
  simWhatIf: simWhatIf
};

});
