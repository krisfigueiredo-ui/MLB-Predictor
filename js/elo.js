// Elo rating engine math: preseason-prior seeding, win probability from two
// ratings, and the margin-of-victory rating-change formula. Pulled out of the
// inline script so the core formulas are unit testable independent of the
// ELO/ELO_PREV mutable rating maps they're normally wired up to.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// Informative prior Elo rating from a preseason power rating (regressed toward
// the mean so best-vs-worst spread stays near MLB reality, ~65% win prob).
function eloSeedFromPower(pwr) {
  return 1500 + (pwr - 64) * 6.5;
}

// Home win probability from the two current ratings + a home-field-advantage bump.
function eloProbFromRatings(homeRating, awayRating, hfa) {
  var d = (homeRating + hfa) - awayRating;
  return 1 / (1 + Math.pow(10, -d / 400));
}

// Rating change for one game (538-style margin-of-victory adjustment): bigger
// margins move ratings more, with diminishing returns, damped when a strong
// favorite wins so blowouts by good teams don't over-inflate.
// homeWon: 1 (home win), 0 (away win), or 0.5 (tie).
//
// The damping term needs the *winner's* rating advantage, so the sign of
// ratingDiff flips when the away side wins. `homeWon ? 1 : -1` got that right
// for 1 and 0 and wrong for 0.5: a tie is truthy in JavaScript, so it took the
// home-win branch. Harmless today, because a tie carries margin 0 and the
// multiplier is overridden below before the direction can matter -- but it is
// wrong on its face, and the next caller to pass a half-credit result with a
// non-zero margin would inherit a silent error. Comparing against 0.5 says what
// is meant.
function eloRatingChange(k, margin, ratingDiff, homeWon, expectedHomeProb) {
  var winnerDiff = homeWon > 0.5 ? ratingDiff : homeWon < 0.5 ? -ratingDiff : 0;
  var mov = Math.log(margin + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
  if (!isFinite(mov) || mov <= 0) mov = 1;
  return k * mov * (homeWon - expectedHomeProb);
}

return {
  eloSeedFromPower: eloSeedFromPower,
  eloProbFromRatings: eloProbFromRatings,
  eloRatingChange: eloRatingChange
};

});
