// News feed: merge ESPN's per-league article feeds into one stream.
//
// Each league has its own /news endpoint, so a multi-league feed means merging
// several responses that overlap heavily -- the same wire story appears under
// NFL and under NCAA Football, and ESPN reuses article ids across them. The
// merge dedupes on id first and then on a normalised headline, because the
// same story sometimes carries different ids per league.
// Exposed as MS.news in the browser and via module.exports under Node, so the
// nine modules never collide on the global scope.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.news = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

function normalizeHeadline(h) {
  return String(h || "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function timeOf(article) {
  var t = Date.parse(article && article.published);
  return isFinite(t) ? t : 0;
}

// Merge article arrays, newest first. When the same story arrives from several
// leagues we keep one copy and record every league it appeared under, so the
// UI can show "NFL · NCAAF" on a shared story instead of listing it twice.
function mergeFeeds(feeds) {
  var byId = {}, byHeadline = {}, out = [];
  (feeds || []).forEach(function(list) {
    (list || []).forEach(function(a) {
      if (!a || !a.headline) return;
      var key = a.id != null ? "id:" + a.id : null;
      var hkey = "h:" + normalizeHeadline(a.headline);
      var existing = (key && byId[key]) || byHeadline[hkey] || null;
      if (existing) {
        if (a.leagueId && existing.leagues.indexOf(a.leagueId) < 0) {
          existing.leagues.push(a.leagueId);
          if (a.leagueName) existing.leagueNames.push(a.leagueName);
        }
        // Prefer a copy that actually has an image.
        if (!existing.image && a.image) existing.image = a.image;
        return;
      }
      var rec = {
        id: a.id,
        headline: a.headline,
        description: a.description,
        published: a.published,
        t: timeOf(a),
        image: a.image,
        link: a.link,
        byline: a.byline,
        type: a.type,
        premium: !!a.premium,
        sport: a.sport,
        leagues: a.leagueId ? [a.leagueId] : [],
        leagueNames: a.leagueName ? [a.leagueName] : []
      };
      if (key) byId[key] = rec;
      byHeadline[hkey] = rec;
      out.push(rec);
    });
  });
  out.sort(function(a, b) { return b.t - a.t; });
  return out;
}

// "3m ago" / "2h ago" / "Tue" / "12 Mar"
function relativeTime(iso, nowMs) {
  var t = Date.parse(iso);
  if (!isFinite(t)) return "";
  var now = nowMs == null ? Date.now() : nowMs;
  var diff = Math.max(0, now - t);
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  var days = Math.floor(hours / 24);
  if (days < 7) return days + "d ago";
  var d = new Date(t);
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return d.getDate() + " " + months[d.getMonth()];
}

// Filter a merged feed by league, sport, or free-text query.
function filterFeed(articles, opts) {
  opts = opts || {};
  var q = (opts.query || "").toLowerCase().trim();
  var leagueId = opts.leagueId || null;
  var sport = opts.sport || null;
  return (articles || []).filter(function(a) {
    if (leagueId && a.leagues.indexOf(leagueId) < 0) return false;
    if (sport && a.sport !== sport) return false;
    if (q) {
      var hay = (a.headline + " " + (a.description || "") + " " + a.leagueNames.join(" ")).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
}

// Group a feed into "Today" / "Yesterday" / "Earlier" buckets for the UI.
function groupByDay(articles, nowMs) {
  var now = nowMs == null ? Date.now() : nowMs;
  var startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  var todayMs = startOfToday.getTime();
  var buckets = { today: [], yesterday: [], earlier: [] };
  (articles || []).forEach(function(a) {
    if (a.t >= todayMs) buckets.today.push(a);
    else if (a.t >= todayMs - 86400000) buckets.yesterday.push(a);
    else buckets.earlier.push(a);
  });
  return buckets;
}

// Which leagues to pull news for: the selected one plus whatever else is on
// screen, capped so the dashboard doesn't fire eighty requests for a feed.
function newsLeagueSelection(leagues, opts) {
  opts = opts || {};
  var max = opts.max == null ? 12 : opts.max;
  var picked = [];
  if (opts.selected) picked.push(opts.selected);
  (leagues || []).forEach(function(l) {
    if (picked.length >= max) return;
    if (picked.some(function(p) { return p.id === l.id; })) return;
    if (opts.sport && l.sport !== opts.sport) return;
    picked.push(l);
  });
  return picked.slice(0, max);
}

return {
  normalizeHeadline: normalizeHeadline,
  mergeFeeds: mergeFeeds,
  relativeTime: relativeTime,
  filterFeed: filterFeed,
  groupByDay: groupByDay,
  newsLeagueSelection: newsLeagueSelection
};

});
