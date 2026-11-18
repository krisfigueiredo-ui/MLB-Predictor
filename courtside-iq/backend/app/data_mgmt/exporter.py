"""Exports (CSV / XLSX / JSON). XLSX uses styled header rows, frozen panes, number formats
and auto-widths, plus a README sheet stating source, timestamp and licensing caveats."""
from __future__ import annotations

import io
import json
from datetime import datetime, timezone

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from ..services import performance, trends

LICENSE_NOTE = ("Provider-sourced data (scores, odds, statistics) may be subject to the provider's redistribution terms. "
                "Rows marked is_demo=True are synthetic demo data and are not real results or real sportsbook prices.")

DATASETS = ["predictions", "picks", "odds", "games", "team_stats", "player_stats", "teams", "accuracy", "diagnostics", "league_table", "cleaned_import"]


def frame(db: Session, name: str, league: str | None = None, dataset_id: int | None = None) -> pd.DataFrame:
    teams = {t.id: t for t in db.scalars(select(m.Team))}
    if name == "predictions":
        df = performance.official_predictions(db, league, include_pending=True)
        return df.drop(columns=[c for c in ("home_team_id", "away_team_id") if c in df.columns]) if not df.empty else df
    if name == "picks":
        return pd.DataFrame([{c.name: getattr(p, c.name) for c in m.UserPick.__table__.columns} for p in db.scalars(select(m.UserPick))])
    if name == "odds":
        q = select(m.OddsSnapshot, m.Game, m.Sportsbook).join(m.Game).join(m.Sportsbook)
        if league:
            q = q.where(m.Game.league == league)
        q = q.where(m.Game.is_historical_sim.is_(False)).order_by(m.OddsSnapshot.captured_at.desc()).limit(50000)
        return pd.DataFrame([dict(captured_at=s.captured_at, league=g.league, game_id=g.id, home=teams[g.home_team_id].abbreviation,
                                  away=teams[g.away_team_id].abbreviation, sportsbook=b.name, market=s.market, outcome=s.outcome,
                                  line=s.line, price=s.price_american, source=s.source, is_demo=s.is_demo) for s, g, b in db.execute(q).all()])
    if name == "games":
        q = select(m.Game).where(m.Game.is_historical_sim.is_(False))
        if league:
            q = q.where(m.Game.league == league)
        return pd.DataFrame([dict(id=g.id, league=g.league, season=g.season, start_time=g.start_time, home=teams[g.home_team_id].display_name,
                                  away=teams[g.away_team_id].display_name, status=g.status, home_score=g.home_score, away_score=g.away_score,
                                  home_h1=g.home_h1, away_h1=g.away_h1, neutral=g.neutral_site, source=g.source, is_demo=g.is_demo)
                             for g in db.scalars(q.order_by(m.Game.start_time))])
    if name == "team_stats":
        q = select(m.TeamGameStat, m.Game).join(m.Game).where(m.Game.is_historical_sim.is_(False))
        if league:
            q = q.where(m.Game.league == league)
        return pd.DataFrame([dict(game_id=g.id, date=g.start_time, team=teams[s.team_id].abbreviation, is_home=s.is_home,
                                  **{c: getattr(s, c) for c in ("points", "h1_points", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "tov", "possessions")},
                                  is_demo=g.is_demo) for s, g in db.execute(q).all()])
    if name == "player_stats":
        players = {p.id: p.full_name for p in db.scalars(select(m.Player))}
        q = select(m.PlayerGameStat, m.Game).join(m.Game).where(m.Game.is_historical_sim.is_(False))
        return pd.DataFrame([dict(game_id=g.id, date=g.start_time, player=players[s.player_id], team=teams[s.team_id].abbreviation,
                                  **{c: getattr(s, c) for c in ("minutes", "pts", "reb", "ast", "fg3m", "fg3a", "fga", "fta", "stl", "blk", "tov")},
                                  is_demo=g.is_demo) for s, g in db.execute(q).all()])
    if name == "teams":
        confs = {c.id: c.short_name for c in db.scalars(select(m.Conference))}
        return pd.DataFrame([dict(id=t.id, league=t.league, name=t.display_name, abbr=t.abbreviation, conference=confs.get(t.conference_id),
                                  primary_color=t.primary_color, secondary_color=t.secondary_color, venue=t.venue) for t in teams.values()
                             if not league or t.league == league])
    if name == "accuracy":
        s = performance.summary(db, league)
        rows = [dict(scope="total", **s["total"])] + [dict(scope=f"market:{k}", **v) for k, v in s.get("by_market_detail", {}).items()]
        return pd.DataFrame(rows)
    if name == "diagnostics":
        from ..services import diagnostics

        return pd.DataFrame(diagnostics.analyze(db, league)["findings"])
    if name == "league_table":
        return pd.DataFrame(trends.league_table(db, league or "NBA"))
    if name == "cleaned_import":
        recs = db.scalars(select(m.ImportRecord).where(m.ImportRecord.dataset_id == dataset_id)).all()
        return pd.DataFrame([dict(row=r.row_index, status=r.status, issues="; ".join(i["msg"] for i in r.issues), **(r.cleaned or {})) for r in recs])
    raise ValueError(f"unknown dataset {name}")


def _strip_tz(df: pd.DataFrame) -> pd.DataFrame:
    """Excel cannot store timezone-aware datetimes: convert to naive UTC."""
    df = df.copy()
    for c in df.columns:
        if isinstance(df[c].dtype, pd.DatetimeTZDtype):
            df[c] = df[c].dt.tz_convert("UTC").dt.tz_localize(None)
        elif df[c].dtype == object:
            df[c] = df[c].map(lambda x: x.astimezone(timezone.utc).replace(tzinfo=None) if isinstance(x, datetime) and x.tzinfo else x)
    return df


def render(df: pd.DataFrame, fmt: str, name: str) -> tuple[bytes, str]:
    if fmt == "csv":
        return df.to_csv(index=False).encode(), "text/csv"
    if fmt == "json":
        return json.dumps(dict(dataset=name, exported_at=datetime.now(timezone.utc).isoformat(), license=LICENSE_NOTE,
                               rows=json.loads(df.to_json(orient="records", date_format="iso"))), indent=1).encode(), "application/json"
    if fmt == "xlsx":
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter

        buf = io.BytesIO()
        df = _strip_tz(df)
        with pd.ExcelWriter(buf, engine="openpyxl") as xw:
            df.to_excel(xw, sheet_name=name[:31], index=False)
            ws = xw.sheets[name[:31]]
            head = PatternFill("solid", fgColor="0B1E3B")
            for cell in ws[1]:
                cell.font = Font(bold=True, color="FFFFFF")
                cell.fill = head
                cell.alignment = Alignment(horizontal="center", vertical="center")
            ws.freeze_panes = "A2"
            ws.auto_filter.ref = ws.dimensions
            for i, col in enumerate(df.columns, 1):
                width = min(48, max(10, len(str(col)) + 2, *(len(str(v)) + 2 for v in df[col].head(200).tolist())))
                ws.column_dimensions[get_column_letter(i)].width = width
                lc = str(col).lower()
                fmtc = "0.0%" if any(k in lc for k in ("prob", "pct", "win_pct", "roi")) else "0.000" if any(k in lc for k in ("brier", "log_loss", "ece")) else None
                if fmtc:
                    for row in ws.iter_rows(min_row=2, min_col=i, max_col=i):
                        for c in row:
                            c.number_format = fmtc
            meta = xw.book.create_sheet("README")
            meta.append(["COURTSIDE IQ export"])
            meta.append(["Dataset", name])
            meta.append(["Exported at (UTC)", datetime.now(timezone.utc).isoformat()])
            meta.append(["Rows", len(df)])
            meta.append(["Licensing", LICENSE_NOTE])
            meta["A1"].font = Font(bold=True, size=14)
            meta.column_dimensions["A"].width = 22
            meta.column_dimensions["B"].width = 110
        return buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    raise ValueError("format must be csv, xlsx or json")
