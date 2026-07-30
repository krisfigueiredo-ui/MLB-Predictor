// Dashboard application layer for sports.html.
//
// All the maths lives in the MS.* modules; this file is the shell around them:
// fetching, caching, state, rendering and interaction. It deliberately keeps a
// visible record of every request it makes (the feed log at the bottom of the
// page) because the whole app depends on a third-party feed that can and does
// return nothing for a given league on a given day. When that happens the UI
// says so instead of inventing a slate.
(function() {
"use strict";

var L = MS.leagues, E = MS.espn, LOGO = MS.logos, R = MS.ratings, F = MS.features,
    BT = MS.backtest, MODEL = MS.model, LIVE = MS.live, NEWS = MS.news;

// ml-train.js / calibration.js / betting.js still publish flat globals.
var deps = {
  leagues: L, espn: E, logos: LOGO, ratings: R, features: F,
  backtest: BT, live: LIVE, news: NEWS,
  ml: {
    standardize: standardize,
    fitLogisticRegression: fitLogisticRegression,
    evaluateLogisticRegression: evaluateLogisticRegression,
    rocAUC: rocAUC, rocCurve: rocCurve, confusionMatrixStats: confusionMatrixStats
  },
  calibration: { calibrationReport: calibrationReport, wilsonCI: wilsonCI }
};

var PREF_KEY = "ms.prefs.v1";
var LIVE_POLL_MS = 30000;

var S = {
  catalog: [],
  league: null,
  date: todayISO(),
  tab: "slate",
  slate: null,          // { events, season, calendar, leagueLogo, ... }
  seasonInfo: null,
  ratingsState: null,   // point-in-time state from the replay
  historyFor: null,     // league id the ratings state belongs to
  historySummary: null,
  model: null,
  news: null,
  standings: null,
  feed: [],
  busy: false,
  progress: null,
  lookbackDays: 180,
  detail: null,
  pollTimer: null,
  discovery: "idle"
};

// ---------------------------------------------------------------- utilities
function $(sel, root) { return (root || document).querySelector(sel); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function pct(p, dp) { return p == null || !isFinite(p) ? "—" : (p * 100).toFixed(dp == null ? 1 : dp) + "%"; }
function num(v, dp) { return v == null || !isFinite(v) ? "—" : Number(v).toFixed(dp == null ? 2 : dp); }
function todayISO() {
  var d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function shiftDate(iso, days) {
  var d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function fmtTime(iso) {
  var t = Date.parse(iso);
  if (!isFinite(t)) return "";
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDay(iso) {
  var t = Date.parse(iso + "T12:00:00");
  if (!isFinite(t)) return iso;
  return new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; }
}
function savePrefs(patch) {
  try {
    var p = loadPrefs();
    Object.keys(patch).forEach(function(k) { p[k] = patch[k]; });
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch (e) { /* private mode: preferences just don't persist */ }
}

// ------------------------------------------------------------------ fetching
// Every request is logged so the footer can show exactly what the dashboard
// asked for and what came back.
function logFeed(entry) {
  S.feed.unshift(entry);
  if (S.feed.length > 60) S.feed.length = 60;
  renderFeedFoot();
}

function fetchJson(url, label, timeoutMs) {
  var started = Date.now();
  var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, timeoutMs || 15000) : null;
  return fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: "no-store" })
    .then(function(res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) {
        logFeed({ label: label, url: url, ok: false, code: res.status, ms: Date.now() - started });
        return null;
      }
      return res.json().then(function(json) {
        logFeed({ label: label, url: url, ok: true, code: res.status, ms: Date.now() - started });
        return json;
      }, function() {
        logFeed({ label: label, url: url, ok: false, code: res.status, error: "bad JSON", ms: Date.now() - started });
        return null;
      });
    }, function(err) {
      if (timer) clearTimeout(timer);
      logFeed({ label: label, url: url, ok: false, error: (err && err.name === "AbortError") ? "timeout" : "network", ms: Date.now() - started });
      return null;
    });
}

// Run promise-returning tasks with a small concurrency cap. ESPN tolerates
// parallel reads fine, but a 30-request burst from one tab is impolite and
// makes failures harder to read.
function pool(items, limit, worker, onProgress) {
  var idx = 0, done = 0, results = new Array(items.length);
  return new Promise(function(resolve) {
    if (!items.length) return resolve(results);
    var active = 0;
    function next() {
      while (active < limit && idx < items.length) {
        (function(i) {
          active++; idx++;
          Promise.resolve(worker(items[i], i)).then(function(r) {
            results[i] = r;
          }, function() {
            results[i] = null;
          }).then(function() {
            active--; done++;
            if (onProgress) onProgress(done, items.length);
            if (done === items.length) resolve(results); else next();
          });
        })(idx);
      }
    }
    next();
  });
}

// ------------------------------------------------------------------ boot
function boot() {
  var prefs = loadPrefs();
  if (prefs.theme) document.documentElement.setAttribute("data-theme", prefs.theme);
  if (prefs.lookbackDays) S.lookbackDays = prefs.lookbackDays;

  S.catalog = L.buildCatalog();
  S.league = (prefs.leagueId && L.findLeague(S.catalog, prefs.leagueId)) ||
             L.findLeague(S.catalog, "baseball/mlb") || S.catalog[0];
  S.date = todayISO();

  $("#datePick").value = S.date;
  wireChrome();
  renderRail();
  renderLeagueBtn();
  setTab(prefs.tab && ["slate","live","news","model","power","leagues"].indexOf(prefs.tab) >= 0 ? prefs.tab : "slate");

  discoverLeagues();
  refreshAll();
}

function wireChrome() {
  $("#themeBtn").addEventListener("click", function() {
    var cur = document.documentElement.getAttribute("data-theme");
    var next = cur === "dark" ? "light" : (cur === "light" ? "dark" : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark"));
    document.documentElement.setAttribute("data-theme", next);
    savePrefs({ theme: next });
    render();
  });
  $("#refreshBtn").addEventListener("click", function() { refreshAll(true); });
  $("#leagueBtn").addEventListener("click", openLeaguePicker);
  $("#dayPrev").addEventListener("click", function() { setDate(shiftDate(S.date, -1)); });
  $("#dayNext").addEventListener("click", function() { setDate(shiftDate(S.date, 1)); });
  $("#dayToday").addEventListener("click", function() { setDate(todayISO()); });
  $("#datePick").addEventListener("change", function(e) { if (e.target.value) setDate(e.target.value); });

  document.querySelectorAll(".tab").forEach(function(btn) {
    btn.addEventListener("click", function() { setTab(btn.dataset.tab); });
  });

  // One delegated click handler for everything rendered into the view.
  document.addEventListener("click", function(e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var act = el.dataset.action;
    if (act === "open-game") { openGame(el.dataset.gameId); }
    else if (act === "close-modal") { closeModal(); }
    else if (act === "pick-league") { pickLeague(el.dataset.leagueId); }
    else if (act === "open-picker") { openLeaguePicker(); }
    else if (act === "train") { buildHistory(true); }
    else if (act === "set-lookback") { S.lookbackDays = parseInt(el.dataset.days, 10); savePrefs({ lookbackDays: S.lookbackDays }); buildHistory(true); }
    else if (act === "goto-date") { setDate(el.dataset.date); }
    else if (act === "set-tab") { setTab(el.dataset.tab); }
  });
  document.addEventListener("keydown", function(e) { if (e.key === "Escape") closeModal(); });
}

function setTab(tab) {
  S.tab = tab;
  savePrefs({ tab: tab });
  document.querySelectorAll(".tab").forEach(function(b) {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  });
  if (tab === "news" && !S.news) loadNews();
  if (tab === "power" && !S.ratingsState) buildHistory(false);
  render();
}

function setDate(iso) {
  S.date = iso;
  $("#datePick").value = iso;
  loadSlate().then(render);
}

function pickLeague(id) {
  var lg = L.findLeague(S.catalog, id);
  if (!lg) return;
  S.league = lg;
  S.slate = null; S.model = null; S.ratingsState = null; S.historyFor = null;
  S.news = null; S.standings = null; S.historySummary = null;
  savePrefs({ leagueId: id });
  renderLeagueBtn();
  renderRail();
  closeModal();
  refreshAll();
}

function refreshAll(force) {
  loadSlate().then(function() {
    render();
    return buildHistory(!!force);
  }).then(function() {
    render();
    if (S.tab === "news" || force) loadNews();
  });
}

// ------------------------------------------------------------------ loading
function loadSlate() {
  var lg = S.league;
  if (!lg) return Promise.resolve();
  S.busy = true;
  render();
  var url = L.scoreboardUrl(lg, S.date);
  return fetchJson(url, lg.short + " scoreboard").then(function(json) {
    S.busy = false;
    if (!json) { S.slate = null; return; }
    S.slate = E.parseScoreboard(json, lg);
    S.seasonInfo = E.seasonState(S.slate, new Date().toISOString());
    // Nothing today: ESPN's own calendar tells us when this league next plays,
    // which is how out-of-season leagues stay useful rather than blank.
    if (!S.slate.events.length) {
      S.slate.nextDate = E.nextCalendarDate(S.slate, new Date().toISOString());
    }
    schedulePolling();
  });
}

// Pull a window of completed games, replay them point-in-time, and fit the
// league's model. This is what powers every probability on the page.
function buildHistory(force) {
  var lg = S.league;
  if (!lg) return Promise.resolve();
  if (!force && S.historyFor === lg.id) return Promise.resolve();
  if (lg.kind === "field") { S.historyFor = lg.id; return Promise.resolve(); }

  var range = BT.lookbackRange(S.lookbackDays);
  var dates = BT.dateRange(range.start, range.end);
  var chunks = BT.chunkRanges(dates, 30);

  S.progress = { done: 0, total: chunks.length, label: "Loading " + S.lookbackDays + " days of " + lg.short };
  render();

  return pool(chunks, 4, function(c) {
    var url = L.scoreboardUrl(lg, L.espnDateRange(c.from, c.to));
    return fetchJson(url, lg.short + " " + c.from + "→" + c.to).then(function(json) {
      return json ? E.parseScoreboard(json, lg).events : [];
    });
  }, function(done, total) {
    S.progress = { done: done, total: total, label: "Loading " + S.lookbackDays + " days of " + lg.short };
    renderProgressOnly();
  }).then(function(lists) {
    var all = [];
    lists.forEach(function(list) { if (list) all = all.concat(list); });
    all = BT.dedupeById(all);

    var rep = BT.replay(all, lg, deps);
    S.ratingsState = rep.state;
    S.historySummary = rep.summary;
    S.historySummary.fetched = all.length;
    S.samples = rep.samples;
    S.historyFor = lg.id;

    S.model = MODEL.trainLeagueModel(rep.samples, lg, deps);
    if (S.model.trained) MODEL.saveModel(localStorage, S.model);

    S.progress = null;
    render();
  });
}

function loadNews() {
  var picks = NEWS.newsLeagueSelection(
    S.catalog.filter(function(l) { return l.sport === S.league.sport; }),
    { selected: S.league, max: 8 }
  );
  return pool(picks, 4, function(lg) {
    return fetchJson(L.newsUrl(lg, 30), lg.short + " news").then(function(json) {
      return json ? E.parseNews(json, lg) : [];
    });
  }).then(function(lists) {
    S.news = NEWS.mergeFeeds(lists.filter(Boolean));
    if (S.tab === "news") render();
  });
}

function loadStandings() {
  if (S.standings || !S.league) return Promise.resolve();
  return fetchJson(L.standingsUrl(S.league), S.league.short + " standings").then(function(json) {
    S.standings = json ? E.parseStandings(json) : [];
    render();
  });
}

// ESPN publishes its whole sport/league directory; merging it in means leagues
// we never hand-wrote still appear.
function discoverLeagues() {
  S.discovery = "loading";
  return fetchJson(L.directoryUrl(), "ESPN league directory", 20000).then(function(json) {
    if (!json) { S.discovery = "failed"; render(); return; }
    var found = L.parseDirectory(json);
    var before = S.catalog.length;
    S.catalog = L.mergeDiscovered(S.catalog, found);
    S.discovery = { added: S.catalog.length - before, seen: found.length };
    renderRail();
    if (S.tab === "leagues") render();
  });
}

function schedulePolling() {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  var live = liveGames();
  updateLiveBadge(live.length);
  if (!live.length) return;
  S.pollTimer = setInterval(function() {
    loadSlate().then(function() {
      render();
      if (S.detail && S.detail.gameId) refreshDetail(S.detail.gameId);
    });
  }, LIVE_POLL_MS);
}

function liveGames() {
  if (!S.slate) return [];
  return S.slate.events.filter(function(g) { return g.status && g.status.live; });
}

function updateLiveBadge(n) {
  var el = $("#liveBadge");
  if (!el) return;
  if (n > 0) { el.hidden = false; el.textContent = n; } else { el.hidden = true; }
}

// ------------------------------------------------------------------ images
// ESPN's CDN path shape varies by sport, so every logo carries an ordered list
// of candidates and walks it on error, ending at a generated monogram.
window.MSAPP = window.MSAPP || {};
window.MSAPP.logoFail = function(img) {
  var list;
  try { list = JSON.parse(img.getAttribute("data-fb") || "[]"); } catch (e) { list = []; }
  var i = parseInt(img.getAttribute("data-fbi") || "0", 10) + 1;
  if (i < list.length) {
    img.setAttribute("data-fbi", String(i));
    img.src = list[i];
  } else {
    img.onerror = null;
  }
};

function imgTag(candidates, fallback, cls, alt) {
  var list = (candidates || []).slice();
  if (fallback) list.push(fallback);
  if (!list.length) list = [fallback || ""];
  return '<img class="' + esc(cls || "") + '" alt="' + esc(alt || "") + '" loading="lazy"' +
         ' src="' + esc(list[0]) + '" data-fb="' + esc(JSON.stringify(list)) + '" data-fbi="0"' +
         ' onerror="MSAPP.logoFail(this)">';
}

function teamImg(competitor, league, cls, style) {
  var badge = LOGO.competitorBadge(competitor, league, { dark: isDark() });
  var tag = imgTag(badge.candidates, badge.fallback, cls || "", badge.label);
  return style ? tag.replace("<img ", '<img style="' + esc(style) + '" ') : tag;
}

function leagueImg(league, cls) {
  var runtime = (S.slate && S.league && S.league.id === league.id) ? S.slate.leagueLogo : null;
  var badge = LOGO.leagueBadge(league, runtime, { dark: isDark() });
  return imgTag(badge.candidates, badge.fallback, cls || "", badge.label);
}

function flagImg(region, cls) {
  if (LOGO.isGlobalRegion(region)) return '<span class="' + esc(cls || "") + '" title="International">🌐</span>';
  var cands = LOGO.flagCandidates(region, { size: 500 });
  if (!cands.length) return "";
  return imgTag(cands, LOGO.monogram(region, { size: 32, dark: isDark() }), cls || "flag", region);
}

function isDark() {
  var attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

// ------------------------------------------------------------------ chrome render
function renderRail() {
  var groups = L.groupBySport(S.catalog);
  var icons = {
    football: "🏈", basketball: "🏀", baseball: "⚾", hockey: "🏒", soccer: "⚽",
    tennis: "🎾", golf: "⛳", racing: "🏁", mma: "🥊", boxing: "🥊", cricket: "🏏",
    rugby: "🏉", volleyball: "🏐", lacrosse: "🥍", softball: "🥎", "water-polo": "🤽",
    "field-hockey": "🏑", olympics: "🏅"
  };
  var html = groups.map(function(g) {
    var isCur = S.league && S.league.sport === g.sport;
    return '<button class="rail-item" aria-current="' + (isCur ? "true" : "false") + '" data-action="pick-league"' +
      ' data-league-id="' + esc(preferredLeagueFor(g).id) + '">' +
      '<span class="rail-ico">' + (icons[g.sport] || "🏆") + "</span>" +
      "<span>" + esc(L.sportLabel(g.sport)) + "</span>" +
      '<span class="count">' + g.leagues.length + "</span></button>";
  }).join("");
  $("#sportRail").innerHTML = html;
  $("#brandSub").textContent = S.catalog.length + " leagues";
}

// When someone clicks a sport, land them on the biggest league in it (which is
// the curated one listed first) rather than an arbitrary discovered slug.
function preferredLeagueFor(group) {
  if (S.league && S.league.sport === group.sport) return S.league;
  var curated = group.leagues.filter(function(l) { return l.curated; });
  return curated[0] || group.leagues[0];
}

function renderLeagueBtn() {
  if (!S.league) return;
  $("#leagueBtnName").textContent = S.league.name;
  var badge = LOGO.leagueBadge(S.league, S.slate && S.slate.leagueLogo, { dark: isDark() });
  var img = $("#leagueBtnLogo");
  var list = badge.candidates.concat([badge.fallback]);
  img.setAttribute("data-fb", JSON.stringify(list));
  img.setAttribute("data-fbi", "0");
  img.onerror = function() { window.MSAPP.logoFail(img); };
  img.src = list[0];
}

function renderFeedFoot() {
  var el = $("#feedFoot");
  if (!el) return;
  var ok = S.feed.filter(function(f) { return f.ok; }).length;
  var bad = S.feed.length - ok;
  var last = S.feed[0];
  el.textContent = "Feed: " + ok + " ok / " + bad + " failed" +
    (last ? " · last: " + last.label + " " + (last.ok ? "ok" : (last.error || last.code)) + " (" + last.ms + "ms)" : "");
}

function renderProgressOnly() {
  var bar = $("#progressBar");
  if (bar && S.progress) {
    bar.style.width = (100 * S.progress.done / Math.max(1, S.progress.total)).toFixed(1) + "%";
    var lbl = $("#progressLabel");
    if (lbl) lbl.textContent = S.progress.label + " — " + S.progress.done + "/" + S.progress.total;
  }
}

// ------------------------------------------------------------------ main render
function render() {
  var view = $("#view");
  if (!view) return;
  var html = "";
  if (S.tab === "slate") html = viewSlate();
  else if (S.tab === "live") html = viewLive();
  else if (S.tab === "news") html = viewNews();
  else if (S.tab === "model") html = viewModel();
  else if (S.tab === "power") html = viewPower();
  else if (S.tab === "leagues") html = viewLeagues();
  view.innerHTML = html;
  renderFeedFoot();
  updateLiveBadge(liveGames().length);
  // Charts are drawn after innerHTML so they can measure their container.
  drawPendingCharts(view);
}

function progressBlock() {
  if (!S.progress) return "";
  return '<div class="card" style="padding:12px 14px;margin-bottom:14px">' +
    '<div class="small" id="progressLabel" style="margin-bottom:7px">' + esc(S.progress.label) + " — " + S.progress.done + "/" + S.progress.total + "</div>" +
    '<div class="progress"><span id="progressBar" style="width:' + (100 * S.progress.done / Math.max(1, S.progress.total)).toFixed(1) + '%"></span></div></div>';
}

// ------------------------------------------------------------------ Slate
function viewSlate() {
  if (!S.league) return "";
  var out = progressBlock();

  if (S.busy && !S.slate) {
    return out + '<div class="empty"><div class="big"><span class="spin"></span></div>Loading ' + esc(S.league.name) + "…</div>";
  }
  if (!S.slate) {
    return out + banner("crit", "The ESPN scoreboard feed did not return for " + esc(S.league.name) +
      " on " + esc(fmtDay(S.date)) + ". Nothing is shown rather than a substitute slate. Try refreshing, or another date.");
  }

  var events = S.slate.events;
  if (!events.length) return out + offseasonBlock();

  var preds = events.map(function(g) { return predictionFor(g); });
  var live = events.filter(function(g) { return g.status.live; }).length;
  var finals = events.filter(function(g) { return g.status.final; }).length;

  out += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
    "<h2>" + esc(fmtDay(S.date)) + "</h2>" +
    '<span class="pill">' + events.length + " game" + (events.length === 1 ? "" : "s") + "</span>" +
    (live ? '<span class="pill live"><span class="dot pulse"></span>' + live + " live</span>" : "") +
    (finals ? '<span class="pill">' + finals + " final</span>" : "") +
    modelPill() +
    "</div>";

  out += '<div class="slate">' + events.map(function(g, i) { return gameCard(g, preds[i]); }).join("") + "</div>";
  return out;
}

function modelPill() {
  if (S.progress) return "";
  if (!S.model) return '<span class="pill">Ratings loading…</span>';
  if (!S.model.trained) return '<span class="pill warn" title="' + esc(S.model.reason || "") + '">Elo only — ' + esc(S.model.reason || "model not trained") + "</span>";
  var w = MODEL.modelWeight(S.model);
  if (w <= 0) return '<span class="pill warn">Model trained but did not beat Elo — Elo only</span>';
  return '<span class="pill good">Model trained · ' + S.model.n + " games · weight " + (w * 100).toFixed(0) + "%</span>";
}

function banner(kind, html) {
  return '<div class="banner ' + kind + '"><span>' + (kind === "crit" ? "⚠️" : "ℹ️") + "</span><div>" + html + "</div></div>";
}

function offseasonBlock() {
  var info = S.seasonInfo || {};
  var next = S.slate && S.slate.nextDate;
  var season = info.season;
  var out = "";
  var head = "No games on " + esc(fmtDay(S.date)) + " for " + esc(S.league.name) + ".";
  var detail = "";
  if (info.state === "preseason" && info.startsInDays != null) {
    detail = "ESPN has this season starting " + esc(season && season.startDate ? fmtDay(season.startDate.slice(0, 10)) : "later") +
      " — " + info.startsInDays + " days away. Ratings below are carried over from the last completed season.";
  } else if (info.state === "offseason") {
    detail = "The " + esc(season && season.displayName ? season.displayName : "current") + " season has finished. Ratings show final standings strength.";
  } else {
    detail = "This league may simply not play today, or ESPN may not carry it. The feed answered — it just had no events.";
  }
  out += banner("warn", "<strong>" + head + "</strong><br>" + detail);

  if (next && next.date) {
    var nd = next.date.slice(0, 10);
    out += '<div style="margin-top:12px"><button class="btn primary" data-action="goto-date" data-date="' + esc(nd) + '">' +
      "Jump to next matchday · " + esc(fmtDay(nd)) + (next.label ? " (" + esc(next.label) + ")" : "") + "</button></div>";
  }

  // Even with no fixtures, the power ratings from the loaded window are the
  // useful thing to show for an out-of-season league.
  if (S.ratingsState) {
    var rows = F.powerRankings(S.ratingsState, 12);
    if (rows.length) {
      out += '<div class="section-title">Carried-over power ratings</div>' + powerTable(rows, 12);
    }
  } else if (!S.progress) {
    out += '<div style="margin-top:12px"><button class="btn" data-action="train">Load history and build ratings</button></div>';
  }
  return out;
}

function predictionFor(g) {
  if (!S.ratingsState || !S.league) return null;
  try {
    return MODEL.predict(g, S.ratingsState, S.league, S.model, deps, {
      avgTotal: S.historySummary && S.historySummary.avgTotal,
      drawRate: S.historySummary && S.historySummary.drawRate
    });
  } catch (e) {
    return null;
  }
}

function gameCard(g, pred) {
  var lg = S.league;
  if (g.isField || lg.kind === "field") return fieldCard(g, pred);

  var home = g.home, away = g.away;
  if (!home || !away) return "";
  var st = g.status;
  var statusHtml = st.live
    ? '<span class="pill live"><span class="dot pulse"></span>' + esc(st.detail || "Live") + "</span>"
    : (st.final ? '<span class="pill">' + esc(st.detail || "Final") + "</span>"
                : '<span class="pill">' + esc(fmtTime(g.date)) + "</span>");

  var liveInfo = st.live ? LIVE.analyzeLive(g, lg, {
    pregameHomeProb: pred ? pred.homeWinProb : 0.5,
    lambdas: pred && pred.goals ? pred.goals.lambdas : null
  }) : null;

  var pHome = liveInfo && liveInfo.homeWinProb != null ? liveInfo.homeWinProb : (pred ? pred.homeWinProb : null);
  var three = liveInfo && liveInfo.threeWay ? liveInfo.threeWay : (pred ? pred.threeWay : null);

  var showScore = st.live || st.final;
  var homeLost = st.final && home.score < away.score;
  var awayLost = st.final && away.score < home.score;

  var out = '<div class="game" data-action="open-game" data-game-id="' + esc(g.id) + '" tabindex="0" role="button">';
  out += '<div class="game-head">' + statusHtml +
    (g.broadcast ? "<span>" + esc(g.broadcast) + "</span>" : "") +
    (g.neutralSite ? '<span class="pill">Neutral</span>' : "") +
    (liveInfo && liveInfo.leverage && liveInfo.leverage.index > 1.6
      ? '<span class="pill warn" title="How much the next score would swing the win probability">High leverage</span>' : "") +
    "</div>";

  out += sideRow(away, lg, showScore, awayLost);
  out += sideRow(home, lg, showScore, homeLost);

  if (pHome != null) {
    out += probBar(pHome, three);
    out += '<div class="problabels"><span>' + esc(away.abbrev || away.shortName || "Away") + " <b>" +
      pct(three ? three.away : 1 - pHome, 0) + "</b></span>" +
      (three ? "<span>Draw <b>" + pct(three.draw, 0) + "</b></span>" : "") +
      "<span>" + esc(home.abbrev || home.shortName || "Home") + " <b>" + pct(three ? three.home : pHome, 0) + "</b></span></div>";
  }

  var foot = [];
  if (liveInfo && liveInfo.summary) foot.push(esc(liveInfo.summary));
  else if (pred && pred.confidence) foot.push(esc(pred.confidence.text));
  if (pred && pred.bestEdge && pred.bestEdge.edge >= 0.04) {
    foot.push('<span class="pill good">Edge ' + (pred.bestEdge.edge * 100).toFixed(1) + "% " + esc(pred.bestEdge.side) + "</span>");
  }
  if (g.odds && g.odds.details) foot.push('<span class="mono">' + esc(g.odds.details) + "</span>");
  if (foot.length) out += '<div class="game-foot">' + foot.join("") + "</div>";

  out += "</div>";
  return out;
}

function sideRow(c, lg, showScore, lost) {
  return '<div class="side' + (lost ? " loser" : "") + '">' +
    teamImg(c, lg) +
    (c.rank ? '<span class="rank">#' + c.rank + "</span>" : "") +
    '<span class="nm">' + esc(c.shortName || c.name || "TBD") + "</span>" +
    (c.record ? '<span class="rec">' + esc(c.record) + "</span>" : "") +
    (showScore && c.score != null ? '<span class="sc">' + c.score + "</span>" : "") +
    "</div>";
}

function probBar(pHome, three) {
  if (three) {
    return '<div class="probbar">' +
      '<span style="width:' + (three.away * 100).toFixed(1) + '%;background:var(--series-2)"></span>' +
      '<span style="width:' + (three.draw * 100).toFixed(1) + '%;background:var(--series-4)"></span>' +
      '<span style="width:' + (three.home * 100).toFixed(1) + '%;background:var(--series-1)"></span></div>';
  }
  return '<div class="probbar">' +
    '<span style="width:' + ((1 - pHome) * 100).toFixed(1) + '%;background:var(--series-2)"></span>' +
    '<span style="width:' + (pHome * 100).toFixed(1) + '%;background:var(--series-1)"></span></div>';
}

function fieldCard(g, pred) {
  var rows = pred && pred.entrants ? pred.entrants.slice(0, 6) : [];
  var out = '<div class="game" data-action="open-game" data-game-id="' + esc(g.id) + '" tabindex="0" role="button">';
  out += '<div class="game-head"><span class="pill">' + esc(g.status.detail || fmtTime(g.date)) + "</span>" +
    (g.venue && g.venue.name ? "<span>" + esc(g.venue.name) + "</span>" : "") + "</div>";
  out += '<div style="font-weight:650;margin-bottom:8px">' + esc(g.name || g.shortName || "Event") + "</div>";
  if (!rows.length) {
    var n = (g.field || g.competitors || []).length;
    out += '<div class="small muted">' + n + " entrant" + (n === 1 ? "" : "s") +
      (S.ratingsState ? "" : " · load history to rate the field") + "</div>";
  } else {
    out += rows.map(function(e) {
      return '<div class="side"><span class="nm">' + esc(e.shortName || e.name) + "</span>" +
        '<span class="sc mono" style="font-size:13px">' + pct(e.winProb, 1) + "</span></div>";
    }).join("");
  }
  out += "</div>";
  return out;
}

// ------------------------------------------------------------------ Live tab
function viewLive() {
  var live = liveGames();
  if (!S.slate) return banner("crit", "No scoreboard loaded for this league and date.");
  if (!live.length) {
    var upcoming = S.slate.events.filter(function(g) { return g.status.state === "pre"; });
    return '<div class="empty"><div class="big">📡</div><strong>Nothing live right now</strong>' +
      '<div class="small" style="margin-top:6px">' +
      (upcoming.length ? upcoming.length + " game" + (upcoming.length === 1 ? "" : "s") + " still to start on this date."
                       : "No games in progress for " + esc(S.league.name) + " on " + esc(fmtDay(S.date)) + ".") +
      "</div><div class=\"small muted\" style=\"margin-top:8px\">This tab polls every 30 seconds while anything is in progress.</div></div>";
  }
  var out = '<div class="section-title">Live now · ' + live.length + " game" + (live.length === 1 ? "" : "s") + "</div>";
  out += live.map(function(g) { return liveStrip(g); }).join("");
  return out;
}

function liveStrip(g) {
  var lg = S.league;
  var pred = predictionFor(g);
  var info = LIVE.analyzeLive(g, lg, {
    pregameHomeProb: pred ? pred.homeWinProb : 0.5,
    lambdas: pred && pred.goals ? pred.goals.lambdas : null
  });
  var home = g.home, away = g.away;
  if (!home || !away) return "";

  var out = '<div class="card" style="padding:14px;margin-bottom:11px;cursor:pointer" data-action="open-game" data-game-id="' + esc(g.id) + '">';
  out += '<div class="game-head"><span class="pill live"><span class="dot pulse"></span>' + esc(g.status.detail || "Live") + "</span>" +
    (info.model ? '<span class="pill" title="Which in-game model is driving this number">' + esc(modelLabel(info.model)) + "</span>" : "") +
    (info.leverage && info.leverage.index != null ? '<span class="pill' + (info.leverage.index > 1.6 ? " warn" : "") + '">Leverage ' + info.leverage.index.toFixed(1) + "×</span>" : "") +
    "</div>";
  out += sideRow(away, lg, true, false);
  out += sideRow(home, lg, true, false);
  if (info.homeWinProb != null) {
    out += probBar(info.homeWinProb, info.threeWay);
    out += '<div class="problabels"><span>' + esc(away.abbrev || away.shortName) + " <b>" +
      pct(info.threeWay ? info.threeWay.away : 1 - info.homeWinProb, 0) + "</b></span>" +
      (info.threeWay ? "<span>Draw <b>" + pct(info.threeWay.draw, 0) + "</b></span>" : "") +
      "<span>" + esc(home.abbrev || home.shortName) + " <b>" + pct(info.threeWay ? info.threeWay.home : info.homeWinProb, 0) + "</b></span></div>";
  }
  if (info.summary) out += '<div class="game-foot">' + esc(info.summary) + "</div>";
  out += '<div class="small muted" style="margin-top:8px">Tap for play-by-play and the win-probability chart →</div>';
  out += "</div>";
  return out;
}

function modelLabel(m) {
  return { "brownian": "Clock model", "poisson-remaining": "Remaining-goals model", "base-out": "Base-out model" }[m] || m;
}

// ------------------------------------------------------------------ News
function viewNews() {
  if (!S.news) return '<div class="empty"><div class="big"><span class="spin"></span></div>Loading news…</div>';
  if (!S.news.length) return banner("warn", "ESPN's news feed returned nothing for these leagues.");
  var buckets = NEWS.groupByDay(S.news);
  var out = "";
  [["today", "Today"], ["yesterday", "Yesterday"], ["earlier", "Earlier"]].forEach(function(pair) {
    var list = buckets[pair[0]];
    if (!list.length) return;
    out += '<div class="section-title">' + pair[1] + "</div>";
    out += '<div class="newsgrid">' + list.map(articleCard).join("") + "</div>";
  });
  return out;
}

function articleCard(a) {
  var leagues = a.leagueNames.slice(0, 3).join(" · ");
  return '<article class="article">' +
    (a.image ? '<img class="thumb" src="' + esc(a.image) + '" alt="" loading="lazy">' : "") +
    '<div class="body">' +
    "<h4>" + (a.link ? '<a href="' + esc(a.link) + '" target="_blank" rel="noopener noreferrer">' + esc(a.headline) + "</a>" : esc(a.headline)) + "</h4>" +
    (a.description ? '<p class="small muted" style="margin:0">' + esc(a.description.slice(0, 165)) + (a.description.length > 165 ? "…" : "") + "</p>" : "") +
    '<div class="meta">' + (leagues ? '<span class="pill">' + esc(leagues) + "</span>" : "") +
    "<span>" + esc(NEWS.relativeTime(a.published)) + "</span>" +
    (a.premium ? '<span class="pill warn">ESPN+</span>' : "") +
    "</div></div></article>";
}

// ------------------------------------------------------------------ Model tab
function viewModel() {
  var out = progressBlock();
  out += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">' +
    '<button class="btn primary" data-action="train">Rebuild &amp; retrain</button>' +
    "<span class=\"small muted\">Lookback</span>" +
    [90, 180, 365, 730].map(function(d) {
      return '<button class="btn' + (S.lookbackDays === d ? " primary" : "") + '" data-action="set-lookback" data-days="' + d + '">' + d + "d</button>";
    }).join("") +
    "</div>";

  if (!S.historySummary) {
    return out + banner("warn", "No history loaded yet for " + esc(S.league.name) +
      ". Press <strong>Rebuild &amp; retrain</strong> to pull the last " + S.lookbackDays + " days of completed games, replay them point-in-time, and fit the model.");
  }

  var hs = S.historySummary, m = S.model;
  out += '<div class="section-title">Backtest window</div>';
  out += '<div class="statgrid">' +
    stat("Events fetched", hs.fetched, "over " + S.lookbackDays + " days") +
    stat("Graded games", hs.games, "used for ratings") +
    stat("Home win rate", pct(hs.homeWinRate), "observed") +
    (hs.drawRate ? stat("Draw rate", pct(hs.drawRate), "calibrates the 3-way model") : "") +
    stat("Avg total", num(hs.avgTotal, 2), S.league.unit || "") +
    "</div>";

  if (!m || !m.trained) {
    return out + '<div style="margin-top:14px">' + banner("warn",
      "Model not fitted: <strong>" + esc((m && m.reason) || "not enough graded games") + "</strong>. " +
      "Predictions fall back to the Elo rating prior, which needs no training. Try a longer lookback.") + "</div>";
  }

  var t = m.metrics.test, e = m.metrics.eloOnly;
  out += '<div class="section-title">Held-out performance <span class="muted" style="text-transform:none;letter-spacing:0">(chronological split — the model never sees its test period)</span></div>';
  out += '<div class="statgrid">' +
    stat("Test games", t ? t.n : "—", "most recent " + (100 - Math.round(100 * m.nTrain / m.n)) + "% of the window") +
    stat("Accuracy", t ? pct(t.acc) : "—", "vs " + pct(m.metrics.baselineHomeRate) + " always-home") +
    stat("Log loss", t ? num(t.logloss, 4) : "—", e ? "Elo alone " + num(e.logloss, 4) : "") +
    stat("Brier", t ? num(t.brier, 4) : "—", e ? "Elo alone " + num(e.brier, 4) : "") +
    stat("ROC-AUC", num(m.metrics.auc, 4), "0.5 = coin flip") +
    stat("Walk-forward", num(m.metrics.foldMeanLogloss, 4), m.metrics.folds.length + " expanding folds") +
    "</div>";

  var beatsElo = t && e && t.logloss < e.logloss;
  out += '<div style="margin-top:12px">' + banner(beatsElo ? "" : "warn",
    beatsElo
      ? "The fitted model beat the Elo-only prior on held-out data, so it gets a <strong>" +
        (MODEL.modelWeight(m) * 100).toFixed(0) + "%</strong> vote in the blend."
      : "The fitted model did <strong>not</strong> beat the Elo-only prior on held-out data, so it is given zero weight and predictions use Elo alone. That is the intended behaviour, not a failure to display.") + "</div>";

  // Charts
  out += '<div class="section-title">Calibration</div>';
  out += chartHost("calib", 220, "Confidence in the picked side against how often that pick actually won, held-out games. Points on the diagonal are perfectly calibrated; above it means the model is under-confident, below it means over-confident.");
  out += '<div class="section-title">ROC curve</div>';
  out += chartHost("roc", 220, "True-positive rate against false-positive rate as the decision threshold sweeps.");
  out += '<div class="section-title">Training loss</div>';
  out += chartHost("loss", 160, "Mean log loss per epoch on the training slice.");

  // Feature weights. The hfa slot is a constant 1 for every game, so it
  // standardizes to a constant 0 and never receives gradient -- its role is
  // carried entirely by the intercept. Showing it as a 0.000 weight would
  // read as "home advantage doesn't matter", which is the opposite of true,
  // so it gets its own row with the intercept's value.
  out += '<div class="section-title">What the model learned</div>';
  var weights = m.features.map(function(f, i) { return { f: f, w: m.w[i] }; })
    .filter(function(r) { return r.f !== "hfa"; })
    .sort(function(a, b) { return Math.abs(b.w) - Math.abs(a.w); });
  out += '<div class="card scroll-x"><table class="tbl"><thead><tr><th>Feature</th><th class="num">Std. weight</th><th>Direction</th></tr></thead><tbody>' +
    '<tr><td>Baseline home edge (intercept)</td><td class="num mono">' + num(m.b, 3) +
    '</td><td class="small muted">' + (m.b > 0 ? "favours home" : (m.b < 0 ? "favours away" : "—")) + "</td></tr>" +
    weights.map(function(r) {
      var dir = Math.abs(r.w) < 0.02 ? "—" : (r.w > 0 ? "favours home" : "favours away");
      return "<tr><td>" + esc(featureLabel(r.f)) + '</td><td class="num mono">' + num(r.w, 3) + "</td><td class=\"small muted\">" + dir + "</td></tr>";
    }).join("") + "</tbody></table></div>" +
    '<div class="small muted" style="margin-top:6px">Weights are on standardized features, so they are comparable to each other but not in raw units. ' +
    "A near-zero weight means the model found no signal in that feature for this league.</div>";

  // Walk-forward folds
  if (m.metrics.folds.length) {
    out += '<div class="section-title">Walk-forward folds</div>';
    out += '<div class="card scroll-x"><table class="tbl"><thead><tr><th>Fold</th><th class="num">Test n</th><th class="num">Accuracy</th><th class="num">Log loss</th><th class="num">Brier</th></tr></thead><tbody>' +
      m.metrics.folds.map(function(f, i) {
        return "<tr><td>" + (i + 1) + '</td><td class="num mono">' + f.n + '</td><td class="num mono">' + pct(f.acc) +
          '</td><td class="num mono">' + num(f.logloss, 4) + '</td><td class="num mono">' + num(f.brier, 4) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  // Paper betting backtest
  var bb = betBacktestBlock();
  if (bb) out += bb;

  out += '<div class="section-title">Method</div>';
  out += '<div class="card" style="padding:14px"><ul class="small" style="margin:0;padding-left:18px;line-height:1.75">' +
    "<li>Features for each game are built from state containing <strong>only earlier games</strong>, then the result is folded in. No present-day table is used to grade a past game.</li>" +
    "<li>The train/test split is <strong>chronological</strong>, never random, so the model cannot see the future of its own test period.</li>" +
    "<li>Standardization means and deviations are fitted on the training slice only.</li>" +
    "<li>The model must beat the Elo-only prior on held-out data to receive any weight in the blend.</li>" +
    "<li>Backtest depth is limited to what the ESPN scoreboard returns for the chosen window; a league ESPN covers thinly will train on thin data, and the counts above say so.</li>" +
    "</ul></div>";

  return out;
}

function featureLabel(f) {
  return {
    hfa: "Home advantage (intercept)", eloDiff: "Elo rating gap", formDiff: "Recent form (last 10)",
    marginDiff: "Average scoring margin", offDiff: "Offence (points scored)", defDiff: "Defence (points allowed)",
    pythagDiff: "Pythagorean expectation", venueSplitDiff: "Home/away venue split", restDiff: "Rest days",
    h2hDiff: "Head-to-head history", rankDiff: "Poll ranking", experience: "Sample depth"
  }[f] || f;
}

function betBacktestBlock() {
  if (!S.samples || !S.samples.length || !S.model || !S.model.trained) return "";
  var parts = BT.chronoSplit(BT.splitDraws(S.samples).binary, 0.75);
  var res = BT.betBacktest(parts.test, function(s) {
    var p = MODEL.modelProb(s.feat, S.model, deps);
    return R.blendLogits([{ p: s.eloPrior, w: 1 - MODEL.modelWeight(S.model) }, { p: p, w: MODEL.modelWeight(S.model) }]);
  }, { minEdge: 0.04, mode: "kelly", kellyFraction: 0.25, bankroll: 100 });

  if (!res.bets) {
    return '<div class="section-title">Paper betting backtest</div>' +
      banner("warn", "No qualifying bets in the held-out window — either ESPN carried no moneylines for these games, or the model never found a 4% edge. Nothing is shown rather than a synthetic line.");
  }
  var out = '<div class="section-title">Paper betting backtest <span class="muted" style="text-transform:none;letter-spacing:0">(held-out games only, 4% minimum edge, quarter-Kelly)</span></div>';
  out += '<div class="statgrid">' +
    stat("Bets", res.bets, "of " + parts.test.length + " test games") +
    stat("Hit rate", pct(res.hitRate), "") +
    stat("P/L", (res.pnl >= 0 ? "+" : "") + num(res.pnl, 2) + "u", "from 100u bank") +
    stat("ROI", pct(res.roi), "on turnover") +
    "</div>";
  window.__msEquity = res.curve;
  out += chartHost("equity", 190, "Cumulative paper profit and loss across the held-out window.");
  return out;
}

function stat(k, v, d) {
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v)) + "</div>" +
    (d ? '<div class="d">' + esc(d) + "</div>" : "") + "</div>";
}

// ------------------------------------------------------------------ Power tab
function viewPower() {
  var out = progressBlock();
  if (!S.ratingsState) {
    return out + banner("warn", "No ratings built yet. <button class=\"btn\" data-action=\"train\">Load history</button>");
  }
  var rows = F.powerRankings(S.ratingsState);
  if (!rows.length) return out + banner("warn", "The loaded window contained no completed games for this league.");
  out += '<div class="section-title">Power ratings · ' + esc(S.league.name) +
    ' <span class="muted" style="text-transform:none;letter-spacing:0">(Elo after replaying ' + S.historySummary.games + " games)</span></div>";
  out += powerTable(rows, 60);

  out += '<div class="section-title">Standings</div>';
  if (!S.standings) { loadStandings(); out += '<div class="small muted"><span class="spin"></span> Loading standings…</div>'; }
  else if (!S.standings.length) out += banner("warn", "ESPN returned no standings for this league.");
  else out += standingsTable(S.standings);
  return out;
}

function powerTable(rows, limit) {
  var lookup = teamLookup();
  return '<div class="card scroll-x"><table class="tbl"><thead><tr><th>#</th><th>Team</th><th class="num">Elo</th><th class="num">GP</th><th class="num">Win%</th><th class="num">Margin</th></tr></thead><tbody>' +
    rows.slice(0, limit).map(function(r, i) {
      var c = lookup[r.id] || { id: r.id, shortName: r.id, name: r.id };
      return "<tr><td class=\"mono muted\">" + (i + 1) + "</td>" +
        '<td><span style="display:inline-flex;align-items:center;gap:8px">' +
        teamImg(c, S.league, "", "width:20px;height:20px;object-fit:contain;border-radius:4px") +
        "<span>" + esc(c.shortName || c.name || r.id) + "</span></span></td>" +
        '<td class="num mono">' + Math.round(r.elo) + '</td><td class="num mono">' + r.games +
        '</td><td class="num mono">' + (r.winPct == null ? "—" : pct(r.winPct, 0)) +
        '</td><td class="num mono">' + (r.marginAvg == null ? "—" : (r.marginAvg > 0 ? "+" : "") + num(r.marginAvg, 1)) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
}

// Team display info is only available from events we've seen, so build a
// lookup from the current slate plus the replayed history.
var _teamLookup = null, _teamLookupFor = null;
function teamLookup() {
  if (_teamLookup && _teamLookupFor === S.league.id) return _teamLookup;
  var map = {};
  function add(c) { if (c && c.id != null && !map[c.id]) map[c.id] = c; }
  if (S.slate) S.slate.events.forEach(function(g) { add(g.home); add(g.away); (g.competitors || []).forEach(add); });
  if (S.samples) S.samples.forEach(function(s) {
    if (!map[s.homeId]) map[s.homeId] = { id: s.homeId, shortName: s.homeName, name: s.homeName };
    if (!map[s.awayId]) map[s.awayId] = { id: s.awayId, shortName: s.awayName, name: s.awayName };
  });
  _teamLookup = map; _teamLookupFor = S.league.id;
  return map;
}

function standingsTable(rows) {
  var groups = {};
  rows.forEach(function(r) { (groups[r.group || "League"] = groups[r.group || "League"] || []).push(r); });
  return Object.keys(groups).map(function(g) {
    return "<h4 style=\"margin:14px 0 7px;font-size:13px\">" + esc(g) + "</h4>" +
      '<div class="card scroll-x"><table class="tbl"><thead><tr><th>Team</th><th class="num">W</th><th class="num">L</th><th class="num">T</th><th class="num">Pts</th><th class="num">GP</th></tr></thead><tbody>' +
      groups[g].map(function(r) {
        return "<tr><td>" + esc(r.name || "—") + '</td><td class="num mono">' + (r.wins == null ? "—" : r.wins) +
          '</td><td class="num mono">' + (r.losses == null ? "—" : r.losses) +
          '</td><td class="num mono">' + (r.ties == null ? "—" : r.ties) +
          '</td><td class="num mono">' + (r.points == null ? "—" : r.points) +
          '</td><td class="num mono">' + (r.gamesPlayed == null ? "—" : r.gamesPlayed) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }).join("");
}

// ------------------------------------------------------------------ Leagues tab
function viewLeagues() {
  var groups = L.groupBySport(S.catalog);
  var out = "";
  var d = S.discovery;
  if (d === "loading") out += '<div class="small muted" style="margin-bottom:12px"><span class="spin"></span> Discovering leagues from ESPN…</div>';
  else if (d === "failed") out += banner("warn", "ESPN's league directory did not load, so this list is the built-in catalog only.");
  else if (d && d.added != null) out += '<div class="small muted" style="margin-bottom:12px">ESPN\'s directory listed ' + d.seen + " leagues; " + d.added + " of them were not in the built-in catalog and have been added with sport-inferred defaults.</div>";

  out += '<div class="statgrid" style="margin-bottom:16px">' +
    stat("Leagues", S.catalog.length, "selectable") +
    stat("Sports", groups.length, "") +
    stat("Curated", S.catalog.filter(function(l) { return l.curated; }).length, "with tuned priors") +
    "</div>";

  groups.forEach(function(g) {
    out += '<div class="section-title">' + esc(L.sportLabel(g.sport)) + " · " + g.leagues.length + "</div>";
    out += '<div class="picker-grid">' + g.leagues.map(leagueTile).join("") + "</div>";
  });
  return out;
}

function leagueTile(lg) {
  var cur = S.league && S.league.id === lg.id;
  return '<button class="picker-item" aria-current="' + (cur ? "true" : "false") + '" data-action="pick-league" data-league-id="' + esc(lg.id) + '">' +
    leagueImg(lg) +
    '<span class="pi-text"><span class="pi-name">' + esc(lg.name) + "</span>" +
    '<span class="pi-sub">' + flagImg(lg.region) +
    "<span>" + esc(kindLabel(lg.kind)) + (lg.curated ? "" : " · discovered") + "</span></span></span></button>";
}

function kindLabel(k) {
  return { team: "Two-team", draw: "Draw possible", duel: "Head-to-head", field: "Field event" }[k] || k;
}

// ------------------------------------------------------------------ League picker
function openLeaguePicker() {
  var host = $("#modalHost");
  host.innerHTML = '<div class="overlay" data-action="close-modal"><div class="modal" role="dialog" aria-label="Choose league" onclick="event.stopPropagation()">' +
    '<div class="modal-head"><strong style="flex:1">Choose a league</strong>' +
    '<input type="search" id="leagueSearch" placeholder="Search leagues, sports, countries…" style="flex:2;min-width:0">' +
    '<button class="icon-btn" data-action="close-modal" aria-label="Close">✕</button></div>' +
    '<div class="modal-body" id="pickerBody">' + pickerBody("") + "</div></div></div>";
  var input = $("#leagueSearch");
  input.focus();
  input.addEventListener("input", function() { $("#pickerBody").innerHTML = pickerBody(input.value); });
}

function pickerBody(query) {
  var q = String(query || "").toLowerCase().trim();
  var matches = S.catalog.filter(function(l) {
    if (!q) return true;
    return (l.name + " " + l.short + " " + l.sport + " " + l.region + " " + l.slug).toLowerCase().indexOf(q) >= 0;
  });
  if (!matches.length) return '<div class="empty">No league matches “' + esc(query) + "”.</div>";
  var groups = L.groupBySport(matches);
  return groups.map(function(g) {
    return '<div class="section-title">' + esc(L.sportLabel(g.sport)) + "</div>" +
      '<div class="picker-grid">' + g.leagues.map(leagueTile).join("") + "</div>";
  }).join("");
}

function closeModal() {
  $("#modalHost").innerHTML = "";
  S.detail = null;
}

// ------------------------------------------------------------------ Game detail
function openGame(gameId) {
  var g = findGame(gameId);
  if (!g) return;
  S.detail = { gameId: gameId, summary: null, loading: true };
  renderDetail();
  fetchJson(L.summaryUrl(S.league, gameId), S.league.short + " summary " + gameId).then(function(json) {
    if (!S.detail || S.detail.gameId !== gameId) return;
    S.detail.summary = json;
    S.detail.loading = false;
    renderDetail();
  });
}

function refreshDetail(gameId) {
  fetchJson(L.summaryUrl(S.league, gameId), S.league.short + " summary " + gameId).then(function(json) {
    if (!S.detail || S.detail.gameId !== gameId) return;
    S.detail.summary = json;
    renderDetail();
  });
}

function findGame(id) {
  if (!S.slate) return null;
  for (var i = 0; i < S.slate.events.length; i++) if (S.slate.events[i].id === id) return S.slate.events[i];
  return null;
}

function renderDetail() {
  var g = findGame(S.detail && S.detail.gameId);
  if (!g) return;
  var host = $("#modalHost");
  host.innerHTML = '<div class="overlay" data-action="close-modal"><div class="modal" role="dialog" aria-label="Game detail" onclick="event.stopPropagation()">' +
    '<div class="modal-head">' + detailHead(g) + '<button class="icon-btn" data-action="close-modal" aria-label="Close">✕</button></div>' +
    '<div class="modal-body">' + detailBody(g) + "</div></div></div>";
  drawPendingCharts(host);
}

function detailHead(g) {
  var st = g.status;
  return '<div style="flex:1;min-width:0">' +
    '<div style="font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
    esc(g.shortName || g.name || "Game") + "</div>" +
    '<div class="small muted">' + esc(S.league.name) + " · " +
    (st.live ? esc(st.detail || "Live") : (st.final ? esc(st.detail || "Final") : esc(fmtDay(S.date) + " " + fmtTime(g.date)))) + "</div></div>";
}

function detailBody(g) {
  if (g.isField || S.league.kind === "field") return fieldDetail(g);
  var pred = predictionFor(g);
  var st = g.status;
  var out = "";

  // Score / teams
  out += '<div class="card" style="padding:12px 14px;margin-bottom:14px">' +
    sideRow(g.away, S.league, st.live || st.final, st.final && g.away.score < g.home.score) +
    sideRow(g.home, S.league, st.live || st.final, st.final && g.home.score < g.away.score) +
    "</div>";

  if (st.live) out += liveDetail(g, pred);
  else if (st.final) out += finalDetail(g, pred);

  if (pred) out += predictionDetail(g, pred);
  else out += banner("warn", "Ratings for this league haven't been built yet, so no probability is shown. " +
    '<button class="btn" data-action="train">Load history</button>');

  // Meta
  var meta = [];
  if (g.venue && g.venue.name) meta.push(esc(g.venue.name) + (g.venue.city ? ", " + esc(g.venue.city) : ""));
  if (g.broadcast) meta.push(esc(g.broadcast));
  if (g.attendance) meta.push("Attendance " + g.attendance.toLocaleString());
  if (g.neutralSite) meta.push("Neutral site");
  if (meta.length) out += '<div class="small muted" style="margin-top:14px">' + meta.join(" · ") + "</div>";
  return out;
}

function liveDetail(g, pred) {
  var info = LIVE.analyzeLive(g, S.league, {
    pregameHomeProb: pred ? pred.homeWinProb : 0.5,
    lambdas: pred && pred.goals ? pred.goals.lambdas : null
  });
  var out = '<div class="section-title">Live</div>';

  out += '<div class="statgrid" style="margin-bottom:12px">' +
    stat(esc(g.home.abbrev || g.home.shortName) + " win", pct(info.homeWinProb, 1), info.model ? modelLabel(info.model) : "") +
    (info.threeWay ? stat("Draw", pct(info.threeWay.draw, 1), "remaining-goals model") : "") +
    (info.leverage ? stat("Leverage", info.leverage.index == null ? "—" : info.leverage.index.toFixed(2) + "×",
      "next score swings " + pct(info.leverage.swing, 1)) : "") +
    (info.fracRemaining != null ? stat("Remaining", pct(info.fracRemaining, 0), "of regulation") : "") +
    "</div>";

  if (info.summary) out += '<div class="banner" style="margin-bottom:12px">' + esc(info.summary) + "</div>";

  if (S.detail && S.detail.loading) {
    out += '<div class="small muted"><span class="spin"></span> Loading play-by-play…</div>';
    return out;
  }

  var summary = S.detail && S.detail.summary;
  if (!summary) return out + banner("warn", "The play-by-play feed did not load for this game.");

  var plays = LIVE.parsePlays(summary);
  var espnWp = LIVE.parseWinProbability(summary);

  if (plays.length) {
    var series = LIVE.buildWinProbSeries(plays, {
      league: S.league,
      pregameHomeProb: pred ? pred.homeWinProb : 0.5,
      lambdas: pred && pred.goals ? pred.goals.lambdas : null
    });
    if (series.length > 1) {
      var swings = LIVE.winProbSwings(series, 6);
      window.__msWp = { series: swings.series, espn: espnWp, home: g.home, away: g.away };
      out += '<div class="section-title">Win probability</div>';
      out += chartHost("wp", 200, "Our in-game model after every play" + (espnWp.length ? ", with ESPN's own line for comparison" : "") + ". Hover for the play.");

      var mo = LIVE.momentum(swings.series, 8);
      if (mo) {
        out += '<div class="small muted" style="margin-top:6px">Momentum over the last ' + mo.plays + " plays: " +
          "<strong style=\"color:" + (mo.delta >= 0 ? "var(--series-1)" : "var(--series-2)") + '">' +
          (mo.delta >= 0 ? "+" : "") + pct(mo.delta, 1) + "</strong> toward " +
          esc(mo.delta >= 0 ? (g.home.shortName || "home") : (g.away.shortName || "away")) + "</div>";
      }

      if (swings.top.length) {
        out += '<div class="section-title">Biggest swings</div><div class="card" style="padding:6px 12px">';
        out += swings.top.map(function(p) {
          return '<div class="play' + (p.scoringPlay ? " scoring" : "") + '">' +
            '<span class="clock">' + esc((p.period ? "P" + p.period + " " : "") + (p.clock || "")) + "</span>" +
            '<span class="txt">' + esc(p.text || "—") + '<br><span class="small muted">' +
            (p.awayScore != null ? esc(g.away.abbrev || "A") + " " + p.awayScore + " – " + p.homeScore + " " + esc(g.home.abbrev || "H") : "") +
            "</span></span>" +
            '<span class="swing ' + (p.delta >= 0 ? "up" : "down") + '">' + (p.delta >= 0 ? "+" : "") + pct(p.delta, 1) + "</span></div>";
        }).join("") + "</div>";
      }
    }

    out += '<div class="section-title">Play-by-play</div>';
    out += '<div class="card" style="padding:6px 12px"><div class="playfeed">' +
      plays.slice(-60).reverse().map(function(p) {
        return '<div class="play' + (p.scoringPlay ? " scoring" : "") + '">' +
          '<span class="clock">' + esc((p.period ? "P" + p.period + " " : "") + (p.clock || "")) + "</span>" +
          '<span class="txt">' + esc(p.text || p.typeText || "—") + "</span>" +
          (p.homeScore != null ? '<span class="swing mono muted">' + p.awayScore + "–" + p.homeScore + "</span>" : "") +
          "</div>";
      }).join("") + "</div></div>";
  } else {
    out += banner("warn", "ESPN returned no play list for this game — many leagues outside the US majors have scores but no play-by-play.");
  }

  var drives = LIVE.parseDrives(summary);
  if (drives.length) {
    out += '<div class="section-title">Drives</div><div class="card scroll-x"><table class="tbl"><thead><tr><th>Result</th><th class="num">Plays</th><th class="num">Yards</th><th class="num">Time</th></tr></thead><tbody>' +
      drives.slice(-10).reverse().map(function(d) {
        return "<tr><td>" + esc(d.result || d.description || "—") + '</td><td class="num mono">' + (d.plays == null ? "—" : d.plays) +
          '</td><td class="num mono">' + (d.yards == null ? "—" : d.yards) + '</td><td class="num mono">' + esc(d.timeElapsed || "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  return out;
}

function finalDetail(g, pred) {
  var out = '<div class="section-title">Result</div>';
  var homeWon = g.home.score > g.away.score;
  var drew = g.home.score === g.away.score;
  var called = pred ? ((pred.homeWinProb >= 0.5) === homeWon) : null;
  out += '<div class="statgrid" style="margin-bottom:12px">' +
    stat("Final", g.away.score + " – " + g.home.score, drew ? "Draw" : esc((homeWon ? g.home.shortName : g.away.shortName) || "") + " won") +
    (pred ? stat("We had", pct(pred.homeWinProb, 1), "for " + esc(g.home.shortName || "home")) : "") +
    (pred && !drew ? stat("Called it", called ? "Yes" : "No", "at the 50% line") : "") +
    "</div>";
  if (pred) {
    out += '<div class="small muted">This prediction is recomputed from the ratings as they stand <em>now</em>, ' +
      "which include this game. It is a post-hoc read, not the number we would have shown before kick-off — " +
      "the honest before-the-fact evaluation is the held-out backtest on the Model tab.</div>";
  }
  return out;
}

function predictionDetail(g, pred) {
  var out = '<div class="section-title">Model</div>';

  if (pred.kind === "duel" && pred.tennis) {
    var t = pred.tennis;
    out += '<div class="statgrid">' +
      stat(esc(g.home.shortName || "A"), pct(pred.homeWinProb, 1), "match win, best of " + t.bestOf) +
      stat("Set", pct(t.set, 1), "current-set win") +
      stat("Hold", pct(t.hold.a, 1) + " / " + pct(t.hold.b, 1), "service holds A / B") +
      stat("Tiebreak", pct(t.tiebreak, 1), "if it goes there") +
      "</div>" +
      '<div class="small muted" style="margin-top:8px">Built by driving a point → game → set → match model from the Elo gap, ' +
      "not by reading the match probability straight off the ratings.</div>";
    return out;
  }

  out += '<div class="statgrid">' +
    stat("Blended", pct(pred.homeWinProb, 1), "home win probability") +
    stat("Elo prior", pct(pred.eloProb, 1), "rating gap " + (pred.ratings.diff > 0 ? "+" : "") + Math.round(pred.ratings.diff)) +
    (pred.modelProb != null ? stat("Fitted model", pct(pred.modelProb, 1), "weight " + (pred.modelWeight * 100).toFixed(0) + "%") : "") +
    (pred.threeWay ? stat("Draw", pct(pred.threeWay.draw, 1), "Davidson 3-way") : "") +
    "</div>";

  out += '<div class="small muted" style="margin-top:8px">' + esc(pred.confidence.text) + "</div>";

  // Feature contributions
  if (pred.features && S.model && S.model.trained && MODEL.modelWeight(S.model) > 0) {
    var contrib = S.model.features.map(function(f, i) {
      var mu = S.model.mean[f] || 0, sd = S.model.std[f] || 1;
      return { f: f, c: S.model.w[i] * (((pred.features[f] || 0) - mu) / sd) };
    }).filter(function(r) { return Math.abs(r.c) > 0.01; })
      .sort(function(a, b) { return Math.abs(b.c) - Math.abs(a.c); }).slice(0, 8);
    if (contrib.length) {
      var max = Math.max.apply(null, contrib.map(function(r) { return Math.abs(r.c); }));
      out += '<div class="section-title">Why</div><div class="card" style="padding:12px 14px">';
      out += contrib.map(function(r) {
        var w = (Math.abs(r.c) / max * 50).toFixed(1);
        var pos = r.c > 0;
        return '<div style="display:flex;align-items:center;gap:10px;margin:6px 0;font-size:12.5px">' +
          '<span style="flex:0 0 150px">' + esc(featureLabel(r.f)) + "</span>" +
          '<span style="flex:1;display:flex;height:9px;background:var(--surface-3);border-radius:3px;overflow:hidden">' +
          '<span style="width:50%;display:flex;justify-content:flex-end">' + (pos ? "" : '<span style="width:' + w + '%;background:var(--series-2)"></span>') + "</span>" +
          '<span style="width:50%">' + (pos ? '<span style="display:block;width:' + w + '%;height:100%;background:var(--series-1)"></span>' : "") + "</span>" +
          "</span>" +
          '<span class="mono" style="flex:0 0 48px;text-align:right">' + (r.c > 0 ? "+" : "") + num(r.c, 2) + "</span></div>";
      }).join("");
      out += '<div class="legend"><span class="key"><span class="swatch" style="background:var(--series-1)"></span>favours ' +
        esc(g.home.shortName || "home") + '</span><span class="key"><span class="swatch" style="background:var(--series-2)"></span>favours ' +
        esc(g.away.shortName || "away") + "</span></div></div>";
    }
  }

  // Goals model
  if (pred.goals) {
    var gl = pred.goals;
    out += '<div class="section-title">Goals model</div>';
    out += '<div class="statgrid">' +
      stat("Expected", num(gl.lambdas.home, 2) + " – " + num(gl.lambdas.away, 2), "goals") +
      stat("Over 2.5", pct(gl.totals[2.5].over, 1), "under " + pct(gl.totals[2.5].under, 1)) +
      stat("Both score", pct(gl.btts, 1), "") +
      stat("Top score", gl.topScores[0].home + "–" + gl.topScores[0].away, pct(gl.topScores[0].p, 1)) +
      "</div>";
    out += '<div class="card scroll-x" style="margin-top:10px"><table class="tbl"><thead><tr><th>Score</th><th class="num">Probability</th></tr></thead><tbody>' +
      gl.topScores.slice(0, 6).map(function(s) {
        return "<tr><td class=\"mono\">" + s.home + " – " + s.away + '</td><td class="num mono">' + pct(s.p, 1) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  // Market
  if (pred.market) {
    out += '<div class="section-title">Market</div>';
    out += '<div class="card scroll-x"><table class="tbl"><thead><tr><th>Side</th><th class="num">Line</th><th class="num">Market (no-vig)</th><th class="num">Model</th><th class="num">Edge</th></tr></thead><tbody>' +
      pred.edges.map(function(e) {
        if (e.fair == null) return "";
        var big = e.edge != null && e.edge >= 0.04;
        return "<tr><td>" + esc(sideName(e.side, g)) + '</td><td class="num mono">' + (e.ml == null ? "—" : (e.ml > 0 ? "+" : "") + e.ml) +
          '</td><td class="num mono">' + pct(e.fair, 1) + '</td><td class="num mono">' + pct(e.model, 1) +
          '</td><td class="num mono"' + (big ? ' style="color:var(--good);font-weight:700"' : "") + ">" +
          (e.edge == null ? "—" : (e.edge > 0 ? "+" : "") + pct(e.edge, 1)) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    out += '<div class="small muted" style="margin-top:6px">Market probabilities have the bookmaker margin removed proportionally' +
      (pred.market.overround ? " (overround " + pct(pred.market.overround - 1, 1) + ")" : "") + ". Paper analysis only.</div>";
  } else if (g.odds) {
    out += '<div class="small muted" style="margin-top:10px">ESPN carried an odds block for this game but no usable moneyline.</div>';
  }

  if (g.predictor) {
    out += '<div class="small muted" style="margin-top:10px">ESPN\'s own model has ' +
      esc(g.home.shortName || "home") + " at " + pct(g.predictor.homeWinProb, 1) + ".</div>";
  }
  return out;
}

function sideName(side, g) {
  if (side === "home") return g.home.shortName || "Home";
  if (side === "away") return g.away.shortName || "Away";
  return "Draw";
}

function fieldDetail(g) {
  var pred = predictionFor(g);
  var out = '<div class="section-title">' + esc(g.name || "Field") + "</div>";
  if (!pred || !pred.entrants) {
    return out + banner("warn", "No ratings for this field yet. Field events need history from the same tour to rate entrants. " +
      '<button class="btn" data-action="train">Load history</button>');
  }
  out += '<div class="small muted" style="margin-bottom:10px">' + pred.fieldSize + " entrants · Plackett-Luce over Elo ratings; top-5 and top-10 by seeded simulation.</div>";
  out += '<div class="card scroll-x"><table class="tbl"><thead><tr><th>#</th><th>Entrant</th><th class="num">Win</th><th class="num">Top 5</th><th class="num">Top 10</th><th class="num">Rating</th></tr></thead><tbody>' +
    pred.entrants.slice(0, 40).map(function(e, i) {
      return "<tr><td class=\"mono muted\">" + (i + 1) + "</td><td>" + esc(e.shortName || e.name || "—") +
        '</td><td class="num mono">' + pct(e.winProb, 1) + '</td><td class="num mono">' + pct(e.top5, 0) +
        '</td><td class="num mono">' + pct(e.top10, 0) + '</td><td class="num mono">' + Math.round(e.rating) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
  return out;
}

// ------------------------------------------------------------------ charts
// Charts are declared in markup as a host div and drawn after render, so they
// can measure their own width.
function chartHost(kind, height, caption) {
  return '<div class="card" style="padding:14px">' +
    '<div class="chart-wrap" data-chart="' + esc(kind) + '" data-h="' + height + '"></div>' +
    (caption ? '<div class="small muted" style="margin-top:8px">' + esc(caption) + "</div>" : "") + "</div>";
}

function drawPendingCharts(root) {
  root.querySelectorAll("[data-chart]").forEach(function(host) {
    var kind = host.dataset.chart;
    var h = parseInt(host.dataset.h, 10) || 200;
    try {
      if (kind === "calib") drawCalibration(host, h);
      else if (kind === "roc") drawRoc(host, h);
      else if (kind === "loss") drawLoss(host, h);
      else if (kind === "equity") drawEquity(host, h);
      else if (kind === "wp") drawWinProb(host, h);
    } catch (e) {
      host.innerHTML = '<div class="small muted">Chart unavailable.</div>';
    }
  });
}

// Minimal line/scatter chart engine: one linear x, one linear y, hover
// crosshair with a tooltip. Deliberately single-axis — never two y-scales.
function makeChart(host, h, opts) {
  opts = opts || {};
  var w = Math.max(280, host.clientWidth || 560);
  var pad = { l: 42, r: 14, t: 10, b: 26 };
  var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  var xd = opts.xDomain || [0, 1], yd = opts.yDomain || [0, 1];
  function sx(v) { return pad.l + (v - xd[0]) / ((xd[1] - xd[0]) || 1) * iw; }
  function sy(v) { return pad.t + ih - (v - yd[0]) / ((yd[1] - yd[0]) || 1) * ih; }
  var parts = [];
  parts.push('<svg class="chart" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="' + esc(opts.label || "chart") + '">');
  // grid + y axis
  var yTicks = opts.yTicks || 4;
  parts.push('<g class="grid">');
  for (var i = 0; i <= yTicks; i++) {
    var v = yd[0] + (yd[1] - yd[0]) * i / yTicks;
    parts.push('<line x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + sy(v).toFixed(1) + '" y2="' + sy(v).toFixed(1) + '"/>');
  }
  parts.push("</g>");
  parts.push('<g class="axis">');
  for (var j = 0; j <= yTicks; j++) {
    var vv = yd[0] + (yd[1] - yd[0]) * j / yTicks;
    parts.push('<text x="' + (pad.l - 7) + '" y="' + (sy(vv) + 3.5).toFixed(1) + '" text-anchor="end">' +
      esc((opts.yFormat || function(x) { return x.toFixed(1); })(vv)) + "</text>");
  }
  var xTicks = opts.xTicks || 4;
  for (var k = 0; k <= xTicks; k++) {
    var xv = xd[0] + (xd[1] - xd[0]) * k / xTicks;
    parts.push('<text x="' + sx(xv).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle">' +
      esc((opts.xFormat || function(x) { return x.toFixed(1); })(xv)) + "</text>");
  }
  parts.push("</g>");
  return { w: w, h: h, pad: pad, iw: iw, ih: ih, sx: sx, sy: sy, parts: parts, xd: xd, yd: yd };
}

function finishChart(host, c, legendHtml, hoverPoints, tipFn) {
  c.parts.push("</svg>");
  host.innerHTML = c.parts.join("") + (legendHtml || "") + '<div class="tooltip"></div>';
  if (!hoverPoints || !hoverPoints.length) return;
  var svg = host.querySelector("svg"), tip = host.querySelector(".tooltip");
  var cursor = document.createElementNS("http://www.w3.org/2000/svg", "line");
  cursor.setAttribute("stroke", "var(--border-strong)");
  cursor.setAttribute("stroke-width", "1");
  cursor.setAttribute("y1", c.pad.t);
  cursor.setAttribute("y2", c.pad.t + c.ih);
  cursor.setAttribute("opacity", "0");
  svg.appendChild(cursor);
  svg.addEventListener("pointermove", function(ev) {
    var box = svg.getBoundingClientRect();
    var px = (ev.clientX - box.left) / box.width * c.w;
    var best = null, bestD = Infinity;
    hoverPoints.forEach(function(p) {
      var d = Math.abs(c.sx(p.x) - px);
      if (d < bestD) { bestD = d; best = p; }
    });
    if (!best) return;
    cursor.setAttribute("x1", c.sx(best.x));
    cursor.setAttribute("x2", c.sx(best.x));
    cursor.setAttribute("opacity", "1");
    tip.innerHTML = tipFn(best);
    tip.style.opacity = "1";
    var left = (c.sx(best.x) / c.w) * box.width;
    tip.style.left = Math.min(Math.max(6, left + 10), box.width - tip.offsetWidth - 6) + "px";
    tip.style.top = "6px";
  });
  svg.addEventListener("pointerleave", function() {
    cursor.setAttribute("opacity", "0");
    tip.style.opacity = "0";
  });
}

function drawCalibration(host, h) {
  var bins = S.model && S.model.metrics.calibration && S.model.metrics.calibration.bins;
  if (!bins || !bins.length) { host.innerHTML = '<div class="small muted">Not enough held-out games to plot calibration.</div>'; return; }
  // Confidence can never be below 50%, but the *observed* win rate in a bin
  // certainly can be -- an over-confident bin where the picks lost more often
  // than they won sits below 0.5. Extend the y axis to cover that rather than
  // letting the point escape the plot area.
  var obs = bins.filter(function(b) { return b.n && b.obar != null; }).map(function(b) { return b.obar; });
  var yLo = Math.min(0.5, obs.length ? Math.min.apply(null, obs) - 0.05 : 0.5);
  var c = makeChart(host, h, {
    xDomain: [0.5, 1], yDomain: [Math.max(0, yLo), 1], label: "Calibration",
    xFormat: function(v) { return (v * 100).toFixed(0) + "%"; },
    yFormat: function(v) { return (v * 100).toFixed(0) + "%"; }
  });
  c.parts.push('<line x1="' + c.sx(0.5) + '" y1="' + c.sy(0.5) + '" x2="' + c.sx(1) + '" y2="' + c.sy(1) +
    '" stroke="var(--text-muted)" stroke-dasharray="4 4" stroke-width="1"/>');
  var pts = [];
  bins.forEach(function(b) {
    if (!b.n || b.pbar == null) return;
    var x = b.pbar, y = b.obar;
    var r = Math.max(3.5, Math.min(11, Math.sqrt(b.n) * 1.5));
    c.parts.push('<circle cx="' + c.sx(x).toFixed(1) + '" cy="' + c.sy(y).toFixed(1) + '" r="' + r.toFixed(1) +
      '" fill="var(--series-1)" fill-opacity="0.75" stroke="var(--surface-1)" stroke-width="2"/>');
    pts.push({ x: x, y: y, n: b.n });
  });
  finishChart(host, c,
    '<div class="legend"><span class="key"><span class="swatch" style="background:var(--series-1)"></span>Held-out bins (size = games)</span>' +
    '<span class="key"><span class="swatch" style="background:var(--text-muted)"></span>Perfect calibration</span></div>',
    pts, function(p) { return "Predicted " + pct(p.x, 0) + "<br>Actually won " + pct(p.y, 0) + "<br>" + p.n + " games"; });
}

function drawRoc(host, h) {
  var m = S.model;
  if (!m || !m.trained) { host.innerHTML = ""; return; }
  var pairs = null;
  // Recompute test pairs (they aren't persisted with the model).
  if (S.samples) {
    var parts = BT.chronoSplit(BT.splitDraws(S.samples).binary, 0.75);
    var ev = evaluateLogisticRegression(parts.test, m.features, m, m.mean, m.std);
    pairs = ev.pairs;
  }
  if (!pairs || !pairs.length) { host.innerHTML = '<div class="small muted">No held-out pairs to plot.</div>'; return; }
  var curve = rocCurve(pairs);
  var c = makeChart(host, h, {
    xDomain: [0, 1], yDomain: [0, 1], label: "ROC curve",
    xFormat: function(v) { return v.toFixed(1); }, yFormat: function(v) { return v.toFixed(1); }
  });
  c.parts.push('<line x1="' + c.sx(0) + '" y1="' + c.sy(0) + '" x2="' + c.sx(1) + '" y2="' + c.sy(1) +
    '" stroke="var(--text-muted)" stroke-dasharray="4 4" stroke-width="1"/>');
  var d = curve.map(function(p, i) { return (i ? "L" : "M") + c.sx(p.fpr).toFixed(1) + " " + c.sy(p.tpr).toFixed(1); }).join(" ");
  c.parts.push('<path d="' + d + '" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>');
  finishChart(host, c,
    '<div class="legend"><span class="key"><span class="swatch" style="background:var(--series-1)"></span>Model (AUC ' +
    num(m.metrics.auc, 3) + ')</span><span class="key"><span class="swatch" style="background:var(--text-muted)"></span>Chance</span></div>',
    null, null);
}

function drawLoss(host, h) {
  var m = S.model;
  if (!m || !m.lossCurve || m.lossCurve.length < 2) { host.innerHTML = '<div class="small muted">No loss curve retained.</div>'; return; }
  var lc = m.lossCurve;
  var lo = Math.min.apply(null, lc), hi = Math.max.apply(null, lc);
  var c = makeChart(host, h, {
    xDomain: [0, lc.length - 1], yDomain: [Math.max(0, lo - 0.02), hi + 0.02], label: "Training loss",
    xFormat: function(v) { return Math.round(v * 20) + ""; }, yFormat: function(v) { return v.toFixed(2); }, yTicks: 3
  });
  var d = lc.map(function(v, i) { return (i ? "L" : "M") + c.sx(i).toFixed(1) + " " + c.sy(v).toFixed(1); }).join(" ");
  c.parts.push('<path d="' + d + '" fill="none" stroke="var(--series-3)" stroke-width="2"/>');
  finishChart(host, c, '<div class="legend"><span class="key"><span class="swatch" style="background:var(--series-3)"></span>Mean log loss (epoch)</span></div>',
    lc.map(function(v, i) { return { x: i, y: v }; }),
    function(p) { return "Epoch " + (p.x * 20) + "<br>Loss " + p.y.toFixed(4); });
}

function drawEquity(host, h) {
  var curve = window.__msEquity;
  if (!curve || curve.length < 2) { host.innerHTML = '<div class="small muted">Not enough bets to plot.</div>'; return; }
  var pnls = curve.map(function(p) { return p.pnl; });
  var lo = Math.min(0, Math.min.apply(null, pnls)), hi = Math.max(0, Math.max.apply(null, pnls));
  var padY = Math.max(1, (hi - lo) * 0.1);
  var c = makeChart(host, h, {
    xDomain: [0, curve.length - 1], yDomain: [lo - padY, hi + padY], label: "Paper P/L",
    xFormat: function(v) { return Math.round(v) + ""; }, yFormat: function(v) { return v.toFixed(0) + "u"; }, yTicks: 4
  });
  c.parts.push('<line x1="' + c.sx(0) + '" x2="' + c.sx(curve.length - 1) + '" y1="' + c.sy(0) + '" y2="' + c.sy(0) +
    '" stroke="var(--text-muted)" stroke-dasharray="3 3"/>');
  var d = curve.map(function(p, i) { return (i ? "L" : "M") + c.sx(i).toFixed(1) + " " + c.sy(p.pnl).toFixed(1); }).join(" ");
  var final = curve[curve.length - 1].pnl;
  var col = final >= 0 ? "var(--series-3)" : "var(--series-2)";
  c.parts.push('<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round"/>');
  finishChart(host, c, '<div class="legend"><span class="key"><span class="swatch" style="background:' + col + '"></span>Cumulative paper P/L (units)</span></div>',
    curve.map(function(p, i) { return { x: i, y: p.pnl, d: p }; }),
    function(p) { return esc(p.d.date ? p.d.date.slice(0, 10) : "") + "<br>P/L " + p.y.toFixed(2) + "u<br>" + esc(p.d.side) + " · edge " + pct(p.d.edge, 1); });
}

function drawWinProb(host, h) {
  var data = window.__msWp;
  if (!data || !data.series || data.series.length < 2) { host.innerHTML = '<div class="small muted">Not enough plays to chart.</div>'; return; }
  var series = data.series;
  var c = makeChart(host, h, {
    xDomain: [0, series.length - 1], yDomain: [0, 1], label: "Win probability",
    xFormat: function(v) {
      var p = series[Math.round(v)];
      return p && p.period ? "P" + p.period : "";
    },
    yFormat: function(v) { return (v * 100).toFixed(0) + "%"; }, yTicks: 4, xTicks: 5
  });
  c.parts.push('<line x1="' + c.sx(0) + '" x2="' + c.sx(series.length - 1) + '" y1="' + c.sy(0.5) + '" y2="' + c.sy(0.5) +
    '" stroke="var(--text-muted)" stroke-dasharray="3 3"/>');

  // ESPN's own line, when the league has one, drawn behind ours.
  var legend = "";
  if (data.espn && data.espn.length > 3) {
    var e = data.espn;
    var de = e.map(function(p, i) {
      return (i ? "L" : "M") + c.sx(i / (e.length - 1) * (series.length - 1)).toFixed(1) + " " + c.sy(p.homeWinProb).toFixed(1);
    }).join(" ");
    c.parts.push('<path d="' + de + '" fill="none" stroke="var(--series-4)" stroke-width="2" opacity="0.75"/>');
    legend += '<span class="key"><span class="swatch" style="background:var(--series-4)"></span>ESPN</span>';
  }
  var d = series.map(function(p, i) { return (i ? "L" : "M") + c.sx(i).toFixed(1) + " " + c.sy(p.homeWinProb).toFixed(1); }).join(" ");
  c.parts.push('<path d="' + d + '" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>');
  // Mark scoring plays.
  series.forEach(function(p, i) {
    if (!p.scoringPlay) return;
    c.parts.push('<circle cx="' + c.sx(i).toFixed(1) + '" cy="' + c.sy(p.homeWinProb).toFixed(1) +
      '" r="3.2" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="1.5"/>');
  });

  var homeName = (data.home && (data.home.shortName || data.home.abbrev)) || "Home";
  legend = '<span class="key"><span class="swatch" style="background:var(--series-1)"></span>' + esc(homeName) + " win prob (our model)</span>" + legend;
  finishChart(host, c, '<div class="legend">' + legend + "</div>",
    series.map(function(p, i) { return { x: i, y: p.homeWinProb, d: p }; }),
    function(p) {
      var d0 = p.d;
      return "<strong>" + pct(d0.homeWinProb, 1) + "</strong> " + esc(homeName) +
        (d0.delta ? ' <span style="color:' + (d0.delta >= 0 ? "var(--series-1)" : "var(--series-2)") + '">' + (d0.delta >= 0 ? "+" : "") + pct(d0.delta, 1) + "</span>" : "") +
        "<br><span style=\"white-space:normal;display:block;max-width:230px\">" + esc((d0.text || "").slice(0, 110)) + "</span>";
    });
}

// ------------------------------------------------------------------ go
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
