"""Normalized relational schema for COURTSIDE IQ.

Design notes
- NBA franchises and NCAA schools share `teams` with a `league` discriminator so that
  games, odds, stats and predictions use a single foreign key; conferences are a separate
  entity (CBB conferences, NBA East/West).
- Odds snapshots, prop lines and predictions are append-only. Settlement writes a separate
  `settlements` row and only fills the result columns on the prediction; it never mutates
  the forecast itself.
- Every externally sourced row records `source` and whether it is demo data (`is_demo`).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, EmbeddingType


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


class Conference(Base):
    __tablename__ = "conferences"
    id: Mapped[int] = mapped_column(primary_key=True)
    league: Mapped[str] = mapped_column(String(8), index=True)
    name: Mapped[str] = mapped_column(String(80))
    short_name: Mapped[str] = mapped_column(String(24))
    strength: Mapped[float | None] = mapped_column(Float)  # prior conference strength (pts/100 vs avg)
    __table_args__ = (UniqueConstraint("league", "short_name"),)


class Team(Base):
    __tablename__ = "teams"
    id: Mapped[int] = mapped_column(primary_key=True)
    league: Mapped[str] = mapped_column(String(8), index=True)  # NBA | CBB
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    abbreviation: Mapped[str] = mapped_column(String(8))
    location: Mapped[str] = mapped_column(String(80))
    nickname: Mapped[str] = mapped_column(String(80))
    conference_id: Mapped[int | None] = mapped_column(ForeignKey("conferences.id"))
    division: Mapped[str | None] = mapped_column(String(40))
    primary_color: Mapped[str] = mapped_column(String(9))
    secondary_color: Mapped[str] = mapped_column(String(9))
    venue: Mapped[str | None] = mapped_column(String(120))
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    provider_ids: Mapped[dict] = mapped_column(JSON, default=dict)
    conference: Mapped[Conference | None] = relationship()

    @property
    def display_name(self) -> str:
        return f"{self.location} {self.nickname}"


class Asset(Base):
    """Central asset registry: logos and portraits with licensing provenance."""

    __tablename__ = "assets"
    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(16))  # team | player
    entity_id: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(16))  # logo | portrait
    url: Mapped[str] = mapped_column(String(500))
    license: Mapped[str] = mapped_column(String(200))
    source: Mapped[str] = mapped_column(String(120))
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (Index("ix_asset_entity", "entity_type", "entity_id", "kind"),)


class Player(Base):
    __tablename__ = "players"
    id: Mapped[int] = mapped_column(primary_key=True)
    league: Mapped[str] = mapped_column(String(8), index=True)
    full_name: Mapped[str] = mapped_column(String(120), index=True)
    first_name: Mapped[str] = mapped_column(String(60))
    last_name: Mapped[str] = mapped_column(String(60))
    position: Mapped[str | None] = mapped_column(String(8))
    provider_ids: Mapped[dict] = mapped_column(JSON, default=dict)
    memberships: Mapped[list[RosterMembership]] = relationship(back_populates="player")


class RosterMembership(Base):
    __tablename__ = "roster_memberships"
    id: Mapped[int] = mapped_column(primary_key=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"), index=True)
    season: Mapped[str] = mapped_column(String(9))
    jersey_number: Mapped[str | None] = mapped_column(String(4))
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)  # NULL = current
    source: Mapped[str] = mapped_column(String(80))
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    player: Mapped[Player] = relationship(back_populates="memberships")
    team: Mapped[Team] = relationship()


class Game(Base):
    __tablename__ = "games"
    id: Mapped[int] = mapped_column(primary_key=True)
    league: Mapped[str] = mapped_column(String(8), index=True)
    season: Mapped[str] = mapped_column(String(9), index=True)
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    home_team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"), index=True)
    away_team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"), index=True)
    neutral_site: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(12), default="scheduled", index=True)
    period: Mapped[int | None] = mapped_column(Integer)
    clock: Mapped[str | None] = mapped_column(String(8))
    home_score: Mapped[int | None] = mapped_column(Integer)
    away_score: Mapped[int | None] = mapped_column(Integer)
    home_h1: Mapped[int | None] = mapped_column(Integer)
    away_h1: Mapped[int | None] = mapped_column(Integer)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    is_historical_sim: Mapped[bool] = mapped_column(Boolean, default=False)  # synthetic training history
    source: Mapped[str] = mapped_column(String(60))
    provider_ids: Mapped[dict] = mapped_column(JSON, default=dict)
    # Information knowable before tip-off (injury impact, lineup changes, roster continuity),
    # with the timestamp it was known. Used by point-in-time feature builders.
    pregame_context: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    home_team: Mapped[Team] = relationship(foreign_keys=[home_team_id])
    away_team: Mapped[Team] = relationship(foreign_keys=[away_team_id])


class DemoOutcome(Base):
    """Pre-simulated results for DEMO-mode games. Never exposed by the API: the demo feed
    reveals scores progressively as wall-clock time passes, emulating a live provider."""

    __tablename__ = "demo_outcomes"
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSON)


class GameEvent(Base):
    __tablename__ = "game_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    period: Mapped[int] = mapped_column(Integer)
    clock: Mapped[str] = mapped_column(String(8))
    event_type: Mapped[str] = mapped_column(String(24))
    description: Mapped[str] = mapped_column(String(300))
    home_score: Mapped[int] = mapped_column(Integer)
    away_score: Mapped[int] = mapped_column(Integer)
    win_prob_home: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TeamGameStat(Base):
    __tablename__ = "team_game_stats"
    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), index=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"), index=True)
    is_home: Mapped[bool] = mapped_column(Boolean)
    points: Mapped[int] = mapped_column(Integer)
    h1_points: Mapped[int | None] = mapped_column(Integer)
    fgm: Mapped[int] = mapped_column(Integer)
    fga: Mapped[int] = mapped_column(Integer)
    fg3m: Mapped[int] = mapped_column(Integer)
    fg3a: Mapped[int] = mapped_column(Integer)
    ftm: Mapped[int] = mapped_column(Integer)
    fta: Mapped[int] = mapped_column(Integer)
    oreb: Mapped[int] = mapped_column(Integer)
    dreb: Mapped[int] = mapped_column(Integer)
    tov: Mapped[int] = mapped_column(Integer)
    ast: Mapped[int | None] = mapped_column(Integer)
    possessions: Mapped[float] = mapped_column(Float)
    __table_args__ = (UniqueConstraint("game_id", "team_id"),)


class PlayerGameStat(Base):
    __tablename__ = "player_game_stats"
    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    started: Mapped[bool] = mapped_column(Boolean, default=True)
    minutes: Mapped[float] = mapped_column(Float)
    pts: Mapped[int] = mapped_column(Integer)
    reb: Mapped[int] = mapped_column(Integer)
    ast: Mapped[int] = mapped_column(Integer)
    fg3m: Mapped[int] = mapped_column(Integer)
    fg3a: Mapped[int] = mapped_column(Integer)
    fga: Mapped[int] = mapped_column(Integer)
    fta: Mapped[int] = mapped_column(Integer)
    stl: Mapped[int] = mapped_column(Integer)
    blk: Mapped[int] = mapped_column(Integer)
    tov: Mapped[int] = mapped_column(Integer)
    usage: Mapped[float | None] = mapped_column(Float)
    __table_args__ = (UniqueConstraint("game_id", "player_id"),)


class Injury(Base):
    __tablename__ = "injuries"
    id: Mapped[int] = mapped_column(primary_key=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    status: Mapped[str] = mapped_column(String(24))  # out | doubtful | questionable | probable
    description: Mapped[str | None] = mapped_column(String(200))
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    cleared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(60))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)


class Lineup(Base):
    __tablename__ = "lineups"
    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), index=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"))
    is_starter: Mapped[bool] = mapped_column(Boolean)
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    source: Mapped[str] = mapped_column(String(60))


class Sportsbook(Base):
    __tablename__ = "sportsbooks"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(80))
    region: Mapped[str] = mapped_column(String(8), default="us")


class OddsSnapshot(Base):
    """Immutable, timestamped market snapshot (one row per outcome)."""

    __tablename__ = "odds_snapshots"
    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), index=True)
    sportsbook_id: Mapped[int] = mapped_column(ForeignKey("sportsbooks.id"))
    market: Mapped[str] = mapped_column(String(24))  # h2h | spreads | totals | h1_totals | team_totals | alt_spreads
    outcome: Mapped[str] = mapped_column(String(16))  # home | away | over | under | home_over ...
    line: Mapped[float | None] = mapped_column(Float)
    price_american: Mapped[int] = mapped_column(Integer)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    source: Mapped[str] = mapped_column(String(60))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    sportsbook: Mapped[Sportsbook] = relationship()
    __table_args__ = (Index("ix_odds_game_market_time", "game_id", "market", "captured_at"),)


class PropLine(Base):
    __tablename__ = "prop_lines"
    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    sportsbook_id: Mapped[int] = mapped_column(ForeignKey("sportsbooks.id"))
    market: Mapped[str] = mapped_column(String(24))  # pts reb ast fg3m stl blk pra
    line: Mapped[float] = mapped_column(Float)
    over_price: Mapped[int] = mapped_column(Integer)
    under_price: Mapped[int] = mapped_column(Integer)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    source: Mapped[str] = mapped_column(String(60))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    sportsbook: Mapped[Sportsbook] = relationship()


class ModelVersion(Base):
    __tablename__ = "model_versions"
    id: Mapped[int] = mapped_column(primary_key=True)
    league: Mapped[str] = mapped_column(String(8))
    name: Mapped[str] = mapped_column(String(40))  # game | props
    version: Mapped[str] = mapped_column(String(40), unique=True)
    algorithm: Mapped[str] = mapped_column(String(120))
    trained_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    train_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    train_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    n_train: Mapped[int] = mapped_column(Integer, default=0)
    data_source: Mapped[str] = mapped_column(String(40))  # synthetic_demo | imported | provider
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    features: Mapped[list] = mapped_column(JSON, default=list)
    artifact_path: Mapped[str | None] = mapped_column(String(300))
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)


class Prediction(Base):
    """Permanent model forecast archive. Forecast columns are never updated after insert."""

    __tablename__ = "predictions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    league: Mapped[str] = mapped_column(String(8), index=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), index=True)
    player_id: Mapped[int | None] = mapped_column(ForeignKey("players.id"), index=True)
    model_version_id: Mapped[int] = mapped_column(ForeignKey("model_versions.id"))
    market: Mapped[str] = mapped_column(String(24), index=True)  # moneyline spread total h1_total team_total prop_pts ...
    selection: Mapped[str] = mapped_column(String(40))  # home | away | over | under
    predicted_value: Mapped[float | None] = mapped_column(Float)  # e.g. projected margin / total / stat
    predicted_prob: Mapped[float] = mapped_column(Float)
    line: Mapped[float | None] = mapped_column(Float)
    sportsbook_id: Mapped[int | None] = mapped_column(ForeignKey("sportsbooks.id"))
    price_american: Mapped[int | None] = mapped_column(Integer)
    data_as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    # settlement (filled once by the reconciliation engine)
    actual_value: Mapped[float | None] = mapped_column(Float)
    result: Mapped[str] = mapped_column(String(10), default="pending", index=True)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    game: Mapped[Game] = relationship()
    player: Mapped[Player | None] = relationship()
    model_version: Mapped[ModelVersion] = relationship()
    sportsbook: Mapped[Sportsbook | None] = relationship()


class UserPick(Base):
    __tablename__ = "user_picks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    pick_date: Mapped[date] = mapped_column(Date)
    league: Mapped[str] = mapped_column(String(8))
    game_id: Mapped[int | None] = mapped_column(ForeignKey("games.id"))
    player_id: Mapped[int | None] = mapped_column(ForeignKey("players.id"))
    description: Mapped[str] = mapped_column(String(200))
    market: Mapped[str] = mapped_column(String(24))
    selection: Mapped[str] = mapped_column(String(60))
    line: Mapped[float | None] = mapped_column(Float)
    predicted_outcome: Mapped[str | None] = mapped_column(String(200))
    sportsbook: Mapped[str | None] = mapped_column(String(60))
    price_american: Mapped[int | None] = mapped_column(Integer)
    confidence_notes: Mapped[str | None] = mapped_column(Text)
    stake_units: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(10), default="pending")  # win loss push void pending
    actual_result: Mapped[str | None] = mapped_column(String(200))
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Settlement(Base):
    __tablename__ = "settlements"
    id: Mapped[int] = mapped_column(primary_key=True)
    prediction_id: Mapped[str | None] = mapped_column(ForeignKey("predictions.id"), index=True)
    pick_id: Mapped[str | None] = mapped_column(ForeignKey("user_picks.id"), index=True)
    result: Mapped[str] = mapped_column(String(10))
    actual_value: Mapped[float | None] = mapped_column(Float)
    settled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    rule: Mapped[str] = mapped_column(String(200))
    source: Mapped[str] = mapped_column(String(60))


class TrendSnapshot(Base):
    __tablename__ = "trend_snapshots"
    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(16))
    entity_id: Mapped[int] = mapped_column(Integer)
    metric: Mapped[str] = mapped_column(String(40))
    window: Mapped[int] = mapped_column(Integer)
    value: Mapped[float] = mapped_column(Float)
    sample_size: Mapped[int] = mapped_column(Integer)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    source: Mapped[str] = mapped_column(String(60))


class ImportedDataset(Base):
    __tablename__ = "imported_datasets"
    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(32))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    status: Mapped[str] = mapped_column(String(20), default="previewed")  # previewed | approved | committed | rejected
    raw_path: Mapped[str] = mapped_column(String(400))
    raw_sha256: Mapped[str] = mapped_column(String(64))
    n_rows: Mapped[int] = mapped_column(Integer, default=0)
    n_valid: Mapped[int] = mapped_column(Integer, default=0)
    n_rejected: Mapped[int] = mapped_column(Integer, default=0)
    n_quarantined: Mapped[int] = mapped_column(Integer, default=0)
    n_duplicates: Mapped[int] = mapped_column(Integer, default=0)
    column_mapping: Mapped[dict] = mapped_column(JSON, default=dict)
    scorecard: Mapped[dict] = mapped_column(JSON, default=dict)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ImportRecord(Base):
    __tablename__ = "import_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("imported_datasets.id"), index=True)
    row_index: Mapped[int] = mapped_column(Integer)
    raw: Mapped[dict] = mapped_column(JSON)
    cleaned: Mapped[dict | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16))  # valid | quarantined | rejected | duplicate
    issues: Mapped[list] = mapped_column(JSON, default=list)


class ValidationResult(Base):
    __tablename__ = "validation_results"
    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("imported_datasets.id"), index=True)
    check: Mapped[str] = mapped_column(String(60))
    severity: Mapped[str] = mapped_column(String(10))  # info | warning | error
    count: Mapped[int] = mapped_column(Integer)
    details: Mapped[dict] = mapped_column(JSON, default=dict)


class CleaningLog(Base):
    __tablename__ = "cleaning_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("imported_datasets.id"), index=True)
    row_index: Mapped[int | None] = mapped_column(Integer)
    field: Mapped[str | None] = mapped_column(String(60))
    action: Mapped[str] = mapped_column(String(60))
    before: Mapped[str | None] = mapped_column(String(300))
    after: Mapped[str | None] = mapped_column(String(300))
    destructive: Mapped[bool] = mapped_column(Boolean, default=False)
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AIDocument(Base):
    __tablename__ = "ai_documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    source_type: Mapped[str] = mapped_column(String(32), index=True)
    source_id: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    embedding: Mapped[list | None] = mapped_column(EmbeddingType(384))
    __table_args__ = (UniqueConstraint("source_type", "source_id"),)


class ProviderHealth(Base):
    __tablename__ = "provider_health"
    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(40), index=True)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ok: Mapped[bool] = mapped_column(Boolean)
    latency_ms: Mapped[float | None] = mapped_column(Float)
    message: Mapped[str | None] = mapped_column(String(300))
    rate_limit_remaining: Mapped[int | None] = mapped_column(Integer)
