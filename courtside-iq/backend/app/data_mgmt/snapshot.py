"""Dataset snapshots: export the database to versioned, gzipped CSV files and load them back.

A snapshot directory contains one `<table>.csv.gz` per table and a `manifest.json` with row
counts, SHA-256 checksums and provenance. Tables in LOAD_TABLES are restored by `load`; the
prediction archive and settlements are exported for analysis only, because they reference
model versions whose artifacts are rebuilt (deterministically) after loading.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import logging
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd
from sqlalchemy import JSON, Boolean, Date, DateTime, Float, Integer, func, insert, select
from sqlalchemy.orm import Session

from .. import models as m
from ..db import Base, EmbeddingType

log = logging.getLogger(__name__)

DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "demo_snapshot"
LOAD_TABLES = ["conferences", "teams", "sportsbooks", "players", "roster_memberships", "games", "team_game_stats",
               "player_game_stats", "injuries", "odds_snapshots", "prop_lines", "demo_outcomes"]
EXPORT_ONLY = ["predictions", "settlements", "model_versions"]
SNAPSHOT_FORMAT = 1


def _table(name: str):
    return Base.metadata.tables[name]


def export(db: Session, out_dir: Path | str = DEFAULT_DIR, description: str = "") -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest = dict(format=SNAPSHOT_FORMAT, generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    description=description, tables={})
    for name in LOAD_TABLES + EXPORT_ONLY:
        t = _table(name)
        cols = [c for c in t.columns if not isinstance(c.type, EmbeddingType)]
        rows = db.execute(select(*cols).order_by(*t.primary_key.columns)).all()
        df = pd.DataFrame(rows, columns=[c.name for c in cols])
        for c in cols:
            if isinstance(c.type, JSON) and not df.empty:
                df[c.name] = df[c.name].map(lambda v: None if v is None else json.dumps(v, sort_keys=True, default=str))
            elif isinstance(c.type, DateTime) and not df.empty:
                df[c.name] = df[c.name].map(lambda v: None if v is None else (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).isoformat())
        buf = io.StringIO()
        df.to_csv(buf, index=False)
        raw = buf.getvalue().encode()
        path = out / f"{name}.csv.gz"
        with open(path, "wb") as fh, gzip.GzipFile(filename="", mode="wb", fileobj=fh, mtime=0) as gz:  # mtime=0: reproducible bytes
            gz.write(raw)
        manifest["tables"][name] = dict(file=path.name, rows=len(df), sha256=hashlib.sha256(raw).hexdigest(),
                                        restore=name in LOAD_TABLES)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def _coerce(df: pd.DataFrame, table) -> list[dict]:
    recs = []
    types = {c.name: c.type for c in table.columns}
    for row in df.to_dict("records"):
        r = {}
        for k, v in row.items():
            if k not in types:
                continue
            t = types[k]
            if v is None or (isinstance(v, float) and pd.isna(v)):
                r[k] = None
            elif isinstance(t, JSON):
                r[k] = json.loads(v) if isinstance(v, str) else v
            elif isinstance(t, DateTime):
                r[k] = datetime.fromisoformat(str(v))
            elif isinstance(t, Date):
                r[k] = date.fromisoformat(str(v)[:10])
            elif isinstance(t, Boolean):
                r[k] = v if isinstance(v, bool) else str(v).lower() in ("true", "1")
            elif isinstance(t, Integer):
                r[k] = int(float(v))
            elif isinstance(t, Float):
                r[k] = float(v)
            else:
                r[k] = str(v) if not isinstance(v, str) else v
        recs.append(r)
    return recs


def load(db: Session, src: Path | str = DEFAULT_DIR, verify: bool = True) -> dict:
    """Restore a snapshot into an empty database (tables in LOAD_TABLES)."""
    src = Path(src)
    manifest = json.loads((src / "manifest.json").read_text())
    if manifest.get("format") != SNAPSHOT_FORMAT:
        raise ValueError(f"unsupported snapshot format {manifest.get('format')}")
    if db.scalar(select(func.count(m.Game.id))):
        raise ValueError("database already contains games; load a snapshot only into an empty database")
    # registry tables may have been seeded already; replace them so IDs match the snapshot
    for name in reversed(LOAD_TABLES):
        db.execute(_table(name).delete())
    db.commit()
    counts = {}
    for name in LOAD_TABLES:
        meta = manifest["tables"][name]
        raw = gzip.decompress((src / meta["file"]).read_bytes())
        if verify and hashlib.sha256(raw).hexdigest() != meta["sha256"]:
            raise ValueError(f"checksum mismatch for {meta['file']}")
        df = pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False, na_values=[""])
        recs = _coerce(df, _table(name))
        for i in range(0, len(recs), 5000):
            db.execute(insert(_table(name)), recs[i: i + 5000])
        counts[name] = len(recs)
    db.commit()
    if db.bind.dialect.name == "postgresql":
        from sqlalchemy import text

        for name in LOAD_TABLES:
            pk = list(_table(name).primary_key.columns)[0]
            if isinstance(pk.type, Integer) and pk.autoincrement is not False and name != "demo_outcomes":
                db.execute(text(f"SELECT setval(pg_get_serial_sequence('{name}', '{pk.name}'), "
                                f"COALESCE((SELECT MAX({pk.name}) FROM {name}), 1))"))
        db.commit()
    log.info("snapshot loaded: %s", counts)
    return counts


def available(src: Path | str = DEFAULT_DIR) -> bool:
    return (Path(src) / "manifest.json").exists()
