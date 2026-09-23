// +EV engine. Edges and stakes come from final_p (market-anchored, calibrated)
// against the de-vigged market — never from the raw model probability.
// Rules: flag only when edge >= 3 points and the model is not paused;
// stake = 0.25 × full Kelly, capped at 2% of bankroll.
(function(root, factory) {
  var P = (typeof module !== "undefined" && module.exports) ? require("./probability") : root.DSProb;
  var mod = factory(P);
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  root.DSEv = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function(P) {
  var RULES = { minEdge: 0.03, kellyFraction: 0.25, maxStake: 0.02 };

  function kellyFull(p, decimalOdds) {
    var b = decimalOdds - 1;
    if (!(b > 0)) return 0;
    return Math.max(0, (b * p - (1 - p)) / b);
  }

  // input: {finalP (home), homeML, awayML, paused, bankroll}
  function evaluateBet(input) {
    input = input || {};
    var out = { flag: false, side: null, edge: null, homeEdge: null, awayEdge: null, stakeFraction: 0, stake: 0, reason: null };
    var fair = P.devig(input.homeML, input.awayML);
    if (!fair) { out.reason = "no real market odds"; return out; }
    if (!P.finite(input.finalP)) { out.reason = "no final probability"; return out; }
    out.marketHomeP = fair.home;
    out.homeEdge = input.finalP - fair.home;
    out.awayEdge = (1 - input.finalP) - fair.away;
    var home = out.homeEdge >= out.awayEdge;
    out.side = home ? "home" : "away";
    out.edge = home ? out.homeEdge : out.awayEdge;
    if (input.paused) { out.reason = "MODEL PAUSED — no edge"; return out; }
    if (out.edge < RULES.minEdge - 1e-12) { out.reason = "edge below 3 points"; return out; }
    var p = home ? input.finalP : 1 - input.finalP;
    var dec = P.americanToDecimal(home ? input.homeML : input.awayML);
    var f = Math.min(RULES.maxStake, RULES.kellyFraction * kellyFull(p, dec));
    if (!(f > 0)) { out.reason = "non-positive Kelly stake"; return out; }
    out.flag = true;
    out.stakeFraction = f;
    out.stake = (input.bankroll || 0) * f;
    out.price = home ? input.homeML : input.awayML;
    out.reason = "edge " + (out.edge * 100).toFixed(1) + " pts";
    return out;
  }

  // Closing-line value in fair-probability points for the chosen side:
  // positive when the market moved toward the pick after it was made.
  function clv(side, pickHomeML, pickAwayML, closeHomeML, closeAwayML) {
    var a = P.devig(pickHomeML, pickAwayML), b = P.devig(closeHomeML, closeAwayML);
    if (!a || !b || !side) return null;
    return side === "home" ? b.home - a.home : b.away - a.away;
  }

  // Profit per unit staked at the pick-time American price.
  function profitPerUnit(won, ml) { return won ? P.americanToDecimal(ml) - 1 : -1; }

  return { RULES: RULES, kellyFull: kellyFull, evaluateBet: evaluateBet, clv: clv, profitPerUnit: profitPerUnit };
});
