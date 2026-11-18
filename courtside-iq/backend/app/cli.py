"""Operations CLI.

  python -m app.cli bootstrap                 # schema, registry, demo data (demo mode), models
  python -m app.cli train --league NBA        # retrain a league (game + props when logs exist)
  python -m app.cli tune --league CBB --trials 30
  python -m app.cli sync-rosters              # BALLDONTLIE /players/active -> verified memberships
  python -m app.cli sync --league NBA --days 2 # games + odds from configured providers
  python -m app.cli backfill --league NBA      # walk-forward archive for completed games
  python -m app.cli settle | reindex
"""
from __future__ import annotations

import argparse
import json
from datetime import date, timedelta


def main() -> None:
    ap = argparse.ArgumentParser(prog="courtside")
    ap.add_argument("command", choices=["bootstrap", "train", "tune", "sync-rosters", "sync", "backfill", "settle", "reindex"])
    ap.add_argument("--league", default="NBA", choices=["NBA", "CBB"])
    ap.add_argument("--trials", type=int, default=20)
    ap.add_argument("--days", type=int, default=1)
    a = ap.parse_args()

    from .db import SessionLocal, init_db

    init_db()
    with SessionLocal() as db:
        if a.command == "bootstrap":
            from .main import bootstrap

            out = bootstrap()
        elif a.command == "train":
            from .ai import rag
            from .services import modeling

            out = modeling.train_league(db, a.league)
            rag.index_core(db)
        elif a.command == "tune":
            from .ml.game_model import tune_lightgbm
            from .services.dataset import feature_frame

            out = tune_lightgbm(feature_frame(db, a.league), a.league, a.trials)
        elif a.command == "sync-rosters":
            from .providers import sync
            from .providers.clients import clients

            out = {"memberships": sync.sync_rosters(db, clients()["balldontlie"])}
        elif a.command == "sync":
            from .providers import sync
            from .providers.clients import clients

            c = clients()
            out = {}
            for i in range(a.days):
                d = date.today() - timedelta(days=i)
                if c["balldontlie"].configured:
                    out[f"games_{d}"] = sync.sync_games(db, a.league, d, c["balldontlie"])
            if c["the_odds_api"].configured:
                out["odds"] = sync.sync_odds(db, a.league, c["the_odds_api"])
        elif a.command == "backfill":
            from .services import modeling

            out = {"predictions": modeling.backfill_current_season(db, a.league)}
        elif a.command == "settle":
            from .services import settlement

            out = {"settled": settlement.settle_all(db)}
        else:
            from .ai import rag

            out = {"indexed": rag.index_core(db)}
    print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
