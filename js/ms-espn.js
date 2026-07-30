// Sport-agnostic ESPN response parsing.
//
// The MLB app's js/espn-parse.js knows about pitchers and runs. This module is
// the generalisation: one event shape that covers club sports, individual
// duels (tennis/MMA/boxing) and field events (golf/motorsport), because ESPN
// reuses the same scoreboard envelope for all of them with different innards.
//
// Everything here is defensive on purpose. ESPN mixes numbers with strings,
// nests the same value at two or three different paths depending on the
// endpoint, and omits whole blocks for leagues that are out of season. A
// parser that throws takes the whole dashboard down with it, so each helper
// returns null/[] rather than assuming a shape.
// Exposed as MS.espn in the browser and via module.exports under Node, so the
// nine modules never collide on the global scope.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.espn = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

function num(v) {
  if (v == null || v === "") return null;
  var n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9eE+.-]/g, ""));
  return isFinite(n) ? n : null;
}

function str(v) { return v == null ? null : String(v); }

// ESPN american odds arrive as numbers (-150), strings ("+130"), or "EVEN".
function parseAmerican(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  var s = String(v).replace(/\s/g, "");
  if (s === "") return null;
  if (/^(even|ev|pk)$/i.test(s)) return 100;
  var n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// Pull a moneyline out of an ESPN homeTeamOdds/awayTeamOdds/drawOdds block.
// Old payloads: flat `moneyLine` number. New ones: `current.moneyLine.american`
// (a string) or `.value` (a number). Some soccer payloads use `moneyLineOdds`.
function teamMoneyLine(to) {
  if (!to) return null;
  var direct = parseAmerican(to.moneyLine != null ? to.moneyLine : to.moneyLineOdds);
  if (direct != null) return direct;
  var nested = [to.current, to.open, to.close];
  for (var i = 0; i < nested.length; i++) {
    var s = nested[i];
    if (!s) continue;
    var m = s.moneyLine != null ? s.moneyLine : s.moneyLineOdds;
    if (m == null) continue;
    if (typeof m === "object") {
      var v = parseAmerican(m.american != null ? m.american : m.value);
      if (v != null) return v;
    } else {
      var v2 = parseAmerican(m);
      if (v2 != null) return v2;
    }
  }
  return null;
}

// The odds block: ESPN returns an array of provider quotes; take the first
// that actually carries prices rather than blindly using [0].
function parseOdds(comp) {
  var arr = (comp && comp.odds) || [];
  if (!Array.isArray(arr) || !arr.length) return null;
  var best = null;
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i];
    if (!o) continue;
    var home = teamMoneyLine(o.homeTeamOdds);
    var away = teamMoneyLine(o.awayTeamOdds);
    var draw = teamMoneyLine(o.drawOdds);
    if (draw == null) draw = parseAmerican(o.drawOdds && o.drawOdds.moneyLine);
    var cand = {
      provider: (o.provider && (o.provider.name || o.provider.shortName)) || null,
      details: str(o.details),
      overUnder: num(o.overUnder),
      spread: num(o.spread),
      homeML: home,
      awayML: away,
      drawML: draw
    };
    if (home != null || away != null || cand.overUnder != null || cand.spread != null) return cand;
    if (!best) best = cand;
  }
  return best;
}

// Status is the single most-used field in the UI; normalise it hard.
function parseStatus(src) {
  var st = (src && (src.status || src)) || {};
  var t = st.type || {};
  var state = str(t.state) || "pre";
  return {
    state: state,                                   // pre | in | post
    completed: !!t.completed,
    detail: str(t.shortDetail) || str(t.detail) || str(t.description) || "",
    description: str(t.description) || "",
    clock: str(st.displayClock) || null,
    clockSeconds: num(st.clock),
    period: num(st.period),
    live: state === "in",
    final: state === "post" || !!t.completed,
    // A postponed/cancelled game is "post" to ESPN but must not be graded.
    cancelled: /postpon|cancel|suspend|abandon|forfeit/i.test(str(t.description) || "")
  };
}

// A competitor may be a team, an athlete (tennis/MMA/golf), or a two-athlete
// pairing (doubles). Flatten all three into one shape.
function parseCompetitor(c, comp) {
  if (!c) return null;
  var team = c.team || null;
  var athlete = c.athlete || (Array.isArray(c.athletes) && c.athletes.length === 1 ? c.athletes[0] : null);
  var roster = Array.isArray(c.athletes) ? c.athletes : null;

  var name, shortName, abbrev, logo, color, id, flag;
  if (team) {
    id = str(team.id) || str(c.id);
    name = str(team.displayName) || str(team.name) || str(team.location);
    shortName = str(team.shortDisplayName) || str(team.name) || name;
    abbrev = str(team.abbreviation) || str(team.shortDisplayName);
    logo = str(team.logo) || (Array.isArray(team.logos) && team.logos.length ? str(team.logos[0].href) : null);
    color = str(team.color);
    flag = (team.flag && str(team.flag.href)) || null;
  } else if (athlete) {
    id = str(athlete.id) || str(c.id);
    name = str(athlete.displayName) || str(athlete.fullName) || str(athlete.shortName);
    shortName = str(athlete.shortName) || name;
    abbrev = str(athlete.abbreviation) || (name ? name.split(" ").pop() : null);
    logo = (athlete.headshot && str(athlete.headshot.href)) || str(athlete.headshot) || null;
    flag = (athlete.flag && str(athlete.flag.href)) || null;
  } else if (roster && roster.length) {
    id = str(c.id);
    name = roster.map(function(a) { return str(a.shortName) || str(a.displayName) || ""; })
                 .filter(Boolean).join(" / ");
    shortName = name;
    abbrev = null;
    logo = null;
    flag = (roster[0] && roster[0].flag && str(roster[0].flag.href)) || null;
  } else {
    id = str(c.id);
    name = str(c.displayName) || str(c.name) || null;
    shortName = name;
    abbrev = null;
    logo = null;
    flag = null;
  }

  // Records: ESPN uses [{type:'total', summary:'12-4'}] on teams; individual
  // sports put a W-L in `records` too but sometimes only in `statistics`.
  var record = null, homeRecord = null, awayRecord = null;
  if (Array.isArray(c.records)) {
    c.records.forEach(function(r) {
      var s = str(r.summary) || str(r.displayValue);
      if (!s) return;
      var type = (str(r.type) || str(r.name) || "").toLowerCase();
      if (type === "total" || type === "overall" || (!record && !type)) record = s;
      else if (type.indexOf("home") >= 0) homeRecord = s;
      else if (type.indexOf("road") >= 0 || type.indexOf("away") >= 0) awayRecord = s;
      if (!record) record = s;
    });
  }

  // Field events: golf/racing put the running result in `score`/`order`/`stats`.
  var linescores = Array.isArray(c.linescores)
    ? c.linescores.map(function(l) { return num(l.value != null ? l.value : l.displayValue); })
    : null;

  return {
    id: id,
    uid: str(c.uid),
    name: name,
    shortName: shortName,
    abbrev: abbrev,
    logo: logo,
    flag: flag,
    color: color,
    homeAway: str(c.homeAway) || null,
    score: num(c.score),
    scoreText: str(c.score),
    winner: c.winner === true,
    record: record,
    homeRecord: homeRecord,
    awayRecord: awayRecord,
    rank: num(c.curatedRank && c.curatedRank.current) || num(c.rank),
    seed: num(c.seed),
    order: num(c.order),
    linescores: linescores,
    isAthlete: !!athlete && !team,
    possession: comp && str(comp.situation && comp.situation.possession) === str(c.id)
  };
}

// Golf/racing: the "competition" holds the whole field. We keep the leaderboard
// but the models only need entrant strength, so expose both.
function parseFieldEntrants(comp) {
  var arr = (comp && comp.competitors) || [];
  return arr.map(function(c) { return parseCompetitor(c, comp); })
            .filter(Boolean)
            .sort(function(a, b) {
              if (a.order != null && b.order != null) return a.order - b.order;
              return 0;
            });
}

function parseVenue(comp) {
  var v = (comp && comp.venue) || null;
  if (!v) return null;
  var addr = v.address || {};
  return {
    name: str(v.fullName) || str(v.name),
    city: str(addr.city),
    state: str(addr.state),
    country: str(addr.country),
    indoor: !!v.indoor,
    neutral: !!(comp && comp.neutralSite)
  };
}

function parseBroadcast(comp) {
  var b = (comp && comp.broadcasts) || [];
  if (!Array.isArray(b) || !b.length) return null;
  var names = [];
  b.forEach(function(x) {
    if (Array.isArray(x.names)) names = names.concat(x.names);
    else if (x.media && x.media.shortName) names.push(x.media.shortName);
  });
  return names.length ? names.join(", ") : null;
}

// ESPN's own model, when present, so the dashboard can show model-vs-ESPN.
function parsePredictor(src) {
  var p = src && src.predictor;
  if (!p) return null;
  var h = num(p.homeTeam && (p.homeTeam.gameProjection != null ? p.homeTeam.gameProjection : p.homeTeam.teamChanceLoss));
  var a = num(p.awayTeam && p.awayTeam.gameProjection);
  if (h == null && a == null) return null;
  var home = h != null ? h / 100 : (a != null ? 1 - a / 100 : null);
  if (home == null || !isFinite(home)) return null;
  return { homeWinProb: Math.min(1, Math.max(0, home)), source: "espn" };
}

// One scoreboard event -> one normalised game.
function parseEvent(ev, league) {
  if (!ev) return null;
  var comps = Array.isArray(ev.competitions) ? ev.competitions : [];
  var comp = comps[0] || {};
  var kind = (league && league.kind) || "team";
  var status = parseStatus(comp.status ? comp : ev);
  var competitors = (comp.competitors || []).map(function(c) { return parseCompetitor(c, comp); }).filter(Boolean);

  var home = null, away = null;
  competitors.forEach(function(c) {
    if (c.homeAway === "home") home = c;
    else if (c.homeAway === "away") away = c;
  });
  // Duels and neutral events often omit homeAway; fall back to slot order so
  // downstream code always has two sides to talk about.
  if (!home && !away && competitors.length === 2) { away = competitors[0]; home = competitors[1]; }

  var isField = kind === "field" || competitors.length > 2;

  return {
    id: str(ev.id),
    uid: str(ev.uid),
    leagueId: league ? league.id : null,
    sport: league ? league.sport : null,
    kind: kind,
    date: str(ev.date) || str(comp.date),
    name: str(ev.name),
    shortName: str(ev.shortName),
    season: ev.season ? { year: num(ev.season.year), type: num(ev.season.type), slug: str(ev.season.slug) } : null,
    week: num(ev.week && (ev.week.number != null ? ev.week.number : ev.week)),
    status: status,
    venue: parseVenue(comp),
    broadcast: parseBroadcast(comp),
    attendance: num(comp.attendance),
    neutralSite: !!comp.neutralSite,
    conferenceCompetition: !!comp.conferenceCompetition,
    home: home,
    away: away,
    competitors: competitors,
    isField: isField,
    field: isField ? parseFieldEntrants(comp) : null,
    odds: parseOdds(comp),
    predictor: parsePredictor(comp) || parsePredictor(ev),
    notes: Array.isArray(comp.notes) ? comp.notes.map(function(n) { return str(n.headline) || str(n.type); }).filter(Boolean) : [],
    situation: comp.situation || null,
    // Group/round label ("Round of 16", "Group B") when ESPN supplies it.
    groupLabel: (comp.notes && comp.notes[0] && str(comp.notes[0].headline)) ||
                (ev.season && str(ev.season.slug)) || null
  };
}

// Full scoreboard payload -> events + league/season context.
function parseScoreboard(payload, league) {
  var out = {
    events: [],
    season: null,
    calendar: [],
    leagueName: null,
    leagueLogo: null,
    day: null
  };
  if (!payload) return out;

  var lg = Array.isArray(payload.leagues) ? payload.leagues[0] : null;
  if (lg) {
    out.leagueName = str(lg.name) || str(lg.abbreviation);
    if (Array.isArray(lg.logos) && lg.logos.length) out.leagueLogo = str(lg.logos[0].href);
    if (lg.season) {
      out.season = {
        year: num(lg.season.year),
        type: num(lg.season.type && lg.season.type.type),
        typeName: str(lg.season.type && (lg.season.type.name || lg.season.type.abbreviation)),
        startDate: str(lg.season.startDate),
        endDate: str(lg.season.endDate),
        displayName: str(lg.season.displayName)
      };
    }
    // The calendar tells us which dates actually have games -- this is how the
    // dashboard finds the next matchday for a league that's out of season.
    if (Array.isArray(lg.calendar)) {
      out.calendar = lg.calendar.map(function(c) {
        if (typeof c === "string") return { date: c, label: null };
        return { date: str(c.startDate) || str(c.value), label: str(c.label) || str(c.alternateLabel),
                 endDate: str(c.endDate) };
      }).filter(function(c) { return !!c.date; });
    }
  }
  if (payload.day) out.day = str(payload.day.date);

  var evs = Array.isArray(payload.events) ? payload.events : [];
  out.events = evs.map(function(e) { return parseEvent(e, league); }).filter(Boolean);
  return out;
}

// ---- News -----------------------------------------------------------------
function parseNews(payload, league) {
  var arts = (payload && Array.isArray(payload.articles)) ? payload.articles : [];
  return arts.map(function(a) {
    if (!a) return null;
    var img = null;
    if (Array.isArray(a.images) && a.images.length) img = str(a.images[0].url) || str(a.images[0].href);
    var link = (a.links && ((a.links.web && str(a.links.web.href)) || (a.links.mobile && str(a.links.mobile.href)))) || null;
    return {
      id: str(a.id) || link || str(a.headline),
      headline: str(a.headline) || str(a.title),
      description: str(a.description),
      published: str(a.published) || str(a.lastModified),
      type: str(a.type),
      premium: !!a.premium,
      image: img,
      link: link,
      byline: str(a.byline),
      leagueId: league ? league.id : null,
      leagueName: league ? league.name : null,
      sport: league ? league.sport : null
    };
  }).filter(function(a) { return a && a.headline; });
}

// ---- Teams ----------------------------------------------------------------
function parseTeams(payload) {
  var out = [];
  var sports = (payload && payload.sports) || [];
  var leagues = (sports[0] && sports[0].leagues) || [];
  var teams = (leagues[0] && leagues[0].teams) || (payload && payload.teams) || [];
  (Array.isArray(teams) ? teams : []).forEach(function(t) {
    var team = t.team || t;
    if (!team) return;
    out.push({
      id: str(team.id),
      abbrev: str(team.abbreviation),
      name: str(team.displayName) || str(team.name),
      shortName: str(team.shortDisplayName) || str(team.name),
      location: str(team.location),
      color: str(team.color),
      altColor: str(team.alternateColor),
      logo: str(team.logo) || (Array.isArray(team.logos) && team.logos.length ? str(team.logos[0].href) : null),
      record: (team.record && Array.isArray(team.record.items) && team.record.items.length)
        ? str(team.record.items[0].summary) : null
    });
  });
  return out;
}

// ---- Standings ------------------------------------------------------------
// ESPN nests standings as children -> standings.entries, arbitrarily deep for
// leagues with conferences/divisions. Walk the whole tree.
function parseStandings(payload) {
  var rows = [];
  function statVal(stats, names) {
    if (!Array.isArray(stats)) return null;
    for (var i = 0; i < stats.length; i++) {
      var s = stats[i];
      var key = (str(s.name) || str(s.abbreviation) || "").toLowerCase();
      for (var j = 0; j < names.length; j++) {
        if (key === names[j]) {
          var v = s.value != null ? num(s.value) : num(s.displayValue);
          if (v != null) return v;
        }
      }
    }
    return null;
  }
  function walk(node, groupName) {
    if (!node || typeof node !== "object") return;
    var name = str(node.name) || str(node.displayName) || groupName;
    var st = node.standings;
    if (st && Array.isArray(st.entries)) {
      st.entries.forEach(function(e) {
        var t = e.team || {};
        var stats = e.stats || [];
        rows.push({
          group: name || null,
          teamId: str(t.id),
          name: str(t.displayName) || str(t.name),
          abbrev: str(t.abbreviation),
          logo: str(t.logo) || (Array.isArray(t.logos) && t.logos.length ? str(t.logos[0].href) : null),
          wins: statVal(stats, ["wins", "w"]),
          losses: statVal(stats, ["losses", "l"]),
          ties: statVal(stats, ["ties", "draws", "t", "d"]),
          winPercent: statVal(stats, ["winpercent", "pct", "winpct"]),
          points: statVal(stats, ["points", "pts"]),
          gamesPlayed: statVal(stats, ["gamesplayed", "gp"]),
          pointsFor: statVal(stats, ["pointsfor", "pf", "goalsfor", "gf"]),
          pointsAgainst: statVal(stats, ["pointsagainst", "pa", "goalsagainst", "ga"]),
          rank: statVal(stats, ["rank", "position"])
        });
      });
    }
    if (Array.isArray(node.children)) node.children.forEach(function(c) { walk(c, name); });
    if (Array.isArray(node.groups)) node.groups.forEach(function(c) { walk(c, name); });
  }
  walk(payload, null);
  if (payload && Array.isArray(payload.children)) { /* already walked */ }
  return rows;
}

// ---- Season / offseason helpers -------------------------------------------
// Given a parsed scoreboard, find the next date that has scheduled events.
// Used for leagues whose season hasn't started: ESPN still ships the calendar.
function nextCalendarDate(parsed, fromISO) {
  var cal = (parsed && parsed.calendar) || [];
  if (!cal.length) return null;
  var from = fromISO ? new Date(fromISO) : new Date();
  if (isNaN(from.getTime())) from = new Date();
  var best = null;
  cal.forEach(function(c) {
    var d = new Date(c.date);
    if (isNaN(d.getTime())) return;
    if (d.getTime() >= from.getTime() && (!best || d.getTime() < new Date(best.date).getTime())) best = c;
  });
  return best;
}

// Is this league in-season right now, per ESPN's own season window?
function seasonState(parsed, nowISO) {
  var s = parsed && parsed.season;
  var now = nowISO ? new Date(nowISO) : new Date();
  if (isNaN(now.getTime())) now = new Date();
  if (!s || !s.startDate) {
    return { state: (parsed && parsed.events && parsed.events.length) ? "active" : "unknown", season: s || null };
  }
  var start = new Date(s.startDate), end = s.endDate ? new Date(s.endDate) : null;
  if (!isNaN(start.getTime()) && now < start) {
    return { state: "preseason", season: s, startsInDays: Math.ceil((start - now) / 86400000) };
  }
  if (end && !isNaN(end.getTime()) && now > end) return { state: "offseason", season: s };
  return { state: "active", season: s };
}

return {
  num: num,
  parseAmerican: parseAmerican,
  teamMoneyLine: teamMoneyLine,
  parseOdds: parseOdds,
  parseStatus: parseStatus,
  parseCompetitor: parseCompetitor,
  parseFieldEntrants: parseFieldEntrants,
  parseVenue: parseVenue,
  parseBroadcast: parseBroadcast,
  parsePredictor: parsePredictor,
  parseEvent: parseEvent,
  parseScoreboard: parseScoreboard,
  parseNews: parseNews,
  parseTeams: parseTeams,
  parseStandings: parseStandings,
  nextCalendarDate: nextCalendarDate,
  seasonState: seasonState
};

});
