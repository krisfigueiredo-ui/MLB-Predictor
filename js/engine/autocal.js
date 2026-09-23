// Self-maintaining calibration state. One pure function, refit(), is called
// after each day's games are graded (pipeline) and on dashboard load when the
// last fit is more than 24h old (browser). It
//   1. fits a calibrator on a rolling, recency-weighted window of walk-forward
//      predictions, choosing the method by sample size (the ladder);
//   2. promotes it only if it beats the incumbent on recent held-out games;
//   3. runs the drift monitor (slope, bucket error, model-vs-market Brier) and
//      applies its automatic actions (tighten cap, raise w, pause, recover);
//   4. re-optimizes the market weight w within [0.5, 1], at most ±0.1 per refit;
//   5. records a new version whenever anything changed (last 30 kept).
// The state is plain JSON so it can be committed to the data branch, stored in
// localStorage, diffed, and rolled back.
(function(root, factory) {
  var P = (typeof module !== "undefined" && module.exports) ? require("./probability") : root.DSProb;
  var mod = factory(P);
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  root.DSAutoCal = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function(P) {
  var DAY = 86400000;
  var SCHEMA = 1, MAX_VERSIONS = 30, MAX_LOG = 300, MAX_HISTORY = 400;
  var DEFAULTS = {
    window: 60, halfLife: 21, bestMethod: "isotonic", gateDays: 14, driftDays: 14,
    minGateOlder: 60, minSlopeN: 50, minMarketN: 30, w0: 0.7, wLo: 0.5, wHi: 1, wStep: 0.1
  };

  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function round(x, d) { return x == null || !isFinite(x) ? x : Number(x.toFixed(d == null ? 4 : d)); }
  function ymdToMs(ymd) { ymd = String(ymd); return Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)); }
  function dayDiff(a, b) { return Math.round((ymdToMs(b) - ymdToMs(a)) / DAY); }

  function initialState(opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    return {
      schema: SCHEMA,
      current: {
        version: 0,
        calibrator: { method: "shrink-fixed", params: { alpha: P.FIXED_SHRINK }, n: 0, fitDate: null, window: opts.window, halfLife: opts.halfLife },
        w: opts.w0, wOpt: null, capTightened: false, cap: P.capFor("shrink-fixed", false),
        paused: false, pausedSince: null, stepdown: false, lastStepDate: null,
        badDays: 0, goodDays: 0, inRangeDays: 0,
        modelConfig: clone(opts.modelConfig || null),
        driftStatus: "green", driftReasons: [],
        lastRefit: null, lastRefitDate: null, metrics: null
      },
      versions: [],
      log: [],
      metricsHistory: []
    };
  }

  function calibratorVersion(state) { return "cal-v" + ((state && state.current && state.current.version) || 0); }

  function predict(state, rawP, marketP) {
    var cur = (state && state.current) || initialState().current;
    var calP = P.applyCalibrator(cur.calibrator, rawP, cur.cap);
    var hasMarket = P.finite(marketP);
    var w = cur.paused ? 1 : cur.w;
    return {
      rawP: rawP, calP: calP, marketP: hasMarket ? marketP : null,
      finalP: hasMarket ? P.blend(marketP, calP, w) : calP,
      w: hasMarket ? w : null, paused: !!cur.paused,
      calibratorVersion: calibratorVersion(state),
      modelConfigVersion: cur.modelConfig && cur.modelConfig.version || null
    };
  }

  function weightRows(rows, now, halfLife) {
    return rows.map(function(r) {
      var age = Math.max(0, (now - r.firstPitch) / DAY);
      return { p: r.rawP, y: r.y, w: Math.pow(0.5, age / halfLife), firstPitch: r.firstPitch };
    });
  }

  function evalLL(cal, cap, rows) {
    return P.logLoss(rows.map(function(r) { return { p: P.applyCalibrator(cal, r.rawP, cap), y: r.y }; }));
  }

  function pushLog(state, at, event, detail) {
    state.log.push({ at: at, event: event, detail: detail });
    if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG);
  }

  function driftMetrics(recent) {
    var cal = P.summarize(recent.map(function(r) { return { p: r.calP, y: r.y }; }));
    var fin = P.summarize(recent.map(function(r) { return { p: r.finalP, y: r.y }; }));
    var odds = recent.filter(function(r) { return P.finite(r.marketP) && P.finite(r.calP); });
    var modelBrier = odds.length ? P.brier(odds.map(function(r) { return { p: r.calP, y: r.y }; })) : null;
    var marketBrier = odds.length ? P.brier(odds.map(function(r) { return { p: r.marketP, y: r.y }; })) : null;
    return {
      n: recent.length, brier: round(fin.brier), logLoss: round(fin.logLoss),
      modelBrier14: round(cal.brier), slope: round(cal.slope, 3), slopeSE: round(cal.slopeSE, 3), maxBucketError: round(cal.maxBucketError),
      oddsN: odds.length, modelBrierOdds: round(modelBrier), marketBrierOdds: round(marketBrier)
    };
  }

  // rows: graded walk-forward rows {firstPitch, date, rawP, calP, finalP, marketP, y}
  // opts: {now (ms), asOfDate (YYYYMMDD), window, halfLife, bestMethod, modelConfig, force}
  function refit(prevState, rows, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var state = prevState ? clone(prevState) : initialState(opts);
    var cur = state.current, before = JSON.stringify(cur);
    var now = opts.now, asOf = String(opts.asOfDate), atIso = new Date(now).toISOString();
    if (opts.modelConfig) {
      if (!cur.modelConfig || cur.modelConfig.version !== opts.modelConfig.version) pushLog(state, atIso, "model-config", "model config " + opts.modelConfig.version + " active");
      cur.modelConfig = clone(opts.modelConfig);
    }
    var windowDays = opts.window, hl = opts.halfLife;
    var graded = (rows || []).filter(function(r) {
      return r && (r.y === 0 || r.y === 1) && P.finite(r.rawP) && P.finite(r.firstPitch) && r.firstPitch < now;
    }).sort(function(a, b) { return a.firstPitch - b.firstPitch; });
    var win = graded.filter(function(r) { return r.firstPitch >= now - windowDays * DAY; });
    var n = win.length, method = P.ladderMethod(n, opts.bestMethod);

    // 1-2. candidate + promotion gate
    var incumbent = cur.calibrator, promote, gate = null;
    var fullFit = P.fitCalibrator(method, weightRows(win, now, hl));
    if (method === "shrink-fixed") {
      promote = true; gate = { reason: "n<100: fixed shrink, no fitted calibrator" };
    } else if (!incumbent || incumbent.method === "shrink-fixed") {
      // The n<100 regime is "no fitted calibrator", so there is no incumbent to
      // beat: the ladder hands over to its first fitted method directly. The
      // gate governs every replacement after that.
      promote = true; gate = { reason: "first fitted calibrator (ladder: n=" + n + ")" };
    } else {
      var cutoff = now - opts.gateDays * DAY;
      var older = win.filter(function(r) { return r.firstPitch < cutoff; });
      var recent = win.filter(function(r) { return r.firstPitch >= cutoff; });
      var split = "last " + opts.gateDays + " days";
      if (older.length < opts.minGateOlder) {
        var k = Math.max(20, Math.round(0.3 * n));
        older = win.slice(0, n - k); recent = win.slice(n - k); split = "last " + k + " games (too few rows before the 14-day window)";
      }
      var cand = P.fitCalibrator(method, weightRows(older, now, hl));
      var candCap = P.capFor(method, cur.capTightened), incCap = cur.cap;
      var llCand = evalLL(cand, candCap, recent), llInc = evalLL(incumbent, incCap, recent);
      promote = llCand <= llInc + 1e-12;
      gate = { heldOut: split, nHeldOut: recent.length, candidateLogLoss: round(llCand, 5), incumbentLogLoss: round(llInc, 5), candidateMethod: method, incumbentMethod: incumbent && incumbent.method };
    }
    if (promote) {
      var changed = !incumbent || incumbent.method !== fullFit.method || JSON.stringify(incumbent.params) !== JSON.stringify(fullFit.params);
      cur.calibrator = { method: fullFit.method, params: fullFit.params, n: n, fitDate: atIso, window: windowDays, halfLife: hl, gate: gate };
      if (fullFit.fallbackFrom) cur.calibrator.fallbackFrom = fullFit.fallbackFrom;
      cur.cap = P.capFor(fullFit.method, cur.capTightened);
      if (changed) pushLog(state, atIso, "calibrator-promoted", fullFit.method + " n=" + n + (gate && gate.candidateLogLoss != null ? " (held-out LL " + gate.candidateLogLoss + " vs " + gate.incumbentLogLoss + ")" : ""));
    } else {
      cur.calibrator.gate = gate;
      pushLog(state, atIso, "calibrator-kept", "candidate " + method + " held-out LL " + gate.candidateLogLoss + " > incumbent " + gate.incumbentLogLoss + " on " + gate.heldOut + " (n=" + gate.nHeldOut + ")");
    }

    // 3. drift monitor on what was actually published over the last 14 days
    var recent14 = graded.filter(function(r) { return r.firstPitch >= now - opts.driftDays * DAY && P.finite(r.calP) && P.finite(r.finalP); });
    var dm = driftMetrics(recent14);
    var newDay = cur.lastRefitDate !== asOf;
    var slopeAction = false, reasons = [];
    // A 14-day window holds ~200 games, so the slope's standard error is often
    // ±0.4: act only when the slope is outside 0.7–1.3 AND significantly
    // different from 1 (95%), otherwise noise alone would keep firing it.
    var slopeSignificant = dm.slopeSE != null && Math.abs(dm.slope - 1) > 1.96 * dm.slopeSE;
    if (dm.n >= opts.minSlopeN && dm.slope != null && (dm.slope < 0.7 || dm.slope > 1.3) && slopeSignificant) {
      if (newDay && !cur.capTightened) {
        // One action per drift episode: tighten the cap, lean 0.1 further on the
        // market, and hold that w as a floor until the episode clears.
        slopeAction = true;
        cur.capTightened = true; cur.cap = P.capFor(cur.calibrator.method, true);
        var wUp = Math.min(1, round(cur.w + 0.1, 2));
        pushLog(state, atIso, "drift-slope", "14-day slope " + dm.slope + " outside 0.7–1.3: cap tightened to [0.42, 0.60], w " + cur.w + " → " + wUp);
        cur.w = wUp; cur.wFloor = wUp;
      }
      if (newDay) cur.inRangeDays = 0;
      reasons.push("slope " + dm.slope + " outside 0.7–1.3");
    }
    else if (newDay && cur.capTightened) {
      var inRange = dm.slope != null && ((dm.slope >= 0.8 && dm.slope <= 1.2) || !slopeSignificant);
      cur.inRangeDays = inRange ? (cur.inRangeDays || 0) + 1 : 0;
      if (cur.inRangeDays >= 14) {
        cur.capTightened = false; cur.cap = P.capFor(cur.calibrator.method, false); cur.inRangeDays = 0; cur.wFloor = null;
        pushLog(state, atIso, "drift-cap-relaxed", "slope in 0.8–1.2 (or not significantly off 1) for 14 days");
      }
    }
    var bad = dm.oddsN >= opts.minMarketN && dm.modelBrierOdds > dm.marketBrierOdds;
    if (newDay) {
      if (bad) { cur.badDays = (cur.badDays || 0) + 1; cur.goodDays = 0; }
      else if (dm.oddsN >= opts.minMarketN) { cur.goodDays = (cur.goodDays || 0) + 1; cur.badDays = 0; }
    }
    if (!cur.paused && cur.badDays >= 14) {
      cur.paused = true; cur.pausedSince = asOf; cur.stepdown = false; cur.w = 1;
      pushLog(state, atIso, "model-paused", "model Brier worse than market for 14 straight days: w=1.0, +EV flags off");
    } else if (cur.paused && cur.goodDays >= 14) {
      cur.paused = false; cur.stepdown = true; cur.lastStepDate = asOf; cur.pausedSince = null;
      pushLog(state, atIso, "model-recovered", "14 days at or better than market: stepping w down 0.1 per week");
    }

    // 4. market weight
    var wOpt = P.optimizeW(graded.filter(function(r) { return r.firstPitch >= now - windowDays * DAY; })
      .map(function(r) { return { marketP: r.marketP, calP: r.calP, y: r.y, w: Math.pow(0.5, Math.max(0, (now - r.firstPitch) / DAY) / hl) }; }),
      opts.wLo, opts.wHi, 0.05);
    cur.wOpt = wOpt ? wOpt.w : null;
    if (cur.paused) cur.w = 1;
    else if (cur.stepdown) {
      if (newDay && dayDiff(cur.lastStepDate, asOf) >= 7) {
        var target = cur.wOpt == null ? opts.wLo : cur.wOpt;
        cur.w = Math.max(target, round(cur.w - 0.1, 2)); cur.lastStepDate = asOf;
        pushLog(state, atIso, "w-stepdown", "w stepped to " + cur.w);
      }
      if (cur.wOpt != null && cur.w <= cur.wOpt + 1e-9) cur.stepdown = false;
    } else if (newDay && !slopeAction && cur.wOpt != null) {
      var move = Math.max(-opts.wStep, Math.min(opts.wStep, cur.wOpt - cur.w));
      cur.w = Math.max(opts.wLo, cur.wFloor || 0, Math.min(opts.wHi, round(cur.w + move, 2)));
    }

    // status
    if (cur.paused) reasons.push("paused: no edge vs market");
    if (bad) reasons.push("14-day model Brier " + dm.modelBrierOdds + " > market " + dm.marketBrierOdds);
    if (dm.maxBucketError != null && dm.maxBucketError > 0.05) reasons.push("bucket error " + dm.maxBucketError + " > 0.05");
    if (dm.slope != null && dm.n >= opts.minSlopeN && (dm.slope < 0.8 || dm.slope > 1.2) && reasons.indexOf("slope " + dm.slope + " outside 0.7–1.3") < 0) reasons.push("slope " + dm.slope + " outside 0.8–1.2");
    cur.driftStatus = cur.paused ? "red" : (reasons.length || cur.capTightened || cur.stepdown) ? "amber" : "green";
    cur.driftReasons = reasons;
    cur.metrics = dm;
    cur.lastRefit = atIso; cur.lastRefitDate = asOf;
    if (newDay) {
      state.metricsHistory.push(Object.assign({ date: asOf, w: cur.w, method: cur.calibrator.method, paused: cur.paused }, dm));
      if (state.metricsHistory.length > MAX_HISTORY) state.metricsHistory = state.metricsHistory.slice(-MAX_HISTORY);
    }

    // 5. versioning: bump only when the published mapping or its controls changed
    var fingerprint = function(c) { return JSON.stringify([c.calibrator.method, c.calibrator.params, c.w, c.cap, c.paused, c.modelConfig && c.modelConfig.version]); };
    var prev = JSON.parse(before);
    if (!state.versions.length || fingerprint(prev) !== fingerprint(cur)) {
      cur.version = (prev.version || 0) + 1;
      state.versions.push(clone(cur));
      if (state.versions.length > MAX_VERSIONS) state.versions = state.versions.slice(-MAX_VERSIONS);
    } else {
      cur.version = prev.version;
    }
    return state;
  }

  function rollback(state, version, at) {
    var target = (state.versions || []).filter(function(v) { return v.version === version; })[0];
    if (!target) return null;
    var next = clone(state);
    var restored = clone(target);
    restored.version = (state.current.version || 0) + 1;
    restored.rolledBackFrom = version;
    next.current = restored;
    next.versions.push(clone(restored));
    if (next.versions.length > MAX_VERSIONS) next.versions = next.versions.slice(-MAX_VERSIONS);
    pushLog(next, at || new Date().toISOString(), "rollback", "restored version " + version + " as " + restored.version);
    return next;
  }

  function needsRefit(state, now) {
    if (!state || !state.current || !state.current.lastRefit) return true;
    return now - Date.parse(state.current.lastRefit) > DAY;
  }

  // Persistence through any Storage-like adapter (localStorage in the browser,
  // an in-memory shim in tests). Corrupt or foreign data falls back to null.
  var STORAGE_KEY = "ds_autocal_state_v1";
  function save(storage, state) { try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; } catch (e) { return false; } }
  function load(storage) {
    try {
      var s = JSON.parse(storage.getItem(STORAGE_KEY));
      return s && s.schema === SCHEMA && s.current ? s : null;
    } catch (e) { return null; }
  }
  // The newer of two states by last refit (repo state vs a local browser refit).
  function newest(a, b) {
    if (!a) return b; if (!b) return a;
    return Date.parse(a.current.lastRefit || 0) >= Date.parse(b.current.lastRefit || 0) ? a : b;
  }

  return {
    SCHEMA: SCHEMA, DEFAULTS: DEFAULTS, STORAGE_KEY: STORAGE_KEY, MAX_VERSIONS: MAX_VERSIONS,
    initialState: initialState, refit: refit, predict: predict, rollback: rollback, needsRefit: needsRefit,
    calibratorVersion: calibratorVersion, save: save, load: load, newest: newest, ymdToMs: ymdToMs, dayDiff: dayDiff
  };
});
