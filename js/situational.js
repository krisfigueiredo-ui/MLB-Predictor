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
  currentStreak: currentStreak,
  teamSituationalContribution: teamSituationalContribution,
  gameSituationalCore: gameSituationalCore
};

});
