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
    #: When true, ``create_app`` creates the schema (SQLite/dev convenience)
    #: and ensures a ``default`` user+project exist so the single-user frontend
    #: works without a project picker. MUST be false in production (Postgres
    #: schema is owned by Alembic): set ``DATA_ROVER_DEV_SEED=false``.
    dev_seed: bool = True
    #: Dev-seed source artifacts for the ``default`` project. Empty ⇒ the
    #: bundled ``examples/smart-city.*`` (preserves default behaviour). Set to
    #: seed a different model. Relative paths resolve from the process CWD
    #: (the repo root for pixi tasks). ``seed_view`` may be empty / point at a
    #: missing file to seed no view.
    seed_metamodel: str = ""
    seed_model: str = ""
    seed_view: str = ""
    #: Optional path to a JSON file of extra dev users to provision as members
    #: of the seeded ``default`` project (so local multi-user testing needs no
    #: manual member calls). Empty ⇒ none. Applied on every dev seed (idempotent
    #: upsert), so adding a user and restarting picks it up. Dev-only.
    #: Shape: ``{"users": [{"id": "alice", "email": "a@x", "role": "editor"}]}``
    dev_users_file: str = ""
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


def get_settings() -> Settings:
    return Settings()
