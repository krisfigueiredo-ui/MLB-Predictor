// Multi-sport league catalog + ESPN endpoint builders + runtime discovery.
//
// Two sources of leagues feed the dashboard:
//   1. CATALOG below -- a curated list with the metadata the models need
//      (competition kind, home-advantage prior, Elo K, expected scoring).
//   2. ESPN's own sports directory, fetched at runtime and merged in by
//      mergeDiscovered(). Anything ESPN exposes that we didn't hand-write
//      still shows up, with defaults inferred from its sport.
//
// This split matters because ESPN adds/retires leagues without notice: the
// curated rows give good priors for the leagues we know, and discovery keeps
// the dashboard from silently missing the rest.
// Exposed as MS.leagues in the browser and via module.exports under Node, so the
// nine modules never collide on the global scope.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.leagues = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// Competition kinds drive which probability model runs:
//   team  - two clubs, a winner is always produced (NBA/NFL/MLB/NHL/college)
//   draw  - two clubs, regulation draw is a real outcome (soccer, some cricket)
//   duel  - two individual athletes (tennis, MMA, boxing)
//   field - many entrants, one winner (golf, motorsport)
var KINDS = { TEAM: "team", DRAW: "draw", DUEL: "duel", FIELD: "field" };

// Per-sport defaults. hfa is in Elo points, k is the Elo update rate, total is
// the expected combined score used to scale margin features.
var SPORT_DEFAULTS = {
  "football":       { kind: KINDS.TEAM,  hfa: 55, k: 20, total: 44,  unit: "pts" },
  "basketball":     { kind: KINDS.TEAM,  hfa: 45, k: 20, total: 226, unit: "pts" },
  "baseball":       { kind: KINDS.TEAM,  hfa: 24, k: 6,  total: 8.6, unit: "runs" },
  "hockey":         { kind: KINDS.TEAM,  hfa: 35, k: 8,  total: 6.1, unit: "goals" },
  "soccer":         { kind: KINDS.DRAW,  hfa: 60, k: 20, total: 2.7, unit: "goals" },
  "tennis":         { kind: KINDS.DUEL,  hfa: 0,  k: 24, total: 0,   unit: "sets" },
  "mma":            { kind: KINDS.DUEL,  hfa: 0,  k: 28, total: 0,   unit: "" },
  "boxing":         { kind: KINDS.DUEL,  hfa: 0,  k: 28, total: 0,   unit: "" },
  "golf":           { kind: KINDS.FIELD, hfa: 0,  k: 16, total: 0,   unit: "strokes" },
  "racing":         { kind: KINDS.FIELD, hfa: 0,  k: 16, total: 0,   unit: "" },
  "cricket":        { kind: KINDS.TEAM,  hfa: 45, k: 16, total: 0,   unit: "runs" },
  "rugby":          { kind: KINDS.DRAW,  hfa: 55, k: 20, total: 45,  unit: "pts" },
  "volleyball":     { kind: KINDS.TEAM,  hfa: 40, k: 20, total: 0,   unit: "sets" },
  "lacrosse":       { kind: KINDS.TEAM,  hfa: 45, k: 20, total: 22,  unit: "goals" },
  "water-polo":     { kind: KINDS.TEAM,  hfa: 40, k: 20, total: 20,  unit: "goals" },
  "field-hockey":   { kind: KINDS.DRAW,  hfa: 40, k: 20, total: 3.5, unit: "goals" },
  "softball":       { kind: KINDS.TEAM,  hfa: 30, k: 8,  total: 7,   unit: "runs" },
  "olympics":       { kind: KINDS.FIELD, hfa: 0,  k: 16, total: 0,   unit: "" },
  "athletics":      { kind: KINDS.FIELD, hfa: 0,  k: 16, total: 0,   unit: "" }
};

var GENERIC_DEFAULT = { kind: KINDS.TEAM, hfa: 40, k: 20, total: 0, unit: "" };

function sportDefaults(sport) {
  return SPORT_DEFAULTS[sport] || GENERIC_DEFAULT;
}

// Curated rows: [sport, slug, displayName, shortName, region]
// `region` is used for grouping in the UI and for country-flag lookup.
var CURATED = [
  // ---- American football
  ["football", "nfl", "NFL", "NFL", "us"],
  ["football", "college-football", "NCAA Football", "NCAAF", "us"],
  ["football", "ufl", "United Football League", "UFL", "us"],
  ["football", "cfl", "Canadian Football League", "CFL", "ca"],
  ["football", "xfl", "XFL", "XFL", "us"],
  ["football", "nfl-preseason", "NFL Preseason", "NFL PRE", "us"],

  // ---- Basketball
  ["basketball", "nba", "NBA", "NBA", "us"],
  ["basketball", "wnba", "WNBA", "WNBA", "us"],
  ["basketball", "mens-college-basketball", "NCAA Men's Basketball", "NCAAM", "us"],
  ["basketball", "womens-college-basketball", "NCAA Women's Basketball", "NCAAW", "us"],
  ["basketball", "nba-development", "NBA G League", "G LEAGUE", "us"],
  ["basketball", "nbl", "Australian NBL", "NBL", "au"],
  ["basketball", "fiba-world-championship", "FIBA World Cup", "FIBA WC", "world"],
  ["basketball", "olympics-men-basketball", "Olympic Basketball (M)", "OLY M", "world"],
  ["basketball", "olympics-women-basketball", "Olympic Basketball (W)", "OLY W", "world"],

  // ---- Baseball
  ["baseball", "mlb", "MLB", "MLB", "us"],
  ["baseball", "college-baseball", "NCAA Baseball", "NCAA BSB", "us"],
  ["baseball", "llb", "Little League Baseball", "LLB", "world"],
  ["baseball", "olympics-men-baseball", "Olympic Baseball", "OLY BSB", "world"],

  // ---- Hockey
  ["hockey", "nhl", "NHL", "NHL", "us"],
  ["hockey", "mens-college-hockey", "NCAA Men's Hockey", "NCAA M HKY", "us"],
  ["hockey", "womens-college-hockey", "NCAA Women's Hockey", "NCAA W HKY", "us"],
  ["hockey", "world-cup-of-hockey", "World Cup of Hockey", "WCH", "world"],
  ["hockey", "mens-olympic-hockey", "Olympic Hockey (M)", "OLY HKY", "world"],

  // ---- Soccer: England
  ["soccer", "eng.1", "Premier League", "EPL", "gb-eng"],
  ["soccer", "eng.2", "EFL Championship", "CHAMP", "gb-eng"],
  ["soccer", "eng.3", "EFL League One", "L1", "gb-eng"],
  ["soccer", "eng.4", "EFL League Two", "L2", "gb-eng"],
  ["soccer", "eng.5", "National League", "NL", "gb-eng"],
  ["soccer", "eng.fa", "FA Cup", "FA CUP", "gb-eng"],
  ["soccer", "eng.league_cup", "EFL Cup", "EFL CUP", "gb-eng"],
  ["soccer", "eng.charity", "FA Community Shield", "SHIELD", "gb-eng"],
  ["soccer", "eng.w.1", "Women's Super League", "WSL", "gb-eng"],

  // ---- Soccer: Spain / Germany / Italy / France
  ["soccer", "esp.1", "LaLiga", "LALIGA", "es"],
  ["soccer", "esp.2", "LaLiga 2", "LALIGA2", "es"],
  ["soccer", "esp.copa_del_rey", "Copa del Rey", "COPA", "es"],
  ["soccer", "esp.super_cup", "Spanish Supercopa", "SUPERCOPA", "es"],
  ["soccer", "ger.1", "Bundesliga", "BUND", "de"],
  ["soccer", "ger.2", "2. Bundesliga", "BUND2", "de"],
  ["soccer", "ger.dfb_pokal", "DFB Pokal", "POKAL", "de"],
  ["soccer", "ger.super_cup", "German Super Cup", "GER SC", "de"],
  ["soccer", "ita.1", "Serie A", "SERIE A", "it"],
  ["soccer", "ita.2", "Serie B", "SERIE B", "it"],
  ["soccer", "ita.coppa_italia", "Coppa Italia", "COPPA", "it"],
  ["soccer", "ita.super_cup", "Supercoppa Italiana", "ITA SC", "it"],
  ["soccer", "fra.1", "Ligue 1", "LIGUE 1", "fr"],
  ["soccer", "fra.2", "Ligue 2", "LIGUE 2", "fr"],
  ["soccer", "fra.coupe_de_france", "Coupe de France", "CDF", "fr"],
  ["soccer", "fra.super_cup", "Trophée des Champions", "FRA SC", "fr"],

  // ---- Soccer: rest of Europe
  ["soccer", "ned.1", "Eredivisie", "ERE", "nl"],
  ["soccer", "ned.2", "Eerste Divisie", "ERE2", "nl"],
  ["soccer", "por.1", "Primeira Liga", "POR", "pt"],
  ["soccer", "sco.1", "Scottish Premiership", "SPFL", "gb-sct"],
  ["soccer", "sco.2", "Scottish Championship", "SPFL2", "gb-sct"],
  ["soccer", "bel.1", "Belgian Pro League", "BEL", "be"],
  ["soccer", "tur.1", "Süper Lig", "TUR", "tr"],
  ["soccer", "gre.1", "Super League Greece", "GRE", "gr"],
  ["soccer", "aut.1", "Austrian Bundesliga", "AUT", "at"],
  ["soccer", "sui.1", "Swiss Super League", "SUI", "ch"],
  ["soccer", "den.1", "Danish Superliga", "DEN", "dk"],
  ["soccer", "nor.1", "Eliteserien", "NOR", "no"],
  ["soccer", "swe.1", "Allsvenskan", "SWE", "se"],
  ["soccer", "fin.1", "Veikkausliiga", "FIN", "fi"],
  ["soccer", "isl.1", "Besta deild karla", "ISL", "is"],
  ["soccer", "pol.1", "Ekstraklasa", "POL", "pl"],
  ["soccer", "cze.1", "Czech First League", "CZE", "cz"],
  ["soccer", "rou.1", "Liga I", "ROU", "ro"],
  ["soccer", "cro.1", "Croatian Football League", "CRO", "hr"],
  ["soccer", "srb.1", "Serbian SuperLiga", "SRB", "rs"],
  ["soccer", "ukr.1", "Ukrainian Premier League", "UKR", "ua"],
  ["soccer", "rus.1", "Russian Premier League", "RUS", "ru"],
  ["soccer", "hun.1", "Nemzeti Bajnokság I", "HUN", "hu"],
  ["soccer", "bul.1", "Bulgarian First League", "BUL", "bg"],
  ["soccer", "isr.1", "Israeli Premier League", "ISR", "il"],
  ["soccer", "irl.1", "League of Ireland", "IRL", "ie"],
  ["soccer", "cyp.1", "Cypriot First Division", "CYP", "cy"],

  // ---- Soccer: North & Central America
  ["soccer", "usa.1", "Major League Soccer", "MLS", "us"],
  ["soccer", "usa.nwsl", "NWSL", "NWSL", "us"],
  ["soccer", "usa.usl.1", "USL Championship", "USL", "us"],
  ["soccer", "usa.usl.l1", "USL League One", "USL1", "us"],
  ["soccer", "usa.open", "US Open Cup", "USOC", "us"],
  ["soccer", "usa.ncaa.m.1", "NCAA Men's Soccer", "NCAA M", "us"],
  ["soccer", "usa.ncaa.w.1", "NCAA Women's Soccer", "NCAA W", "us"],
  ["soccer", "mex.1", "Liga MX", "LIGA MX", "mx"],
  ["soccer", "mex.2", "Liga de Expansión MX", "MX2", "mx"],
  ["soccer", "can.1", "Canadian Premier League", "CPL", "ca"],
  ["soccer", "crc.1", "Liga FPD", "CRC", "cr"],
  ["soccer", "hon.1", "Liga Nacional", "HON", "hn"],
  ["soccer", "gua.1", "Liga Nacional", "GUA", "gt"],
  ["soccer", "jam.1", "Jamaica Premier League", "JAM", "jm"],

  // ---- Soccer: South America
  ["soccer", "bra.1", "Brasileirão Série A", "BRA", "br"],
  ["soccer", "bra.2", "Brasileirão Série B", "BRA2", "br"],
  ["soccer", "arg.1", "Liga Profesional", "ARG", "ar"],
  ["soccer", "chi.1", "Primera División", "CHI", "cl"],
  ["soccer", "col.1", "Categoría Primera A", "COL", "co"],
  ["soccer", "uru.1", "Primera División", "URU", "uy"],
  ["soccer", "per.1", "Liga 1", "PER", "pe"],
  ["soccer", "ecu.1", "Liga Pro", "ECU", "ec"],
  ["soccer", "par.1", "División Profesional", "PAR", "py"],
  ["soccer", "ven.1", "Liga FUTVE", "VEN", "ve"],
  ["soccer", "bol.1", "División Profesional", "BOL", "bo"],

  // ---- Soccer: Asia, Oceania, Africa
  ["soccer", "jpn.1", "J1 League", "J1", "jp"],
  ["soccer", "kor.1", "K League 1", "K1", "kr"],
  ["soccer", "chn.1", "Chinese Super League", "CSL", "cn"],
  ["soccer", "aus.1", "A-League Men", "A-LEAGUE", "au"],
  ["soccer", "ind.1", "Indian Super League", "ISL IND", "in"],
  ["soccer", "sau.1", "Saudi Pro League", "SPL", "sa"],
  ["soccer", "uae.1", "UAE Pro League", "UAE", "ae"],
  ["soccer", "qat.1", "Qatar Stars League", "QAT", "qa"],
  ["soccer", "irn.1", "Persian Gulf Pro League", "IRN", "ir"],
  ["soccer", "rsa.1", "South African Premiership", "PSL", "za"],
  ["soccer", "egy.1", "Egyptian Premier League", "EGY", "eg"],
  ["soccer", "mar.1", "Botola Pro", "MAR", "ma"],
  ["soccer", "nga.1", "Nigeria Professional League", "NGA", "ng"],

  // ---- Soccer: continental & international
  ["soccer", "uefa.champions", "UEFA Champions League", "UCL", "world"],
  ["soccer", "uefa.europa", "UEFA Europa League", "UEL", "world"],
  ["soccer", "uefa.europa.conf", "UEFA Conference League", "UECL", "world"],
  ["soccer", "uefa.super_cup", "UEFA Super Cup", "USC", "world"],
  ["soccer", "uefa.nations", "UEFA Nations League", "UNL", "world"],
  ["soccer", "uefa.euro", "UEFA European Championship", "EURO", "world"],
  ["soccer", "uefa.euroq", "Euro Qualifying", "EURO Q", "world"],
  ["soccer", "uefa.wchampions", "UEFA Women's Champions League", "UWCL", "world"],
  ["soccer", "conmebol.libertadores", "Copa Libertadores", "LIB", "world"],
  ["soccer", "conmebol.sudamericana", "Copa Sudamericana", "SUD", "world"],
  ["soccer", "conmebol.america", "Copa América", "CA", "world"],
  ["soccer", "concacaf.champions_cup", "CONCACAF Champions Cup", "CCC", "world"],
  ["soccer", "concacaf.gold", "CONCACAF Gold Cup", "GOLD", "world"],
  ["soccer", "concacaf.nations.league", "CONCACAF Nations League", "CNL", "world"],
  ["soccer", "concacaf.leagues.cup", "Leagues Cup", "LC", "world"],
  ["soccer", "afc.champions", "AFC Champions League", "ACL", "world"],
  ["soccer", "afc.asian.cup", "AFC Asian Cup", "ASIAN CUP", "world"],
  ["soccer", "caf.champions", "CAF Champions League", "CAF CL", "world"],
  ["soccer", "caf.nations", "Africa Cup of Nations", "AFCON", "world"],
  ["soccer", "fifa.world", "FIFA World Cup", "WC", "world"],
  ["soccer", "fifa.wwc", "FIFA Women's World Cup", "WWC", "world"],
  ["soccer", "fifa.cwc", "FIFA Club World Cup", "CWC", "world"],
  ["soccer", "fifa.world.q.uefa", "World Cup Qualifying - UEFA", "WCQ UEFA", "world"],
  ["soccer", "fifa.world.q.conmebol", "World Cup Qualifying - CONMEBOL", "WCQ CONM", "world"],
  ["soccer", "fifa.world.q.concacaf", "World Cup Qualifying - CONCACAF", "WCQ CCF", "world"],
  ["soccer", "fifa.world.q.afc", "World Cup Qualifying - AFC", "WCQ AFC", "world"],
  ["soccer", "fifa.world.q.caf", "World Cup Qualifying - CAF", "WCQ CAF", "world"],
  ["soccer", "fifa.friendly", "International Friendlies", "FRIENDLY", "world"],
  ["soccer", "fifa.friendly.w", "Women's Friendlies", "FRIENDLY W", "world"],
  ["soccer", "club.friendly", "Club Friendlies", "CLUB FR", "world"],

  // ---- Individual sports
  ["tennis", "atp", "ATP Tour", "ATP", "world"],
  ["tennis", "wta", "WTA Tour", "WTA", "world"],
  ["golf", "pga", "PGA Tour", "PGA", "us"],
  ["golf", "lpga", "LPGA Tour", "LPGA", "us"],
  ["golf", "champions-tour", "PGA Tour Champions", "CHAMPIONS", "us"],
  ["golf", "eur", "DP World Tour", "DPWT", "world"],
  ["golf", "liv", "LIV Golf", "LIV", "world"],
  ["golf", "ntw", "Korn Ferry Tour", "KFT", "us"],
  ["racing", "f1", "Formula 1", "F1", "world"],
  ["racing", "nascar-premier", "NASCAR Cup Series", "NASCAR", "us"],
  ["racing", "nascar-secondary", "NASCAR Xfinity Series", "XFINITY", "us"],
  ["racing", "nascar-truck", "NASCAR Truck Series", "TRUCK", "us"],
  ["racing", "irl", "IndyCar Series", "INDYCAR", "us"],
  ["mma", "ufc", "UFC", "UFC", "world"],
  ["mma", "pfl", "Professional Fighters League", "PFL", "world"],
  ["boxing", "boxing", "Boxing", "BOXING", "world"],

  // ---- Other team sports ESPN carries
  ["cricket", "cricket", "Cricket", "CRICKET", "world"],
  ["rugby", "rugby", "Rugby Union", "RUGBY", "world"],
  ["lacrosse", "mens-college-lacrosse", "NCAA Men's Lacrosse", "NCAA LAX", "us"],
  ["lacrosse", "womens-college-lacrosse", "NCAA Women's Lacrosse", "NCAA W LAX", "us"],
  ["volleyball", "mens-college-volleyball", "NCAA Men's Volleyball", "NCAA M VB", "us"],
  ["volleyball", "womens-college-volleyball", "NCAA Women's Volleyball", "NCAA W VB", "us"],
  ["water-polo", "mens-college-water-polo", "NCAA Men's Water Polo", "NCAA WP", "us"],
  ["field-hockey", "womens-college-field-hockey", "NCAA Field Hockey", "NCAA FH", "us"],
  ["softball", "college-softball", "NCAA Softball", "NCAA SB", "us"]
];

// A few leagues need overrides where the sport default is wrong.
var OVERRIDES = {
  "baseball/mlb": { total: 8.6, hfa: 24, k: 6 },
  "basketball/mens-college-basketball": { hfa: 75, total: 145, k: 24 },
  "basketball/womens-college-basketball": { hfa: 70, total: 135, k: 24 },
  "basketball/wnba": { hfa: 40, total: 165 },
  "basketball/nbl": { hfa: 55, total: 170 },
  "football/college-football": { hfa: 60, total: 52, k: 24 },
  "football/cfl": { total: 50 },
  "hockey/nhl": { hfa: 35, total: 6.1, k: 8 },
  "soccer/eng.1": { total: 2.85 },
  "soccer/ger.1": { total: 3.15 },
  "soccer/ned.1": { total: 3.2 },
  "soccer/ita.1": { total: 2.7 },
  "soccer/esp.1": { total: 2.6 },
  "soccer/fra.1": { total: 2.75 },
  "soccer/usa.1": { total: 3.0 },
  "soccer/mex.1": { total: 2.75 },
  "soccer/uefa.champions": { total: 3.1, hfa: 50 },
  // Neutral-site competitions: no home edge worth modelling.
  "soccer/fifa.world": { hfa: 12 },
  "soccer/fifa.cwc": { hfa: 10 },
  "soccer/uefa.super_cup": { hfa: 0 },
  "soccer/concacaf.gold": { hfa: 15 }
};

function leagueId(sport, slug) { return sport + "/" + slug; }

// Build a full league record from a curated row or a discovered pair.
function makeLeague(sport, slug, name, short, region) {
  var d = sportDefaults(sport);
  var id = leagueId(sport, slug);
  var ov = OVERRIDES[id] || {};
  return {
    id: id,
    sport: sport,
    slug: slug,
    name: name || slug,
    short: short || (name || slug).toUpperCase().slice(0, 10),
    region: region || "world",
    kind: ov.kind || d.kind,
    hfa: ov.hfa == null ? d.hfa : ov.hfa,
    k: ov.k == null ? d.k : ov.k,
    expectedTotal: ov.total == null ? d.total : ov.total,
    unit: ov.unit || d.unit,
    curated: true
  };
}

function buildCatalog() {
  return CURATED.map(function(r) { return makeLeague(r[0], r[1], r[2], r[3], r[4]); });
}

// ---- ESPN endpoints -------------------------------------------------------
var SITE = "https://site.api.espn.com/apis/site/v2/sports";
var SITE_V2 = "https://site.api.espn.com/apis/v2/sports";
var CORE = "https://sports.core.api.espn.com/v2/sports";

// ESPN wants YYYYMMDD. Accept a Date, "YYYY-MM-DD", or an already-packed string.
function espnDate(d) {
  if (d == null) return null;
  if (typeof d === "string") {
    var digits = d.replace(/-/g, "");
    return /^\d{8}$/.test(digits) ? digits : null;
  }
  if (d instanceof Date && !isNaN(d.getTime())) {
    var m = String(d.getMonth() + 1), day = String(d.getDate());
    return "" + d.getFullYear() + (m.length < 2 ? "0" + m : m) + (day.length < 2 ? "0" + day : day);
  }
  return null;
}

// A date *range* is only meaningful to ESPN as YYYYMMDD-YYYYMMDD.
function espnDateRange(from, to) {
  var a = espnDate(from), b = espnDate(to);
  if (!a || !b) return null;
  return a + "-" + b;
}

function scoreboardUrl(league, date, extra) {
  var u = SITE + "/" + league.sport + "/" + league.slug + "/scoreboard";
  var qs = [];
  var d = typeof date === "string" && date.indexOf("-") > 0 && date.length > 10 ? date : espnDate(date);
  if (d) qs.push("dates=" + d);
  // College leagues page at 25 events by default; ask for the whole slate.
  qs.push("limit=900");
  if (extra && extra.groups) qs.push("groups=" + extra.groups);
  if (extra && extra.seasontype) qs.push("seasontype=" + extra.seasontype);
  return u + "?" + qs.join("&");
}

function newsUrl(league, limit) {
  return SITE + "/" + league.sport + "/" + league.slug + "/news?limit=" + (limit || 40);
}

function teamsUrl(league) {
  return SITE + "/" + league.sport + "/" + league.slug + "/teams?limit=900";
}

function standingsUrl(league, season) {
  var u = SITE_V2 + "/" + league.sport + "/" + league.slug + "/standings";
  return season ? u + "?season=" + season : u;
}

function summaryUrl(league, eventId) {
  return SITE + "/" + league.sport + "/" + league.slug + "/summary?event=" + eventId;
}

// The directory of every sport/league ESPN publishes.
function directoryUrl() { return SITE; }

function coreLeaguesUrl(sport) { return CORE + "/" + sport + "/leagues?limit=200"; }

// ---- Runtime discovery ----------------------------------------------------
// ESPN's /sports directory returns { sports: [ { slug, leagues: [ {slug, name,
// abbreviation, ...} ] } ] }. Turn that into league records, keeping curated
// metadata wherever we already have it.
function parseDirectory(payload) {
  var out = [];
  if (!payload || !Array.isArray(payload.sports)) return out;
  payload.sports.forEach(function(sp) {
    var sport = sp.slug || sp.name;
    if (!sport || !Array.isArray(sp.leagues)) return;
    sp.leagues.forEach(function(lg) {
      var slug = lg.slug || lg.abbreviation;
      if (!slug) return;
      out.push({
        sport: sport,
        slug: slug,
        name: lg.name || lg.shortName || slug,
        short: lg.abbreviation || lg.shortName || slug
      });
    });
  });
  return out;
}

// Merge discovered leagues into a catalog. Curated rows win on metadata; a
// discovered league we've never seen is added with sport-inferred defaults and
// curated:false so the UI can show where it came from.
function mergeDiscovered(catalog, discovered) {
  var byId = {};
  var out = (catalog || []).slice();
  out.forEach(function(l) { byId[l.id] = l; });
  (discovered || []).forEach(function(d) {
    if (!d || !d.sport || !d.slug) return;
    var id = leagueId(d.sport, d.slug);
    if (byId[id]) {
      // Prefer ESPN's own display name if ours was just the slug.
      if (byId[id].name === byId[id].slug && d.name) byId[id].name = d.name;
      return;
    }
    var l = makeLeague(d.sport, d.slug, d.name, d.short, "world");
    l.curated = false;
    byId[id] = l;
    out.push(l);
  });
  return out;
}

function findLeague(catalog, id) {
  for (var i = 0; i < (catalog || []).length; i++) if (catalog[i].id === id) return catalog[i];
  return null;
}

function groupBySport(catalog) {
  var map = {}, order = [];
  (catalog || []).forEach(function(l) {
    if (!map[l.sport]) { map[l.sport] = []; order.push(l.sport); }
    map[l.sport].push(l);
  });
  return order.map(function(s) { return { sport: s, leagues: map[s] }; });
}

// Human label for a sport slug ("mens-college-basketball" -> "Mens College Basketball").
function sportLabel(sport) {
  var special = { mma: "MMA", nfl: "NFL", "water-polo": "Water Polo", "field-hockey": "Field Hockey" };
  if (special[sport]) return special[sport];
  return String(sport || "").split("-").map(function(w) {
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  }).join(" ");
}

return {
  KINDS: KINDS,
  SPORT_DEFAULTS: SPORT_DEFAULTS,
  CURATED: CURATED,
  sportDefaults: sportDefaults,
  makeLeague: makeLeague,
  buildCatalog: buildCatalog,
  leagueId: leagueId,
  espnDate: espnDate,
  espnDateRange: espnDateRange,
  scoreboardUrl: scoreboardUrl,
  newsUrl: newsUrl,
  teamsUrl: teamsUrl,
  standingsUrl: standingsUrl,
  summaryUrl: summaryUrl,
  directoryUrl: directoryUrl,
  coreLeaguesUrl: coreLeaguesUrl,
  parseDirectory: parseDirectory,
  mergeDiscovered: mergeDiscovered,
  findLeague: findLeague,
  groupBySport: groupBySport,
  sportLabel: sportLabel
};

});
