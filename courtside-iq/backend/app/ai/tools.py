"""Read-only, structured tools exposed to Claude. Each returns data plus `citations` that
point at concrete database records (table, id, timestamp). No tool writes to the database."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .. import models as m
from ..services import diagnostics, market, modeling, performance, trends
from . import rag

TOOLS = [
    dict(name="search_documents", description="Semantic search over methodology docs, model cards and indexed notes. Use for 'how does the model work' questions.",
         input_schema=dict(type="object", properties=dict(query=dict(type="string"), k=dict(type="integer")), required=["query"], additionalProperties=False)),
    dict(name="find_games", description="List games by date (YYYY-MM-DD, UTC), league (NBA/CBB) and optional team text. Returns ids, teams, status, scores.",
         input_schema=dict(type="object", properties=dict(date=dict(type="string"), league=dict(type="string"), team=dict(type="string"),
                                                          days=dict(type="integer")), additionalProperties=False)),
    dict(name="get_game_projection", description="Model projection for a game id: projected score/spread/total, simulation probabilities, market comparison, and SHAP drivers.",
         input_schema=dict(type="object", properties=dict(game_id=dict(type="integer")), required=["game_id"], additionalProperties=False)),
    dict(name="get_odds_movement", description="Opening/current lines and timestamped snapshot history for a game id.",
         input_schema=dict(type="object", properties=dict(game_id=dict(type="integer")), required=["game_id"], additionalProperties=False)),
    dict(name="league_efficiency_table", description="Season-to-date offensive/defensive efficiency, net rating and pace for every team in NBA or CBB.",
         input_schema=dict(type="object", properties=dict(league=dict(type="string"), sort_by=dict(type="string"), limit=dict(type="integer")),
                           required=["league"], additionalProperties=False)),
    dict(name="player_trends", description="A player's rolling averages (last 5/10/20), usage, minutes, splits and prop history. Accepts player name.",
         input_schema=dict(type="object", properties=dict(player=dict(type="string")), required=["player"], additionalProperties=False)),
    dict(name="model_performance", description="Accuracy of settled pre-game predictions: totals, by market, calibration, Brier/log loss, optional breakdown by team/player/conference/market.",
         input_schema=dict(type="object", properties=dict(league=dict(type="string"), breakdown=dict(type="string")), additionalProperties=False)),
    dict(name="largest_market_disagreements", description="Upcoming games where the model's spread or total differs most from the market consensus.",
         input_schema=dict(type="object", properties=dict(league=dict(type="string"), limit=dict(type="integer")), additionalProperties=False)),
    dict(name="model_diagnostics", description="Aggregated error analysis: pace/total bias, margin bias, calibration by market, minutes errors, conference errors.",
         input_schema=dict(type="object", properties=dict(league=dict(type="string")), additionalProperties=False)),
    dict(name="recent_results", description="Recently settled predictions with outcome (e.g. what the model got wrong yesterday). days default 1.",
         input_schema=dict(type="object", properties=dict(days=dict(type="integer"), league=dict(type="string"), only_misses=dict(type="boolean")),
                           additionalProperties=False)),
]


def _cite(table: str, rid, ts=None, label: str | None = None) -> dict:
    return dict(table=table, id=rid, timestamp=ts.isoformat() if hasattr(ts, "isoformat") else ts, label=label)


def run(db: Session, name: str, args: dict) -> dict:
    fn = HANDLERS.get(name)
    if fn is None:
        return dict(error=f"unknown tool {name}")
    try:
        return fn(db, **args)
    except TypeError as exc:
        return dict(error=f"bad arguments: {exc}")


def t_search(db, query, k=5):
    docs = rag.search(db, query, k=k)
    return dict(results=docs, citations=[_cite("ai_documents", d["id"], d["indexed_at"], d["title"]) for d in docs])


def t_find_games(db, date=None, league=None, team=None, days=1):
    d0 = datetime.fromisoformat(date).replace(tzinfo=timezone.utc) if date else datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    q = select(m.Game).where(m.Game.start_time >= d0, m.Game.start_time < d0 + timedelta(days=max(1, days or 1)), m.Game.is_historical_sim.is_(False))
    if league:
        q = q.where(m.Game.league == league.upper())
    games = db.scalars(q.order_by(m.Game.start_time).limit(200)).all()
    out = []
    for g in games:
        name = f"{g.away_team.display_name} @ {g.home_team.display_name}"
        if team and team.lower() not in name.lower() and team.upper() not in (g.home_team.abbreviation, g.away_team.abbreviation):
            continue
        out.append(dict(game_id=g.id, league=g.league, start_time=g.start_time.isoformat(), matchup=name, status=g.status,
                        score=f"{g.away_score}-{g.home_score}" if g.home_score is not None else None, is_demo=g.is_demo, source=g.source))
    return dict(games=out[:60], citations=[_cite("games", x["game_id"], x["start_time"], x["matchup"]) for x in out[:60]])


def t_projection(db, game_id):
    g = db.get(m.Game, game_id)
    if g is None:
        return dict(error="game not found")
    p = modeling.project_game(db, g)
    if p is None:
        return dict(error="no active model for this league")
    p.pop("features", None)
    for k in ("margin_hist", "total_hist"):
        p["simulation"].pop(k, None)
    p["matchup"] = f"{g.away_team.display_name} @ {g.home_team.display_name}"
    p["is_demo"] = g.is_demo
    mv = modeling.active_version(db, g.league)
    cites = [_cite("games", g.id, g.start_time, p["matchup"]), _cite("model_versions", mv.id, mv.trained_at, mv.version)]
    if p["market"].get("captured_at"):
        cites.append(_cite("odds_snapshots", f"game:{g.id}", p["market"]["captured_at"], "latest consensus snapshot"))
    p["market"].pop("by_book", None)
    return dict(projection=p, citations=cites)


def t_movement(db, game_id):
    mv = market.movement(db, game_id)
    return dict(summary=mv["summary"], n_snapshots=mv["n"], citations=[_cite("odds_snapshots", f"game:{game_id}", None, f"{mv['n']} snapshots")])


def t_league_table(db, league, sort_by="net", limit=15):
    rows = trends.league_table(db, league.upper())
    key = sort_by if rows and sort_by in rows[0] else "net"
    rows = sorted(rows, key=lambda r: -r[key])[: limit or 15]
    return dict(rows=rows, sorted_by=key, citations=[_cite("team_game_stats", f"season:{rows[0]['season']}" if rows else None, None, f"{league} season aggregates")])


def t_player(db, player):
    p = db.scalar(select(m.Player).where(m.Player.full_name.ilike(f"%{player}%")))
    if p is None:
        return dict(error=f"no player matching '{player}'")
    tr = trends.player_trends(db, p.id)
    tr.pop("games", None)
    tr["prop_history"] = tr["prop_history"][:15]
    rm = db.scalar(select(m.RosterMembership).where(m.RosterMembership.player_id == p.id, m.RosterMembership.end_date.is_(None)))
    tr["player"] = dict(id=p.id, name=p.full_name, team=rm.team.display_name if rm else None, roster_verified=rm.verified if rm else None)
    return dict(trends=tr, citations=[_cite("players", p.id, None, p.full_name), _cite("player_game_stats", f"player:{p.id}", None, "game logs")])


def t_performance(db, league=None, breakdown=None):
    s = performance.summary(db, league.upper() if league else None)
    s.pop("rolling", None)
    s.pop("cumulative_units", None)
    out = dict(summary=s)
    if breakdown:
        out["breakdown"] = performance.breakdown(db, breakdown, league.upper() if league else None)[:25]
    return dict(**out, citations=[_cite("predictions", "official_pregame", None, "settled pre-game predictions")])


def t_disagree(db, league=None, limit=8):
    now = datetime.now(timezone.utc)
    q = select(m.Game).where(m.Game.status == "scheduled", m.Game.start_time >= now, m.Game.start_time < now + timedelta(hours=36))
    if league:
        q = q.where(m.Game.league == league.upper())
    rows = []
    for g in db.scalars(q.limit(80)):
        p = modeling.project_game(db, g, n_sims=3000, explain=False)
        if not p:
            continue
        vs = p["vs_market"]
        rows.append(dict(game_id=g.id, matchup=f"{g.away_team.abbreviation} @ {g.home_team.abbreviation}", start_time=g.start_time.isoformat(),
                         spread_diff=vs.get("spread", {}).get("line_diff"), market_spread=vs.get("spread", {}).get("market_line_home"),
                         model_spread=p["projected"]["spread_home"], total_diff=vs.get("total", {}).get("line_diff"),
                         market_total=vs.get("total", {}).get("market_line"), model_total=p["projected"]["total"], is_demo=g.is_demo))
    rows.sort(key=lambda r: -max(abs(r["spread_diff"] or 0), abs(r["total_diff"] or 0)))
    rows = rows[: limit or 8]
    return dict(games=rows, citations=[_cite("games", r["game_id"], r["start_time"], r["matchup"]) for r in rows])


def t_diag(db, league=None):
    return dict(diagnostics=diagnostics.analyze(db, league.upper() if league else None),
                citations=[_cite("predictions", "settled", None, "diagnostics over settled predictions")])


def t_recent(db, days=1, league=None, only_misses=False):
    since = datetime.now(timezone.utc) - timedelta(days=days or 1, hours=6)
    df = performance.official_predictions(db, league.upper() if league else None)
    if df.empty:
        return dict(results=[], citations=[])
    df = df[df["start_time"] >= since]
    if only_misses:
        df = df[df["result"] == "loss"]
    df = df.sort_values("start_time", ascending=False).head(40)
    rows = [dict(prediction_id=r.id, game=f"{r.away} @ {r.home}", market=r.market, selection=r.selection, line=r.line,
                 prob=round(r.predicted_prob, 3), projection=r.predicted_value, actual=r.actual_value, result=r.result,
                 player=r.player, model=r.model_version, is_demo=r.is_demo) for r in df.itertuples()]
    return dict(results=rows, citations=[_cite("predictions", r["prediction_id"], None, f"{r['game']} {r['market']}") for r in rows[:20]])


HANDLERS = dict(search_documents=t_search, find_games=t_find_games, get_game_projection=t_projection, get_odds_movement=t_movement,
                league_efficiency_table=t_league_table, player_trends=t_player, model_performance=t_performance,
                largest_market_disagreements=t_disagree, model_diagnostics=t_diag, recent_results=t_recent)
