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
    #: SQLAlchemy URL for the tenancy database. Production/dev default to a
    #: local Postgres (psycopg v3 driver); the test suite overrides this to
    #: ``sqlite://`` (in-memory) via the env. The engine is created lazily, so
    #: importing the app never connects.
    database_url: str = (
        "postgresql+psycopg://data_rover:data_rover@localhost:5432/data_rover"
    )
    #: Request headers the dev IdentityProvider trusts. Case-insensitive
    #: (Starlette headers are). A real SSO provider replaces the provider, not
    #: these names.
    identity_user_header: str = "x-user-id"
    identity_email_header: str = "x-user-email"
    #: Which IdentityProvider get_identity_provider() builds: "cookie" (local
    #: email+password auth, the default) or "header" (trust gateway headers /
    #: tests). A real SSO provider is a third option installed via code.
    identity_provider: str = "cookie"
    #: HMAC secret for signing session JWTs. The default is INSECURE and only
    #: tolerated in dev; create_app refuses to boot the cookie provider in a
    #: non-dev deploy that still uses it.
    jwt_secret: str = "dev-insecure-secret-change-me"
    #: Session token lifetime (seconds). Default 8h.
    jwt_ttl_seconds: int = 28800
    #: Session cookie name.
    auth_cookie_name: str = "session"
    #: Set the cookie Secure flag (HTTPS only). False for localhost dev.
    auth_cookie_secure: bool = True
    #: Idempotently ensure an admin user exists on startup (independent of
    #: dev_seed, so prod can seed its first admin). Empty email ⇒ no bootstrap.
    bootstrap_admin_email: str = ""
    bootstrap_admin_password: str = ""
    #: Dev/SQLite convenience: when true, ``create_app`` creates the schema
    #: (so local dev needs no Alembic). It seeds NO users or model — the single
    #: admin comes from ``bootstrap_admin_*`` and projects are made via the
    #: wizard. MUST be false in production (Postgres schema is Alembic-owned):
    #: set ``DATA_ROVER_DEV_SEED=false``. Also the prod signal for
    #: ``_guard_prod_secret``.
    dev_seed: bool = True
    #: Snapshot blob backend: "gcs" (real client; points at GCS in prod or a
    #: fake-gcs-server emulator in dev) or "memory" (in-process; tests only).
    snapshot_store: str = "gcs"
    #: GCS bucket holding per-project model snapshots.
    gcs_bucket: str = "data-rover-snapshots"
    #: When non-empty, the GCS client talks to this emulator endpoint
    #: (e.g. "http://localhost:4443") instead of real GCS — set for local dev.
    storage_emulator_host: str = ""
    #: A full-model snapshot is written every Nth commit (bounds hydration
    #: replay length). A snapshot is ALSO always written on eviction.
    snapshot_every: int = 200
    #: Idle sessions (no request for this many seconds) are snapshotted and
    #: evicted by the background sweeper. 0 disables the sweeper (tests).
    idle_evict_seconds: int = 1800
    #: lease lifetime; renewed by client heartbeat (spec §8). Must be well
    #: under idle_evict_seconds so an idle session has no live leases to strand.
    lock_ttl_seconds: int = 300
    #: lifespan sweeper interval for auto-releasing expired leases. 0 disables.
    lock_sweep_seconds: int = 60
    #: bounded per-client feed queue. A client whose queue overflows is dropped
    #: and reconnects (Phase 5). Large enough to absorb a burst of commits.
    feed_queue_max: int = 256
    #: run the background validation sweep inline (synchronously) on the
    #: load/upload/hydrate paths. False in production; the API test conftest
    #: pins it true so tests keep deterministic "seeded after load" semantics.
    validation_sweep_sync: bool = False


def get_settings() -> Settings:
    return Settings()
