# Metamodel Commit Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route metamodel YAML edits and diagram node positions through the check-out/commit flow (`POST /commits`) as a fourth `metamodel.*` op family, retiring the standalone rebind route and the live layout PUT.

**Architecture:** A new `MetamodelOpIn` union member set (`metamodel.rebind` carrying the full candidate YAML, `metamodel.move_node` carrying one node position) joins `OpIn`. A new `api/metamodel_ops.py` applier (twin of `view_ops.py`/`artifact_ops.py`) swaps the in-memory metamodel and stages `MetamodelRow`/`ModelRow`/`MetamodelLayoutRow` writes on the request's DB transaction with full-state inverses. `create_commit` applies the metamodel half FIRST (so model ops in the batch validate against the new schema — the migration semantics), replaces the dirty-scope validation splice with a full sweep for rebind batches, hard-verifies the `mm` lease, and keeps the rebind commit's existing `from/to_metamodel_id` column markers so history, staleness, and hydration invariants survive unchanged. The frontend stages the editor buffer + diagram moves like any other edit and commits them in the one mixed batch.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + pydantic v2 (backend), Svelte 5 runes + zod (frontend), pytest + vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-metamodel-commit-flow-design.md`

## Global Constraints

- Everything runs through pixi: `pixi run -e core-dev pytest tests/api/...`, `pixi run core-lint`, `pixi run backend-lint`, `pixi run frontend-test`, `pixi run frontend-check`. There is no global `python`/`node`.
- API tests need NO database service (in-memory SQLite via `tests/api/conftest.py`); use the `AUTH_HEADERS`/`papi`/`seed_default_project` helpers.
- **No Alembic migration** — the feature reuses existing tables/columns exactly.
- One journaled batch == one rev == one `Commit` row (completeness invariant). Any path that bumps `model_rev` must write exactly one row.
- Empty-ops journal rows remain reserved for `persist_baseline`'s opaque-reset marker; a metamodel batch always has non-empty `ops`.
- Rebind batches: at most ONE `metamodel.rebind` per batch (422), owner-only (403), full-sweep validation, strict-mode exempt, forced snapshot, `rebind_event` broadcast.
- **Plan deviation from spec, agreed rationale:** (a) `POST /model/undo` answers **409** for a popped batch containing `metamodel.rebind` (push-back, history preserved) instead of replaying it — restore-mode property patches are schema-checked at the core mutation boundary, so replaying inverses across a schema swap fails in one direction or the other; layout-only (`move_node`) undo IS supported. (b) The conflict backstop uses the single `mm` resource for all metamodel ops instead of per-node `mmnode:` markers — the exclusive `mm` lease already serializes all metamodel writers, so finer markers can never change an outcome. Both are recorded in the spec's amendment section (Task 13 updates the spec).
- Preserve the dense docstring style of `routes/commits.py`/`view_ops.py` — invariants are load-bearing; every new module/branch gets a why-docstring.
- Commit after each task with a conventional-commits message.

---

## File structure

**Backend — create:**
- `src/data_rover/api/metamodel_ops.py` — the metamodel-family applier (split/apply/inverses/current-blob helper).
- `tests/api/test_commits_metamodel_ops.py` — commit-flow integration tests (the big suite).
- `tests/api/test_metamodel_ops.py` — applier unit tests.

**Backend — modify:**
- `src/data_rover/api/schemas.py` — op models, unions, `METAMODEL_OP_KINDS`, `CommitResponse.rebound/to_metamodel_id`, `CommitDiffOut.layout_moves`.
- `src/data_rover/api/artifact_ops.py` — `split_ops` → 4-tuple.
- `src/data_rover/api/routes/ops.py` — 4-tuple destructures, `/model/ops` rejection, undo metamodel half, `_persist_commit` from/to kwargs.
- `src/data_rover/api/routes/commits.py` — create_commit/preview/revert integration, `_affected_ids`/`_batch_touched_ids` arms.
- `src/data_rover/api/locking.py` — `required_locks` metamodel arm.
- `src/data_rover/api/content.py` — `stage_metamodel_layout` (flush-only upsert).
- `src/data_rover/api/hydration.py` — 4-tuple destructure (replay skip falls out).
- `src/data_rover/api/commit_diff.py` — 4-tuple destructures, `has_model` fix, layout rendering, scope arm.
- `src/data_rover/api/routes/snippets.py` — guest-op rejection extended.
- `src/data_rover/api/routes/metamodel_swap.py` — DELETE the rebind route (keep diff/lint).
- `src/data_rover/api/routes/metamodel_layout.py` — DELETE the PUT route (keep GET).

**Frontend — create:**
- `frontend/src/lib/state/metamodel-stage.svelte.ts` — staged metamodel ops store (draft provider + coalesced move journal + committed/discard listeners).
- `frontend/src/lib/state/__tests__/metamodel-stage.test.ts`

**Frontend — modify:**
- `frontend/src/lib/state/ops.ts` — `MetamodelOp` types, `METAMODEL_RESOURCE`.
- `frontend/src/lib/state/checkout.svelte.ts` — batch composition, `lockedResourcesNeededBy` arm, `releaseMetamodelLease` staged guard, rebound adoption.
- `frontend/src/lib/state/metamodel-editor.svelte.ts` — committed-listener baseline adoption; `commitMetamodelRebind` deleted.
- `frontend/src/lib/state/metamodel-diagram.svelte.ts` — staged moves replace live PUT + rename-deferral machinery.
- `frontend/src/lib/state/quiet.ts`, `frontend/src/lib/state/unsaved.ts` — metamodel terms.
- `frontend/src/lib/components/DiffDrawer.svelte` — metamodel section + total.
- `frontend/src/lib/components/Metamodel/MetamodelTab.svelte` — Rebind button/quiet gate removed.
- `frontend/src/lib/api/metamodel.ts`, `frontend/src/lib/api/types.ts` — client cleanup + response schema fields.

---

### Task 1: Backend op schemas (`metamodel.rebind`, `metamodel.move_node`)

**Files:**
- Modify: `src/data_rover/api/schemas.py` (op-schema region, around lines 348–487)
- Test: `tests/api/test_commit_schemas.py` (append)

**Interfaces:**
- Produces: `MetamodelNodePos(x: float, y: float)`, `RebindMetamodelOp(kind="metamodel.rebind", blob: str)`, `MoveMetamodelNodeOp(kind="metamodel.move_node", node: str, pos: MetamodelNodePos | None)`, `MetamodelOpIn = RebindMetamodelOp | MoveMetamodelNodeOp`, `METAMODEL_OP_KINDS = frozenset({"metamodel.rebind", "metamodel.move_node"})`, and `OpIn` extended with `MetamodelOpIn`. Everything later consumes these exact names.

- [ ] **Step 1: Write the failing test** — append to `tests/api/test_commit_schemas.py`:

```python
def test_metamodel_ops_round_trip_through_adapter() -> None:
    """The journal adapter must round-trip the metamodel family with kind
    tags intact (same guarantee the other three families have)."""
    from data_rover.api.schemas import (
        METAMODEL_OP_KINDS,
        OPS_ADAPTER,
        MoveMetamodelNodeOp,
        RebindMetamodelOp,
    )

    ops = [
        RebindMetamodelOp(kind="metamodel.rebind", blob="elements:\n  - name: A\n"),
        MoveMetamodelNodeOp(
            kind="metamodel.move_node", node="el:A", pos={"x": 1.5, "y": -2.0}
        ),
        MoveMetamodelNodeOp(kind="metamodel.move_node", node="el:B", pos=None),
    ]
    raw = OPS_ADAPTER.dump_python(list(ops), mode="json")
    assert [o["kind"] for o in raw] == [
        "metamodel.rebind",
        "metamodel.move_node",
        "metamodel.move_node",
    ]
    assert raw[2]["pos"] is None
    back = OPS_ADAPTER.validate_python(raw)
    assert back == ops
    assert METAMODEL_OP_KINDS == {"metamodel.rebind", "metamodel.move_node"}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commit_schemas.py::test_metamodel_ops_round_trip_through_adapter -v`
Expected: FAIL — `ImportError: cannot import name 'RebindMetamodelOp'`.

- [ ] **Step 3: Implement.** In `src/data_rover/api/schemas.py`, after the `ViewOpIn` union (line ~457) and before `OpIn`, add:

```python
class MetamodelNodePos(BaseModel):
    x: float
    y: float


class RebindMetamodelOp(BaseModel):
    """Whole-metamodel swap as a batch member (spec 2026-08-16). ``blob`` is
    the author's YAML SOURCE, persisted verbatim as a new immutable
    ``MetamodelRow`` (Correction A: never a pydantic round-trip). At most one
    per batch; the commit applier hoists it FIRST so every other op in the
    batch validates against the candidate schema. The inverse op carries the
    PRIOR blob — full-state, so the journal alone answers undo/diff."""

    kind: Literal["metamodel.rebind"]
    blob: str = Field(min_length=1)


class MoveMetamodelNodeOp(BaseModel):
    """One diagram-layout key write against ``metamodel_layouts``. ``node``
    is a layout key (``el:<Name>`` / ``rel:<Name>`` / ``enum:<Name>``);
    ``pos: None`` REMOVES the key (a rename migrates a position as two ops:
    old key -> None, new key -> pos). The inverse carries the prior position
    (or None). Presentation data: no validation beyond this schema."""

    kind: Literal["metamodel.move_node"]
    node: str = Field(min_length=1)
    pos: MetamodelNodePos | None = None


#: Metamodel-family ops (spec 2026-08-16) — applied by api/metamodel_ops.py
#: to the in-memory metamodel + content tables, never to the model.
MetamodelOpIn = RebindMetamodelOp | MoveMetamodelNodeOp
```

Change the `OpIn` line to:

```python
OpIn = Annotated[
    ModelOpIn | ArtifactOpIn | ViewOpIn | MetamodelOpIn, Field(discriminator="kind")
]
```

After `VIEW_OP_KINDS`, add:

```python
#: kind-tags of metamodel ops, for raw journal dicts (lives here for the same
#: no-cycle reason VIEW_OP_KINDS does).
METAMODEL_OP_KINDS = frozenset({"metamodel.rebind", "metamodel.move_node"})
```

- [ ] **Step 4: Run the test again** — expected: PASS. Also run `pixi run -e core-dev pytest tests/api/test_commit_schemas.py -v` (whole file green).

- [ ] **Step 5: Commit** — `git commit -m "feat(api): add metamodel.rebind/move_node to the op union"`

---

### Task 2: `split_ops` grows a fourth family; legacy/guest paths reject it

**Files:**
- Modify: `src/data_rover/api/artifact_ops.py:56-87` (split_ops), `src/data_rover/api/routes/ops.py:616-628,704` , `src/data_rover/api/routes/commits.py:433,671,1255`, `src/data_rover/api/hydration.py:122`, `src/data_rover/api/commit_diff.py:149,162,300-301`, `src/data_rover/api/routes/snippets.py:342-346`
- Test: `tests/api/test_commits_metamodel_ops.py` (create), existing suites

**Interfaces:**
- Produces: `split_ops(ops) -> tuple[list[ModelOpIn], list[ArtifactOpIn], list[ViewOpIn], list[MetamodelOpIn]]`. EVERY destructure site changes arity in this task; sites that don't handle the family yet just bind `mm_ops` and (for this task) reject or ignore it as specified below.

- [ ] **Step 1: Write the failing tests** — create `tests/api/test_commits_metamodel_ops.py`:

```python
"""Metamodel ops through the commit flow (spec 2026-08-16). This file grows
across Tasks 2-7; each task appends its section."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, papi, seed_default_project

MM_V1 = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
"""

MM_V2 = """
elements:
  - name: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"),
        content=MM_V1,
        headers={"Content-Type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    return c


def _rev(client: TestClient) -> int:
    return get_session().model_rev


def test_split_ops_separates_metamodel_family() -> None:
    from data_rover.api.artifact_ops import split_ops
    from data_rover.api.schemas import (
        DeleteElementOp,
        MoveMetamodelNodeOp,
        RebindMetamodelOp,
    )

    model, art, view, mm = split_ops(
        [
            RebindMetamodelOp(kind="metamodel.rebind", blob="x: 1\n"),
            DeleteElementOp(kind="delete_element", id="e1"),
            MoveMetamodelNodeOp(kind="metamodel.move_node", node="el:A", pos=None),
        ]
    )
    assert [type(o).__name__ for o in mm] == [
        "RebindMetamodelOp",
        "MoveMetamodelNodeOp",
    ]
    assert len(model) == 1 and not art and not view


def test_model_ops_route_rejects_metamodel_ops(client: TestClient) -> None:
    r = client.post(
        papi("/model/ops"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.move_node", "node": "el:Node", "pos": None}],
        },
    )
    assert r.status_code == 422
    assert "commits" in r.json()["detail"]
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_commits_metamodel_ops.py -v`
Expected: FAIL — `split_ops` returns 3 items / no 422 branch.

- [ ] **Step 3: Implement.**

In `artifact_ops.py`, change `split_ops` (import `MetamodelOpIn`, `MoveMetamodelNodeOp`, `RebindMetamodelOp` from `.schemas`):

```python
def split_ops(
    ops: Sequence[OpIn],
) -> tuple[
    list[ModelOpIn], list[ArtifactOpIn], list[ViewOpIn], list[MetamodelOpIn]
]:
    """Separate a mixed batch into (model, artifact, view, metamodel) ops,
    order-preserving within each family. The metamodel arm is matched
    EXPLICITLY — the trailing else is the model-applier fallthrough, and an
    op family that silently lands there reaches ``_apply_one``'s
    ``assert_never`` as a 500 instead of its own applier."""
    model_ops: list[ModelOpIn] = []
    artifact_ops: list[ArtifactOpIn] = []
    view_ops: list[ViewOpIn] = []
    metamodel_ops: list[MetamodelOpIn] = []
    for op in ops:
        if isinstance(op, (CreateArtifactOp, UpdateArtifactOp, DeleteArtifactOp)):
            artifact_ops.append(op)
        elif isinstance(op, (RebindMetamodelOp, MoveMetamodelNodeOp)):
            metamodel_ops.append(op)
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
    return model_ops, artifact_ops, view_ops, metamodel_ops
```

Update every destructure site to 4-arity:

- `routes/ops.py:616` (`apply_ops`): `model_ops, artifact_ops, view_ops, metamodel_ops = split_ops(payload.ops)` and add after the view rejection:

```python
    if metamodel_ops:
        raise HTTPException(
            status_code=422,
            detail="metamodel ops are not supported on /model/ops; use /commits",
        )
```

- `routes/ops.py:704` (`undo`): `model_inv, artifact_inv, view_inv, metamodel_inv = split_ops(batch.inverse_ops)`. **For this task only**, add immediately after (Task 7 replaces this stub with the real handling — the guard keeps history safe meanwhile):

```python
        if metamodel_inv:
            session.op_log.append(batch)
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "undo across metamodel changes is not yet supported",
                    "model_rev": session.model_rev,
                },
            )
```

- `routes/commits.py:433` (preview): `model_ops, artifact_ops, view_ops, metamodel_ops = split_ops(payload.ops)`; for this task add `if metamodel_ops: raise HTTPException(status_code=422, detail="metamodel ops not yet supported")` (Task 6 removes it).
- `routes/commits.py:671` (create_commit): same 4-arity bind + the same temporary 422 (Task 5 removes it).
- `routes/commits.py:1255` (revert): `combined, artifact_combined, view_combined, metamodel_combined = split_ops(...)`; extend the defensive 500 condition to `if artifact_combined or view_combined or metamodel_combined:` and its detail string to `"artifact/view/metamodel ops reached the revert applier"`.
- `hydration.py:122` (`replay_commits_into`): `ops, _artifact_ops, _view_ops, _metamodel_ops = split_ops(deserialize_ops(c.ops))` — comment gains "metamodel ops are materialized heads too (ModelRow.metamodel_id / metamodel_layouts)".
- `commit_diff.py:149,162`: `_, inverse_artifact_ops, _, _ = split_ops(...)` / `_, forward_artifact_ops, _, _ = split_ops(...)`.
- `commit_diff.py:300-301` (`_view_diffs`): `_, _, forward, _ = split_ops(...)` / `_, _, inverse, _ = split_ops(...)`.
- `routes/snippets.py:342`: `_, artifact_ops, view_ops, metamodel_ops = split_ops(validated_ops)` and change the guard to `if artifact_ops or view_ops or metamodel_ops:` (extend the log line's wording to "artifact/view/metamodel ops"). The docstring rationale is identical: the facade has no metamodel surface, so a proposed rebind could only be an injection channel.

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_commits_metamodel_ops.py tests/api/test_commits_route.py tests/api/test_commits_view_ops.py tests/api/test_commits_artifact_ops.py tests/api/test_undo_view_ops.py tests/api/test_snippets*.py -x -q`
Expected: PASS (mechanical arity change breaks nothing else; fix any missed destructure the failures point at).

- [ ] **Step 5: Commit** — `git commit -m "feat(api): split_ops grows the metamodel family; legacy/guest paths reject it"`

---

### Task 3: `api/metamodel_ops.py` — the applier

**Files:**
- Create: `src/data_rover/api/metamodel_ops.py`
- Modify: `src/data_rover/api/content.py` (add `stage_metamodel_layout`), `src/data_rover/api/routes/metamodel.py` (extract `serialize_metamodel_blob` if `/metamodel/raw`'s fallback is inline — reuse, don't duplicate)
- Test: `tests/api/test_metamodel_ops.py` (create)

**Interfaces:**
- Consumes: Task 1 schemas; `content.create_metamodel/get_model_row/get_metamodel_row/upsert_model_row/get_metamodel_layout`.
- Produces:
  - `MetamodelBatchResult` — fields `canonical_ops: list[MetamodelOpIn]`, `inverse_units: list[list[MetamodelOpIn]]`, `rebound: bool`, `prior_metamodel: Metamodel | None`, `from_metamodel_id: str | None`, `to_metamodel_id: str | None`, `layout_touched: bool`; method `inverse_ops() -> list[MetamodelOpIn]`.
  - `split_rebind(ops) -> tuple[RebindMetamodelOp | None, list[MoveMetamodelNodeOp]]` (raises 422 on >1 rebind).
  - `load_candidate(blob: str) -> Metamodel` (422 on parse/schema error).
  - `apply_metamodel_ops(db, project_id, session, ops) -> MetamodelBatchResult`.
  - `content.stage_metamodel_layout(db, project_id, blob: dict) -> None` (flush-only upsert).

- [ ] **Step 1: Write the failing unit tests** — `tests/api/test_metamodel_ops.py`:

```python
"""Unit tests for the metamodel-family applier (api/metamodel_ops.py)."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api import content, db
from data_rover.api.metamodel_ops import (
    MetamodelBatchResult,
    apply_metamodel_ops,
    split_rebind,
)
from data_rover.api.schemas import MoveMetamodelNodeOp, RebindMetamodelOp
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session

from .conftest import AUTH_HEADERS, papi, seed_default_project

MM_V1 = "elements:\n  - name: Node\n    properties:\n      - name: label\n        datatype: string\n"
MM_V2 = "elements:\n  - name: Node\n"


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"),
        content=MM_V1,
        headers={"Content-Type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    return c


def _db():
    gen = db.get_db()
    s = next(gen)
    return s, gen


def test_split_rebind_rejects_two_rebinds() -> None:
    ops = [
        RebindMetamodelOp(kind="metamodel.rebind", blob="a: 1\n"),
        RebindMetamodelOp(kind="metamodel.rebind", blob="b: 2\n"),
    ]
    with pytest.raises(HTTPException) as e:
        split_rebind(ops)
    assert e.value.status_code == 422


def test_apply_rebind_swaps_memory_and_stages_rows(client: TestClient) -> None:
    session = get_session()
    s, gen = _db()
    try:
        res = apply_metamodel_ops(
            s,
            DEFAULT_PROJECT_ID,
            session,
            [RebindMetamodelOp(kind="metamodel.rebind", blob=MM_V2)],
        )
        assert res.rebound and res.prior_metamodel is not None
        # in-memory swap happened; 'label' is gone from the effective schema
        assert session.metamodel is not None
        assert not session.metamodel.effective_element_properties("Node")
        # inverse carries the PRIOR stored blob byte-identically
        inv = res.inverse_ops()
        assert len(inv) == 1 and inv[0].blob == MM_V1
        # staged rows: new MetamodelRow version, ModelRow repointed
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None and row.metamodel_id == res.to_metamodel_id
        mm_row = content.get_metamodel_row(s, res.to_metamodel_id)
        assert mm_row is not None and mm_row.blob == MM_V2 and mm_row.version == 2
    finally:
        s.rollback()
        gen.close()


def test_apply_moves_updates_layout_blob_with_inverses(client: TestClient) -> None:
    session = get_session()
    s, gen = _db()
    try:
        content.stage_metamodel_layout(
            s, DEFAULT_PROJECT_ID, {"positions": {"el:Node": {"x": 1.0, "y": 2.0}}}
        )
        res = apply_metamodel_ops(
            s,
            DEFAULT_PROJECT_ID,
            session,
            [
                MoveMetamodelNodeOp(
                    kind="metamodel.move_node", node="el:Node", pos={"x": 9.0, "y": 9.0}
                ),
                MoveMetamodelNodeOp(
                    kind="metamodel.move_node", node="el:Fresh", pos={"x": 3.0, "y": 4.0}
                ),
            ],
        )
        assert res.layout_touched and not res.rebound
        blob = content.get_metamodel_layout(s, DEFAULT_PROJECT_ID)
        assert blob == {
            "positions": {
                "el:Node": {"x": 9.0, "y": 9.0},
                "el:Fresh": {"x": 3.0, "y": 4.0},
            }
        }
        inv = res.inverse_ops()
        # reversed units: Fresh's inverse removes it (no prior), Node's restores
        assert inv[0].node == "el:Fresh" and inv[0].pos is None
        assert inv[1].node == "el:Node" and inv[1].pos is not None
        assert inv[1].pos.x == 1.0 and inv[1].pos.y == 2.0
    finally:
        s.rollback()
        gen.close()
```

- [ ] **Step 2: Run to verify failure** — `pixi run -e core-dev pytest tests/api/test_metamodel_ops.py -v` → ImportError.

- [ ] **Step 3: Implement `content.stage_metamodel_layout`** (append near `put_metamodel_layout` in `content.py`):

```python
def stage_metamodel_layout(db: Session, project_id: str, blob: dict) -> None:
    """Flush-only upsert of the canvas-layout blob, for writers that own a
    larger unit of work (the metamodel half of POST /commits and undo — the
    caller's transaction lands or discards it with the Commit row). The
    first-write PK race ``put_metamodel_layout`` documents cannot happen
    here: layout ops flow only through the per-session ``write_mutex``."""
    row = db.get(MetamodelLayoutRow, project_id)
    if row is None:
        db.add(MetamodelLayoutRow(project_id=project_id, blob=blob))
    else:
        row.blob = blob
        row.updated_at = _utcnow()
    db.flush()
```

- [ ] **Step 4: Implement `src/data_rover/api/metamodel_ops.py`:**

```python
"""Metamodel-op plumbing (spec 2026-08-16 metamodel commit flow).

The metamodel and the diagram layout are MATERIALIZED HEADS
(``ModelRow.metamodel_id`` -> immutable ``MetamodelRow`` versions;
``metamodel_layouts``), so metamodel ops must never reach the model applier.
This module is their applier — the fourth sibling of ``routes/ops.py``'s
model applier, ``artifact_ops`` and ``view_ops``:

- ``metamodel.rebind`` swaps the IN-MEMORY metamodel (``session.metamodel``,
  ``model.metamodel``, ``model.indexes.rebuild()`` — the index is
  metamodel-derived) and stages the durable rows (new ``MetamodelRow`` at
  ``prior_version + 1`` carrying the author's verbatim blob, ``ModelRow``
  repointed) on the caller's DB transaction. The caller (``create_commit``)
  applies this module FIRST so the batch's model ops validate against the
  candidate schema — the whole point of a migration batch.
- ``metamodel.move_node`` ops rewrite the layout blob; ``pos: None`` removes
  a key. Presentation data: no validation beyond schema shape.

Inverses carry FULL PRIOR STATE (the prior YAML blob; a node's prior
position), never patches — the journal alone answers undo and diff, exactly
like artifact inverses. There is NO restore-mode parameter: a rebind's
"restore" is just another forward rebind to the prior blob (a fresh
``MetamodelRow`` version — the journal stays append-only), and a move's
inverse is just another move.

There is NO internal rollback: the in-memory swap is undone by
``_CommitUnwind``'s metamodel stage (restore ``prior_metamodel`` + rebuild
indexes + null the validation state), and ``db.rollback()`` discards the
staged rows — the same split of responsibilities as the artifact applier.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import yaml
from fastapi import HTTPException
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel

from . import content
from .deps import Session
from .schemas import MetamodelNodePos, MetamodelOpIn, MoveMetamodelNodeOp, RebindMetamodelOp


@dataclass
class MetamodelBatchResult:
    """Everything one metamodel-op batch produced (twin of the other three
    ``*BatchResult`` types). ``prior_metamodel`` is the unwind handle for the
    in-memory swap; the two row ids feed ``_persist_commit``'s
    ``from/to_metamodel_id`` columns so every reader keyed off them
    (staleness guard, history ``is_rebind``, ``first_rebind_after``,
    ``_metamodel_structural``) keeps working unchanged."""

    canonical_ops: list[MetamodelOpIn] = field(default_factory=list)
    inverse_units: list[list[MetamodelOpIn]] = field(default_factory=list)
    rebound: bool = False
    prior_metamodel: Metamodel | None = None
    from_metamodel_id: str | None = None
    to_metamodel_id: str | None = None
    layout_touched: bool = False

    def inverse_ops(self) -> list[MetamodelOpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
        return [op for unit in reversed(self.inverse_units) for op in unit]


def split_rebind(
    ops: list[MetamodelOpIn],
) -> tuple[RebindMetamodelOp | None, list[MoveMetamodelNodeOp]]:
    """At most ONE rebind per batch (422): two schema swaps in one rev have
    no meaning the journal could represent (which candidate did the model
    ops validate against?), and the inverse would be ambiguous."""
    rebinds = [op for op in ops if isinstance(op, RebindMetamodelOp)]
    moves = [op for op in ops if isinstance(op, MoveMetamodelNodeOp)]
    if len(rebinds) > 1:
        raise HTTPException(
            status_code=422,
            detail="a batch may contain at most one metamodel.rebind op",
        )
    return (rebinds[0] if rebinds else None), moves


def load_candidate(blob: str) -> Metamodel:
    """Parse+schema-check a candidate blob; 422 on anything bad (mirrors the
    retired rebind route's ``_load_candidate``)."""
    try:
        return load_metamodel_str(blob)
    except (MetamodelError, yaml.YAMLError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def current_blob(db: DbSession, project_id: str, session: Session) -> str:
    """The blob the rebind inverse must carry: the STORED source when a
    durable row exists (byte-exact, the author's comments included), else a
    re-serialization of the in-memory metamodel — the same degradation
    ``GET /metamodel/raw`` documents for legacy in-memory-only sessions."""
    row = content.get_model_row(db, project_id)
    if row is not None:
        mm_row = content.get_metamodel_row(db, row.metamodel_id)
        if mm_row is not None:
            return mm_row.blob
    assert session.metamodel is not None
    return yaml.safe_dump(session.metamodel.model_dump(mode="json"), sort_keys=False)


def apply_metamodel_ops(
    db: DbSession, project_id: str, session: Session, ops: list[MetamodelOpIn]
) -> MetamodelBatchResult:
    """Apply the metamodel family: rebind first (in-memory swap + staged
    rows), then layout moves (staged blob rewrite). Caller holds the
    ``write_mutex`` and owns the transaction; see the module docstring for
    the no-rollback contract."""
    res = MetamodelBatchResult()
    rebind, moves = split_rebind(ops)
    if rebind is not None:
        model = session.model
        assert model is not None and session.metamodel is not None
        candidate = load_candidate(rebind.blob)
        prior_blob = current_blob(db, project_id, session)
        model_row = content.get_model_row(db, project_id)
        from_id = model_row.metamodel_id if model_row is not None else None
        prior_version = 0
        if from_id is not None:
            prior = content.get_metamodel_row(db, from_id)
            prior_version = prior.version if prior is not None else 0
        res.prior_metamodel = session.metamodel
        session.metamodel = candidate
        model.metamodel = candidate
        model.indexes.rebuild()  # containment flags + key groups are mm-derived
        if model_row is not None:
            mm_row = content.create_metamodel(
                db, name="", version=prior_version + 1, blob=rebind.blob
            )
            content.upsert_model_row(db, project_id, metamodel_id=mm_row.id)
            res.from_metamodel_id = from_id
            res.to_metamodel_id = mm_row.id
        res.rebound = True
        res.canonical_ops.append(rebind)
        res.inverse_units.append(
            [RebindMetamodelOp(kind="metamodel.rebind", blob=prior_blob)]
        )
    if moves:
        blob = content.get_metamodel_layout(db, project_id) or {}
        positions: dict = dict(blob.get("positions") or {})
        for op in moves:
            prior = positions.get(op.node)
            if op.pos is None:
                positions.pop(op.node, None)
            else:
                positions[op.node] = {"x": op.pos.x, "y": op.pos.y}
            inv_pos = (
                None
                if prior is None
                else MetamodelNodePos(x=float(prior["x"]), y=float(prior["y"]))
            )
            res.inverse_units.append(
                [
                    MoveMetamodelNodeOp(
                        kind="metamodel.move_node", node=op.node, pos=inv_pos
                    )
                ]
            )
            res.canonical_ops.append(op)
        content.stage_metamodel_layout(db, project_id, {"positions": positions})
        res.layout_touched = True
    return res
```

Note: if `Session` from `.deps` creates an import cycle (deps imports session, not metamodel_ops — it should be safe), fall back to importing `Session` from `..session` the way `hydration.py` does; use whichever matches the existing import graph.

- [ ] **Step 5: Run the tests** — `pixi run -e core-dev pytest tests/api/test_metamodel_ops.py -v` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(api): metamodel-family applier with full-state inverses"`

---

### Task 4: Locking + conflict-backstop arms

**Files:**
- Modify: `src/data_rover/api/locking.py:445-507` (`required_locks`), `src/data_rover/api/routes/commits.py:157-298` (`_affected_ids`, `_batch_touched_ids`)
- Test: `tests/api/test_lock_scope.py` (append), `tests/api/test_commit_conflict_backstop.py` (append)

**Interfaces:**
- Consumes: `METAMODEL_RESOURCE` (`locking.py:56`), Task 1 op types.
- Produces: every `metamodel.*` op derives `RequiredLock("mm", EXCLUSIVE, EDIT)`; `_affected_ids`/`_batch_touched_ids` both report `"mm"` for the family.

- [ ] **Step 1: Write the failing tests** — append to `tests/api/test_lock_scope.py`:

```python
def test_metamodel_ops_require_the_mm_exclusive_lease() -> None:
    from data_rover.api.locking import LockIntent, LockMode, required_locks
    from data_rover.api.schemas import MoveMetamodelNodeOp, RebindMetamodelOp
    from data_rover.core.metamodel.loader import load_metamodel_str
    from data_rover.core.model.model import Model

    model = Model(load_metamodel_str("elements:\n  - name: A\n"))
    reqs = required_locks(
        model,
        None,
        [
            RebindMetamodelOp(kind="metamodel.rebind", blob="x: 1\n"),
            MoveMetamodelNodeOp(kind="metamodel.move_node", node="el:A", pos=None),
        ],
    )
    assert [(r.resource_id, r.mode, r.intent) for r in reqs] == [
        ("mm", LockMode.EXCLUSIVE, LockIntent.EDIT)
    ]
```

And to `tests/api/test_commit_conflict_backstop.py`, following that file's local conventions for building `Commit` stand-ins (read its existing tests first and mirror them):

```python
def test_affected_ids_reports_mm_for_metamodel_ops() -> None:
    from data_rover.api.routes.commits import _affected_ids

    class _C:  # journal-row stand-in: only .ops/.inverse_ops are read
        ops = [{"kind": "metamodel.move_node", "node": "el:A", "pos": None}]
        inverse_ops = [
            {"kind": "metamodel.rebind", "blob": "x: 1\n"},
        ]

    assert "mm" in _affected_ids([_C()])
```

- [ ] **Step 2: Run to verify failure** — both new tests FAIL (no arm yet; `required_locks` currently drops the ops on the floor / `_affected_ids` scans them with model id keys).

- [ ] **Step 3: Implement.**

`locking.py` — import the two op types in the deferred import block at the bottom, and add to `required_locks`'s chain (before the final `return`):

```python
        elif isinstance(op, (RebindMetamodelOp, MoveMetamodelNodeOp)):
            # The whole family serializes on the singleton `mm` lease: a
            # rebind rewrites what every node/key MEANS, so per-node layout
            # granularity could never change an outcome (spec 2026-08-16,
            # amended) — and the diagram + YAML editor already share one
            # surface lease.
            add(METAMODEL_RESOURCE, LockMode.EXCLUSIVE, LockIntent.EDIT)
```

`routes/commits.py::_affected_ids` — add before the artifact-kind branch (import `METAMODEL_OP_KINDS` from `..schemas` and `METAMODEL_RESOURCE` from `..locking`):

```python
            if kind in METAMODEL_OP_KINDS:
                # One resource for the whole family (see required_locks): the
                # exclusive `mm` lease already serializes every metamodel
                # writer, so the backstop only needs mm-vs-mm overlap.
                ids.add(METAMODEL_RESOURCE)
                continue
```

`routes/commits.py::_batch_touched_ids` — add a typed branch before `assert_never` (import the op types):

```python
        elif isinstance(op, (RebindMetamodelOp, MoveMetamodelNodeOp)):
            # required_locks already derived `mm` above; the explicit branch
            # keeps the assert_never chain exhaustive.
            ids.add(METAMODEL_RESOURCE)
```

- [ ] **Step 4: Run the tests** — the two new tests + `pixi run -e core-dev pytest tests/api/test_lock_scope.py tests/api/test_commit_conflict_backstop.py -q` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): mm lease derivation + conflict-backstop arms for metamodel ops"`

---

### Task 5: `create_commit` integration (the core task)

**Files:**
- Modify: `src/data_rover/api/routes/commits.py` (`_CommitUnwind`, `create_commit`), `src/data_rover/api/routes/ops.py:489-543` (`_persist_commit`), `src/data_rover/api/schemas.py` (`CommitResponse`)
- Test: `tests/api/test_commits_metamodel_ops.py` (append)

**Interfaces:**
- Consumes: Task 3's `apply_metamodel_ops`/`MetamodelBatchResult`/`split_rebind`; `feed.rebind_event`; `hydration.write_snapshot`; `authz.require_membership` + `db_models.Role`.
- Produces: `CommitResponse.rebound: bool = False` and `CommitResponse.to_metamodel_id: str | None = None`; `_persist_commit(..., _from_metamodel_id=None, _to_metamodel_id=None)` passing through to `content.append_commit`; feed `scope` vocabulary gains `"metamodel-layout"`.

- [ ] **Step 1: Write the failing tests** — append to `tests/api/test_commits_metamodel_ops.py`. These encode the spec's semantics; write them all now:

```python
OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _seed_second_member(user_id: str, email: str, role_name: str = "editor") -> None:
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, user_id) is None:
            s.add(User(id=user_id, email=email))
            s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role(role_name))
    finally:
        gen.close()


def _acquire_mm(client: TestClient) -> str:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _acquire_element(client: TestClient, eid: str) -> str:
    """An update/delete op in a batch requires the element's EXCLUSIVE lease
    at verify time — migration batches must hold BOTH tokens (mm + element)."""
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": eid, "mode": "exclusive"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _create_node(client: TestClient, label: str) -> str:
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_a",
                    "type_name": "Node",
                    "properties": {"label": label},
                }
            ],
            "message": "seed",
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id_map"]["tmp_a"]


def test_migration_batch_lands_atomically(client: TestClient) -> None:
    """The motivating scenario: remove property `label` from the schema AND
    strip it from an element in ONE commit — validated against the NEW
    schema, one rev, one journal row, rebind columns set."""
    eid = _create_node(client, "hello")
    mm_token = _acquire_mm(client)
    el_token = _acquire_element(client, eid)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {"kind": "update_element", "id": eid, "properties_patch": {"label": None}},
                {"kind": "metamodel.rebind", "blob": MM_V2},
            ],
            "message": "drop label",
            "lock_tokens": [mm_token, el_token],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == base + 1
    assert body["rebound"] is True and body["to_metamodel_id"]
    # the new schema is live and the element no longer carries the property
    session = get_session()
    assert not session.metamodel.effective_element_properties("Node")
    assert "label" not in session.model.elements[eid].properties
    # journal: ONE row, rebind columns set, ops carry both families
    hist = client.get(papi("/commits"), params={"limit": 1}).json()["commits"][0]
    assert hist["rev"] == base + 1 and hist["is_rebind"] is True
    assert hist["op_count"] == 2


def test_rebind_batch_requires_the_mm_lease(client: TestClient) -> None:
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [],
        },
    )
    assert r.status_code == 409
    assert any(m["resource_id"] == "mm" for m in r.json()["missing"])


def test_rebind_batch_requires_owner(client: TestClient) -> None:
    _seed_second_member("user-2", "user2@example.com", "editor")
    c2_token_probe = TestClient(create_app())
    c2_token_probe.headers.update(OTHER_HEADERS)
    r = c2_token_probe.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [],
        },
    )
    assert r.status_code == 403


def test_rebind_refused_while_a_peer_holds_a_model_lease(client: TestClient) -> None:
    eid = _create_node(client, "x")
    _seed_second_member("user-2", "user2@example.com", "editor")
    c2 = TestClient(create_app())
    c2.headers.update(OTHER_HEADERS)
    r = c2.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": eid, "mode": "exclusive"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 409
    assert "quiet" in r.json()["detail"]


def test_two_rebinds_in_one_batch_is_422(client: TestClient) -> None:
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "metamodel.rebind", "blob": MM_V2},
                {"kind": "metamodel.rebind", "blob": MM_V1},
            ],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 422


def test_invalid_candidate_unwinds_cleanly(client: TestClient) -> None:
    """A bad blob 422s and leaves rev, schema and journal untouched."""
    token = _acquire_mm(client)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [{"kind": "metamodel.rebind", "blob": ": not yaml ["}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 422
    session = get_session()
    assert session.model_rev == base
    assert session.metamodel.effective_element_properties("Node")  # V1 intact


def test_mid_batch_model_failure_restores_the_old_schema(client: TestClient) -> None:
    """Rebind applies, then a model op hits the mutation boundary: the whole
    batch unwinds — old schema back in memory, rev unchanged.

    The failing op is a patch that is only invalid under the CANDIDATE
    schema (`label` exists in V1, is gone in V2): its 422 therefore also
    proves the model half validated against the swapped-in schema."""
    eid = _create_node(client, "x")
    mm_token = _acquire_mm(client)
    el_token = _acquire_element(client, eid)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {"kind": "metamodel.rebind", "blob": MM_V2},
                {"kind": "update_element", "id": eid, "properties_patch": {"label": "y"}},
            ],
            "message": "",
            "lock_tokens": [mm_token, el_token],
        },
    )
    assert r.status_code == 422
    session = get_session()
    assert session.model_rev == base
    assert session.metamodel.effective_element_properties("Node")  # V1 restored
    # and the durable binding did not move either
    r2 = client.get(papi("/metamodel/raw"))
    assert r2.json()["blob"] == MM_V1


def test_layout_only_commit_is_cheap_and_journalled(client: TestClient) -> None:
    token = _acquire_mm(client)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {"kind": "metamodel.move_node", "node": "el:Node", "pos": {"x": 5, "y": 6}}
            ],
            "message": "arrange",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == base + 1
    assert r.json()["rebound"] is False
    layout = client.get(papi("/metamodel/layout")).json()
    assert layout["positions"]["el:Node"] == {"x": 5.0, "y": 6.0}
    hist = client.get(papi("/commits"), params={"limit": 1}).json()["commits"][0]
    assert hist["is_rebind"] is False and hist["op_count"] == 1


def test_stale_batch_below_a_rebind_conflicts_unconditionally(client: TestClient) -> None:
    eid = _create_node(client, "x")
    stale_base = _rev(client)
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    # a peer batch computed at stale_base, touching something unrelated,
    # must still 409: the schema moved under it.
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [
                {"kind": "update_element", "id": eid, "properties_patch": {}},
            ],
            "message": "",
            "lock_tokens": [],
        },
    )
    assert r.status_code == 409


def test_strict_mode_exempts_rebind_batches(client: TestClient) -> None:
    """A rebind that mints conformance issues still lands under strict mode
    (Phase 6B: the engine stays inspectable)."""
    _create_node(client, "x")
    from data_rover.api import db as _db
    from data_rover.api.session import DEFAULT_PROJECT_ID

    gen = _db.get_db()
    s = next(gen)
    try:
        content.set_strict_mode(s, DEFAULT_PROJECT_ID, True)
    finally:
        gen.close()
    get_session().strict_mode = True
    token = _acquire_mm(client)
    # V3 makes `label` mandatory -> existing element without it is a
    # conformance (multiplicity) issue under the new schema.
    mm_v3 = (
        "elements:\n  - name: Node\n    properties:\n"
        "      - name: label\n        datatype: string\n        multiplicity: '1'\n"
    )
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": mm_v3}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["validation_error_count"] >= 1
```

Adjust `mm_v3`'s multiplicity syntax to whatever `examples/smart-city.metamodel.yaml` uses if `'1'` is not the mandatory spelling — check the example file and `tests/validation/` fixtures; the test's intent is "existing element newly violates the candidate schema, commit still lands under strict mode". Add the needed imports (`content`, `create_app`) at the top of the test file.

- [ ] **Step 2: Run to verify failure** — `pixi run -e core-dev pytest tests/api/test_commits_metamodel_ops.py -v` → the new tests FAIL (422 stub from Task 2).

- [ ] **Step 3: Implement.**

**(a) `schemas.py`** — add to `CommitResponse`:

```python
    #: True when this commit carried a metamodel.rebind: the client must
    #: refetch the metamodel + issues (there is no applyable schema delta).
    rebound: bool = False
    to_metamodel_id: str | None = None
```

**(b) `routes/ops.py::_persist_commit`** — add keyword params `_from_metamodel_id: str | None = None, _to_metamodel_id: str | None = None` and pass them to `content.append_commit(..., from_metamodel_id=_from_metamodel_id, to_metamodel_id=_to_metamodel_id)`.

**(c) `routes/commits.py::_CommitUnwind`** — add field + unwind stage:

```python
    prior_metamodel: Metamodel | None = None
```

(import `Metamodel` from `data_rover.core.metamodel.schema`). In `unwind()`, insert AFTER the `model_res` rollback and BEFORE the rev decrement:

```python
        if self.prior_metamodel is not None:
            # Reverse of apply order: the swap went in first, so it unwinds
            # after the model ops that were applied on top of it. Restores
            # all four pieces the swap touched; validation is nulled (not
            # restored) so the next read re-seeds a full run — set_full may
            # already have replaced the store by the time a failure lands.
            self.session.metamodel = self.prior_metamodel
            self.model.metamodel = self.prior_metamodel
            self.model.indexes.rebuild()
            self.session.validation = None
```

Also extend the docstring's field-order invariants with one line for the new stage.

**(d) `create_commit`** — the integration. Add imports: `from ..metamodel_ops import MetamodelBatchResult, apply_metamodel_ops, split_rebind`, `from ..feed import rebind_event` (extend the existing feed import), `from ..hydration import write_snapshot` (extend), `from ..authz import require_membership` (already imported), `from ..db_models import Membership, Role` (extend), `from data_rover.core.validation.scope import Scope`. Add the dependency `membership: Membership = Depends(require_membership)` to the signature. Then, replacing the Task-2 stub:

1. After `split_ops`: `rebind_op, mm_moves = split_rebind(metamodel_ops)` (raises the one-rebind 422 pre-mutex). Then the role gate:

```python
    if rebind_op is not None and membership.role is not Role.owner:
        raise HTTPException(
            status_code=403, detail="metamodel changes require the owner role"
        )
```

(Check `Role`'s member spelling in `db_models.py` — `Role.owner` vs `Role.OWNER` — and match it.)

2. Inside the mutex, AFTER the missing-lock 409 and BEFORE the model apply, the quiet-peers guard:

```python
        if rebind_op is not None:
            # Today's rebind guarantee, scoped to PEERS: a schema swap must
            # not invalidate someone else's open model check-out. The
            # CALLER's own leases are the point of a migration batch — it
            # holds locks on the very elements it is fixing.
            peer_model = [
                le
                for le in session.lock_table.active_leases(time.monotonic())
                if le.holder != user.id and is_model_resource(le.resource_id)
            ]
            if peer_model:
                unwind.unwind()
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": "active locks; rebind requires a quiet project"
                    },
                )
```

(import `is_model_resource` from `..locking`).

3. Apply the metamodel half FIRST (before `_apply_batch`), registering DB staging and the unwind handle:

```python
        mm_res: MetamodelBatchResult | None = None
        if metamodel_ops:
            unwind.db_staged = True  # apply stages rows via flush
            try:
                mm_res = apply_metamodel_ops(db, project_id, session, metamodel_ops)
            except Exception:
                unwind.unwind()
                raise
            unwind.prior_metamodel = mm_res.prior_metamodel
```

4. The existing model/artifact/view applies run unchanged after it (model ops now validate against the swapped-in schema).

5. Validation (step c): replace the fixed `res.dirty.to_scope()` call with:

```python
        rebound = mm_res is not None and mm_res.rebound
        if rebound:
            # A schema change invalidates the dirty-scope premise for the
            # whole batch: re-validate everything (the same O(model) cost the
            # retired rebind route paid) and REPLACE the store below.
            scoped = default_pipeline().validate(model, Scope.all())
        else:
            scoped = default_pipeline().validate(model, res.dirty.to_scope())
```

Strict-mode gate becomes `if session.strict_mode and conformance and not rebound:` — update its comment: rebind batches stay exempt BY DECISION (Phase 6B: the engine stays inspectable; a schema migration on a strict project must not be impossible).

6. Step d: the issue-store write branches:

```python
        if rebound:
            state.set_full(scoped)
            issues_removed: list[str] = []
            issues_added = [IssueOut.from_core(i) for i in scoped]
        else:
            delta = state.replace(res.dirty.ids, scoped)
            issues_removed = delta.removed_owner_ids
            issues_added = [IssueOut.from_core(i) for i in delta.added]
```

and the two `CommitResponse` fields at the end use `issues_removed`/`issues_added`. Cache invalidation: for `rebound`, call `session.invalidate_derived_caches()` unconditionally (mirror the rebind route — every derived row order changed) instead of the `touched_keys` branch.

7. Journal merge: extend the three merged lists with the metamodel half (family order: model, artifact, view, metamodel — order across families carries no meaning, but keep metamodel LAST so `_view_diffs`-style front-to-back readers see no change):

```python
        canonical_ops: list[OpIn] = [
            *res.canonical_ops,
            *art_res.canonical_ops,
            *(view_res.canonical_ops if view_res else []),
            *(mm_res.canonical_ops if mm_res else []),
        ]
        inverse_ops: list[OpIn] = [
            *res.inverse_ops(),
            *art_res.inverse_ops(),
            *(view_res.inverse_ops() if view_res else []),
            *(mm_res.inverse_ops() if mm_res else []),
        ]
```

8. Persist: pass `_from_metamodel_id=mm_res.from_metamodel_id if mm_res else None, _to_metamodel_id=mm_res.to_metamodel_id if mm_res else None` to `_persist_commit`. Extend the orphan-DB-state guard: `if (artifact_ops or view_ops or metamodel_ops) and not persisted: db.commit()`.

9. Snapshot: for `rebound and persisted`, FORCE a snapshot instead of the periodic check (keeps "the replay tail never spans a rebind boundary"):

```python
        if persisted:
            try:
                if rebound:
                    # FORCED, not periodic: keeps "the replay tail never
                    # spans a rebind boundary" (hydration loads the CURRENT
                    # metamodel and would replay pre-rebind ops under it).
                    write_snapshot(project_id, session, session.model_rev)
                else:
                    _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
            except Exception:
                logger.warning(
                    "post-commit snapshot failed for project %s at rev %s; "
                    "commit is durable, hydration will rebuild",
                    project_id,
                    session.model_rev,
                    exc_info=True,
                )
```

10. Broadcast: scope gains the layout family, and a rebound commit emits `rebind_event` INSTEAD of `commit_event` (peers cannot apply a delta across a schema swap — they get the reload banner, exactly like today):

```python
        scope = sorted(
            ({"model"} if model_ops else set())
            | ({"artifact"} if artifact_ops else set())
            | ({"view"} if view_ops else set())
            | ({"metamodel-layout"} if mm_moves else set())
        ) or ["model"]
        if rebound:
            session.hub.broadcast(
                rebind_event(
                    rev=session.model_rev,
                    from_metamodel_id=mm_res.from_metamodel_id,
                    to_metamodel_id=mm_res.to_metamodel_id or "",
                    validation_error_count=len(conformance),
                )
            )
        else:
            session.hub.broadcast(commit_event(rev=..., scope=scope, ...unchanged...))
```

11. Response: add `rebound=rebound, to_metamodel_id=mm_res.to_metamodel_id if mm_res else None`.

- [ ] **Step 4: Run the tests** — `pixi run -e core-dev pytest tests/api/test_commits_metamodel_ops.py -v` → all PASS. Then the full commit suites: `pixi run -e core-dev pytest tests/api/test_commits_route.py tests/api/test_commits_artifact_ops.py tests/api/test_commits_view_ops.py tests/api/test_commit_conflict_backstop.py tests/api/test_commit_metamodel_columns.py -q` → PASS (the added `membership` dependency and unchanged defaults must not disturb them).

- [ ] **Step 5: Commit** — `git commit -m "feat(api): metamodel ops flow through POST /commits (migration batches)"`

---

### Task 6: `POST /commits/preview` dry-runs metamodel batches

**Files:**
- Modify: `src/data_rover/api/routes/commits.py:420-488` (`preview_commit`)
- Test: `tests/api/test_commits_metamodel_ops.py` (append)

**Interfaces:**
- Consumes: `split_rebind`, `load_candidate` from `metamodel_ops`.
- Produces: preview accepts rebind batches; `would_block` is always False for them; NO DB writes, NO session mutation survives.

- [ ] **Step 1: Write the failing tests:**

```python
def test_preview_dry_runs_a_migration_batch(client: TestClient) -> None:
    eid = _create_node(client, "hello")
    base = _rev(client)
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": base,
            "ops": [
                {"kind": "metamodel.rebind", "blob": MM_V2},
                {"kind": "update_element", "id": eid, "properties_patch": {"label": None}},
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["would_block"] is False
    # side-effect free: old schema still live, rev unchanged, raw blob unchanged
    session = get_session()
    assert session.model_rev == base
    assert session.metamodel.effective_element_properties("Node")
    assert client.get(papi("/metamodel/raw")).json()["blob"] == MM_V1
    assert "label" in session.model.elements[eid].properties


def test_preview_422s_a_bad_candidate(client: TestClient) -> None:
    r = client.post(
        papi("/commits/preview"),
        json={"base_rev": _rev(client), "ops": [{"kind": "metamodel.rebind", "blob": ": ["}]},
    )
    assert r.status_code == 422
```

- [ ] **Step 2: Run to verify failure** — the Task-2 stub 422s the first test.

- [ ] **Step 3: Implement.** In `preview_commit`, replace the stub. Pre-mutex: `rebind_op, mm_moves = split_rebind(metamodel_ops)` and `candidate = load_candidate(rebind_op.blob) if rebind_op is not None else None` (both raise their 422s before any lock). Move-node ops need no further validation (schema shape suffices). Inside the mutex, wrap the model apply:

```python
        prior_mm = session.metamodel
        if candidate is not None:
            # In-memory ONLY (no DB writes — preview must stay side-effect
            # free): swap so the model ops validate against the candidate,
            # exactly as the real commit will.
            assert prior_mm is not None
            session.metamodel = candidate
            model.metamodel = candidate
            model.indexes.rebuild()
        try:
            res = _apply_batch(model, model_ops, restore=False)
            try:
                scope_arg = (
                    Scope.all() if candidate is not None else res.dirty.to_scope()
                )
                scoped = default_pipeline().validate(model, scope_arg)
            finally:
                _rollback(model, res.inverse_units)
        finally:
            if candidate is not None:
                session.metamodel = prior_mm
                model.metamodel = prior_mm
                model.indexes.rebuild()
            session.invalidate_derived_caches()
```

and change the final `would_block` to `session.strict_mode and len(conformance) > 0 and rebind_op is None` (with a comment: rebind batches are strict-exempt, mirroring `create_commit`).

- [ ] **Step 4: Run** — the two new tests + `pixi run -e core-dev pytest tests/api/test_commits_route.py -q` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): commit preview dry-runs metamodel batches"`

---

### Task 7: Undo — layout ops replay; rebind batches refuse cleanly

**Files:**
- Modify: `src/data_rover/api/routes/ops.py` (`undo`)
- Test: `tests/api/test_commits_metamodel_ops.py` (append)

**Interfaces:**
- Consumes: `apply_metamodel_ops`, `METAMODEL_RESOURCE`.
- Produces: undo of a layout-carrying batch replays `move_node` inverses (honoring a peer's `mm` lease); undo of a rebind-carrying batch push-backs + 409 (plan deviation, recorded in spec).

- [ ] **Step 1: Write the failing tests:**

```python
def test_undo_restores_layout_positions(client: TestClient) -> None:
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "metamodel.move_node", "node": "el:Node", "pos": {"x": 5, "y": 6}}
            ],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    layout = client.get(papi("/metamodel/layout")).json()
    assert "el:Node" not in layout["positions"]  # prior state: key absent


def test_undo_refuses_rebind_batches_and_keeps_history(client: TestClient) -> None:
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    r = client.post(papi("/model/undo"))
    assert r.status_code == 409
    # push-back: a second undo attempt hits the same refusal, not "Nothing to undo"
    r = client.post(papi("/model/undo"))
    assert r.status_code == 409
    assert "metamodel" in r.json()["detail"]
```

- [ ] **Step 2: Run to verify failure** — the first test FAILS on the Task-2 blanket 409.

- [ ] **Step 3: Implement.** In `undo`, replace the Task-2 stub with:

```python
        if any(op.kind == "metamodel.rebind" for op in metamodel_inv):
            # PLAN DEVIATION (spec amendment 2026-08-16): restore-mode model
            # inverses are schema-checked at the core mutation boundary
            # (_check_patch_keys + Model.set_property), so replaying them
            # across a schema swap fails whichever side of the swap-back
            # they run on. Refused cleanly, history intact — a "new rebind
            # back" through the editor is the supported path.
            session.op_log.append(batch)
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "undo across a metamodel change is not supported; "
                    "rebind back through the metamodel editor instead",
                    "model_rev": session.model_rev,
                },
            )
```

Then wire the layout half through the existing structure:
- Add `METAMODEL_RESOURCE` to the peer-guard resources when `metamodel_inv` is non-empty: `peer_resources = [...] + ([METAMODEL_RESOURCE] if metamodel_inv else [])` (import from `..locking`; the `mm` lease is the layout's only concurrency control, same honor rule as `art:`/`folder:`).
- After the view half's apply and before the rev bump, apply the metamodel half (staged on this request's transaction — `db.rollback()` in every later failure path already discards it):

```python
        mm_res = None
        if metamodel_inv:
            try:
                mm_res = apply_metamodel_ops(db, project_id, session, metamodel_inv)
            except Exception:
                _rollback(model, res.inverse_units)
                session.invalidate_derived_caches()
                if view_res is not None:
                    assert session.view is not None
                    rollback_view(session.view, view_res.inverse_units)
                if created_view:
                    session.view = None
                session.op_log.append(batch)
                db.rollback()
                raise
```

(the rebind arm of `apply_metamodel_ops` is unreachable here — the 409 above filtered it; `mm_res.rebound` is always False.)
- Extend `canonical_ops`/`inverse_ops`/`merged_id_map` with `mm_res`'s halves (same spread pattern as the view half; `mm_res` contributes no id_map).
- Extend the persist-failure rollback branch with nothing new (staged layout rows die with `db.rollback()`), and extend the in-memory-only guard to `(artifact_inv or view_inv or metamodel_inv) and not persisted`.

- [ ] **Step 4: Run** — both new tests + `pixi run -e core-dev pytest tests/api/test_undo_view_ops.py tests/api/test_undo_artifact_ops.py -q` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): undo replays layout ops; rebind batches refuse with 409"`

---

### Task 8: Revert refusal + commit-diff rendering + scope

**Files:**
- Modify: `src/data_rover/api/routes/commits.py` (`revert_commit`), `src/data_rover/api/commit_diff.py`, `src/data_rover/api/schemas.py` (`CommitDiffOut` + `LayoutMoveOut`)
- Test: `tests/api/test_commits_revert.py` (append), `tests/api/test_commit_diff.py` (append)

**Interfaces:**
- Produces: `LayoutMoveOut(node: str, x: float | None, y: float | None)`; `CommitDiffOut.layout_moves: list[LayoutMoveOut] = []`; diff `scope` gains `"metamodel-layout"`; revert 409s on `METAMODEL_OP_KINDS` in range.

- [ ] **Step 1: Write the failing tests** — append to `tests/api/test_commits_revert.py` (mirror that file's fixtures — it seeds via the commit route; a layout-only commit needs the `mm` lease helper from `test_commits_metamodel_ops.py`, import it or inline it):

```python
def test_revert_409s_across_metamodel_ops(...):
    # land a layout-only commit at rev N (no rebind columns), then
    # POST /commits/revert with target_rev < N:
    assert r.status_code == 409
    assert "metamodel" in r.json()["detail"]
```

and to `tests/api/test_commit_diff.py`:

```python
def test_diff_renders_layout_moves_and_scope(...):
    # land a commit with one move_node op; GET /commits/{rev}/diff:
    body = r.json()
    assert body["scope"] == ["metamodel-layout"]
    assert body["layout_moves"] == [{"node": "el:Node", "x": 5.0, "y": 6.0}]
    assert body["is_rebind"] is False
```

Write these fully against the local fixture conventions of each file (read the first existing test in each and copy its setup shape; the assertions above are the contract).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`schemas.py`:

```python
class LayoutMoveOut(BaseModel):
    node: str
    x: float | None = None
    y: float | None = None
```

and on `CommitDiffOut`: `layout_moves: list[LayoutMoveOut] = Field(default_factory=list)`.

`routes/commits.py::revert_commit` — add a third refusal loop after the view one (same raw-dict shape, import `METAMODEL_OP_KINDS`):

```python
        for c in commits:
            # Same permanent boundary as the view family: a range revert
            # across a schema swap is exactly the undo refusal (Task 7), and
            # layout rows share the artifact family's row-identity hazard.
            if any(op.get("kind") in METAMODEL_OP_KINDS for op in c.ops):
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": "revert across metamodel changes is not supported",
                        "metamodel_commit_rev": c.rev,
                    },
                )
```

`commit_diff.py::diff_commit` — fix `has_model` to exclude the new family and add the layout scope + rendering (import `METAMODEL_OP_KINDS`, `LayoutMoveOut`, `MoveMetamodelNodeOp`):

```python
    has_layout = any(op.get("kind") == "metamodel.move_node" for op in commit.ops)
    has_model = any(
        op.get("kind") not in ARTIFACT_OP_KINDS
        and op.get("kind") not in VIEW_OP_KINDS
        and op.get("kind") not in METAMODEL_OP_KINDS
        for op in commit.ops
    )
    scope = sorted(
        ({"model"} if has_model or is_rebind else set())
        | ({"artifact"} if has_artifact else set())
        | ({"view"} if has_view else set())
        | ({"metamodel-layout"} if has_layout else set())
    ) or ["model"]
```

and build `layout_moves` from the forward metamodel ops (deserialize once alongside `_view_diffs`' pattern):

```python
def _layout_moves(commit: Commit) -> list[LayoutMoveOut]:
    """Journal-only summary of the layout half — a moved node's destination
    (x/y None = key removed). Deliberately no before/after per coordinate:
    the diff surface promises "N nodes moved", not pixel history."""
    _, _, _, forward = split_ops(deserialize_ops(commit.ops))
    return [
        LayoutMoveOut(
            node=op.node,
            x=op.pos.x if op.pos is not None else None,
            y=op.pos.y if op.pos is not None else None,
        )
        for op in forward
        if isinstance(op, MoveMetamodelNodeOp)
    ]
```

wired as `layout_moves=_layout_moves(commit)` in the `CommitDiffOut` construction.

- [ ] **Step 4: Run** — new tests + `pixi run -e core-dev pytest tests/api/test_commits_revert.py tests/api/test_commit_diff.py -q` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): revert refusal + commit-diff rendering for metamodel ops"`

---

### Task 9: Retire `POST /metamodel/rebind` and `PUT /metamodel/layout`

**Files:**
- Modify: `src/data_rover/api/routes/metamodel_swap.py` (delete the rebind route + its now-unused imports; KEEP `/metamodel/diff` and `/metamodel/lint`), `src/data_rover/api/routes/metamodel_layout.py` (delete the PUT route + payload re-export check), `src/data_rover/api/content.py` (delete `put_metamodel_layout` if grep shows no remaining caller)
- Test: `tests/api/test_metamodel_rebind.py` (rewrite), `tests/api/test_metamodel_layout.py` (trim)

**Interfaces:**
- Consumes: nothing new. `RebindResponse` in `schemas.py` becomes dead — delete it and its import sites.

- [ ] **Step 1: Update the tests first.** Rewrite `tests/api/test_metamodel_rebind.py`: replace every `POST /metamodel/rebind` call with the commit-flow equivalent OR — where the test asserted route-specific behaviour now covered by `test_commits_metamodel_ops.py` (stale rev, owner gate, quiet project, snapshot forcing, journal columns) — delete the duplicate and keep a single tombstone test:

```python
def test_rebind_route_is_gone(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel/rebind"),
        params={"base_rev": 0},
        content="elements: []\n",
        headers={"Content-Type": "application/x-yaml"},
    )
    assert r.status_code in (404, 405)
```

Same shape for `tests/api/test_metamodel_layout.py`: keep the GET tests, replace PUT tests with a tombstone (`assert r.status_code in (404, 405)`) plus one test proving GET reflects a layout landed via the commit flow.

- [ ] **Step 2: Run to verify the tombstones fail** (routes still exist).

- [ ] **Step 3: Implement.** Delete `rebind_metamodel` from `metamodel_swap.py` and prune its imports (`content`, `require_owner`, `rebind_event`, `write_snapshot`, `is_model_resource`, `RebindResponse`, `_peer_mm_conflict`, `time`, `uuid` — whatever ruff flags). Delete `put_metamodel_layout` (route) from `metamodel_layout.py`. Grep for remaining callers before deleting `content.put_metamodel_layout` and `RebindResponse`:

Run: `grep -rn "put_metamodel_layout\|RebindResponse\|/metamodel/rebind" src/ frontend/src/ --include=*.py --include=*.ts`

Frontend hits are Task 10's job — leave them; delete only backend dead code.

- [ ] **Step 4: Run** — `pixi run -e core-dev pytest tests/api/test_metamodel_rebind.py tests/api/test_metamodel_layout.py tests/api/test_metamodel_diff.py tests/api/test_metamodel_lint.py tests/api/test_metamodel_raw.py -q` → PASS. Then the FULL backend suite: `pixi run core-test` → PASS. Then `pixi run backend-lint` → clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(api)!: retire POST /metamodel/rebind and PUT /metamodel/layout"`

---

### Task 10: Frontend — op types, API client, `metamodel-stage` store, checkout wiring

**Files:**
- Modify: `frontend/src/lib/state/ops.ts`, `frontend/src/lib/api/metamodel.ts`, `frontend/src/lib/api/types.ts`, `frontend/src/lib/state/checkout.svelte.ts`, `frontend/src/lib/state/metamodel-editor.svelte.ts`, `frontend/src/lib/state/index.ts`
- Create: `frontend/src/lib/state/metamodel-stage.svelte.ts`, `frontend/src/lib/state/__tests__/metamodel-stage.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 11–12):
  - `ops.ts`: `MetamodelOp` union (`{kind:'metamodel.rebind'; blob:string} | {kind:'metamodel.move_node'; node:string; pos:{x:number;y:number}|null}`), `Op` extended, `METAMODEL_RESOURCE = 'mm'`.
  - `metamodel-stage.svelte.ts`: `initMetamodelStage(projectId)`, `closeMetamodelStage()`, `registerMetamodelDraftProvider(p: () => {dirty:boolean; blob:string})`, `stageNodeMove(node: string, pos: {x:number;y:number}|null)`, `getStagedNodeMoves(): ReadonlyMap<string, {x:number;y:number}|null>`, `getStagedMetamodelOps(): MetamodelOp[]` (rebind FIRST, then moves), `getStagedMetamodelDepth(): number` (dirty?1:0 + moves.size), `clearStagedNodeMoves()`, `discardStagedNodeMoves()`, `onMetamodelCommitted(cb: (info:{rebound:boolean; blob:string|null}) => void): () => void`, `notifyMetamodelCommitted(info)`.
  - `metamodel-editor.svelte.ts`: `commitMetamodelRebind` DELETED; module-scope registration of the draft provider + a committed-listener that adopts the baseline (ported body of the deleted function, minus the HTTP call).
  - `checkout.svelte.ts`: batch = `[...getStagedMetamodelOps(), ...model, ...artifact, ...view]`; `lockedResourcesNeededBy` gains the two `metamodel.*` cases adding `'mm'`; `releaseMetamodelLease` keeps the lease while `getStagedMetamodelDepth() > 0`; post-commit: `clearStagedNodeMoves()` + `notifyMetamodelCommitted({rebound, blob})` + on rebound `void adoptReboundMetamodel()` (fetch metamodel → `setMetamodel`, `refetchIssues`, `refreshSummary`).

- [ ] **Step 1: Write the failing tests** — `frontend/src/lib/state/__tests__/metamodel-stage.test.ts` (mirror the setup idioms of the neighbouring `__tests__` files — imports of `$lib/state` go through the vitest aliases already configured):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearStagedNodeMoves,
	getStagedMetamodelDepth,
	getStagedMetamodelOps,
	initMetamodelStage,
	notifyMetamodelCommitted,
	onMetamodelCommitted,
	registerMetamodelDraftProvider,
	stageNodeMove
} from '../metamodel-stage.svelte';

describe('metamodel-stage', () => {
	beforeEach(() => {
		initMetamodelStage('p1');
		clearStagedNodeMoves();
		registerMetamodelDraftProvider(() => ({ dirty: false, blob: '' }));
	});

	it('coalesces repeated moves of the same node', () => {
		stageNodeMove('el:A', { x: 1, y: 1 });
		stageNodeMove('el:A', { x: 2, y: 2 });
		const ops = getStagedMetamodelOps();
		expect(ops).toEqual([
			{ kind: 'metamodel.move_node', node: 'el:A', pos: { x: 2, y: 2 } }
		]);
		expect(getStagedMetamodelDepth()).toBe(1);
	});

	it('puts the rebind op first when the draft is dirty', () => {
		registerMetamodelDraftProvider(() => ({ dirty: true, blob: 'elements: []\n' }));
		stageNodeMove('el:A', null);
		const ops = getStagedMetamodelOps();
		expect(ops[0]).toEqual({ kind: 'metamodel.rebind', blob: 'elements: []\n' });
		expect(ops[1]).toEqual({ kind: 'metamodel.move_node', node: 'el:A', pos: null });
		expect(getStagedMetamodelDepth()).toBe(2);
	});

	it('notifies committed listeners', () => {
		const cb = vi.fn();
		const off = onMetamodelCommitted(cb);
		notifyMetamodelCommitted({ rebound: true, blob: 'x' });
		expect(cb).toHaveBeenCalledWith({ rebound: true, blob: 'x' });
		off();
	});

	it('persists staged moves per project in localStorage', () => {
		stageNodeMove('el:A', { x: 3, y: 4 });
		initMetamodelStage('p1'); // re-open restores
		expect(getStagedMetamodelOps()).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pixi run frontend-test -- run metamodel-stage` → module not found.

- [ ] **Step 3: Implement.**

`ops.ts` — after `ViewOp`:

```ts
/**
 * Metamodel-family ops (spec 2026-08-16) — mirror of the backend's
 * MetamodelOpIn (api/schemas.py). Applied by POST /commits to the session
 * metamodel + metamodel_layouts blob; /model/ops rejects them. At most one
 * rebind per batch (the server hoists it first); `pos: null` removes a
 * layout key.
 */
export type MetamodelOp =
	| { kind: 'metamodel.rebind'; blob: string }
	| { kind: 'metamodel.move_node'; node: string; pos: { x: number; y: number } | null };
```

extend `Op` with `| MetamodelOp`, and add:

```ts
/** Client mirror of api/locking.py's METAMODEL_RESOURCE (singleton lease). */
export const METAMODEL_RESOURCE = 'mm';
```

`metamodel-stage.svelte.ts` — new module, the view-edits listener pattern (imports ONLY from `./ops` and svelte/reactivity, so checkout/editor/diagram can all import it without cycles). Store `_moves` in a `SvelteMap`, `_projectId`, localStorage key `ui.metamodel.layoutdraft.<projectId>` (same try/catch idiom as `metamodel-editor.svelte.ts`'s draft helpers), a `_draftProvider` slot, and the committed-listener registry mirroring `onViewCommitted`. `initMetamodelStage` restores the moves from storage; `stageNodeMove` writes through; `clearStagedNodeMoves` (commit success — silent) and `discardStagedNodeMoves` (user discard — also clears storage) both empty the map.

`metamodel-editor.svelte.ts`:
- Delete `commitMetamodelRebind` and its imports (`rebindMetamodelApi`, `isProjectQuiet`, `getModelRev`).
- At module scope, register the provider and the committed listener:

```ts
registerMetamodelDraftProvider(() => ({
	dirty: isMetamodelEditorDirty(),
	blob: _buffer
}));

onMetamodelCommitted(({ rebound, blob }) => {
	// The commit-flow port of the deleted commitMetamodelRebind's success
	// body: the server has adopted `blob`, whatever the buffer holds now.
	if (blob === null || _phase !== 'ready') return;
	_baseline = blob;
	_source = 'stored';
	_preview = null;
	_previewFor = null;
	_draftRestored = false;
	if (_buffer === blob) clearDraftStorage();
	else writeDraftNow(); // mid-flight keystrokes stay dirty on the new baseline
	_leaseHeld = false; // the commit surrendered the mm token server-side
	void rebound; // metamodel/issue refetch is checkout's adoptReboundMetamodel
});
```

`checkout.svelte.ts`:
- `previewStaged`/`commitStaged` batch: in `commitStaged`, capture ONCE at the top — `const mmOps = getStagedMetamodelOps();` — and build `const ops: Op[] = [...mmOps, ...getStagedOps(), ...getStagedArtifactOps(), ...getStagedViewOps()];` so the post-success notify below describes exactly what was sent (the buffer can move mid-flight, same hazard the deleted `commitMetamodelRebind` handled with its `sent` capture). `previewStaged` composes the same way inline. Metamodel FIRST — the server hoists the rebind anyway; first keeps the drawer's mental model "schema, then data".
- `lockedResourcesNeededBy`: add

```ts
			case 'metamodel.rebind':
			case 'metamodel.move_node':
				needed.add(METAMODEL_RESOURCE);
				break;
```

- `releaseMetamodelLease`: first line becomes

```ts
	if (getStagedMetamodelDepth() > 0) return; // staged metamodel work still needs the lease
```

(update its docstring: the "never needed by staged ops" claim is now false and the guard mirrors its artifact/folder siblings).
- `commitStaged` post-success (between `clearStagedView()` and the token drop): from the `mmOps` captured above, derive `const mmBlob = (mmOps.find((o) => o.kind === 'metamodel.rebind') as {blob?: string} | undefined)?.blob ?? null;` then after `clearStagedView()`:

```ts
		clearStagedNodeMoves();
		notifyMetamodelCommitted({ rebound: res.rebound === true, blob: mmBlob });
		if (res.rebound === true) void adoptReboundMetamodel();
```

with:

```ts
/** Own-commit rebind adoption (the port of MetamodelTab's old onRebind):
 * peers get the rebind_event reload banner; the committer refetches in
 * place. Best-effort — the commit is durable either way. */
async function adoptReboundMetamodel(): Promise<void> {
	try {
		const mm = await getMetamodel(_clientConfig);
		setMetamodel(mm);
		await refetchIssues();
		await refreshSummary();
	} catch {
		/* stale view only; the workspace's pendingRebind/reload path still exists */
	}
}
```

(import `getMetamodel` from `$lib/api/metamodel`, `setMetamodel`, `refetchIssues`, `refreshSummary` from `./model.svelte` — check the actual export homes with grep and import from there; `state/index.ts` re-exports are for components, stores import sibling modules directly.)

`api/types.ts` — extend the commit-response zod schema (find `CommitResponseSchema` / the schema `commitChanges` parses with) with `rebound: z.boolean().optional()` and `to_metamodel_id: z.string().nullable().optional()`.

`api/metamodel.ts` — delete `rebindMetamodel` and `putMetamodelLayout` (+ their type imports); keep `getMetamodelLayout`, `diffMetamodel`, `lintMetamodel`, `getMetamodelRaw`. Delete `RebindSchema`/`Rebind` from `types.ts` if now unreferenced (grep first).

`state/index.ts` — export the new stage module's public functions; remove the `commitMetamodelRebind` export.

- [ ] **Step 4: Run** — `pixi run frontend-test -- run metamodel-stage checkout` → new tests PASS; fix the existing checkout/metamodel-editor test files the deletions break (tests exercising `commitMetamodelRebind` move to Task 12's drawer-flow coverage or are deleted where they tested the HTTP call itself).

- [ ] **Step 5: Commit** — `git commit -m "feat(frontend): metamodel staging store + commit batch wiring"`

---

### Task 11: Frontend — diagram stages moves; rename-deferral machinery deleted

**Files:**
- Modify: `frontend/src/lib/state/metamodel-diagram.svelte.ts`, its test file(s) (`grep -rl "pendingRenames\|serverPositions\|LAYOUT_SAVE" frontend/src`)
- Test: existing diagram state tests (rewrite the layout/rename sections)

**Interfaces:**
- Consumes: `stageNodeMove`, `discardStagedNodeMoves`, `getStagedNodeMoves`, `initMetamodelStage`, `closeMetamodelStage`, `onMetamodelCommitted` (Task 10).
- Produces: `moveNode`/`runAutoArrange`/rename/delete gestures stage `metamodel.move_node` ops; NO live PUT anywhere; `onMetamodelRebound()` shrinks to undo-history + baseline concerns.

- [ ] **Step 1: Write/adjust the failing tests.** In the diagram state test file, add:

```ts
it('a drag stages a coalesced move op instead of PUTting', async () => {
	// arrange: init editor with a parseable buffer + init diagram (existing
	// helpers in this file); then:
	moveNode('el:Node', { x: 10, y: 20 });
	moveNode('el:Node', { x: 11, y: 21 });
	expect(getStagedMetamodelOps()).toEqual([
		{ kind: 'metamodel.move_node', node: 'el:Node', pos: { x: 11, y: 21 } }
	]);
	// and no PUT was issued (assert via the module's fetch/api mock)
});

it('a diagram rename migrates the layout key as two staged ops', () => {
	// apply a renameElementType command via applyDiagramEdit, then:
	const ops = getStagedMetamodelOps().filter((o) => o.kind === 'metamodel.move_node');
	expect(ops).toContainEqual({ kind: 'metamodel.move_node', node: 'el:Old', pos: null });
	expect(ops.find((o) => o.node === 'el:New')?.pos).toBeTruthy();
});
```

Delete the tests that exercise `_pendingRenames` persistence, `serverPositions` inversion, `liveRenames` pruning, and the debounced PUT (`LAYOUT_SAVE_DEBOUNCE_MS`).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `metamodel-diagram.svelte.ts`:

- **Delete**: `putMetamodelLayout` import, `LAYOUT_SAVE_DEBOUNCE_MS`, `_saveTimer`, `saveNow`, `scheduleSave`, `flushSave`, `canSaveLayout`, `_pendingRenames`, `renamesKey`, `persistRenames`, `restoreRenames`, `liveRenames`, `serverPositions`, `localPositions`, the `KeySnapshot.renames` half (undo snapshots keep positions only), and the module-docstring paragraphs describing the deferral (replace with two sentences: positions stage as `metamodel.move_node` ops and land atomically with the draft's rebind, so keys are always draft-keys — the deferral problem no longer exists).
- **`moveNode`** becomes:

```ts
export function moveNode(nodeId: string, pos: XY): void {
	_positions = { ..._positions, [nodeId]: { x: pos.x, y: pos.y } };
	if (getRole() !== 'viewer') stageNodeMove(nodeId, { x: pos.x, y: pos.y });
}
```

(viewers keep local-only drags — nothing to commit, same as today's no-save gate).
- **`applyKeyMove`** (rename/delete): replace the deferral bookkeeping with staging:

```ts
function applyKeyMove(move: { from: string; to: string | null }): void {
	const next = { ..._positions };
	const pos = next[move.from];
	delete next[move.from];
	if (move.to !== null && pos !== undefined) next[move.to] = pos;
	_positions = next;
	if (getRole() === 'viewer') return;
	// The layout key migrates WITH the rename, in the same commit: old key
	// removed, new key claims the position. A delete just removes the key.
	stageNodeMove(move.from, null);
	if (move.to !== null && pos !== undefined) stageNodeMove(move.to, pos);
}
```

- **`runAutoArrange`**: after `_positions = arranged;`, stage every arranged node (`for (const [id, p] of Object.entries(arranged)) stageNodeMove(id, p);` behind the viewer guard). The INIT-time auto-arrange of a never-arranged diagram stays LOCAL-only (no staging — first-open must not manufacture a pending commit); delete the `layoutRead`-gated `scheduleSave()` tail of `initMetamodelDiagram`.
- **`initMetamodelDiagram`**: call `initMetamodelStage(projectId)` first; after fetching the baseline layout, overlay restored staged moves: `for (const [node, pos] of getStagedNodeMoves()) { if (pos === null) delete next[node]; else next[node] = pos; }` before assigning `_positions`.
- **`closeMetamodelDiagram`**: drop `flushSave()`; staged moves survive in the stage store/localStorage (that is the point).
- **`onMetamodelRebound`** shrinks to: guard on `_projectId`, clear `_undo`/`_canUndo`. (Peer-rebind reload and own-commit adoption both refetch through init paths.)
- Register a committed listener at module scope: on commit, refetch the baseline (`getMetamodelLayout()`) and re-derive `_positions` (staged moves are now empty), and clear undo history when `rebound`:

```ts
onMetamodelCommitted(({ rebound }) => {
	if (_projectId === null) return;
	if (rebound) {
		_undo = [];
		_canUndo = false;
	}
	void getMetamodelLayout()
		.then((layout) => {
			_positions = clonePositions(layout.positions);
		})
		.catch(() => {});
});
```

- Subscribe to peer layout commits: in `initMetamodelDiagram`, register `onCommitEvent(({scope}) => { if (scope.includes('metamodel-layout')) void refetchBaselineLayout(); })` and unsubscribe in `closeMetamodelDiagram` (import `onCommitEvent` from `./realtime.svelte`; keep the refetch overlay-aware — staged moves reapply on top).

- [ ] **Step 4: Run** — `pixi run frontend-test -- run metamodel` → PASS; `pixi run frontend-check` → clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(frontend): diagram positions stage as move ops; rename-deferral machinery deleted"`

---

### Task 12: Frontend — MetamodelTab, DiffDrawer, quiet/unsaved, realtime polish

**Files:**
- Modify: `frontend/src/lib/components/Metamodel/MetamodelTab.svelte`, `frontend/src/lib/components/DiffDrawer.svelte`, `frontend/src/lib/state/quiet.ts`, `frontend/src/lib/state/unsaved.ts`, `frontend/src/lib/state/index.ts`
- Test: existing component/store tests for the drawer + unsaved + quiet

**Interfaces:**
- Consumes: `getStagedMetamodelDepth`, `getStagedNodeMoves`, `discardStagedNodeMoves` (Task 10); `discardMetamodelDraft` (existing).
- Produces: `discardMetamodelChanges()` composite in `metamodel-stage`-adjacent code (drawer's one discard for the section).

- [ ] **Step 1: Write the failing tests:**
- quiet: `isProjectQuiet()` returns false while a metamodel draft is dirty or moves are staged (extend the quiet test file with the new term, mocking `getStagedMetamodelDepth`).
- unsaved: `hasUnsavedWork()` true when `getStagedMetamodelDepth() > 0`.
- drawer (store-level, matching how existing drawer logic is tested): total includes the metamodel depth.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`quiet.ts` — add the term + docstring bullet ("staged METAMODEL ops ride the same commit batch, so a revert invalidates them by the same rev bump"):

```ts
		getStagedMetamodelDepth() === 0 &&
```

`unsaved.ts` — add `getStagedMetamodelDepth() > 0` to `hasUnsavedWork()` and REWRITE the "deliberately NO metamodel-editor term" paragraph: the buffer/moves are staged commit content now; both restore from localStorage, but the term keeps the leave-guard consistent with every other staged family. `isTabDirty('metamodel', …)` becomes `isMetamodelEditorDirty() || getStagedMetamodelDepth() > 0`.

`MetamodelTab.svelte`:
- Delete: the Rebind button, `message` input, `quiet` derivation + warning paragraph, `onRebind`, `refreshError`, imports of `commitMetamodelRebind` / `isProjectQuiet` / `onMetamodelRebound` / `fetchMetamodel` / `setMetamodel` / `adoptIssues` / `refreshSummary`.
- Keep: Preview button + panel, Discard (now also clears staged moves — call a new composite):

```ts
function onDiscard(): void {
	discardMetamodelDraft();
	discardStagedNodeMoves();
}
```

- Add a hint line where Rebind was:

```svelte
{#if ed.dirty || stagedMoveCount > 0}
	<p class="text-xs text-muted-foreground">
		Metamodel changes are staged — review and commit them from the Commit drawer.
	</p>
{/if}
```

with `const stagedMoveCount = $derived(getStagedNodeMoves().size);`.

`DiffDrawer.svelte`:
- `const mmDepth = $derived(getStagedMetamodelDepth());` and fold into `total`.
- New section on the Changes tab (after Artifacts), rendering at most two rows:

```svelte
{#if mmDepth > 0}
	<section class="flex flex-col gap-1">
		<h3 class="text-xs font-semibold text-info">Metamodel ({mmDepth})</h3>
		{#if mmDraftDirty}
			<div class="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs">
				<span class="w-3 font-mono text-warning">~</span>
				<span class="font-mono text-foreground">metamodel schema (YAML edited)</span>
			</div>
		{/if}
		{#if stagedMoveCount > 0}
			<div class="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs">
				<span class="w-3 font-mono text-warning">~</span>
				<span class="font-mono text-foreground">
					{stagedMoveCount} diagram node{stagedMoveCount === 1 ? '' : 's'} moved
				</span>
			</div>
		{/if}
		<button type="button" class="self-start rounded border border-input px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-ring hover:text-foreground"
			onclick={onDiscardMetamodel}>
			Discard metamodel changes
		</button>
	</section>
{/if}
```

with `mmDraftDirty` from `getMetamodelEditor().dirty` (or `isMetamodelEditorDirty()`), `stagedMoveCount` from `getStagedNodeMoves().size`, and `onDiscardMetamodel` calling the same composite as the tab (`discardMetamodelDraft(); discardStagedNodeMoves();`). All-or-nothing per family, like the View tab — no per-move rows.
- `discardAll` (checkout) must also call `discardMetamodelDraft()` + `discardStagedNodeMoves()` — add there, not in the drawer (the drawer's Discard-all button already routes through it). Note `discardMetamodelDraft` lives in metamodel-editor which imports checkout — call it via a discard listener registered by the editor on the stage module (add `onMetamodelDiscardAll(cb)` / `notifyMetamodelDiscardAll()` to `metamodel-stage`, checkout calls the notify; the editor registers `discardMetamodelDraft`) to avoid the import cycle.

- [ ] **Step 4: Run** — `pixi run frontend-test` (full) and `pixi run frontend-check` → green. Manually sanity-check the flows the tests can't cover cheaply: open the metamodel tab, edit YAML → drawer shows the section; drag a node → count updates; commit → tab shows clean baseline.

- [ ] **Step 5: Commit** — `git commit -m "feat(frontend): metamodel edits stage into the commit drawer"`

---

### Task 13: Docs, spec amendment, full verification

**Files:**
- Modify: `CLAUDE.md`, `frontend/README.md`, `BACKLOG.md`, `docs/superpowers/specs/2026-08-16-metamodel-commit-flow-design.md`

- [ ] **Step 1: Spec amendment.** Append an "## Amendments (implementation)" section to the spec recording the two deviations (undo-across-rebind 409s; single `mm` backstop resource instead of `mmnode:` markers) with their rationale from this plan's Global Constraints.

- [ ] **Step 2: CLAUDE.md.** Rewrite the "Live metamodel editing" section: the swap pair is now `POST /metamodel/diff` + the `metamodel.*` op family through `POST /commits` (owner-only rebind batches, one per batch, full-sweep validation, strict-exempt, forced snapshot, quiet-peers guard, hard-verified `mm` lease); `POST /metamodel/rebind` and `PUT /metamodel/layout` are retired; layout is journalled per-node via `metamodel.move_node` (undo yes, revert no, hydration-skip yes — materialized head in `metamodel_layouts`); feed scope vocabulary gains `metamodel-layout`; the diagram's rename-key-deferral wrinkle paragraph is deleted (obsolete). Also update the artefacts-revamp bullet's `/model/ops` sentence to mention the metamodel family among the rejected ones.

- [ ] **Step 3: frontend/README.md.** Update its "Live metamodel editing" / state-model sections: the editor buffer + staged node moves are a fourth staged family (`metamodel-stage.svelte.ts`), committed through `commitStaged`; Rebind button gone; `mm` lease surrendered through commit; localStorage keys (`ui.metamodel.draft.*`, `ui.metamodel.layoutdraft.*`); the deferral machinery's documentation paragraphs deleted.

- [ ] **Step 4: BACKLOG.md.** Update the entries this feature resolves/reverses: "Hard-verify (token-required) rebind — honor-don't-require was chosen explicitly" (now reversed by spec 2026-08-16 for the commit path), the "no hasUnsavedWork() metamodel term" note (reversed), R-2's rebind-range revert blocker (still open — undo/revert across rebind remain 409, pointer to the amendment).

- [ ] **Step 5: Full verification.**

Run: `pixi run dr-tidy && pixi run dr-test`
Expected: format/lint/typecheck (ruff + mypy + pyright) clean; core pytest + frontend vitest green.

Run: `pixi run frontend-test-e2e`
Expected: green (it boots the backend itself; the retired routes must not be referenced by any e2e helper — grep `e2e/` for `metamodel/rebind` and `metamodel/layout` PUTs and update).

- [ ] **Step 6: Commit** — `git commit -m "docs: metamodel commit-flow spec amendments + CLAUDE/README/BACKLOG updates"`
