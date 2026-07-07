// ESPN scoreboard/response parsing helpers: the code most exposed to a
// third-party API shape we don't control. Pulled out of the inline script so
// these can be tested against real (saved) and malformed ESPN payloads
// without needing the full buildGamesFromESPN pipeline.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// ESPN uses a few team abbreviations that differ from ours -- map them back.
function ourAbbrFromEspn(a) {
  var rev = { OAK: "ATH", CHW: "CWS", ARI: "AZ" };
  return rev[a] || a;
}

// Pull real weather from an ESPN event/competition when present. ESPN
// sometimes provides weather.temperature + weather.displayValue, and a venue
// indoor flag.
function weatherFromESPN(ev, comp) {
  var w = ev.weather || comp.weather || (comp.venue && comp.venue.weather) || null;
  var indoor = (comp.venue && comp.venue.indoor) || false;
  if (indoor && !w) return "Indoor / roof closed";
  if (!w) return null;
  var temp = (w.temperature != null ? w.temperature : (w.highTemperature != null ? w.highTemperature : null));
  var cond = w.displayValue || w.conditionId || "";
  var parts = [];
  if (temp != null) parts.push(temp + "F");
  if (cond) parts.push(cond);
  if (indoor) parts.push("(roof closed)");
  return parts.length ? parts.join(" ") : null;
}

// Parse ESPN's odds array into our {homeML,awayML,homeImpl,awayImpl,overUnder,provider} shape.
// Returns null if there's no clean moneyline to convert (e.g. spread-only entries).
function realOddsFromESPN(comp, homeP) {
  var arr = comp && comp.odds;
  if (!arr || !arr.length) return null;
  var o = arr[0];
  var hML = o.homeTeamOdds && o.homeTeamOdds.moneyLine, aML = o.awayTeamOdds && o.awayTeamOdds.moneyLine;
  if (hML == null || aML == null) return null;
  function impl(ml) { return ml < 0 ? (-ml) / ((-ml) + 100) : 100 / (ml + 100); }
  var hi = impl(hML), ai = impl(aML);
  var tot = hi + ai; if (tot > 0) { hi = hi / tot; ai = ai / tot; } // de-vig to normalize to 100%
  return {
    homeML: Math.round(hML), awayML: Math.round(aML),
    homeImpl: parseFloat(hi.toFixed(3)), awayImpl: parseFloat(ai.toFixed(3)),
    overUnder: (o.overUnder != null ? o.overUnder : null),
    provider: (o.provider && o.provider.name) ? o.provider.name : "ESPN BET", real: true
  };
}

// Overlay real pitcher season stats from an ESPN "probables" entry onto our
// generated pitcher line `p`, mutating it in place (matches the call sites,
// which build `p` fresh and immediately discard the return value).
function applyRealPitcher(p, prob) {
  if (!prob) return;
  var stats = prob.statistics || (prob.athlete && prob.athlete.statistics) || null;
  var gotReal = false;
  if (stats && stats.length) {
    stats.forEach(function(s) {
      var k = (s.name || s.abbreviation || "").toLowerCase();
      var v = s.displayValue || s.value;
      if (v == null) return;
      if (k.indexOf("era") === 0) { p.era = ("" + v); p.xfip = ("" + v); gotReal = true; }
      else if (k === "whip") { p.whip = ("" + v); gotReal = true; }
    });
  }
  if (prob.record) p.wl = ("" + prob.record);
  if (gotReal) { p.realQ = true; p.synth = false; }
}

// Overlay real W-L record/streak from an ESPN competitor entry onto a team's
// split record. Returns the updated split object (a fresh default if
// `existingSplit` is falsy and real data was found), or `existingSplit`
// unchanged if there's nothing usable in `comp`. Does not mutate its inputs.
function applyRealRecordCore(existingSplit, comp) {
  if (!comp) return existingSplit || null;
  var recs = comp.records;
  if (!recs || !recs.length) return existingSplit || null;
  var overall = recs.filter(function(r) { return r.type === "total" || r.name === "overall" || r.name === "Overall"; })[0] || recs[0];
  if (!overall || !overall.summary) return existingSplit || null;
  var split = existingSplit ? Object.assign({}, existingSplit) :
    { rec: "0-0", home: "0-0", away: "0-0", l10: "5-5", vsR: .500, vsL: .500, day: .500, night: .500, rd: "+0", oneRun: "0-0", streak: "-" };
  split.rec = overall.summary; split._real = true;
  var home = recs.filter(function(r) { return r.type === "home" || r.name === "Home"; })[0];
  var away = recs.filter(function(r) { return r.type === "road" || r.name === "Road" || r.name === "Away"; })[0];
  if (home && home.summary) split.home = home.summary;
  if (away && away.summary) split.away = away.summary;
  return split;
}

return {
  ourAbbrFromEspn: ourAbbrFromEspn,
  weatherFromESPN: weatherFromESPN,
  realOddsFromESPN: realOddsFromESPN,
  applyRealPitcher: applyRealPitcher,
  applyRealRecordCore: applyRealRecordCore
};

});
