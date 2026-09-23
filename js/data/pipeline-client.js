// Browser side of the pipeline. Loads what the scheduled GitHub Action
// publishes on the `pipeline-data` branch (today's raw model probabilities,
// frozen picks, model/calibrator state, metrics), keeps the calibrator state
// fresh (refit on load when the last fit is >24h old, persisted to
// localStorage so it survives a reload), and turns raw_p + the live market
// into final_p. Edges and stakes are computed from final_p only.
(function(root) {
  var AC = root.DSAutoCal, EV = root.DSEv;
  var BASE = root.DS_PIPELINE_BASE || "https://raw.githubusercontent.com/krisfigueiredo-ui/MLB-Predictor/pipeline-data/data";
  var data = { today: null, metrics: null, model: null, state: null, localRefit: false, error: null, loadedAt: null, byGame: {} };

  function get(path) {
    return fetch(BASE + "/" + path + "?t=" + Math.floor(Date.now() / 60000), { cache: "no-store" })
      .then(function(r) { if (!r.ok) throw new Error(path + " HTTP " + r.status); return r.json(); });
  }
  function storage() { try { return root.localStorage; } catch (e) { return null; } }
  function etDate(ms) {
    var parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
    function part(t) { for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value; return ""; }
    return part("year") + part("month") + part("day");
  }

  function refitIfStale(model, state) {
    var now = Date.now();
    if (!AC.needsRefit(state, now)) return Promise.resolve(state);
    return Promise.all([get("backfill/predictions.json"), get("live/picks.json").catch(function() { return { picks: {} }; })]).then(function(res) {
      var byId = {};
      (res[0].rows || []).forEach(function(r) { if (r.y != null) byId[r.gameId] = r; });
      Object.keys(res[1].picks || {}).forEach(function(k) { var p = res[1].picks[k]; if (p.y != null) byId[p.gameId] = p; });
      var rows = Object.keys(byId).map(function(k) { return byId[k]; });
      var cfg = Object.assign({ version: model.configVersion }, model.config);
      var next = AC.refit(state, rows, { now: now, asOfDate: etDate(now), window: model.config.calWindow, halfLife: 21, bestMethod: model.config.calMethod, modelConfig: cfg });
      var s = storage();
      if (s) AC.save(s, next);
      data.localRefit = true;
      return next;
    });
  }

  function load() {
    if (!AC || !EV) return Promise.resolve(data);
    return Promise.all([get("live/today.json"), get("metrics/metrics.json").catch(function() { return null; }), get("state/model_state.json")])
      .then(function(res) {
        data.today = res[0]; data.metrics = res[1]; data.model = res[2];
        var s = storage(), local = s ? AC.load(s) : null;
        var state = AC.newest(data.model.autocal, local);
        return refitIfStale(data.model, state);
      })
      .then(function(state) {
        data.state = state; data.byGame = {};
        (data.today.games || []).forEach(function(g) { data.byGame[String(g.gameId)] = g; });
        data.loadedAt = Date.now(); data.error = null;
        if (typeof root.recomputeAll === "function" && root.GAMES30 && root.GAMES30.length) root.recomputeAll();
        else if (typeof root.renderToday === "function") root.renderToday();
        return data;
      })
      .catch(function(err) { data.error = String(err && err.message || err); return data; });
  }

  // final_p for a game: a frozen pick is immutable; otherwise raw_p from the
  // pipeline is calibrated with the current state and anchored to the live line.
  function finalFor(gameId, odds) {
    var g = data.byGame[String(gameId)];
    if (!g || !data.state) return null;
    if (g.frozen && g.frozenFinalP != null) return { rawP: g.frozenRawP, finalP: g.frozenFinalP, marketP: g.frozenMarketP, paused: !!g.frozenPaused, frozen: true, bet: g.frozenBet || null };
    if (g.rawP == null) return null;
    var marketP = odds && odds.real && odds.homeImpl != null ? odds.homeImpl : null;
    var pr = AC.predict(data.state, g.rawP, marketP);
    pr.frozen = false;
    return pr;
  }

  function status() {
    var st = data.state && data.state.current;
    return {
      ready: !!st, error: data.error, paused: !!(st && st.paused), driftStatus: st ? st.driftStatus : null,
      banner: st && st.paused ? "MODEL PAUSED — no edge" : null,
      alerts: (data.today && data.today.alerts) || [], localRefit: data.localRefit
    };
  }

  root.DSPipeline = { BASE: BASE, data: data, load: load, finalFor: finalFor, status: status, etDate: etDate };
})(typeof globalThis !== "undefined" ? globalThis : this);
