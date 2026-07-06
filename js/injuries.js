// Injury-impact math: matching an injured player against a curated star-tier
// list, and turning a team's injury report into a capped win-probability
// adjustment. Pulled out of the inline script so it's unit testable without
// the live ESPN-fed INJURIES/STARS globals.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// stars: array of [namePart, tier] for one team. Returns the best (lowest =
// most important) matching tier, or null if the injured player isn't a listed star.
function starTierCore(stars, name) {
  var tier = null;
  (stars || []).forEach(function(s) {
    var key = s[0].toLowerCase();
    if (name && name.toLowerCase().indexOf(key) >= 0) tier = (tier === null ? s[1] : Math.min(tier, s[1]));
  });
  return tier;
}

// Is this injury status one that actually keeps a player off the field tonight
// (out / injured list / suspended / restricted), as opposed to day-to-day?
// NOTE: matches "il"/"il-10" etc. as a whole leading token (word boundary), not
// merely a string PREFIX -- a bare prefix match would also catch "Illness",
// "Ill", etc. and wrongly treat a day-to-day sick player as unavailable.
function isOutStatus(status) {
  var st = (status || "").toLowerCase();
  return st.indexOf("out") >= 0 || st.indexOf("60-day") >= 0 || st.indexOf("15-day") >= 0 ||
    st.indexOf("10-day") >= 0 || st.indexOf("injured list") >= 0 || /^il\b/.test(st) ||
    st.indexOf("suspend") >= 0 || st.indexOf("restricted") >= 0;
}

// Net injury impact for one team (adj is always <= 0; negative = hurts them).
// injuries: array of {name,pos,status}. stars: this team's [name,tier] list.
function injuryImpactCore(injuries, stars) {
  if (!injuries || !injuries.length) return { players: [], adj: 0, dtd: [] };
  var out = [], dtd = [], adj = 0;
  injuries.forEach(function(p) {
    var tier = starTierCore(stars, p.name);
    if (isOutStatus(p.status)) {
      var hit = tier === 1 ? 0.035 : tier === 2 ? 0.020 : tier === 3 ? 0.010 : 0.005;
      adj -= hit; out.push({ name: p.name, pos: p.pos, status: p.status, tier: tier });
    } else {
      dtd.push({ name: p.name, pos: p.pos, status: p.status, tier: tier });
    }
  });
  adj = Math.max(-0.06, adj); // cap so it can't dominate
  return { players: out, adj: adj, dtd: dtd };
}

return {
  starTierCore: starTierCore,
  isOutStatus: isOutStatus,
  injuryImpactCore: injuryImpactCore
};

});
