(function(root) {
  "use strict";

  var SNAPSHOT_KEY = "mlb_prediction_snapshots_v1";
  var MODEL_VERSION = "2.0.0-shadow";
  var CALIBRATION_VERSION = "rolling-alpha-v1";
  var state = {
    view: "slate",
    selectedGameId: null,
    filter: "all",
    sort: "time",
    sortDir: 1,
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
    if (game.status === "void") return "VOID";
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
      var game = row.game;
      if (state.filter === "soon") return game.status === "pre" && game.startMs >= now && game.startMs <= now + 90 * 60000;
      if (state.filter === "edge") return finite(row.market.edge) && row.market.edge >= .04;
      if (state.filter === "confidence") return game.conf >= .60;
      if (state.filter === "agreement") return row.detail.agreement === "Strong";
      if (state.filter === "complete") return row.quality.score >= 85;
      if (state.filter === "live") return game.status === "live";
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

  function filterButton(id, label) {
    return '<button class="ql-filter '+(state.filter === id ? "active" : "")+'" onclick="QuantLabUI.setSlateFilter(\''+id+'\')">'+label+'</button>';
  }

  function renderSlate() {
    var rootEl = document.getElementById("ql-slate-root"); if (!rootEl) return;
    var list = slateRows(), game = selectedGame();
    var providers = games().map(function(g) { var o = root.ODDS && root.ODDS[g.id]; return o && o.real ? o.provider : null; }).filter(Boolean);
    var dateLabel = localDate(Date.now(), { weekday: "long", month: "long", day: "numeric" });
    var body = list.length ? list.map(renderSlateRow).join("") : '<tr class="ql-table-empty"><td colspan="8">No games match the selected filter. The verified slate remains available under All.</td></tr>';
    rootEl.innerHTML = '<div class="ql-page-head"><div><div class="ql-eyebrow">Daily forecasting workspace</div><h1>'+esc(dateLabel)+'</h1><p>'+games().length+' verified matchup'+(games().length === 1 ? "" : "s")+' · probabilities update when source data changes</p></div>'
      +'<div class="ql-inline-meta"><span><i class="ql-source-dot '+(root.ESPN_OK ? "" : "pending")+'"></i>'+ (root.ESPN_OK ? "ESPN slate active" : "Feed pending") +'</span><span>Markets <strong>'+providers.length+'/'+games().length+'</strong></span></div></div>'
      +'<div class="ql-workspace"><section class="ql-slate-pane"><div class="ql-toolbar"><div class="ql-filter-group">'
      +filterButton("all","All")+filterButton("soon","Starting soon")+filterButton("edge","High edge")+filterButton("confidence","High confidence")+filterButton("agreement","Model agreement")+filterButton("complete","Data complete")+filterButton("live","Live")
      +'</div><select class="ql-control" aria-label="Sort slate" onchange="QuantLabUI.setSlateSort(this.value)"><option value="time" '+(state.sort==="time"?"selected":"")+'>Game time</option><option value="confidence" '+(state.sort==="confidence"?"selected":"")+'>Confidence</option><option value="edge" '+(state.sort==="edge"?"selected":"")+'>Edge</option><option value="disagreement" '+(state.sort==="disagreement"?"selected":"")+'>Disagreement</option><option value="runs" '+(state.sort==="runs"?"selected":"")+'>Projected runs</option><option value="quality" '+(state.sort==="quality"?"selected":"")+'>Data quality</option></select></div>'
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
      +'<td class="num"><div class="ql-quality '+q.level+'"><div class="ql-quality-bar"><i style="width:'+q.score+'%"></i></div><span class="ql-value">'+q.score+'%</span></div></td></tr>';
  }

  function renderInspector(game) {
    if (!game) return '<div class="ql-empty"><strong>No matchup selected</strong><span>The game workspace will populate when the official slate is available.</span></div>';
    var detail=modelDetail(game), quality=dataQuality(game), market=marketForPick(game), pickHome=game.homeP>=.5, pick=pickHome?game.home:game.away, opponent=pickHome?game.away:game.home;
    var park=root.stadiumForTeam?root.stadiumForTeam(game.home,root.PARK&&root.PARK[game.home]):{name:"Home ballpark"};
    var score=game.pois?(game.home+' '+num(game.pois.lambdaH,1)+' — '+game.away+' '+num(game.pois.lambdaA,1)):'—';
    return '<div class="ql-inspector-inner"><div class="ql-inspector-kicker"><span>'+esc(gameStatus(game))+' · '+esc(game.time||'Time pending')+'</span><span>'+esc(park.name)+'</span></div>'
      +'<div class="ql-inspector-match"><div class="ql-inspector-team">'+logo(pick,pick)+'<div><strong>'+esc(teamLabel(pick))+'</strong><span>vs '+esc(teamLabel(opponent))+'</span></div></div><div class="ql-inspector-prob"><strong>'+pct(Math.max(game.homeP,game.awayP),1)+'</strong><span>published win probability</span></div></div>'
      +'<div class="ql-inspector-grid"><div class="ql-inspector-stat"><span>Market</span><strong>'+(market.probability==null?'—':pct(market.probability,1))+'</strong></div><div class="ql-inspector-stat"><span>Edge</span><strong class="'+(market.edge>=.04?'ql-edge positive':'')+'">'+signedPct(market.edge,1)+'</strong></div><div class="ql-inspector-stat"><span>Projected</span><strong>'+esc(score)+'</strong></div><div class="ql-inspector-stat"><span>Data</span><strong>'+quality.score+'%</strong></div></div>'
      +'<div class="ql-inspector-section"><h3>Base-model view</h3>'+modelRows(detail,pickHome)+'</div>'
      +'<div class="ql-inspector-section"><h3>Read</h3><p style="margin:0;color:var(--text-secondary);font-size:11px;line-height:1.55">'+esc(inspectorRead(game,detail,market,quality))+'</p></div>'
      +'<div class="ql-actions"><button class="ql-primary" onclick="QuantLabUI.openGame()">Open game analysis</button><button class="ql-secondary" onclick="QuantLabUI.enterBallpark()">Enter ballpark</button></div></div>';
  }

  function modelRows(detail, pickHome) {
    var rows=[['Elo',detail.parts.elo],['Poisson',detail.parts.poisson],['Feature',detail.parts.feature],['Published',detail.publishedProbability]];
    return rows.map(function(row){var value=finite(row[1])?(pickHome?row[1]:1-row[1]):null;return '<div class="ql-model-row"><span>'+row[0]+'</span><div class="ql-model-track"><i style="width:'+(value==null?0:value*100)+'%"></i></div><strong>'+pct(value,1)+'</strong></div>';}).join('');
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
    host.innerHTML='<div class="ql-game-head"><div class="ql-game-title">'+logo(game.away,game.away)+logo(game.home,game.home)+'<div><div class="ql-eyebrow">'+esc(park.name)+' · '+esc(game.time||'Time pending')+'</div><h1>'+esc(teamLabel(game.away))+' @ '+esc(teamLabel(game.home))+'</h1><p>'+esc(gameStatus(game))+' · selected from today\'s verified slate</p></div></div>'
      +'<div class="ql-actions"><button class="ql-secondary" onclick="setTab(\'slate\')">Back to slate</button><button class="ql-primary" onclick="QuantLabUI.enterBallpark()">Enter ballpark</button></div></div>'
      +'<div class="ql-game-scorecard"><div><span>Model</span><strong>'+esc(pick)+' '+pct(Math.max(game.homeP,game.awayP),1)+'</strong></div><div><span>Market</span><strong>'+(market.probability==null?'—':esc(pick)+' '+pct(market.probability,1))+'</strong></div><div><span>Model edge</span><strong class="'+(market.edge>=.04?'ql-edge positive':'')+'">'+signedPct(market.edge,1)+'</strong></div><div><span>Projected score</span><strong>'+esc(projected)+'</strong></div><div><span>Agreement / data</span><strong>'+esc(detail.agreement)+' · '+quality.score+'%</strong></div></div>'
      +'<div class="ql-game-layout"><main>'+comparisonSection(game)+contributionSection(game,detail,pickHome)+pitchLab(game)+'</main><aside>'+baseModelSection(detail,pickHome)+modelFlow(detail,pickHome)+modelLab(game,detail,pickHome)+'</aside></div>';
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
    return '<section class="ql-section"><div class="ql-section-head"><h2>Why the model leans '+esc(pickHome?game.home:game.away)+'</h2><span>Logit contribution · selected-side orientation</span></div><div class="ql-waterfall"><div class="ql-waterfall-start"><span>Start</span><strong class="ql-value">50.0%</strong></div>'+html+'<div class="ql-waterfall-total"><span>Published probability</span><strong class="ql-value">'+pct(Math.max(game.homeP,game.awayP),1)+'</strong></div></div></section>';
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

  function renderPerformance(){var host=document.getElementById('ql-performance-root');if(!host)return;var perf=performanceRows(),bets=bettingSummary(),m=perf.metrics,record=m.n?Math.round(m.accuracy*m.n)+'–'+(m.n-Math.round(m.accuracy*m.n)):'—';
    host.innerHTML='<div class="ql-page-head"><div><div class="ql-eyebrow">Prospective evaluation</div><h1>Performance</h1><p>Forward snapshots are evaluated separately from legacy history and reconstructed backtests.</p></div><div class="ql-inline-meta"><span>Snapshot schema <strong>v1</strong></span><span>Timezone <strong>'+esc(Intl.DateTimeFormat().resolvedOptions().timeZone||'local')+'</strong></span></div></div>'
      +'<div class="ql-subnav"><button onclick="QuantLabUI.openLegacy(\'calib\')">Calibration details</button><button onclick="QuantLabUI.openLegacy(\'accuracy\')">Legacy accuracy</button><button onclick="QuantLabUI.openLegacy(\'backtest\')">Backtest tools</button><button onclick="QuantLabUI.openLegacy(\'history\')">Prediction log</button></div>'
      +'<div class="ql-kpis">'+kpi('Record',record,m.n?'prospective frozen':'awaiting snapshots')+kpi('Win rate',m.n?pct(m.accuracy,1):'—','published probability')+kpi('Flat P/L',bets.rows.length?money(bets.flat):'—','$100 flat stakes',bets.flat)+kpi('¼-Kelly P/L',bets.rows.length?money(bets.kelly):'—','paper trading',bets.kelly)+kpi('Flat ROI',bets.rows.length?pct(bets.flatRoi,1):'—','graded bets')+kpi('Max drawdown',bets.rows.length?money(-bets.maxDD):'—','Kelly curve',-bets.maxDD)+kpi('Bets logged',String(bets.rows.length),'verified lines only')+kpi('Average edge',bets.rows.length?pct(bets.avgEdge,1):'—','at prediction')+'</div>'
      +'<div class="ql-toast-note warning"><strong>Legacy audit reference:</strong> the supplied 199-game review reported 57.8% accuracy, 0.2505 Brier, and 0.6959 log loss. It is retained as a labeled benchmark, not mixed with the forward snapshot record.</div>'
      +'<div class="ql-performance-grid"><div>'+bankrollChart(bets.rows)+calibrationTable(perf.snapshots)+'</div><div>'+modelVersionTable(perf)+recentBetLog(bets.rows)+'</div></div>';
  }
  function money(value){return (value>=0?'+':'−')+'$'+Math.abs(value).toFixed(0);}
  function kpi(label,value,sub,semantic){var cls=finite(semantic)?(semantic>0?'pos':semantic<0?'neg':''):'';return '<div class="ql-kpi"><span>'+esc(label)+'</span><strong class="'+cls+'">'+esc(value)+'</strong><small>'+esc(sub||'')+'</small></div>';}
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
  function calibrationTable(snapshots){var bands=[[.5,.55],[.55,.6],[.6,.65],[.65,.7],[.7,.75],[.75,1.001]],rows=bands.map(function(b){var set=snapshots.filter(function(s){var c=Math.max(s.publishedProb,1-s.publishedProb);return c>=b[0]&&c<b[1];});var wins=set.filter(function(s){return (s.publishedProb>=.5)===!!s.result.actualHome;}).length,avg=set.length?set.reduce(function(sum,s){return sum+Math.max(s.publishedProb,1-s.publishedProb);},0)/set.length:null,actual=set.length?wins/set.length:null,ci=set.length&&root.wilsonCI?root.wilsonCI(wins,set.length):null;return {label:Math.round(b[0]*100)+'–'+(b[1]>1?'100':Math.round(b[1]*100))+'%',n:set.length,avg:avg,actual:actual,ci:ci};});return '<section class="ql-section"><div class="ql-section-head"><h2>Calibration by confidence</h2><span>Prospective snapshots only · Wilson interval</span></div><table class="ql-health-table"><thead><tr><th>Confidence</th><th>Predicted</th><th>Actual</th><th>95% interval</th><th>N</th></tr></thead><tbody>'+rows.map(function(r){return '<tr><td>'+r.label+'</td><td>'+pct(r.avg,1)+'</td><td>'+pct(r.actual,1)+'</td><td>'+(r.ci?pct(r.ci[0],0)+'–'+pct(r.ci[1],0):'—')+'</td><td>'+r.n+'</td></tr>';}).join('')+'</tbody></table></section>';}
  function modelVersionTable(perf){
    var versions=perf.versions||{},published=versions.published||perf.metrics||{n:0},raw=versions.raw||{n:0},calibrated=versions.calibrated||{n:0};
    function row(label,m){return '<tr><td>'+esc(label)+'</td><td>'+m.n+'</td><td>'+pct(m.accuracy,1)+'</td><td>'+num(m.brier,4)+'</td><td>'+num(m.logLoss,4)+'</td><td>'+num(m.auc,3)+'</td><td>'+num(m.ece,3)+'</td></tr>';}
    function pending(label,note){return '<tr><td>'+esc(label)+'</td><td colspan="6" style="color:var(--text-tertiary)">'+esc(note)+'</td></tr>';}
    return '<section class="ql-section"><div class="ql-section-head"><h2>Model versions</h2><span>Forward comparison</span></div><table class="ql-health-table"><thead><tr><th>Model</th><th>N</th><th>ACC</th><th>Brier</th><th>Log loss</th><th>AUC</th><th>ECE</th></tr></thead><tbody>'+row('Published',published)+row('Raw ensemble shadow',raw)+row('Calibrated shadow',calibrated)+pending('Frozen comparator','Begins with the next explicitly frozen weight release')+pending('Online learner','Requires a separately versioned pregame output')+pending('Walk-forward batch','Requires an adequate chronological snapshot sample')+'</tbody></table></section>';
  }
  function recentBetLog(rows){return '<section class="ql-section"><div class="ql-section-head"><h2>Recent paper-trading log</h2><span>Verified results</span></div>'+(rows.length?'<div class="ql-snapshot-list">'+rows.slice(-8).reverse().map(function(row){return '<div class="ql-snapshot-row"><span>'+esc(row.pick||row.team||'Market')+' <small>'+ml(row.ml)+'</small></span><strong class="'+(row.won?'ql-edge positive':'ql-edge negative')+'">'+(row.won?'WIN':'LOSS')+'</strong><span>'+money(row.won?(row.kStake||0)*((safeCall('mlToDecimal',[row.ml])||1)-1):-(row.kStake||0))+'</span></div>';}).join('')+'</div>':'<div class="ql-empty" style="min-height:150px"><span>No graded paper trades.</span></div>')+'</section>';}

  function renderModelPage(){var host=document.getElementById('ql-model-root');if(!host)return;var perf=performanceRows(),m=perf.metrics,game=selectedGame(),detail=game?modelDetail(game):null;
    host.innerHTML='<div class="ql-page-head"><div><div class="ql-eyebrow">Forecast architecture and validation</div><h1>Model health</h1><p>Out-of-time log loss and Brier lead the evaluation hierarchy. Training accuracy is not a promotion criterion.</p></div><div class="ql-inline-meta"><span>Production path <strong>feature + Poisson</strong></span><span>Shadow path <strong>three-model calibrated</strong></span></div></div>'
      +'<div class="ql-kpis">'+kpi('Accuracy',m.n?pct(m.accuracy,1):'—','prospective')+kpi('Brier',m.n?num(m.brier,4):'—','lower is better')+kpi('Log loss',m.n?num(m.logLoss,4):'—','coin flip 0.6931')+kpi('ECE',m.n?num(m.ece,3):'—','calibration gap')+kpi('Games',String(m.n),'frozen snapshots')+kpi('Raw / calibrated',detail?pct(detail.rawProbability,1)+' / '+pct(detail.calibratedProbability,1):'—','selected game')+kpi('Calibration α',detail&&detail.calibrationFitted?num(detail.alpha,2):'—',detail?detail.calibrationN+' prior games':'no game')+kpi('Dispersion',detail&&detail.dispersion!=null?(detail.dispersion*100).toFixed(1)+' pp':'—',detail?detail.agreement:'no game')+'</div>'
      +'<div class="ql-subnav"><button onclick="QuantLabUI.openLegacy(\'bracket\')">Playoff projection</button><button onclick="QuantLabUI.openLegacy(\'ai\')">Rules-based slate query</button></div>'
      +'<div class="ql-performance-grid"><div>'+(detail?modelFlow(detail,detail.publishedProbability>=.5):'<section class="ql-section"><div class="ql-empty">Select a game to inspect model flow.</div></section>')+'<section class="ql-section"><div class="ql-section-head"><h2>Walk-forward validation</h2><span>Primary framework</span></div><div class="ql-lab"><p class="ql-lab-note">Rolling-origin splits fit normalization, model weights, and calibration on earlier games only. A forward result appears after enough immutable snapshots exist; legacy backtests are not silently reused.</p><table class="ql-health-table"><thead><tr><th>Stage</th><th>Training window</th><th>Evaluation window</th><th>Status</th></tr></thead><tbody><tr><td>Normalization</td><td>Prior fold</td><td>Unseen fold</td><td>Implemented</td></tr><tr><td>Logistic weights</td><td>Prior fold</td><td>Unseen fold</td><td>Implemented</td></tr><tr><td>Calibration alpha</td><td>Prior games</td><td>Next prediction</td><td>Implemented</td></tr><tr><td>Promotion decision</td><td>Prospective sample</td><td>Future games</td><td>Pending evidence</td></tr></tbody></table></div></section></div><div>'+modelVersionTable(perf)+'<section class="ql-section"><div class="ql-section-head"><h2>Feature ablation</h2><span>Walk-forward only</span></div><table class="ql-health-table"><thead><tr><th>Feature</th><th>N</th><th>Δ log loss</th><th>Δ Brier</th><th>Δ accuracy</th></tr></thead><tbody><tr><td colspan="5" style="text-align:center;color:var(--text-tertiary)">Awaiting an adequate prospective feature-snapshot sample. No feature is removed on a tiny sample.</td></tr></tbody></table></section></div></div>';
  }

  function sourceStatus(){var list=games(),starter=0,weather=0,markets=0;list.forEach(function(g){var sp=root.SP&&root.SP[g.id],o=root.ODDS&&root.ODDS[g.id];if(sp&&sp.h&&sp.a&&sp.h.name&&sp.a.name)starter++;if(sp&&sp.wxReal)weather++;if(o&&o.real)markets++;});return [{name:'Schedule',value:root.ESPN_OK?'Verified':'Pending',status:root.ESPN_OK?'ok':'pending',coverage:list.length?list.length+' games':'—',source:'ESPN scoreboard'}, {name:'Starters',value:starter+'/'+list.length,status:starter===list.length&&list.length?'ok':'pending',coverage:'Names posted',source:'ESPN / MLB Stats API'}, {name:'Standings',value:root.STANDINGS_OK?'Current':'Pending',status:root.STANDINGS_OK?'ok':'pending',coverage:'Season / L10 / run differential',source:'ESPN / MLB Stats API'}, {name:'Injuries',value:root.INJURIES&&Object.keys(root.INJURIES).length?'Current':'Pending',status:root.INJURIES&&Object.keys(root.INJURIES).length?'ok':'pending',coverage:'Availability report',source:'ESPN'}, {name:'Weather',value:weather+'/'+list.length,status:weather===list.length&&list.length?'ok':'pending',coverage:'Game conditions',source:'ESPN'}, {name:'Market odds',value:markets+'/'+list.length,status:markets?'ok':'pending',coverage:'Real moneylines only',source:'ESPN odds provider'}, {name:'Live play feed',value:root.ESPN_OK?'Active':'Pending',status:root.ESPN_OK?'ok':'pending',coverage:'Score / inning / count',source:'ESPN + MLB live feed'}];}
  function renderData(){var host=document.getElementById('ql-data-root');if(!host)return;var sources=sourceStatus(),store=getSnapshotStore(),snaps=Object.keys(store.snapshots||{}).map(function(k){return store.snapshots[k];}).sort(function(a,b){return b.firstPitch-a.firstPitch;}),legacy=(safeCall('realHistory')||[]).length+Object.keys(safeCall('btLoad')||{}).filter(function(k){return k.indexOf('__')!==0;}).length;
    host.innerHTML='<div class="ql-page-head"><div><div class="ql-eyebrow">Coverage, provenance, and frozen records</div><h1>Data health</h1><p>Unavailable inputs remain neutral. Missing values render as — and never become synthetic model features.</p></div><div class="ql-actions"><button class="ql-secondary" onclick="QuantLabUI.exportSnapshots()">Download snapshots</button><button class="ql-secondary" onclick="QuantLabUI.openLegacy(\'history\')">Prediction log</button></div></div>'
      +'<div class="ql-data-grid"><div><section class="ql-section"><div class="ql-section-head"><h2>Source coverage</h2><span>Current slate</span></div><table class="ql-health-table"><thead><tr><th>Source</th><th>Status</th><th>Coverage</th><th>Provenance</th></tr></thead><tbody>'+sources.map(function(s){return '<tr><td>'+esc(s.name)+'</td><td><span class="ql-health-status '+s.status+'"><i></i>'+esc(s.value)+'</span></td><td>'+esc(s.coverage)+'</td><td>'+esc(s.source)+'</td></tr>';}).join('')+'</tbody></table></section><section class="ql-section"><div class="ql-section-head"><h2>Source provenance</h2><span>Major analytical inputs</span></div><div class="ql-source-list">'+provenanceRows()+'</div></section></div><div><section class="ql-section"><div class="ql-section-head"><h2>Prediction snapshots</h2><span>'+snaps.length+' frozen · '+legacy+' legacy rows</span></div>'+(snaps.length?'<div class="ql-snapshot-list">'+snaps.slice(0,12).map(function(s){return '<div class="ql-snapshot-row"><span>'+esc(s.away)+' @ '+esc(s.home)+'<small class="ql-subline">'+esc(localDate(s.firstPitch,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))+'</small></span><strong>'+pct(s.publishedProb,1)+'</strong><span>'+esc(s.result?'GRADED':'FROZEN')+'</span></div>';}).join('')+'</div>':'<div class="ql-empty" style="min-height:180px"><strong>No frozen snapshots yet</strong><span>The browser freezes a prediction when an upcoming game is observed within 30 minutes of first pitch. Existing rows remain labeled legacy.</span></div>')+'</section><section class="ql-section"><div class="ql-section-head"><h2>Legacy history</h2><span>Excluded from prospective claims</span></div><div class="ql-lab"><span class="ql-legacy-label">LEGACY</span><p class="ql-lab-note" style="margin-top:9px">'+legacy+' existing grade'+(legacy===1?' is':'s are')+' retained for continuity. Rows without a complete pregame feature and market snapshot are not reconstructed with current inputs.</p></div></section></div></div>';
  }
  function provenanceRows(){var rows=[['Schedule / scores','ESPN','Measured','https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'],['Standings / records','ESPN + MLB','Measured','https://statsapi.mlb.com/api/v1/standings'],['Probable starters','ESPN + MLB','Measured','https://statsapi.mlb.com/api/v1/schedule'],['Pitch locations','MLB live feed','Measured','https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live'],['Elo / Poisson / model output','Local model','Derived',''],['Representative park dimensions','Official MLB/team pages','Measured + schematic interpolation','https://www.mlb.com/ballparks'],['Unconfigured stadium geometry','Procedural fallback','Schematic','']];return rows.map(function(r){return '<div class="ql-source-row"><b>'+esc(r[0])+'</b><span>'+esc(r[2])+'</span>'+(r[3]?'<a href="'+esc(r[3])+'" target="_blank" rel="noopener">'+esc(r[1])+'</a>':'<span>'+esc(r[1])+'</span>')+'</div>';}).join('');}

  function renderBallpark(){var host=document.getElementById('ql-ballpark-root');if(!host)return;var game=selectedGame();if(!game){host.innerHTML='<div class="ql-empty"><strong>No game selected</strong><span>Choose a matchup from the slate before entering Ballpark Live.</span></div>';return;}var config=root.stadiumForTeam?root.stadiumForTeam(game.home,root.PARK&&root.PARK[game.home]):null;if(!config)return;var wp=game.status==='live'&&root.liveWinProb?safeCall('liveWinProb',[game]):game.homeP,lv=game.live||{},events=ballparkEvents(game),sp=root.SP&&root.SP[game.id];
    host.innerHTML='<div class="ql-ballpark-shell"><div class="ql-ballpark-bar"><button class="ql-tertiary" onclick="QuantLabUI.openGame()">← Analysis</button><div class="ql-ballpark-title"><strong>'+esc(config.name)+'</strong><span>'+esc(game.away)+' @ '+esc(game.home)+' · '+(config.schematic?'schematic geometry':'configured dimensions')+'</span></div><div class="ql-camera-group" aria-label="Camera presets">'+['broadcast','catcher','pitcher','overhead','outfield','free'].map(function(name){return '<button class="'+(name==='broadcast'?'active':'')+'" data-camera="'+name+'" onclick="QuantLabUI.setCamera(\''+name+'\',this)">'+name.charAt(0).toUpperCase()+name.slice(1)+'</button>';}).join('')+'</div><div class="ql-overlay-group"><button class="active" data-overlay="dimensions" onclick="QuantLabUI.toggleOverlay(\'dimensions\',this)">Dimensions</button><button data-overlay="defense" onclick="QuantLabUI.toggleOverlay(\'defense\',this)">Defense</button></div><select class="ql-quality-select" aria-label="3D quality" onchange="QuantLabUI.setQuality(this.value)"><option value="high" '+(state.quality==='high'?'selected':'')+'>High</option><option value="medium" '+(state.quality==='medium'?'selected':'')+'>Medium</option><option value="low" '+(state.quality==='low'?'selected':'')+'>Low</option></select></div><div class="ql-ballpark-main"><div class="ql-ballpark-stage"><div id="ql-ballpark-host" class="ql-ballpark-host"></div><div class="ql-broadcast"><div class="ql-scorebug"><div class="ql-scorebug-team"><span>'+esc(game.away)+'</span><strong id="ql-bp-away-score">'+(lv.away==null?'—':lv.away)+'</strong></div><div class="ql-scorebug-team"><span>'+esc(game.home)+'</span><strong id="ql-bp-home-score">'+(lv.home==null?'—':lv.home)+'</strong></div><div class="ql-scorebug-state"><b id="ql-bp-inning">'+esc(lv.inning||gameStatus(game))+'</b><span id="ql-bp-count">'+(lv.balls==null?'Count —':lv.balls+'–'+lv.strikes)+' · '+(lv.outs==null?'—':lv.outs)+' out</span></div></div><div class="ql-wpbug"><div class="ql-wpbug-head"><span>'+esc(game.home)+' win probability</span><strong id="ql-bp-wp">'+pct(wp,1)+'</strong></div><div class="ql-wpbug-track"><i id="ql-bp-wp-bar" style="width:'+(finite(wp)?wp*100:50)+'%"></i></div></div></div></div><aside class="ql-ballpark-rail"><section class="ql-rail-section"><h3>Game state</h3><div class="ql-rail-grid"><div class="ql-rail-stat"><span>Win probability</span><strong id="ql-bp-rail-wp">'+pct(wp,1)+'</strong></div><div class="ql-rail-stat"><span>Leverage</span><strong id="ql-bp-leverage">'+esc((safeCall('gameLeverage',[game])||{}).label||'—')+'</strong></div><div class="ql-rail-stat"><span>Weather</span><strong>'+esc(sp&&sp.wxReal?sp.weather:'—')+'</strong></div><div class="ql-rail-stat"><span>Run expectancy</span><strong>—</strong></div></div></section><section class="ql-rail-section"><h3>Live events</h3><div id="ql-bp-events" class="ql-timeline">'+events+'</div>'+(game.status==='pre'?'':'<button class="ql-secondary" style="margin-top:10px" onclick="QuantLabUI.loadPitches(true)">Load current at-bat</button>')+'<div id="ql-ballpark-message" class="ql-lab-note" style="margin-top:8px"></div></section><section class="ql-rail-section"><h3>Geometry and provenance</h3><div class="ql-legend"><span class="measured"><i></i>Measured</span><span class="derived"><i></i>Derived</span><span class="schematic"><i></i>Schematic</span></div><p class="ql-lab-note" style="margin-top:10px">'+esc(config.sourceLabel)+(config.schematic?' The field is representational and does not claim official wall geometry.':' Intermediate wall segments are procedural interpolations between listed dimensions.')+'</p>'+(config.sourceUrl?'<a href="'+esc(config.sourceUrl)+'" target="_blank" rel="noopener" style="font-size:10px;color:#75a7dc">Official dimension source</a>':'')+'</section></aside></div></div>';
    var stage=document.getElementById('ql-ballpark-host');if(state.engine)state.engine.dispose();var engine=new root.BallparkEngine(stage,{onFallback:function(){var m=document.getElementById('ql-ballpark-message');if(m)m.textContent='WebGL was unavailable. The analytical 2D field remains active.';}});state.engine=engine;engine.init(config,game,state.quality).then(function(result){if(state.engine!==engine||!result||result.mode==='cancelled')return;engine.setOverlay('dimensions',state.overlays.dimensions);engine.setOverlay('defense',state.overlays.defense);var cached=state.pitchCache[game.id];if(cached&&cached.pitches&&cached.pitches.length)engine.showPitch(cached.pitches[cached.pitches.length-1]);});
  }
  function updateBallparkLive(game){if(!game)return;var wp=game.status==='live'&&root.liveWinProb?safeCall('liveWinProb',[game]):game.homeP,lv=game.live||{},values={
    'ql-bp-away-score':lv.away==null?'—':lv.away,
    'ql-bp-home-score':lv.home==null?'—':lv.home,
    'ql-bp-inning':lv.inning||gameStatus(game),
    'ql-bp-count':(lv.balls==null?'Count —':lv.balls+'–'+lv.strikes)+' · '+(lv.outs==null?'—':lv.outs)+' out',
    'ql-bp-wp':pct(wp,1),'ql-bp-rail-wp':pct(wp,1),
    'ql-bp-leverage':(safeCall('gameLeverage',[game])||{}).label||'—'
  };Object.keys(values).forEach(function(id){var node=document.getElementById(id);if(node)node.textContent=values[id];});var bar=document.getElementById('ql-bp-wp-bar');if(bar)bar.style.width=(finite(wp)?wp*100:50)+'%';var events=document.getElementById('ql-bp-events');if(events)events.innerHTML=ballparkEvents(game);if(state.engine)state.engine.updateGame(game);}
  function ballparkEvents(game){var list=(root.ALERTS||[]).filter(function(a){return String(a.gid)===String(game.id);}).slice(0,8);if(!list.length){var text=game.status==='pre'?'Awaiting first pitch':game.status==='live'?'Live state received':'Final score verified';list=[{ts:Date.now(),msg:text,icon:'•'}];}return list.map(function(e,i){return '<div class="ql-event '+(i===0&&game.status==='live'?'live':'')+'"><time>'+esc(localDate(e.ts,{hour:'numeric',minute:'2-digit'}))+'</time><i></i><div><strong>'+esc(e.icon||'Event')+'</strong> '+esc(e.msg||'')+'</div></div>';}).join('');}

  function updateTopbar(){var update=document.getElementById('ql-last-update'),odds=document.getElementById('ql-odds-source'),bank=document.getElementById('bankroll-in-top'),kelly=document.getElementById('kelly-frac-top');if(update)update.textContent=root.ESPN_LAST?localDate(root.ESPN_LAST,{hour:'numeric',minute:'2-digit',second:'2-digit'}):'Pending';var providers=[];games().forEach(function(g){var o=root.ODDS&&root.ODDS[g.id];if(o&&o.real&&providers.indexOf(o.provider)<0)providers.push(o.provider);});if(odds)odds.textContent=providers.length?providers.join(', '):'No posted lines';if(bank&&document.activeElement!==bank)bank.value=safeCall('getBankroll')||1000;if(kelly)kelly.value=String(safeCall('getKellyFrac')||.25);}

  function renderCurrent(){updateTopbar();maybeFreezeSnapshots();if(state.view==='slate')renderSlate();else if(state.view==='game')renderGame();else if(state.view==='ballpark'){var g=selectedGame();if(state.engine)updateBallparkLive(g);else renderBallpark();}else if(state.view==='performance')renderPerformance();else if(state.view==='model')renderModelPage();else if(state.view==='market')safeCall('renderBetting');else if(state.view==='data')renderData();}

  function showPanel(id,topView){document.querySelectorAll('.pnl').forEach(function(panel){panel.classList.remove('active');});var panel=document.getElementById(id);if(panel)panel.classList.add('active');document.querySelectorAll('.ql-nav .tab').forEach(function(button){button.classList.toggle('active',button.getAttribute('data-view')===topView);});state.view=topView;window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}
  function setTab(view){var aliases={today:'slate',betting:'market',accuracy:'performance'};view=aliases[view]||view;if(['history','calib','backtest','bracket','ai'].indexOf(view)>=0){openLegacy(view);return;}var panels={slate:'pnl-today',game:'pnl-game',ballpark:'pnl-ballpark',model:'pnl-model',performance:'pnl-performance',market:'pnl-betting',data:'pnl-data'};if(!panels[view])view='slate';if(state.view==='ballpark'&&view!=='ballpark'&&state.engine){state.engine.dispose();state.engine=null;}showPanel(panels[view],view);if(view==='model')safeCall('renderModel');renderCurrent();}
  function openLegacy(name){if(state.engine){state.engine.dispose();state.engine=null;}var map={history:['pnl-history','performance','renderHistory'],calib:['pnl-calib','performance','renderCalib'],accuracy:['pnl-accuracy','performance','renderAccuracy'],backtest:['pnl-backtest','performance','renderBacktest'],bracket:['pnl-bracket','model','renderBracket'],ai:['pnl-ai','model','renderAITab']};var item=map[name]||map.history;showPanel(item[0],item[1]);safeCall(item[2]);}
  function selectGame(id){state.selectedGameId=String(id);renderSlate();renderGame();}
  function openGame(){setTab('game');}
  function enterBallpark(){setTab('ballpark');}
  function setSlateFilter(filter){state.filter=filter;renderSlate();}
  function setSlateSort(sort){if(state.sort===sort)state.sortDir*=-1;else{state.sort=sort;state.sortDir=(sort==='time'?1:-1);}renderSlate();}
  function toggleModelFeature(key,enabled){state.modelToggles[key]=!!enabled;renderGame();}
  function setCamera(mode,button){if(state.engine)state.engine.setCamera(mode);document.querySelectorAll('[data-camera]').forEach(function(el){el.classList.toggle('active',el===button);});}
  function toggleOverlay(name,button){state.overlays[name]=!state.overlays[name];button.classList.toggle('active',state.overlays[name]);if(state.engine)state.engine.setOverlay(name,state.overlays[name]);}
  function setQuality(quality){state.quality=quality;renderBallpark();}
  function loadPitches(fromBallpark){var game=selectedGame(),message=document.getElementById(fromBallpark?'ql-ballpark-message':'ql-pitch-lab');if(!game)return;if(game.status==='pre'){if(message)message.textContent='Measured pitch coordinates become available after first pitch.';return;}if(message)message.textContent='Loading the current at-bat from MLB…';if(typeof root.mlbGamePkFor!=='function'||typeof root.fetchMLBPitches!=='function'){if(message)message.textContent='MLB pitch feed is unavailable.';return;}root.mlbGamePkFor(game).then(root.fetchMLBPitches).then(function(result){if(!result||!result.pitches||!result.pitches.length)throw new Error('No tracked pitches in the current at-bat.');state.pitchCache[game.id]=result;if(state.engine)state.engine.showPitch(result.pitches[result.pitches.length-1]);if(fromBallpark){var m=document.getElementById('ql-ballpark-message');if(m)m.textContent=result.pitches.length+' measured pitch'+(result.pitches.length===1?'':'es')+' loaded. Trajectory interpolation is schematic.';}else renderGame();}).catch(function(error){var m=document.getElementById(fromBallpark?'ql-ballpark-message':'ql-pitch-lab');if(m)m.textContent=error&&error.message?error.message:'Could not reach the MLB pitch feed.';});}
  function exportSnapshots(){var store=getSnapshotStore(),content=JSON.stringify({exportedAt:new Date().toISOString(),schema:store.schema,snapshots:store.snapshots},null,2);if(typeof root.downloadBlob==='function')root.downloadBlob(content,'mlb-prediction-snapshots-'+new Date().toISOString().slice(0,10)+'.json','application/json');}
  function syncSettings(){var bottomBank=document.getElementById('bankroll-in'),bottomKelly=document.getElementById('kelly-frac');if(bottomBank)bottomBank.value=safeCall('getBankroll')||1000;if(bottomKelly)bottomKelly.value=safeCall('getKellyFrac')||.25;if(state.view==='market')safeCall('renderBetting');updateTopbar();}

  function init(){if(state.initialized)return;state.initialized=true;state.quality=matchMedia('(max-width: 760px)').matches?'low':'medium';state.legacyRenderToday=root.renderToday;if(typeof state.legacyRenderToday==='function'){root.renderToday=function(){state.legacyRenderToday.apply(root,arguments);renderCurrent();};}root.setTab=setTab;root.jumpToGame=function(id){state.selectedGameId=String(id);setTab('game');};if(games().length)state.selectedGameId=String(games()[0].id);updateTopbar();maybeFreezeSnapshots();renderSlate();renderGame();renderModelPage();renderPerformance();renderData();setInterval(function(){updateTopbar();if(['slate','game','performance','model','data','ballpark'].indexOf(state.view)>=0)renderCurrent();},15000);}

  root.QuantLabUI={init:init,setTab:setTab,selectGame:selectGame,openGame:openGame,enterBallpark:enterBallpark,setSlateFilter:setSlateFilter,setSlateSort:setSlateSort,toggleModelFeature:toggleModelFeature,openLegacy:openLegacy,setCamera:setCamera,toggleOverlay:toggleOverlay,setQuality:setQuality,loadPitches:loadPitches,exportSnapshots:exportSnapshots,syncSettings:syncSettings,render:renderCurrent};
  init();
})(typeof window !== "undefined" ? window : globalThis);
