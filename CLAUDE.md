# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A reflective MBSE (Model-Based Systems Engineering) metamodel engine. Three data layers stack on each other:

- **Metamodel** (`*.metamodel.yaml`) — the schema: element types, relationship types, inheritance (`extends`), properties with datatypes/multiplicity/facets, allowed endpoint `mappings`, and `key`s for uniqueness.
- **Model** (`*.model.json`) — instance data: elements and relationships conforming to one metamodel.
- **View** (`*.view.json`) — an optional user-defined folder overlay that *references* model elements by id; it owns nothing.

It ships as a Python core + FastAPI backend and a SvelteKit single-page frontend, with a one-shot CLI to migrate a legacy metamodel/model format into the new one. Example artifacts live in `examples/` (`smart-city.*`).

## Toolchain & commands

Everything runs through **pixi** (conda-based). There is no global `python` or `node` — always go through `pixi run`. Environments: `core` (runtime), `core-dev` (lint/test, includes api), `api` (backend runtime), `frontend` (Node 22).

```sh
# Python core + API
pixi run test-core                       # pytest (pythonpath=src, testpaths=tests)
pixi run -e core-dev pytest tests/model/test_model.py::test_name   # a single test
pixi run -e core-dev pytest -k uniqueness                          # by keyword
pixi run start-backend                   # uvicorn on 127.0.0.1:8000 (needs Postgres + DATA_ROVER_DATABASE_URL, or DATA_ROVER_DEV_SEED with a sqlite DSN)
pixi run db-upgrade                      # alembic upgrade head (Postgres tenancy schema)
# API tests need NO database service: tests/api/conftest.py runs in-memory SQLite.

# Lint / format / typecheck (ruff --fix, mypy, AND pyright — all three must pass)
pixi run tidy                            # format + lint across frontend, core, backend
pixi run lint-core                       # core only; lint-backend for the API package
pixi run -e core-dev pytest .            # run pytest directly when you need flags

# Frontend (run inside the frontend env; there are no pixi wrappers for its tests)
pixi run start-frontend                  # vite dev on :5173, proxies /api/v1 -> :8000
pixi run -e frontend npm test            # vitest (happy-dom + MSW)
pixi run -e frontend npm run test:e2e    # playwright (boots backend + dev server itself)
pixi run -e frontend npm run check       # svelte-check
```

`start-frontend` accepts `metamodel=`, `model=`, `view=` args that autoload files on boot (defaults to the smart-city example).

### Python version gotcha

The runtime is **Python 3.14**, but `pyrightconfig.json` pins the check floor to **3.10**. Don't reach for stdlib features newer than the floor (e.g. import `assert_never`/`Self` from `typing_extensions`, not `typing`) or pyright will fail even though the code runs.

## Architecture — the parts that span files

### Core layering (`src/data_rover/core/`)

- **`metamodel/schema.py` — `Metamodel` is immutable with lazily-built derived caches** (`_Caches`: ancestor chains, effective properties/keys, containment flags, end constraints). Treat it as frozen after load; uploads replace the whole object. If you ever add a mutation path, reset `_cache` to `None` (see `model_copy`). All subtype/effective-property/containment queries go through its cached lookup methods — never re-walk `extends` chains by hand.
- **`model/model.py` — `Model` is the single mutation boundary.** Every create/connect/set_property/delete flows through its methods, which keep `self.indexes` (`IndexSet`, in/out relationship adjacency) in sync. Bulk loaders that populate the dicts directly must call `indexes.rebuild()`. `delete_element` cascades through containment children. Property values are **replaced wholesale, never mutated in place** — the API op-log's inverse patches alias prior values by reference and depend on this.
- **`validation/pipeline.py` — one sweep, many validators.** The pipeline iterates the model (or a `Scope` subset) once and hands each entity to every `Validator` (`type_conformance`, `multiplicity`, `facets`, `endpoint_typing`, `containment`, `uniqueness`). Per-entity hooks must be O(entity) — use metamodel caches and `model.indexes`, not model scans. Whole-model checks go in `validate_global`. Validators carry mutable per-metamodel memo caches (`MetamodelMemo`, identity-keyed), so **construct one pipeline per request/thread**; never share across threads.

### Backend session & the delta protocol (`src/data_rover/api/`)

This is the central design and the thing most likely to surprise you. The model can be **~80 MB**, so the architecture is built to avoid copying it (this is the focus of the `perf/large-model-overhaul` work).

- **`session.py`** holds a process-wide `SessionRegistry` (one independent in-memory `Session` per project id, created lazily on first access). Each `Session` carries the metamodel, model, view, validation baseline, `model_rev`, and `op_log` for its project. Routes resolve the active `Session` per-request from the **`/api/v1/projects/{project_id}` path segment** via `deps.get_request_session`, which depends on `authz.require_membership` so the request is **authorized before the session is touched** (see Tenancy below); the no-arg `get_session()` returns the default project's session for internal/test callers. The **backend session is the source of truth; the client never holds the whole model.**

### Tenancy & auth (`src/data_rover/api/`, Phase 2)

User/project/membership data lives in a **SQLAlchemy + Postgres** layer, separate from the in-memory model `Session` (the model itself is still in-memory; durable model persistence is a later phase). Tests run hermetic **in-memory SQLite** (`tests/api/conftest.py`); production runs Postgres with the schema owned by **Alembic** (`alembic/`, `pixi run db-upgrade`).

- **`db.py`** — SQLAlchemy 2.0 (sync) engine lifecycle: `Base`, idempotent `init_engine` (in-memory SQLite → `StaticPool`; file SQLite/Postgres → default pool; SQLite gets `PRAGMA foreign_keys=ON`), `get_db` request dependency, `create_all`/`drop_all` (SQLite/dev + tests only — Postgres uses Alembic).
- **`db_models.py`** — `User`, `Project`, `Membership` + `Role` (`owner`/`editor`/`viewer`). FKs cascade (DB `ON DELETE CASCADE` + ORM `passive_deletes`); `role` is `native_enum=False` (VARCHAR+CHECK, portable across SQLite/Postgres). `User.id` is the external identity subject.
- **`tenancy.py`** — service functions over the ORM (create/list/get/delete project, member CRUD, `upsert_user`); the single place queries live.
- **`identity.py`** — the **auth seam**: `IdentityProvider.identify(request) -> Identity`. Ships a `DevHeaderIdentityProvider` (trusts `X-User-Id`/`X-User-Email` — dev/gateway only) swappable via `set_identity_provider` for real SSO later. `get_current_user` auto-provisions the user.
- **`authz.py`** — `require_membership` (404 unknown project / 403 non-member / 403 viewer-attempting-write) and `require_owner` (membership management). Writes are detected by HTTP method with a small allowlist of read-only POSTs (search/batch/validate); `/model/save` and `/model/apply-cr` are deliberately treated as writes (see comments).
- **`routes/projects.py`** — project + membership CRUD at `/api/v1/projects` (the only non-project-scoped data routes). All other data routers mount under `/api/v1/projects/{project_id}`.
- **Dev seed** — `main._ensure_dev_seed` (gated by `settings.dev_seed`, SQLite-only `create_all`) provisions a `default` user+project so the single-user frontend works against `/api/v1/projects/default` with dev identity headers, no project picker. Set `DATA_ROVER_DEV_SEED=false` in production.
- **`routes/ops.py` (`POST /model/ops`)** is the mutation path: clients send small op batches (mirroring `frontend/src/lib/state/ops.ts`). Ops are applied **in place** to the live model while inverse ops are collected; a mid-batch failure rolls back by applying inverses in reverse and returns **422**. Each accepted batch bumps `model_rev` once and is appended to `op_log` for undo.
- **Rev conflicts**: clients echo `model_rev` as `base_rev`; a stale batch gets **409** and the client must reload.
- **Undo** (`POST /model/undo`) replays an op-log batch's inverses in restore mode (`Model.restore_element/restore_relationship` reinstate exact ids). `op_log` is capped at `OP_LOG_MAX` (1000 batches); past that, `GET /model/changes` reports `complete: false`.
- **Legacy direct-mutation routes** (`routes/elements.py`, `relationships.py`) bypass the op protocol, so they call `session.touch_model()` to invalidate `op_log`/validation and bump `model_rev`.
- Reads are **paged/on-demand** (element pages, fuzzy search, containment tree children, BFS neighborhoods); load/save **stream** rather than materializing the serialized model as a string.

The frontend mirrors all of this client-side (optimistic ops, serialized flushes, conflict recovery). **`frontend/README.md` documents the frontend architecture in depth — read it before touching `frontend/src/lib/state/`.**

### Durable persistence (`src/data_rover/api/`, Phase 3)

Model content is now durable: the in-memory per-project `Session` is a **cache
over a durable journal**, hydrated on cache-miss and snapshotted on eviction.

- **`db_models.py`** adds content tables: `MetamodelRow` (versioned YAML blob),
  `ModelRow` (1:1 with `Project`; carries DB-authoritative `model_rev` + the
  swappable `metamodel_id`), `ViewRow`, `Commit` (PK `(project_id, rev)`; the
  durable op-journal — `ops`/`inverse_ops`/`id_map` as JSON, `author_id` SET
  NULL on user delete), `Snapshot` (PK `(project_id, rev)`; blob `key`).
- **`storage.py` / `storage_gcs.py`** — the `SnapshotStore` seam. `GcsSnapshotStore`
  (real `google-cloud-storage`) is used in dev (pointed at `fake-gcs-server` via
  `DATA_ROVER_STORAGE_EMULATOR_HOST`) and prod; `MemorySnapshotStore` backs the
  hermetic test suite. One opt-in `integration`-marked test hits the emulator.
- **`content.py`** — service functions over the content tables (the `tenancy.py`
  of model content). **`hydration.py`** — `hydrate_session` (nearest snapshot +
  replay commit tail through the restore-mode applier) and `persist_baseline`/
  `write_snapshot`. The op journal is (de)serialized via `schemas.OPS_ADAPTER`.
- **`SessionRegistry.get`** hydrates cold projects via an injected loader under a
  per-project init-once lock; **`evict`** snapshots-then-drops under the session's
  `write_mutex`. A contentless project still hydrates to an empty `Session`
  (pre-Phase-3 behaviour). A lifespan idle-sweeper evicts stale sessions
  (`DATA_ROVER_IDLE_EVICT_SECONDS`, 0 disables).
- **`POST /model/ops`** appends a `Commit` and bumps `models.model_rev` in
  lockstep with `session.model_rev`, under the write-mutex. **`POST /model/undo`**
  appends a *compensating* commit (journal stays append-only; `model_rev` moves
  forward). Upload routes (`metamodel`/`model`/`view`) persist their content so a
  project survives eviction; `/model/save` + `/model/download` remain read-only
  **export** conveniences.
- **`importer.py`** (`python -m data_rover.api.importer`) turns
  `(metamodel.yaml + model.json + view.json)` into a project's rev-0 baseline;
  the dev-seed reuses it to load `examples/smart-city.*` into `default`.

### Check-out/commit + locking (`src/data_rover/api/`, Phase 4)

Pessimistic leases gate every durable mutation; the legacy unlocked path remains for the frontend migration window.

- **`locking.py` — `LockTable`** holds in-session TTL leases keyed by resource id (single-instance in-process; Redis mirroring deferred to Phase 7). `acquire` is all-or-nothing. Conflict matrix: SHARED never conflicts; non-DELETE EXCLUSIVE conflicts only with another holder's EXCLUSIVE; DELETE EXCLUSIVE conflicts with ANY other holder's lease (including shared pins — that is how a pin blocks deletion). `expand_targets` turns a lock request into `RequiredLock`s, expanding DELETE-intent exclusives to the full containment subtree. `required_locks` derives the lock set from an op batch (delete → subtree; connect → EXCLUSIVE on source + SHARED pin on target); temp/just-created ids within the same batch need no lock.
- **`IssueCategory` on `core.validation.issue.Issue`** — two-tier commit gate: `STRUCTURAL` (dangling reference, containment cycle/two-parents) hard-fails at commit with 422; `CONFORMANCE` (endpoint typing, multiplicity, facets, uniqueness, scalar type) is counted and surfaced but never blocks a commit (engine stays inspectable). Default is `CONFORMANCE`; only the handful of structural call sites opt in.
- **`routes/locks.py`** — `POST /locks` acquires leases (all-or-nothing; 409 with conflict detail on failure); `POST /locks/release` releases by token; `POST /locks/renew` heartbeat-extends all leases under a token; `GET /locks` lists active leases for the project. Holder = authenticated user; times use `time.monotonic()` (same clock as the sweeper).
- **`routes/commits.py`** — `GET /open` returns `{model_rev, role, element_count, relationship_count, issue_counts}`; `POST /commits/preview` applies ops → validates the dirty set → rolls back (all under `write_mutex`), returning `conformance_error_count`, `structural_blockers`, and the full `issues` list without advancing `model_rev`; `POST /commits` is the durable lock-verified commit (see below).
- **Commit flow** (`POST /commits`): (1) stale-rev 409 before the mutex; (2) `_ensure_validation_seeded`; (3) under `write_mutex`: verify caller holds every required lock (409 if any expired/missing), apply batch (422 on mutation-boundary error), hard-reject structural blockers (422 + rollback), splice conformance issues into the issue store, bump `model_rev`, record batch in `op_log`, persist a `Commit` row with `message`/`validation_error_count`/conformance `issues` JSON (500 + full in-memory rollback on DB failure), release caller's locks. Returns `CommitResponse` with full element/relationship delta and commit metadata.
- **`Commit` row additions** (Alembic 0003) — `message TEXT`, `validation_error_count INTEGER`, `issues JSON` on the existing `commits` table; fed by `_persist_commit` via the extended `_commit_id`/`_message`/`_validation_error_count`/`_issues` kwargs.
- **Lifespan sweepers** — a `lock-sweeper` daemon thread runs every `lock_sweep_seconds` (default 60) calling `LockTable.sweep_expired` on every registered session; `lock_ttl_seconds` (default 300) is the per-lease TTL refreshed on each `renew` call. Both settings are 0-disableable (tests use 0).
- **Evict-with-live-locks guard** — `SessionRegistry.evict` checks `lock_table.active_leases` under the `write_mutex` before removing the session; if any lease is live, eviction is skipped and the session stays registered.
- **`/model/ops` + `/model/undo`** remain the **legacy unlocked** path until the frontend migrates to the check-out/commit flow (separate follow-up plan, pairs with Phase 5 realtime).

### Realtime feed (`src/data_rover/api/`, Phase 5)

Server-to-client WebSocket feed; the lock→edit→commit editing UI is a later phase (Spec B).

- **`feed.py` — `FeedHub`** holds a per-`Session` set of `ClientConn`s (each with a bounded `asyncio.Queue`). `broadcast` is sync and thread-safe: it schedules enqueues on the event-loop thread via `loop.call_soon_threadsafe` so it is safe to call while holding the `write_mutex`. A client that falls behind has its queue drained, receives `CLOSE_SENTINEL`, and is dropped; its sender pump closes the socket with 4408 and the client reconnects. The event loop is captured lazily on the first WebSocket connect via `set_loop_if_unset`; `reset_loop` provides test isolation. Four event builders (`snapshot_event`, `commit_event`, `lock_event`, `presence_event`) return plain dicts serialized by `ws.send_json`.
- **`routes/feed.py` — `@router.websocket("/feed")`** mounts under the `/{project_id}` prefix. Authentication uses the `IdentityProvider` seam (now typed to `HTTPConnection`, the shared base of `Request`/`WebSocket`); `DevHeaderIdentityProvider` falls back to `?x-user-id=`/`?x-user-email=` query params so browsers can authenticate without setting WebSocket headers. Close codes: 4401 (no identity), 4403 (non-member), 4404 (unknown project), 4408 (dropped-behind). On connect: capture the event loop, auth+authz over a short-lived DB session, register `ClientConn`, broadcast a presence-join, send an initial snapshot (current `model_rev` + active leases + connected users), then run a sender pump (`_pump`) alongside a receive loop that only observes disconnect. On disconnect: unregister and broadcast a presence-leave.
- **Broadcast hook sites** — commit delta + lock release after `POST /commits` (in `routes/commits.py`); lock acquire in `POST /locks` and release in `POST /locks/release` (in `routes/locks.py`); lock expiry in the lifespan lock-sweeper (`main.py`). `POST /locks/renew` is silent (heartbeat only, no peer-visible state change).
- **`identity.py`** — `IdentityProvider.identify` is now typed `(HTTPConnection) -> Identity`; `DevHeaderIdentityProvider` reads the same header names from `conn.headers` (HTTP) or `conn.query_params` (WebSocket).
- **Evict guard extension** — `SessionRegistry.evict` skips eviction while `session.hub.has_clients()` returns true (mirrors the live-leases guard); `feed_queue_max` setting controls per-client queue depth.

### Migration CLI (`src/data_rover/migration/`, `migration/README.md`)

`python -m data_rover.migration` converts the old JSON metamodel+model format to the new one (stereotype→element type, `owner`→`Owns` containment, `element_type`→`TypedBy`, datatypes inferred from real values). It never raises on invalid output so incomplete inputs stay inspectable; `--remove-inconsistencies` prunes model entities that would block frontend load.

## Conventions

- Tests live in `tests/<area>/` mirroring the source packages (`model`, `metamodel`, `validation`, `view`, `api`, `migration`). `pythonpath=src` is set in `pytest.ini`, so import as `from data_rover.core...`.
- Code in this repo carries dense docstrings explaining *why* invariants exist (immutability, mutation boundary, in-place rollback). Preserve and extend that style when changing those areas — the invariants are load-bearing.
- `docs/superpowers/{plans,specs}/` hold dated design docs (gitignored) that capture the rationale behind major features; consult the matching spec before reworking ops, validation, or the view tree.
- API tests that hit data routes use the `client` fixture + `seed_default_project`/`AUTH_HEADERS`/`papi` helpers from `tests/api/conftest.py`: every project-scoped request needs an identity header and a seeded project (the helpers seed/​target the `default` project so `get_session()`-based setup lines up with the HTTP path).
