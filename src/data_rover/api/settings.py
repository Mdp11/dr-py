from __future__ import annotations

from typing import Literal

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
    #: Which ScriptRunner ``build_runner_from_settings`` constructs: "wasm"
    #: (the wasmtime/CPython-WASI sandbox, the only choice safe for real
    #: deployments) or "trusted" (the in-process, unsandboxed test runner —
    #: see the RCE tripwire in ``script_runner.build_runner_from_settings``,
    #: which refuses "trusted" whenever ``dev_seed`` is false).
    snippet_runner: Literal["wasm", "trusted"] = "wasm"
    #: Path to the CPython-WASI guest binary (`python.wasm`) the wasm runner
    #: loads. Not committed: it is fetched by the `scripts/ensure_guest.sh`
    #: pixi activation hook (or by hand via
    #: `spikes/code_exec/fetch_python_wasi.sh`), so a checkout where that never
    #: ran — no network, a non-pixi deployment — simply leaves the runner unset
    #: (routes 503) rather than failing to boot.
    snippet_guest_wasm_path: str = "spikes/code_exec/vendor/python.wasm"
    #: Path to the CPython-WASI stdlib the wasm runner preopens as
    #: `PYTHONHOME`/`PYTHONPATH` for the guest.
    snippet_guest_lib_path: str = "spikes/code_exec/vendor/lib/python3.14"
    #: Warm-instance pool size for the wasm runner (`WasmScriptRunner.
    #: pool_size`). More instances absorb concurrent runs without a cold
    #: boot, at the cost of one idle CPython-WASI interpreter per slot.
    #:
    #: SIZED FOR THE SHARDED SWEEP (spec 2026-07-20 §4.3): a background sweep
    #: fans its cell work out across ``snippet_sweep_workers`` (4) guest
    #: sessions, and it draws from its OWN process-wide semaphore — it does
    #: NOT take a slot from the interactive ``snippet_concurrency`` guard. So
    #: a running sweep plus concurrent console/table evaluation would exhaust
    #: a pool of 2 and degrade those interactive calls to ``unavailable``.
    #: 4 sweep workers + 2 interactive headroom = 6.
    snippet_pool_size: int = 6
    #: Global cap on concurrently executing snippet runs. Settings-only here;
    #: enforcement lands in Task 11.
    snippet_concurrency: int = 4
    #: Per-user cap on concurrently executing snippet runs. Settings-only
    #: here; enforcement lands in Task 11.
    snippet_per_user_concurrency: int = 1
    #: Mirrors ``RunLimits.wall_timeout_s`` (see ``run_limits_from_settings``).
    snippet_wall_timeout_s: float = 10
    #: Mirrors ``RunLimits.memory_bytes``.
    snippet_memory_bytes: int = 256 * 1024 * 1024
    #: Mirrors ``RunLimits.stdout_bytes``.
    snippet_stdout_bytes: int = 256 * 1024
    #: Mirrors ``RunLimits.result_repr_bytes``.
    snippet_result_repr_bytes: int = 64 * 1024
    #: Mirrors ``RunLimits.max_ops``.
    snippet_max_ops: int = 1000
    #: Mirrors ``RunLimits.max_op_bytes``.
    snippet_max_op_bytes: int = 1024 * 1024
    #: Mirrors ``RunLimits.page_limit``.
    snippet_page_limit: int = 500
    #: Capacity (entries) of the guest facade's session-lifetime read memo
    #: (spec 2026-07-21 Phase A'). One entry is one memoized bridge read
    #: response (element projection / adjacency list / type info). 0 disables.
    snippet_read_memo_max: int = 4096
    #: Total wall budget (seconds) for ALL embedded snippet work one
    #: evaluate/export request triggers (``ScriptBudget``, M2/M3 script
    #: columns/steps) — shared across every script column/step call the
    #: request transitively makes, not a per-call timeout.
    snippet_eval_budget_s: float = 30.0
    #: Capacity of each session's ``ScriptCellCache`` (spec 2026-07-20 §3).
    #: Consumed at ``Session`` CONSTRUCTION: the ``script_cell_cache`` field's
    #: ``default_factory`` reads this via ``get_settings()`` so every
    #: construction path (the empty-fallback ``Session()`` and hydration's
    #: ``Session(metamodel=..., model=...)``) gets a setting-sized cache
    #: without threading a cap argument through ``SessionRegistry``. 50k cells
    #: comfortably holds a whole large table's script column at one rev.
    snippet_cell_cache_max: int = 50_000
    #: Process-wide bound on concurrently RUNNING background sweep jobs
    #: (``script_sweep._global_slots``). Bounded across ALL sessions so N open
    #: projects cannot mean N×workers guest instances — a sweep pool separate
    #: from the interactive ``snippet_concurrency`` guard.
    snippet_sweep_workers: int = 4
    #: Per-sweep wall ceiling (seconds): a ``SweepJob`` whose ``ScriptBudget``
    #: exhausts mid-grind aborts (``failed``, and NOT cached) rather than
    #: pinning a worker on one pathological table forever.
    snippet_sweep_ceiling_s: float = 600.0
    #: Consecutive-timeout abort threshold: a sweep that sees this many script
    #: timeouts in a row gives up (``failed``). A single slow cell resets the
    #: counter on the next success, so only a persistently-timing-out snippet
    #: trips it.
    snippet_sweep_timeout_abort: int = 3
    #: Run each background sweep inline (synchronously) inside
    #: ``kick_or_join_sweep`` instead of on a daemon thread. False in
    #: production; tests pin it true (``DATA_ROVER_SNIPPET_SWEEP_SYNC``) so a
    #: sweep completes deterministically within the calling test.
    snippet_sweep_sync: bool = False
    #: Incremental cell-cache invalidation on the op-delta commit paths
    #: (spec 2026-07-21 Phase B). True: a commit evicts only the cells whose
    #: recorded read-sets intersect its touched keys, and survivors stay
    #: warm at the new rev. False: legacy behavior (clear-all semantics via
    #: rev-stamp mismatch). Escape hatch, default on.
    snippet_incremental_invalidation: bool = True


def get_settings() -> Settings:
    return Settings()
