from __future__ import annotations

from data_rover.api.settings import Settings


def test_defaults_present() -> None:
    s = Settings()
    assert s.database_url.startswith("postgresql+psycopg://")
    assert s.identity_user_header == "x-user-id"
    assert s.identity_email_header == "x-user-email"
    assert s.dev_seed is True


def test_env_override(monkeypatch) -> None:
    monkeypatch.setenv("DATA_ROVER_DATABASE_URL", "sqlite://")
    monkeypatch.setenv("DATA_ROVER_DEV_SEED", "false")
    monkeypatch.setenv("DATA_ROVER_IDENTITY_USER_HEADER", "x-sso-subject")
    monkeypatch.setenv("DATA_ROVER_IDENTITY_EMAIL_HEADER", "x-sso-email")
    s = Settings()
    assert s.database_url == "sqlite://"
    assert s.dev_seed is False
    assert s.identity_user_header == "x-sso-subject"
    assert s.identity_email_header == "x-sso-email"
