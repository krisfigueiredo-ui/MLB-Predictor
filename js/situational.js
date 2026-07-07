// Situational-trend math: recent form / streaks / home-road splits computed
// from a team's own chronological game log. Pulled out of the inline script
// so the note-generation and capped-adjustment logic is unit testable without
// needing the localStorage-backed backtest store (teamGameLog's job, which
// stays inline as thin IO glue around this).
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

function recOf(gs) {
  var w = gs.filter(function(g) { return g.won; }).length;
  return { w: w, l: gs.length - w, n: gs.length };
}

// Point-in-time filter: keep only games strictly before `beforeDate`
// ("YYYYMMDD", lexicographically comparable). Used so grading a historical
// game only sees what had actually happened by then, not future results a
// naive "current game log" lookup would otherwise leak in. No-op if
// beforeDate is falsy.
function filterBeforeDate(games, beforeDate) {
  if (!beforeDate) return games;
  return games.filter(function(g) { return (g.d || "") < beforeDate; });
}

// Exponentially-recency-weighted run-differential form score in [-1, 1], from
// a team's chronological game log. Needs >=4 games of history, else neutral
// (0). Blowouts are clipped per-game so one 14-run night can't dominate.
function recencyFormCore(log) {
  if (!log || log.length < 4) return 0;
  var recent = log.slice(-10), lambda = 0.80, wsum = 0, vsum = 0;
  for (var i = recent.length - 1, k = 0; i >= 0; i--, k++) {
    var w = Math.pow(lambda, k);
    var nd = recent[i].rs - recent[i].ra;
    vsum += w * Math.max(-6, Math.min(6, nd));
    wsum += w;
  }
  var avg = wsum > 0 ? vsum / wsum : 0;
  return Math.max(-1, Math.min(1, avg / 3.5)); // ~3.5-run weighted avg diff -> ~1.0
}

// Signed length of the CURRENT active win/loss streak (positive = winning,
// negative = losing), walking back from the most recent game in `log`.
function currentStreak(log) {
  var streak = 0;
  for (var i = log.length - 1; i >= 0; i--) {
    if (i === log.length - 1) { streak = log[i].won ? 1 : -1; }
    else {
      if ((log[i].won ? 1 : -1) === (streak > 0 ? 1 : -1)) streak += (streak > 0 ? 1 : -1);
      else break;
    }
  }
  return streak;
}

// Situational notes + home-prob nudge contributed by ONE team's game log.
// side: +1 if this team is home tonight, -1 if away. atHome: are they playing
// at home tonight (used to pick the right home/road split to check).
function teamSituationalContribution(log, team, side, atHome) {
  var notes = [], adj = 0;
  if (log.length < 6) return { notes: notes, adj: adj };

  // 1) Recent form (last 6 games): record + run differential
  var l6 = log.slice(-6), rec = recOf(l6), rd = l6.reduce(function(s, g) { return s + (g.rs - g.ra); }, 0);
  if (rec.w >= 5 || rd >= 10) {
    notes.push({ text: team + " hot lately: " + rec.w + "-" + rec.l + ", " + (rd >= 0 ? "+" : "") + rd + " run diff over last " + l6.length, signal: "real", lean: side });
    adj += side * 0.018;
  } else if (rec.l >= 5 || rd <= -10) {
    notes.push({ text: team + " cold lately: " + rec.w + "-" + rec.l + ", " + rd + " run diff over last " + l6.length, signal: "real", lean: -side });
    adj += -side * 0.018;
  }

  // 2) Active win/loss streak (>=4 games)
  var streak = currentStreak(log);
  if (Math.abs(streak) >= 4) {
    notes.push({ text: team + " on a " + Math.abs(streak) + "-game " + (streak > 0 ? "win" : "losing") + " streak", signal: "real", lean: streak > 0 ? side : -side });
    adj += (streak > 0 ? side : -side) * 0.010;
  }

  // 3) Home/road split for the side they actually play tonight
  var venueGames = log.filter(function(g) { return g.h === atHome; });
  if (venueGames.length >= 8) {
    var vr = recOf(venueGames), wp = vr.w / vr.n, venue = atHome ? "at home" : "on the road";
    if (wp >= 0.60) {
      notes.push({ text: team + " strong " + venue + ": " + vr.w + "-" + vr.l + " (" + Math.round(wp * 100) + "%)", signal: "real", lean: side });
      adj += side * 0.012;
    } else if (wp <= 0.40) {
      notes.push({ text: team + " weak " + venue + ": " + vr.w + "-" + vr.l + " (" + Math.round(wp * 100) + "%)", signal: "real", lean: -side });
      adj += -side * 0.012;
    }
  }

  return { notes: notes, adj: adj };
}

// Combine both teams' contributions into the final capped nudge (hard cap:
// situational trends alone can never move a prediction by more than +/-5%).
function gameSituationalCore(homeLog, awayLog, home, away) {
  var h = teamSituationalContribution(homeLog, home, 1, true);
  var a = teamSituationalContribution(awayLog, away, -1, false);
  var adj = Math.max(-0.05, Math.min(0.05, h.adj + a.adj));
  return { notes: h.notes.concat(a.notes), adj: adj };
}

return {
  recOf: recOf,
  filterBeforeDate: filterBeforeDate,
  recencyFormCore: recencyFormCore,
  currentStreak: currentStreak,
  teamSituationalContribution: teamSituationalContribution,
  gameSituationalCore: gameSituationalCore
};

});
