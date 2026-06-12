from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


#: Origins the browser frontend is served from in dev (`vite dev`, port 5173)
#: and local preview (`vite preview`, port 4173), under both spellings of
#: loopback. These are the CORS allowlist default AND the allowlist used by
#: the Origin guard on the local-filesystem endpoints (see
#: ``deps.require_allowed_origin``). Override via the environment as JSON,
#: e.g. ``DATA_ROVER_CORS_ORIGINS='["http://localhost:3000"]'``
#: (pydantic-settings parses list fields from env as JSON).
DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DATA_ROVER_", env_file=".env")

    cors_origins: list[str] = Field(default_factory=lambda: list(DEFAULT_CORS_ORIGINS))


def get_settings() -> Settings:
    return Settings()
