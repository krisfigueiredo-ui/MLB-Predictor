"""Import / cleaning / export pipeline tests."""
import io
import json

import openpyxl
from sqlalchemy import select

from app import models as m
from app.data_mgmt import exporter, importer

MESSY_GAMES = """Game Date,Home,Visitor,Home PTS,Visitor PTS,League
2026-01-05 19:30,Boston Celtics,Miami Heat,112,104,NBA
2026-01-05 19:30,Boston Celtics,Miami Heat,112,104,NBA
2026-01-06,LAL,GSW,99,99,nba
01/07/2026,Duke Blue Devils,North Carolina Tar Heels,81,77,NCAAB
2026-01-08,Springfield Isotopes,Miami Heat,100,90,NBA
2026-01-09,Denver Nuggets,Utah Jazz,abc,101,NBA
"""


def test_detect_mapping_synonyms():
    kind, mapping, info = importer.detect_mapping(["Game Date", "Home", "Visitor", "Home PTS", "Visitor PTS"])
    assert kind == "games"
    assert mapping["home_score"] == "Home PTS" and mapping["away_team"] == "Visitor"
    assert info["missing_required"] == []


def test_import_cleaning_and_quarantine(db):
    ds = importer.run_import(db, "messy.csv", MESSY_GAMES.encode(), timezone_name="America/New_York")
    recs = {r.row_index: r for r in db.scalars(select(m.ImportRecord).where(m.ImportRecord.dataset_id == ds.id))}
    assert recs[0].status == "valid"
    assert recs[0].cleaned["date"].endswith("+00:00")  # 19:30 ET standardised to UTC
    assert recs[0].cleaned["date"].startswith("2026-01-06T00:30")
    assert recs[1].status == "duplicate"
    assert recs[2].status == "quarantined"  # tied final score
    assert recs[3].status == "valid" and recs[3].cleaned["league"] == "CBB"
    assert recs[4].status == "quarantined"  # unknown team
    assert recs[5].status == "quarantined"  # non-numeric score
    sc = ds.scorecard
    assert sc["rows"] == 6 and sc["duplicates"] == 1 and sc["valid"] == 2
    assert sc["checks"]["invalid_scores"] >= 1
    # raw bytes preserved
    with open(ds.raw_path, "rb") as f:
        assert f.read() == MESSY_GAMES.encode()
    logs = db.scalars(select(m.CleaningLog).where(m.CleaningLog.dataset_id == ds.id)).all()
    assert any(lg.action == "timezone_standardized" for lg in logs)
    assert any(lg.destructive for lg in logs)
    # destructive correction (dropping the duplicate) needs approval before commit
    try:
        importer.commit(db, ds)
        raised = False
    except ValueError:
        raised = True
    assert raised
    importer.approve(db, ds, approve_destructive=True)
    out = importer.commit(db, ds)
    assert out["committed"] == 2
    g = db.scalar(select(m.Game).where(m.Game.source == "import:messy.csv"))
    assert g is not None and g.is_demo is False


def test_probability_percent_requires_approval(db):
    csv = "date,home_team,away_team,market,selection,probability\n2026-11-17,Duke,Kansas,moneyline,home,62%\n2026-11-17,Duke,Kansas,total,over,58\n"
    ds = importer.run_import(db, "preds.csv", csv.encode())
    recs = sorted(db.scalars(select(m.ImportRecord).where(m.ImportRecord.dataset_id == ds.id)).all(), key=lambda r: r.row_index)
    assert abs(recs[0].cleaned["probability"] - 0.62) < 1e-9  # explicit % string converted
    assert recs[1].status == "quarantined" and recs[1].cleaned["probability_proposed"] == 0.58
    importer.approve(db, ds, approve_destructive=True)
    r1 = db.scalar(select(m.ImportRecord).where(m.ImportRecord.dataset_id == ds.id, m.ImportRecord.row_index == 1))
    assert r1.status == "valid" and r1.cleaned["probability"] == 0.58


def test_json_and_xlsx_parsing():
    js = json.dumps({"data": [{"date": "2026-01-01", "player": "Stephen Curry", "team": "GSW", "minutes": "34", "pts": "31"}]}).encode()
    df = importer.parse_file("x.json", js)
    assert list(df.columns)[:2] == ["date", "player"]
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Date", "Player", "Team", "MIN", "PTS"])
    ws.append(["2026-01-01", "Stephen Curry", "GSW", 34, 31])
    buf = io.BytesIO()
    wb.save(buf)
    df2 = importer.parse_file("x.xlsx", buf.getvalue())
    kind, mapping, _ = importer.detect_mapping(list(df2.columns))
    assert kind == "player_stats" and mapping["minutes"] == "MIN"


def test_exports_all_formats(db):
    df = exporter.frame(db, "teams", "NBA")
    assert len(df) == 30
    for fmt in ("csv", "json", "xlsx"):
        body, ctype = exporter.render(df, fmt, "teams")
        assert len(body) > 100
    wb = openpyxl.load_workbook(io.BytesIO(exporter.render(df, "xlsx", "teams")[0]))
    assert "README" in wb.sheetnames
    ws = wb["teams"]
    assert ws.freeze_panes == "A2" and ws["A1"].font.bold
