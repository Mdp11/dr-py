# Artefacts Phase 2 — View as First-Class Content (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The view (folder overlay) becomes first-class committable content: folders gain stable uuid ids, a fine-grained `view.*` op family flows through `POST /commits` (journaled, diffable, undoable), `ViewRow` gains `view_rev`, per-folder `folder:` leases gate concurrent edits, and two long-standing bugs (root artifacts dropped by `ViewOut`, no dangling-artifact-ref warnings) are fixed along the way.

**Architecture:** One journal, materialized heads (spec: `docs/superpowers/specs/2026-07-29-artefacts-revamp-design.md`, Phase 2 section). View ops join the `OpIn` union and are applied by a new `api/view_ops.py` to the in-memory `session.view` (with exact inverses), then the whole blob is persisted to `ViewRow` on the same DB transaction as the `Commit` row — never through the model applier. Model hydration replay SKIPS view ops (the view hydrates from its row); the journal is read for history, diffs, and undo only. Folder identity migration is lazy: hydration and the legacy `PUT /view/snapshot` assign ids to blobs lacking them — the only Alembic migration is the `view_rev` column.

**Tech Stack:** Python 3.14, FastAPI, SQLAlchemy 2.0 (sync), pydantic v2, Alembic, pytest (hermetic in-memory SQLite via `tests/api/conftest.py`).

## Global Constraints

- All commands go through pixi: tests `pixi run -e core-dev pytest <path> -v`, full suite `pixi run core-test`, lint `pixi run backend-lint` for the API package and `pixi run core-lint` for core (ruff + mypy + pyright — ALL must pass), format `pixi run dr-tidy`.
- **Backend only.** Do not touch anything under `frontend/`. The frontend keeps using whole-document `PUT /view/snapshot` until the follow-up frontend plan lands; both write paths must stay consistent (both bump `view_rev`, both normalize folder ids). This plan DEFINES the wire contract (`view.*` op shapes, `folder:` lock type, `view` scope) that the frontend plan will mirror into `ops.ts` — do not "improve" field names mid-implementation; they are load-bearing for two plans.
- **One Alembic migration** (`0009`, `view_rev` on `views`). Folder ids are blob content — NO migration for them (lazy assignment, spec Phase 2).
- **Root addressing:** the view root is addressed by the fixed id `VIEW_ROOT_ID = "root"` (`core/view/schema.py`, Task 1). Artifact placements may target the root (`View.artifacts`); element placements may NOT (an element with no placement renders at the root — "at root" is the *absence* of a placement, so "move an element to root" is `remove_element`).
- **Op semantics that mirror the live frontend** (verified against `frontend/src/lib/state/view-ops.ts` before this plan was written): element order inside a folder is user-meaningful (placement ops carry `index`); sibling-folder order is not user-controlled (the tree renders alphabetically) but `index` is still carried and concretized so inverses restore byte-identical blobs; an element may sit in at most ONE folder; an artifact ref may sit in MANY folders (but at most once per folder).
- **No per-op OCC precondition on view ops.** The lease is the concurrency control (same stance the client already takes for `UpdateArtifactOp.artifact_rev`, which it deliberately never sends); the generalized conflict backstop is the safety net.
- **Off-limits files** (STOP and report if you believe you must edit them): `src/data_rover/core/model/model.py`, `src/data_rover/core/metamodel/schema.py`, `src/data_rover/core/validation/pipeline.py`, `src/data_rover/api/routes/elements.py`, `src/data_rover/api/routes/relationships.py`.
- **Never** add view-op branches to `routes/ops.py::_apply_one` — it stays model-only (its `assert_never` over `ModelOpIn` enforces this at type-check time).
- Preserve the dense-docstring style: new modules explain *why* invariants exist.
- Do not delete or weaken any existing test. If an existing test fails after your change, the change is wrong — fix the change, not the test. (Exception: tests that assert the OLD 2-tuple `split_ops` return shape are updated in Task 4, where the shape change is the deliverable.)
- Every commit message follows the repo style (`feat(api): ...`, `feat(core): ...`, `test(api): ...`) and ends with the Co-Authored-By line from the repo instructions.

## Guardrail Protocol (applies to every task)

1. Write the failing test FIRST, run it, and confirm it fails for the expected reason (missing symbol / 404 / wrong status), not an import typo.
2. After implementation, run the task's named tests AND `pixi run -e core-dev pytest tests/api tests/view -q`. Expected: all pass.
3. Run `pixi run backend-lint` (and `pixi run core-lint` when core files changed). Expected: zero errors. If pyright flags a missing union branch or a 2-vs-3 tuple unpack, that is the plan working as intended — fix the site it names (never silence with `# type: ignore`).
4. Commit at the end of every task. Never batch two tasks into one commit.
5. **CHECKPOINT tasks** (3, 6, 7, 10, 11) additionally run `pixi run core-test`. If anything unrelated fails, STOP — do not proceed to the next task; report the failure.
6. If you are blocked, confused, or an instruction contradicts what you find in the code, STOP and report rather than improvising.

---

### Task 1: Core folder identity

`Folder` gains a stable `id`; a new `core/view/ids.py` owns id assignment and id-addressed traversal. Everything downstream (ops, leases, diffs) keys on these ids.

**Files:**
- Modify: `src/data_rover/core/view/schema.py`
- Create: `src/data_rover/core/view/ids.py`
- Test: `tests/view/test_folder_ids.py`

**Interfaces:**
- Consumes: `Folder`, `View` (existing core pydantic models).
- Produces (used by Tasks 3, 5, 6, and the frontend plan):
  - `VIEW_ROOT_ID: str = "root"` (in `schema.py`)
  - `Folder.id: str = ""` (empty string = "not yet assigned", the lazy-migration marker)
  - `ensure_folder_ids(view: View) -> bool` — assign uuid4-hex ids where missing/duplicate/reserved; True if anything changed
  - `iter_folders(view: View) -> Iterator[Folder]` — DFS pre-order over all folders
  - `find_folder(view: View, folder_id: str) -> Folder | None`
  - `locate_folder(view: View, folder_id: str) -> tuple[View | Folder, int] | None` — (parent node, index in `parent.folders`)
  - `folder_subtree(view: View | None, folder_id: str) -> list[str]` — `folder_id` + all descendant folder ids; `[folder_id]` when the view is None or the id is unknown

- [ ] **Step 1: Write the failing tests**

```python
# tests/view/test_folder_ids.py
"""Folder identity (artefacts revamp Phase 2): ids are assigned lazily, never
reassigned once present, and the reserved root id / duplicates are healed.
`ensure_folder_ids` is the ONE assignment path — hydration, the legacy PUT and
the importer all call it, so these tests pin the healing rules for all three."""

from __future__ import annotations

from data_rover.core.view.ids import (
    ensure_folder_ids,
    find_folder,
    folder_subtree,
    iter_folders,
    locate_folder,
)
from data_rover.core.view.schema import VIEW_ROOT_ID, Folder, View


def _view() -> View:
    return View(
        name="v",
        folders=[
            Folder(
                name="A",
                folders=[Folder(name="A1"), Folder(name="A2")],
                elements=["e1"],
            ),
            Folder(name="B"),
        ],
    )


def test_old_blob_parses_with_empty_ids() -> None:
    v = View.model_validate({"name": "v", "folders": [{"name": "A"}]})
    assert v.folders[0].id == ""


def test_ensure_assigns_ids_everywhere_and_reports_change() -> None:
    v = _view()
    assert ensure_folder_ids(v) is True
    ids = [f.id for f in iter_folders(v)]
    assert len(ids) == 4
    assert all(len(i) == 32 for i in ids)  # uuid4().hex
    assert len(set(ids)) == 4


def test_ensure_is_idempotent_and_preserves_existing_ids() -> None:
    v = _view()
    ensure_folder_ids(v)
    before = [f.id for f in iter_folders(v)]
    assert ensure_folder_ids(v) is False
    assert [f.id for f in iter_folders(v)] == before


def test_ensure_heals_duplicates_and_reserved_root_id() -> None:
    v = View(
        name="v",
        folders=[
            Folder(id="dup", name="A"),
            Folder(id="dup", name="B"),
            Folder(id=VIEW_ROOT_ID, name="C"),
        ],
    )
    assert ensure_folder_ids(v) is True
    ids = [f.id for f in v.folders]
    assert ids[0] == "dup"  # first occurrence keeps its id
    assert ids[1] != "dup" and ids[2] != VIEW_ROOT_ID
    assert len(set(ids)) == 3


def test_find_and_locate() -> None:
    v = _view()
    ensure_folder_ids(v)
    a = v.folders[0]
    a1 = a.folders[0]
    assert find_folder(v, a1.id) is a1
    assert find_folder(v, "missing") is None
    parent, idx = locate_folder(v, a1.id)  # type: ignore[misc]
    assert parent is a and idx == 0
    parent, idx = locate_folder(v, a.id)  # type: ignore[misc]
    assert parent is v and idx == 0
    assert locate_folder(v, "missing") is None


def test_folder_subtree() -> None:
    v = _view()
    ensure_folder_ids(v)
    a = v.folders[0]
    sub = folder_subtree(v, a.id)
    assert sub[0] == a.id
    assert set(sub) == {a.id, a.folders[0].id, a.folders[1].id}
    assert folder_subtree(v, "missing") == ["missing"]
    assert folder_subtree(None, "x") == ["x"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/view/test_folder_ids.py -v`
Expected: FAIL with `ImportError` (`data_rover.core.view.ids` does not exist).

- [ ] **Step 3: Implement**

In `src/data_rover/core/view/schema.py`, add above `Folder`:

```python
#: Fixed id addressing the view ROOT in id-addressed operations (view ops,
#: folder leases). The root is the View itself, not a Folder row in the blob —
#: this constant only exists so "place at root" / "root membership lease" have
#: a stable resource id. `ensure_folder_ids` reassigns any real folder that
#: claims it.
VIEW_ROOT_ID = "root"
```

and on `Folder`:

```python
    #: Stable identity (uuid4 hex), assigned lazily by
    #: `core.view.ids.ensure_folder_ids` — old blobs parse with "" and are
    #: healed at their next hydration/save. Once assigned, an id is never
    #: rewritten: view ops, folder leases and view diffs all key on it.
    id: str = ""
```

Update `Folder`'s class docstring: identity within a view is now its `id`; the name-path sentence stays as a description of the LEGACY addressing that `validate_view`'s duplicate-name warnings still reference.

Create `src/data_rover/core/view/ids.py`:

```python
"""Folder identity helpers (artefacts revamp Phase 2).

Folder ids are assigned LAZILY: old blobs parse with ``Folder.id == ""`` and
are healed by ``ensure_folder_ids`` at hydration / legacy-PUT / import time —
there is deliberately no Alembic migration for blob content. This module is
the one place assignment and id-addressed traversal live so the API layer
(op applier, lock-scope expansion) cannot grow a second, subtly different
walk. All functions are pure over the core ``View``.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

from .schema import VIEW_ROOT_ID, Folder, View


def iter_folders(view: View) -> Iterator[Folder]:
    """All folders, DFS pre-order (parents before children)."""
    stack: list[Folder] = list(reversed(view.folders))
    while stack:
        f = stack.pop()
        yield f
        stack.extend(reversed(f.folders))


def ensure_folder_ids(view: View) -> bool:
    """Assign a uuid4-hex id to every folder lacking a usable one.

    "Usable" excludes three shapes: empty (an un-migrated blob), a duplicate
    of an id already seen this walk (first occurrence wins — ops addressed at
    the survivor keep working), and the reserved ``VIEW_ROOT_ID`` (a folder
    claiming the root's address would shadow root placements). Returns True
    if anything was (re)assigned so callers know to persist the blob back.
    """
    changed = False
    seen: set[str] = set()
    for f in iter_folders(view):
        if not f.id or f.id == VIEW_ROOT_ID or f.id in seen:
            f.id = uuid.uuid4().hex
            changed = True
        seen.add(f.id)
    return changed


def find_folder(view: View, folder_id: str) -> Folder | None:
    for f in iter_folders(view):
        if f.id == folder_id:
            return f
    return None


def locate_folder(view: View, folder_id: str) -> tuple[View | Folder, int] | None:
    """(parent node, index in ``parent.folders``) for *folder_id*, or None.

    The parent of a top-level folder is the ``View`` itself — callers translate
    that back to ``VIEW_ROOT_ID`` when they need a resource id.
    """
    def walk(parent: View | Folder) -> tuple[View | Folder, int] | None:
        for i, child in enumerate(parent.folders):
            if child.id == folder_id:
                return parent, i
            found = walk(child)
            if found is not None:
                return found
        return None

    return walk(view)


def folder_subtree(view: View | None, folder_id: str) -> list[str]:
    """*folder_id* + all transitive descendant folder ids (pre-order).

    Falls back to ``[folder_id]`` when the view is absent or the id unknown:
    lock-scope expansion must stay total (a lease request on a just-deleted
    folder degrades to a single-resource lock rather than raising)."""
    if view is None:
        return [folder_id]
    root = find_folder(view, folder_id)
    if root is None:
        return [folder_id]
    out: list[str] = []
    stack = [root]
    while stack:
        f = stack.pop()
        out.append(f.id)
        stack.extend(reversed(f.folders))
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/view/test_folder_ids.py tests/view -v`
Expected: PASS (including the pre-existing `tests/view` files — `Folder.id` defaults keep old shapes parsing).

- [ ] **Step 5: Lint and commit**

Run: `pixi run core-lint` — expect clean.

```bash
git add src/data_rover/core/view/schema.py src/data_rover/core/view/ids.py tests/view/test_folder_ids.py
git commit -m "feat(core): folder identity — Folder.id + lazy assignment helpers"
```

---

### Task 2: View wire round-trip + dangling-artifact-ref warnings (folded-in bug fixes)

Two bugs the spec folds into Phase 2: `ViewOut` silently drops root-level `View.artifacts`, and `validate_view` never checks artifact refs. Also: the wire schemas start carrying folder ids so the (Task 3) normalized ids actually reach clients.

**Files:**
- Modify: `src/data_rover/api/schemas.py` (`FolderOut`, `ViewOut`, `ViewIn`)
- Modify: `src/data_rover/core/view/validation.py` (`validate_view`)
- Modify: `src/data_rover/api/routes/view.py` (pass known artifact ids)
- Test: `tests/view/test_validation.py` (extend), `tests/api/test_view_routes.py` (extend)

**Interfaces:**
- Consumes: `ArtifactRefOut` (existing, `schemas.py`), `content.list_artifacts(db, project_id)` (existing; check its exact signature in `content.py` — it may take a `kind` filter with a default).
- Produces:
  - `FolderOut.id: str = ""` (mirrored from core)
  - `ViewOut.artifacts: list[ArtifactRefOut]`, `ViewIn.artifacts: list[ArtifactRefOut] = []`
  - `validate_view(view: View, model: Model, *, known_artifact_ids: Collection[str] | None = None) -> list[Issue]` — `None` skips artifact-ref checks (core stays DB-free; the importer and pure-core callers pass nothing)

- [ ] **Step 1: Write the failing tests**

Append to `tests/view/test_validation.py` (reuse its existing model/metamodel fixtures — read the file first and follow its local helper conventions):

```python
def test_dangling_artifact_ref_warns() -> None:
    view = View(
        name="v",
        folders=[
            Folder(name="F", artifacts=[ArtifactRef(id="a-live", kind="table")])
        ],
        artifacts=[ArtifactRef(id="a-gone", kind="navigation")],
    )
    model = _empty_model()  # use/adapt this file's existing model helper
    issues = validate_view(view, model, known_artifact_ids={"a-live"})
    msgs = [i.message for i in issues]
    assert any("unknown artifact 'a-gone'" in m for m in msgs)
    assert not any("a-live" in m for m in msgs)


def test_artifact_refs_skipped_without_known_set() -> None:
    view = View(name="v", artifacts=[ArtifactRef(id="a-gone", kind="table")])
    issues = validate_view(view, _empty_model())
    assert not any("unknown artifact" in i.message for i in issues)
```

Append to `tests/api/test_view_routes.py` (follow its existing `client` fixture conventions):

```python
def test_root_artifacts_round_trip(client: TestClient) -> None:
    body = {
        "name": "v",
        "folders": [{"name": "F"}],
        "artifacts": [{"id": "a1", "kind": "table"}],
    }
    r = client.put(papi("/view/snapshot"), json=body)
    assert r.status_code == 200, r.text
    assert r.json()["view"]["artifacts"] == [{"id": "a1", "kind": "table"}]
    r = client.get(papi("/view"))
    assert r.json()["view"]["artifacts"] == [{"id": "a1", "kind": "table"}]


def test_dangling_artifact_ref_warning_from_route(client: TestClient) -> None:
    body = {"name": "v", "folders": [], "artifacts": [{"id": "nope", "kind": "table"}]}
    r = client.put(papi("/view/snapshot"), json=body)
    assert r.status_code == 200
    assert any("unknown artifact" in w["message"] for w in r.json()["warnings"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/view/test_validation.py tests/api/test_view_routes.py -v`
Expected: the new tests FAIL — `validate_view` rejects the keyword, and the route response has no root `artifacts` key.

- [ ] **Step 3: Implement**

`schemas.py` — `FolderOut` gains `id: str = ""` (and `from_core` maps `folder.id`); `ViewOut` gains `artifacts: list[ArtifactRefOut] = Field(default_factory=list)` with `from_core` mapping `view.artifacts`; `ViewIn` gains the same field (its `to_core` already round-trips via `model_dump`). Add a comment on `ViewOut.artifacts`: root-level refs were silently dropped before Phase 2 — this field is the fix, additive so old clients ignore it.

`core/view/validation.py` — new signature:

```python
def validate_view(
    view: View,
    model: Model,
    *,
    known_artifact_ids: Collection[str] | None = None,
) -> list[Issue]:
```

Inside, add a check reused for both folder-level and root-level refs (root path label `"'/'"`, matching the existing duplicate-folder wording):

```python
    def check_artifacts(refs: list[ArtifactRef], where: str) -> None:
        if known_artifact_ids is None:
            return
        for ref in refs:
            if ref.id not in known_artifact_ids:
                issues.append(
                    Issue(
                        Severity.WARNING,
                        (
                            f"view {view.name!r}: {where} references "
                            f"unknown artifact {ref.id!r}; renderers skip it"
                        ),
                    )
                )
```

Call `check_artifacts(folder.artifacts, f"folder {path!r}")` inside `visit`, and `check_artifacts(view.artifacts, "the view root")` at the end. Extend the docstring's warning list.

`routes/view.py` — both `snapshot_view` and `get_view` compute the known set and pass it:

```python
known = {row.id for row in content.list_artifacts(db, project_id)}
warnings = [
    IssueOut.from_core(i)
    for i in validate_view(view, model, known_artifact_ids=known)
]
```

`get_view` needs new `project_id: str` and `db: DbSession = Depends(get_db)` parameters (mirror `snapshot_view`'s).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/view tests/api/test_view_routes.py -v`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `pixi run backend-lint && pixi run core-lint`

```bash
git add src/data_rover/api/schemas.py src/data_rover/core/view/validation.py src/data_rover/api/routes/view.py tests/view/test_validation.py tests/api/test_view_routes.py
git commit -m "fix(api): root artifacts round-trip + dangling artifact-ref warnings"
```

---

### Task 3: `view_rev` + lazy folder-id migration (CHECKPOINT)

`ViewRow` gains the rev its blob reflects; every write path bumps it; every load/save path heals missing folder ids.

**Files:**
- Modify: `src/data_rover/api/db_models.py` (`ViewRow`)
- Create: `alembic/versions/0009_view_rev.py`
- Modify: `src/data_rover/api/content.py` (`upsert_single_view`)
- Modify: `src/data_rover/api/routes/view.py` (normalize ids on PUT; surface `view_rev`)
- Modify: `src/data_rover/api/schemas.py` (`ViewSnapshotResponse.view_rev`, `ViewStateResponse.view_rev`)
- Modify: `src/data_rover/api/hydration.py` (heal ids on hydrate, persist back)
- Modify: `src/data_rover/api/importer.py` (assign ids at import)
- Test: `tests/api/test_view_routes.py` (extend), `tests/api/test_hydration.py` (extend), `tests/api/test_alembic.py` (only if it enumerates revisions — check first)

**Interfaces:**
- Consumes: `ensure_folder_ids` (Task 1).
- Produces:
  - `ViewRow.view_rev: Mapped[int]` (default 0)
  - `content.upsert_single_view(db, project_id, *, name: str, blob: str, bump_rev: bool = True) -> ViewRow` — `bump_rev=False` is for NORMALIZATION writes (id healing), which must not look like edits
  - `ViewSnapshotResponse.view_rev: int` and `ViewStateResponse.view_rev: int | None` on the wire

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_view_routes.py`:

```python
def test_put_assigns_folder_ids_and_bumps_view_rev(client: TestClient) -> None:
    body = {"name": "v", "folders": [{"name": "A", "folders": [{"name": "A1"}]}]}
    r = client.put(papi("/view/snapshot"), json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["view_rev"] == 1
    a = out["view"]["folders"][0]
    assert len(a["id"]) == 32 and len(a["folders"][0]["id"]) == 32

    # ids are STABLE across saves when the client echoes them back
    r2 = client.put(papi("/view/snapshot"), json=out["view"])
    assert r2.json()["view_rev"] == 2
    assert r2.json()["view"]["folders"][0]["id"] == a["id"]

    r3 = client.get(papi("/view"))
    assert r3.json()["view_rev"] == 2


def test_get_view_rev_none_without_row(client: TestClient) -> None:
    r = client.get(papi("/view"))
    assert r.status_code == 200
    assert r.json()["view"] is None and r.json()["view_rev"] is None
```

Append to `tests/api/test_hydration.py` (mirror its existing evict/rehydrate helpers — read the file first):

```python
def test_hydration_heals_missing_folder_ids(client: TestClient) -> None:
    """An old blob (no folder ids) is healed at hydration and persisted back
    WITHOUT consuming a view_rev — normalization is not an edit."""
    from data_rover.api import content, db
    from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry

    gen = db.get_db()
    s = next(gen)
    try:
        content.upsert_single_view(
            s,
            DEFAULT_PROJECT_ID,
            name="v",
            blob='{"name": "v", "folders": [{"name": "A"}], "artifacts": []}',
            bump_rev=False,
        )
        s.commit()
    finally:
        gen.close()

    get_registry().evict(DEFAULT_PROJECT_ID)
    r = client.get(papi("/view"))
    assert r.status_code == 200
    assert len(r.json()["view"]["folders"][0]["id"]) == 32
    assert r.json()["view_rev"] == 0

    gen = db.get_db()
    s = next(gen)
    try:
        row = content.get_single_view(s, DEFAULT_PROJECT_ID)
        assert row is not None and '"id"' in row.blob and row.view_rev == 0
    finally:
        gen.close()
```

(Adapt the eviction mechanics to what `test_eviction.py`/`test_hydration.py` already do — e.g. if eviction needs the write-mutex path or a registry accessor with a different name, use that; the assertion set is what matters.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_view_routes.py tests/api/test_hydration.py -v`
Expected: FAIL — no `view_rev` key in responses; healing not implemented.

- [ ] **Step 3: Implement**

`db_models.py`, on `ViewRow`:

```python
    #: Rev of the last EDIT reflected by ``blob`` (both write paths bump it:
    #: the legacy PUT and the view half of POST /commits — Phase 2). Secondary,
    #: informational: staleness/conflicts are governed by the project rev +
    #: leases, not this counter. Normalization writes (lazy folder-id healing)
    #: deliberately do NOT bump it.
    view_rev: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
```

`alembic/versions/0009_view_rev.py` (mirror `0008_project_artifacts.py`'s header/downgrade style):

```python
"""views.view_rev (artefacts revamp Phase 2)

Revision ID: 0009
Revises: 0008
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "views",
        sa.Column("view_rev", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("views", "view_rev")
```

`content.upsert_single_view`:

```python
def upsert_single_view(
    db: Session, project_id: str, *, name: str, blob: str, bump_rev: bool = True
) -> ViewRow:
    row = get_single_view(db, project_id)
    if row is None:
        row = ViewRow(
            id=uuid.uuid4().hex,
            project_id=project_id,
            name=name,
            blob=blob,
            view_rev=1 if bump_rev else 0,
        )
        db.add(row)
    else:
        row.name, row.blob = name, blob
        if bump_rev:
            row.view_rev += 1
    db.flush()
    return row
```

`routes/view.py::snapshot_view` — after `payload.to_core()`, call `ensure_folder_ids(view)` (unconditionally; idempotent for id-carrying documents), and capture the row to surface the rev:

```python
    session.view = view
    view_rev = 0
    if content.get_model_row(db, project_id) is not None:
        row = content.upsert_single_view(
            db, project_id, name=view.name, blob=view.model_dump_json()
        )
        db.commit()
        view_rev = row.view_rev
    ...
    return ViewSnapshotResponse(
        view=ViewOut.from_core(view), warnings=warnings, view_rev=view_rev
    )
```

`get_view` returns `view_rev=row.view_rev if row is not None else None` (it already has `db` from Task 2; `row = content.get_single_view(db, project_id)`). Schemas: `ViewSnapshotResponse.view_rev: int = 0`, `ViewStateResponse.view_rev: int | None = None`.

`hydration.py::_hydrate_session` — replace the blob-stash with parse-and-heal INSIDE the `with db_session() as s:` block (verify `db_session` commits on clean exit — read its definition in `db.py`; if it does not, add an explicit `s.commit()`):

```python
        view_row = content.get_single_view(s, project_id)
        view: View | None = None
        if view_row is not None:
            view = View.model_validate_json(view_row.blob)
            if ensure_folder_ids(view):
                # heal-and-persist: a pre-Phase-2 blob gets ids exactly once.
                # bump_rev=False — normalization is not an edit.
                content.upsert_single_view(
                    s,
                    project_id,
                    name=view.name,
                    blob=view.model_dump_json(),
                    bump_rev=False,
                )
```

and later `session.view = view` replaces the old `if view_blob is not None:` branch.

`importer.py` — after `View.model_validate_json(view_json)`, insert `ensure_folder_ids(view)` before the upsert, and pass `bump_rev=False` (a baseline import starts at rev 0, matching `model_rev=0`).

Check `tests/api/test_alembic.py` — if it walks revisions or asserts the head, update it to include `0009`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_view_routes.py tests/api/test_hydration.py tests/api/test_alembic.py tests/api/test_importer.py -v`
Expected: PASS.

- [ ] **Step 5: CHECKPOINT — full suite, lint, commit**

Run: `pixi run core-test && pixi run backend-lint`
Expected: everything green (the additive response fields must not break any existing view test).

```bash
git add src/data_rover/api/db_models.py alembic/versions/0009_view_rev.py src/data_rover/api/content.py src/data_rover/api/routes/view.py src/data_rover/api/schemas.py src/data_rover/api/hydration.py src/data_rover/api/importer.py tests/api
git commit -m "feat(api): ViewRow.view_rev + lazy folder-id healing on every load/save path"
```

---

### Task 4: View op schemas, 3-way `split_ops`, rejection sweep

The `view.*` family joins the wire union; `split_ops` returns three families; every legacy/side path explicitly rejects or skips view ops. After this task the type checker guarantees no code path can silently drop or misroute a view op.

**Files:**
- Modify: `src/data_rover/api/schemas.py` (op models, `ViewOpIn`, `OpIn`, `VIEW_OP_KINDS`)
- Modify: `src/data_rover/api/artifact_ops.py` (`split_ops` → 3-tuple)
- Modify: `src/data_rover/api/routes/ops.py` (`apply_ops` rejects view ops; `undo` gets a TEMPORARY guard)
- Modify: `src/data_rover/api/routes/commits.py` (TEMPORARY 422 guards in preview/create; `revert` refusal — permanent)
- Modify: `src/data_rover/api/routes/validation.py`, `src/data_rover/api/routes/snippets.py` (reject)
- Modify: `src/data_rover/api/hydration.py` (`replay_commits_into` skips view ops)
- Modify: `src/data_rover/api/commit_diff.py` (3-tuple unpacks only)
- Test: `tests/api/test_view_op_schemas.py` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces (the WIRE CONTRACT — the frontend plan mirrors these names/fields exactly into `ops.ts`):
  - Op models (all `kind`-discriminated, snake_case, creates carry `temp_id`):
    - `CreateFolderOp {kind: "create_folder", temp_id, parent_id, name, index: int | None}`
    - `RenameFolderOp {kind: "rename_folder", id, name}`
    - `MoveFolderOp {kind: "move_folder", id, to_parent_id, index: int | None}`
    - `DeleteFolderOp {kind: "delete_folder", id}`
    - `PlaceElementOp {kind: "place_element", element_id, folder_id, index: int | None}`
    - `RemoveElementOp {kind: "remove_element", element_id, folder_id}`
    - `MoveElementOp {kind: "move_element", element_id, from_folder_id, to_folder_id, index: int | None}`
    - `PlaceArtifactOp {kind: "place_artifact", artifact_id, artifact_kind: str, folder_id, index: int | None}`
    - `RemoveArtifactOp {kind: "remove_artifact", artifact_id, folder_id}`
    - `MoveArtifactOp {kind: "move_artifact", artifact_id, from_folder_id, to_folder_id, index: int | None}`
  - `ViewOpIn` union of the ten; `OpIn = Annotated[ModelOpIn | ArtifactOpIn | ViewOpIn, Field(discriminator="kind")]`
  - `VIEW_OP_KINDS: frozenset[str]` (in `schemas.py`, next to the union — unlike `ARTIFACT_OP_KINDS` it cannot live with its applier because Task 4 lands before the applier exists, and `schemas` is import-cycle-free from everywhere)
  - `split_ops(ops) -> tuple[list[ModelOpIn], list[ArtifactOpIn], list[ViewOpIn]]`

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_view_op_schemas.py
"""Wire-contract tests for the view.* op family: discriminated-union
round-trip through OPS_ADAPTER (the durable journal format), the 3-way
split, and the legacy-path rejections. These pin the field names the
frontend plan will mirror into ops.ts — renames here are contract breaks."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.artifact_ops import split_ops
from data_rover.api.schemas import (
    OPS_ADAPTER,
    VIEW_OP_KINDS,
    CreateElementOp,
    CreateArtifactOp,
    PlaceElementOp,
)

from .conftest import papi

RAW_VIEW_OPS = [
    {"kind": "create_folder", "temp_id": "tmp_f1", "parent_id": "root", "name": "A"},
    {"kind": "rename_folder", "id": "f1", "name": "B"},
    {"kind": "move_folder", "id": "f1", "to_parent_id": "f2", "index": 0},
    {"kind": "delete_folder", "id": "f1"},
    {"kind": "place_element", "element_id": "e1", "folder_id": "f1", "index": 2},
    {"kind": "remove_element", "element_id": "e1", "folder_id": "f1"},
    {
        "kind": "move_element",
        "element_id": "e1",
        "from_folder_id": "f1",
        "to_folder_id": "f2",
        "index": None,
    },
    {
        "kind": "place_artifact",
        "artifact_id": "a1",
        "artifact_kind": "table",
        "folder_id": "root",
        "index": 0,
    },
    {"kind": "remove_artifact", "artifact_id": "a1", "folder_id": "root"},
    {
        "kind": "move_artifact",
        "artifact_id": "a1",
        "from_folder_id": "root",
        "to_folder_id": "f1",
        "index": None,
    },
]


def test_union_round_trips_and_kinds_set_matches() -> None:
    ops = OPS_ADAPTER.validate_python(RAW_VIEW_OPS)
    assert [o.kind for o in ops] == [r["kind"] for r in RAW_VIEW_OPS]
    dumped = OPS_ADAPTER.dump_python(ops, mode="json")
    assert OPS_ADAPTER.validate_python(dumped) == ops
    assert VIEW_OP_KINDS == {r["kind"] for r in RAW_VIEW_OPS}


def test_split_ops_three_ways() -> None:
    ops = OPS_ADAPTER.validate_python(
        [
            {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node"},
            {
                "kind": "create_artifact",
                "temp_id": "tmp_a",
                "artifact_kind": "table",
                "name": "t",
                "payload": {},
            },
            *RAW_VIEW_OPS[:1],
        ]
    )
    model_ops, artifact_ops, view_ops = split_ops(ops)
    assert isinstance(model_ops[0], CreateElementOp)
    assert isinstance(artifact_ops[0], CreateArtifactOp)
    assert len(view_ops) == 1 and view_ops[0].kind == "create_folder"


def test_model_ops_route_rejects_view_ops(client: TestClient) -> None:
    r = client.post(
        papi("/model/ops"),
        json={"base_rev": 0, "ops": [RAW_VIEW_OPS[0]]},
    )
    assert r.status_code == 422
    assert "view ops" in r.json()["detail"]


def test_validate_route_rejects_view_ops(client: TestClient) -> None:
    r = client.post(
        papi("/model/validate"),
        json={"ops": [RAW_VIEW_OPS[0]]},
    )
    assert r.status_code == 422
```

The `client` fixture: copy the metamodel-seeding fixture pattern from `tests/api/test_commits_artifact_ops.py` (seed default project, upload a one-type metamodel and an empty model). Check `POST /model/validate`'s exact request shape in `routes/validation.py` before writing the second test (it may require more fields) and adapt.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_view_op_schemas.py -v`
Expected: FAIL — unknown discriminator values.

- [ ] **Step 3: Implement**

1. `schemas.py`: add the ten op models exactly as specified in Interfaces, after the artifact ops. Docstring notes to carry: `index` is "position among siblings, None = append; canonical stored ops always carry the concrete index" (on `CreateFolderOp.index`, referenced by the others); `PlaceArtifactOp.artifact_kind` is a plain `str` (not the artifact Literal) because view refs are tolerant danglers — a ref must outlive kind-registry evolution; `PlaceElementOp.folder_id` must be a real folder id, never `VIEW_ROOT_ID` (an unplaced element already renders at the root — enforced by the applier, Task 5). Then:

```python
#: View-content ops (Phase 2 artefacts revamp) — applied by api/view_ops.py to
#: the in-memory session.view, then the blob is persisted; never to the model.
ViewOpIn = (
    CreateFolderOp
    | RenameFolderOp
    | MoveFolderOp
    | DeleteFolderOp
    | PlaceElementOp
    | RemoveElementOp
    | MoveElementOp
    | PlaceArtifactOp
    | RemoveArtifactOp
    | MoveArtifactOp
)

OpIn = Annotated[ModelOpIn | ArtifactOpIn | ViewOpIn, Field(discriminator="kind")]

#: kind-tags of view ops, for raw journal dicts (mirrors ARTIFACT_OP_KINDS,
#: which lives with ITS applier; this one lives here because schemas is the
#: only module every consumer can import without cycles).
VIEW_OP_KINDS = frozenset(
    {
        "create_folder",
        "rename_folder",
        "move_folder",
        "delete_folder",
        "place_element",
        "remove_element",
        "move_element",
        "place_artifact",
        "remove_artifact",
        "move_artifact",
    }
)
```

2. `artifact_ops.py::split_ops` — 3-tuple:

```python
def split_ops(
    ops: Sequence[OpIn],
) -> tuple[list[ModelOpIn], list[ArtifactOpIn], list[ViewOpIn]]:
    """Separate a mixed batch into (model, artifact, view) ops, order-
    preserving within each family. The families are independent (payloads and
    placements may REFERENCE ids across families, but tolerantly), so relative
    cross-family order carries no meaning."""
    model_ops: list[ModelOpIn] = []
    artifact_ops: list[ArtifactOpIn] = []
    view_ops: list[ViewOpIn] = []
    for op in ops:
        if isinstance(op, (CreateArtifactOp, UpdateArtifactOp, DeleteArtifactOp)):
            artifact_ops.append(op)
        elif isinstance(
            op,
            (
                CreateFolderOp,
                RenameFolderOp,
                MoveFolderOp,
                DeleteFolderOp,
                PlaceElementOp,
                RemoveElementOp,
                MoveElementOp,
                PlaceArtifactOp,
                RemoveArtifactOp,
                MoveArtifactOp,
            ),
        ):
            view_ops.append(op)
        else:
            model_ops.append(op)
    return model_ops, artifact_ops, view_ops
```

3. Update EVERY call site (run `pixi run backend-lint` to let pyright enumerate them; the known set):
   - `routes/ops.py::apply_ops`: `model_ops, artifact_ops, view_ops = split_ops(payload.ops)`; extend the rejection: after the artifact 422, add
     ```python
     if view_ops:
         raise HTTPException(
             status_code=422,
             detail="view ops are not supported on /model/ops; use /commits",
         )
     ```
   - `routes/ops.py::undo`: `model_inv, artifact_inv, view_inv = split_ops(batch.inverse_ops)` plus a TEMPORARY guard right after (replaced in Task 8):
     ```python
     if view_inv:  # TEMPORARY (plan Task 8): no view commit exists yet to undo
         session.op_log.append(batch)
         raise HTTPException(status_code=500, detail="view undo not wired yet")
     ```
   - `routes/commits.py::preview_commit` and `create_commit`: 3-way unpack + TEMPORARY `if view_ops: raise HTTPException(422, "view ops are not yet supported here")` (both replaced in Task 7).
   - `routes/commits.py::_batch_touched_ids`: the widened `OpIn` union breaks its `assert_never` chain — add a TEMPORARY no-op branch over all ten view op types (`elif isinstance(op, (CreateFolderOp, RenameFolderOp, MoveFolderOp, DeleteFolderOp, PlaceElementOp, RemoveElementOp, MoveElementOp, PlaceArtifactOp, RemoveArtifactOp, MoveArtifactOp)): pass  # TEMPORARY (plan Task 9)`) so the chain stays closed; Task 9 replaces it with the real derivation.
   - `routes/commits.py::revert_commit`: 3-way unpack of the inverse split; PERMANENT refusal loop next to the artifact one (import `VIEW_OP_KINDS` from `..schemas`):
     ```python
     if any(op.get("kind") in VIEW_OP_KINDS for op in c.ops):
         return JSONResponse(
             status_code=409,
             content={
                 "detail": "revert across view changes is not yet supported",
                 "view_commit_rev": c.rev,
             },
         )
     ```
     and widen the post-split narrowing raise to `if artifact_combined or view_combined:` (same 500, message "artifact/view ops reached the revert applier"). Extend that raise's comment: an op's inverse is always in its own family, so the guards above prove both halves empty.
   - `routes/validation.py`: 3-way unpack; reject `view_ops` with the same 422 shape as its artifact rejection ("view ops are not supported on /model/validate; use /commits/preview").
   - `routes/snippets.py` (~line 342): 3-way unpack; extend the guest-proposed-op guard to refuse view ops too (the facade has no view surface either — same injection-channel stance; mirror the artifact guard's wording).
   - `hydration.py::replay_commits_into`: `ops, _artifact_ops, _view_ops = split_ops(...)` — extend the SKIP comment: view ops are also materialized-head content (`ViewRow`), replayed never.
   - `commit_diff.py::_artifact_states`: both unpacks become `_, inverse_artifact_ops, _ = split_ops(...)` / `_, forward_artifact_ops, _ = split_ops(...)`.
   - Any test asserting the 2-tuple shape (search `tests/` for `split_ops`): update the unpack.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_view_op_schemas.py tests/api -q`
Expected: PASS (whole api suite — the temporary guards must not trip any existing test, since nothing emits view ops yet).

- [ ] **Step 5: Lint and commit**

Run: `pixi run backend-lint` — pyright confirms no remaining 2-tuple unpacks.

```bash
git add src/data_rover/api tests/api
git commit -m "feat(api): view.* op family — wire schemas, 3-way split_ops, legacy-path rejections"
```

---

### Task 5: View op applier

`api/view_ops.py` — the in-memory twin of `artifact_ops.py`: applies a view-op batch to a `View` with exact inverses, rolls back via inverses, and validates dry for preview. The apply-then-inverse ⇒ byte-identical-blob invariant is what undo and the diff API lean on.

**Files:**
- Create: `src/data_rover/api/view_ops.py`
- Test: `tests/api/test_view_ops_apply.py`

**Interfaces:**
- Consumes: `VIEW_ROOT_ID`, `Folder`, `View`, `ArtifactRef` (core), `find_folder`/`locate_folder` (Task 1), `TEMP_ID_PREFIX` + the ten op models (Task 4).
- Produces (used by Tasks 7, 8, 9):
  - `ViewBatchResult` dataclass: `canonical_ops: list[ViewOpIn]`, `inverse_units: list[list[ViewOpIn]]`, `id_map: dict[str, str]`, method `inverse_ops() -> list[ViewOpIn]`
  - `apply_view_ops(view: View, ops: list[ViewOpIn], *, id_map: dict[str, str] | None = None, restore: bool = False) -> ViewBatchResult` — raises `HTTPException(422)` on impossible ops; mutates `view` in place
  - `rollback_view(view: View, inverse_units: list[list[ViewOpIn]]) -> None`
  - `validate_view_ops(view: View | None, ops: list[ViewOpIn]) -> None` — dry (deep-copy) apply
  - `view_op_folder_ids(ops: Sequence[ViewOpIn]) -> set[str]` — bare folder ids an op batch references (undo's peer-lease guard, Task 8)

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_view_ops_apply.py
"""View-op applier: apply/inverse symmetry (the invariant undo and the diff
API lean on — apply-then-inverse must restore a byte-identical blob), the
422 rules, id resolution, and restore mode."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from data_rover.api.schemas import (
    CreateFolderOp,
    DeleteFolderOp,
    MoveElementOp,
    MoveFolderOp,
    PlaceArtifactOp,
    PlaceElementOp,
    RemoveArtifactOp,
    RemoveElementOp,
    RenameFolderOp,
)
from data_rover.api.view_ops import (
    apply_view_ops,
    rollback_view,
    validate_view_ops,
    view_op_folder_ids,
)
from data_rover.core.view.ids import ensure_folder_ids, find_folder
from data_rover.core.view.schema import ArtifactRef, Folder, View


def _view() -> View:
    v = View(
        name="v",
        folders=[
            Folder(
                name="A",
                folders=[Folder(name="A1")],
                elements=["e1", "e2"],
                artifacts=[ArtifactRef(id="a1", kind="table")],
            ),
            Folder(name="B"),
        ],
        artifacts=[ArtifactRef(id="a2", kind="navigation")],
    )
    ensure_folder_ids(v)
    return v


def _ids(v: View) -> dict[str, str]:
    return {f.name: f.id for f in [*v.folders, *v.folders[0].folders]}


def test_apply_inverse_restores_byte_identical_blob() -> None:
    v = _view()
    f = _ids(v)
    before = v.model_dump_json()
    ops = [
        CreateFolderOp(kind="create_folder", temp_id="tmp_c", parent_id=f["B"], name="C"),
        RenameFolderOp(kind="rename_folder", id=f["A"], name="A-renamed"),
        PlaceElementOp(kind="place_element", element_id="e9", folder_id="tmp_c", index=0),
        MoveElementOp(
            kind="move_element",
            element_id="e1",
            from_folder_id=f["A"],
            to_folder_id=f["B"],
            index=None,
        ),
        MoveFolderOp(kind="move_folder", id=f["A1"], to_parent_id="root", index=0),
        PlaceArtifactOp(
            kind="place_artifact",
            artifact_id="a3",
            artifact_kind="code_snippet",
            folder_id="root",
            index=1,
        ),
        RemoveArtifactOp(kind="remove_artifact", artifact_id="a1", folder_id=f["A"]),
        DeleteFolderOp(kind="delete_folder", id=f["A"]),
    ]
    res = apply_view_ops(v, ops)
    assert v.model_dump_json() != before
    rollback_view(v, res.inverse_units)
    assert v.model_dump_json() == before


def test_canonical_ops_concretize_ids_and_indices() -> None:
    v = _view()
    f = _ids(v)
    res = apply_view_ops(
        v,
        [
            CreateFolderOp(kind="create_folder", temp_id="tmp_c", parent_id="root", name="C"),
            PlaceElementOp(kind="place_element", element_id="e9", folder_id="tmp_c", index=None),
        ],
    )
    created = res.canonical_ops[0]
    assert isinstance(created, CreateFolderOp)
    assert not created.temp_id.startswith("tmp_") and created.index == 2
    placed = res.canonical_ops[1]
    assert isinstance(placed, PlaceElementOp)
    assert placed.folder_id == created.temp_id == res.id_map["tmp_c"]
    assert placed.index == 0


def test_delete_folder_inverse_recreates_subtree() -> None:
    v = _view()
    f = _ids(v)
    before = v.model_dump_json()
    res = apply_view_ops(v, [DeleteFolderOp(kind="delete_folder", id=f["A"])])
    assert find_folder(v, f["A"]) is None
    # the single inverse unit replays parent-before-child with placements
    unit = res.inverse_units[0]
    kinds = [op.kind for op in unit]
    assert kinds[0] == "create_folder" and "place_element" in kinds
    rollback_view(v, res.inverse_units)
    assert v.model_dump_json() == before


def _expect_422(v: View, op, detail: str) -> None:
    with pytest.raises(HTTPException) as exc:
        apply_view_ops(v, [op])
    assert exc.value.status_code == 422
    assert detail in str(exc.value.detail)


def test_unknown_folder_422() -> None:
    _expect_422(
        _view(),
        RenameFolderOp(kind="rename_folder", id="missing", name="x"),
        "unknown folder",
    )


def test_place_element_at_root_422() -> None:
    _expect_422(
        _view(),
        PlaceElementOp(kind="place_element", element_id="e9", folder_id="root"),
        "cannot place an element at the view root",
    )


def test_place_already_placed_element_422() -> None:
    v = _view()
    f = _ids(v)
    _expect_422(
        v,
        PlaceElementOp(kind="place_element", element_id="e1", folder_id=f["B"]),
        "already placed",
    )


def test_remove_unplaced_element_422() -> None:
    v = _view()
    f = _ids(v)
    _expect_422(
        v,
        RemoveElementOp(kind="remove_element", element_id="e9", folder_id=f["A"]),
        "not placed",
    )


def test_move_folder_cycle_422() -> None:
    v = _view()
    f = _ids(v)
    with pytest.raises(HTTPException) as exc:
        apply_view_ops(
            v, [MoveFolderOp(kind="move_folder", id=f["A"], to_parent_id=f["A1"])]
        )
    assert exc.value.status_code == 422
    assert "own subtree" in str(exc.value.detail)


def test_mid_batch_failure_leaves_prefix_applied() -> None:
    """apply_view_ops does NOT roll itself back — mirrors _apply_batch's
    caller contract (Task 7 adds apply_view_ops_atomic for callers that want
    all-or-nothing). The pinned behavior: the applied prefix stays, and the
    exception fires on the offending op."""
    v = _view()
    f = _ids(v)
    ops = [
        RenameFolderOp(kind="rename_folder", id=f["B"], name="B2"),
        RenameFolderOp(kind="rename_folder", id="missing", name="boom"),
    ]
    with pytest.raises(HTTPException):
        apply_view_ops(v, ops)
    assert v.folders[1].name == "B2"


def test_restore_mode_reinstates_exact_ids_and_tolerates_duplicates() -> None:
    v = _view()
    f = _ids(v)
    res = apply_view_ops(v, [DeleteFolderOp(kind="delete_folder", id=f["A"])])
    # peer places e1 somewhere else after the delete
    apply_view_ops(
        v,
        [PlaceElementOp(kind="place_element", element_id="e1", folder_id=f["B"])],
    )
    # undo of the delete replays the recreate unit in restore mode: the
    # duplicate e1 placement is TOLERATED (validate_view warns; first wins)
    restored = apply_view_ops(v, res.inverse_units[0], restore=True)
    assert find_folder(v, f["A"]) is not None
    assert restored.canonical_ops[0].temp_id == f["A"]


def test_validate_view_ops_is_dry() -> None:
    v = _view()
    f = _ids(v)
    before = v.model_dump_json()
    validate_view_ops(v, [RenameFolderOp(kind="rename_folder", id=f["A"], name="x")])
    assert v.model_dump_json() == before
    with pytest.raises(HTTPException):
        validate_view_ops(v, [RenameFolderOp(kind="rename_folder", id="missing", name="x")])
    # None view validates against an empty view (the auto-create commit path)
    validate_view_ops(
        None,
        [CreateFolderOp(kind="create_folder", temp_id="tmp_x", parent_id="root", name="F")],
    )


def test_view_op_folder_ids() -> None:
    ops = [
        MoveElementOp(
            kind="move_element", element_id="e", from_folder_id="f1", to_folder_id="f2"
        ),
        CreateFolderOp(kind="create_folder", temp_id="tmp_c", parent_id="f3", name="x"),
    ]
    assert view_op_folder_ids(ops) == {"f1", "f2", "f3", "tmp_c"}
```

Note on the parametrized test: the `__A__`/`__B__` placeholder-patching shown is fiddly — if it fights you, unroll the parametrize into four plain test functions that build the view first and use real ids directly. The assertions are the contract, not the parametrization.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_view_ops_apply.py -v`
Expected: FAIL with `ImportError` (`data_rover.api.view_ops` does not exist).

- [ ] **Step 3: Implement `src/data_rover/api/view_ops.py`**

```python
"""View-op plumbing (Phase 2 artefacts revamp).

The view is a materialized head (``session.view`` in memory, ``ViewRow.blob``
durable), so view ops must never reach the model applier. This module is the
in-memory twin of ``artifact_ops``: ``apply_view_ops`` mutates a core ``View``
in place while collecting EXACT inverses — apply-then-inverse restores a
byte-identical blob, the invariant ``POST /model/undo`` and the commit-diff
API lean on. ``routes/commits.py`` is the write caller (apply under the write
mutex, persist the blob on the commit's DB transaction); ``routes/ops.py``'s
undo replays inverses in restore mode; ``/commits/preview`` validates dry.

Unlike the artifact applier there is no DB here at all: rollback is
``rollback_view`` (apply the collected inverse units in reverse), the same
in-place shape as ``routes/ops.py::_rollback``.

Tolerance stance (mirrors ``validate_view``): ids that merely DANGLE (an
element not in the model, an artifact with no row) are legal — the view never
owns what it references. 422 is reserved for ops that are IMPOSSIBLE against
the current tree: unknown folder ids, cycle moves, duplicate/missing
placements. Restore mode (undo) skips the duplicate-placement checks —
replaying accepted history over a peer-modified view degrades to a
first-placement-wins warning, never a failed undo — but still 422s on a
missing folder (the compensating commit must not silently half-apply).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import assert_never

from fastapi import HTTPException

from data_rover.core.view.ids import find_folder, locate_folder
from data_rover.core.view.schema import VIEW_ROOT_ID, ArtifactRef, Folder, View

from .schemas import (
    TEMP_ID_PREFIX,
    CreateFolderOp,
    DeleteFolderOp,
    MoveArtifactOp,
    MoveElementOp,
    MoveFolderOp,
    PlaceArtifactOp,
    PlaceElementOp,
    RemoveArtifactOp,
    RemoveElementOp,
    RenameFolderOp,
    ViewOpIn,
)


@dataclass
class ViewBatchResult:
    """Everything one view-op batch produced (twin of ArtifactBatchResult).

    ``inverse_units`` are per-op lists because delete_folder's inverse is a
    multi-op recreate of the whole subtree; every other op inverts 1:1."""

    canonical_ops: list[ViewOpIn] = field(default_factory=list)
    inverse_units: list[list[ViewOpIn]] = field(default_factory=list)
    id_map: dict[str, str] = field(default_factory=dict)

    def inverse_ops(self) -> list[ViewOpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
        return [op for unit in reversed(self.inverse_units) for op in unit]


def _422(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _require_folder(view: View, folder_id: str) -> Folder:
    f = find_folder(view, folder_id)
    if f is None:
        raise _422(f"unknown folder {folder_id!r}")
    return f


def _folders_container(view: View, container_id: str) -> View | Folder:
    """The node whose ``.folders`` list *container_id* names (root or folder)."""
    if container_id == VIEW_ROOT_ID:
        return view
    return _require_folder(view, container_id)


def _artifact_container(view: View, container_id: str) -> View | Folder:
    """The node whose ``.artifacts`` list *container_id* names. Artifacts,
    unlike elements, have a REAL root list (``View.artifacts``)."""
    if container_id == VIEW_ROOT_ID:
        return view
    return _require_folder(view, container_id)


def _container_id(node: View | Folder) -> str:
    return VIEW_ROOT_ID if isinstance(node, View) else node.id


def _clamped(index: int | None, length: int) -> int:
    if index is None:
        return length
    return max(0, min(index, length))


def _subtree_ids(folder: Folder) -> set[str]:
    """*folder*'s id + all descendant folder ids (the move-cycle check)."""
    out: set[str] = set()
    stack = [folder]
    while stack:
        f = stack.pop()
        out.add(f.id)
        stack.extend(f.folders)
    return out


def _element_home(view: View, element_id: str) -> Folder | None:
    """The folder holding *element_id*'s placement, if any (single-folder
    rule: an element sits in at most one folder)."""
    stack = list(view.folders)
    while stack:
        f = stack.pop()
        if element_id in f.elements:
            return f
        stack.extend(f.folders)
    return None


def _recreate_ops(folder: Folder, parent_id: str, index: int) -> list[ViewOpIn]:
    """Ops that rebuild *folder* (and its whole subtree) exactly, in an order
    replayable front-to-back: the folder first, then its own placements at
    exact indices, then children recursively. ``temp_id`` carries the REAL id
    — in restore mode the applier reinstates it verbatim."""
    ops: list[ViewOpIn] = [
        CreateFolderOp(
            kind="create_folder",
            temp_id=folder.id,
            parent_id=parent_id,
            name=folder.name,
            index=index,
        )
    ]
    for i, element_id in enumerate(folder.elements):
        ops.append(
            PlaceElementOp(
                kind="place_element",
                element_id=element_id,
                folder_id=folder.id,
                index=i,
            )
        )
    for i, ref in enumerate(folder.artifacts):
        ops.append(
            PlaceArtifactOp(
                kind="place_artifact",
                artifact_id=ref.id,
                artifact_kind=ref.kind,
                folder_id=folder.id,
                index=i,
            )
        )
    for i, child in enumerate(folder.folders):
        ops.extend(_recreate_ops(child, folder.id, i))
    return ops


def apply_view_ops(
    view: View,
    ops: list[ViewOpIn],
    *,
    id_map: dict[str, str] | None = None,
    restore: bool = False,
) -> ViewBatchResult:
    """Apply view ops to *view* in place, collecting exact inverses.

    ``id_map`` is seeded with the model/artifact halves' temp→canonical map so
    a placement may reference an element or artifact created earlier in the
    SAME batch; folder temp ids created here are added to the same map.
    Canonical ops always carry resolved ids and CONCRETE indices — the journal
    must replay deterministically with no reference to live state.

    There is NO internal rollback: a mid-batch failure leaves the already-
    applied prefix in place and the caller undoes it by applying the partial
    result's ``inverse_units`` in reverse (``rollback_view``), exactly the
    ``_apply_batch``/``_rollback`` contract the model applier uses.
    """
    res = ViewBatchResult(id_map=dict(id_map or {}))

    def rid(v: str) -> str:
        return res.id_map.get(v, v)

    for op in ops:
        if isinstance(op, CreateFolderOp):
            parent_id = rid(op.parent_id)
            container = _folders_container(view, parent_id)
            if op.temp_id.startswith(TEMP_ID_PREFIX):
                folder_id = uuid.uuid4().hex
                res.id_map[op.temp_id] = folder_id
            elif restore:
                folder_id = op.temp_id  # reinstate the exact id
                if find_folder(view, folder_id) is not None:
                    raise _422(f"a folder with id {folder_id!r} already exists")
            else:
                raise _422(
                    f"create_folder temp_id {op.temp_id!r} must start "
                    f"with {TEMP_ID_PREFIX!r}"
                )
            index = _clamped(op.index, len(container.folders))
            container.folders.insert(
                index, Folder(id=folder_id, name=op.name)
            )
            res.inverse_units.append(
                [DeleteFolderOp(kind="delete_folder", id=folder_id)]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={"temp_id": folder_id, "parent_id": parent_id, "index": index}
                )
            )
        elif isinstance(op, RenameFolderOp):
            folder = _require_folder(view, rid(op.id))
            res.inverse_units.append(
                [RenameFolderOp(kind="rename_folder", id=folder.id, name=folder.name)]
            )
            folder.name = op.name
            res.canonical_ops.append(op.model_copy(update={"id": folder.id}))
        elif isinstance(op, MoveFolderOp):
            folder_id = rid(op.id)
            to_parent_id = rid(op.to_parent_id)
            located = locate_folder(view, folder_id)
            if located is None:
                raise _422(f"unknown folder {folder_id!r}")
            old_container, old_index = located
            moving = old_container.folders[old_index]
            if to_parent_id != VIEW_ROOT_ID and to_parent_id in _subtree_ids(moving):
                raise _422("cannot move a folder into its own subtree")
            # resolve the destination BEFORE popping (an unknown destination
            # must not half-apply), but pop before computing the clamp so a
            # same-container move clamps against the post-removal length.
            dest = _folders_container(view, to_parent_id)
            old_container.folders.pop(old_index)
            index = _clamped(op.index, len(dest.folders))
            dest.folders.insert(index, moving)
            res.inverse_units.append(
                [
                    MoveFolderOp(
                        kind="move_folder",
                        id=moving.id,
                        to_parent_id=_container_id(old_container),
                        index=old_index,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={"id": moving.id, "to_parent_id": to_parent_id, "index": index}
                )
            )
        elif isinstance(op, DeleteFolderOp):
            folder_id = rid(op.id)
            located = locate_folder(view, folder_id)
            if located is None:
                raise _422(f"unknown folder {folder_id!r}")
            container, index = located
            folder = container.folders[index]
            res.inverse_units.append(
                _recreate_ops(folder, _container_id(container), index)
            )
            container.folders.pop(index)
            res.canonical_ops.append(op.model_copy(update={"id": folder_id}))
        elif isinstance(op, PlaceElementOp):
            element_id = rid(op.element_id)
            folder_id = rid(op.folder_id)
            if folder_id == VIEW_ROOT_ID:
                raise _422(
                    "cannot place an element at the view root; an unplaced "
                    "element already renders there (use remove_element)"
                )
            folder = _require_folder(view, folder_id)
            if not restore:
                home = _element_home(view, element_id)
                if home is not None:
                    raise _422(
                        f"element {element_id!r} is already placed in folder "
                        f"{home.id!r} (use move_element)"
                    )
            index = _clamped(op.index, len(folder.elements))
            folder.elements.insert(index, element_id)
            res.inverse_units.append(
                [
                    RemoveElementOp(
                        kind="remove_element",
                        element_id=element_id,
                        folder_id=folder.id,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "element_id": element_id,
                        "folder_id": folder.id,
                        "index": index,
                    }
                )
            )
        elif isinstance(op, RemoveElementOp):
            element_id = rid(op.element_id)
            folder = _require_folder(view, rid(op.folder_id))
            if element_id not in folder.elements:
                raise _422(
                    f"element {element_id!r} is not placed in folder {folder.id!r}"
                )
            old_index = folder.elements.index(element_id)
            folder.elements.pop(old_index)
            res.inverse_units.append(
                [
                    PlaceElementOp(
                        kind="place_element",
                        element_id=element_id,
                        folder_id=folder.id,
                        index=old_index,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(update={"element_id": element_id, "folder_id": folder.id})
            )
        elif isinstance(op, MoveElementOp):
            element_id = rid(op.element_id)
            src = _require_folder(view, rid(op.from_folder_id))
            dst = _require_folder(view, rid(op.to_folder_id))
            if element_id not in src.elements:
                raise _422(
                    f"element {element_id!r} is not placed in folder {src.id!r}"
                )
            old_index = src.elements.index(element_id)
            src.elements.pop(old_index)
            index = _clamped(op.index, len(dst.elements))
            dst.elements.insert(index, element_id)
            res.inverse_units.append(
                [
                    MoveElementOp(
                        kind="move_element",
                        element_id=element_id,
                        from_folder_id=dst.id,
                        to_folder_id=src.id,
                        index=old_index,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "element_id": element_id,
                        "from_folder_id": src.id,
                        "to_folder_id": dst.id,
                        "index": index,
                    }
                )
            )
        elif isinstance(op, PlaceArtifactOp):
            artifact_id = rid(op.artifact_id)
            folder_id = rid(op.folder_id)
            container = _artifact_container(view, folder_id)
            if not restore and any(r.id == artifact_id for r in container.artifacts):
                raise _422(
                    f"artifact {artifact_id!r} is already placed in {folder_id!r}"
                )
            index = _clamped(op.index, len(container.artifacts))
            container.artifacts.insert(
                index, ArtifactRef(id=artifact_id, kind=op.artifact_kind)
            )
            res.inverse_units.append(
                [
                    RemoveArtifactOp(
                        kind="remove_artifact",
                        artifact_id=artifact_id,
                        folder_id=_container_id(container),
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "artifact_id": artifact_id,
                        "folder_id": _container_id(container),
                        "index": index,
                    }
                )
            )
        elif isinstance(op, RemoveArtifactOp):
            artifact_id = rid(op.artifact_id)
            container = _artifact_container(view, rid(op.folder_id))
            pos = next(
                (i for i, r in enumerate(container.artifacts) if r.id == artifact_id),
                None,
            )
            if pos is None:
                raise _422(
                    f"artifact {artifact_id!r} is not placed in "
                    f"{_container_id(container)!r}"
                )
            ref = container.artifacts.pop(pos)
            res.inverse_units.append(
                [
                    PlaceArtifactOp(
                        kind="place_artifact",
                        artifact_id=ref.id,
                        artifact_kind=ref.kind,
                        folder_id=_container_id(container),
                        index=pos,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "artifact_id": artifact_id,
                        "folder_id": _container_id(container),
                    }
                )
            )
        elif isinstance(op, MoveArtifactOp):
            artifact_id = rid(op.artifact_id)
            src = _artifact_container(view, rid(op.from_folder_id))
            dst = _artifact_container(view, rid(op.to_folder_id))
            pos = next(
                (i for i, r in enumerate(src.artifacts) if r.id == artifact_id), None
            )
            if pos is None:
                raise _422(
                    f"artifact {artifact_id!r} is not placed in "
                    f"{_container_id(src)!r}"
                )
            if (
                not restore
                and src is not dst
                and any(r.id == artifact_id for r in dst.artifacts)
            ):
                raise _422(
                    f"artifact {artifact_id!r} is already placed in "
                    f"{_container_id(dst)!r}"
                )
            ref = src.artifacts.pop(pos)
            index = _clamped(op.index, len(dst.artifacts))
            dst.artifacts.insert(index, ref)
            res.inverse_units.append(
                [
                    MoveArtifactOp(
                        kind="move_artifact",
                        artifact_id=ref.id,
                        from_folder_id=_container_id(dst),
                        to_folder_id=_container_id(src),
                        index=pos,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "artifact_id": artifact_id,
                        "from_folder_id": _container_id(src),
                        "to_folder_id": _container_id(dst),
                        "index": index,
                    }
                )
            )
        else:
            assert_never(op)
    return res


def rollback_view(view: View, inverse_units: list[list[ViewOpIn]]) -> None:
    """Undo an applied (possibly partial) batch: apply inverse units newest-
    first, each unit front-to-back, in restore mode. Inverses are exact by
    construction, so a failure here would mean the view was mutated behind the
    caller's back while it held the write mutex — let it propagate."""
    for unit in reversed(inverse_units):
        apply_view_ops(view, list(unit), restore=True)


def validate_view_ops(view: View | None, ops: list[ViewOpIn]) -> None:
    """Dry preview validation: apply against a deep copy and discard. Views
    are small (user-curated trees), so the copy is cheap; sharing the real
    applier means preview and commit can never disagree on a batch's
    validity. ``None`` validates against an empty view — the same auto-create
    a real commit performs (see routes/commits.py)."""
    base = view.model_copy(deep=True) if view is not None else View(name="view")
    apply_view_ops(base, ops, restore=False)


def view_op_folder_ids(ops: Sequence[ViewOpIn]) -> set[str]:
    """Every folder id (bare, un-namespaced) a batch references — the undo
    route's peer-lease guard input. Over-reports on purpose (a create's
    temp/parent id, both ends of a move): a spurious id can only produce a
    conservative 409, never hide a held lease."""
    ids: set[str] = set()
    for op in ops:
        if isinstance(op, CreateFolderOp):
            ids |= {op.temp_id, op.parent_id}
        elif isinstance(op, (RenameFolderOp, DeleteFolderOp)):
            ids.add(op.id)
        elif isinstance(op, MoveFolderOp):
            ids |= {op.id, op.to_parent_id}
        elif isinstance(op, (PlaceElementOp, RemoveElementOp)):
            ids.add(op.folder_id)
        elif isinstance(op, MoveElementOp):
            ids |= {op.from_folder_id, op.to_folder_id}
        elif isinstance(op, (PlaceArtifactOp, RemoveArtifactOp)):
            ids.add(op.folder_id)
        elif isinstance(op, MoveArtifactOp):
            ids |= {op.from_folder_id, op.to_folder_id}
        else:
            assert_never(op)
    return ids
```

**Implementation note on `MoveFolderOp`:** `_subtree_ids(moving)` includes `moving.id` itself, so `to_parent_id in _subtree_ids(moving)` covers both "into itself" and "into a descendant" in one check; the root destination bypasses it (the root can never be inside a folder's subtree).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_view_ops_apply.py -v`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `pixi run backend-lint`

```bash
git add src/data_rover/api/view_ops.py tests/api/test_view_ops_apply.py
git commit -m "feat(api): view-op applier with exact inverses and dry validation"
```

---

### Task 6: Folder leases (CHECKPOINT)

`folder:` joins the typed lock namespace for real: lock requests accept `type: "folder"`, DELETE-intent expands to the folder subtree, `required_locks` derives folder leases from view ops, and the legacy whole-document `PUT /view/snapshot` honors peer folder leases.

**Files:**
- Modify: `src/data_rover/api/locking.py` (`folder_resource`, `expand_targets`, `required_locks`)
- Modify: `src/data_rover/api/schemas.py` (`LockTargetIn.type` gains `"folder"`)
- Modify: `src/data_rover/api/routes/locks.py` (canonicalization + `expand_targets` call)
- Modify: `src/data_rover/api/routes/commits.py` (pass `session.view` to `required_locks`/`_batch_touched_ids`)
- Modify: `src/data_rover/api/routes/view.py` (PUT honors peer folder leases)
- Test: `tests/api/test_lock_scope.py` + `tests/api/test_locks_route.py` (extend), `tests/api/test_view_routes.py` (extend)

**Interfaces:**
- Consumes: `folder_subtree` (Task 1), the view op models (Task 4), `FOLDER_PREFIX` (already declared in `locking.py`).
- Produces:
  - `locking.folder_resource(folder_id: str) -> str` (`"folder:" + id`)
  - `expand_targets(model: Model, view: View | None, targets, intent) -> list[RequiredLock]` — NEW `view` parameter
  - `required_locks(model: Model, view: View | None, ops: list[OpIn]) -> list[RequiredLock]` — NEW `view` parameter; per-op rules (spec §locking): `create_folder` → EXCLUSIVE parent (CREATE_CHILD); `rename_folder` → EXCLUSIVE that folder (EDIT); `move_folder` → EXCLUSIVE source parent + destination parent (EDIT); `delete_folder` → EXCLUSIVE folder + subtree (DELETE); element/artifact place/remove → EXCLUSIVE containing folder (EDIT); moves → EXCLUSIVE both folders (EDIT). Same-batch-created folders (temp ids) need no lease.
  - Wire: `LockTargetIn.type: Literal["element", "artifact", "metamodel", "folder"]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_lock_scope.py` (check its existing fixtures for a `Model`; view-only cases need none — pass a minimal model the file already builds):

```python
def _v() -> View:
    v = View(
        name="v",
        folders=[Folder(name="A", folders=[Folder(name="A1")]), Folder(name="B")],
    )
    ensure_folder_ids(v)
    return v


def test_required_locks_folder_ops(model_fixture) -> None:  # adapt fixture name
    v = _v()
    a, a1, b = v.folders[0], v.folders[0].folders[0], v.folders[1]
    ops = OPS_ADAPTER.validate_python(
        [
            {"kind": "create_folder", "temp_id": "tmp_c", "parent_id": b.id, "name": "C"},
            {"kind": "rename_folder", "id": b.id, "name": "B2"},
            {"kind": "delete_folder", "id": a.id},
            {
                "kind": "move_folder",
                "id": a1.id,
                "to_parent_id": "root",
            },
            {"kind": "place_element", "element_id": "e1", "folder_id": "tmp_c"},
        ]
    )
    reqs = {(r.resource_id, r.mode, r.intent) for r in required_locks(model_fixture, v, ops)}
    assert (f"folder:{b.id}", LockMode.EXCLUSIVE, LockIntent.CREATE_CHILD) in reqs
    assert (f"folder:{b.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    # delete expands over the subtree
    assert (f"folder:{a.id}", LockMode.EXCLUSIVE, LockIntent.DELETE) in reqs
    assert (f"folder:{a1.id}", LockMode.EXCLUSIVE, LockIntent.DELETE) in reqs
    # move locks source parent (A — resolved from the view) and destination (root)
    assert (f"folder:{a.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    assert ("folder:root", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    # placement into the same-batch-created folder needs no lease
    assert not any(rid == "folder:tmp_c" for rid, _, _ in reqs)


def test_expand_targets_folder_delete_subtree(model_fixture) -> None:
    v = _v()
    a = v.folders[0]
    reqs = expand_targets(
        model_fixture,
        v,
        [(f"folder:{a.id}", LockMode.EXCLUSIVE)],
        LockIntent.DELETE,
    )
    ids = {r.resource_id for r in reqs}
    assert ids == {f"folder:{a.id}", f"folder:{a.folders[0].id}"}
```

Append to `tests/api/test_locks_route.py` (mirror its existing typed-target tests):

```python
def test_acquire_folder_lease_and_conflict(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["leases"][0]["resource_id"] == f"folder:{fid}"
    # a peer's exclusive on the same folder conflicts
    _seed_second_member("user-2", "user2@example.com")
    r2 = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
        headers=OTHER_HEADERS,
    )
    assert r2.status_code == 409
```

Append to `tests/api/test_view_routes.py`:

```python
def test_legacy_put_honors_peer_folder_lease(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    _seed_second_member("user-2", "user2@example.com")
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 200
    # my whole-document PUT would stomp the peer's checked-out folder → 409
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": []})
    assert r.status_code == 409
    assert "checked out" in r.json()["detail"]["message"]
    # the PEER's own PUT is not blocked by their own lease
    r = client.put(
        papi("/view/snapshot"),
        json={"name": "v", "folders": []},
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 200
```

(`_seed_second_member`/`OTHER_HEADERS`: copy the helpers from `tests/api/test_commits_artifact_ops.py`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_lock_scope.py tests/api/test_locks_route.py tests/api/test_view_routes.py -v`
Expected: FAIL — `folder_resource` missing / signature errors / `type: "folder"` rejected / PUT returns 200.

- [ ] **Step 3: Implement**

`locking.py`:
- Add `def folder_resource(folder_id: str) -> str: return FOLDER_PREFIX + folder_id` next to `artifact_resource`, and update `FOLDER_PREFIX`'s comment (no longer "declared with its family" — it is live).
- Import `View` + `folder_subtree` under `TYPE_CHECKING`/runtime as needed (`from data_rover.core.view.ids import folder_subtree` and `from data_rover.core.view.schema import View` — core imports, no cycle).
- `expand_targets(model, view, targets, intent)`: in the DELETE branch, add a folder arm:

```python
        if intent is LockIntent.DELETE and mode is LockMode.EXCLUSIVE:
            if is_model_resource(rid):
                for member in containment_subtree(model, rid):
                    add(member, LockMode.EXCLUSIVE)
            elif rid.startswith(FOLDER_PREFIX):
                bare = rid.removeprefix(FOLDER_PREFIX)
                for member in folder_subtree(view, bare):
                    add(folder_resource(member), LockMode.EXCLUSIVE)
            else:
                add(rid, mode)
        else:
            add(rid, mode)
```

- `required_locks(model, view, ops)`: add the ten branches after the artifact ones (the existing `add()` helper's `created`-set exemption already covers folder temp ids once you `created.add(folder_resource(op.temp_id))`):

```python
        elif isinstance(op, CreateFolderOp):
            created.add(folder_resource(op.temp_id))
            add(folder_resource(op.parent_id), LockMode.EXCLUSIVE, LockIntent.CREATE_CHILD)
        elif isinstance(op, RenameFolderOp):
            add(folder_resource(op.id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, MoveFolderOp):
            if view is not None:
                located = locate_folder(view, op.id)
                if located is not None:
                    add(
                        folder_resource(_locate_container_id(located[0])),
                        LockMode.EXCLUSIVE,
                        LockIntent.EDIT,
                    )
            add(folder_resource(op.to_parent_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, DeleteFolderOp):
            for member in folder_subtree(view, op.id):
                add(folder_resource(member), LockMode.EXCLUSIVE, LockIntent.DELETE)
        elif isinstance(op, (PlaceElementOp, RemoveElementOp)):
            add(folder_resource(op.folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, MoveElementOp):
            add(folder_resource(op.from_folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
            add(folder_resource(op.to_folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, (PlaceArtifactOp, RemoveArtifactOp)):
            add(folder_resource(op.folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, MoveArtifactOp):
            add(folder_resource(op.from_folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
            add(folder_resource(op.to_folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
```

with a tiny module helper `_locate_container_id(node) -> str` (root → `VIEW_ROOT_ID`, folder → `.id`) or inline the two-way check. Docstring updates on both functions: the source-parent lock of a folder move is resolved FROM THE VIEW (the op only names the destination); a missing view/unknown id skips it — the op will 422 at apply anyway, and required-lock derivation must stay total.

`schemas.py`: `LockTargetIn.type` Literal gains `"folder"`; extend its comment (`"folder" -> "folder:<id>"`).

`routes/locks.py::acquire_locks`: add the branch to `_canonical` (`if t.type == "folder": return folder_resource(t.resource_id)`; import `folder_resource`) and pass the view: `reqs = expand_targets(model, session.view, targets, LockIntent(payload.intent))`.

`routes/commits.py`: `required_locks(model, session.view, payload.ops)` in `create_commit`, and thread the view through `_batch_touched_ids` (signature becomes `_batch_touched_ids(model: Model, view: View | None, ops: list[OpIn])`, its internal `required_locks` call gains `view`, its one call site passes `session.view`). Its isinstance chain keeps Task 4's TEMPORARY view no-op branch untouched (Task 9 replaces it).

`routes/view.py::snapshot_view`: add `user: User = Depends(get_current_user)` (import from `..identity`/`..db_models`), and before mutating anything:

```python
    # Lease rule (Phase 1 stance, extended): every writer HONORS folder
    # leases even though only POST /commits VERIFIES them. A whole-document
    # PUT rewrites every folder, so ANY peer-held folder lease refuses it.
    now = time.monotonic()
    peer_held = [
        le
        for le in session.lock_table.active_leases(now)
        if le.resource_id.startswith(FOLDER_PREFIX) and le.holder != user.id
    ]
    if peer_held:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "view is checked out by someone else",
                "conflicts": [
                    {
                        "resource_id": le.resource_id,
                        "holder_id": le.holder,
                        "holder_email": le.holder_email,
                    }
                    for le in peer_held
                ],
            },
        )
```

(Compare with how `routes/artifacts.py` phrases its peer-lease 409 and keep the two shapes aligned — same keys, same "checked out" wording.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_lock_scope.py tests/api/test_locks_route.py tests/api/test_locking_typed.py tests/api/test_view_routes.py -v`
Expected: PASS.

- [ ] **Step 5: CHECKPOINT — full suite, lint, commit**

Run: `pixi run core-test && pixi run backend-lint`

```bash
git add src/data_rover/api tests/api
git commit -m "feat(api): folder leases — typed lock resource, subtree expansion, op derivation, legacy PUT honors peers"
```

---

### Task 7: View ops through `POST /commits` and `/commits/preview` (CHECKPOINT)

The heart of the phase: a commit batch may now carry view ops. Applied to `session.view` under the write mutex, blob persisted on the commit's DB transaction, `view_rev` bumped in lockstep, journal spans all three families, feed scope gains `"view"`.

**Files:**
- Modify: `src/data_rover/api/routes/commits.py` (`preview_commit`, `create_commit`)
- Modify: `src/data_rover/api/schemas.py` (`CommitResponse.view_rev`)
- Test: `tests/api/test_commits_view_ops.py` (create)

**Interfaces:**
- Consumes: `apply_view_ops`/`rollback_view`/`validate_view_ops` (Task 5), 3-way `split_ops` (Task 4), folder leases (Task 6).
- Produces:
  - `CommitResponse.view_rev: int | None = None` — the post-commit `ViewRow.view_rev`; `None` when the batch touched no view content
  - Commit feed events whose `scope` may include `"view"`
  - The commit journal contract: canonical ops ordered model + artifact + view; one `Commit` row spans all three

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_commits_view_ops.py
"""View ops through the lock-verified commit flow: lease enforcement,
journaling, view_rev lockstep, auto-created views, mixed-batch atomicity
(the view half rolls back when the model half hard-fails), preview dryness,
and the feed scope."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

# copy the client fixture + _MM + _seed_second_member/OTHER_HEADERS pattern
# from tests/api/test_commits_artifact_ops.py, and papi/feed_url from conftest.


def _folder_lease(client: TestClient, fid: str, intent: str = "edit") -> str:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": intent,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _rev(client: TestClient) -> int:
    r = client.get(papi("/open"))
    return r.json()["model_rev"]


def test_commit_requires_folder_lease(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    ops = [{"kind": "rename_folder", "id": fid, "name": "A2"}]
    r = client.post(
        papi("/commits"),
        json={"base_rev": _rev(client), "ops": ops, "message": "m", "lock_tokens": []},
    )
    assert r.status_code == 409
    assert r.json()["missing"][0]["resource_id"] == f"folder:{fid}"


def test_commit_applies_persists_and_journals(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    put_view_rev = r.json()["view_rev"]
    token = _folder_lease(client, fid)
    base = _rev(client)
    ops = [
        {"kind": "rename_folder", "id": fid, "name": "A2"},
        {"kind": "create_folder", "temp_id": "tmp_c", "parent_id": fid, "name": "C"},
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "view edit", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["model_rev"] == base + 1          # any commit bumps the project rev
    assert out["view_rev"] == put_view_rev + 1   # lockstep with the legacy PUT path
    assert "tmp_c" in out["id_map"]

    # the view head reflects it
    r = client.get(papi("/view"))
    v = r.json()["view"]
    assert v["folders"][0]["name"] == "A2"
    assert v["folders"][0]["folders"][0]["id"] == out["id_map"]["tmp_c"]

    # the journal row spans the family; the diff route can read it later
    r = client.get(papi("/commits"))
    assert r.json()["commits"][0]["op_count"] == 2

    # commit released the lease
    r = client.get(papi("/locks"))
    assert r.json()["leases"] == []


def test_commit_view_ops_without_existing_view_autocreates(client: TestClient) -> None:
    base = _rev(client)
    ops = [{"kind": "create_folder", "temp_id": "tmp_c", "parent_id": "root", "name": "A"}]
    # create_folder under root needs the root-membership lease
    token = _folder_lease(client, "root", intent="edit")
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["view_rev"] == 1
    r = client.get(papi("/view"))
    assert r.json()["view"]["folders"][0]["name"] == "A"


def test_mixed_batch_atomicity_view_rolls_back_with_model(client: TestClient) -> None:
    """A structural model blocker rolls back the ALREADY-APPLIED view half."""
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    view_before = client.get(papi("/view")).json()
    token = _folder_lease(client, fid)
    base = _rev(client)
    ops = [
        {"kind": "rename_folder", "id": fid, "name": "A2"},
        # dangling target -> STRUCTURAL blocker from the validation pipeline
        {
            "kind": "create_relationship",
            "temp_id": "tmp_r",
            "type_name": "Rel",
            "source_id": "missing-src",
            "target_id": "missing-tgt",
        },
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 422
    assert client.get(papi("/view")).json() == view_before
    assert _rev(client) == base

    # NB: if the metamodel fixture has no "Rel" type this 422s at the mutation
    # boundary BEFORE the view half applies — that would not exercise the
    # rollback. Use whatever op shape the existing structural-blocker tests in
    # test_commits_route.py use to provoke a STRUCTURAL issue, and assert the
    # view is untouched afterwards. The assertion set is the contract.


def test_preview_validates_view_ops_dry(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    view_before = client.get(papi("/view")).json()
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "id": fid, "name": "A2"}],
        },
    )
    assert r.status_code == 200
    assert client.get(papi("/view")).json() == view_before
    # an impossible view op fails preview with 422
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "id": "missing", "name": "x"}],
        },
    )
    assert r.status_code == 422


def test_commit_event_scope_includes_view(client: TestClient) -> None:
    # mirror test_commits_artifact_ops.py's feed-event test mechanics: open the
    # WS via feed_url, drain the snapshot event, run the commit above, then
    # assert the commit event's scope == ["view"] (and ["model", "view"] for a
    # mixed batch).
    ...
```

Fill in the feed test by copying the WebSocket harness from `test_commits_artifact_ops.py` verbatim and adjusting the ops + expected scope.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commits_view_ops.py -v`
Expected: FAIL — the Task 4 temporary guard 422s every view-op commit.

- [ ] **Step 3: Implement in `routes/commits.py`**

Remove both TEMPORARY guards. In `preview_commit`, inside the `with session.write_mutex:` block, before `_apply_batch`:

```python
        # View ops are validated DRY against a deep copy (views are small):
        # nothing to roll back, and sharing the real applier means preview and
        # commit cannot disagree. Inside the mutex because a concurrent commit
        # mutates session.view in place.
        validate_view_ops(session.view, view_ops)
```

First, add the all-or-nothing wrapper the commit/undo callers need — `apply_view_ops` raises without returning, so a caller has no handle on the applied prefix's inverses. Add to `view_ops.py`:

```python
def apply_view_ops_atomic(
    view: View,
    ops: list[ViewOpIn],
    *,
    id_map: dict[str, str] | None = None,
    restore: bool = False,
) -> ViewBatchResult:
    """apply_view_ops with all-or-nothing semantics: on ANY failure the
    already-applied prefix is rolled back via its own inverses before the
    exception propagates. The commit/undo callers want exactly this — they
    have no other handle on the partial result."""
    res = ViewBatchResult(id_map=dict(id_map or {}))
    try:
        for op in ops:
            step = apply_view_ops(view, [op], id_map=res.id_map, restore=restore)
            res.canonical_ops.extend(step.canonical_ops)
            res.inverse_units.extend(step.inverse_units)
            res.id_map.update(step.id_map)
    except Exception:
        rollback_view(view, res.inverse_units)
        raise
    return res
```

Then in `create_commit`, after the artifact half (step b2), add step b3 — on failure the view is already clean (the atomic wrapper rolled its prefix back), so the except-branch only undoes the model + DB halves:

```python
        # b3. apply the view half to session.view IN PLACE, all-or-nothing
        #     (auto-creating an empty view for a project that never had one —
        #     the ops path must be self-sufficient once the legacy PUT
        #     retires). Seeded with both prior id_maps so a placement may
        #     reference an element or artifact created earlier in the SAME
        #     batch.
        view_res: ViewBatchResult | None = None
        if view_ops:
            if session.view is None:
                session.view = View(name="view")
            try:
                view_res = apply_view_ops_atomic(
                    session.view,
                    view_ops,
                    id_map={**res.id_map, **art_res.id_map},
                    restore=False,
                )
            except Exception:
                # mirror b2's stance: never leave the model half applied.
                _rollback(model, res.inverse_units)
                session.invalidate_derived_caches()
                db.rollback()
                raise
```

(Imports to add in `routes/commits.py`: `View` from `data_rover.core.view.schema`; `ViewBatchResult`, `apply_view_ops_atomic`, `rollback_view`, `validate_view_ops` from `..view_ops`.)

Add a test for the wrapper in `tests/api/test_view_ops_apply.py`:

```python
def test_apply_view_ops_atomic_rolls_back_prefix() -> None:
    v = _view()
    f = _ids(v)
    before = v.model_dump_json()
    with pytest.raises(HTTPException):
        apply_view_ops_atomic(
            v,
            [
                RenameFolderOp(kind="rename_folder", id=f["B"], name="B2"),
                RenameFolderOp(kind="rename_folder", id="missing", name="x"),
            ],
        )
    assert v.model_dump_json() == before
```

Every later failure path in `create_commit` (structural 422, strict-mode 422, persist 500) gains one line next to its `_rollback(model, ...)`:

```python
            if view_res is not None:
                rollback_view(session.view, view_res.inverse_units)  # type: ignore[arg-type]
```

(`session.view` is non-None whenever `view_res` is — assert rather than ignore if pyright complains: `assert session.view is not None`.)

Journal + heads (step d/e): before the `_persist_commit` try-block, stage the blob:

```python
        new_view_rev: int | None = None
        if view_res is not None and view_res.canonical_ops:
            assert session.view is not None
            view_row = content.upsert_single_view(
                db,
                project_id,
                name=session.view.name,
                blob=session.view.model_dump_json(),
            )
            new_view_rev = view_row.view_rev
```

and merge the third family into the journal entry:

```python
        merged_id_map = {**res.id_map, **art_res.id_map, **(view_res.id_map if view_res else {})}
        canonical_ops: list[OpIn] = [
            *res.canonical_ops,
            *art_res.canonical_ops,
            *(view_res.canonical_ops if view_res else []),
        ]
        inverse_ops: list[OpIn] = [
            *res.inverse_ops(),
            *art_res.inverse_ops(),
            *(view_res.inverse_ops() if view_res else []),
        ]
```

(NOTE: the view id_map is seeded with the model+artifact maps, so `view_res.id_map` is a superset — merging it last is correct and the other two redundant-but-harmless; keep all three spreads for symmetry with undo.)

The no-durable-row commit guard widens: `if (artifact_ops or view_ops) and not persisted: db.commit()`.

Scope (step h):

```python
        scope = sorted(
            ({"model"} if model_ops else set())
            | ({"artifact"} if artifact_ops else set())
            | ({"view"} if view_ops else set())
        ) or ["model"]
```

Response: add `view_rev=new_view_rev` to the returned `CommitResponse`; in `schemas.py` add to `CommitResponse`:

```python
    #: post-commit ViewRow.view_rev; None when the batch touched no view
    #: content (Phase 2). Secondary/informational — see ViewRow.view_rev.
    view_rev: int | None = None
```

Update `create_commit`'s docstring: flow list gains "b3. apply the view half (all-or-nothing via apply_view_ops_atomic)", the atomicity section becomes three-way (model in place / artifact rows staged / view in place + blob staged), and the step-e note mentions the view blob rides the same transaction as the `Commit` row.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_commits_view_ops.py tests/api/test_view_ops_apply.py tests/api/test_commits_route.py tests/api/test_commits_artifact_ops.py -v`
Expected: PASS.

- [ ] **Step 5: CHECKPOINT — full suite, lint, commit**

Run: `pixi run core-test && pixi run backend-lint`

```bash
git add src/data_rover/api tests/api
git commit -m "feat(api): view ops through POST /commits — atomic three-family batches, view_rev lockstep, view scope"
```

---

### Task 8: Undo across view ops; revert refuses them

`POST /model/undo` replays a commit's view inverses in restore mode (honoring peer folder leases), journals the compensating commit across all three families, and persists the blob. Revert's refusal (already landed in Task 4) gets its tests here.

**Files:**
- Modify: `src/data_rover/api/routes/ops.py` (`undo`)
- Test: `tests/api/test_undo_view_ops.py` (create), `tests/api/test_commits_revert.py` (extend)

**Interfaces:**
- Consumes: `apply_view_ops_atomic`, `rollback_view`, `view_op_folder_ids` (Tasks 5/7), `folder_resource` (Task 6).
- Produces: no new public surface — behavior only.

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_undo_view_ops.py
"""Undo across view ops: restore-mode replay, peer-lease refusal (leases are
the ONLY concurrency control on view content — same rationale as the
artifact half), blob persistence, and journal append-only-ness.

Fixtures: copy the client/_MM/_seed_second_member pattern from
tests/api/test_commits_artifact_ops.py; _folder_lease/_rev from
tests/api/test_commits_view_ops.py."""

from __future__ import annotations


def _commit_rename(client, fid: str, name: str) -> None:
    token = _folder_lease(client, fid)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "id": fid, "name": name}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text


def test_undo_restores_view_and_bumps_revs(client) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    _commit_rename(client, fid, "A2")
    base = _rev(client)
    view_rev = client.get(papi("/view")).json()["view_rev"]

    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == base + 1  # append-only: rev moves FORWARD

    out = client.get(papi("/view")).json()
    assert out["view"]["folders"][0]["name"] == "A"
    assert out["view_rev"] == view_rev + 1  # the compensating edit bumps it

    # the compensating commit is journaled (newest row carries the inverse op)
    r = client.get(papi("/commits"))
    assert r.json()["commits"][0]["op_count"] == 1


def test_undo_refuses_while_peer_holds_folder_lease(client) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    _commit_rename(client, fid, "A2")
    _seed_second_member("user-2", "user2@example.com")
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 200
    r = client.post(papi("/model/undo"))
    assert r.status_code == 409
    assert f"folder:{fid}" in [c["resource_id"] for c in r.json()["conflicts"]]
    # the refusal did not eat the undo slot: after the peer releases, undo works
```

Append to `tests/api/test_commits_revert.py` (mirror its artifact-refusal test):

```python
def test_revert_refuses_range_with_view_ops(client) -> None:
    # helpers as in test_undo_view_ops.py (_folder_lease/_rev/_commit_rename)
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    target = _rev(client)
    _commit_rename(client, fid, "A2")
    view_commit_rev = _rev(client)
    r = client.post(
        papi("/commits/revert"),
        json={"base_rev": _rev(client), "target_rev": target},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "revert across view changes is not yet supported"
    assert r.json()["view_commit_rev"] == view_commit_rev
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_undo_view_ops.py tests/api/test_commits_revert.py -v`
Expected: the undo tests FAIL (Task 4's temporary 500 guard); the revert test should PASS already if Task 4 was done right — if it fails, fix the Task 4 refusal now.

- [ ] **Step 3: Implement in `routes/ops.py::undo`**

Replace the temporary guard. Extend the peer-lease guard input:

```python
        peer_resources = [
            artifact_resource(aid) for aid in artifact_op_ids(artifact_inv)
        ] + [folder_resource(fid) for fid in view_op_folder_ids(view_inv)]
        peer_held = session.lock_table.peer_leases(
            peer_resources, user.id, now=time.monotonic()
        )
```

Generalize the 409 detail to `"resource is checked out by someone else"` (it now covers artifacts AND folders; extend the comment above it — view content, like artifact rows, is protected only by its leases, and `view_op_folder_ids` over-reports on purpose).

After the artifact half applies, add the view half (restore mode, all-or-nothing):

```python
        view_res: ViewBatchResult | None = None
        if view_inv:
            if session.view is None:
                # a batch that touched the view implies one existed; an evicted
                # + contentless resurrection is the only way here — recreate.
                session.view = View(name="view")
            try:
                view_res = apply_view_ops_atomic(
                    session.view, view_inv, restore=True
                )
            except Exception:
                _rollback(model, res.inverse_units)
                session.invalidate_derived_caches()
                session.op_log.append(batch)
                db.rollback()
                raise
```

Stage the blob before `_persist_undo_commit` (identical shape to Task 7):

```python
        if view_res is not None and view_res.canonical_ops:
            assert session.view is not None
            content.upsert_single_view(
                db,
                project_id,
                name=session.view.name,
                blob=session.view.model_dump_json(),
            )
```

Merge the third family into `canonical_ops`/`inverse_ops`/`merged_id_map` (same three-spread shape as Task 7). The persist-failure branch gains `rollback_view(session.view, view_res.inverse_units)` when `view_res is not None` (with the same non-None assert). The no-durable-row guard widens to `if (artifact_inv or view_inv) and not persisted: db.commit()`.

Update `undo`'s docstring ("spanning both families" → "all three families"; note the view blob rides the commit's transaction). No new feed events: undo is the legacy unlocked path and today broadcasts only artifact events — the view, like the model half here, reaches peers on their next refresh (documented stance, kept).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_undo_view_ops.py tests/api/test_undo_artifact_ops.py tests/api/test_commits_revert.py -v`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `pixi run backend-lint`

```bash
git add src/data_rover/api/routes/ops.py tests/api
git commit -m "feat(api): undo replays view inverses; revert refuses view ranges"
```

---

### Task 9: Generalized conflict backstop over view ops

A stale batch touching view resources 409s iff it overlaps what landed in `(base_rev, head]`. One typed derivation (`view_touched_resources`) feeds both sides of the overlap check.

**Files:**
- Modify: `src/data_rover/api/view_ops.py` (`view_touched_resources`, marker prefixes)
- Modify: `src/data_rover/api/routes/commits.py` (`_affected_ids`, `_batch_touched_ids`)
- Test: `tests/api/test_commit_conflict_backstop.py` (extend)

**Interfaces:**
- Consumes: `VIEW_OP_KINDS` (Task 4), a `TypeAdapter` for single view ops.
- Produces:
  - `view_ops.VIEW_ELEMENT_MARKER = "viewel:"`, `view_ops.VIEW_ARTIFACT_MARKER = "viewart:"` — placement-subject namespaces. They exist ONLY for overlap detection (two batches fighting over the same element's placement conflict even when their folders differ); no lease ever carries them.
  - `view_ops.view_touched_resources(op: ViewOpIn) -> set[str]` — `folder:`-namespaced ids for every folder the op names + subject markers for placements
  - `schemas.VIEW_OP_ADAPTER: TypeAdapter[ViewOpIn]` — validates one raw journal dict into a typed view op

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_commit_conflict_backstop.py` (reuse its client/commit helpers; copy `_folder_lease`/`_rev` from `test_commits_view_ops.py` and `_commit_rename` from `test_undo_view_ops.py`):

```python
def test_stale_view_batch_overlapping_tail_409s(client) -> None:
    r = client.put(
        papi("/view/snapshot"),
        json={"name": "v", "folders": [{"name": "A"}, {"name": "B"}]},
    )
    fa = r.json()["view"]["folders"][0]["id"]
    stale_base = _rev(client)
    _commit_rename(client, fa, "A2")  # tail commit touching folder:fa
    token = _folder_lease(client, fa)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "rename_folder", "id": fa, "name": "A3"}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "conflicting concurrent commits"


def test_stale_view_batch_disjoint_from_tail_lands(client) -> None:
    r = client.put(
        papi("/view/snapshot"),
        json={"name": "v", "folders": [{"name": "A"}, {"name": "B"}]},
    )
    fa = r.json()["view"]["folders"][0]["id"]
    fb = r.json()["view"]["folders"][1]["id"]
    stale_base = _rev(client)
    _commit_rename(client, fa, "A2")  # tail touches only folder:fa
    token = _folder_lease(client, fb)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "rename_folder", "id": fb, "name": "B2"}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text


def test_placement_subject_overlap_conflicts_across_folders(client) -> None:
    """Two batches fighting over the SAME element's placement conflict even
    though the folders they name are disjoint — the viewel: marker is the
    only thing connecting them (folder leases never collided)."""
    r = client.put(
        papi("/view/snapshot"),
        json={"name": "v", "folders": [{"name": "A"}, {"name": "C"}]},
    )
    fa = r.json()["view"]["folders"][0]["id"]
    fc = r.json()["view"]["folders"][1]["id"]
    # place e1 in A (a real commit, so the journal carries canonical ops)
    tok = _folder_lease(client, fa)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "place_element", "element_id": "e1", "folder_id": fa}],
            "message": "m",
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    stale_base = _rev(client)
    # tail: remove e1's placement (touches folder:fa + viewel:e1)
    tok = _folder_lease(client, fa)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "remove_element", "element_id": "e1", "folder_id": fa}],
            "message": "m",
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    # stale batch: place e1 into C — folder set {fc} is DISJOINT from the
    # tail's {fa}; only viewel:e1 overlaps. Must 409, not land.
    tok = _folder_lease(client, fc)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "place_element", "element_id": "e1", "folder_id": fc}],
            "message": "m",
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "conflicting concurrent commits"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_conflict_backstop.py -v`
Expected: the OVERLAP test fails (stale view batch currently lands — `_affected_ids` sees no view ids). Note the disjoint test may already pass; keep it as the guard against over-conservatism.

- [ ] **Step 3: Implement**

`schemas.py`:

```python
#: validates ONE raw journal op dict into a typed view op (the conflict
#: backstop deserializes only the view ops of tail commits; model/artifact
#: ops are cheaper to scan as raw dicts, see routes/commits._affected_ids).
VIEW_OP_ADAPTER: TypeAdapter[ViewOpIn] = TypeAdapter(ViewOpIn)
```

`view_ops.py`:

```python
#: Placement-subject namespaces for the conflict backstop ONLY (no lease ever
#: carries them): two batches fighting over the same element's/artifact-ref's
#: placement must conflict even when the folders they name are disjoint —
#: folder leases cannot see that collision, the overlap check can.
VIEW_ELEMENT_MARKER = "viewel:"
VIEW_ARTIFACT_MARKER = "viewart:"


def view_touched_resources(op: ViewOpIn) -> set[str]:
    """The backstop resources one view op touches: every folder it names in
    the ``folder:`` lease namespace (so the set compares directly against
    lease ids and the tail's), plus a subject marker per placement. Folder
    ids here may be temp ids in a CLIENT batch — the caller strips those; in
    CANONICAL journal ops they are always real (the applier rewrote them)."""
    if isinstance(op, CreateFolderOp):
        return {folder_resource(op.temp_id), folder_resource(op.parent_id)}
    if isinstance(op, (RenameFolderOp, DeleteFolderOp)):
        # a delete's subtree victims surface via the INVERSE unit's create
        # ops when _affected_ids scans both halves (same cascade rationale
        # as delete_element).
        return {folder_resource(op.id)}
    if isinstance(op, MoveFolderOp):
        return {folder_resource(op.id), folder_resource(op.to_parent_id)}
    if isinstance(op, (PlaceElementOp, RemoveElementOp)):
        return {folder_resource(op.folder_id), VIEW_ELEMENT_MARKER + op.element_id}
    if isinstance(op, MoveElementOp):
        return {
            folder_resource(op.from_folder_id),
            folder_resource(op.to_folder_id),
            VIEW_ELEMENT_MARKER + op.element_id,
        }
    if isinstance(op, (PlaceArtifactOp, RemoveArtifactOp)):
        return {folder_resource(op.folder_id), VIEW_ARTIFACT_MARKER + op.artifact_id}
    if isinstance(op, MoveArtifactOp):
        return {
            folder_resource(op.from_folder_id),
            folder_resource(op.to_folder_id),
            VIEW_ARTIFACT_MARKER + op.artifact_id,
        }
    assert_never(op)
```

(`folder_resource` import from `.locking` — locking imports only `schemas` + core, no cycle.)

`routes/commits.py::_affected_ids` — before the artifact branch:

```python
            kind = op.get("kind")
            if kind in VIEW_OP_KINDS:
                ids |= view_touched_resources(VIEW_OP_ADAPTER.validate_python(op))
                continue
```

Extend the docstring: view ops are deserialized (10 kinds × heterogeneous id-field namespaces make the raw-key derivation used for the other families wrong here — `element_id` must land in `viewel:`, not `folder:`); tail sizes are small so the validation cost is noise.

`routes/commits.py::_batch_touched_ids` — replace the Task 6 temporary pass-branch:

```python
        elif isinstance(
            op,
            (
                CreateFolderOp,
                RenameFolderOp,
                MoveFolderOp,
                DeleteFolderOp,
                PlaceElementOp,
                RemoveElementOp,
                MoveElementOp,
                PlaceArtifactOp,
                RemoveArtifactOp,
                MoveArtifactOp,
            ),
        ):
            # delete_folder's subtree is already covered: required_locks
            # expanded it against the live view above.
            ids |= view_touched_resources(op)
```

Extend the trailing temp-strip comment: `folder:tmp_x` / `viewel:tmp_x` survive the strip (they don't START with `tmp_`) but can never collide with canonical journal ids — same harmlessness argument as `art:tmp_x`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_commit_conflict_backstop.py tests/api/test_commits_view_ops.py -v`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `pixi run backend-lint`

```bash
git add src/data_rover/api tests/api
git commit -m "feat(api): conflict backstop covers view ops — folder + placement-subject overlap"
```

---

### Task 10: Commit diff — view section (CHECKPOINT)

`GET /commits/{rev}/diff` renders view commits journal-only: the fine-grained canonical ops ARE the diff; prior names come from the inverse half.

**Files:**
- Modify: `src/data_rover/api/schemas.py` (`ViewDiffEntryOut`, `CommitDiffOut.view`)
- Modify: `src/data_rover/api/commit_diff.py` (`_view_diffs`, scope)
- Test: `tests/api/test_commit_diff.py` (extend)

**Interfaces:**
- Consumes: 3-way `split_ops`, `deserialize_ops`, the op models.
- Produces:
  - `ViewDiffEntryOut` — one entry per canonical view op, in batch order: `{kind: str, folder_id: str | None, name: str | None, name_before: str | None, parent_id: str | None, index: int | None, from_folder_id: str | None, to_folder_id: str | None, element_id: str | None, artifact_id: str | None, artifact_kind: str | None}`
  - `CommitDiffOut.view: list[ViewDiffEntryOut]`; `CommitDiffOut.scope` may include `"view"`

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_commit_diff.py` (reuse its client/commit plumbing; add the view seed + `_folder_lease` helper):

```python
def test_view_commit_diff_renders_ops_with_prior_names(client) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    token = _folder_lease(client, fid)
    base = _rev(client)
    ops = [
        {"kind": "rename_folder", "id": fid, "name": "A2"},
        {"kind": "create_folder", "temp_id": "tmp_c", "parent_id": fid, "name": "C"},
        {"kind": "place_element", "element_id": "e1", "folder_id": "tmp_c"},
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    cid = r.json()["id_map"]["tmp_c"]

    r = client.get(papi(f"/commits/{base + 1}/diff"))
    assert r.status_code == 200
    out = r.json()
    assert out["scope"] == ["view"]
    entries = out["view"]
    assert [e["kind"] for e in entries] == ["rename_folder", "create_folder", "place_element"]
    assert entries[0] == {
        **entries[0],
        "folder_id": fid,
        "name": "A2",
        "name_before": "A",
    }
    assert entries[1]["folder_id"] == cid and entries[1]["parent_id"] == fid
    assert entries[2]["element_id"] == "e1" and entries[2]["folder_id"] == cid
    # model/artifact halves untouched by a pure-view commit
    assert out["elements"] == {"added": [], "modified": [], "deleted": []}


def test_delete_folder_diff_carries_prior_name(client) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    token = _folder_lease(client, fid, intent="delete")
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [{"kind": "delete_folder", "id": fid}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    r = client.get(papi(f"/commits/{base + 1}/diff"))
    e = r.json()["view"][0]
    assert e["kind"] == "delete_folder" and e["name_before"] == "A"


def test_mixed_commit_scope_lists_both(client) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    token = _folder_lease(client, fid)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node"},
                {"kind": "rename_folder", "id": fid, "name": "A2"},
            ],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    r = client.get(papi(f"/commits/{base + 1}/diff"))
    assert r.json()["scope"] == ["model", "view"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_diff.py -v`
Expected: FAIL — no `view` key in `CommitDiffOut`, scope lacks `"view"`.

- [ ] **Step 3: Implement**

`schemas.py` — after the artifact-diff models:

```python
class ViewDiffEntryOut(BaseModel):
    """One canonical view op, rendered for history. The view family is
    fine-grained on the wire, so the ops ARE the diff — no before/after
    reconstruction. ``name_before`` (rename/delete) comes from the commit's
    inverse half. Folder ids referenced by other entries are NOT resolved to
    names here (journal-only stance): the client resolves against its live
    view and degrades to the bare id for folders deleted since."""

    kind: str
    folder_id: str | None = None
    name: str | None = None
    name_before: str | None = None
    parent_id: str | None = None
    index: int | None = None
    from_folder_id: str | None = None
    to_folder_id: str | None = None
    element_id: str | None = None
    artifact_id: str | None = None
    artifact_kind: str | None = None
```

and `CommitDiffOut` gains `view: list[ViewDiffEntryOut] = Field(default_factory=list)`.

`commit_diff.py`:

```python
def _view_diffs(commit: Commit) -> list[ViewDiffEntryOut]:
    """Render the view half journal-only (module docstring: same stance as
    artifacts). Prior names come from the inverse half: a rename's inverse
    carries the old name, and a delete's inverse unit RECREATES the subtree,
    so its create ops name every deleted folder."""
    _, _, forward = split_ops(deserialize_ops(commit.ops))
    _, _, inverse = split_ops(deserialize_ops(commit.inverse_ops))
    names_before: dict[str, str] = {}
    for op in inverse:
        if isinstance(op, RenameFolderOp):
            # inverse units are stored reversed (undo order): the LAST write
            # per id is the earliest unit == the true pre-batch name.
            names_before[op.id] = op.name
        elif isinstance(op, CreateFolderOp):
            names_before[op.temp_id] = op.name

    out: list[ViewDiffEntryOut] = []
    for op in forward:
        if isinstance(op, CreateFolderOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    folder_id=op.temp_id,  # canonical ops carry the real id
                    name=op.name,
                    parent_id=op.parent_id,
                    index=op.index,
                )
            )
        elif isinstance(op, RenameFolderOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    folder_id=op.id,
                    name=op.name,
                    name_before=names_before.get(op.id),
                )
            )
        elif isinstance(op, MoveFolderOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    folder_id=op.id,
                    to_folder_id=op.to_parent_id,
                    index=op.index,
                    name_before=names_before.get(op.id),
                )
            )
        elif isinstance(op, DeleteFolderOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind, folder_id=op.id, name_before=names_before.get(op.id)
                )
            )
        elif isinstance(op, (PlaceElementOp, RemoveElementOp)):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    folder_id=op.folder_id,
                    element_id=op.element_id,
                    index=getattr(op, "index", None),
                )
            )
        elif isinstance(op, MoveElementOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    element_id=op.element_id,
                    from_folder_id=op.from_folder_id,
                    to_folder_id=op.to_folder_id,
                    index=op.index,
                )
            )
        elif isinstance(op, (PlaceArtifactOp, RemoveArtifactOp)):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    folder_id=op.folder_id,
                    artifact_id=op.artifact_id,
                    artifact_kind=getattr(op, "artifact_kind", None),
                    index=getattr(op, "index", None),
                )
            )
        elif isinstance(op, MoveArtifactOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    artifact_id=op.artifact_id,
                    from_folder_id=op.from_folder_id,
                    to_folder_id=op.to_folder_id,
                    index=op.index,
                )
            )
        else:
            assert_never(op)
    return out
```

In `diff_commit`: `has_model` becomes "not artifact AND not view" (`op.get("kind") not in ARTIFACT_OP_KINDS and op.get("kind") not in VIEW_OP_KINDS`), add `has_view = any(op.get("kind") in VIEW_OP_KINDS for op in commit.ops)`, fold `{"view"} if has_view else set()` into the scope union, and pass `view=_view_diffs(commit)` into `CommitDiffOut`. Update the module docstring (three mechanisms now; the view one is "the ops ARE the diff").

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_commit_diff.py tests/api/test_commits_view_ops.py -v`
Expected: PASS.

- [ ] **Step 5: CHECKPOINT — full suite, lint, commit**

Run: `pixi run core-test && pixi run backend-lint`

```bash
git add src/data_rover/api tests/api
git commit -m "feat(api): commit diff renders view commits journal-only with prior names"
```

---

### Task 11: Final verification and docs (CHECKPOINT)

**Files:**
- Modify: `CLAUDE.md` (the "Artifact ops (artefacts revamp Phase 1)" paragraph gains a Phase 2 sibling)
- Verify: everything

- [ ] **Step 1: Full verification**

Run, in order, expecting all green:

```
pixi run dr-tidy
pixi run core-lint
pixi run backend-lint
pixi run core-test
```

Then re-run the plan's own suites one last time:

```
pixi run -e core-dev pytest tests/view tests/api/test_view_op_schemas.py tests/api/test_view_ops_apply.py tests/api/test_commits_view_ops.py tests/api/test_undo_view_ops.py tests/api/test_commit_conflict_backstop.py tests/api/test_commit_diff.py tests/api/test_view_routes.py -q
```

- [ ] **Step 2: Sweep for leftovers**

- `grep -rn "TEMPORARY (plan Task" src/` → must return nothing.
- `grep -rn "split_ops" src/ | grep -v "def split_ops"` → every unpack is 3-way.
- Confirm `routes/ops.py::_apply_one` was never touched (`git log --oneline -- src/data_rover/api/routes/ops.py` shows only this plan's undo/apply_ops edits; `_apply_one` has no view branch).

- [ ] **Step 3: Update CLAUDE.md**

Add after the Phase 1 artifact-ops bullet (match its voice; one bullet, dense):

```markdown
- **View ops (artefacts revamp Phase 2)** — folders carry stable uuid ids (`Folder.id`, healed lazily by `core/view/ids.ensure_folder_ids` at hydration/PUT/import — no Alembic migration for blob content; `views.view_rev` is Alembic `0009`). The ten-op `view.*` family (`create/rename/move/delete_folder`, `place/remove/move_element`, `place/remove/move_artifact`) flows through `POST /commits` only: `api/view_ops.py` applies them to the in-memory `session.view` with exact inverses (apply-then-inverse restores a byte-identical blob — the invariant undo and `GET /commits/{rev}/diff` lean on; the diff renders view commits journal-only, prior names off the inverse half), then the whole blob is persisted to `ViewRow` + `view_rev` bumped on the commit's transaction. `/model/ops`, `/model/validate` and guest-proposed snippet ops reject the family; model hydration replay skips it; `/commits/revert` answers 409 across it. Locks: `folder:<id>` leases (`LockTargetIn.type: "folder"`; root membership = `folder:root`; DELETE intent expands over the folder subtree; element placement ops lock only the containing folder). The conflict backstop compares `folder:` resources plus `viewel:`/`viewart:` placement-subject markers. Legacy `PUT /view/snapshot` stays for the frontend migration window — it bumps `view_rev`, heals ids, and HONORS peer folder leases (whole-doc write ⇒ any peer folder lease 409s). Element placements never target the root (`VIEW_ROOT_ID = "root"`): an unplaced element renders there, so "move to root" is `remove_element`; artifact refs have a real root list and may sit in many folders.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: view-as-content (artefacts Phase 2 backend) architecture notes"
```

---

## Out of scope for this plan (later plans in the same program)

- **Frontend rewire** (the Phase 2 sibling of `2026-08-06-artefacts-phase-1-frontend-rewire.md`): `ops.ts` gains the `ViewOp` arm + a staged view buffer, `view.svelte.ts` mutators emit ops instead of `pushView`, folder-id addressing replaces name paths in `view-tree.ts`/DnD, lease acquisition at drag/edit start (watch the known `endGesture`-before-mutator ordering trap), `view-diff.ts`/baseline retire, `lockedResourcesNeededBy` + `hasModelLocks` + `canonicalResource` + `LockTargetInSchema` gain the folder arm, DiffDrawer's View tab consumes `CommitDiffOut.view`. After it lands: retire `PUT /view/snapshot` (spec's migration-window stance).
- **View-scoped feed events for the legacy PUT** — peers still don't see legacy-PUT view changes live (pre-existing); the commit path's `scope: ["view"]` is the go-forward signal.
- **`DELETE /view` durability** — it clears `session.view` but leaves `ViewRow`, so eviction resurrects the view (pre-existing oddity; the route is unused by the current frontend).
- **Renaming the view itself / multiple named views** — no op for `View.name` (legacy PUT can still set it); schema allows N views, no UX ask (spec: deferred).
- **Revert across view ops** — same deliberate boundary as artifacts (Phase-1 Decision), refused 409.
- Phase 3 (import/export closure) and Phase 4 (metamodel lease + diff) per the spec.
