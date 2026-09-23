// Coverage check: every scheduled game must have a frozen pregame pick at
// least 15 minutes before first pitch. Returns alerts for the dashboard and
// the pipeline log, each with the best reason we can determine.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  root.DSCoverage = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  var LEAD_MS = 15 * 60000;
  var SKIP_STATUS = { postponed: 1, canceled: 1 };

  // games: [{id, firstPitch, status, home, away}]; picks: {gameId: pick}
  // context: {lastRunAt, apiErrors: {YYYYMMDD: message}, date}
  function coverageCheck(games, picks, now, context) {
    context = context || {};
    var alerts = [];
    (games || []).forEach(function(g) {
      if (!g || SKIP_STATUS[g.status]) return;
      if (picks && picks[g.id]) return;
      if (!(now >= g.firstPitch - LEAD_MS)) return;
      var reason;
      if (context.apiErrors && context.apiErrors[g.date]) reason = "ESPN request failed: " + context.apiErrors[g.date];
      else if (now >= g.firstPitch) reason = "no pipeline run froze a pick before first pitch" + (context.lastRunAt ? " (previous run " + context.lastRunAt + ")" : "");
      else reason = "not frozen 15 minutes before first pitch";
      alerts.push({ gameId: String(g.id), date: g.date, matchup: (g.away || "?") + " @ " + (g.home || "?"), firstPitch: g.firstPitch,
        severity: now >= g.firstPitch ? "missed" : "late", reason: reason, detectedAt: new Date(now).toISOString() });
    });
    return alerts;
  }

  function seasonCoverage(games, predictedIds) {
    var scheduled = 0, completed = 0, predicted = 0, missing = [];
    (games || []).forEach(function(g) {
      if (SKIP_STATUS[g.status]) return;
      scheduled++;
      if (g.status !== "final") return;
      completed++;
      if (predictedIds[g.id]) predicted++; else missing.push(g.id);
    });
    return { scheduled: scheduled, completed: completed, predicted: predicted, missing: missing };
  }

  return { LEAD_MS: LEAD_MS, coverageCheck: coverageCheck, seasonCoverage: seasonCoverage };
});
