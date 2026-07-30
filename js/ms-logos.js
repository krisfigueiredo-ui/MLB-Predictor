// Logo, crest and flag resolution for every league in the catalog.
//
// ESPN serves images from a handful of CDN path shapes that differ by sport,
// and it does not document which shape a given league uses. Rather than guess
// once and render a broken image, every lookup returns an ordered *candidate
// list*: the UI tries them in order via onerror and lands on a generated
// monogram if they all fail. The monogram is an inline SVG data URI, so the
// final fallback never needs the network.
// Exposed as MS.logos in the browser and via module.exports under Node, so the
// nine modules never collide on the global scope.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.logos = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

var CDN = "https://a.espncdn.com";

// ESPN's country image folder uses 3-letter codes that are mostly, but not
// always, ISO-3166 alpha-3 (Saudi Arabia is "ksa", England is "eng").
var ISO2_TO_ESPN = {
  "gb-eng": "eng", "gb-sct": "sco", "gb-wls": "wal", "gb-nir": "nir",
  us: "usa", ca: "can", mx: "mex", cr: "crc", hn: "hon", gt: "gua", jm: "jam",
  pa: "pan", sv: "slv",
  br: "bra", ar: "arg", cl: "chi", co: "col", uy: "uru", pe: "per", ec: "ecu",
  py: "par", ve: "ven", bo: "bol",
  es: "esp", de: "ger", it: "ita", fr: "fra", nl: "ned", pt: "por", be: "bel",
  tr: "tur", gr: "gre", at: "aut", ch: "sui", dk: "den", no: "nor", se: "swe",
  fi: "fin", is: "isl", pl: "pol", cz: "cze", ro: "rou", hr: "cro", rs: "srb",
  ua: "ukr", ru: "rus", hu: "hun", bg: "bul", il: "isr", ie: "irl", cy: "cyp",
  sk: "svk", si: "slo",
  jp: "jpn", kr: "kor", cn: "chn", au: "aus", in: "ind", sa: "ksa", ae: "uae",
  qa: "qat", ir: "irn", za: "rsa", eg: "egy", ma: "mar", ng: "nga", tn: "tun",
  dz: "alg"
};

// Sports whose team art lives under a league-specific folder keyed by team
// abbreviation. Everything else is keyed by numeric team id.
var ABBREV_FOLDER = {
  "baseball/mlb": "mlb",
  "basketball/nba": "nba",
  "basketball/wnba": "wnba",
  "football/nfl": "nfl",
  "football/nfl-preseason": "nfl",
  "hockey/nhl": "nhl",
  "football/cfl": "cfl",
  "football/ufl": "ufl"
};

function isNumericId(id) { return id != null && /^\d+$/.test(String(id)); }

function dedupe(list) {
  var seen = {}, out = [];
  (list || []).forEach(function(u) {
    if (!u || seen[u]) return;
    seen[u] = 1;
    out.push(u);
  });
  return out;
}

// Deterministic hue from a string, so a given team always gets the same
// monogram colour across reloads.
function hashHue(s) {
  var h = 0, t = String(s || "");
  for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) & 0x7fffffff;
  return h % 360;
}

// Up to three initials: "Manchester United" -> MU, "Real Madrid" -> RM,
// "PSG" -> PSG, "Novak Djokovic" -> ND.
function initials(name) {
  var t = String(name || "").trim();
  if (!t) return "?";
  if (/^[A-Z0-9]{2,4}$/.test(t)) return t.slice(0, 3);
  var words = t.split(/[\s./-]+/).filter(function(w) {
    return w && !/^(fc|cf|sc|ac|as|afc|cd|ud|us|sv|vf[lb]|the|of|and|club|city)$/i.test(w);
  });
  if (!words.length) words = t.split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 2).map(function(w) { return w.charAt(0).toUpperCase(); }).join("");
}

// Inline SVG monogram -- the guaranteed-final fallback. No network needed.
function monogram(name, opts) {
  opts = opts || {};
  var text = opts.text || initials(name);
  var hue = opts.hue == null ? hashHue(name) : opts.hue;
  var size = opts.size || 64;
  var bg = opts.bg || ("hsl(" + hue + " 42% " + (opts.dark ? "26%" : "88%") + ")");
  var fg = opts.fg || ("hsl(" + hue + " 55% " + (opts.dark ? "82%" : "26%") + ")");
  var fontSize = text.length >= 3 ? size * 0.32 : size * 0.42;
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '">' +
    '<rect width="' + size + '" height="' + size + '" rx="' + (size * 0.24) + '" fill="' + bg + '"/>' +
    '<text x="50%" y="50%" dy="0.35em" text-anchor="middle" ' +
    'font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" ' +
    'font-size="' + fontSize.toFixed(1) + '" font-weight="700" fill="' + fg + '">' +
    text.replace(/[&<>"]/g, "") + "</text></svg>";
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

// Ordered logo candidates for a competitor in a league.
// The payload URL always wins -- ESPN told us where the art is, believe it.
function teamLogoCandidates(competitor, league, opts) {
  opts = opts || {};
  var c = competitor || {};
  var out = [];
  var size = opts.size || 500;

  if (c.logo) out.push(c.logo);
  if (c.flag) out.push(c.flag);

  var lid = league ? league.id : null;
  var sport = league ? league.sport : null;
  var folder = lid ? ABBREV_FOLDER[lid] : null;

  if (folder && c.abbrev) {
    out.push(CDN + "/i/teamlogos/" + folder + "/" + size + "/" + String(c.abbrev).toLowerCase() + ".png");
  }
  if (isNumericId(c.id)) {
    if (sport === "soccer") out.push(CDN + "/i/teamlogos/soccer/" + size + "/" + c.id + ".png");
    if (sport && /college|ncaa/.test(String(lid))) out.push(CDN + "/i/teamlogos/ncaa/" + size + "/" + c.id + ".png");
    if (folder) out.push(CDN + "/i/teamlogos/" + folder + "/" + size + "/" + c.id + ".png");
    // Generic per-sport folder covers the long tail (rugby, cricket, nbl, ...).
    if (sport) out.push(CDN + "/i/teamlogos/" + sport + "/" + size + "/" + c.id + ".png");
  }
  // Individual athletes: headshots live in a per-sport folder keyed by id.
  if (c.isAthlete && isNumericId(c.id) && sport) {
    out.push(CDN + "/i/headshots/" + sport + "/players/full/" + c.id + ".png");
  }
  return dedupe(out);
}

// Ordered league-crest candidates. `runtimeLogo` is leagues[0].logos[0].href
// from a scoreboard response, which is the only fully reliable source.
function leagueLogoCandidates(league, runtimeLogo, opts) {
  opts = opts || {};
  var size = opts.size || 500;
  var out = [];
  if (runtimeLogo) out.push(runtimeLogo);
  if (!league) return dedupe(out);
  var slug = league.slug, sport = league.sport;
  // US majors publish a crest keyed by slug.
  out.push(CDN + "/i/teamlogos/leagues/" + size + "/" + String(slug).toLowerCase() + ".png");
  if (sport === "soccer") {
    // Soccer crests are keyed by ESPN's numeric competition id, which we only
    // learn at runtime -- the slug form is a long shot but costs one 404.
    out.push(CDN + "/i/leaguelogos/soccer/" + size + "/" + String(slug).toLowerCase() + ".png");
  }
  out.push(CDN + "/i/leaguelogos/" + sport + "/" + size + "/" + String(slug).toLowerCase() + ".png");
  return dedupe(out);
}

// Country flag candidates from a region code (ISO-2, "gb-eng", or ESPN-3).
function flagCandidates(region, opts) {
  opts = opts || {};
  var size = opts.size || 500;
  var r = String(region || "").toLowerCase();
  if (!r || r === "world") return [];
  var out = [];
  var espn = ISO2_TO_ESPN[r];
  if (espn) out.push(CDN + "/i/teamlogos/countries/" + size + "/" + espn + ".png");
  // Already a 3-letter ESPN code, or a plain ISO-2 that ESPN also accepts.
  out.push(CDN + "/i/teamlogos/countries/" + size + "/" + r.replace(/[^a-z]/g, "") + ".png");
  return dedupe(out);
}

// A "world" region has no flag -- use a globe glyph instead of a broken image.
function isGlobalRegion(region) {
  var r = String(region || "").toLowerCase();
  return !r || r === "world" || r === "int" || r === "intl";
}

// Convenience: everything the UI needs to render one competitor's badge.
function competitorBadge(competitor, league, opts) {
  var c = competitor || {};
  return {
    candidates: teamLogoCandidates(c, league, opts),
    fallback: monogram(c.abbrev || c.shortName || c.name, opts),
    label: c.shortName || c.name || "TBD"
  };
}

function leagueBadge(league, runtimeLogo, opts) {
  return {
    candidates: leagueLogoCandidates(league, runtimeLogo, opts),
    flags: league ? flagCandidates(league.region, opts) : [],
    global: league ? isGlobalRegion(league.region) : true,
    fallback: monogram(league ? (league.short || league.name) : "?", opts),
    label: league ? league.name : ""
  };
}

return {
  CDN: CDN,
  ISO2_TO_ESPN: ISO2_TO_ESPN,
  initials: initials,
  hashHue: hashHue,
  monogram: monogram,
  teamLogoCandidates: teamLogoCandidates,
  leagueLogoCandidates: leagueLogoCandidates,
  flagCandidates: flagCandidates,
  isGlobalRegion: isGlobalRegion,
  competitorBadge: competitorBadge,
  leagueBadge: leagueBadge
};

});
