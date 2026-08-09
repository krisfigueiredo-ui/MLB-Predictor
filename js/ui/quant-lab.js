(function(root) {
  "use strict";

  var SNAPSHOT_KEY = "mlb_prediction_snapshots_v1";
  var MODEL_VERSION = "2.0.0-shadow";
  var CALIBRATION_VERSION = "rolling-alpha-v1";
  var state = {
    view: "slate",
    selectedGameId: null,
    filter: "all",
    marketFilter: "any",
    confidenceFilter: "any",
    sort: "time",
    sortDir: 1,
    performanceMetric: "accuracy",
    performanceRolling: 50,
    selectedSource: 0,
    modelToggles: {},
    overlays: { dimensions: true, defense: false },
    quality: "medium",
    pitchCache: {},
    engine: null,
    legacyRenderToday: null,
    initialized: false
  };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>\"]/g, function(ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  function finite(value) { return typeof value === "number" && isFinite(value); }
  function pct(value, digits) { return finite(value) ? (value * 100).toFixed(digits == null ? 1 : digits) + "%" : "—"; }
  function signedPct(value, digits) { return finite(value) ? (value >= 0 ? "+" : "") + (value * 100).toFixed(digits == null ? 1 : digits) + "%" : "—"; }
  function num(value, digits) { return finite(Number(value)) ? Number(value).toFixed(digits == null ? 1 : digits) : "—"; }
  function ml(value) { return finite(Number(value)) ? (Number(value) > 0 ? "+" : "") + Math.round(Number(value)) : "—"; }
  function safeCall(name, args) { try { return typeof root[name] === "function" ? root[name].apply(root, args || []) : null; } catch (error) { return null; } }
  function games() { return Array.isArray(root.GAMES30) ? root.GAMES30 : []; }
  function selectedGame() {
    var list = games();
    if (!state.selectedGameId && list.length) state.selectedGameId = list[0].id;
    return list.filter(function(game) { return String(game.id) === String(state.selectedGameId); })[0] || list[0] || null;
  }
  function logoUrl(team) { return root.LOGO_URL && root.LOGO_URL[team] || ""; }
  function logo(team, alt) {
    var url = logoUrl(team);
    return url ? '<img class="ql-team-logo" src="'+esc(url)+'" alt="'+esc(alt || team)+'">' : '<span class="ql-team-code">'+esc(team)+'</span>';
  }
  function fullName(team) { return root.TEAM_NAMES && root.TEAM_NAMES[team] ? root.TEAM_NAMES[team] : team; }
  function teamLabel(team) { return fullName(team) === team ? team : fullName(team); }
  function gameStatus(game) {
    if (game.status === "live") return "LIVE";
    if (game.status === "final") return "FINAL";
    if (game.status === "void") return "POSTPONED";
    if (game.status === "delayed") return "DELAYED";
    return "UPCOMING";
  }
  function localDate(value, options) {
    var date = new Date(value);
    return isFinite(date.getTime()) ? date.toLocaleString("en-US", options) : "—";
  }

  function getSnapshotStore() {
    var raw = null;
    try { raw = root.LS ? root.LS.getItem(SNAPSHOT_KEY) : localStorage.getItem(SNAPSHOT_KEY); } catch (error) {}
    return root.parseSnapshotStore ? root.parseSnapshotStore(raw) : { schema: 1, snapshots: {}, legacy: [] };
  }
  function saveSnapshotStore(store) {
    try {
      var value = JSON.stringify(store);
      if (root.LS) root.LS.setItem(SNAPSHOT_KEY, value); else localStorage.setItem(SNAPSHOT_KEY, value);
    } catch (error) {}
  }
  function gradedSnapshots(before) {
    var snapshots = getSnapshotStore().snapshots || {};
    return Object.keys(snapshots).map(function(key) { return snapshots[key]; }).filter(function(snapshot) {
      return snapshot.result && (!before || snapshot.firstPitch < before);
    }).sort(function(a, b) { return a.firstPitch - b.firstPitch; });
  }

  function modelDetail(game) {
    if (!game) return null;
    var sp = root.SP && root.SP[game.id];
    var feature = safeCall("predictFull", [game.home, game.away, sp, game.id, game.ump]);
    var fullLogit = feature && finite(feature.logit) ? feature.logit : 0;
    var eloContribution = feature && feature.contrib && finite(feature.contrib.elo) ? feature.contrib.elo : 0;
    var featureOnly = root.logitToProbability ? root.logitToProbability(fullLogit - eloContribution) : game.homeP;
    var elo = safeCall("eloProbHome", [game.home, game.away]);
    var poisson = game.pois && finite(game.pois.pHome) ? game.pois.pHome : null;
    var parts = { elo: finite(elo) ? elo : null, poisson: poisson, feature: finite(featureOnly) ? featureOnly : null };
    var prior = gradedSnapshots(game.startMs).map(function(snapshot) {
      return { rawProb: snapshot.rawProb, y: snapshot.result.actualHome ? 1 : 0, firstPitch: snapshot.firstPitch };
    });
    var fit = root.fitPriorShrinkage ? root.fitPriorShrinkage(prior, "rawProb", { minGames: 30 }) : { alpha: 1, n: 0, fitted: false };
    var pipeline = root.probabilityPipeline ? root.probabilityPipeline(parts, {
      alpha: fit.alpha,
      weights: { elo: 0.15, poisson: 0.33, feature: 0.52 }
    }) : { rawProbability: game.homeP, calibratedProbability: game.homeP, dispersion: null, agreement: "Unavailable" };
    return {
      feature: feature || { contrib: {}, raw: {}, logit: 0 },
      parts: parts,
      rawProbability: pipeline.rawProbability,
      calibratedProbability: pipeline.calibratedProbability,
      publishedProbability: game.homeP,
      dispersion: pipeline.dispersion,
      agreement: pipeline.agreement,
      alpha: fit.alpha,
      calibrationN: fit.n,
      calibrationFitted: fit.fitted
    };
  }

  function dataQuality(game) {
    if (!game) return { score: 0, level: "low", checks: {} };
    var sp = root.SP && root.SP[game.id];
    var odds = root.ODDS && root.ODDS[game.id];
    var homeSplit = root.TEAM_SPLITS && root.TEAM_SPLITS[game.home];
    var awaySplit = root.TEAM_SPLITS && root.TEAM_SPLITS[game.away];
    var checks = {
      schedule: true,
      standings: !!(root.STANDINGS_OK && homeSplit && homeSplit._real && awaySplit && awaySplit._real),
      starterNames: !!(sp && sp.h && sp.a && sp.h.name && sp.a.name),
      starterMetrics: !!(sp && sp.h && sp.a && sp.h.realQ && sp.a.realQ),
      weather: !!(sp && sp.wxReal),
      market: !!(odds && odds.real),
      injuries: !!(root.INJURIES && Object.keys(root.INJURIES).length),
      liveFeed: root.ESPN_OK === true
    };
    var weights = { schedule: 15, standings: 20, starterNames: 10, starterMetrics: 20, weather: 8, market: 12, injuries: 5, liveFeed: 10 };
    var score = Object.keys(weights).reduce(function(sum, key) { return sum + (checks[key] ? weights[key] : 0); }, 0);
    return { score: score, level: score >= 85 ? "high" : score >= 60 ? "medium" : "low", checks: checks };
  }

  function marketForPick(game) {
    var odds = root.ODDS && root.ODDS[game.id];
    if (!odds || !odds.real) return { probability: null, odds: null, edge: null, side: null, provider: null };
    var pickHome = game.homeP >= .5;
    var probability = pickHome ? odds.homeImpl : odds.awayImpl;
    var price = pickHome ? odds.homeML : odds.awayML;
    var model = pickHome ? game.homeP : game.awayP;
    return { probability: probability, odds: price, edge: model - probability, side: pickHome ? game.home : game.away, provider: odds.provider || "ESPN" };
  }

  function marketSnapshot(game) {
    var odds = root.ODDS && root.ODDS[game.id], line = root.LINES && root.LINES[game.id];
    if (!odds || !odds.real) return null;
    return {
      provider: odds.provider || "ESPN",
      openHomeML: line && line.oHML != null ? line.oHML : null,
      openAwayML: line && line.oAML != null ? line.oAML : null,
      predictionHomeML: odds.homeML,
      predictionAwayML: odds.awayML,
      predictionHomeNoVig: odds.homeImpl,
      predictionAwayNoVig: odds.awayImpl,
      closingHomeML: null,
      closingAwayML: null,
      capturedAt: Date.now()
    };
  }

  function maybeFreezeSnapshots() {
    if (!root.createPredictionSnapshot || !root.appendImmutableSnapshot) return;
    var now = Date.now(), store = getSnapshotStore(), changed = false;
    games().forEach(function(game) {
      var existing = store.snapshots[game.id];
      if (existing && game.status === "final" && game.finalScore && !existing.result && root.gradePredictionSnapshot) {
        store = root.gradePredictionSnapshot(store, String(game.id), { homeScore: game.finalScore.h, awayScore: game.finalScore.a, gradedAt: now });
        changed = true;
        return;
      }
      if (existing || game.status !== "pre" || !finite(game.startMs)) return;
      var untilFirstPitch = game.startMs - now;
      if (untilFirstPitch < 0 || untilFirstPitch > 30 * 60 * 1000) return;
      var detail = modelDetail(game), quality = dataQuality(game), market = marketSnapshot(game);
      var prior = gradedSnapshots(game.startMs);
      var snapshot = root.createPredictionSnapshot({
        gameId: String(game.id), timestamp: now, firstPitch: game.startMs,
        modelVersion: MODEL_VERSION, weightVersion: root.WEIGHTS_SCHEMA || "legacy-weights",
        calibrationVersion: CALIBRATION_VERSION, trainingCutoff: prior.length ? prior[prior.length - 1].firstPitch : null,
        rawProb: detail.rawProbability, calibratedProb: detail.calibratedProbability, publishedProb: game.homeP,
        eloProb: detail.parts.elo, poissonProb: detail.parts.poisson, featureProb: detail.parts.feature,
        features: detail.feature.raw, contributions: detail.feature.contrib,
        dataQuality: { score: quality.score, checks: quality.checks },
        market: market, home: game.home, away: game.away
      }, now);
      if (snapshot) { store = root.appendImmutableSnapshot(store, snapshot); changed = true; }
    });
    if (changed) saveSnapshotStore(store);
  }

  function slateRows() {
    var now = Date.now();
    var list = games().map(function(game) {
      return { game: game, detail: modelDetail(game), quality: dataQuality(game), market: marketForPick(game) };
    });
    list = list.filter(function(row) {
      var game = row.game, viewMatch = true;
      if (state.filter === "soon") viewMatch = game.status === "pre" && game.startMs >= now && game.startMs <= now + 90 * 60000;
      else if (state.filter === "edge") viewMatch = finite(row.market.edge) && row.market.edge >= .04;
      else if (state.filter === "agreement") viewMatch = row.detail.agreement === "Strong";
      else if (state.filter === "complete") viewMatch = row.quality.score >= 85;
      else if (state.filter === "live") viewMatch = game.status === "live";
      if (!viewMatch) return false;
      if (state.marketFilter === "available" && row.market.probability == null) return false;
      if (state.marketFilter === "unavailable" && row.market.probability != null) return false;
      if (state.confidenceFilter === "60" && game.conf < .60) return false;
      if (state.confidenceFilter === "70" && game.conf < .70) return false;
      return true;
    });
    var direction = state.sortDir;
    list.sort(function(a, b) {
      var av, bv;
      if (state.sort === "confidence") { av = a.game.conf; bv = b.game.conf; }
      else if (state.sort === "edge") { av = a.market.edge == null ? -9 : a.market.edge; bv = b.market.edge == null ? -9 : b.market.edge; }
      else if (state.sort === "disagreement") { av = a.detail.dispersion == null ? 9 : a.detail.dispersion; bv = b.detail.dispersion == null ? 9 : b.detail.dispersion; }
      else if (state.sort === "runs") { av = a.game.pois ? a.game.pois.total : -9; bv = b.game.pois ? b.game.pois.total : -9; }
      else if (state.sort === "quality") { av = a.quality.score; bv = b.quality.score; }
      else { av = a.game.startMs || 0; bv = b.game.startMs || 0; }
      return (av - bv) * direction;
    });
    return list;
  }

  function renderSlate() {
    var rootEl = document.getElementById("ql-slate-root"); if (!rootEl) return;
    var list = slateRows(), game = selectedGame();
    var providers = games().map(function(g) { var o = root.ODDS && root.ODDS[g.id]; return o && o.real ? o.provider : null; }).filter(Boolean);
    var dateLabel = localDate(Date.now(), { weekday: "long", month: "long", day: "numeric" });
    var body = list.length ? list.map(renderSlateRow).join("") : '<tr class="ql-table-empty"><td colspan="8">No games match the selected filter. The verified slate remains available under All.</td></tr>';
    rootEl.innerHTML = '<div class="ql-page-head"><div><div class="ql-eyebrow">MLB SLATE · '+games().length+' GAME'+(games().length === 1 ? '' : 'S')+' · UPDATED '+esc(root.ESPN_LAST?localDate(root.ESPN_LAST,{hour:'numeric',minute:'2-digit'}):'PENDING')+' ET</div><h1>'+esc(dateLabel)+'</h1><p>Today’s games, model probabilities, projected scoring, and verified market coverage.</p></div>'
      +'<div class="ql-inline-meta"><span><i class="ql-source-dot '+(root.ESPN_OK ? "" : "pending")+'"></i>'+ (root.ESPN_OK ? "Schedule live" : "Schedule pending") +'</span><span>Market coverage <strong>'+providers.length+'/'+games().length+'</strong></span></div></div>'
      +'<div class="ql-workspace"><section class="ql-slate-pane"><div class="ql-toolbar">'
      +'<div class="ql-tool"><label>View</label><select class="ql-control" aria-label="Slate view" onchange="QuantLabUI.setSlateFilter(this.value)"><option value="all" '+(state.filter==='all'?'selected':'')+'>All games</option><option value="soon" '+(state.filter==='soon'?'selected':'')+'>Starting soon</option><option value="live" '+(state.filter==='live'?'selected':'')+'>Live</option><option value="edge" '+(state.filter==='edge'?'selected':'')+'>Qualified edge</option><option value="agreement" '+(state.filter==='agreement'?'selected':'')+'>Model agreement</option><option value="complete" '+(state.filter==='complete'?'selected':'')+'>Data complete</option></select></div>'
      +'<div class="ql-tool"><label>Sort</label><select class="ql-control" aria-label="Sort slate" onchange="QuantLabUI.setSlateSort(this.value)"><option value="time" '+(state.sort==="time"?"selected":"")+'>Game time</option><option value="confidence" '+(state.sort==="confidence"?"selected":"")+'>Confidence</option><option value="edge" '+(state.sort==="edge"?"selected":"")+'>Edge</option><option value="disagreement" '+(state.sort==="disagreement"?"selected":"")+'>Disagreement</option><option value="runs" '+(state.sort==="runs"?"selected":"")+'>Projected runs</option><option value="quality" '+(state.sort==="quality"?"selected":"")+'>Data quality</option></select></div>'
      +'<div class="ql-tool"><label>Market</label><select class="ql-control" aria-label="Market availability" onchange="QuantLabUI.setMarketFilter(this.value)"><option value="any" '+(state.marketFilter==='any'?'selected':'')+'>Any</option><option value="available" '+(state.marketFilter==='available'?'selected':'')+'>Available</option><option value="unavailable" '+(state.marketFilter==='unavailable'?'selected':'')+'>Unavailable</option></select></div>'
      +'<div class="ql-tool"><label>Confidence</label><select class="ql-control" aria-label="Model confidence" onchange="QuantLabUI.setConfidenceFilter(this.value)"><option value="any" '+(state.confidenceFilter==='any'?'selected':'')+'>Any</option><option value="60" '+(state.confidenceFilter==='60'?'selected':'')+'>60%+</option><option value="70" '+(state.confidenceFilter==='70'?'selected':'')+'>70%+</option></select></div></div>'
      +'<div class="ql-table-scroll"><table class="ql-table" aria-label="Today\'s MLB prediction slate"><colgroup><col style="width:12%"><col style="width:21%"><col style="width:24%"><col style="width:11%"><col style="width:10%"><col style="width:9%"><col style="width:7%"><col style="width:8%"></colgroup><thead><tr><th>Time</th><th>Matchup</th><th>Starters</th><th class="num">Model</th><th class="num">Market</th><th class="num">Edge</th><th class="num">Runs</th><th class="num">Data</th></tr></thead><tbody>'+body+'</tbody></table></div></section>'
      +'<aside class="ql-inspector" aria-label="Selected matchup preview">'+renderInspector(game)+'</aside></div>';
  }

  function renderSlateRow(row) {
    var game=row.game, sp=root.SP&&root.SP[game.id], pick=game.homeP>=.5?game.home:game.away, selected=String(game.id)===String(state.selectedGameId);
    var market=row.market.probability, edge=row.market.edge, status=gameStatus(game);
    var statusDetail=game.status==="live"&&game.live&&game.live.inning?game.live.inning:status;
    var starters=sp&&sp.h&&sp.a?esc(sp.a.name||"TBD")+'<span class="ql-subline">'+esc(sp.h.name||"TBD")+'</span>':'TBD<span class="ql-subline">Starter data pending</span>';
    var q=row.quality;
    return '<tr class="'+(selected?'selected ':'')+(game.status==='live'?'live':'')+'" tabindex="0" onclick="QuantLabUI.selectGame(\''+esc(game.id)+'\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();QuantLabUI.selectGame(\''+esc(game.id)+'\')}">'
      +'<td><span class="ql-time">'+esc(game.time||"—")+'</span><span class="ql-subline ql-state '+(game.status==='live'?'live':'')+'">'+esc(statusDetail)+'</span></td>'
      +'<td><div class="ql-matchup">'+logo(game.away,game.away)+'<span class="ql-team-code">'+esc(game.away)+'</span><span class="ql-at">@</span>'+logo(game.home,game.home)+'<span class="ql-team-code">'+esc(game.home)+'</span></div><span class="ql-subline">'+esc(teamLabel(pick))+' lean</span></td>'
      +'<td class="ql-starters">'+starters+'</td>'
      +'<td class="num"><span class="ql-value">'+esc(pick)+' '+pct(Math.max(game.homeP,game.awayP),1)+'</span><span class="ql-subline">'+esc(row.detail.agreement)+' agreement</span></td>'
      +'<td class="num"><span class="ql-value">'+(market==null?'—':pct(market,1))+'</span><span class="ql-subline">'+(row.market.odds==null?'No line':ml(row.market.odds))+'</span></td>'
      +'<td class="num"><span class="ql-edge '+(edge!=null&&edge>=.04?'positive':edge!=null&&edge<0?'negative':'')+'">'+signedPct(edge,1)+'</span></td>'
      +'<td class="num"><span class="ql-value">'+(game.pois?num(game.pois.total,1):'—')+'</span></td>'
      +'<td class="num"><div class="ql-quality '+q.level+'"><i class="ql-quality-dot"></i><span class="ql-value">'+q.score+'%</span></div></td>'
      +'<td class="ql-mobile-game"><div class="ql-mobile-main"><strong>'+esc(game.away)+' @ '+esc(game.home)+'</strong><b>'+esc(pick)+' '+pct(Math.max(game.homeP,game.awayP),1)+'</b></div><div class="ql-mobile-sub"><span>'+esc(sp&&sp.a&&sp.a.name||'TBD')+' / '+esc(sp&&sp.h&&sp.h.name||'TBD')+'</span><time>'+esc(game.time||'—')+'</time></div><div class="ql-mobile-foot"><span>Projected '+(game.pois?num(game.pois.lambdaA,1)+'–'+num(game.pois.lambdaH,1):'—')+'</span><span>Market '+(market==null?'—':pct(market,1))+'</span><span class="ql-state '+(game.status==='live'?'live':'')+'">'+esc(statusDetail)+'</span></div></td></tr>';
  }

  function renderInspector(game) {
    if (!game) return '<div class="ql-empty"><strong>No matchup selected</strong><span>The game workspace will populate when the official slate is available.</span></div>';
    var detail=modelDetail(game), quality=dataQuality(game), market=marketForPick(game), pickHome=game.homeP>=.5, pick=pickHome?game.home:game.away;
    var park=root.stadiumForTeam?root.stadiumForTeam(game.home,root.PARK&&root.PARK[game.home]):{name:"Home ballpark"};
    var score=game.pois?(game.home+' '+num(game.pois.lambdaH,1)+' — '+game.away+' '+num(game.pois.lambdaA,1)):'—';
    return '<div class="ql-inspector-inner"><div class="ql-inspector-kicker"><span>'+esc(gameStatus(game))+' · '+esc(game.time||'Time pending')+'</span><span>'+esc(park.name)+'</span></div>'
      +'<div class="ql-inspector-scoreline"><div class="ql-inspector-club">'+logo(game.away,game.away)+'<div><strong>'+esc(game.away)+'</strong><span>'+esc(teamLabel(game.away))+'</span></div></div><div class="ql-inspector-vs">AT</div><div class="ql-inspector-club home"><div><strong>'+esc(game.home)+'</strong><span>'+esc(teamLabel(game.home))+'</span></div>'+logo(game.home,game.home)+'</div></div>'
      +'<div class="ql-inspector-decision"><div class="ql-inspector-pick"><span>MODEL PICK</span><strong>'+esc(teamLabel(pick))+'</strong></div><div class="ql-inspector-prob"><strong>'+pct(Math.max(game.homeP,game.awayP),1)+'</strong><span>win probability</span></div></div>'
      +'<div class="ql-inspector-grid"><div class="ql-inspector-stat"><span>Market</span><strong>'+(market.probability==null?'—':pct(market.probability,1))+'</strong></div><div class="ql-inspector-stat"><span>Edge</span><strong class="'+(market.edge>=.04?'ql-edge positive':'')+'">'+signedPct(market.edge,1)+'</strong></div><div class="ql-inspector-stat"><span>Projected</span><strong>'+esc(score)+'</strong></div><div class="ql-inspector-stat"><span>Data</span><strong>'+quality.score+'%</strong></div></div>'
      +'<div class="ql-inspector-section"><h3>Base-model view</h3>'+modelRows(detail,pickHome)+'</div>'
      +'<div class="ql-inspector-section"><h3>Read</h3><p style="margin:0;color:var(--text-secondary);font-size:11px;line-height:1.55">'+esc(inspectorRead(game,detail,market,quality))+'</p></div>'
      +'<div class="ql-actions"><button class="ql-primary" onclick="QuantLabUI.openGame()">Open game analysis</button><button class="ql-secondary" onclick="QuantLabUI.enterBallpark()">Enter ballpark</button></div></div>';
  }

  function modelRows(detail, pickHome) {
    var rows=[['Elo',detail.parts.elo],['Poisson',detail.parts.poisson],['Feature',detail.parts.feature],['Published',detail.publishedProbability]];
    return rows.map(function(row){var value=finite(row[1])?(pickHome?row[1]:1-row[1]):null;return '<div class="ql-model-row"><span>'+row[0]+'</span><div class="ql-model-track"><i style="left:'+(value==null?50:value*100)+'%"></i></div><strong>'+pct(value,1)+'</strong></div>';}).join('');
  }

  function inspectorRead(game,detail,market,quality) {
    var pick=game.homeP>=.5?game.home:game.away;
    var parts=[pick+' is the current model side at '+pct(Math.max(game.homeP,game.awayP),1)+'.'];
    if(market.probability==null)parts.push('No verified market line is available.');else parts.push('The no-vig market comparison is '+signedPct(market.edge,1)+'.');
    parts.push('Base-model agreement is '+detail.agreement.toLowerCase()+'.');
    if(quality.score<85)parts.push('Some inputs remain pending and contribute neutrally.');
    return parts.join(' ');
  }

  function compareValue(value, fallback) { return value == null || value === "" ? (fallback || "—") : value; }
  function splitFor(team) { return root.TEAM_SPLITS && root.TEAM_SPLITS[team] || {}; }
  function gameComparison(game) {
    var away=splitFor(game.away),home=splitFor(game.home),sp=root.SP&&root.SP[game.id],aq=sp&&sp.a||{},hq=sp&&sp.h||{};
    var restAway=root.REST_OK?(root.PLAYED_YDAY&&root.PLAYED_YDAY[game.away]?0:1):null,restHome=root.REST_OK?(root.PLAYED_YDAY&&root.PLAYED_YDAY[game.home]?0:1):null;
    var rows=[
      {group:'Team'},
      ['Elo',Math.round(safeCall('eloR',[game.away])||1500),Math.round(safeCall('eloR',[game.home])||1500),'Derived from verified results'],
      ['Season record',away._real?away.rec:'—',home._real?home.rec:'—','ESPN standings'],
      ['Pythagorean W%',away._real?pct(safeCall('pythagExp',[game.away]),1):'—',home._real?pct(safeCall('pythagExp',[game.home]),1):'—','Derived from record and run differential'],
      ['Last 10',away._real?compareValue(away.l10):'—',home._real?compareValue(home.l10):'—','ESPN standings'],
      {group:'Starting pitcher'},
      ['Pitcher',compareValue(aq.name,'Not posted'),compareValue(hq.name,'Not posted'),'ESPN / MLB probable starters'],
      ['ERA / xFIP proxy',aq.realQ?compareValue(aq.xfip):'—',hq.realQ?compareValue(hq.xfip):'—','Verified feed; neutral when unavailable'],
      ['WHIP',aq.realWhip?compareValue(aq.whip):'—',hq.realWhip?compareValue(hq.whip):'—','Verified feed'],
      ['K/9',aq.realK9?compareValue(aq.k9):'—',hq.realK9?compareValue(hq.k9):'—','Verified feed'],
      {group:'Offense and context'},
      ['Lineup index',sp&&sp.lineup&&away._real?num(sp.lineup.a,0):'—',sp&&sp.lineup&&home._real?num(sp.lineup.h,0):'—','Derived from verified team context'],
      ['Rest days',restAway==null?'—':restAway,restHome==null?'—':restHome,'Prior-day verified schedule'],
      ['Bullpen workload','—','—','No verified workload feed; excluded'],
      ['Weather',sp&&sp.wxReal?sp.weather:'—',sp&&sp.wxReal?sp.weather:'—','ESPN game conditions']
    ];
    return rows;
  }

  function renderGame() {
    var host=document.getElementById('ql-game-root');if(!host)return;var game=selectedGame();
    if(!game){host.innerHTML='<div class="ql-empty"><strong>No game selected</strong><span>Select a matchup from the Slate to open its analysis.</span><button class="ql-secondary" style="margin-top:14px" onclick="setTab(\'slate\')">Return to slate</button></div>';return;}
    var detail=modelDetail(game),quality=dataQuality(game),market=marketForPick(game),park=root.stadiumForTeam?root.stadiumForTeam(game.home,root.PARK&&root.PARK[game.home]):{name:'Home ballpark'};
    var pickHome=game.homeP>=.5,pick=pickHome?game.home:game.away,opp=pickHome?game.away:game.home;
    var projected=game.pois?game.home+' '+num(game.pois.lambdaH,1)+' — '+game.away+' '+num(game.pois.lambdaA,1):'—';
    host.innerHTML='<div class="ds-matchup-hero"><div class="ds-matchup-context"><span>'+esc(gameStatus(game))+' · '+esc(game.time||'TIME PENDING')+'</span><span>'+esc(park.name)+'</span></div><div class="ds-matchup-line"><div class="ds-hero-team">'+logo(game.away,game.away)+'<span><b>'+esc(game.away)+'</b><small>'+esc(teamLabel(game.away))+'</small></span><strong>'+pct(game.awayP,1)+'</strong></div><div class="ds-hero-at">@</div><div class="ds-hero-team home">'+logo(game.home,game.home)+'<span><b>'+esc(game.home)+'</b><small>'+esc(teamLabel(game.home))+'</small></span><strong>'+pct(game.homeP,1)+'</strong></div></div><div class="ds-model-pick"><span>MODEL PICK</span><strong>'+esc(pick)+' '+pct(Math.max(game.homeP,game.awayP),1)+'</strong><small>Projected '+esc(projected)+'</small></div><div class="ql-actions"><button class="ql-tertiary" onclick="setTab(\'slate\')">Back to slate</button><button class="ql-primary" onclick="QuantLabUI.enterBallpark()">Enter ballpark</button></div></div>'
      +'<div class="ql-game-scorecard"><div><span>Starting pitchers</span><strong>'+esc(((root.SP&&root.SP[game.id]&&root.SP[game.id].a)||{}).name||'TBD')+' / '+esc(((root.SP&&root.SP[game.id]&&root.SP[game.id].h)||{}).name||'TBD')+'</strong></div><div><span>Market</span><strong>'+(market.probability==null?'Unavailable':esc(pick)+' '+pct(market.probability,1))+'</strong></div><div><span>Model edge</span><strong class="'+(market.edge>=.04?'ql-edge positive':'')+'">'+signedPct(market.edge,1)+'</strong></div><div><span>Model agreement</span><strong>'+esc(detail.agreement)+'</strong></div><div><span>Data quality</span><strong>'+quality.score+'%</strong></div></div>'
      +signatureAxis(game,detail)
      +'<div class="ql-game-layout"><main>'+comparisonSection(game)+contributionSection(game,detail,pickHome)+pitchLab(game)+'</main><aside>'+baseModelSection(detail,pickHome)+modelFlow(detail,pickHome)+modelLab(game,detail,pickHome)+'</aside></div>';
  }

  function signatureAxis(game,detail) {
    var rows=[['Elo',detail.parts.elo],['Poisson',detail.parts.poisson],['Feature',detail.parts.feature],['Ensemble',detail.publishedProbability]];
    return '<section class="ds-signature-axis"><div class="ds-axis-head"><div><span>'+esc(game.away)+'</span><strong>'+pct(game.awayP,1)+'</strong></div><b>MODEL PROBABILITY</b><div><span>'+esc(game.home)+'</span><strong>'+pct(game.homeP,1)+'</strong></div></div><div class="ds-axis-scale"><span>AWAY</span><i>50%</i><span>HOME</span></div>'+rows.map(function(row){var value=finite(row[1])?row[1]:.5;return '<div class="ds-axis-row"><span>'+esc(row[0])+'</span><div class="ds-axis-track"><i style="left:'+Math.max(0,Math.min(100,value*100))+'%"></i></div><strong>'+pct(value,1)+'</strong></div>';}).join('')+'</section>';
  }

  function comparisonSection(game) {
    var rows=gameComparison(game).map(function(row){if(row.group)return '<tr class="group"><td colspan="3">'+esc(row.group)+'</td></tr>';return '<tr><td><span class="ql-provenance" title="'+esc(row[3])+'">'+esc(row[0])+'</span></td><td class="numeric">'+esc(row[1])+'</td><td class="numeric">'+esc(row[2])+'</td></tr>';}).join('');
    return '<section class="ql-section"><div class="ql-section-head"><h2>Matchup comparison</h2><span>Hover labels for provenance</span></div><table class="ql-compare"><thead><tr><th>Metric</th><th>'+esc(game.away)+'</th><th>'+esc(game.home)+'</th></tr></thead><tbody>'+rows+'</tbody></table></section>';
  }

  var CONTRIBUTION_LABELS={power:'Power prior',elo:'Elo',hfa:'Home advantage',recform:'Recency form',rest:'Rest',xfip:'Starting pitching',whip:'Pitcher command',xwoba:'Expected contact',barrel:'Barrel rate',lineup:'Offensive matchup',park:'Park factor',form:'Last 10',h2h:'Head-to-head',pvt:'Pitcher vs opponent',wx:'Weather',split:'Home / road split',pythag:'Pythagorean performance'};
  function contributionRows(detail,pickHome) {
    return Object.keys(CONTRIBUTION_LABELS).map(function(key){var value=detail.feature.contrib&&Number(detail.feature.contrib[key]);if(!isFinite(value)||Math.abs(value)<.0001)return null;return {key:key,label:CONTRIBUTION_LABELS[key],value:pickHome?value:-value};}).filter(Boolean).sort(function(a,b){return Math.abs(b.value)-Math.abs(a.value);});
  }
  function contributionSection(game,detail,pickHome) {
    var rows=contributionRows(detail,pickHome),max=rows.reduce(function(m,r){return Math.max(m,Math.abs(r.value));},.01);
    var html=rows.length?rows.map(function(row){var width=Math.min(50,Math.abs(row.value)/max*46),left=row.value>=0?50:50-width;return '<div class="ql-contribution"><span class="ql-contribution-label">'+esc(row.label)+'</span><div class="ql-contribution-track"><i class="'+(row.value<0?'neg':'')+'" style="left:'+left+'%;width:'+width+'%"></i></div><span class="ql-contribution-value">'+(row.value>=0?'+':'')+row.value.toFixed(3)+'</span></div>';}).join(''):'<div class="ql-empty" style="min-height:120px"><span>Verified feature contributions are pending.</span></div>';
    var raw=finite(detail.rawProbability)?(pickHome?detail.rawProbability:1-detail.rawProbability):null,cal=finite(detail.calibratedProbability)?(pickHome?detail.calibratedProbability:1-detail.calibratedProbability):null;
    return '<section class="ql-section"><div class="ql-section-head"><h2>Why the model leans '+esc(pickHome?game.home:game.away)+'</h2><span>Selected-side contribution ladder</span></div><div class="ql-waterfall"><div class="ql-waterfall-start"><span>Neutral prior</span><strong class="ql-value">50.0%</strong></div>'+html+'<div class="ql-waterfall-stage"><span>Raw ensemble</span><strong>'+pct(raw,1)+'</strong></div><div class="ql-waterfall-stage calibration"><span>Calibration</span><strong>'+pct(cal,1)+'</strong></div><div class="ql-waterfall-total"><span>Final published probability</span><strong class="ql-value">'+pct(Math.max(game.homeP,game.awayP),1)+'</strong></div></div></section>';
  }

  function baseModelSection(detail,pickHome) {
    var rows=[['Elo model',detail.parts.elo,'15% shadow weight'],['Poisson run model',detail.parts.poisson,'33% shadow weight'],['Feature model',detail.parts.feature,'52% shadow weight'],['Ensemble raw',detail.rawProbability,'before rolling calibration'],['Calibrated shadow',detail.calibratedProbability,detail.calibrationFitted?'alpha '+detail.alpha.toFixed(2)+' · '+detail.calibrationN+' prior games':'unfitted · alpha 1.00'],['Published',detail.publishedProbability,'current production path']];
    return '<section class="ql-section"><div class="ql-section-head"><h2>Base-model disagreement</h2><span>'+esc(detail.agreement)+' · '+(detail.dispersion==null?'—':(detail.dispersion*100).toFixed(1)+' pp dispersion')+'</span></div><table class="ql-base-table"><tbody>'+rows.map(function(row){var p=finite(row[1])?(pickHome?row[1]:1-row[1]):null;return '<tr><td>'+esc(row[0])+'</td><td>'+pct(p,1)+'</td><td style="color:var(--text-tertiary);font-family:var(--sans)">'+esc(row[2])+'</td></tr>';}).join('')+'</tbody></table></section>';
  }

  function modelFlow(detail,pickHome) {
    var value=function(p){return finite(p)?pct(pickHome?p:1-p,1):'—';};
    return '<section class="ql-section"><div class="ql-section-head"><h2>Model flow</h2><span>Hover nodes for the current output</span></div><div class="ql-flow"><svg viewBox="0 0 620 220" role="img" aria-label="Model flow from source data through three base models, ensemble, calibration, and final probability"><path class="ql-flow-line active" d="M130 44 H235 M130 110 H235 M130 176 H235 M355 44 C405 44 380 110 425 110 M355 110 H425 M355 176 C405 176 380 110 425 110 M510 110 H555"/><g class="ql-flow-node"><title>Dynamic team ratings from verified results</title><rect x="18" y="21" width="112" height="46" rx="5"/><text x="31" y="41">TEAM DATA</text><text class="flow-value" x="31" y="57">'+value(detail.parts.elo)+'</text></g><g class="ql-flow-node"><title>Independent win probability from Elo</title><rect x="235" y="21" width="120" height="46" rx="5"/><text x="249" y="41">ELO</text><text class="flow-value" x="249" y="57">'+value(detail.parts.elo)+'</text></g><g class="ql-flow-node"><title>Run distribution and verified starter inputs</title><rect x="18" y="87" width="112" height="46" rx="5"/><text x="31" y="107">RUN DATA</text><text class="flow-value" x="31" y="123">'+value(detail.parts.poisson)+'</text></g><g class="ql-flow-node"><title>Poisson score distribution</title><rect x="235" y="87" width="120" height="46" rx="5"/><text x="249" y="107">POISSON</text><text class="flow-value" x="249" y="123">'+value(detail.parts.poisson)+'</text></g><g class="ql-flow-node"><title>Only available, gated features vote</title><rect x="18" y="153" width="112" height="46" rx="5"/><text x="31" y="173">FEATURE DATA</text><text class="flow-value" x="31" y="189">gated</text></g><g class="ql-flow-node"><title>Feature logistic model without the standalone Elo term</title><rect x="235" y="153" width="120" height="46" rx="5"/><text x="249" y="173">LOGISTIC</text><text class="flow-value" x="249" y="189">'+value(detail.parts.feature)+'</text></g><g class="ql-flow-node"><title>Normalized blend of available base models</title><rect x="425" y="87" width="85" height="46" rx="5"/><text x="438" y="107">ENSEMBLE</text><text class="flow-value" x="438" y="123">'+value(detail.rawProbability)+'</text></g><g class="ql-flow-node"><title>Rolling calibrator is fit on prior games only</title><rect x="555" y="87" width="60" height="46" rx="5"/><text x="563" y="107">CAL.</text><text class="flow-value" x="563" y="123">'+value(detail.calibratedProbability)+'</text></g></svg></div></section>';
  }

  function modelLab(game,detail,pickHome) {
    var rows=contributionRows(detail,pickHome);if(!Object.keys(state.modelToggles).length)rows.forEach(function(row){state.modelToggles[row.key]=true;});
    var logit=rows.reduce(function(sum,row){return sum+(state.modelToggles[row.key]!==false?row.value:0);},0),scenario=root.logitToProbability?root.logitToProbability(logit):.5;
    return '<section class="ql-section"><div class="ql-section-head"><h2>Model Lab</h2><span>Scenario only · never writes weights</span></div><div class="ql-lab"><div class="ql-lab-note">Temporarily remove contributions to inspect sensitivity. Production probabilities and saved weights are unchanged.</div><div class="ql-inspector-stat" style="padding:0 0 10px"><span>Scenario probability</span><strong id="ql-scenario-prob">'+pct(scenario,1)+'</strong></div><div class="ql-lab-controls">'+rows.map(function(row){return '<label class="ql-lab-toggle"><span>'+esc(row.label)+'</span><input type="checkbox" '+(state.modelToggles[row.key]!==false?'checked':'')+' onchange="QuantLabUI.toggleModelFeature(\''+esc(row.key)+'\',this.checked)"></label>';}).join('')+'</div></div></section>';
  }

  function pitchLab(game) {
    var cached=state.pitchCache[game.id];
    var body;if(cached&&cached.pitches&&cached.pitches.length){body='<div class="ql-strike-zone">'+strikeZoneSvg(cached.pitches)+'<div><div class="ql-lab-note">Measured plate coordinates from the MLB live feed. The 3D path uses the measured endpoint with a schematic interpolation; it does not invent pitch movement.</div><div class="ql-pitch-list">'+cached.pitches.map(function(p){return esc(p.n+'. '+(p.desc||p.type||'Pitch'));}).join('<br>')+'</div></div></div>';}else{body='<div class="ql-empty" style="min-height:150px"><strong>'+(game.status==='pre'?'Available after first pitch':'No measured pitches loaded')+'</strong><span>Pitch Lab renders only MLB-tracked plate coordinates. It does not generate a placeholder arsenal.</span>'+(game.status==='pre'?'':'<button class="ql-secondary" style="margin-top:12px" onclick="QuantLabUI.loadPitches()">Load current at-bat</button>')+'</div>';}
    return '<section class="ql-section"><div class="ql-section-head"><h2>Pitch Lab</h2><span>Measured coordinates only</span></div><div class="ql-lab" id="ql-pitch-lab">'+body+'</div></section>';
  }
  function strikeZoneSvg(pitches){var dots=(pitches||[]).filter(function(p){return p.px!=null&&p.pz!=null;}).map(function(p){var x=120+Number(p.px)/.83*58,y=32+(3.5-Number(p.pz))/2*120;return '<circle cx="'+Math.max(12,Math.min(228,x)).toFixed(1)+'" cy="'+Math.max(12,Math.min(190,y)).toFixed(1)+'" r="6" fill="'+esc(p.col||'#75a7dc')+'" stroke="#eef2f4" stroke-width="1"/><text x="'+Math.max(12,Math.min(228,x)).toFixed(1)+'" y="'+(Math.max(12,Math.min(190,y))+3).toFixed(1)+'" text-anchor="middle" fill="#fff" font-size="7" font-family="var(--mono)">'+esc(p.n)+'</text>';}).join('');return '<svg viewBox="0 0 240 215" role="img" aria-label="Catcher view of measured pitch locations"><rect x="62" y="32" width="116" height="120" fill="none" stroke="#75a7dc" stroke-width="1.5"/><path d="M90 185 H150 L150 194 L120 207 L90 194 Z" fill="none" stroke="#8997a2"/><path d="M100.7 32 V152 M139.3 32 V152 M62 72 H178 M62 112 H178" stroke="#33414c" stroke-width=".8"/>'+dots+'</svg>';}

  function performanceRows() {
    var snapshots=gradedSnapshots();
    function metrics(key){var pairs=snapshots.filter(function(s){return finite(s[key]);}).map(function(s){return {p:s[key],y:s.result.actualHome?1:0};});return root.metricsForPairs?root.metricsForPairs(pairs):{n:0};}
    return {snapshots:snapshots,metrics:metrics('publishedProb'),versions:{published:metrics('publishedProb'),raw:metrics('rawProb'),calibrated:metrics('calibratedProb')}};
  }
  function betRows(){var log=safeCall('betlogLoad')||{};return Object.keys(log).map(function(key){return Object.assign({key:key},log[key]);}).filter(function(row){return row&&row.result;}).sort(function(a,b){return (a.ts||0)-(b.ts||0);});}
  function bettingSummary(){var rows=betRows(),flat=0,kelly=0,peak=0,cum=0,maxDD=0,edgeSum=0;rows.forEach(function(row){var dec=safeCall('mlToDecimal',[row.ml])||1;flat+=row.won?100*(dec-1):-100;kelly+=row.won?(row.kStake||0)*(dec-1):-(row.kStake||0);cum=kelly;peak=Math.max(peak,cum);maxDD=Math.max(maxDD,peak-cum);edgeSum+=Number(row.edge)||0;});return {rows:rows,flat:flat,kelly:kelly,flatRoi:rows.length?flat/(rows.length*100):null,maxDD:rows.length?maxDD:null,avgEdge:rows.length?edgeSum/rows.length:null};}

  function renderMarket(){
    var host=document.getElementById('ql-market-root');if(!host)return;
    var list=games(),rows=list.map(function(game){return {game:game,market:marketForPick(game)};}).filter(function(row){return row.market.probability!=null;});
    var qualified=rows.filter(function(row){return row.market.edge>=.04;});
    var providers=[];rows.forEach(function(row){if(row.market.provider&&providers.indexOf(row.market.provider)<0)providers.push(row.market.provider);});
    var checked=root.ESPN_LAST?localDate(root.ESPN_LAST,{hour:'numeric',minute:'2-digit',second:'2-digit'}):'Pending';
    var tableRows=rows.length?rows.map(function(row){var game=row.game,side=row.market.side||'—',line=root.LINES&&root.LINES[game.id]||{};return '<tr><td>'+esc(game.away)+' @ '+esc(game.home)+'</td><td>'+esc(side)+'</td><td>'+pct(side===game.home?game.homeP:game.awayP,1)+'</td><td>'+ml(row.market.odds)+'</td><td>'+pct(row.market.probability,1)+'</td><td class="'+(row.market.edge>=.04?'ql-edge positive':row.market.edge<0?'ql-edge negative':'')+'">'+signedPct(row.market.edge,1)+'</td><td>'+(line.oHML!=null||line.oAML!=null?'Captured':'—')+'</td><td>—</td></tr>';}).join(''):'<tr><td colspan="8"><div class="ds-market-empty"><div><strong>Market data unavailable</strong><span>No moneyline markets were returned by the provider. Predictions remain active.</span><div class="ds-market-empty-actions"><button class="ql-secondary" onclick="QuantLabUI.retryMarket()">Retry data</button><button class="ql-tertiary" onclick="QuantLabUI.openData()">View diagnostics</button></div></div><div class="ds-market-diagnostics"><div><small>Source</small><b>ESPN</b></div><div><small>Last attempt</small><b>'+esc(checked)+'</b></div><div><small>Games returned</small><b>'+list.length+'</b></div><div><small>Valid markets</small><b>0</b></div></div></div></td></tr>';
    host.innerHTML='<div class="ql-page-head"><div><div class="ql-eyebrow">Verified prices and paper-trading records</div><h1>Market</h1><p>Model comparisons appear only when the source returns a valid moneyline. Missing quotes remain unavailable.</p></div><div class="ql-actions"><button class="ql-secondary" onclick="DiamondSignalUI.toggleSettings(true)">Market settings</button><button class="ql-secondary" onclick="QuantLabUI.exportTradingLog(\'csv\')">Download log</button></div></div>'
      +'<div class="ds-market-status"><div><span>Market status</span><strong class="ds-market-state '+(rows.length?'':'off')+'">'+(rows.length?'LIVE':'UNAVAILABLE')+'</strong></div><div><span>Coverage</span><strong>'+rows.length+'/'+list.length+'</strong></div><div><span>Source</span><strong>'+esc(providers.join(', ')||'ESPN')+'</strong></div><div><span>Last refresh</span><strong>'+esc(checked)+'</strong></div></div>'
      +'<section class="ql-section"><div class="ql-section-head"><h2>Moneyline comparison</h2><span>'+qualified.length+' market'+(qualified.length===1?'':'s')+' above the 4.0% threshold</span></div><div class="ds-market-table-wrap"><table class="ds-market-table"><thead><tr><th>Game</th><th>Model side</th><th>Model</th><th>Current</th><th>Implied</th><th>Edge</th><th>Open</th><th>CLV</th></tr></thead><tbody>'+tableRows+'</tbody></table></div></section>'
      +'<div class="ql-performance-grid"><section class="ql-section"><div class="ql-section-head"><h2>Qualified plays</h2><span>Paper trading only</span></div>'+(qualified.length?'<div class="ds-market-table-wrap"><table class="ds-market-table"><thead><tr><th>Game</th><th>Market</th><th>Model probability</th><th>Odds</th><th>Edge</th><th>Recommended stake</th><th>Status</th></tr></thead><tbody>'+qualified.map(function(row){var p=row.market.side===row.game.home?row.game.homeP:row.game.awayP,dec=safeCall('mlToDecimal',[row.market.odds])||1,stake=safeCall('kellyStake',[p,dec,safeCall('getBankroll')||1000,safeCall('getKellyFrac')||.25])||0;return '<tr><td>'+esc(row.game.away)+' @ '+esc(row.game.home)+'</td><td>'+esc(row.market.side)+' ML</td><td>'+pct(p,1)+'</td><td>'+ml(row.market.odds)+'</td><td class="ql-edge positive">'+signedPct(row.market.edge,1)+'</td><td>$'+num(stake,0)+'</td><td>'+esc(gameStatus(row.game))+'</td></tr>';}).join('')+'</tbody></table></div>':'<div class="ql-empty"><strong>No qualifying markets</strong><span>No available moneyline currently clears the 4.0% minimum edge threshold.</span></div>')+'</section><div>'+recentBetLog(betRows())+'</div></div>';
  }

  function exportTradingLog(format){
    var rows=betRows(),stamp=new Date().toISOString().slice(0,10),content,type,name;
    if(format==='json'){content=JSON.stringify({exportedAt:new Date().toISOString(),records:rows},null,2);type='application/json';name='diamond-signal-paper-log-'+stamp+'.json';}
    else{var cols=['timestamp','game','pick','moneyline','model_probability','edge','kelly_stake','result','won'];content=[cols.join(',')].concat(rows.map(function(row){return [new Date(row.ts||0).toISOString(),row.game||row.key||'',row.pick||row.team||'',row.ml==null?'':row.ml,row.prob==null?'':row.prob,row.edge==null?'':row.edge,row.kStake==null?'':row.kStake,row.result||'',row.won===true?'true':row.won===false?'false':''].map(function(value){return '"'+String(value).replace(/"/g,'""')+'"';}).join(',');})).join('\n');type='text/csv';name='diamond-signal-paper-log-'+stamp+'.csv';}
    if(typeof root.downloadBlob==='function')root.downloadBlob(content,name,type);
  }

  function renderPerformance(){var host=document.getElementById('ql-performance-root');if(!host)return;var perf=performanceRows(),bets=bettingSummary(),m=perf.metrics,record=m.n?Math.round(m.accuracy*m.n)+'–'+(m.n-Math.round(m.accuracy*m.n)):'—';
    host.innerHTML='<div class="ql-page-head"><div><div class="ql-eyebrow">Prospective evaluation</div><h1>Performance</h1><p>Forward snapshots are evaluated separately from legacy history and reconstructed backtests.</p></div><div class="ql-inline-meta"><span>Snapshot schema <strong>v1</strong></span><span>Timezone <strong>'+esc(Intl.DateTimeFormat().resolvedOptions().timeZone||'local')+'</strong></span></div></div>'
      +'<div class="ql-kpis">'+kpi('Accuracy',m.n?pct(m.accuracy,1):'—',record+' prospective')+kpi('Brier',m.n?num(m.brier,4):'—','lower is better')+kpi('Log loss',m.n?num(m.logLoss,4):'—','coin flip 0.6931')+kpi('ECE',m.n?num(m.ece,3):'—','calibration error')+kpi('Games',String(m.n),'frozen snapshots')+'</div>'
      +'<div class="ql-toast-note warning"><strong>Legacy audit reference:</strong> the supplied 199-game review reported 57.8% accuracy, 0.2505 Brier, and 0.6959 log loss. It is retained as a labeled benchmark, not mixed with the forward snapshot record.</div>'
      +performanceChart(perf.snapshots)
      +'<div class="ql-performance-grid"><div>'+calibrationTable(perf.snapshots)+bankrollChart(bets.rows)+'</div><div>'+modelVersionTable(perf)+recentBetLog(bets.rows)+'</div></div>';
  }
  function money(value){return (value>=0?'+':'−')+'$'+Math.abs(value).toFixed(0);}
  function kpi(label,value,sub,semantic){var cls=finite(semantic)?(semantic>0?'pos':semantic<0?'neg':''):'';return '<div class="ql-kpi"><span>'+esc(label)+'</span><strong class="'+cls+'">'+esc(value)+'</strong><small>'+esc(sub||'')+'</small></div>';}
  function performanceChart(snapshots){
    var metric=state.performanceMetric,rolling=state.performanceRolling;
    var controls='<div class="ds-chart-controls"><label>Metric <select onchange="QuantLabUI.setPerformanceMetric(this.value)"><option value="accuracy" '+(metric==='accuracy'?'selected':'')+'>Accuracy</option><option value="brier" '+(metric==='brier'?'selected':'')+'>Brier</option><option value="logloss" '+(metric==='logloss'?'selected':'')+'>Log loss</option><option value="confidence" '+(metric==='confidence'?'selected':'')+'>Confidence</option></select></label><label>Rolling <select onchange="QuantLabUI.setPerformanceRolling(this.value)"><option value="20" '+(rolling===20?'selected':'')+'>20</option><option value="50" '+(rolling===50?'selected':'')+'>50</option><option value="100" '+(rolling===100?'selected':'')+'>100</option></select></label></div>';
    if(!snapshots.length)return '<section class="ql-section"><div class="ql-section-head"><h2>Performance over time</h2>'+controls+'</div><div class="ql-empty"><strong>No prospective curve yet</strong><span>The chart begins when frozen pregame predictions receive verified finals. Legacy rows are not substituted.</span></div></section>';
    var values=snapshots.map(function(snapshot,index){var from=Math.max(0,index-rolling+1),windowRows=snapshots.slice(from,index+1),sum=0;windowRows.forEach(function(row){var p=row.publishedProb,y=row.result.actualHome?1:0;if(metric==='accuracy')sum+=((p>=.5)===!!y?1:0);else if(metric==='brier')sum+=Math.pow(p-y,2);else if(metric==='logloss')sum+=-(y*Math.log(Math.max(.001,p))+(1-y)*Math.log(Math.max(.001,1-p)));else sum+=Math.max(p,1-p);});return sum/windowRows.length;});
    var min=Math.min.apply(null,values),max=Math.max.apply(null,values);if(metric==='accuracy'||metric==='confidence'){min=Math.min(.45,min);max=Math.max(.75,max);}else if(max-min<.05){min=Math.max(0,min-.025);max+=.025;}var range=max-min||1,x=function(i){return 50+(values.length===1?0:i/(values.length-1)*700);},y=function(v){return 28+(max-v)/range*190;};var points=values.map(function(v,i){return x(i).toFixed(1)+','+y(v).toFixed(1);}).join(' '),label=metric==='accuracy'?'Rolling accuracy':metric==='brier'?'Rolling Brier':metric==='logloss'?'Rolling log loss':'Average confidence';
    return '<section class="ql-section"><div class="ql-section-head"><h2>Performance over time</h2>'+controls+'</div><div class="ql-chart"><svg viewBox="0 0 800 260" role="img" aria-label="'+esc(label)+'"><path class="ql-chart-grid" d="M50 28V218H750 M50 91H750 M50 154H750 M50 218H750"/><polyline class="ql-chart-line" points="'+points+'"/><circle class="ql-chart-end" cx="'+x(values.length-1).toFixed(1)+'" cy="'+y(values[values.length-1]).toFixed(1)+'" r="4"/><text class="ql-chart-final" x="742" y="'+Math.max(14,y(values[values.length-1])-9).toFixed(1)+'" text-anchor="end">'+(metric==='accuracy'||metric==='confidence'?pct(values[values.length-1],1):num(values[values.length-1],4))+'</text><text class="ql-chart-axis" x="6" y="34">'+(metric==='accuracy'||metric==='confidence'?pct(max,0):num(max,3))+'</text><text class="ql-chart-axis" x="6" y="220">'+(metric==='accuracy'||metric==='confidence'?pct(min,0):num(min,3))+'</text><text class="ql-chart-axis" x="50" y="245">1</text><text class="ql-chart-axis" x="730" y="245">'+values.length+'</text><text class="ql-chart-axis" x="375" y="255">Frozen games</text></svg></div></section>';
  }
  function bankrollChart(rows){
    if(!rows.length)return '<section class="ql-section"><div class="ql-section-head"><h2>Bankroll curve</h2><span>¼-Kelly paper trading</span></div><div class="ql-empty"><strong>No graded paper trades</strong><span>The curve begins after a qualified market is logged and graded against a verified final.</span></div></section>';
    var values=[0],cum=0,peak=0,peakIndex=0,maxDD=0,ddPeak=0,ddTrough=0;
    rows.forEach(function(row,index){
      var dec=safeCall('mlToDecimal',[row.ml])||1;
      cum+=row.won?(row.kStake||0)*(dec-1):-(row.kStake||0);
      values.push(cum);
      if(cum>peak){peak=cum;peakIndex=index+1;}
      if(peak-cum>maxDD){maxDD=peak-cum;ddPeak=peakIndex;ddTrough=index+1;}
    });
    var min=Math.min(0,Math.min.apply(null,values)),max=Math.max(0,Math.max.apply(null,values)),range=max-min||1;
    function x(index){return 45+index/(values.length-1)*520;}
    function y(value){return 25+(max-value)/range*150;}
    var pts=values.map(function(v,i){return x(i).toFixed(1)+','+y(v).toFixed(1);}).join(' '),finalValue=values[values.length-1],finalY=y(finalValue);
    var annotation=maxDD>0?'<line class="ql-chart-dd" x1="'+x(ddTrough).toFixed(1)+'" y1="'+y(values[ddPeak]).toFixed(1)+'" x2="'+x(ddTrough).toFixed(1)+'" y2="'+y(values[ddTrough]).toFixed(1)+'"/><text class="ql-chart-note" x="'+Math.min(485,x(ddTrough)+6).toFixed(1)+'" y="'+Math.max(18,(y(values[ddPeak])+y(values[ddTrough]))/2).toFixed(1)+'">Max DD −$'+maxDD.toFixed(0)+'</text>':'';
    return '<section class="ql-section"><div class="ql-section-head"><h2>Bankroll curve</h2><span>¼-Kelly paper trading</span></div><div class="ql-chart"><svg viewBox="0 0 600 215" role="img" aria-label="Quarter-Kelly cumulative profit and loss with breakeven and max drawdown"><path class="ql-chart-grid" d="M45 25V175H565 M45 75H565 M45 125H565"/><line class="ql-chart-baseline" x1="45" y1="'+y(0).toFixed(1)+'" x2="565" y2="'+y(0).toFixed(1)+'"/><text class="ql-chart-note" x="49" y="'+Math.max(12,y(0)-5).toFixed(1)+'">Breakeven</text><polyline class="ql-chart-line" points="'+pts+'"/>'+annotation+'<circle class="ql-chart-end" cx="565" cy="'+finalY.toFixed(1)+'" r="3"/><text class="ql-chart-final" x="558" y="'+Math.max(13,Math.min(190,finalY-7)).toFixed(1)+'" text-anchor="end">Final '+money(finalValue)+'</text><text class="ql-chart-axis" x="8" y="30">'+money(max)+'</text><text class="ql-chart-axis" x="8" y="178">'+money(min)+'</text><text class="ql-chart-axis" x="45" y="204">0</text><text class="ql-chart-axis" x="548" y="204">'+rows.length+'</text><text class="ql-chart-axis" x="285" y="213">Graded bets</text><text class="ql-chart-axis" transform="translate(9 119) rotate(-90)">Cumulative P/L</text></svg></div></section>';
  }
  function calibrationTable(snapshots){var bands=[[.5,.55],[.55,.6],[.6,.65],[.65,.7],[.7,.75],[.75,1.001]],rows=bands.map(function(b){var set=snapshots.filter(function(s){var c=Math.max(s.publishedProb,1-s.publishedProb);return c>=b[0]&&c<b[1];});var wins=set.filter(function(s){return (s.publishedProb>=.5)===!!s.result.actualHome;}).length,avg=set.length?set.reduce(function(sum,s){return sum+Math.max(s.publishedProb,1-s.publishedProb);},0)/set.length:null,actual=set.length?wins/set.length:null,ci=set.length&&root.wilsonCI?root.wilsonCI(wins,set.length):null;return {label:Math.round(b[0]*100)+'–'+(b[1]>1?'100':Math.round(b[1]*100))+'%',n:set.length,avg:avg,actual:actual,ci:ci};});var valid=rows.filter(function(r){return r.n&&finite(r.actual)&&finite(r.avg);}),points=valid.map(function(r){return (24+(r.avg-.5)/.5*196).toFixed(1)+','+(220-(r.actual-.5)/.5*196).toFixed(1);}).join(' '),dots=valid.map(function(r){var x=24+(r.avg-.5)/.5*196,y=220-(r.actual-.5)/.5*196;return '<circle class="ds-reliability-point" cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="4"><title>'+esc(r.label)+' · observed '+pct(r.actual,1)+'</title></circle>';}).join('');return '<section class="ql-section"><div class="ql-section-head"><h2>Calibration by confidence</h2><span>Wilson 95% interval</span></div><div class="ds-reliability"><svg viewBox="0 0 244 244" role="img" aria-label="Reliability plot"><path class="ql-chart-grid" d="M24 24V220H220 M24 171H220 M24 122H220 M24 73H220 M73 24V220 M122 24V220 M171 24V220"/><line class="ds-reliability-line" x1="24" y1="220" x2="220" y2="24"/>'+(points?'<polyline class="ds-reliability-observed" points="'+points+'"/>':'')+dots+'<text class="ql-chart-axis" x="20" y="238">50%</text><text class="ql-chart-axis" x="202" y="238">100%</text><text class="ql-chart-axis" x="4" y="224">50%</text><text class="ql-chart-axis" x="1" y="30">100%</text></svg><table class="ql-health-table"><thead><tr><th>Confidence</th><th>Predicted</th><th>Observed</th><th>95% interval</th><th>N</th></tr></thead><tbody>'+rows.map(function(r){return '<tr><td>'+r.label+'</td><td>'+pct(r.avg,1)+'</td><td>'+pct(r.actual,1)+'</td><td>'+(r.ci?pct(r.ci[0],0)+'–'+pct(r.ci[1],0):'—')+'</td><td>'+r.n+'</td></tr>';}).join('')+'</tbody></table></div></section>';}
  function modelVersionTable(perf){
    var versions=perf.versions||{},published=versions.published||perf.metrics||{n:0},raw=versions.raw||{n:0},calibrated=versions.calibrated||{n:0};
    function row(label,m){return '<tr><td>'+esc(label)+'</td><td>'+m.n+'</td><td>'+pct(m.accuracy,1)+'</td><td>'+num(m.brier,4)+'</td><td>'+num(m.logLoss,4)+'</td><td>'+num(m.auc,3)+'</td><td>'+num(m.ece,3)+'</td></tr>';}
    function pending(label,note){return '<tr><td>'+esc(label)+'</td><td colspan="6" style="color:var(--text-tertiary)">'+esc(note)+'</td></tr>';}
    return '<section class="ql-section"><div class="ql-section-head"><h2>Model versions</h2><span>Forward comparison</span></div><table class="ql-health-table"><thead><tr><th>Model</th><th>N</th><th>ACC</th><th>Brier</th><th>Log loss</th><th>AUC</th><th>ECE</th></tr></thead><tbody>'+row('Published',published)+row('Raw ensemble shadow',raw)+row('Calibrated shadow',calibrated)+pending('Frozen comparator','Begins with the next explicitly frozen weight release')+pending('Online learner','Requires a separately versioned pregame output')+pending('Walk-forward batch','Requires an adequate chronological snapshot sample')+'</tbody></table></section>';
  }
  function recentBetLog(rows){return '<section class="ql-section"><div class="ql-section-head"><h2>Recent paper-trading log</h2><span>Verified results</span></div>'+(rows.length?'<div class="ql-snapshot-list">'+rows.slice(-8).reverse().map(function(row){return '<div class="ql-snapshot-row"><span>'+esc(row.pick||row.team||'Market')+' <small>'+ml(row.ml)+'</small></span><strong class="'+(row.won?'ql-edge positive':'ql-edge negative')+'">'+(row.won?'WIN':'LOSS')+'</strong><span>'+money(row.won?(row.kStake||0)*((safeCall('mlToDecimal',[row.ml])||1)-1):-(row.kStake||0))+'</span></div>';}).join('')+'</div>':'<div class="ql-empty" style="min-height:150px"><span>No graded paper trades.</span></div>')+'</section>';}

  function renderModelPage(){var host=document.getElementById('ql-model-root');if(!host)return;var perf=performanceRows(),m=perf.metrics,game=selectedGame(),detail=game?modelDetail(game):null;
    host.innerHTML='<div class="ql-page-head"><div><div class="ql-eyebrow">MODEL VERSION 2.0.0 · FORWARD TESTING</div><h1>Model research</h1><p>Chronological validation, model disagreement, calibration, and feature evidence.</p></div><div class="ql-inline-meta"><span>Production <strong>feature + Poisson</strong></span><span>Shadow <strong>three-model calibrated</strong></span></div></div>'
      +'<div class="ds-research-lead"><div><span>Model version</span><strong>v2.0.0-shadow</strong></div><div><span>Status</span><strong>FORWARD TESTING</strong></div><div><span>Prospective sample</span><strong>'+m.n+' GAMES</strong></div></div>'
      +'<section class="ql-section"><div class="ql-section-head"><h2>Model pipeline</h2><span>Current production path</span></div><div class="ds-pipeline-strip"><div class="ds-pipeline-node"><span>01</span><strong>Data</strong></div><div class="ds-pipeline-node"><span>02</span><strong>Features</strong></div><div class="ds-pipeline-node"><span>03</span><strong>Base models</strong></div><div class="ds-pipeline-node"><span>04</span><strong>Ensemble</strong></div><div class="ds-pipeline-node"><span>05</span><strong>Calibration</strong></div><div class="ds-pipeline-node"><span>06</span><strong>Prediction</strong></div></div></section>'
      +'<div class="ql-performance-grid"><div>'+(detail?modelFlow(detail,detail.publishedProbability>=.5):'<section class="ql-section"><div class="ql-empty">Select a game to inspect model flow.</div></section>')+'<section class="ql-section"><div class="ql-section-head"><h2>Walk-forward validation</h2><span>Primary framework</span></div><div class="ql-lab"><p class="ql-lab-note">Rolling-origin splits fit normalization, model weights, and calibration on earlier games only. A forward result appears after enough immutable snapshots exist; legacy backtests are not silently reused.</p><table class="ql-health-table"><thead><tr><th>Stage</th><th>Training window</th><th>Evaluation window</th><th>Status</th></tr></thead><tbody><tr><td>Normalization</td><td>Prior fold</td><td>Unseen fold</td><td>Implemented</td></tr><tr><td>Logistic weights</td><td>Prior fold</td><td>Unseen fold</td><td>Implemented</td></tr><tr><td>Calibration alpha</td><td>Prior games</td><td>Next prediction</td><td>Implemented</td></tr><tr><td>Promotion decision</td><td>Prospective sample</td><td>Future games</td><td>Pending evidence</td></tr></tbody></table></div></section></div><div>'+modelVersionTable(perf)+'<section class="ql-section"><div class="ql-section-head"><h2>Feature ablation</h2><span>Walk-forward only</span></div><table class="ql-health-table"><thead><tr><th>Feature</th><th>N</th><th>Δ log loss</th><th>Δ Brier</th><th>Δ accuracy</th></tr></thead><tbody><tr><td colspan="5" style="text-align:center;color:var(--text-tertiary)">Awaiting an adequate prospective feature-snapshot sample. No feature is removed on a tiny sample.</td></tr></tbody></table></section></div></div>';
  }

  function sourceStatus(){
    var list=games(),starter=0,weather=0,markets=0,live=list.some(function(g){return g.status==='live';});
    list.forEach(function(g){var sp=root.SP&&root.SP[g.id],o=root.ODDS&&root.ODDS[g.id];if(sp&&sp.h&&sp.a&&sp.h.name&&sp.a.name)starter++;if(sp&&sp.wxReal)weather++;if(o&&o.real)markets++;});
    var updated=root.ESPN_LAST?localDate(root.ESPN_LAST,{hour:'numeric',minute:'2-digit',second:'2-digit'}):'Pending';
    return [
      {name:'Schedule',value:root.ESPN_OK?'LIVE':'OFFLINE',status:root.ESPN_OK?'ok':'off',coverage:list.length+'/'+list.length,source:'ESPN scoreboard',updated:updated,detail:'Official game identity, start time, score, inning, and game status. The slate remains usable from the last verified response if a refresh fails.'},
      {name:'Starters',value:starter===list.length&&list.length?'LIVE':'PARTIAL',status:starter===list.length&&list.length?'ok':'pending',coverage:starter+'/'+list.length,source:'ESPN / MLB Stats API',updated:updated,detail:'Probable starter names are measured. Advanced pitcher inputs stay neutral unless a verified statistics response is available.'},
      {name:'Standings',value:root.STANDINGS_OK?'LIVE':'STALE',status:root.STANDINGS_OK?'ok':'pending',coverage:root.STANDINGS_OK?'30/30':'—',source:'ESPN / MLB Stats API',updated:updated,detail:'Season records and run differential support team-strength context. Stale data is labeled and is never presented as current.'},
      {name:'Injuries',value:root.INJURIES&&Object.keys(root.INJURIES).length?'LIVE':'UNAVAILABLE',status:root.INJURIES&&Object.keys(root.INJURIES).length?'ok':'pending',coverage:root.INJURIES&&Object.keys(root.INJURIES).length?Object.keys(root.INJURIES).length+' reports':'—',source:'ESPN',updated:updated,detail:'Only provider-returned injury reports are shown. Missing injury coverage does not create synthetic absences.'},
      {name:'Weather',value:weather===list.length&&list.length?'LIVE':weather?'PARTIAL':'UNAVAILABLE',status:weather===list.length&&list.length?'ok':'pending',coverage:weather+'/'+list.length,source:'ESPN game conditions',updated:updated,detail:'Verified venue conditions are displayed when returned. Team-specific weather performance is intentionally excluded.'},
      {name:'Market odds',value:markets?'LIVE':'UNAVAILABLE',status:markets?'ok':'pending',coverage:markets+'/'+list.length,source:'ESPN odds provider',updated:updated,detail:'Only valid provider moneylines enter implied-probability and edge calculations. No line means no market recommendation.'},
      {name:'Pitch tracking',value:live?'LIVE':'UNAVAILABLE',status:live?'ok':'pending',coverage:'Live games only',source:'MLB live feed',updated:live?updated:'—',detail:'Pitch Lab uses measured plate coordinates. The rendered flight path is a labeled schematic interpolation.'}
    ];
  }
  function renderData(){var host=document.getElementById('ql-data-root');if(!host)return;var sources=sourceStatus(),selected=sources[Math.max(0,Math.min(sources.length-1,state.selectedSource))],store=getSnapshotStore(),snaps=Object.keys(store.snapshots||{}).map(function(k){return store.snapshots[k];}).sort(function(a,b){return b.firstPitch-a.firstPitch;}),legacy=(safeCall('realHistory')||[]).length+Object.keys(safeCall('btLoad')||{}).filter(function(k){return k.indexOf('__')!==0;}).length;
    host.innerHTML='<div class="ql-page-head"><div><div class="ql-eyebrow">SYSTEM OBSERVABILITY</div><h1>Data health</h1><p>Coverage, freshness, and provenance for every source used by the current slate.</p></div><div class="ql-actions"><button class="ql-secondary" onclick="QuantLabUI.exportSnapshots()">Download snapshots</button><button class="ql-secondary" onclick="QuantLabUI.exportTradingLog(\'json\')">Download paper log</button></div></div>'
      +'<div class="ql-data-grid"><div><section class="ql-section"><div class="ql-section-head"><h2>Source coverage</h2><span>Select a row for detail</span></div><table class="ql-health-table"><thead><tr><th>Source</th><th>Status</th><th>Coverage</th><th>Updated</th></tr></thead><tbody>'+sources.map(function(s,index){return '<tr tabindex="0" style="cursor:pointer" onclick="QuantLabUI.selectSource('+index+')" onkeydown="if(event.key===\'Enter\')QuantLabUI.selectSource('+index+')"><td>'+esc(s.name)+'</td><td><span class="ql-health-status '+s.status+'"><i></i>'+esc(s.value)+'</span></td><td>'+esc(s.coverage)+'</td><td>'+esc(s.updated)+'</td></tr>';}).join('')+'</tbody></table></section><section class="ql-section"><div class="ql-section-head"><h2>Source provenance</h2><span>Major analytical inputs</span></div><div class="ql-source-list">'+provenanceRows()+'</div></section></div><div><div class="ds-source-detail"><span class="ql-eyebrow">SELECTED SOURCE</span><h3>'+esc(selected.name)+'</h3><p>'+esc(selected.detail)+'</p><dl><dt>Status</dt><dd>'+esc(selected.value)+'</dd><dt>Coverage</dt><dd>'+esc(selected.coverage)+'</dd><dt>Updated</dt><dd>'+esc(selected.updated)+'</dd><dt>Provider</dt><dd>'+esc(selected.source)+'</dd></dl></div><section class="ql-section"><div class="ql-section-head"><h2>Prediction snapshots</h2><span>'+snaps.length+' frozen · '+legacy+' legacy rows</span></div>'+(snaps.length?'<div class="ql-snapshot-list">'+snaps.slice(0,12).map(function(s){return '<div class="ql-snapshot-row"><span>'+esc(s.away)+' @ '+esc(s.home)+'<small class="ql-subline">'+esc(localDate(s.firstPitch,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))+'</small></span><strong>'+pct(s.publishedProb,1)+'</strong><span>'+esc(s.result?'GRADED':'FROZEN')+'</span></div>';}).join('')+'</div>':'<div class="ql-empty"><strong>No frozen snapshots yet</strong><span>Predictions freeze within 30 minutes of first pitch and remain immutable.</span></div>')+'</section></div></div>';
  }
  function provenanceRows(){var rows=[['Schedule / scores','ESPN','Measured','https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'],['Standings / records','ESPN + MLB','Measured','https://statsapi.mlb.com/api/v1/standings'],['Probable starters','ESPN + MLB','Measured','https://statsapi.mlb.com/api/v1/schedule'],['Pitch locations','MLB live feed','Measured','https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live'],['Elo / Poisson / model output','Local model','Derived',''],['Park identity and listed dimensions','Official MLB/team pages','Measured + interpolated','https://www.mlb.com/ballparks'],['3D architecture and people','Diamond Signal renderer','Stylized','']];return rows.map(function(r){return '<div class="ql-source-row"><b>'+esc(r[0])+'</b><span>'+esc(r[2])+'</span>'+(r[3]?'<a href="'+esc(r[3])+'" target="_blank" rel="noopener">'+esc(r[1])+'</a>':'<span>'+esc(r[1])+'</span>')+'</div>';}).join('');}

  function renderBallpark(){var host=document.getElementById('ql-ballpark-root');if(!host)return;var game=selectedGame();if(!game){host.innerHTML='<div class="ql-empty"><strong>No game selected</strong><span>Choose a matchup from the slate before entering Ballpark Live.</span></div>';return;}var config=root.stadiumForTeam?root.stadiumForTeam(game.home,root.PARK&&root.PARK[game.home]):null;if(!config)return;var wp=game.status==='live'&&root.liveWinProb?safeCall('liveWinProb',[game]):game.homeP,lv=game.live||{},events=ballparkEvents(game),sp=root.SP&&root.SP[game.id],awayStarter=sp&&sp.a&&sp.a.name||'Away starter pending',homeStarter=sp&&sp.h&&sp.h.name||'Home starter pending',awayScore=lv.away!=null?lv.away:(game.finalScore?game.finalScore.a:null),homeScore=lv.home!=null?lv.home:(game.finalScore?game.finalScore.h:null),storyLabel=game.status==='live'?'LIVE MATCHUP':game.status==='final'?'FINAL':'PROBABLE STARTERS',storyMessage=game.status==='pre'?'Live pitch context will appear after first pitch.':game.status==='live'?'Verified game state is active. Load the current at-bat for measured pitch locations.':'Final score verified. Pitch playback is available only during live tracking.';
    host.innerHTML='<div class="ql-ballpark-shell" style="--bp-accent:'+esc(config.accent||'#9bbbd8')+'"><div class="ql-ballpark-bar"><button class="ql-ballpark-back" onclick="QuantLabUI.openGame()">← Game analysis</button><div class="ql-ballpark-title"><strong>'+esc(config.name)+'</strong><span>'+esc(config.city)+' · '+esc(game.away)+' at '+esc(game.home)+'</span></div><select class="ql-camera-select" aria-label="Ballpark camera" onchange="QuantLabUI.setCameraSelect(this.value)"><option value="broadcast">Broadcast</option><option value="catcher">Catcher</option><option value="pitcher">Pitcher</option><option value="overhead">Overhead</option><option value="outfield">Center field</option><option value="free">Free camera</option></select><div class="ql-overlay-group"><button class="active" data-overlay="dimensions" onclick="QuantLabUI.toggleOverlay(\'dimensions\',this)">Dimensions</button><button data-overlay="defense" onclick="QuantLabUI.toggleOverlay(\'defense\',this)">Defense</button></div></div><div class="ql-ballpark-main"><div class="ql-ballpark-stage"><div id="ql-ballpark-host" class="ql-ballpark-host"></div><div class="ql-broadcast"><div class="ql-scorebug"><div class="ql-scorebug-team"><span>'+esc(game.away)+'</span><strong id="ql-bp-away-score">'+(awayScore==null?'—':awayScore)+'</strong></div><div class="ql-scorebug-team"><span>'+esc(game.home)+'</span><strong id="ql-bp-home-score">'+(homeScore==null?'—':homeScore)+'</strong></div><div class="ql-scorebug-state"><b id="ql-bp-inning">'+esc(lv.inning||gameStatus(game))+'</b><span id="ql-bp-count">'+(game.status==='final'?'Verified final':(lv.balls==null?'Count —':lv.balls+'–'+lv.strikes)+' · '+(lv.outs==null?'—':lv.outs)+' out')+'</span></div></div><div class="ql-wpbug"><div class="ql-wpbug-head"><span>'+esc(game.home)+' win probability</span><strong id="ql-bp-wp">'+pct(wp,1)+'</strong></div><div class="ql-wpbug-track"><i id="ql-bp-wp-bar" style="width:'+(finite(wp)?wp*100:50)+'%"></i></div></div></div><div class="ql-live-lower"><div class="ql-live-story"><div class="ql-live-story-label">'+storyLabel+'</div><div><strong>'+esc(awayStarter)+' → '+esc(homeStarter)+'</strong><span id="ql-ballpark-message">'+esc(storyMessage)+'</span></div>'+(game.status==='live'?'<button onclick="QuantLabUI.loadPitches(true)">Load at-bat</button>':'')+'</div><div id="ql-bp-events" class="ql-ballpark-notes">'+events+'</div></div><div class="ql-ballpark-detail"><div class="ql-legend"><span class="measured"><i></i>Measured</span><span class="derived"><i></i>Derived</span><span class="schematic"><i></i>Stylized</span></div>'+esc(config.distinctive)+' · '+esc(config.sourceLabel)+'. Listed wall points are sourced; intervening architecture and movement are stylized.</div></div></div></div>';
    var stage=document.getElementById('ql-ballpark-host');if(state.engine)state.engine.dispose();var engine=new root.BallparkEngine(stage,{onFallback:function(){var m=document.getElementById('ql-ballpark-message');if(m)m.textContent='WebGL was unavailable. The analytical 2D field remains active.';}});state.engine=engine;engine.init(config,game,state.quality).then(function(result){if(state.engine!==engine||!result||result.mode==='cancelled')return;engine.setOverlay('dimensions',state.overlays.dimensions);engine.setOverlay('defense',state.overlays.defense);var cached=state.pitchCache[game.id];if(cached&&cached.pitches&&cached.pitches.length)engine.showPitch(cached.pitches[cached.pitches.length-1]);});
  }
  function updateBallparkLive(game){if(!game)return;var wp=game.status==='live'&&root.liveWinProb?safeCall('liveWinProb',[game]):game.homeP,lv=game.live||{},values={
    'ql-bp-away-score':lv.away!=null?lv.away:(game.finalScore?game.finalScore.a:'—'),
    'ql-bp-home-score':lv.home!=null?lv.home:(game.finalScore?game.finalScore.h:'—'),
    'ql-bp-inning':lv.inning||gameStatus(game),
    'ql-bp-count':(lv.balls==null?'Count —':lv.balls+'–'+lv.strikes)+' · '+(lv.outs==null?'—':lv.outs)+' out',
    'ql-bp-wp':pct(wp,1),'ql-bp-rail-wp':pct(wp,1),
    'ql-bp-leverage':(safeCall('gameLeverage',[game])||{}).label||'—'
  };Object.keys(values).forEach(function(id){var node=document.getElementById(id);if(node)node.textContent=values[id];});var bar=document.getElementById('ql-bp-wp-bar');if(bar)bar.style.width=(finite(wp)?wp*100:50)+'%';var events=document.getElementById('ql-bp-events');if(events)events.innerHTML=ballparkEvents(game);if(state.engine)state.engine.updateGame(game);}
  function ballparkEvents(game){var list=(root.ALERTS||[]).filter(function(a){return String(a.gid)===String(game.id);}).slice(0,8);if(!list.length){var text=game.status==='pre'?'Awaiting first pitch':game.status==='live'?'Live state received':'Final score verified';list=[{ts:Date.now(),msg:text,icon:'•'}];}return list.map(function(e,i){return '<div class="ql-event '+(i===0&&game.status==='live'?'live':'')+'"><time>'+esc(localDate(e.ts,{hour:'numeric',minute:'2-digit'}))+'</time><i></i><div><strong>'+esc(e.icon||'Event')+'</strong> '+esc(e.msg||'')+'</div></div>';}).join('');}

  function updateTopbar(){var bank=document.getElementById('bankroll-in'),kelly=document.getElementById('kelly-frac'),clock=document.getElementById('ds-clock'),badge=document.getElementById('live-badge');if(clock)clock.textContent=localDate(Date.now(),{hour:'numeric',minute:'2-digit',second:'2-digit'});if(badge)badge.textContent=root.ESPN_OK?'DATA LIVE':'DATA PENDING';if(bank&&document.activeElement!==bank)bank.value=safeCall('getBankroll')||1000;if(kelly)kelly.value=String(safeCall('getKellyFrac')||.25);}

  function renderCurrent(){updateTopbar();maybeFreezeSnapshots();if(state.view==='slate')renderSlate();else if(state.view==='game')renderGame();else if(state.view==='ballpark'){var g=selectedGame();if(state.engine)updateBallparkLive(g);else renderBallpark();}else if(state.view==='performance')renderPerformance();else if(state.view==='model')renderModelPage();else if(state.view==='market')renderMarket();else if(state.view==='data')renderData();}

  function showPanel(id,topView){document.querySelectorAll('.pnl').forEach(function(panel){panel.classList.remove('active');});var panel=document.getElementById(id);if(panel)panel.classList.add('active');document.querySelectorAll('.ql-nav .tab').forEach(function(button){button.classList.toggle('active',button.getAttribute('data-view')===topView);});document.body.classList.toggle('ds-ballpark-mode',topView==='ballpark');state.view=topView;window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}
  function setTab(view){var aliases={today:'slate',betting:'market',accuracy:'performance'};view=aliases[view]||view;var panels={slate:'pnl-today',game:'pnl-game',ballpark:'pnl-ballpark',model:'pnl-model',performance:'pnl-performance',market:'pnl-betting',data:'pnl-data'};if(!panels[view])view='slate';if(state.view==='ballpark'&&view!=='ballpark'&&state.engine){state.engine.dispose();state.engine=null;}showPanel(panels[view],view);renderCurrent();}
  function openLegacy(name){if(state.engine){state.engine.dispose();state.engine=null;}var map={history:['pnl-history','performance','renderHistory'],calib:['pnl-calib','performance','renderCalib'],accuracy:['pnl-accuracy','performance','renderAccuracy'],backtest:['pnl-backtest','performance','renderBacktest'],bracket:['pnl-bracket','model','renderBracket'],ai:['pnl-ai','model','renderAITab']};var item=map[name]||map.history;showPanel(item[0],item[1]);safeCall(item[2]);}
  function selectGame(id){state.selectedGameId=String(id);renderSlate();renderGame();}
  function openGame(){setTab('game');}
  function enterBallpark(){setTab('ballpark');}
  function setSlateFilter(filter){state.filter=filter;renderSlate();}
  function setMarketFilter(filter){state.marketFilter=filter;renderSlate();}
  function setConfidenceFilter(filter){state.confidenceFilter=filter;renderSlate();}
  function setSlateSort(sort){if(state.sort===sort)state.sortDir*=-1;else{state.sort=sort;state.sortDir=(sort==='time'?1:-1);}renderSlate();}
  function toggleModelFeature(key,enabled){state.modelToggles[key]=!!enabled;renderGame();}
  function setCamera(mode,button){if(state.engine)state.engine.setCamera(mode);document.querySelectorAll('[data-camera]').forEach(function(el){el.classList.toggle('active',el===button);});}
  function setCameraSelect(mode){if(state.engine)state.engine.setCamera(mode);}
  function toggleOverlay(name,button){state.overlays[name]=!state.overlays[name];button.classList.toggle('active',state.overlays[name]);if(state.engine)state.engine.setOverlay(name,state.overlays[name]);}
  function setQuality(quality){state.quality=quality;var control=document.getElementById('ds-quality');if(control&&control.value!==quality)control.value=quality;if(state.view==='ballpark')renderBallpark();}
  function setPerformanceMetric(metric){state.performanceMetric=metric;renderPerformance();}
  function setPerformanceRolling(value){state.performanceRolling=Math.max(1,Number(value)||50);renderPerformance();}
  function selectSource(index){state.selectedSource=Number(index)||0;renderData();}
  function openData(){setTab('data');}
  function retryMarket(){var message=document.querySelector('.ds-market-empty span');if(message)message.textContent='Refreshing schedule and moneyline coverage…';if(typeof root.fetchESPN==='function'){Promise.resolve(root.fetchESPN()).then(function(){renderMarket();}).catch(function(){renderMarket();});}else renderMarket();}
  function loadPitches(fromBallpark){var game=selectedGame(),message=document.getElementById(fromBallpark?'ql-ballpark-message':'ql-pitch-lab');if(!game)return;if(game.status==='pre'){if(message)message.textContent='Measured pitch coordinates become available after first pitch.';return;}if(message)message.textContent='Loading the current at-bat from MLB…';if(typeof root.mlbGamePkFor!=='function'||typeof root.fetchMLBPitches!=='function'){if(message)message.textContent='MLB pitch feed is unavailable.';return;}root.mlbGamePkFor(game).then(root.fetchMLBPitches).then(function(result){if(!result||!result.pitches||!result.pitches.length)throw new Error('No tracked pitches in the current at-bat.');state.pitchCache[game.id]=result;if(state.engine)state.engine.showPitch(result.pitches[result.pitches.length-1]);if(fromBallpark){var m=document.getElementById('ql-ballpark-message');if(m)m.textContent=result.pitches.length+' measured pitch'+(result.pitches.length===1?'':'es')+' loaded. Trajectory interpolation is schematic.';}else renderGame();}).catch(function(error){var m=document.getElementById(fromBallpark?'ql-ballpark-message':'ql-pitch-lab');if(m)m.textContent=error&&error.message?error.message:'Could not reach the MLB pitch feed.';});}
  function exportSnapshots(){var store=getSnapshotStore(),content=JSON.stringify({exportedAt:new Date().toISOString(),schema:store.schema,snapshots:store.snapshots},null,2);if(typeof root.downloadBlob==='function')root.downloadBlob(content,'mlb-prediction-snapshots-'+new Date().toISOString().slice(0,10)+'.json','application/json');}
  function syncSettings(){var bottomBank=document.getElementById('bankroll-in'),bottomKelly=document.getElementById('kelly-frac');if(bottomBank)bottomBank.value=safeCall('getBankroll')||1000;if(bottomKelly)bottomKelly.value=String(safeCall('getKellyFrac')||.25);if(state.view==='market')renderMarket();updateTopbar();}

  function toggleSettings(open){var drawer=document.getElementById('ds-settings'),scrim=document.getElementById('ds-drawer-scrim');if(!drawer||!scrim)return;drawer.classList.toggle('open',!!open);scrim.classList.toggle('open',!!open);drawer.setAttribute('aria-hidden',open?'false':'true');}
  function setReducedMotion(enabled){document.documentElement.classList.toggle('ds-reduced-motion',!!enabled);try{localStorage.setItem('diamond_signal_reduced_motion',enabled?'1':'0');}catch(error){}}

  function init(){if(state.initialized)return;state.initialized=true;state.quality=matchMedia('(max-width: 760px)').matches?'low':'medium';root.renderToday=renderCurrent;root.setTab=setTab;root.jumpToGame=function(id){state.selectedGameId=String(id);setTab('game');};if(games().length)state.selectedGameId=String(games()[0].id);try{var reduced=localStorage.getItem('diamond_signal_reduced_motion')==='1';var control=document.getElementById('ds-reduced-motion');if(control)control.checked=reduced;setReducedMotion(reduced);}catch(error){}updateTopbar();maybeFreezeSnapshots();renderSlate();renderGame();renderModelPage();renderPerformance();renderMarket();renderData();setInterval(function(){updateTopbar();if(['slate','game','performance','model','market','data','ballpark'].indexOf(state.view)>=0)renderCurrent();},15000);}

  root.QuantLabUI={init:init,setTab:setTab,selectGame:selectGame,openGame:openGame,enterBallpark:enterBallpark,setSlateFilter:setSlateFilter,setMarketFilter:setMarketFilter,setConfidenceFilter:setConfidenceFilter,setSlateSort:setSlateSort,toggleModelFeature:toggleModelFeature,setCamera:setCamera,setCameraSelect:setCameraSelect,toggleOverlay:toggleOverlay,setQuality:setQuality,setPerformanceMetric:setPerformanceMetric,setPerformanceRolling:setPerformanceRolling,selectSource:selectSource,openData:openData,retryMarket:retryMarket,loadPitches:loadPitches,exportSnapshots:exportSnapshots,exportTradingLog:exportTradingLog,syncSettings:syncSettings,render:renderCurrent};
  root.DiamondSignalUI={toggleSettings:toggleSettings,setReducedMotion:setReducedMotion};
  init();
})(typeof window !== "undefined" ? window : globalThis);
