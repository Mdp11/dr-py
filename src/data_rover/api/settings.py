from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DATA_ROVER_", env_file=".env")

    cors_origins: list[str] = Field(default_factory=lambda: ["*"])


def get_settings() -> Settings:
    return Settings()
