"""Environment-based configuration. All secrets stay server-side."""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    app_name: str = "COURTSIDE IQ"
    environment: str = "development"

    # Persistence. SQLite works for local/dev/tests; Postgres + pgvector for production.
    database_url: str = "sqlite:///./courtside.db"
    redis_url: str | None = None

    # Data providers (all optional; missing keys => clearly-labelled DEMO mode)
    balldontlie_api_key: str | None = None
    odds_api_key: str | None = None
    sportsdataio_api_key: str | None = None
    odds_api_regions: str = "us"
    odds_api_bookmakers: str = "draftkings,fanduel,betmgm,williamhill_us"

    # AI
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-opus-5-5"
    ai_effort: str = "medium"
    voyage_api_key: str | None = None

    # Assets: base URL of a licensed logo CDN. Without it, original crests are rendered.
    licensed_logo_base_url: str | None = None

    # Background refresh cadence (seconds)
    live_poll_seconds: int = 20
    odds_poll_seconds: int = 300
    enable_scheduler: bool = True

    # Modelling
    monte_carlo_sims: int = 10_000
    random_seed: int = 20261118
    mlflow_tracking_uri: str | None = None

    # Optional API protection for mutating endpoints
    admin_token: str | None = None
    cors_origins: str = "http://localhost:3000"

    @property
    def demo_mode(self) -> bool:
        return not (self.balldontlie_api_key or self.odds_api_key or self.sportsdataio_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
