# Phase 3 — Durable Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace file-based model load/save with durable persistence — a Postgres commit-journal + content tables and full-model snapshots in a GCS-backed blob store — so a per-project in-memory `Session` can be hydrated on cache-miss and evicted on idle without data loss.

**Architecture:** New Postgres tables (`metamodels`, `models`, `views`, `commits`, `snapshots`) hold durable content; a `SnapshotStore` seam (`GcsSnapshotStore` for dev/prod via `fake-gcs-server`/GCS, `MemorySnapshotStore` for hermetic tests) holds the ~80 MB model snapshots produced by the existing streaming serializer. `SessionRegistry.get` hydrates a cold project from "nearest snapshot + replay commit-journal tail"; eviction snapshots-then-drops under a per-session write-mutex. `POST /model/ops` appends each accepted batch as a durable commit and bumps a DB-authoritative `model_rev`; `POST /model/undo` appends a compensating commit (journal stays append-only). An importer turns `(metamodel.yaml + model.json + view.json)` into a project's `rev 0` baseline and is reused by the dev-seed to load the smart-city example.

**Tech Stack:** Python 3.14 (pyright floor 3.10), FastAPI (sync routes), SQLAlchemy 2.0 + psycopg v3 (Postgres) / SQLite (tests), Alembic, `google-cloud-storage` (+ `fake-gcs-server` emulator for local dev/opt-in integration test), Pydantic v2, pytest, pixi (`api`/`core-dev` envs). Reference: `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md` §5, §6, §7, §11, §12 (this is **Phase 3** of the 8-phase table).

## Global Constraints

- **Python floor is 3.10** (pyrightconfig.json): import `assert_never`/`Self` from `typing_extensions`, never `typing`.
- **Everything runs through pixi.** No global `python`/`node`. Tests: `pixi run -e core-dev pytest <path>`; lint+typecheck: `pixi run tidy` (ruff `--fix` + mypy + pyright — all three must pass).
- **API tests stay hermetic:** in-memory SQLite (`tests/api/conftest.py`) + `MemorySnapshotStore`. No test may require Postgres, GCS, or a running emulator — the one `fake-gcs-server` integration test is **skipped** when the emulator is absent.
- **Postgres schema is owned by Alembic.** `create_all` is SQLite/dev/tests only. Every new table needs an Alembic migration (Task 12).
- **The `Model` mutation boundary, `IndexSet`, validation pipeline, delta-ops, `iter_model_json`, and `build_model_from_dicts` are reused verbatim, per-project.** Do not re-walk metamodel chains or rebuild indexes by hand — bulk dict loaders call `model.indexes.rebuild()` (already done inside `build_model_from_dicts`).
- **ORM class names avoid clashing with core types:** the table-`models` ORM class is `ModelRow`, table-`metamodels` is `MetamodelRow`, table-`views` is `ViewRow` (core has `Model`, `Metamodel`, `View`).
- **Decisions locked (from brainstorming, 2026-06-17):**
  - Full commit-journal **and** snapshots this phase (not snapshot-only).
  - One `SnapshotStore` Protocol; real impl is `GcsSnapshotStore` (dev → `fake-gcs-server` via `STORAGE_EMULATOR_HOST`, prod → GCS). Tests use `MemorySnapshotStore` + one opt-in emulator integration test. Suite stays service-free.
  - Importer + dev-seed-loads-smart-city are in scope.
  - Separate `models` table (carries `model_rev` + the swappable `metamodel_id`), not folded onto `projects`.
  - `POST /model/undo` **appends a compensating commit** (journal append-only; `model_rev` moves up, not down). Forward-compatible with Phase 8 revert.
  - `model_rev` is DB-authoritative (`models.model_rev`); the in-memory `Session.model_rev` is kept in lockstep. Existing in-memory rev semantics (each load-replace bumps +1) are preserved — a persisted baseline snapshots at whatever `model_rev` the in-memory load produced.

---

## File structure

**New (backend):**
- `src/data_rover/api/storage.py` — `SnapshotStore` Protocol, `MemorySnapshotStore`, `GcsSnapshotStore`, `snapshot_key`, seam getter/setter + settings builder.
- `src/data_rover/api/content.py` — service functions over the content tables (mirrors `tenancy.py`): metamodel/model/view rows, commit append + read, snapshot record + lookup, history clear.
- `src/data_rover/api/hydration.py` — `hydrate_session(project_id) -> Session`, `persist_baseline(...)`, `snapshot_session(...)`, `serialize_ops`/`deserialize_ops`; the registry loader function wired in Task 7/11.
- `src/data_rover/api/importer.py` — `import_project(...)` + a `python -m data_rover.api.importer` CLI.
- `alembic/versions/0002_content_tables.py` — content-table migration.

**Modified (backend):**
- `src/data_rover/api/settings.py` — snapshot-store + snapshot-policy + idle-evict settings.
- `src/data_rover/api/db.py` — `db_session()` contextmanager for non-request callers (hydration/eviction/importer).
- `src/data_rover/api/db_models.py` — `MetamodelRow`, `ModelRow`, `ViewRow`, `Commit`, `Snapshot`.
- `src/data_rover/api/session.py` — `Session.write_mutex` + `last_access`; `SessionRegistry` loader seam, init-once hydration on `get`, snapshot-on-`evict`.
- `src/data_rover/api/schemas.py` — `OPS_ADAPTER` (a `TypeAdapter(list[OpIn])`) for journal (de)serialization.
- `src/data_rover/api/routes/ops.py` — append commit + bump DB `model_rev` under the write-mutex; undo-as-compensating-commit.
- `src/data_rover/api/routes/metamodel.py`, `view.py`, `model.py` — persist uploads (metamodel blob + binding; view blob; model baseline snapshot).
- `src/data_rover/api/main.py` — build+install snapshot store and registry loader at startup; dev-seed imports smart-city; lifespan-scoped idle-evict sweeper.
- `pixi.toml` — add `google-cloud-storage` to `[feature.api.dependencies]`; add a `fake-gcs` dev task.
- `CLAUDE.md` — document Phase 3.

**New / modified (tests):**
- `tests/api/conftest.py` — install `MemorySnapshotStore` + the hydrating loader per test; reset both on teardown; force idle-evict off.
- `tests/api/test_storage.py`, `test_content.py`, `test_hydration.py`, `test_importer.py`, `test_eviction.py`, `test_persistence_integration.py` (the GCS round-trip is opt-in/skipped).
- `tests/api/test_ops.py` (extend: commit persistence + undo-as-commit), `tests/api/test_alembic.py` (extend: 0002 upgrades clean).

---

### Task 1: Dependencies + settings

Add the GCS client and the Phase-3 settings fields. No behavior change yet.

**Files:**
- Modify: `pixi.toml` (`[feature.api.dependencies]` + a `fake-gcs` task)
- Modify: `src/data_rover/api/settings.py`
- Test: `tests/api/test_settings.py` (extend)

**Interfaces:**
- Produces: `Settings.snapshot_store: str` (`"memory"|"gcs"`), `Settings.gcs_bucket: str`, `Settings.storage_emulator_host: str` (`""` = real GCS), `Settings.snapshot_every: int`, `Settings.idle_evict_seconds: int`.

- [ ] **Step 1: Add the GCS dependency to pixi**

In `pixi.toml`, under `[feature.api.dependencies]`, add after `psycopg = "3.2.*"`:

```toml
google-cloud-storage = "2.*"
```

- [ ] **Step 2: Add a fake-gcs dev task**

In `pixi.toml`, after the `[feature.api.tasks.db-revision]` block, add:

```toml
# Local GCS emulator for dev + the opt-in storage integration test.
# Requires Docker; not needed for the (hermetic) unit test suite.
[feature.api.tasks.fake-gcs]
cmd = "docker run --rm -p 4443:4443 fsouza/fake-gcs-server -scheme http -port 4443 -public-host localhost:4443"
default-environment = "api"
```

- [ ] **Step 3: Install**

Run: `pixi install -e core-dev`
Expected: resolves and installs `google-cloud-storage` (core-dev includes the `api` feature).

- [ ] **Step 4: Write the failing settings test**

Append to `tests/api/test_settings.py`:

```python
def test_phase3_storage_defaults() -> None:
    s = Settings()
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
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_settings.py -q`
Expected: FAIL (`AttributeError`/missing fields).

- [ ] **Step 6: Add the settings fields**

In `src/data_rover/api/settings.py`, inside `class Settings`, after `dev_seed: bool = True`, add:

```python
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
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_settings.py -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add pixi.toml src/data_rover/api/settings.py tests/api/test_settings.py
git commit -m "feat(api): Phase 3 storage settings + google-cloud-storage dep"
```

---

### Task 2: SnapshotStore seam + MemorySnapshotStore

The storage abstraction and its in-memory impl (the test/default-internal backend). Streaming `put` (the model is ~80 MB), whole-blob `get` (buffer-then-parse, matching the existing `/model/upload` route).

**Files:**
- Create: `src/data_rover/api/storage.py`
- Test: `tests/api/test_storage.py` (create)

**Interfaces:**
- Produces:
  - `snapshot_key(project_id: str, rev: int) -> str`
  - `class SnapshotStore(Protocol)` with `put(key: str, chunks: Iterable[bytes]) -> None`, `get(key: str) -> bytes`, `exists(key: str) -> bool`, `delete(key: str) -> None`
  - `class MemorySnapshotStore` implementing it (plus `.clear()`)
  - `get_snapshot_store() -> SnapshotStore`, `set_snapshot_store(store: SnapshotStore | None) -> None`
  - `build_store_from_settings(settings: Settings) -> SnapshotStore`

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_storage.py`:

```python
from __future__ import annotations

import pytest

from data_rover.api.storage import (
    MemorySnapshotStore,
    SnapshotStore,
    get_snapshot_store,
    set_snapshot_store,
    snapshot_key,
)


def test_snapshot_key_scheme() -> None:
    assert snapshot_key("p1", 7) == "projects/p1/snapshots/7.json"


def test_memory_put_get_roundtrip() -> None:
    store: SnapshotStore = MemorySnapshotStore()
    store.put("k", [b'{"a":', b"1}"])
    assert store.get("k") == b'{"a":1}'
    assert store.exists("k") is True


def test_memory_get_missing_raises() -> None:
    store = MemorySnapshotStore()
    assert store.exists("nope") is False
    with pytest.raises(KeyError):
        store.get("nope")


def test_memory_delete_is_idempotent() -> None:
    store = MemorySnapshotStore()
    store.put("k", [b"x"])
    store.delete("k")
    store.delete("k")  # no error on second delete
    assert store.exists("k") is False


def test_store_seam_set_get_reset() -> None:
    custom = MemorySnapshotStore()
    set_snapshot_store(custom)
    assert get_snapshot_store() is custom
    set_snapshot_store(None)  # reset
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_storage.py -q`
Expected: FAIL (`ModuleNotFoundError: data_rover.api.storage`).

- [ ] **Step 3: Implement storage.py (seam + memory store)**

Create `src/data_rover/api/storage.py`:

```python
"""Blob store for full-model snapshots (Phase 3 durable persistence).

The model is ~80 MB, so writes stream (``put`` takes an iterable of byte
chunks straight from ``serialize.iter_model_json``) and reads buffer the whole
blob (``get`` returns bytes; hydration then ``json.loads`` + 
``build_model_from_dicts`` — identical to today's ``POST /model/upload``).

One Protocol, two impls: ``GcsSnapshotStore`` (the real one — dev points it at
a fake-gcs-server emulator, prod at GCS) and ``MemorySnapshotStore`` (hermetic
tests). The active store is a process-global behind a getter/setter seam,
mirroring ``identity.get_identity_provider`` / ``set_identity_provider``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Iterable, Protocol

if TYPE_CHECKING:
    from .settings import Settings

#: blob key for one project's snapshot at a given rev
_SNAPSHOT_KEY = "projects/{project_id}/snapshots/{rev}.json"


def snapshot_key(project_id: str, rev: int) -> str:
    return _SNAPSHOT_KEY.format(project_id=project_id, rev=rev)


class SnapshotStore(Protocol):
    def put(self, key: str, chunks: Iterable[bytes]) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...


class MemorySnapshotStore:
    """In-process store backed by a dict. Tests + non-GCS internal callers."""

    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}

    def put(self, key: str, chunks: Iterable[bytes]) -> None:
        self._blobs[key] = b"".join(chunks)

    def get(self, key: str) -> bytes:
        return self._blobs[key]  # KeyError on miss — see test

    def exists(self, key: str) -> bool:
        return key in self._blobs

    def delete(self, key: str) -> None:
        self._blobs.pop(key, None)  # idempotent

    def clear(self) -> None:
        self._blobs.clear()


_store: SnapshotStore | None = None


def get_snapshot_store() -> SnapshotStore:
    """Process-global store, built from settings on first use."""
    global _store
    if _store is None:
        from .settings import get_settings

        _store = build_store_from_settings(get_settings())
    return _store


def set_snapshot_store(store: SnapshotStore | None) -> None:
    """Swap the store (``None`` resets to a settings-built default on next get).

    Tests MUST reset (``set_snapshot_store(None)``) on teardown — the store is a
    process-global singleton; the API conftest does this automatically.
    """
    global _store
    _store = store


def build_store_from_settings(settings: "Settings") -> SnapshotStore:
    if settings.snapshot_store == "memory":
        return MemorySnapshotStore()
    if settings.snapshot_store == "gcs":
        from .storage_gcs import GcsSnapshotStore

        return GcsSnapshotStore(
            settings.gcs_bucket,
            endpoint=settings.storage_emulator_host or None,
        )
    raise ValueError(f"unknown snapshot_store {settings.snapshot_store!r}")
```

(`GcsSnapshotStore` lives in its own module imported lazily so the hermetic test suite never imports `google.cloud.storage` — Task 3.)

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_storage.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/storage.py tests/api/test_storage.py
git commit -m "feat(api): SnapshotStore seam + MemorySnapshotStore"
```

---

### Task 3: GcsSnapshotStore + opt-in emulator integration test

The real impl (dev + prod). Unit tests cover construction/endpoint wiring with a fake client object; one integration test exercises a real round-trip against `fake-gcs-server` and is **skipped** when the emulator isn't running.

**Files:**
- Create: `src/data_rover/api/storage_gcs.py`
- Test: `tests/api/test_storage_gcs.py` (create)

**Interfaces:**
- Consumes: `SnapshotStore` Protocol (Task 2).
- Produces: `class GcsSnapshotStore` with `__init__(bucket: str, *, client: Any | None = None, endpoint: str | None = None)` implementing `SnapshotStore`.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_storage_gcs.py`:

```python
from __future__ import annotations

import os
import socket

import pytest

from data_rover.api.storage_gcs import GcsSnapshotStore


class _FakeBlob:
    def __init__(self, store: dict[str, bytes], name: str) -> None:
        self._store, self._name = store, name

    def upload_from_file(self, fileobj) -> None:  # noqa: ANN001
        self._store[self._name] = fileobj.read()

    def download_as_bytes(self) -> bytes:
        if self._name not in self._store:
            from google.cloud.exceptions import NotFound

            raise NotFound(self._name)
        return self._store[self._name]

    def exists(self) -> bool:
        return self._name in self._store

    def delete(self) -> None:
        from google.cloud.exceptions import NotFound

        if self._name not in self._store:
            raise NotFound(self._name)
        del self._store[self._name]


class _FakeBucket:
    def __init__(self, store: dict[str, bytes]) -> None:
        self._store = store

    def blob(self, name: str) -> _FakeBlob:
        return _FakeBlob(self._store, name)


class _FakeClient:
    def __init__(self) -> None:
        self._store: dict[str, bytes] = {}

    def bucket(self, name: str) -> _FakeBucket:  # noqa: ARG002
        return _FakeBucket(self._store)


def test_gcs_put_get_roundtrip_with_fake_client() -> None:
    store = GcsSnapshotStore("b", client=_FakeClient())
    store.put("k", [b"{", b"}"])
    assert store.get("k") == b"{}"
    assert store.exists("k") is True


def test_gcs_get_missing_raises_keyerror() -> None:
    store = GcsSnapshotStore("b", client=_FakeClient())
    assert store.exists("k") is False
    with pytest.raises(KeyError):
        store.get("k")


def test_gcs_delete_is_idempotent() -> None:
    store = GcsSnapshotStore("b", client=_FakeClient())
    store.put("k", [b"x"])
    store.delete("k")
    store.delete("k")  # NotFound swallowed
    assert store.exists("k") is False


def _emulator_up(host: str) -> bool:
    h, _, p = host.partition(":")
    try:
        with socket.create_connection((h, int(p or 4443)), timeout=0.25):
            return True
    except OSError:
        return False


@pytest.mark.integration
def test_gcs_real_roundtrip_against_emulator() -> None:
    host = os.environ.get("STORAGE_EMULATOR_HOST", "localhost:4443")
    if not _emulator_up(host):
        pytest.skip(f"fake-gcs-server not reachable at {host}")
    os.environ["STORAGE_EMULATOR_HOST"] = host
    store = GcsSnapshotStore(
        "data-rover-test", endpoint=f"http://{host}", create_bucket=True
    )
    store.put("projects/p/snapshots/0.json", [b'{"elements":[],"relationships":[]}'])
    assert store.get("projects/p/snapshots/0.json").startswith(b'{"elements"')
    store.delete("projects/p/snapshots/0.json")
```

- [ ] **Step 2: Register the `integration` marker**

In `pytest.ini`, add under `[pytest]` (so the opt-in marker is known and unselected by default):

```ini
markers =
    integration: opt-in tests needing an external service (e.g. fake-gcs-server); deselect with -m "not integration"
addopts = -m "not integration"
```

(If `addopts`/`markers` already exist, merge these lines in. Run `pixi run -e core-dev pytest tests/api/test_storage_gcs.py -q` — the integration test is now deselected, the three fake-client tests run.)

- [ ] **Step 3: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_storage_gcs.py -q`
Expected: FAIL (`ModuleNotFoundError: data_rover.api.storage_gcs`).

- [ ] **Step 4: Implement storage_gcs.py**

Create `src/data_rover/api/storage_gcs.py`:

```python
"""GCS-backed snapshot store (the real impl for dev + prod).

Dev points the standard ``google-cloud-storage`` client at a fake-gcs-server
emulator (``endpoint=`` / ``STORAGE_EMULATOR_HOST``) with anonymous creds; prod
uses default creds against real GCS. The code path is identical — only the
endpoint and credentials differ — which is the whole point of using a GCS
emulator locally rather than a bespoke filesystem store.
"""

from __future__ import annotations

import io
from typing import Any, Iterable


class GcsSnapshotStore:
    def __init__(
        self,
        bucket: str,
        *,
        client: Any | None = None,
        endpoint: str | None = None,
        create_bucket: bool = False,
    ) -> None:
        if client is None:
            client = _make_client(endpoint)
        self._client = client
        self._bucket_name = bucket
        if create_bucket:
            # emulator convenience; ignore "already exists"
            from google.cloud.exceptions import Conflict

            try:
                client.create_bucket(bucket)
            except Conflict:
                pass
        self._bucket = client.bucket(bucket)

    def put(self, key: str, chunks: Iterable[bytes]) -> None:
        # buffer the chunks then upload: the google client's resumable upload
        # wants a seekable file-like; one transient bytes buffer at ~80 MB is
        # the same memory profile as today's upload route (an accepted cost).
        self._bucket.blob(key).upload_from_file(io.BytesIO(b"".join(chunks)))

    def get(self, key: str) -> bytes:
        from google.cloud.exceptions import NotFound

        try:
            return self._bucket.blob(key).download_as_bytes()
        except NotFound as exc:
            raise KeyError(key) from exc

    def exists(self, key: str) -> bool:
        return bool(self._bucket.blob(key).exists())

    def delete(self, key: str) -> None:
        from google.cloud.exceptions import NotFound

        try:
            self._bucket.blob(key).delete()
        except NotFound:
            pass  # idempotent


def _make_client(endpoint: str | None) -> Any:
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import storage

    if endpoint:
        # emulator: anonymous creds + endpoint override
        return storage.Client(
            project="data-rover",
            credentials=AnonymousCredentials(),
            client_options={"api_endpoint": endpoint},
        )
    return storage.Client()
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_storage_gcs.py -q`
Expected: PASS (3 passed, 1 deselected). Optionally, with the emulator running (`pixi run fake-gcs` in another terminal): `pixi run -e core-dev pytest tests/api/test_storage_gcs.py -m integration -q` → 1 passed.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/storage_gcs.py tests/api/test_storage_gcs.py pytest.ini
git commit -m "feat(api): GcsSnapshotStore + opt-in fake-gcs integration test"
```

---

### Task 4: Content ORM models + db_session() contextmanager

The five durable content tables and a non-request DB-session helper (hydration, eviction, and the importer all run outside a FastAPI request).

**Files:**
- Modify: `src/data_rover/api/db_models.py`
- Modify: `src/data_rover/api/db.py`
- Test: `tests/api/test_content_models.py` (create)

**Interfaces:**
- Produces ORM classes (all on `db.Base`):
  - `MetamodelRow` — `id: str (PK)`, `name: str`, `version: int`, `blob: str`, `created_at: datetime`
  - `ModelRow` — `id: str (PK)`, `project_id: str (FK projects.id, unique, CASCADE)`, `metamodel_id: str (FK metamodels.id)`, `name: str`, `model_rev: int (default 0)`
  - `ViewRow` — `id: str (PK)`, `project_id: str (FK projects.id, CASCADE)`, `name: str`, `blob: str`
  - `Commit` — `project_id: str (FK, CASCADE)`, `rev: int`, PK `(project_id, rev)`; `commit_id: str`, `author_id: str | None (FK users.id, SET NULL)`, `ts: datetime`, `ops: JSON`, `inverse_ops: JSON`, `id_map: JSON`
  - `Snapshot` — `project_id: str (FK, CASCADE)`, `rev: int`, PK `(project_id, rev)`; `key: str`, `ts: datetime`
- Produces: `db.db_session()` — a contextmanager yielding a committed-on-exit `Session` for non-request callers.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_content_models.py`:

```python
from __future__ import annotations

from data_rover.api import db
from data_rover.api.db_models import (
    Commit,
    MetamodelRow,
    ModelRow,
    Project,
    Snapshot,
    ViewRow,
)


def _engine():
    db.init_engine("sqlite://", force=True)
    db.create_all()


def test_model_row_one_to_one_with_project() -> None:
    _engine()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))
        s.add(MetamodelRow(id="mm1", name="MM", version=1, blob="x: 1"))
        s.add(ModelRow(id="m1", project_id="p1", metamodel_id="mm1", name="model"))
    with db.db_session() as s:
        row = s.get(ModelRow, "m1")
        assert row is not None and row.model_rev == 0


def test_commit_pk_is_project_and_rev() -> None:
    _engine()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))
        s.add(
            Commit(
                project_id="p1",
                rev=0,
                commit_id="c0",
                author_id=None,
                ops=[],
                inverse_ops=[],
                id_map={},
            )
        )
    with db.db_session() as s:
        c = s.get(Commit, ("p1", 0))
        assert c is not None and c.commit_id == "c0"


def test_snapshot_and_cascade_delete_with_project() -> None:
    _engine()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))
        s.add(Snapshot(project_id="p1", rev=0, key="projects/p1/snapshots/0.json"))
    with db.db_session() as s:
        s.delete(s.get(Project, "p1"))
    with db.db_session() as s:
        assert s.get(Snapshot, ("p1", 0)) is None  # FK ON DELETE CASCADE
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_content_models.py -q`
Expected: FAIL (`ImportError`: `Commit`/`db_session` undefined).

- [ ] **Step 3: Add the `db_session()` contextmanager**

In `src/data_rover/api/db.py`, add `from contextlib import contextmanager` at the top and append:

```python
@contextmanager
def db_session() -> Generator[Session, None, None]:
    """A DB session for non-request callers (hydration, eviction, importer).

    Commits on clean exit, rolls back on exception, always closes. Distinct
    from ``get_db`` (the FastAPI generator dependency) so background/CLI code
    isn't tied to the request lifecycle.
    """
    if _SessionLocal is None:
        raise RuntimeError("engine not initialised; call init_engine() first")
    session = _SessionLocal()
    try:
        yield session
        session.commit()
    except BaseException:
        session.rollback()
        raise
    finally:
        session.close()
```

- [ ] **Step 4: Add the content ORM models**

In `src/data_rover/api/db_models.py`, extend the imports:

```python
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship
```

(Keep the existing `enum` import. `from datetime import datetime, timezone` and the widened `sqlalchemy` import replace the current narrower lines.)

Append after `Membership`:

```python
def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MetamodelRow(Base):
    """A versioned, shareable metamodel. ``blob`` is the YAML source text
    (re-parsed via ``load_metamodel_str`` on hydrate). Immutable per version:
    a new metamodel is a new row, never an in-place mutation (Phase 6)."""

    __tablename__ = "metamodels"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False, default="")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    blob: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class ModelRow(Base):
    """One project's model. 1:1 with ``Project`` (unique project_id). Carries
    the DB-authoritative ``model_rev`` and the swappable ``metamodel_id``."""

    __tablename__ = "models"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    metamodel_id: Mapped[str] = mapped_column(
        ForeignKey("metamodels.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False, default="model")
    model_rev: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class ViewRow(Base):
    """A user-defined folder overlay. ``blob`` is the view JSON
    (``View.model_dump_json``). N per project (Phase 3 frontend uses one)."""

    __tablename__ = "views"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False, default="")
    blob: Mapped[str] = mapped_column(Text, nullable=False)


class Commit(Base):
    """One accepted ops batch == one revision == one journal row (spec §7).

    ``ops``/``inverse_ops`` are the canonical op lists in the same format as
    ``frontend/.../ops.ts`` (serialized via ``schemas.OPS_ADAPTER``);
    ``inverse_ops`` are stored in execution order so undo/replay is "apply
    front-to-back". ``author_id`` is SET NULL on user delete so history
    survives the author leaving."""

    __tablename__ = "commits"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    rev: Mapped[int] = mapped_column(Integer, primary_key=True)
    commit_id: Mapped[str] = mapped_column(String, nullable=False)
    author_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    ops: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    inverse_ops: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    id_map: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class Snapshot(Base):
    """A full-model snapshot in the SnapshotStore. Hydration loads the
    nearest snapshot with ``rev <= model_rev`` then replays later commits."""

    __tablename__ = "snapshots"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    rev: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String, nullable=False)
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_content_models.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/db_models.py src/data_rover/api/db.py tests/api/test_content_models.py
git commit -m "feat(api): content ORM tables + db_session() contextmanager"
```

---

### Task 5: content.py service functions

The single place content-table queries live (mirrors `tenancy.py`). Pure DB; no FastAPI, no storage.

**Files:**
- Create: `src/data_rover/api/content.py`
- Test: `tests/api/test_content.py` (create)

**Interfaces:**
- Consumes: ORM models (Task 4), `db.db_session` (Task 4).
- Produces:
  - `create_metamodel(db, *, name: str, version: int, blob: str) -> MetamodelRow`
  - `get_metamodel_row(db, metamodel_id: str) -> MetamodelRow | None`
  - `get_model_row(db, project_id: str) -> ModelRow | None`
  - `upsert_model_row(db, project_id: str, *, metamodel_id: str, name: str = "model") -> ModelRow`
  - `set_model_rev(db, project_id: str, rev: int) -> None`
  - `append_commit(db, project_id, *, rev, commit_id, author_id, ops, inverse_ops, id_map) -> Commit`
  - `commits_after(db, project_id: str, rev: int) -> list[Commit]`
  - `record_snapshot(db, project_id: str, *, rev: int, key: str) -> Snapshot`
  - `latest_snapshot(db, project_id: str, max_rev: int | None = None) -> Snapshot | None`
  - `clear_history(db, project_id: str) -> None`
  - `upsert_single_view(db, project_id: str, *, name: str, blob: str) -> ViewRow`
  - `get_single_view(db, project_id: str) -> ViewRow | None`

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_content.py`:

```python
from __future__ import annotations

from data_rover.api import content, db
from data_rover.api.db_models import Project


def _setup() -> None:
    db.init_engine("sqlite://", force=True)
    db.create_all()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))


def test_metamodel_and_model_upsert() -> None:
    _setup()
    with db.db_session() as s:
        mm = content.create_metamodel(s, name="MM", version=1, blob="x: 1")
        m = content.upsert_model_row(s, "p1", metamodel_id=mm.id)
        assert m.model_rev == 0
        # upsert again rebinds without a second row
        m2 = content.upsert_model_row(s, "p1", metamodel_id=mm.id)
        assert m2.id == m.id


def test_commit_append_and_read_tail() -> None:
    _setup()
    with db.db_session() as s:
        mm = content.create_metamodel(s, name="MM", version=1, blob="x: 1")
        content.upsert_model_row(s, "p1", metamodel_id=mm.id)
        for rev in (1, 2, 3):
            content.append_commit(
                s, "p1", rev=rev, commit_id=f"c{rev}", author_id=None,
                ops=[{"kind": "noop"}], inverse_ops=[], id_map={},
            )
        content.set_model_rev(s, "p1", 3)
    with db.db_session() as s:
        tail = content.commits_after(s, "p1", 1)
        assert [c.rev for c in tail] == [2, 3]
        assert content.get_model_row(s, "p1").model_rev == 3


def test_snapshot_record_and_latest() -> None:
    _setup()
    with db.db_session() as s:
        content.record_snapshot(s, "p1", rev=0, key="k0")
        content.record_snapshot(s, "p1", rev=5, key="k5")
    with db.db_session() as s:
        assert content.latest_snapshot(s, "p1").rev == 5
        assert content.latest_snapshot(s, "p1", max_rev=3).rev == 0
        assert content.latest_snapshot(s, "p1", max_rev=-1) is None


def test_clear_history_removes_commits_and_snapshots() -> None:
    _setup()
    with db.db_session() as s:
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[], inverse_ops=[], id_map={},
        )
        content.record_snapshot(s, "p1", rev=1, key="k1")
    with db.db_session() as s:
        content.clear_history(s, "p1")
    with db.db_session() as s:
        assert content.commits_after(s, "p1", 0) == []
        assert content.latest_snapshot(s, "p1") is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_content.py -q`
Expected: FAIL (`ModuleNotFoundError: data_rover.api.content`).

- [ ] **Step 3: Implement content.py**

Create `src/data_rover/api/content.py`:

```python
"""Service functions over the content tables (metamodels/models/views/
commits/snapshots). Mirrors ``tenancy.py``: the single place these queries
live; routes and hydration call these instead of inlining SQL. Each function
takes a live ``Session`` and does NOT commit — callers own the unit of work
(``db.db_session`` commits on exit; request code commits explicitly)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .db_models import Commit, MetamodelRow, ModelRow, Snapshot, ViewRow


def create_metamodel(
    db: Session, *, name: str, version: int, blob: str
) -> MetamodelRow:
    row = MetamodelRow(id=uuid.uuid4().hex, name=name, version=version, blob=blob)
    db.add(row)
    db.flush()
    return row


def get_metamodel_row(db: Session, metamodel_id: str) -> MetamodelRow | None:
    return db.get(MetamodelRow, metamodel_id)


def get_model_row(db: Session, project_id: str) -> ModelRow | None:
    return db.execute(
        select(ModelRow).where(ModelRow.project_id == project_id)
    ).scalar_one_or_none()


def upsert_model_row(
    db: Session, project_id: str, *, metamodel_id: str, name: str = "model"
) -> ModelRow:
    row = get_model_row(db, project_id)
    if row is None:
        row = ModelRow(
            id=uuid.uuid4().hex,
            project_id=project_id,
            metamodel_id=metamodel_id,
            name=name,
        )
        db.add(row)
    else:
        row.metamodel_id = metamodel_id
    db.flush()
    return row


def set_model_rev(db: Session, project_id: str, rev: int) -> None:
    row = get_model_row(db, project_id)
    if row is not None:
        row.model_rev = rev


def append_commit(
    db: Session,
    project_id: str,
    *,
    rev: int,
    commit_id: str,
    author_id: str | None,
    ops: list[Any],
    inverse_ops: list[Any],
    id_map: dict[str, str],
) -> Commit:
    row = Commit(
        project_id=project_id,
        rev=rev,
        commit_id=commit_id,
        author_id=author_id,
        ops=ops,
        inverse_ops=inverse_ops,
        id_map=id_map,
    )
    db.add(row)
    db.flush()
    return row


def commits_after(db: Session, project_id: str, rev: int) -> list[Commit]:
    return list(
        db.execute(
            select(Commit)
            .where(Commit.project_id == project_id, Commit.rev > rev)
            .order_by(Commit.rev)
        ).scalars()
    )


def record_snapshot(db: Session, project_id: str, *, rev: int, key: str) -> Snapshot:
    row = db.get(Snapshot, (project_id, rev))
    if row is None:
        row = Snapshot(project_id=project_id, rev=rev, key=key)
        db.add(row)
    else:
        row.key = key
    db.flush()
    return row


def latest_snapshot(
    db: Session, project_id: str, max_rev: int | None = None
) -> Snapshot | None:
    stmt = select(Snapshot).where(Snapshot.project_id == project_id)
    if max_rev is not None:
        stmt = stmt.where(Snapshot.rev <= max_rev)
    return db.execute(
        stmt.order_by(Snapshot.rev.desc()).limit(1)
    ).scalar_one_or_none()


def clear_history(db: Session, project_id: str) -> None:
    """Delete all commits + snapshot rows for a project (baseline reset).

    Does NOT delete the snapshot blobs from the store — callers that reset a
    baseline overwrite the rev-0 blob immediately afterwards; orphan blobs at
    other revs are harmless (a later GC pass is out of scope)."""
    db.execute(delete(Commit).where(Commit.project_id == project_id))
    db.execute(delete(Snapshot).where(Snapshot.project_id == project_id))


def upsert_single_view(
    db: Session, project_id: str, *, name: str, blob: str
) -> ViewRow:
    row = get_single_view(db, project_id)
    if row is None:
        row = ViewRow(id=uuid.uuid4().hex, project_id=project_id, name=name, blob=blob)
        db.add(row)
    else:
        row.name, row.blob = name, blob
    db.flush()
    return row


def get_single_view(db: Session, project_id: str) -> ViewRow | None:
    return db.execute(
        select(ViewRow).where(ViewRow.project_id == project_id).order_by(ViewRow.id)
    ).scalars().first()
```

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_content.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/content.py tests/api/test_content.py
git commit -m "feat(api): content service functions over the durable tables"
```

---

### Task 6: hydration.py — serialize ops, build/persist a Session

The pure persistence logic: turn content+blobs into a live `Session` (hydrate), and turn a live `Session` into durable content (persist a baseline / write a snapshot). No registry wiring yet (Task 7), so each function is tested directly.

**Files:**
- Modify: `src/data_rover/api/schemas.py` (add `OPS_ADAPTER`)
- Create: `src/data_rover/api/hydration.py`
- Test: `tests/api/test_hydration.py` (create)

**Interfaces:**
- Consumes: `content.*` (Task 5), `storage.*` (Task 2), `serialize.iter_model_json`, `_snapshot.build_model_from_dicts`, `load_metamodel_str`, `Session`, `OpsRequest`/`OpIn`.
- Produces:
  - `schemas.OPS_ADAPTER: TypeAdapter[list[OpIn]]`
  - `serialize_ops(ops: list[OpIn]) -> list[dict]`, `deserialize_ops(raw: list) -> list[OpIn]`
  - `hydrate_session(project_id: str) -> Session`
  - `write_snapshot(project_id: str, session: Session, rev: int) -> None`
  - `persist_baseline(project_id: str, session: Session, *, author_id: str | None) -> None`
  - `replay_commits_into(session: Session, commits: list[Commit]) -> None`

- [ ] **Step 1: Add the ops TypeAdapter to schemas.py**

In `src/data_rover/api/schemas.py`, after the `OpIn = Annotated[...]` definition (around line 197-206), add:

```python
from pydantic import TypeAdapter  # add to the existing pydantic import line

#: (de)serializes a list of ops to/from plain JSON for the durable commit
#: journal (Commit.ops / inverse_ops). Mode "json" keeps Literal "kind" tags
#: so the discriminated union round-trips.
OPS_ADAPTER: TypeAdapter[list[OpIn]] = TypeAdapter(list[OpIn])
```

- [ ] **Step 2: Write the failing tests**

Create `tests/api/test_hydration.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest

from data_rover.api import content, db, hydration
from data_rover.api.db_models import Project
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store
from data_rover.api.session import Session
from data_rover.core.metamodel.loader import load_metamodel_str

MM_YAML = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


@pytest.fixture(autouse=True)
def _env():
    db.init_engine("sqlite://", force=True)
    db.create_all()
    store = MemorySnapshotStore()
    set_snapshot_store(store)
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))
    yield
    set_snapshot_store(None)


def _seed_baseline() -> Session:
    """Build an in-memory session with the metamodel + a tiny model, persist it."""
    from data_rover.core.model.model import Model

    mm = load_metamodel_str(MM_YAML)
    model = Model(mm)
    sess = Session(metamodel=mm, model=model)
    with db.db_session() as s:
        mmrow = content.create_metamodel(s, name="smart-city", version=1, blob=MM_YAML)
        content.upsert_model_row(s, "p1", metamodel_id=mmrow.id)
    hydration.persist_baseline("p1", sess, author_id=None)
    return sess


def test_persist_then_hydrate_roundtrip_empty_model() -> None:
    _seed_baseline()
    h = hydration.hydrate_session("p1")
    assert h.metamodel is not None
    assert h.model is not None
    assert h.model_rev == 0
    assert len(h.model.elements) == 0


def test_hydrate_contentless_project_is_empty_session() -> None:
    # no model row at all -> empty session (today's behaviour, keeps tests green)
    h = hydration.hydrate_session("p1")
    assert h.metamodel is None and h.model is None and h.model_rev == 0


def test_hydrate_replays_commit_tail_on_top_of_snapshot() -> None:
    sess = _seed_baseline()
    # one commit that creates an element, recorded as rev 1 with a rev-0 snapshot
    create = {
        "kind": "create_element",
        "temp_id": "e1",
        "type_name": _first_concrete_element_type(sess),
        "properties": {},
    }
    with db.db_session() as s:
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[create], inverse_ops=[], id_map={},
        )
        content.set_model_rev(s, "p1", 1)
    h = hydration.hydrate_session("p1")
    assert h.model_rev == 1
    assert "e1" in h.model.elements


def _first_concrete_element_type(sess: Session) -> str:
    # Metamodel.elements is the public list[ElementType]; each has .name/.abstract
    for et in sess.metamodel.elements:
        if not et.abstract:
            return et.name
    raise AssertionError("no concrete element type in smart-city metamodel")
```

- [ ] **Step 3: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_hydration.py -q`
Expected: FAIL (`ModuleNotFoundError: data_rover.api.hydration`).

- [ ] **Step 4: Implement hydration.py**

Create `src/data_rover/api/hydration.py`:

```python
"""Hydrate a cold project into a live ``Session`` and persist a live ``Session``
back to durable storage.

Hydrate = nearest snapshot (rev <= model_rev) -> ``build_model_from_dicts`` ->
replay the commit tail (rev > snapshot_rev) through the SAME restore-mode
applier the ops route uses. Persist = write the model snapshot via the
streaming serializer + record the row; a baseline reset additionally clears
old history and writes the rev-0 commit + snapshot.

A contentless project (no ``ModelRow``) hydrates to an EMPTY ``Session`` — the
exact pre-Phase-3 behaviour, so projects that haven't been given content yet
behave identically and the existing test suite stays green.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState
from data_rover.core.view.schema import View

from . import content
from .db import db_session
from .db_models import Commit
from .schemas import OPS_ADAPTER, OpIn
from .serialize import iter_model_json
from .session import Session
from .storage import get_snapshot_store, snapshot_key


def serialize_ops(ops: list[OpIn]) -> list[Any]:
    return OPS_ADAPTER.dump_python(ops, mode="json")


def deserialize_ops(raw: list[Any]) -> list[OpIn]:
    return OPS_ADAPTER.validate_python(raw)


def write_snapshot(project_id: str, session: Session, rev: int) -> None:
    """Stream the session model to the blob store and record the snapshot row."""
    assert session.model is not None
    store = get_snapshot_store()
    key = snapshot_key(project_id, rev)
    store.put(key, (chunk.encode("utf-8") for chunk in iter_model_json(session.model)))
    with db_session() as s:
        content.record_snapshot(s, project_id, rev=rev, key=key)


def persist_baseline(
    project_id: str, session: Session, *, author_id: str | None
) -> None:
    """Make the session's CURRENT model the project's durable baseline.

    Clears prior history, writes a snapshot at ``session.model_rev``, records a
    rev-0-style "baseline" commit row at that rev (empty ops — the snapshot IS
    the state), and sets ``models.model_rev`` to the session rev. The in-memory
    ``session.model_rev`` is left as-is (load-replace already bumped it), so
    snapshot rev == model_rev == DB model_rev."""
    assert session.model is not None
    rev = session.model_rev
    with db_session() as s:
        content.clear_history(s, project_id)
        content.append_commit(
            s, project_id, rev=rev, commit_id=uuid.uuid4().hex,
            author_id=author_id, ops=[], inverse_ops=[], id_map={},
        )
        content.set_model_rev(s, project_id, rev)
    write_snapshot(project_id, session, rev)


def replay_commits_into(session: Session, commits: list[Commit]) -> None:
    """Apply each commit's ops to the session model in restore mode.

    Imported here (not at module top) to avoid a circular import: ops.py
    imports nothing from hydration, hydration imports the applier from ops."""
    from .routes.ops import _apply_batch

    assert session.model is not None
    for c in commits:
        ops = deserialize_ops(c.ops)
        if ops:
            _apply_batch(session.model, ops, restore=True)


def hydrate_session(project_id: str) -> Session:
    """Build the live ``Session`` for a project from durable storage.

    No ``ModelRow`` -> empty ``Session`` (pre-Phase-3 behaviour)."""
    with db_session() as s:
        model_row = content.get_model_row(s, project_id)
        if model_row is None:
            return Session()
        mm_row = content.get_metamodel_row(s, model_row.metamodel_id)
        assert mm_row is not None  # FK guarantees it
        model_rev = model_row.model_rev
        snap = content.latest_snapshot(s, project_id, max_rev=model_rev)
        tail = (
            content.commits_after(s, project_id, snap.rev) if snap is not None else []
        )
        snap_key = snap.key if snap is not None else None
        view_row = content.get_single_view(s, project_id)
        view_blob = view_row.blob if view_row is not None else None

    metamodel = load_metamodel_str(mm_row.blob)
    if snap_key is None:
        # model row exists but no snapshot yet (shouldn't happen post-baseline);
        # treat as an empty model conforming to the metamodel.
        model = Model(metamodel)
    else:
        from .routes._snapshot import build_model_from_dicts

        raw = json.loads(get_snapshot_store().get(snap_key))
        model = build_model_from_dicts(metamodel, raw)

    session = Session(metamodel=metamodel, model=model)
    session.model_rev = model_rev
    replay_commits_into(session, tail)
    if view_blob is not None:
        session.view = View.model_validate_json(view_blob)
    state = ValidationState()
    state.set_full(default_pipeline().validate(model, Scope.all()))
    session.validation = state
    return session
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_hydration.py -q`
Expected: PASS. (If `_first_concrete_element_type` needs the real attribute, fix it now and re-run.)

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/hydration.py tests/api/test_hydration.py
git commit -m "feat(api): hydrate/persist a Session from durable storage"
```

---

### Task 7: Wire SessionRegistry — hydrate-on-miss, write-mutex, snapshot-on-evict

Make `SessionRegistry.get` hydrate cold projects through an injected loader (init-once guarded), track last access, and snapshot on `evict`. Add a per-session `write_mutex` (used by Task 8 + eviction). Behaviour is preserved for contentless projects (loader returns an empty `Session`).

**Files:**
- Modify: `src/data_rover/api/session.py`
- Modify: `tests/api/conftest.py` (install memory store + hydrating loader; force idle-evict off)
- Test: `tests/api/test_session_registry.py` (extend or create)

**Interfaces:**
- Consumes: `hydration.hydrate_session` + `hydration.write_snapshot` (Task 6) via injection.
- Produces:
  - `Session.write_mutex: threading.RLock`, `Session.last_access: float`
  - `SessionRegistry.set_loader(loader: Callable[[str], Session] | None)`, `set_evict_hook(hook: Callable[[str, Session], None] | None)`
  - `SessionRegistry.touch(project_id)` (updates `last_access`), `SessionRegistry.idle(now: float, ttl: float) -> list[str]`
  - module-level `install_persistent_registry()` wiring the registry to `hydration` (called by main + conftest)

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_session_registry.py`:

```python
from __future__ import annotations

import threading

from data_rover.api.session import Session, SessionRegistry


def test_get_uses_loader_once_per_project() -> None:
    calls: list[str] = []

    def loader(pid: str) -> Session:
        calls.append(pid)
        return Session(model_rev=42)

    reg = SessionRegistry()
    reg.set_loader(loader)
    a = reg.get("p1")
    b = reg.get("p1")
    assert a is b and a.model_rev == 42
    assert calls == ["p1"]  # loaded once, then cached


def test_loader_init_once_under_concurrency() -> None:
    calls: list[str] = []
    barrier = threading.Barrier(8)

    def loader(pid: str) -> Session:
        barrier.wait()
        calls.append(pid)
        return Session()

    reg = SessionRegistry()
    reg.set_loader(loader)
    out: list[Session] = []
    threads = [
        threading.Thread(target=lambda: out.append(reg.get("p1"))) for _ in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1  # init-once guard held
    assert all(s is out[0] for s in out)


def test_evict_runs_snapshot_hook_then_drops() -> None:
    evicted: list[str] = []
    reg = SessionRegistry()
    reg.set_loader(lambda pid: Session(model_rev=1))
    reg.set_evict_hook(lambda pid, sess: evicted.append(pid))
    reg.get("p1")
    reg.evict("p1")
    assert evicted == ["p1"]
    assert reg.project_ids() == []


def test_evict_hook_skipped_when_nothing_to_persist() -> None:
    reg = SessionRegistry()
    reg.set_evict_hook(lambda pid, sess: (_ for _ in ()).throw(AssertionError("called")))
    reg.evict("absent")  # no session -> hook not called, no error


def test_idle_lists_stale_projects() -> None:
    reg = SessionRegistry()
    reg.set_loader(lambda pid: Session())
    reg.get("p1")
    reg.touch("p1")
    assert reg.idle(now=1000.0, ttl=10.0) == []  # just touched (last_access ~ monotonic)
```

(The `idle` test asserts an empty list because `last_access` is freshly set; a true-positive idle case is exercised in Task 11's eviction test where time is controlled.)

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_session_registry.py -q`
Expected: FAIL (`AttributeError: set_loader`).

- [ ] **Step 3: Extend Session with concurrency fields**

In `src/data_rover/api/session.py`, add imports at the top:

```python
import threading
import time
from collections.abc import Callable
```

In `@dataclass class Session`, add after `op_log_dropped: int = 0`:

```python
    #: serializes commit-persist and eviction for THIS project (spec §11
    #: write-mutex). An RLock so the ops path can take it around a block that
    #: also calls helpers which assume it is held. Phase 4 widens its role
    #: (preview/commit); Phase 3 only guards "apply+persist" vs "evict".
    write_mutex: threading.RLock = field(default_factory=threading.RLock, repr=False)
    #: monotonic timestamp of the last registry access; the idle sweeper
    #: (Task 11) evicts sessions whose last_access is older than the TTL.
    last_access: float = field(default_factory=time.monotonic, repr=False)
```

- [ ] **Step 4: Rewrite SessionRegistry with loader + evict hook + init-once**

In `src/data_rover/api/session.py`, replace the body of `class SessionRegistry` (keep the docstring, update it) so it reads:

```python
class SessionRegistry:
    """Holds one live :class:`Session` per project id, hydrated on first access.

    On a cache-miss ``get`` calls the injected ``loader`` (Phase 3:
    ``hydration.hydrate_session``) under a per-project init-once lock so two
    concurrent requests for a cold project hydrate exactly once. ``evict`` runs
    the injected ``evict_hook`` (Phase 3: snapshot-then-drop) before removing the
    session. With no loader installed the registry falls back to an empty
    ``Session`` — the pre-Phase-3 behaviour used by unit tests that don't need
    persistence."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._loader: Callable[[str], Session] | None = None
        self._evict_hook: Callable[[str, Session], None] | None = None
        self._guard = threading.Lock()  # protects _sessions + per-key locks
        self._key_locks: dict[str, threading.Lock] = {}

    def set_loader(self, loader: Callable[[str], Session] | None) -> None:
        self._loader = loader

    def set_evict_hook(self, hook: Callable[[str, Session], None] | None) -> None:
        self._evict_hook = hook

    def get(self, project_id: str) -> Session:
        # fast path: already warm
        with self._guard:
            session = self._sessions.get(project_id)
            if session is not None:
                session.last_access = time.monotonic()
                return session
            key_lock = self._key_locks.setdefault(project_id, threading.Lock())
        # hydrate outside the global guard, but serialized per project id so a
        # cold project is built exactly once (init-once guard, spec §11).
        with key_lock:
            with self._guard:
                session = self._sessions.get(project_id)
                if session is not None:
                    session.last_access = time.monotonic()
                    return session
            session = self._loader(project_id) if self._loader else Session()
            session.last_access = time.monotonic()
            with self._guard:
                self._sessions[project_id] = session
            return session

    def evict(self, project_id: str) -> None:
        with self._guard:
            session = self._sessions.pop(project_id, None)
        if session is None:
            return
        # snapshot under the session's write-mutex so eviction can't race an
        # in-flight commit (spec §11 evict-during-commit guard).
        with session.write_mutex:
            if self._evict_hook is not None:
                self._evict_hook(project_id, session)

    def touch(self, project_id: str) -> None:
        with self._guard:
            session = self._sessions.get(project_id)
            if session is not None:
                session.last_access = time.monotonic()

    def idle(self, now: float, ttl: float) -> list[str]:
        with self._guard:
            return [
                pid
                for pid, s in self._sessions.items()
                if now - s.last_access >= ttl
            ]

    def reset(self) -> None:
        with self._guard:
            self._sessions.clear()
            self._key_locks.clear()

    def project_ids(self) -> list[str]:
        with self._guard:
            return list(self._sessions)
```

- [ ] **Step 5: Add the persistent-registry installer**

At the bottom of `src/data_rover/api/session.py`, after `reset_session`, add:

```python
def install_persistent_registry() -> None:
    """Wire the process-global registry to durable hydration + snapshot-evict.

    Called at app startup (and by the API test conftest). Kept here — not at
    import time — so importing ``session`` never pulls in the storage/DB stack
    (``hydration`` imports both); unit tests that want the empty-Session
    fallback simply don't call this."""
    from .hydration import hydrate_session, write_snapshot

    def _evict(project_id: str, sess: Session) -> None:
        if sess.model is not None:
            write_snapshot(project_id, sess, sess.model_rev)

    _registry.set_loader(hydrate_session)
    _registry.set_evict_hook(_evict)
```

- [ ] **Step 6: Wire the conftest**

In `tests/api/conftest.py`, extend the imports and the `_fresh_db` fixture:

```python
from data_rover.api.session import (  # noqa: E402
    DEFAULT_PROJECT_ID,
    install_persistent_registry,
    reset_session,
)
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store  # noqa: E402
```

Force idle-evict off near the top, beside the other env defaults:

```python
os.environ.setdefault("DATA_ROVER_SNAPSHOT_STORE", "memory")
os.environ.setdefault("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
```

In `_fresh_db`, after `reset_session()`:

```python
    set_snapshot_store(MemorySnapshotStore())
    install_persistent_registry()  # get() now hydrates from the (empty) DB
```

and in the `finally:` after the second `reset_session()`:

```python
        set_snapshot_store(None)
```

- [ ] **Step 7: Run the registry tests + the full api suite**

Run: `pixi run -e core-dev pytest tests/api/test_session_registry.py tests/api -q`
Expected: PASS. The whole `tests/api` suite stays green: contentless projects hydrate to empty sessions, identical to before.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/session.py tests/api/conftest.py tests/api/test_session_registry.py
git commit -m "feat(api): hydrate-on-miss registry with write-mutex + snapshot-on-evict"
```

---

### Task 8: Persist commits in POST /model/ops + undo-as-commit

Append a durable commit per accepted batch and bump the DB `model_rev`, all under the session write-mutex; rebuild the journal contract for undo as an appended compensating commit. The in-memory op_log stays (fast undo within a warm session); the DB journal is the durable truth that hydration replays.

**Files:**
- Modify: `src/data_rover/api/routes/ops.py`
- Test: `tests/api/test_ops_persistence.py` (create)

**Interfaces:**
- Consumes: `content.append_commit`/`set_model_rev`/`get_model_row` (Task 5), `hydration.serialize_ops` (Task 6), `get_current_user` (identity), `get_db`.
- Produces: durable `Commit` rows; `models.model_rev` advanced in lockstep with `session.model_rev`.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_ops_persistence.py`:

```python
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.main import create_app
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    c.post(papi("/model/upload"), content=b'{"elements":[],"relationships":[]}',
           headers=AUTH_HEADERS)
    return c


def _concrete_type(c: TestClient) -> str:
    mm = c.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    for et in mm["elements"]:  # Metamodel serializes its types under "elements"
        if not et.get("abstract"):
            return et["name"]
    raise AssertionError


def test_ops_batch_persists_a_commit_and_bumps_db_rev() -> None:
    c = _client()
    t = _concrete_type(c)
    base = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
    r = c.post(
        papi("/model/ops"),
        json={"base_rev": base, "ops": [
            {"kind": "create_element", "temp_id": "tmp_1", "type_name": t,
             "properties": {}}]},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200
    new_rev = r.json()["model_rev"]
    with db.db_session() as s:
        assert content.get_model_row(s, "default").model_rev == new_rev
        tail = content.commits_after(s, "default", base)
        assert len(tail) == 1 and tail[0].ops[0]["kind"] == "create_element"


def test_undo_appends_compensating_commit_and_advances_rev() -> None:
    c = _client()
    t = _concrete_type(c)
    base = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
    c.post(papi("/model/ops"),
           json={"base_rev": base, "ops": [
               {"kind": "create_element", "temp_id": "tmp_1", "type_name": t,
                "properties": {}}]},
           headers=AUTH_HEADERS)
    u = c.post(papi("/model/undo"), headers=AUTH_HEADERS)
    assert u.status_code == 200
    assert u.json()["model_rev"] == base + 2  # forward, not back
    with db.db_session() as s:
        revs = [cmt.rev for cmt in content.commits_after(s, "default", base)]
        assert revs == [base + 1, base + 2]  # apply + compensating undo
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_ops_persistence.py -q`
Expected: FAIL (no commit rows persisted; undo rev goes back / no DB row).

- [ ] **Step 3: Add a persistence helper to ops.py**

In `src/data_rover/api/routes/ops.py`, add imports:

```python
from fastapi import Request
from sqlalchemy.orm import Session as DbSession

from ..db import get_db
from ..identity import get_current_user
from ..db_models import User
from .. import content
from ..hydration import serialize_ops
import uuid
```

Add a helper above `apply_ops`:

```python
def _persist_commit(
    db: DbSession,
    project_id: str,
    *,
    rev: int,
    author_id: str | None,
    res: "_BatchResult",
) -> None:
    """Append the accepted batch to the durable journal and advance model_rev.

    Only persists when the project actually has a durable model row (the
    interactive/legacy in-memory-only flows have none yet — they persist a
    baseline via the load/upload routes in Task 9). Keeps DB model_rev in
    lockstep with the just-bumped session.model_rev."""
    if content.get_model_row(db, project_id) is None:
        return
    content.append_commit(
        db, project_id, rev=rev, commit_id=uuid.uuid4().hex, author_id=author_id,
        ops=serialize_ops(res.canonical_ops),
        inverse_ops=serialize_ops(res.inverse_ops()),
        id_map=dict(res.id_map),
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
```

- [ ] **Step 4: Persist in apply_ops under the write-mutex**

In `src/data_rover/api/routes/ops.py`, change `apply_ops`'s signature and the apply block. Replace the handler with:

```python
@router.post("/model/ops", response_model=None)
def apply_ops(
    payload: OpsRequest,
    project_id: str,
    request: Request,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OpsResponse | JSONResponse:
    _, model = require_model(session)
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={
                "detail": (
                    f"base_rev {payload.base_rev} does not match current "
                    f"model_rev {session.model_rev}"
                ),
                "model_rev": session.model_rev,
            },
        )
    state = _ensure_validation_seeded(session, model)
    if not payload.ops:
        return OpsResponse(model_rev=session.model_rev, issue_counts=state.counts())
    with session.write_mutex:
        res = _apply_batch(model, payload.ops, restore=False)
        session.model_rev += 1
        session.record_batch(
            AppliedBatch(
                ops=res.canonical_ops,
                inverse_ops=res.inverse_ops(),
                id_map=dict(res.id_map),
            )
        )
        _persist_commit(
            db, project_id, rev=session.model_rev, author_id=user.id, res=res
        )
        return _finalize(session, state, model, res)
```

- [ ] **Step 5: Make undo append a compensating commit**

In `src/data_rover/api/routes/ops.py`, replace the `undo` handler with:

```python
@router.post("/model/undo", response_model=None)
def undo(
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OpsResponse | JSONResponse:
    _, model = require_model(session)
    if not session.op_log:
        return JSONResponse(
            status_code=409,
            content={"detail": "Nothing to undo", "model_rev": session.model_rev},
        )
    state = _ensure_validation_seeded(session, model)
    with session.write_mutex:
        batch = session.op_log.pop()
        try:
            res = _apply_batch(model, batch.inverse_ops, restore=True)
        except Exception:
            session.op_log.append(batch)  # _apply_batch already rolled back
            raise
        session.model_rev += 1
        # append-only journal: the undo is a NEW forward commit whose ops are
        # the inverse batch, so hydration replays to the post-undo state and
        # model_rev moves up (Phase 8 revert reuses this shape).
        _persist_undo_commit(db, project_id, rev=session.model_rev,
                             author_id=user.id, applied=res)
        return _finalize(session, state, model, res)
```

and add its helper beside `_persist_commit`:

```python
def _persist_undo_commit(
    db: DbSession, project_id: str, *, rev: int, author_id: str | None,
    applied: "_BatchResult",
) -> None:
    """Record an undo as a forward compensating commit (append-only journal).

    ``applied`` is the result of applying the inverse batch: its canonical_ops
    ARE the ops that reproduce the undo on replay, and its inverse_ops redo the
    original change."""
    if content.get_model_row(db, project_id) is None:
        return
    content.append_commit(
        db, project_id, rev=rev, commit_id=uuid.uuid4().hex, author_id=author_id,
        ops=serialize_ops(applied.canonical_ops),
        inverse_ops=serialize_ops(applied.inverse_ops()),
        id_map=dict(applied.id_map),
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
```

- [ ] **Step 6: Run the new + existing ops tests**

Run: `pixi run -e core-dev pytest tests/api/test_ops_persistence.py tests/api/test_ops.py -q`
Expected: PASS. (Existing `test_ops.py` stays green: when a project has no model row — most ops unit tests upload a model only into the session via the legacy snapshot route — `_persist_commit` early-returns; tests that use `/model/upload` get persistence.)

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/ops.py tests/api/test_ops_persistence.py
git commit -m "feat(api): durable commit journal for /model/ops + undo-as-commit"
```

---

### Task 9: Persist metamodel / view / model-baseline on the upload routes

The interactive load/upload/snapshot routes now write durable content so a project survives eviction. `metamodel` upload persists the blob + binds the model row; `view` snapshot persists the view blob; `model` load/upload persists a fresh baseline snapshot.

**Files:**
- Modify: `src/data_rover/api/routes/metamodel.py`
- Modify: `src/data_rover/api/routes/view.py`
- Modify: `src/data_rover/api/routes/model.py`
- Test: `tests/api/test_persistence_roundtrip.py` (create)

**Interfaces:**
- Consumes: `content.*`, `hydration.persist_baseline`, `get_db`, `get_current_user`, `require_model`.
- Produces: after upload, the project hydrates to the same model after a forced `evict`.

- [ ] **Step 1: Write the failing roundtrip test**

Create `tests/api/test_persistence_roundtrip.py`:

```python
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_registry
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def test_upload_survives_eviction_via_hydration() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    c.post(papi("/model/upload"), content=MODEL.encode(), headers=AUTH_HEADERS)
    before = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()

    get_registry().evict("default")  # snapshot-then-drop

    after = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()  # re-hydrates
    assert after["element_count"] == before["element_count"]
    assert after["relationship_count"] == before["relationship_count"]
    assert after["model_rev"] == before["model_rev"]


def test_view_persists_across_eviction() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    c.post(papi("/model/upload"), content=MODEL.encode(), headers=AUTH_HEADERS)
    c.put(papi("/view/snapshot"),
          json={"name": "My View", "folders": []}, headers=AUTH_HEADERS)

    get_registry().evict("default")

    v = c.get(papi("/view"), headers=AUTH_HEADERS).json()
    assert v["view"]["name"] == "My View"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_persistence_roundtrip.py -q`
Expected: FAIL (after eviction the re-hydrated session is empty / 404).

- [ ] **Step 3: Persist the metamodel on upload**

In `src/data_rover/api/routes/metamodel.py`, rewrite `upload_metamodel` to persist the blob and bind the model row. Add imports:

```python
from fastapi import Depends
from sqlalchemy.orm import Session as DbSession

from ..db import get_db
from .. import content
```

Replace `upload_metamodel`:

```python
@router.post("/metamodel")
async def upload_metamodel(
    request: Request,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> Metamodel:
    body = (await request.body()).decode("utf-8")
    content_type = request.headers.get("content-type", "")
    if "json" in content_type:
        import yaml as _yaml  # local: keep top-level import set unchanged

        data = await request.json() if body else {}
        blob = _yaml.safe_dump(data)
    else:
        blob = body
    metamodel = load_metamodel_str(blob)
    session.set_metamodel(metamodel)  # clears the in-memory model (core semantics)
    # persist the metamodel + (re)bind the project's model row; changing the
    # metamodel clears the model, so drop durable history too (Phase 6 will
    # replace this destructive swap with a non-destructive rebind).
    # Metamodel has no name field (only enums/elements/relationships); the row
    # name is cosmetic, leave it "".
    mm_row = content.create_metamodel(db, name="", version=1, blob=blob)
    content.upsert_model_row(db, project_id, metamodel_id=mm_row.id)
    content.clear_history(db, project_id)
    content.set_model_rev(db, project_id, session.model_rev)
    db.commit()
    return metamodel
```

- [ ] **Step 4: Persist the model baseline on load/upload**

In `src/data_rover/api/routes/model.py`, change `_install_model` to also persist a baseline, and thread the DB session + author through the two callers. Add imports:

```python
from sqlalchemy.orm import Session as DbSession

from ..db import get_db
from ..identity import get_current_user
from ..db_models import User
from .. import content
from ..hydration import persist_baseline
```

Change `_install_model` to take `db`, `project_id`, `author_id` and persist after install:

```python
def _install_model(
    session: Session,
    metamodel: Metamodel,
    raw: Any,
    *,
    db: DbSession,
    project_id: str,
    author_id: str | None,
) -> ModelSummary:
    model = build_model_from_dicts(metamodel, raw)
    state = ValidationState()
    state.set_full(default_pipeline().validate(model, Scope.all()))
    session.set_model(model, validation=state)
    # make this uploaded model the durable baseline, but only if the project
    # has a model row (i.e. its metamodel was persisted) — pure in-memory unit
    # tests that skip the metamodel route keep working with no persistence.
    if content.get_model_row(db, project_id) is not None:
        persist_baseline(project_id, session, author_id=author_id)
    return model_summary(session)
```

Update `load_model` and `upload_model_body` signatures to inject `db`/`user`/`project_id` and pass them through. For `load_model`:

```python
@router.post("/model/load", dependencies=[Depends(require_allowed_origin)])
def load_model(
    payload: LoadModelRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ModelSummary:
    metamodel = require_metamodel(session)
    path = Path(payload.path)
    if not path.is_file():
        raise HTTPException(status_code=422, detail=f"Not a readable file: {payload.path!r}")
    try:
        with path.open(encoding="utf-8") as f:
            raw = json.load(f)
    except OSError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid JSON in {payload.path!r}: {exc}") from exc
    return _install_model(session, metamodel, raw, db=db, project_id=project_id, author_id=user.id)
```

For `upload_model_body`:

```python
@router.post("/model/upload", dependencies=[Depends(require_allowed_origin)])
async def upload_model_body(
    request: Request,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ModelSummary:
    metamodel = require_metamodel(session)
    body = await request.body()
    try:
        raw = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=422, detail=f"Request body is not valid JSON: {exc}") from exc
    return _install_model(session, metamodel, raw, db=db, project_id=project_id, author_id=user.id)
```

- [ ] **Step 5: Persist the view on snapshot**

In `src/data_rover/api/routes/view.py`, persist the view blob. Add imports:

```python
from sqlalchemy.orm import Session as DbSession

from ..db import get_db
from .. import content
```

Update `snapshot_view`:

```python
@router.put("/view/snapshot")
def snapshot_view(
    payload: ViewIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ViewSnapshotResponse:
    _, model = require_model(session)
    try:
        view = payload.to_core()
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid view: {exc}") from exc
    session.view = view
    if content.get_model_row(db, project_id) is not None:
        content.upsert_single_view(db, project_id, name=view.name, blob=view.model_dump_json())
        db.commit()
    warnings = [IssueOut.from_core(i) for i in validate_view(view, model)]
    return ViewSnapshotResponse(view=ViewOut.from_core(view), warnings=warnings)
```

- [ ] **Step 6: Run the roundtrip + full api suite**

Run: `pixi run -e core-dev pytest tests/api/test_persistence_roundtrip.py tests/api -q`
Expected: PASS (roundtrip works; suite stays green).

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/metamodel.py src/data_rover/api/routes/view.py src/data_rover/api/routes/model.py tests/api/test_persistence_roundtrip.py
git commit -m "feat(api): persist metamodel/view/model baseline on upload routes"
```

---

### Task 10: Importer + CLI

A one-shot importer turning new-format artifacts into a project's `rev 0` baseline (`Metamodel` + `Project` + `Model` + rev-0 commit + snapshot), with a `python -m data_rover.api.importer` CLI. Reused by the dev-seed (Task 11).

> **Note (spec deviation):** spec §12 says "extend the migration CLI"; the importer is placed in `api/importer.py` instead because it depends on the api/db/storage layer, which the core `migration` package must not import. The migration CLI remains the *format converter*; this importer is the *DB loader* that consumes its (or any new-format) output.

**Files:**
- Create: `src/data_rover/api/importer.py`
- Test: `tests/api/test_importer.py` (create)

**Interfaces:**
- Consumes: `tenancy.create_project`/`upsert_user`, `content.*`, `hydration.write_snapshot`, `load_metamodel_str`, `build_model_from_dicts`, `Session`.
- Produces: `import_project(*, project_id, name, owner_id, metamodel_yaml, model_json, view_json=None) -> None` and `main(argv=None) -> int`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_importer.py`:

```python
from __future__ import annotations

from pathlib import Path

from data_rover.api import content, db, hydration, importer
from data_rover.api.db_models import Project, User
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")
VIEW = Path("examples/smart-city.view.json").read_text(encoding="utf-8")


def _env():
    db.init_engine("sqlite://", force=True)
    db.create_all()
    set_snapshot_store(MemorySnapshotStore())


def test_import_creates_project_baseline_and_hydrates() -> None:
    _env()
    try:
        importer.import_project(
            project_id="proj", name="Smart City", owner_id="u1",
            metamodel_yaml=MM, model_json=MODEL, view_json=VIEW,
        )
        with db.db_session() as s:
            assert s.get(Project, "proj") is not None
            assert s.get(User, "u1") is not None
            assert content.get_model_row(s, "proj").model_rev == 0
            assert content.latest_snapshot(s, "proj").rev == 0
        sess = hydration.hydrate_session("proj")
        assert sess.model is not None and len(sess.model.elements) > 0
        assert sess.view is not None
    finally:
        set_snapshot_store(None)


def test_import_is_idempotent_noop_when_project_exists() -> None:
    _env()
    try:
        importer.import_project(
            project_id="proj", name="Smart City", owner_id="u1",
            metamodel_yaml=MM, model_json=MODEL,
        )
        importer.import_project(  # second call must not raise or duplicate
            project_id="proj", name="Smart City", owner_id="u1",
            metamodel_yaml=MM, model_json=MODEL,
        )
        with db.db_session() as s:
            assert content.get_model_row(s, "proj").model_rev == 0
    finally:
        set_snapshot_store(None)
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_importer.py -q`
Expected: FAIL (`ModuleNotFoundError: data_rover.api.importer`).

- [ ] **Step 3: Implement importer.py**

Create `src/data_rover/api/importer.py`:

```python
"""Import new-format artifacts (metamodel.yaml + model.json + view.json) as a
project's durable rev-0 baseline. Reused by the dev-seed and runnable as a CLI:

    python -m data_rover.api.importer --project-id default --name "Smart City" \
        --owner-id default-user --metamodel examples/smart-city.metamodel.yaml \
        --model examples/smart-city.model.json --view examples/smart-city.view.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.view.schema import View

from . import content, tenancy
from .db import db_session, init_engine
from .db_models import Membership, Project, Role
from .hydration import write_snapshot
from .routes._snapshot import build_model_from_dicts
from .session import Session
from .settings import get_settings


def import_project(
    *,
    project_id: str,
    name: str,
    owner_id: str,
    metamodel_yaml: str,
    model_json: str,
    view_json: str | None = None,
) -> None:
    """Create the project baseline. Idempotent: no-op if the project exists."""
    with db_session() as s:
        if s.get(Project, project_id) is not None:
            return  # already imported
        tenancy.upsert_user(s, owner_id, "")
        s.add(Project(id=project_id, name=name))
        s.add(Membership(user_id=owner_id, project_id=project_id, role=Role.owner))
        mm_row = content.create_metamodel(
            s, name=name, version=1, blob=metamodel_yaml
        )
        content.upsert_model_row(s, project_id, metamodel_id=mm_row.id)
        content.append_commit(
            s, project_id, rev=0, commit_id="import", author_id=owner_id,
            ops=[], inverse_ops=[], id_map={},
        )
        content.set_model_rev(s, project_id, 0)
        if view_json is not None:
            view = View.model_validate_json(view_json)
            content.upsert_single_view(
                s, project_id, name=view.name, blob=view.model_dump_json()
            )

    # build the model + write the rev-0 snapshot (outside the txn above; the
    # commit/model rows are already durable and the snapshot row is its own).
    metamodel = load_metamodel_str(metamodel_yaml)
    model = build_model_from_dicts(metamodel, json.loads(model_json))
    sess = Session(metamodel=metamodel, model=model)
    sess.model_rev = 0
    write_snapshot(project_id, sess, 0)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Import an MBSE project baseline.")
    p.add_argument("--project-id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--owner-id", required=True)
    p.add_argument("--metamodel", required=True, type=Path)
    p.add_argument("--model", required=True, type=Path)
    p.add_argument("--view", type=Path, default=None)
    args = p.parse_args(argv)

    init_engine(get_settings().database_url)
    import_project(
        project_id=args.project_id,
        name=args.name,
        owner_id=args.owner_id,
        metamodel_yaml=args.metamodel.read_text(encoding="utf-8"),
        model_json=args.model.read_text(encoding="utf-8"),
        view_json=args.view.read_text(encoding="utf-8") if args.view else None,
    )
    print(f"Imported project {args.project_id!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_importer.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/importer.py tests/api/test_importer.py
git commit -m "feat(api): project importer + CLI (rev-0 baseline)"
```

---

### Task 11: Wire main.py — store + loader at startup, dev-seed example, idle sweeper

Bring it together at app boot: build+install the snapshot store and the persistent registry, have the dev-seed import the smart-city example, and run a lifespan-scoped idle-eviction sweeper (off when `idle_evict_seconds <= 0`).

**Files:**
- Modify: `src/data_rover/api/main.py`
- Test: `tests/api/test_eviction.py` (create), `tests/api/test_dev_seed_example.py` (create)

**Interfaces:**
- Consumes: `storage.build_store_from_settings`/`set_snapshot_store`, `session.install_persistent_registry`, `session.get_registry`, `importer.import_project`.
- Produces: `_idle_sweep_once(now: float) -> list[str]` (testable single-pass evictor); the running app installs the store/loader and seeds the example.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_eviction.py`:

```python
from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from data_rover.api import main
from data_rover.api.main import create_app
from data_rover.api.session import get_registry
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def test_idle_sweep_evicts_and_snapshots_stale_sessions() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    c.post(papi("/model/upload"), content=MODEL.encode(), headers=AUTH_HEADERS)
    assert "default" in get_registry().project_ids()

    # sweep far in the future -> session is stale -> evicted (snapshot taken)
    evicted = main._idle_sweep_once(now=time.monotonic() + 10_000, ttl=1.0)
    assert "default" in evicted
    assert "default" not in get_registry().project_ids()

    # data survives: next request re-hydrates from the snapshot
    s = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()
    assert s["element_count"] > 0


def test_idle_sweep_keeps_fresh_sessions() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    c.post(papi("/model/upload"), content=MODEL.encode(), headers=AUTH_HEADERS)
    assert main._idle_sweep_once(now=time.monotonic(), ttl=10_000.0) == []
```

Create `tests/api/test_dev_seed_example.py`:

```python
from __future__ import annotations

import os

from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.main import create_app
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store


def test_dev_seed_imports_smart_city_example(monkeypatch) -> None:
    monkeypatch.setenv("DATA_ROVER_DATABASE_URL", "sqlite://")
    monkeypatch.setenv("DATA_ROVER_DEV_SEED", "true")
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_STORE", "memory")
    monkeypatch.setenv("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
    db.init_engine("sqlite://", force=True)
    set_snapshot_store(MemorySnapshotStore())
    try:
        c = TestClient(create_app())
        headers = {"x-user-id": "default-user", "x-user-email": "dev@example.com"}
        s = c.get("/api/v1/projects/default/model/summary", headers=headers).json()
        assert s["element_count"] > 0  # the example model is loaded
    finally:
        set_snapshot_store(None)
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_eviction.py tests/api/test_dev_seed_example.py -q`
Expected: FAIL (`AttributeError: _idle_sweep_once`; dev-seed has no model).

- [ ] **Step 3: Rewrite main.py**

Rewrite `src/data_rover/api/main.py` to install the store/loader, seed the example, and run the sweeper. Replace the top imports and `_ensure_dev_seed`/`create_app`/module tail:

```python
from __future__ import annotations

import threading
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import importer
from .db import create_all, get_db, init_engine
from .db_models import Membership, Project, Role, User
from .errors import register_exception_handlers
from .routes import (
    change_request, elements, health, metamodel, model, ops, projects,
    read, relationships, validation, view,
)
from .session import get_registry, install_persistent_registry
from .settings import get_settings
from .storage import build_store_from_settings, set_snapshot_store

DEV_USER_ID = "default-user"
DEV_PROJECT_ID = "default"
_EXAMPLES = Path(__file__).resolve().parents[3] / "examples"


def _ensure_dev_seed(database_url: str) -> None:
    """SQLite/dev only: create the schema and import the smart-city example as
    the ``default`` project so the single-user frontend opens a real model.

    Idempotent (the importer no-ops if the project exists). Gated by
    ``settings.dev_seed`` — MUST be false in production."""
    if database_url.startswith("sqlite"):
        create_all()
    importer.import_project(
        project_id=DEV_PROJECT_ID,
        name="Smart City",
        owner_id=DEV_USER_ID,
        metamodel_yaml=(_EXAMPLES / "smart-city.metamodel.yaml").read_text("utf-8"),
        model_json=(_EXAMPLES / "smart-city.model.json").read_text("utf-8"),
        view_json=(_EXAMPLES / "smart-city.view.json").read_text("utf-8"),
    )


def _idle_sweep_once(now: float, ttl: float) -> list[str]:
    """Evict (snapshot-then-drop) every session idle for >= ttl. Returns the
    evicted project ids. Pure single-pass — the background loop calls this on a
    timer; tests call it directly with a controlled ``now``."""
    reg = get_registry()
    stale = reg.idle(now=now, ttl=ttl)
    for pid in stale:
        reg.evict(pid)
    return stale


def _start_idle_sweeper(ttl: float) -> tuple[threading.Thread, threading.Event]:
    stop = threading.Event()

    def _loop() -> None:
        interval = max(1.0, ttl / 4)
        while not stop.wait(interval):
            with suppress(Exception):  # a sweep failure must not kill the loop
                _idle_sweep_once(now=time.monotonic(), ttl=ttl)

    t = threading.Thread(target=_loop, name="idle-sweeper", daemon=True)
    t.start()
    return t, stop


def create_app() -> FastAPI:
    settings = get_settings()
    init_engine(settings.database_url)
    set_snapshot_store(build_store_from_settings(settings))
    install_persistent_registry()
    if settings.dev_seed:
        _ensure_dev_seed(settings.database_url)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        thread = stop = None
        if settings.idle_evict_seconds > 0:
            thread, stop = _start_idle_sweeper(float(settings.idle_evict_seconds))
        try:
            yield
        finally:
            if stop is not None:
                stop.set()
            if thread is not None:
                thread.join(timeout=2.0)

    app = FastAPI(
        title="data-rover API",
        version="0.1.0",
        description="HTTP surface for the data-rover MBSE metamodel engine.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_exception_handlers(app)
    app.include_router(health.router)
    app.include_router(projects.router, prefix="/api/v1", tags=["projects"])
    proj = "/api/v1/projects/{project_id}"
    app.include_router(metamodel.router, prefix=proj, tags=["metamodel"])
    app.include_router(model.router, prefix=proj, tags=["model"])
    app.include_router(ops.router, prefix=proj, tags=["ops"])
    app.include_router(read.router, prefix=proj, tags=["read"])
    app.include_router(change_request.router, prefix=proj, tags=["change-request"])
    app.include_router(elements.router, prefix=proj, tags=["elements"])
    app.include_router(relationships.router, prefix=proj, tags=["relationships"])
    app.include_router(validation.router, prefix=proj, tags=["validation"])
    app.include_router(view.router, prefix=proj, tags=["view"])
    return app


app = create_app()
```

(`_EXAMPLES`: `parents[3]` resolves `src/data_rover/api/main.py` → repo root. Verify the depth and adjust if the test fails to find `examples/`.)

- [ ] **Step 4: Run the new tests + full api suite**

Run: `pixi run -e core-dev pytest tests/api/test_eviction.py tests/api/test_dev_seed_example.py tests/api -q`
Expected: PASS. (The autouse `_fresh_db` keeps `DATA_ROVER_DEV_SEED=false` and `IDLE_EVICT_SECONDS=0` for the rest of the suite, so the sweeper never starts and the default project stays contentless except where a test uploads.)

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/main.py tests/api/test_eviction.py tests/api/test_dev_seed_example.py
git commit -m "feat(api): install store+loader, dev-seed example, idle-evict sweeper"
```

---

### Task 12: Alembic migration for the content tables

Postgres owns its schema via Alembic; add the `0002` migration creating the five content tables, matching the ORM exactly.

**Files:**
- Create: `alembic/versions/0002_content_tables.py`
- Test: `tests/api/test_alembic.py` (extend)

**Interfaces:**
- Consumes: the `0001_initial` revision (down_revision).
- Produces: tables `metamodels`, `models`, `views`, `commits`, `snapshots`.

- [ ] **Step 1: Inspect the existing migration head**

Run: `pixi run -e core-dev python -c "import pathlib; print(pathlib.Path('alembic/versions/0001_initial.py').read_text()[:600])"`
Expected: shows `revision = "0001"` (note the exact id string + import style to mirror).

- [ ] **Step 2: Extend the alembic test**

`tests/api/test_alembic.py` runs the real `command.upgrade` against a temp-file SQLite db and round-trips a downgrade-to-base (see its existing `test_migration_creates_all_tables`). Mirror that exact harness — append:

```python
def test_migration_creates_content_tables(tmp_path: Path) -> None:
    db_path = tmp_path / "t2.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")

    engine = create_engine(url)
    content = {"metamodels", "models", "views", "commits", "snapshots"}
    assert content <= set(inspect(engine).get_table_names())

    command.downgrade(cfg, "base")
    assert not content & set(inspect(engine).get_table_names())
```

(`Path`, `Config`, `command`, `create_engine`, `inspect`, `REPO_ROOT` are already imported at the top of the file.)

- [ ] **Step 3: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_alembic.py -q`
Expected: FAIL (content tables absent after upgrade).

- [ ] **Step 4: Write the migration**

Create `alembic/versions/0002_content_tables.py`:

```python
"""content tables (metamodels, models, views, commits, snapshots)

Revision ID: 0002
Revises: 0001
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "metamodels",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, server_default=""),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("blob", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "models",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "metamodel_id",
            sa.String(),
            sa.ForeignKey("metamodels.id"),
            nullable=False,
        ),
        sa.Column("name", sa.String(), nullable=False, server_default="model"),
        sa.Column("model_rev", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "views",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(), nullable=False, server_default=""),
        sa.Column("blob", sa.Text(), nullable=False),
    )
    op.create_table(
        "commits",
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("rev", sa.Integer(), primary_key=True),
        sa.Column("commit_id", sa.String(), nullable=False),
        sa.Column(
            "author_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ops", sa.JSON(), nullable=False),
        sa.Column("inverse_ops", sa.JSON(), nullable=False),
        sa.Column("id_map", sa.JSON(), nullable=False),
    )
    op.create_table(
        "snapshots",
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("rev", sa.Integer(), primary_key=True),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("snapshots")
    op.drop_table("commits")
    op.drop_table("views")
    op.drop_table("models")
    op.drop_table("metamodels")
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_alembic.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add alembic/versions/0002_content_tables.py tests/api/test_alembic.py
git commit -m "feat(api): Alembic 0002 — content tables"
```

---

### Task 13: Lint, typecheck, full suite, and docs

Final green-up + document Phase 3 in CLAUDE.md.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run the full backend test suite**

Run: `pixi run -e core-dev pytest tests -q`
Expected: PASS (the `integration`-marked GCS test is deselected via `addopts`).

- [ ] **Step 2: Lint + typecheck everything**

Run: `pixi run tidy`
Expected: ruff (with `--fix`), mypy, and pyright all pass. Fix any findings (common ones here: unused imports left after route rewrites; `Mapped[list]`/`Mapped[dict]` may need `Mapped[list[Any]]`/`Mapped[dict[str, Any]]` for mypy — adjust the ORM annotations and re-run).

- [ ] **Step 3: Document Phase 3 in CLAUDE.md**

In `CLAUDE.md`, under the "### Tenancy & auth" section (after the Phase 2 bullet list), add a new subsection:

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Phase 3 durable persistence"
```

---

## Self-Review notes (for the implementer)

Verified against the codebase while writing this plan (use as-is):
- `Metamodel.elements: list[ElementType]` is the public collection; each
  `ElementType` has `.name` / `.abstract`. `Metamodel` has **no** `name` field.
  `GET /metamodel` serializes types under the JSON key `"elements"`.
- `schemas.ModelSummary` / `read.model_summary` expose `model_rev`,
  `element_count`, `relationship_count` — the names used in Tasks 8/9/11.
- `tests/api/test_alembic.py` drives real `command.upgrade`/`downgrade` against a
  temp-file SQLite db with `REPO_ROOT`/`Config`/`command` already imported.

Still confirm at implementation time:
- **`_EXAMPLES` path depth** in `main.py` (Task 11): `parents[3]` from
  `src/data_rover/api/main.py` should reach the repo root; verify when the
  dev-seed test runs and correct the index if `examples/` isn't found.
- **mypy on `Mapped[list]`/`Mapped[dict]`** (Task 4): if mypy complains about bare
  generics, widen to `Mapped[list[Any]]` / `Mapped[dict[str, Any]]` (Task 13).
- **`pytest.ini` `addopts`** (Task 3): the repo's `pytest.ini` already sets
  `pythonpath=src`/`testpaths`; merge `-m "not integration"` into the existing
  `addopts` rather than overwriting it.
```
