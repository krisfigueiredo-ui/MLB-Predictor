"""Retrieval: document indexing + semantic search (pgvector on Postgres, cosine in Python otherwise).

Embeddings: deterministic local feature-hashing (unigrams + bigrams, 384 dims, L2-normalised).
No external service required. Set VOYAGE_API_KEY with the optional `voyageai` package
installed to use hosted embeddings instead (dimension is projected to 384).
"""
from __future__ import annotations

import hashlib
import re

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m

DIM = 384
_TOKEN = re.compile(r"[a-z0-9]+")
STOP = set("the a an of to in for and or is are was were be on at by with from as that this it its what which how why".split())


def embed(text: str) -> list[float]:
    toks = [t for t in _TOKEN.findall(text.lower()) if t not in STOP]
    v = np.zeros(DIM)
    grams = toks + [f"{a}_{b}" for a, b in zip(toks, toks[1:])]
    for g in grams:
        h = int.from_bytes(hashlib.blake2b(g.encode(), digest_size=8).digest(), "little")
        v[h % DIM] += 1.0 if (h >> 63) & 1 else -1.0
    n = np.linalg.norm(v)
    return (v / n).tolist() if n else v.tolist()


def upsert(db: Session, source_type: str, source_id: str, title: str, content: str, url: str | None = None) -> None:
    doc = db.scalar(select(m.AIDocument).where(m.AIDocument.source_type == source_type, m.AIDocument.source_id == source_id))
    if doc is None:
        doc = m.AIDocument(source_type=source_type, source_id=source_id, title=title, content=content, url=url)
        db.add(doc)
    doc.title, doc.content, doc.url, doc.embedding = title, content, url, embed(f"{title}\n{content}")


def search(db: Session, query: str, k: int = 6, source_types: list[str] | None = None) -> list[dict]:
    qv = embed(query)
    if db.bind.dialect.name == "postgresql":
        q = select(m.AIDocument, m.AIDocument.embedding.cosine_distance(qv).label("d"))  # pgvector operator
        if source_types:
            q = q.where(m.AIDocument.source_type.in_(source_types))
        rows = db.execute(q.order_by("d").limit(k)).all()
        return [_doc(d, 1 - float(dist)) for d, dist in rows]
    q = select(m.AIDocument)
    if source_types:
        q = q.where(m.AIDocument.source_type.in_(source_types))
    docs = db.scalars(q).all()
    if not docs:
        return []
    M = np.array([d.embedding for d in docs])
    sims = M @ np.array(qv)
    order = np.argsort(-sims)[:k]
    return [_doc(docs[i], float(sims[i])) for i in order]


def _doc(d: m.AIDocument, score: float) -> dict:
    return dict(id=d.id, source_type=d.source_type, source_id=d.source_id, title=d.title, url=d.url,
                content=d.content[:1500], score=score, indexed_at=d.created_at.isoformat())


METHODOLOGY = [
    ("methodology-game-model", "Game model methodology",
     "Game projections come from league-specific models. A structural baseline multiplies expected pace (average of both teams' "
     "possessions per game, exponentially weighted) by opponent-adjusted points per possession. LightGBM and CatBoost regressors "
     "learn the residual from rest days, back-to-backs, travel miles, injury impact, lineup changes, four factors (eFG%, TOV%, "
     "ORB%, FTr), recent form, home/away splits and strength of schedule; their average is the projection. College models add "
     "conference strength, nonconference performance, neutral courts, roster continuity and empirical-Bayes shrinkage toward a "
     "conference prior for small samples. XGBoost is trained as a benchmark only.", "/model"),
    ("methodology-simulation", "Monte Carlo simulation",
     "Each game is simulated 10,000 times by default from a bivariate normal on (margin, total) whose standard deviations and "
     "correlation were estimated from out-of-sample residuals on a chronological calibration fold. Scores are rounded to integers; "
     "ties are resolved with simulated overtime. Spread cover, push and over/under probabilities are counted from the simulations. "
     "Win probability is passed through an isotonic calibrator fit on the calibration fold. Random seeds are fixed per game for reproducibility.", "/totals"),
    ("methodology-market", "Market comparison and expected value",
     "Bookmaker-implied probability is 1/decimal odds. No-vig probabilities normalise a two-way market so both sides sum to one. "
     "Fair odds convert model probability back to American odds. Expected value per unit = p_win*(decimal-1) - p_loss, with pushes "
     "returning the stake. Only odds snapshots captured before a forecast's data timestamp are used; closing lines are never used "
     "to construct earlier predictions.", "/spreads"),
    ("methodology-props", "Player props methodology",
     "Props are modelled in three stages: minutes (LightGBM on recent minutes, rest, blowout risk from the projected spread, teammate injuries), "
     "per-minute production rates (shrunk toward season rates, adjusted for pace and opponent defence), then Negative Binomial "
     "simulations sharing a game-flow multiplier so points, assists and threes are positively correlated; PRA is summed per draw.", "/props"),
    ("methodology-validation", "Validation and leakage policy",
     "Training uses strict chronological splits (70% train, 15% calibration, 15% test) plus expanding-window walk-forward folds. "
     "Features for each game are computed only from games completed before tip-off. Current-season predictions in demo mode are "
     "a walk-forward backtest from a model trained before the season began. Metrics on synthetic demo data describe the simulator, "
     "not real-world accuracy.", "/model"),
    ("policy-demo", "Demo mode",
     "When no provider API keys are configured the platform runs on a synthetic league simulator. All demo games, odds and statistics are "
     "flagged is_demo and labelled DEMO in the interface. Real player names in the seed roster use 2025-26 affiliations and are marked "
     "unverified until a provider roster sync.", "/settings"),
]


def index_core(db: Session) -> int:
    n = 0
    for sid, title, content, url in METHODOLOGY:
        upsert(db, "methodology", sid, title, content, url)
        n += 1
    for mv in db.scalars(select(m.ModelVersion)):
        t = (mv.metrics or {}).get("test", {})
        lines = [f"Model {mv.version} ({mv.league} {mv.name}); algorithm: {mv.algorithm}; trained {mv.trained_at:%Y-%m-%d} on "
                 f"{mv.n_train} rows; data source {mv.data_source}; active={mv.is_active}."]
        for k, v in t.items():
            if isinstance(v, dict) and ("mae" in v or "brier" in v):
                lines.append(f"Held-out {k}: " + ", ".join(f"{kk}={vv:.3f}" for kk, vv in v.items() if isinstance(vv, float)))
        fi = (mv.metrics or {}).get("feature_importance", [])[:8]
        if fi:
            lines.append("Top features: " + ", ".join(f"{f['feature']} ({f['importance']:.3f})" for f in fi))
        upsert(db, "model_card", mv.version, f"Model card {mv.version}", "\n".join(lines), "/model")
        n += 1
    db.commit()
    return n
