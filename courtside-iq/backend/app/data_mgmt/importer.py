"""Import pipeline: parse → detect schema → map columns → clean → validate → preview →
(approve) → commit. Raw bytes are preserved; every decision is logged in `cleaning_log`.
Unresolved rows are quarantined, never silently dropped; destructive corrections need approval.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from ..providers.sync import TeamMatcher, norm

RAW_DIR = Path(__file__).resolve().parents[2] / "data" / "raw"

SCHEMAS: dict[str, dict] = {
    "games": dict(required=["date", "home_team", "away_team", "home_score", "away_score"],
                  optional=["league", "season", "neutral", "home_h1", "away_h1", "home_fga", "home_fgm", "home_fg3a",
                            "home_fg3m", "home_fta", "home_ftm", "home_oreb", "home_dreb", "home_tov", "away_fga", "away_fgm",
                            "away_fg3a", "away_fg3m", "away_fta", "away_ftm", "away_oreb", "away_dreb", "away_tov"]),
    "player_stats": dict(required=["date", "player", "team", "minutes", "pts"],
                         optional=["league", "opponent", "reb", "ast", "fg3m", "fg3a", "fga", "fta", "stl", "blk", "tov"]),
    "odds": dict(required=["captured_at", "home_team", "away_team", "sportsbook", "market", "outcome", "price"],
                 optional=["league", "line", "game_date"]),
    "picks": dict(required=["date", "description", "market", "selection"],
                  optional=["league", "line", "sportsbook", "price", "stake_units", "status", "notes", "predicted_outcome"]),
    "predictions": dict(required=["date", "home_team", "away_team", "market", "selection", "probability"],
                        optional=["league", "line", "price", "predicted_value", "result", "model"]),
}

SYNONYMS = {
    "date": ["date", "game_date", "gamedate", "game_day", "day", "start_time", "commence_time", "datetime", "pick_date"],
    "home_team": ["home_team", "home", "hometeam", "team_home", "home_name", "h_team"],
    "away_team": ["away_team", "away", "visitor", "visitor_team", "awayteam", "road_team", "visiting_team", "v_team"],
    "home_score": ["home_score", "home_pts", "home_points", "pts_home", "hscore", "home_final"],
    "away_score": ["away_score", "away_pts", "away_points", "visitor_score", "visitor_pts", "pts_away", "ascore", "away_final"],
    "home_h1": ["home_h1", "home_1h", "home_first_half", "h1_home"],
    "away_h1": ["away_h1", "away_1h", "away_first_half", "h1_away"],
    "league": ["league", "sport", "competition", "level"],
    "season": ["season", "season_year"],
    "neutral": ["neutral", "neutral_site", "is_neutral"],
    "player": ["player", "player_name", "name", "athlete", "full_name"],
    "team": ["team", "team_name", "tm", "school", "team_abbr"],
    "opponent": ["opponent", "opp", "vs", "opp_team"],
    "minutes": ["minutes", "min", "mins", "mp"],
    "pts": ["pts", "points", "p"],
    "reb": ["reb", "rebounds", "trb", "tot_reb"],
    "ast": ["ast", "assists", "a"],
    "fg3m": ["fg3m", "3pm", "threes", "3p", "three_pointers_made", "tpm"],
    "fg3a": ["fg3a", "3pa", "three_point_attempts"],
    "fga": ["fga", "field_goal_attempts"], "fta": ["fta", "free_throw_attempts"],
    "stl": ["stl", "steals", "s"], "blk": ["blk", "blocks", "b"], "tov": ["tov", "to", "turnovers"],
    "captured_at": ["captured_at", "timestamp", "snapshot_time", "last_update", "odds_time", "time"],
    "sportsbook": ["sportsbook", "book", "bookmaker", "site"],
    "market": ["market", "bet_type", "market_type", "wager_type", "type"],
    "outcome": ["outcome", "side", "selection_side"],
    "selection": ["selection", "pick", "bet", "side", "choice"],
    "price": ["price", "odds", "american_odds", "line_price", "moneyline", "juice"],
    "line": ["line", "point", "points_line", "spread", "total", "handicap", "number"],
    "probability": ["probability", "prob", "win_prob", "predicted_prob", "confidence", "model_prob"],
    "predicted_value": ["predicted_value", "projection", "proj", "model_line"],
    "result": ["result", "outcome_result", "grade"],
    "status": ["status", "result", "grade"],
    "stake_units": ["stake_units", "units", "stake", "risk"],
    "notes": ["notes", "confidence_notes", "comment", "comments", "reason"],
    "description": ["description", "game", "matchup", "event", "desc"],
    "model": ["model", "model_version", "source_model"],
    "game_date": ["game_date", "event_date"],
    "predicted_outcome": ["predicted_outcome", "expected"],
}
for side in ("home", "away"):
    for k in ("fga", "fgm", "fg3a", "fg3m", "fta", "ftm", "oreb", "dreb", "tov"):
        SYNONYMS[f"{side}_{k}"] = [f"{side}_{k}", f"{k}_{side}"]

NUMERIC = {"home_score", "away_score", "home_h1", "away_h1", "minutes", "pts", "reb", "ast", "fg3m", "fg3a", "fga", "fta", "stl",
           "blk", "tov", "price", "line", "probability", "predicted_value", "stake_units"} | {
    f"{s}_{k}" for s in ("home", "away") for k in ("fga", "fgm", "fg3a", "fg3m", "fta", "ftm", "oreb", "dreb", "tov")}
SCORE_LIMITS = {"NBA": (50, 200), "CBB": (20, 150)}


def snake(c: str) -> str:
    c = re.sub(r"([a-z])([A-Z])", r"\1_\2", str(c)).strip().lower()
    c = c.replace("%", "pct").replace("#", "num").replace("3", "3")
    return re.sub(r"[^a-z0-9]+", "_", c).strip("_")


def parse_file(filename: str, content: bytes) -> pd.DataFrame:
    ext = filename.lower().rsplit(".", 1)[-1]
    if ext == "csv":
        return pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
    if ext in ("xlsx", "xlsm"):
        return pd.read_excel(io.BytesIO(content), dtype=str).fillna("")
    if ext == "json":
        data = json.loads(content.decode("utf-8"))
        if isinstance(data, dict):
            data = data.get("data") or data.get("records") or next((v for v in data.values() if isinstance(v, list)), [data])
        return pd.DataFrame(data).astype(str).replace({"None": "", "nan": ""})
    raise ValueError(f"unsupported file type .{ext}; use CSV, XLSX or JSON")


def detect_mapping(columns: list[str], kind: str | None = None) -> tuple[str, dict, dict]:
    cols = {snake(c): c for c in columns}
    best = None
    for k, sch in SCHEMAS.items():
        if kind and k != kind:
            continue
        mapping, used = {}, set()
        for canon in sch["required"] + sch["optional"]:
            for syn in SYNONYMS.get(canon, [canon]):
                if syn in cols and cols[syn] not in used:
                    mapping[canon] = cols[syn]
                    used.add(cols[syn])
                    break
        cov = sum(c in mapping for c in sch["required"]) / len(sch["required"])
        score = cov + 0.01 * len(mapping)
        if best is None or score > best[0]:
            best = (score, k, mapping, cov)
    _, k, mapping, cov = best
    missing = [c for c in SCHEMAS[k]["required"] if c not in mapping]
    unmapped = [c for c in columns if c not in mapping.values()]
    return k, mapping, dict(coverage=cov, missing_required=missing, unmapped=unmapped)


def _num(v: str):
    s = str(v).strip().replace(",", "").replace("$", "")
    if s in ("", "-", "na", "n/a", "null", "none", "nan"):
        return None, None
    pct = s.endswith("%")
    s = s.rstrip("%")
    if s.lower() in ("pk", "pick", "even", "ev"):
        return 0.0 if s.lower() in ("pk", "pick") else 100.0, f"'{v}' interpreted as {'0' if s.lower() in ('pk', 'pick') else '+100'}"
    try:
        x = float(s.replace("+", "")) if s not in ("+",) else None
    except ValueError:
        return None, f"'{v}' is not numeric"
    return (x / 100 if pct else x), ("percent string converted to fraction" if pct else None)


def _date(v: str, tz: str):
    s = str(v).strip()
    if not s:
        return None, "missing date"
    try:
        ts = pd.Timestamp(s)
    except Exception:
        try:
            ts = pd.to_datetime(s, dayfirst=False, errors="raise")
        except Exception:
            return None, f"unparseable date '{v}'"
    note = None
    if ts.tzinfo is None:
        ts = ts.tz_localize(ZoneInfo(tz))
        note = f"naive timestamp localized to {tz}"
    return ts.tz_convert("UTC").to_pydatetime(), note


def _league_guess(row: dict, default: str | None) -> str | None:
    lg = str(row.get("league", "") or "").strip().upper()
    if lg in ("NBA",):
        return "NBA"
    if lg in ("CBB", "NCAAB", "NCAAM", "NCAA", "COLLEGE", "MBB"):
        return "CBB"
    return default


def run_import(db: Session, filename: str, content: bytes, kind: str | None = None, league: str | None = None,
               timezone_name: str = "America/New_York", mapping_override: dict | None = None) -> m.ImportedDataset:
    sha = hashlib.sha256(content).hexdigest()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = RAW_DIR / f"{sha}_{Path(filename).name}"
    raw_path.write_bytes(content)  # preserve original bytes
    df = parse_file(filename, content)
    k, mapping, info = detect_mapping(list(df.columns), kind)
    if mapping_override:
        mapping.update(mapping_override)
        info["missing_required"] = [c for c in SCHEMAS[k]["required"] if c not in mapping]
    ds = m.ImportedDataset(filename=filename, kind=k, raw_path=str(raw_path), raw_sha256=sha, n_rows=len(df),
                           column_mapping=dict(mapping=mapping, **info, timezone=timezone_name, league=league))
    db.add(ds)
    db.flush()
    logs: list[m.CleaningLog] = []

    def log(row, field, action, before=None, after=None, destructive=False):
        logs.append(m.CleaningLog(dataset_id=ds.id, row_index=row, field=field, action=action,
                                  before=None if before is None else str(before)[:300],
                                  after=None if after is None else str(after)[:300], destructive=destructive))

    for canon, src in mapping.items():
        if snake(src) != canon:
            log(None, canon, "column_mapped", src, canon)
    matchers = {lg: TeamMatcher(db, lg) for lg in ("NBA", "CBB")}
    players = {norm(p.full_name): p for p in db.scalars(select(m.Player))}
    current_team = {rm.player_id: rm.team_id for rm in db.scalars(select(m.RosterMembership).where(m.RosterMembership.end_date.is_(None)))}
    records, seen = [], {}
    counts = dict(missing=0, outliers=0, invalid_scores=0, prob_range=0, odds_after_start=0, affiliation=0, dup=0, type_fixes=0)
    missing_by_col = {c: 0 for c in mapping}
    for i, raw in enumerate(df.to_dict("records")):
        row = {canon: raw.get(src, "") for canon, src in mapping.items()}
        issues, clean = [], {}
        status = "valid"
        for canon, v in row.items():
            if str(v).strip() == "":
                missing_by_col[canon] += 1
            if canon in NUMERIC:
                x, note = _num(v)
                if note and "not numeric" in note:
                    issues.append(dict(field=canon, severity="error", msg=note))
                elif note:
                    counts["type_fixes"] += 1
                    log(i, canon, "type_coerced", v, x)
                clean[canon] = x
            elif canon in ("date", "captured_at", "game_date"):
                d, note = _date(v, timezone_name)
                if d is None and canon in SCHEMAS[k]["required"]:
                    issues.append(dict(field=canon, severity="error", msg=note))
                elif note:
                    log(i, canon, "timezone_standardized", v, d.isoformat() if d else None)
                clean[canon] = d.isoformat() if d else None
            else:
                clean[canon] = str(v).strip()
        for req in SCHEMAS[k]["required"]:
            if clean.get(req) in (None, ""):
                counts["missing"] += 1
                issues.append(dict(field=req, severity="error", msg="required value missing"))
        lg = _league_guess(clean, league)
        clean["league"] = lg
        # entity resolution
        for fld in ("home_team", "away_team", "team", "opponent"):
            if clean.get(fld):
                cands = [lg] if lg else ["NBA", "CBB"]
                t = next((matchers[c].match(clean[fld], clean[fld]) for c in cands if matchers[c].match(clean[fld], clean[fld])), None)
                if t is None:
                    issues.append(dict(field=fld, severity="error", msg=f"unknown team/school '{clean[fld]}'"))
                else:
                    if not lg:
                        clean["league"] = lg = t.league
                    clean[f"{fld}_id"] = t.id
                    if norm(clean[fld]) != norm(t.display_name):
                        log(i, fld, "entity_matched", clean[fld], f"{t.display_name} (id {t.id})")
        if clean.get("player"):
            p = players.get(norm(clean["player"]))
            if p is None:
                issues.append(dict(field="player", severity="warning", msg=f"player '{clean['player']}' not in registry (will be created on commit)"))
            else:
                clean["player_id"] = p.id
                if clean.get("team_id") and current_team.get(p.id) and current_team[p.id] != clean["team_id"]:
                    counts["affiliation"] += 1
                    issues.append(dict(field="team", severity="warning",
                                       msg="player-team affiliation differs from current roster (historical trade or data error)"))
        # validation
        if k == "games":
            lim = SCORE_LIMITS.get(lg or "NBA")
            for fld in ("home_score", "away_score"):
                x = clean.get(fld)
                if x is not None and (x < 0 or x != int(x) or x > lim[1]):
                    counts["invalid_scores"] += 1
                    issues.append(dict(field=fld, severity="error", msg=f"invalid score {x}"))
                elif x is not None and x < lim[0]:
                    counts["outliers"] += 1
                    issues.append(dict(field=fld, severity="warning", msg=f"unusually low score {x} for {lg}"))
            if clean.get("home_score") is not None and clean.get("home_score") == clean.get("away_score"):
                counts["invalid_scores"] += 1
                issues.append(dict(field="home_score", severity="error", msg="basketball games cannot end tied"))
            if clean.get("home_team_id") and clean.get("home_team_id") == clean.get("away_team_id"):
                issues.append(dict(field="away_team", severity="error", msg="team cannot play itself"))
        if k in ("predictions",) and clean.get("probability") is not None:
            p = clean["probability"]
            if 1 < p <= 100:
                log(i, "probability", "rescaled_percent", p, p / 100, destructive=True)
                issues.append(dict(field="probability", severity="warning", msg=f"probability {p} looks like a percent; proposed {p/100:.3f} (requires approval)"))
                clean["probability_proposed"] = p / 100
            elif not 0 <= p <= 1:
                counts["prob_range"] += 1
                issues.append(dict(field="probability", severity="error", msg=f"probability {p} outside [0,1]"))
        if clean.get("price") is not None and k in ("odds", "picks", "predictions"):
            pr = clean["price"]
            if -100 < pr < 100:
                if 1.01 <= pr <= 50:  # decimal odds supplied
                    from ..services.odds_math import decimal_to_american

                    am = decimal_to_american(pr)
                    log(i, "price", "decimal_to_american", pr, am)
                    clean["price"] = am
                else:
                    issues.append(dict(field="price", severity="error", msg=f"invalid American price {pr}"))
        if k == "odds" and clean.get("captured_at") and clean.get("game_date"):
            if clean["captured_at"] > clean["game_date"]:
                counts["odds_after_start"] += 1
                issues.append(dict(field="captured_at", severity="warning", msg="odds captured after game start (live/closing); excluded from pregame modelling"))
        if k == "player_stats":
            for fld, hi in (("minutes", 60), ("pts", 100), ("reb", 40), ("ast", 30)):
                x = clean.get(fld)
                if x is not None and (x < 0 or x > hi):
                    counts["outliers"] += 1
                    issues.append(dict(field=fld, severity="warning", msg=f"{fld}={x} outside plausible range"))
        # duplicates
        key_fields = {"games": ("date", "home_team_id", "away_team_id"), "player_stats": ("date", "player", "team_id"),
                      "odds": ("captured_at", "home_team_id", "away_team_id", "sportsbook", "market", "outcome"),
                      "picks": ("date", "description", "market", "selection"),
                      "predictions": ("date", "home_team_id", "away_team_id", "market", "selection")}[k]
        dkey = tuple(str(clean.get(f))[:10] if f == "date" else str(clean.get(f)) for f in key_fields)
        if dkey in seen:
            counts["dup"] += 1
            status = "duplicate"
            issues.append(dict(field="*", severity="warning", msg=f"duplicate of row {seen[dkey]} (will be skipped; requires approval)"))
            log(i, None, "drop_duplicate", f"row {i}", f"keep row {seen[dkey]}", destructive=True)
        else:
            seen[dkey] = i
            if k == "games" and clean.get("home_team_id") and clean.get("date"):
                d0 = pd.Timestamp(clean["date"])
                ex = db.scalar(select(m.Game.id).where(m.Game.home_team_id == clean["home_team_id"], m.Game.away_team_id == clean["away_team_id"],
                                                       m.Game.start_time.between(d0 - pd.Timedelta(hours=18), d0 + pd.Timedelta(hours=18)),
                                                       m.Game.is_demo.is_(False)))
                if ex:
                    counts["dup"] += 1
                    status = "duplicate"
                    issues.append(dict(field="*", severity="warning", msg=f"game already exists in database (id {ex})"))
        if status != "duplicate":
            if any(x["severity"] == "error" for x in issues):
                status = "quarantined"
            elif any("requires approval" in x["msg"] for x in issues):
                status = "quarantined"
        records.append(m.ImportRecord(dataset_id=ds.id, row_index=i, raw={kk: str(vv) for kk, vv in raw.items()},
                                      cleaned=_json_safe(clean), status=status, issues=issues))
    db.add_all(records)
    db.add_all(logs)
    n_valid = sum(r.status == "valid" for r in records)
    n_q = sum(r.status == "quarantined" for r in records)
    n_dup = sum(r.status == "duplicate" for r in records)
    ds.n_valid, ds.n_quarantined, ds.n_duplicates = n_valid, n_q, n_dup
    ds.n_rejected = 0
    total_cells = max(1, len(df) * max(1, len(mapping)))
    ds.scorecard = dict(
        kind=k, rows=len(df), valid=n_valid, quarantined=n_q, duplicates=n_dup, rejected=0,
        missingness={c: v / max(1, len(df)) for c, v in missing_by_col.items()},
        overall_missing=sum(missing_by_col.values()) / total_cells, warnings=sum(len(r.issues) for r in records),
        checks=counts, coverage=info["coverage"], missing_required_columns=info["missing_required"],
        quality_score=round(100 * (n_valid / max(1, len(df))) * (1 - 0.5 * sum(missing_by_col.values()) / total_cells), 1),
        destructive_pending=sum(1 for lg_ in logs if lg_.destructive),
    )
    for check, cnt in counts.items():
        db.add(m.ValidationResult(dataset_id=ds.id, check=check, severity="error" if check in ("invalid_scores", "prob_range") else "warning",
                                  count=cnt))
    db.commit()
    return ds


def _json_safe(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, (np.floating, np.integer)):
            v = v.item()
        out[k] = v
    return out


def approve(db: Session, ds: m.ImportedDataset, approve_destructive: bool, release_rows: list[int] | None = None) -> dict:
    """Approve proposed destructive corrections and/or release specific quarantined rows."""
    released = 0
    if approve_destructive:
        for lg in db.scalars(select(m.CleaningLog).where(m.CleaningLog.dataset_id == ds.id, m.CleaningLog.destructive.is_(True))):
            lg.approved = True
        for r in db.scalars(select(m.ImportRecord).where(m.ImportRecord.dataset_id == ds.id, m.ImportRecord.status == "quarantined")):
            if r.cleaned and "probability_proposed" in r.cleaned and not any(x["severity"] == "error" for x in r.issues):
                c = dict(r.cleaned)
                c["probability"] = c.pop("probability_proposed")
                r.cleaned, r.status = c, "valid"
                released += 1
    for idx in release_rows or []:
        r = db.scalar(select(m.ImportRecord).where(m.ImportRecord.dataset_id == ds.id, m.ImportRecord.row_index == idx))
        if r and r.status == "quarantined" and not any(x["severity"] == "error" for x in r.issues):
            r.status = "valid"
            released += 1
    ds.status = "approved"
    ds.approved_at = datetime.now(timezone.utc)
    ds.n_valid = db.query(m.ImportRecord).filter_by(dataset_id=ds.id, status="valid").count()
    ds.n_quarantined = db.query(m.ImportRecord).filter_by(dataset_id=ds.id, status="quarantined").count()
    db.commit()
    return dict(released=released, valid=ds.n_valid, quarantined=ds.n_quarantined)


def commit(db: Session, ds: m.ImportedDataset) -> dict:
    if ds.status == "committed":
        return dict(status="already committed")
    pending_destructive = db.query(m.CleaningLog).filter_by(dataset_id=ds.id, destructive=True, approved=False).count()
    if pending_destructive and ds.status != "approved":
        raise ValueError(f"{pending_destructive} destructive corrections await approval")
    src = f"import:{ds.filename}"
    n = 0
    recs = db.scalars(select(m.ImportRecord).where(m.ImportRecord.dataset_id == ds.id, m.ImportRecord.status == "valid")).all()
    for r in recs:
        c = r.cleaned
        if ds.kind == "games":
            start = datetime.fromisoformat(c["date"])
            season_y = start.year if start.month > 7 else start.year - 1
            g = m.Game(league=c["league"], season=c.get("season") or f"{season_y}-{str(season_y + 1)[-2:]}", start_time=start,
                       home_team_id=c["home_team_id"], away_team_id=c["away_team_id"],
                       neutral_site=str(c.get("neutral", "")).lower() in ("1", "true", "yes", "y"), status="final",
                       home_score=int(c["home_score"]), away_score=int(c["away_score"]),
                       home_h1=int(c["home_h1"]) if c.get("home_h1") is not None else None,
                       away_h1=int(c["away_h1"]) if c.get("away_h1") is not None else None, source=src, is_demo=False)
            db.add(g)
            db.flush()
            if all(c.get(f"{s}_{x}") is not None for s in ("home", "away") for x in ("fga", "fgm", "fg3m", "fta", "ftm", "oreb", "dreb", "tov")):
                for s, tid, home in (("home", g.home_team_id, True), ("away", g.away_team_id, False)):
                    poss = c[f"{s}_fga"] - c[f"{s}_oreb"] + c[f"{s}_tov"] + 0.44 * c[f"{s}_fta"]
                    db.add(m.TeamGameStat(game_id=g.id, team_id=tid, is_home=home, points=int(c[f"{s}_score"]),
                                          h1_points=int(c[f"{s}_h1"]) if c.get(f"{s}_h1") is not None else None,
                                          fgm=int(c[f"{s}_fgm"]), fga=int(c[f"{s}_fga"]), fg3m=int(c[f"{s}_fg3m"]),
                                          fg3a=int(c.get(f"{s}_fg3a") or 0), ftm=int(c[f"{s}_ftm"]), fta=int(c[f"{s}_fta"]),
                                          oreb=int(c[f"{s}_oreb"]), dreb=int(c[f"{s}_dreb"]), tov=int(c[f"{s}_tov"]), possessions=poss))
        elif ds.kind == "picks":
            db.add(m.UserPick(pick_date=datetime.fromisoformat(c["date"]).date(), league=c.get("league") or "NBA",
                              description=c["description"], market=c["market"].lower(), selection=c["selection"],
                              line=c.get("line"), sportsbook=c.get("sportsbook"), price_american=int(c["price"]) if c.get("price") else None,
                              stake_units=c.get("stake_units"), confidence_notes=c.get("notes"),
                              status=(c.get("status") or "pending").lower() if (c.get("status") or "pending").lower() in ("win", "loss", "push", "void", "pending") else "pending"))
        elif ds.kind == "odds":
            g = _find_game(db, c["home_team_id"], c["away_team_id"], c.get("game_date") or c["captured_at"])
            if g is None:
                continue
            book = db.scalar(select(m.Sportsbook).where(m.Sportsbook.name.ilike(c["sportsbook"]))) or db.scalar(
                select(m.Sportsbook).where(m.Sportsbook.key == norm(c["sportsbook"]).replace(" ", "")))
            if book is None:
                book = m.Sportsbook(key=norm(c["sportsbook"]).replace(" ", "_"), name=c["sportsbook"])
                db.add(book)
                db.flush()
            db.add(m.OddsSnapshot(game_id=g.id, sportsbook_id=book.id, market=c["market"].lower(), outcome=c["outcome"].lower(),
                                  line=c.get("line"), price_american=int(c["price"]), captured_at=datetime.fromisoformat(c["captured_at"]),
                                  source=src))
        elif ds.kind == "player_stats":
            g = _find_game_for_team(db, c.get("team_id"), c["date"])
            if g is None:
                continue
            pid = c.get("player_id")
            if pid is None:
                first, _, last = c["player"].partition(" ")
                p = m.Player(league=c.get("league") or "NBA", full_name=c["player"], first_name=first, last_name=last, provider_ids={"import": ds.id})
                db.add(p)
                db.flush()
                pid = p.id
            db.add(m.PlayerGameStat(game_id=g.id, player_id=pid, team_id=c["team_id"], minutes=c["minutes"] or 0,
                                    pts=int(c.get("pts") or 0), reb=int(c.get("reb") or 0), ast=int(c.get("ast") or 0),
                                    fg3m=int(c.get("fg3m") or 0), fg3a=int(c.get("fg3a") or 0), fga=int(c.get("fga") or 0),
                                    fta=int(c.get("fta") or 0), stl=int(c.get("stl") or 0), blk=int(c.get("blk") or 0),
                                    tov=int(c.get("tov") or 0)))
        elif ds.kind == "predictions":
            g = _find_game(db, c["home_team_id"], c["away_team_id"], c["date"])
            if g is None:
                continue
            mv = db.scalar(select(m.ModelVersion).where(m.ModelVersion.version == "external-import"))
            if mv is None:
                mv = m.ModelVersion(league=g.league, name="external", version="external-import", algorithm="imported external predictions",
                                    data_source="imported")
                db.add(mv)
                db.flush()
            res = (c.get("result") or "pending").lower()
            db.add(m.Prediction(league=g.league, game_id=g.id, model_version_id=mv.id, market=c["market"].lower(),
                                selection=c["selection"].lower(), predicted_prob=c["probability"], line=c.get("line"),
                                price_american=int(c["price"]) if c.get("price") else None, predicted_value=c.get("predicted_value"),
                                data_as_of=datetime.fromisoformat(c["date"]), details=dict(mode="imported", dataset=ds.id),
                                result=res if res in ("win", "loss", "push", "void") else "pending"))
        n += 1
    ds.status = "committed"
    db.commit()
    return dict(committed=n, kind=ds.kind)


def _find_game(db, home_id, away_id, when_iso):
    t = pd.Timestamp(when_iso)
    return db.scalar(select(m.Game).where(m.Game.home_team_id == home_id, m.Game.away_team_id == away_id,
                                          m.Game.start_time.between(t - pd.Timedelta(days=1), t + pd.Timedelta(days=1))))


def _find_game_for_team(db, team_id, when_iso):
    from sqlalchemy import or_

    t = pd.Timestamp(when_iso)
    return db.scalar(select(m.Game).where(or_(m.Game.home_team_id == team_id, m.Game.away_team_id == team_id),
                                          m.Game.start_time.between(t - pd.Timedelta(hours=20), t + pd.Timedelta(hours=20))))
