// Persistence parsing/migration logic: turning a raw (possibly missing,
// corrupt, or stale-schema) localStorage string into a safe in-memory value.
// Pulled out of the inline script so the "what if this is garbage" paths are
// unit testable without a real localStorage.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// Parse a raw stored weights JSON string. Falls back to defaults if the value
// is missing, isn't valid JSON, or was written by an old, incompatible schema
// (rather than silently running the model on half-migrated weights). Any
// individual key missing from an otherwise-valid save is backfilled from
// defaults, so adding a new weight later doesn't require a schema bump.
function parseStoredWeights(raw, defaults, schema) {
  try {
    if (raw) {
      var w = JSON.parse(raw);
      if (w.__schema !== schema) return Object.assign({}, defaults, { __schema: schema });
      for (var k in defaults) { if (w[k] === undefined) w[k] = defaults[k]; }
      return w;
    }
  } catch (e) { /* corrupt JSON -> fall through to defaults */ }
  return Object.assign({}, defaults, { __schema: schema });
}

// Parse a raw stored backtest-store JSON string (a map of gameId -> graded
// game). Missing/corrupt -> empty store, never a thrown error.
function parseBacktestStore(raw) {
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

// Does this backtest store contain real graded games saved under an older,
// incompatible schema? (Used to prompt the user to rebuild rather than trust
// grades computed under since-changed model logic.)
function isBacktestStale(store, currentSchema) {
  var keys = Object.keys(store || {}).filter(function(k) { return k.indexOf("__") !== 0; });
  return keys.length > 0 && store.__schema !== currentSchema;
}

return {
  parseStoredWeights: parseStoredWeights,
  parseBacktestStore: parseBacktestStore,
  isBacktestStale: isBacktestStale
};

});
