from __future__ import annotations

import pytest

from data_rover.api.settings import Settings


def test_defaults_present(monkeypatch: pytest.MonkeyPatch) -> None:
    # The API test conftest sets these env vars process-wide via setdefault so
    # that all other API tests run on SQLite.  This test validates the *code*
    # defaults (what the class returns without any env), so we must clear the
    # injected values for the duration of this single test.
    monkeypatch.delenv("DATA_ROVER_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATA_ROVER_DEV_SEED", raising=False)
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


def test_phase3_storage_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    # conftest sets DATA_ROVER_SNAPSHOT_STORE=memory + DATA_ROVER_IDLE_EVICT_SECONDS=0
    # process-wide; clear them so we can observe the code defaults.
    monkeypatch.delenv("DATA_ROVER_SNAPSHOT_STORE", raising=False)
    monkeypatch.delenv("DATA_ROVER_IDLE_EVICT_SECONDS", raising=False)
    # _env_file=None so a developer's local .env (e.g. copied from .env.example
    # with a fake-gcs emulator host) can't mask the code defaults under test.
    s = Settings(_env_file=None)  # pyright: ignore[reportCallIssue]  # pydantic-settings init kwarg
    assert s.snapshot_store == "gcs"
    assert s.gcs_bucket == "data-rover-snapshots"
    assert s.storage_emulator_host == ""
    assert s.snapshot_every == 200
    assert s.idle_evict_seconds == 1800


def test_phase3_storage_env_override(monkeypatch) -> None:
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_STORE", "memory")
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "10")
    monkeypatch.setenv("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
    s = Settings()
    assert s.snapshot_store == "memory"
    assert s.snapshot_every == 10
    assert s.idle_evict_seconds == 0
