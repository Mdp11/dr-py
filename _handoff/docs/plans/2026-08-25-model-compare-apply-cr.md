# Model Compare / Replace / Create CR / Apply CR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Compare and Apply CR into one "server proposes an op batch, client stages it" pipeline: Compare gains Replace + Create CR (either direction), Apply CR takes an ordered list of CR files, and nothing is ever applied server-side — every edit lands in the client's staged buffer for review and commit.

**Architecture:** Two dry-run routes in `routes/change_request.py` (`POST /model/compare`, reworked `POST /model/apply-cr`) diff/apply transiently and return a `datarover.cr/v1` document plus a `ModelOp` batch whose create ops carry an `id` hint (new optional field honored by the applier through `Model.restore_*`). The client stages that batch through `state/stage-proposed.ts` (extracted from `snippet-stage.ts`) and one dialog (`ModelChangeDialog.svelte`, modes `compare`/`apply-cr`) with explicit **Preview diff** / **Create CR** / **Replace** / **Stage edits** buttons — no automatic preview.

**Tech Stack:** Python 3.14 / FastAPI / pydantic (backend, `pixi run -e core-dev pytest`), SvelteKit 5 runes + zod + vitest/happy-dom (frontend, `pixi run frontend-test`).

**Spec:** `docs/superpowers/specs/2026-08-25-model-compare-apply-cr-design.md`

## Global Constraints

- Every command goes through **pixi**: backend tests `pixi run -e core-dev pytest <path> -v`; a single vitest file `cd frontend && pixi run -e frontend npx vitest run <path>`; whole suites `pixi run core-test`, `pixi run frontend-test`, `pixi run frontend-check`; lint/format/typecheck `pixi run dr-tidy` (ruff + mypy + pyright must all pass).
- Comments/docstrings: concise, present tense, only for invariants and non-obvious contracts. No spec/plan references, no history narration.
- Python 3.14: use `X | Y` unions, `datetime.UTC`, `assert_never`.
- Backend API tests use the `client` fixture pattern from the file being edited + `AUTH_HEADERS`/`seed_default_project`/`papi` from `tests/api/conftest.py` (header identity provider is pinned there).
- `docs/` is gitignored in this repo — the spec and this plan are NOT committed; every other step commits.
- Frontend `ModelOp` create ops: `temp_id` stays mandatory and `tmp_`-prefixed; `id` is optional and only proposed batches set it.
- Never call `POST /model/validate` from any new path; staging → `POST /commits/preview` is the validation.

---

### Task 1: `id` hint on create ops (backend applier)

**Files:**
- Modify: `src/data_rover/api/schemas.py:321-350` (`CreateElementOp`, `CreateRelationshipOp`)
- Modify: `src/data_rover/api/routes/ops.py:212-260` and `:325-365` (`_apply_one` create branches)
- Test: `tests/api/test_ops_route.py` (append), `tests/api/test_commits_route.py` (append), `tests/api/test_hydration.py` (append)

**Interfaces:**
- Produces: `CreateElementOp.id: str | None = None`, `CreateRelationshipOp.id: str | None = None`. Applier semantics: `id is None` → minted id; `id` set → `Model.restore_element/restore_relationship(id, …)`, `ValueError` "already in use" → 422 + rollback; `tmp_`-prefixed hint → 422; canonical journalled op has `temp_id=<final id>` and `id=None`; restore mode ignores `id`.

- [ ] **Step 1: Write the failing tests (ops route)**

Append to `tests/api/test_ops_route.py` (the file already defines `seeded`, `_post_ops`, `_undo`, `_model`, `_rev`, `_snapshot`):

```python
# ---------------------------------------------------------------------------
# id hint on create ops (CR / compare proposals carry the file's real ids)
# ---------------------------------------------------------------------------


def _hinted_create(temp_id: str, hint: str, name: str) -> dict:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "id": hint,
        "type_name": "Item",
        "properties": {"name": name},
    }


def test_create_element_id_hint_lands_with_that_id(seeded: TestClient) -> None:
    res = _post_ops(seeded, [_hinted_create("tmp_x", "fixed-1", "X")])
    assert res.status_code == 200, res.text
    assert res.json()["id_map"] == {"tmp_x": "fixed-1"}
    assert res.json()["changed_elements"][0]["id"] == "fixed-1"
    assert _model().elements["fixed-1"].properties == {"name": "X"}


def test_create_relationship_id_hint_lands_with_that_id(seeded: TestClient) -> None:
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "id": "fixed-r",
                "type_name": "Links",
                "source_id": "b",
                "target_id": "c",
                "properties": {"weight": 5},
            }
        ],
    )
    assert res.status_code == 200, res.text
    assert res.json()["id_map"] == {"tmp_r": "fixed-r"}
    rel = _model().relationships["fixed-r"]
    assert (rel.source_id, rel.target_id, rel.properties) == ("b", "c", {"weight": 5})


def test_same_batch_ops_resolve_through_hinted_id(seeded: TestClient) -> None:
    """A later op may reference the create by temp id; id_map maps it to the hint."""
    res = _post_ops(
        seeded,
        [
            _hinted_create("tmp_x", "fixed-1", "X"),
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Links",
                "source_id": "tmp_x",
                "target_id": "c",
                "properties": {},
            },
        ],
    )
    assert res.status_code == 200, res.text
    rid = res.json()["id_map"]["tmp_r"]
    assert _model().relationships[rid].source_id == "fixed-1"


def test_create_id_hint_taken_422_rolls_back_whole_batch(seeded: TestClient) -> None:
    before = _snapshot(_model())
    rev = _rev()
    res = _post_ops(
        seeded,
        [_hinted_create("tmp_1", "zzz", "Z"), _hinted_create("tmp_2", "a", "Dup")],
    )
    assert res.status_code == 422, res.text
    assert "already in use" in res.json()["detail"]
    assert _snapshot(_model()) == before  # the first create was rolled back too
    assert "zzz" not in _model().elements
    assert _rev() == rev


def test_create_id_hint_reserved_prefix_422(seeded: TestClient) -> None:
    res = _post_ops(seeded, [_hinted_create("tmp_1", "tmp_zz", "Z")])
    assert res.status_code == 422, res.text
    assert "reserved" in res.json()["detail"]


def test_undo_removes_id_hinted_create(seeded: TestClient) -> None:
    assert _post_ops(seeded, [_hinted_create("tmp_x", "fixed-1", "X")]).status_code == 200
    assert _undo().status_code == 200
    assert "fixed-1" not in _model().elements


def test_id_hint_journals_canonical_temp_id_without_hint(seeded: TestClient) -> None:
    """The journal keeps only the canonical temp_id (= final id): hydration
    replay and undo never see the hint."""
    from data_rover.api import content
    from data_rover.api.db import db_session

    base = _rev()
    assert _post_ops(seeded, [_hinted_create("tmp_x", "fixed-1", "X")]).status_code == 200
    with db_session() as s:
        rows = content.commits_after(s, "default", base)
    assert len(rows) == 1
    op = rows[0].ops[0]
    assert op["temp_id"] == "fixed-1"
    assert op.get("id") is None
```

Append to `tests/api/test_commits_route.py` (uses its `client`, `_rev`, `_etype`):

```python
def test_commit_honors_create_id_hint(client: TestClient) -> None:
    """A create needs no lease, so an id-hinted create commits with no tokens."""
    r = client.post(
        papi("/commits"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_x",
                    "id": "node-7",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
            "message": "hinted",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["id_map"] == {"tmp_x": "node-7"}
    assert r.json()["changed_elements"][0]["id"] == "node-7"
```

Append to `tests/api/test_hydration.py` (uses `_seed_baseline`, `_first_concrete_element_type`):

```python
def test_hydrate_replay_ignores_id_hint_in_restore_mode() -> None:
    """Canonical journal ops carry the final id as temp_id; a stray `id` key
    is ignored by restore-mode replay."""
    sess = _seed_baseline()
    create = {
        "kind": "create_element",
        "temp_id": "e1",
        "id": "ignored",
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
    assert h.model is not None
    assert "e1" in h.model.elements and "ignored" not in h.model.elements
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_ops_route.py -k "id_hint or hinted" tests/api/test_commits_route.py::test_commit_honors_create_id_hint tests/api/test_hydration.py::test_hydrate_replay_ignores_id_hint_in_restore_mode -v`
Expected: FAIL — the ops-route tests get 200 with a minted id (`id_map != {"tmp_x": "fixed-1"}`) because pydantic ignores the unknown `id` field; the hydration test passes already (restore mode) — that is fine, it pins the invariant.

- [ ] **Step 3: Add the schema field**

In `src/data_rover/api/schemas.py`, change the two create ops:

```python
class CreateElementOp(BaseModel):
    kind: Literal["create_element"]
    temp_id: str
    type_name: str
    properties: dict[str, Any] = Field(default_factory=dict)
    #: requested final id (CR / compare proposals carry the file's real ids);
    #: None = server-minted. The applier reinstates the entity under it via
    #: Model.restore_element and 422s the batch when it is taken. Canonical
    #: journalled ops never carry it (temp_id holds the final id there).
    id: str | None = None
```

```python
class CreateRelationshipOp(BaseModel):
    kind: Literal["create_relationship"]
    temp_id: str
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any] = Field(default_factory=dict)
    #: see CreateElementOp.id
    id: str | None = None
```

- [ ] **Step 4: Honor the hint in the applier**

In `src/data_rover/api/routes/ops.py`, add above `_apply_one`:

```python
def _reject_reserved_hint(hint: str) -> None:
    """An id hint must never look like a temp id: the restore-mode replay
    branches on the prefix, so a journalled ``tmp_`` id would be ambiguous."""
    if hint.startswith(TEMP_ID_PREFIX):
        raise ValueError(
            f"id hint {hint!r} must not use the reserved {TEMP_ID_PREFIX!r} prefix"
        )
```

Replace the element create branch head (the `if op.temp_id.startswith(TEMP_ID_PREFIX):` block inside `if isinstance(op, CreateElementOp):`) with:

```python
        if op.temp_id.startswith(TEMP_ID_PREFIX):
            if op.id is None:
                element = d.create_element(model, op.type_name)
            else:
                # restore_element raises ValueError when the id is taken;
                # _apply_batch maps it to the 422 + rollback every other
                # mutation-boundary error gets
                _reject_reserved_hint(op.id)
                element = model.restore_element(op.id, op.type_name)
                d.after_element_create(model, element.id)
            res.id_map[op.temp_id] = element.id
        elif restore:
```

and change its canonical-op line to strip the hint:

```python
        res.canonical_ops.append(
            op.model_copy(
                update={"temp_id": element.id, "properties": props, "id": None}
            )
        )
```

Replace the relationship create branch head (inside `if isinstance(op, CreateRelationshipOp):`) with:

```python
        if op.temp_id.startswith(TEMP_ID_PREFIX):
            if op.id is None:
                rel = d.connect(model, op.type_name, source_id, target_id)
            else:
                _reject_reserved_hint(op.id)
                d.before_connect(model, op.type_name, source_id, target_id)
                rel = model.restore_relationship(
                    op.id, op.type_name, source_id, target_id
                )
                d.after_connect(model, rel.id)
            res.id_map[op.temp_id] = rel.id
        elif restore:
```

and its canonical-op update dict gains `"id": None`:

```python
        res.canonical_ops.append(
            op.model_copy(
                update={
                    "temp_id": rel.id,
                    "source_id": source_id,
                    "target_id": target_id,
                    "properties": props,
                    "id": None,
                }
            )
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_ops_route.py tests/api/test_commits_route.py tests/api/test_hydration.py tests/api/test_ops_persistence.py tests/api/test_commit_diff.py -v`
Expected: all PASS.

- [ ] **Step 6: Mirror the field in the frontend op type**

In `frontend/src/lib/state/ops.ts`, extend the two create members of `ElementOp`/`RelationshipOp`:

```ts
	| {
			kind: 'create_element';
			temp_id: string;
			type_name: string;
			properties: Record<string, unknown>;
			/** Requested final id — only proposed batches (CR / compare) set it; the
			 * server reinstates the entity under it or 422s the batch if taken.
			 * `temp_id` stays the batch-internal handle. Manual edits never set it. */
			id?: string;
	  }
```

```ts
	| {
			kind: 'create_relationship';
			temp_id: string;
			type_name: string;
			source_id: string;
			target_id: string;
			properties: Record<string, unknown>;
			/** See `create_element.id`. */
			id?: string;
	  }
```

Run: `pixi run frontend-check` — Expected: 0 errors (the field is optional; no consumer narrows on it).

- [ ] **Step 7: Lint and commit**

Run: `pixi run dr-tidy` — Expected: clean.

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/ops.py frontend/src/lib/state/ops.ts tests/api/test_ops_route.py tests/api/test_commits_route.py tests/api/test_hydration.py
git commit -m "feat(ops): optional id hint on create ops, honored via restore_*"
```

---

### Task 2: Core `diff_models` + `invert_change_request`

**Files:**
- Modify: `src/data_rover/core/model/change_request.py` (append)
- Test: `tests/model/test_change_request_diff.py` (create)

**Interfaces:**
- Produces: `diff_models(base: Model, other: Model) -> ChangeRequest` (direction base → other; `rev` ignored; added/modified in `other` insertion order, deleted in `base` order; a relationship whose endpoints or type changed is *modified*). `invert_change_request(cr: ChangeRequest) -> ChangeRequest` (added↔deleted, before↔after). Both return fresh copies — never alias the input entities.

- [ ] **Step 1: Write the failing tests**

Create `tests/model/test_change_request_diff.py`:

```python
from __future__ import annotations

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.change_request import (
    apply_change_request,
    diff_models,
    invert_change_request,
)
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="note", datatype="string"),
                ],
            ),
            ElementType(name="Other"),
        ],
        relationships=[
            RelationshipType(name="Link", source="Block", target="Block"),
            RelationshipType(name="Other", source="Block", target="Block"),
        ],
    )


def _model(elements: list[Element], relationships: list[Relationship]) -> Model:
    m = Model(_mm())
    for e in elements:
        m.elements[e.id] = e
    for r in relationships:
        m.relationships[r.id] = r
    m.indexes.rebuild()
    return m


def _el(eid: str, name: str, rev: int = 0, type_name: str = "Block", **props) -> Element:
    return Element(id=eid, type_name=type_name, properties={"name": name, **props}, rev=rev)


def _rel(rid: str, src: str, tgt: str, type_name: str = "Link", **props) -> Relationship:
    return Relationship(
        id=rid, type_name=type_name, source_id=src, target_id=tgt, properties=dict(props)
    )


def test_diff_models_partitions_added_modified_deleted_in_order() -> None:
    base = _model([_el("a", "A"), _el("b", "B"), _el("c", "C")], [_rel("r1", "a", "b")])
    other = _model(
        [_el("c", "C2"), _el("a", "A"), _el("d", "D")],
        [_rel("r2", "a", "c")],
    )
    cr = diff_models(base, other)
    assert [e.id for e in cr.elements_added] == ["d"]
    assert [(m.id, m.before.properties["name"], m.after.properties["name"]) for m in cr.elements_modified] == [
        ("c", "C", "C2")
    ]
    assert [e.id for e in cr.elements_deleted] == ["b"]
    assert [r.id for r in cr.relationships_added] == ["r2"]
    assert [r.id for r in cr.relationships_deleted] == ["r1"]


def test_diff_models_ignores_rev() -> None:
    base = _model([_el("a", "A", rev=1)], [])
    other = _model([_el("a", "A", rev=7)], [])
    cr = diff_models(base, other)
    assert cr.elements_modified == [] and cr.elements_added == [] and cr.elements_deleted == []


def test_diff_models_endpoint_or_type_change_is_modified() -> None:
    base = _model([_el("a", "A"), _el("b", "B"), _el("c", "C")], [_rel("r1", "a", "b")])
    other = _model(
        [_el("a", "A"), _el("b", "B"), _el("c", "C")], [_rel("r1", "a", "c", type_name="Other")]
    )
    cr = diff_models(base, other)
    assert len(cr.relationships_modified) == 1
    m = cr.relationships_modified[0]
    assert (m.before.target_id, m.after.target_id) == ("b", "c")
    assert (m.before.type_name, m.after.type_name) == ("Link", "Other")


def test_diff_models_retype_is_modified() -> None:
    base = _model([_el("a", "A")], [])
    other = _model([_el("a", "A", type_name="Other")], [])
    cr = diff_models(base, other)
    assert [(m.before.type_name, m.after.type_name) for m in cr.elements_modified] == [
        ("Block", "Other")
    ]


def test_diff_models_copies_entities() -> None:
    base = _model([], [])
    other = _model([_el("a", "A")], [])
    cr = diff_models(base, other)
    cr.elements_added[0].properties["name"] = "mutated"
    assert other.elements["a"].properties["name"] == "A"


def test_apply_then_invert_round_trips() -> None:
    base = _model([_el("a", "A"), _el("b", "B"), _el("c", "C")], [_rel("r1", "a", "b")])
    other = _model(
        [_el("c", "C2", note="n"), _el("a", "A"), _el("d", "D")],
        [_rel("r2", "a", "c"), _rel("r1", "a", "c")],
    )
    cr = diff_models(base, other)
    forward = apply_change_request(base, cr)
    assert diff_models(forward, other).elements_added == []
    assert diff_models(forward, other).relationships_modified == []
    back = apply_change_request(forward, invert_change_request(cr))
    empty = diff_models(back, base)
    assert (
        empty.elements_added,
        empty.elements_modified,
        empty.elements_deleted,
        empty.relationships_added,
        empty.relationships_modified,
        empty.relationships_deleted,
    ) == ([], [], [], [], [], [])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/model/test_change_request_diff.py -v`
Expected: FAIL with `ImportError: cannot import name 'diff_models'`.

- [ ] **Step 3: Implement**

Append to `src/data_rover/core/model/change_request.py`:

```python
# ---------------------------------------------------------------------------
# diff_models / invert_change_request — pure; never alias input entities
# ---------------------------------------------------------------------------


def _copy_element(e: Element) -> Element:
    return Element(id=e.id, type_name=e.type_name, properties=dict(e.properties), rev=e.rev)


def _copy_relationship(r: Relationship) -> Relationship:
    return Relationship(
        id=r.id,
        type_name=r.type_name,
        source_id=r.source_id,
        target_id=r.target_id,
        properties=dict(r.properties),
        rev=r.rev,
    )


def diff_models(base: Model, other: Model) -> ChangeRequest:
    """The change request that turns *base* into *other*.

    Same identity rules as the match helpers above (``rev`` ignored): an
    entity present only in *other* is added, only in *base* deleted, in
    both but not matching modified. Added/modified follow *other*'s
    insertion order, deleted follow *base*'s.
    """
    cr = ChangeRequest()
    for eid, e in other.elements.items():
        b = base.elements.get(eid)
        if b is None:
            cr.elements_added.append(_copy_element(e))
        elif not _element_matches(b, e):
            cr.elements_modified.append(
                ModifiedElement(id=eid, before=_copy_element(b), after=_copy_element(e))
            )
    for eid, b in base.elements.items():
        if eid not in other.elements:
            cr.elements_deleted.append(_copy_element(b))

    for rid, r in other.relationships.items():
        br = base.relationships.get(rid)
        if br is None:
            cr.relationships_added.append(_copy_relationship(r))
        elif not _relationship_matches(br, r):
            cr.relationships_modified.append(
                ModifiedRelationship(
                    id=rid, before=_copy_relationship(br), after=_copy_relationship(r)
                )
            )
    for rid, br in base.relationships.items():
        if rid not in other.relationships:
            cr.relationships_deleted.append(_copy_relationship(br))
    return cr


def invert_change_request(cr: ChangeRequest) -> ChangeRequest:
    """The change request that undoes *cr*: added↔deleted, before↔after."""
    return ChangeRequest(
        elements_added=[_copy_element(e) for e in cr.elements_deleted],
        elements_modified=[
            ModifiedElement(
                id=m.id, before=_copy_element(m.after), after=_copy_element(m.before)
            )
            for m in cr.elements_modified
        ],
        elements_deleted=[_copy_element(e) for e in cr.elements_added],
        relationships_added=[_copy_relationship(r) for r in cr.relationships_deleted],
        relationships_modified=[
            ModifiedRelationship(
                id=m.id,
                before=_copy_relationship(m.after),
                after=_copy_relationship(m.before),
            )
            for m in cr.relationships_modified
        ],
        relationships_deleted=[_copy_relationship(r) for r in cr.relationships_added],
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/model/test_change_request_diff.py tests/model/test_apply_change_request.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

Run: `pixi run dr-tidy` — Expected: clean.

```bash
git add src/data_rover/core/model/change_request.py tests/model/test_change_request_diff.py
git commit -m "feat(core): diff_models and invert_change_request"
```

---

### Task 3: CR → ops translation (`api/change_request_ops.py`)

**Files:**
- Create: `src/data_rover/api/change_request_ops.py`
- Test: `tests/api/test_change_request_ops.py` (create)

**Interfaces:**
- Consumes: `ChangeRequest`, `ModifiedElement`, `ModifiedRelationship` (core); op schemas from `schemas.py`; `TEMP_ID_PREFIX` from `routes/ops.py`.
- Produces: `ops_for_change(cr: ChangeRequest) -> list[ModelOpIn]` and `class UnsupportedChangeError(ValueError)`. Phase order: element creates → relationship creates → element updates → relationship updates → relationship deletes → rewires (delete + create with same id) → element deletes. Creates carry `temp_id="tmp_<n>"` (1-based batch counter) and `id=<real id>`; relationship endpoints that name an element added in the same CR use that element's temp id. Element type change raises `UnsupportedChangeError`.
- Note: the spec wrote this as `(base, final, cr)`; the CR carries every before/after needed, so the signature takes only `cr`.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_change_request_ops.py`:

```python
from __future__ import annotations

import pytest

from data_rover.api.change_request_ops import UnsupportedChangeError, ops_for_change
from data_rover.core.model.change_request import (
    ChangeRequest,
    ModifiedElement,
    ModifiedRelationship,
)
from data_rover.core.model.element import Element
from data_rover.core.model.relationship import Relationship


def _el(eid: str, type_name: str = "Item", **props) -> Element:
    return Element(id=eid, type_name=type_name, properties=dict(props))


def _rel(rid: str, src: str, tgt: str, type_name: str = "Links", **props) -> Relationship:
    return Relationship(
        id=rid, type_name=type_name, source_id=src, target_id=tgt, properties=dict(props)
    )


def _dump(ops) -> list[dict]:
    return [op.model_dump() for op in ops]


def test_creates_carry_id_hint_and_batch_temp_ids() -> None:
    cr = ChangeRequest(
        elements_added=[_el("n1", name="N1"), _el("n2", name="N2")],
        relationships_added=[_rel("r1", "n1", "n2", weight=3)],
    )
    ops = _dump(ops_for_change(cr))
    assert ops == [
        {
            "kind": "create_element",
            "temp_id": "tmp_1",
            "id": "n1",
            "type_name": "Item",
            "properties": {"name": "N1"},
        },
        {
            "kind": "create_element",
            "temp_id": "tmp_2",
            "id": "n2",
            "type_name": "Item",
            "properties": {"name": "N2"},
        },
        {
            "kind": "create_relationship",
            "temp_id": "tmp_3",
            "id": "r1",
            "type_name": "Links",
            # endpoints on same-CR additions reference the TEMP id, so the
            # client stages them lock-free and id_map resolves them
            "source_id": "tmp_1",
            "target_id": "tmp_2",
            "properties": {"weight": 3},
        },
    ]


def test_relationship_to_existing_element_keeps_real_endpoint() -> None:
    cr = ChangeRequest(relationships_added=[_rel("r1", "a", "b")])
    [op] = _dump(ops_for_change(cr))
    assert (op["source_id"], op["target_id"]) == ("a", "b")


def test_modified_becomes_merge_patch_with_null_for_removed_keys() -> None:
    cr = ChangeRequest(
        elements_modified=[
            ModifiedElement(
                id="a",
                before=_el("a", name="A", note="old", keep="k"),
                after=_el("a", name="A2", keep="k"),
            )
        ],
        relationships_modified=[
            ModifiedRelationship(
                id="r1", before=_rel("r1", "a", "b", weight=1), after=_rel("r1", "a", "b", weight=2)
            )
        ],
    )
    assert _dump(ops_for_change(cr)) == [
        {"kind": "update_element", "id": "a", "properties_patch": {"name": "A2", "note": None}},
        {"kind": "update_relationship", "id": "r1", "properties_patch": {"weight": 2}},
    ]


def test_unchanged_properties_emit_no_update() -> None:
    cr = ChangeRequest(
        elements_modified=[
            ModifiedElement(id="a", before=_el("a", name="A"), after=_el("a", name="A"))
        ]
    )
    assert ops_for_change(cr) == []


def test_phase_order_deletes_relationships_before_elements() -> None:
    cr = ChangeRequest(
        elements_added=[_el("n1", name="N")],
        elements_modified=[
            ModifiedElement(id="a", before=_el("a", name="A"), after=_el("a", name="A2"))
        ],
        elements_deleted=[_el("p", name="P"), _el("ch", name="CH")],
        relationships_added=[_rel("r-new", "n1", "a")],
        relationships_deleted=[_rel("r-pch", "p", "ch", type_name="Contains")],
    )
    kinds = [(op.kind, getattr(op, "id", None)) for op in ops_for_change(cr)]
    assert kinds == [
        ("create_element", "n1"),
        ("create_relationship", "r-new"),
        ("update_element", "a"),
        ("delete_relationship", "r-pch"),
        ("delete_element", "p"),
        ("delete_element", "ch"),
    ]


def test_rewire_is_delete_then_create_with_same_id() -> None:
    cr = ChangeRequest(
        elements_added=[_el("n1", name="N")],
        relationships_modified=[
            ModifiedRelationship(
                id="r1", before=_rel("r1", "a", "b", weight=1), after=_rel("r1", "a", "n1", weight=1)
            )
        ],
        relationships_deleted=[_rel("r9", "a", "b")],
    )
    ops = _dump(ops_for_change(cr))
    assert [op["kind"] for op in ops] == [
        "create_element",
        "delete_relationship",  # plain deletes first...
        "delete_relationship",  # ...then the rewire pair
        "create_relationship",
    ]
    assert ops[1]["id"] == "r9"
    assert ops[2]["id"] == "r1"
    assert ops[3]["id"] == "r1" and ops[3]["temp_id"] == "tmp_2"
    assert ops[3]["target_id"] == "tmp_1"


def test_relationship_type_change_is_a_rewire() -> None:
    cr = ChangeRequest(
        relationships_modified=[
            ModifiedRelationship(
                id="r1", before=_rel("r1", "a", "b"), after=_rel("r1", "a", "b", type_name="Other")
            )
        ]
    )
    assert [op.kind for op in ops_for_change(cr)] == ["delete_relationship", "create_relationship"]


def test_element_type_change_is_unsupported() -> None:
    cr = ChangeRequest(
        elements_modified=[
            ModifiedElement(id="a", before=_el("a", "Item", name="A"), after=_el("a", "Other", name="A"))
        ]
    )
    with pytest.raises(UnsupportedChangeError, match="'a'"):
        ops_for_change(cr)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_change_request_ops.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'data_rover.api.change_request_ops'`.

- [ ] **Step 3: Implement**

Create `src/data_rover/api/change_request_ops.py`:

```python
"""Change request -> op batch translation (the propose half of apply-cr).

A CR describes entity states; the op protocol describes mutations. The
phase order below is what keeps the two equivalent under the applier's
own semantics:

1. element creates      — full properties inline, ``id`` hint = the CR's id
2. relationship creates — endpoints on same-CR additions use the TEMP id
3. element updates      — merge patch before -> after (None deletes a key)
4. relationship updates — property-only changes
5. relationship deletes, then REWIRES (endpoint or type change, which
   ``update_relationship`` cannot express) as delete + create with the
   same id
6. element deletes      — every incident relationship is already gone (the
   route's CR gate guarantees the CR deleted them), so ``delete_element``'s
   containment cascade never removes anything the CR did not name

An element whose type changes has no op (no retype op exists, and
delete + create would cascade through its containment children), so it is
refused as :class:`UnsupportedChangeError`.
"""

from __future__ import annotations

from typing import Any

from data_rover.core.model.change_request import ChangeRequest
from data_rover.core.model.element import Element
from data_rover.core.model.relationship import Relationship

from .routes.ops import TEMP_ID_PREFIX
from .schemas import (
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ModelOpIn,
    UpdateElementOp,
    UpdateRelationshipOp,
)


class UnsupportedChangeError(ValueError):
    """The CR needs a mutation the op protocol cannot express."""


def merge_patch(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """JSON merge patch turning *before* into *after* (None deletes a key)."""
    patch: dict[str, Any] = {
        k: v for k, v in after.items() if k not in before or before[k] != v
    }
    for k in before:
        if k not in after:
            patch[k] = None
    return patch


def _is_rewire(before: Relationship, after: Relationship) -> bool:
    return (
        before.source_id != after.source_id
        or before.target_id != after.target_id
        or before.type_name != after.type_name
    )


def ops_for_change(cr: ChangeRequest) -> list[ModelOpIn]:
    """Translate *cr* into an op batch in the phase order documented above."""
    for m in cr.elements_modified:
        if m.before.type_name != m.after.type_name:
            raise UnsupportedChangeError(
                f"Element {m.id!r} changes type "
                f"({m.before.type_name!r} -> {m.after.type_name!r}); element type "
                f"changes are not supported — delete and re-create it in the CR"
            )

    ops: list[ModelOpIn] = []
    temp_of: dict[str, str] = {}
    counter = 0

    def next_temp(real_id: str) -> str:
        nonlocal counter
        counter += 1
        temp_of[real_id] = f"{TEMP_ID_PREFIX}{counter}"
        return temp_of[real_id]

    def ref(entity_id: str) -> str:
        return temp_of.get(entity_id, entity_id)

    def create_rel(r: Relationship) -> CreateRelationshipOp:
        return CreateRelationshipOp(
            kind="create_relationship",
            temp_id=next_temp(r.id),
            id=r.id,
            type_name=r.type_name,
            source_id=ref(r.source_id),
            target_id=ref(r.target_id),
            properties=dict(r.properties),
        )

    def create_el(e: Element) -> CreateElementOp:
        return CreateElementOp(
            kind="create_element",
            temp_id=next_temp(e.id),
            id=e.id,
            type_name=e.type_name,
            properties=dict(e.properties),
        )

    ops.extend(create_el(e) for e in cr.elements_added)
    ops.extend(create_rel(r) for r in cr.relationships_added)

    for m in cr.elements_modified:
        patch = merge_patch(m.before.properties, m.after.properties)
        if patch:
            ops.append(UpdateElementOp(kind="update_element", id=m.id, properties_patch=patch))

    rewires = [m for m in cr.relationships_modified if _is_rewire(m.before, m.after)]
    for m in cr.relationships_modified:
        if _is_rewire(m.before, m.after):
            continue
        patch = merge_patch(m.before.properties, m.after.properties)
        if patch:
            ops.append(
                UpdateRelationshipOp(
                    kind="update_relationship", id=m.id, properties_patch=patch
                )
            )

    ops.extend(
        DeleteRelationshipOp(kind="delete_relationship", id=r.id)
        for r in cr.relationships_deleted
    )
    for m in rewires:
        ops.append(DeleteRelationshipOp(kind="delete_relationship", id=m.id))
        ops.append(create_rel(m.after))

    ops.extend(DeleteElementOp(kind="delete_element", id=e.id) for e in cr.elements_deleted)
    return ops
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_change_request_ops.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

Run: `pixi run dr-tidy` — Expected: clean (if pyright flags the circular-looking `.routes.ops` import, it is the same import `routes/_snapshot.py` already makes; keep it).

```bash
git add src/data_rover/api/change_request_ops.py tests/api/test_change_request_ops.py
git commit -m "feat(api): translate a change request into a phase-ordered op batch"
```

---

### Task 4: `POST /model/apply-cr` becomes a dry-run proposal

**Files:**
- Modify: `src/data_rover/api/schemas.py` (replace `ApplyCrRequest`/`ApplyCrResponse`)
- Modify: `src/data_rover/api/routes/change_request.py` (rewrite; keep `_require_endpoint`, `_gate_cr_result`)
- Modify: `src/data_rover/api/authz.py:38-40` (comment)
- Modify: `src/data_rover/api/routes/read.py:613-623` (`get_changes` docstring)
- Test: `tests/api/test_apply_cr_route.py` (rewrite), `tests/api/test_read_routes.py:789-843`, `tests/api/test_rules_callsites.py` (drop one test)

**Interfaces:**
- Consumes: `apply_change_request`, `CRConflictError`, `diff_models` (Task 2), `ops_for_change`/`UnsupportedChangeError` (Task 3).
- Produces: `ProposeCrRequest {crs: list[ChangeRequestIn]}` (min 1), `ProposeCrResponse {model_rev, cr: ChangesOut, ops: list[ModelOpIn]}`; 409 body `{cr_index, conflicts, model_rev}`; helper `_changes_out(base: Model, cr: ChangeRequest) -> ChangesOut` (reused by Task 5). Route stays a write for authz (viewer 403).

- [ ] **Step 1: Write the failing tests**

Replace the whole of `tests/api/test_apply_cr_route.py` with:

```python
"""POST /api/v1/projects/{id}/model/apply-cr — dry-run proposal of an ordered
CR list against the session model (never applied server-side)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import tenancy
from data_rover.api.db import db_session
from data_rover.api.db_models import Role
from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Item
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
      - {name: note, datatype: string}
  - name: Other
    properties:
      - {name: name, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Item
    target: Item
  - name: Links
    containment: false
    source: Item
    target: Item
    properties:
      - {name: weight, datatype: integer}
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200, res.text
    return c


@pytest.fixture
def seeded(client: TestClient) -> TestClient:
    """a Contains b via r-ab."""
    res = client.post(
        f"{API}/model",
        json={
            "elements": [_el("a", "A"), _el("b", "B")],
            "relationships": [_rel("r-ab", "Contains", "a", "b")],
        },
    )
    assert res.status_code == 200, res.text
    return client


@pytest.fixture
def viewer_headers(client: TestClient) -> dict[str, str]:
    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1", role=Role.viewer)
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


def _el(eid: str, name: str, type_name: str = "Item", **props) -> dict:
    return {"id": eid, "type_name": type_name, "properties": {"name": name, **props}, "rev": 0}


def _rel(rid: str, type_name: str, src: str, tgt: str, **props) -> dict:
    return {
        "id": rid,
        "type_name": type_name,
        "source_id": src,
        "target_id": tgt,
        "properties": dict(props),
        "rev": 0,
    }


def _cr(
    *,
    e_added=(),
    e_modified=(),
    e_deleted=(),
    r_added=(),
    r_modified=(),
    r_deleted=(),
) -> dict:
    return {
        "format": "datarover.cr/v1",
        "createdAt": "2026-01-01T00:00:00Z",
        "baseline": {"filename": None, "elementCount": 0, "relationshipCount": 0},
        "ops": {
            "elements": {
                "added": list(e_added),
                "modified": list(e_modified),
                "deleted": list(e_deleted),
            },
            "relationships": {
                "added": list(r_added),
                "modified": list(r_modified),
                "deleted": list(r_deleted),
            },
        },
    }


def _mod(id: str, before: dict, after: dict) -> dict:
    return {"id": id, "before": before, "after": after}


def _propose(client: TestClient, crs: list[dict], **kw):
    return client.post(f"{API}/model/apply-cr", json={"crs": crs}, **kw)


def test_propose_returns_ops_and_combined_cr_without_touching_session(seeded: TestClient) -> None:
    rev = get_session().model_rev
    res = _propose(seeded, [_cr(e_added=[_el("n1", "N")])])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["model_rev"] == rev
    assert body["ops"] == [
        {
            "kind": "create_element",
            "temp_id": "tmp_1",
            "id": "n1",
            "type_name": "Item",
            "properties": {"name": "N"},
        }
    ]
    assert [e["id"] for e in body["cr"]["ops"]["elements"]["added"]] == ["n1"]
    assert body["cr"]["baseline"] == {"filename": None, "elementCount": 2, "relationshipCount": 1}
    assert get_session().model_rev == rev
    model = get_session().model
    assert model is not None and "n1" not in model.elements


def test_propose_applies_crs_sequentially(seeded: TestClient) -> None:
    """CR2 modifies what CR1 added: one create op with the FINAL state."""
    cr1 = _cr(e_added=[_el("n1", "N")])
    cr2 = _cr(e_modified=[_mod("n1", _el("n1", "N"), _el("n1", "N2", note="x"))])
    res = _propose(seeded, [cr1, cr2])
    assert res.status_code == 200, res.text
    body = res.json()
    assert [op["kind"] for op in body["ops"]] == ["create_element"]
    assert body["ops"][0]["properties"] == {"name": "N2", "note": "x"}
    assert body["cr"]["ops"]["elements"]["modified"] == []


def test_propose_conflict_reports_index_of_failing_cr(seeded: TestClient) -> None:
    rev = get_session().model_rev
    cr1 = _cr(e_added=[_el("n1", "N")])
    cr2 = _cr(e_modified=[_mod("zzz", _el("zzz", "Z"), _el("zzz", "Z2"))])
    res = _propose(seeded, [cr1, cr2])
    assert res.status_code == 409, res.text
    body = res.json()
    assert body["cr_index"] == 1
    assert body["model_rev"] == rev
    assert [(c["kind"], c["id"]) for c in body["conflicts"]] == [("missing", "zzz")]


def test_propose_before_mismatch_against_session_is_409_at_index_0(seeded: TestClient) -> None:
    res = _propose(seeded, [_cr(e_modified=[_mod("a", _el("a", "WRONG"), _el("a", "A2"))])])
    assert res.status_code == 409
    assert res.json()["cr_index"] == 0
    assert res.json()["conflicts"][0]["kind"] == "before_mismatch"


def test_propose_gate_unknown_type_422(seeded: TestClient) -> None:
    res = _propose(seeded, [_cr(e_added=[_el("n1", "N", type_name="Nope")])])
    assert res.status_code == 422, res.text
    assert "Nope" in res.json()["detail"]


def test_propose_gate_dangling_delete_422(seeded: TestClient) -> None:
    """Deleting b without deleting r-ab leaves a dangling relationship."""
    res = _propose(seeded, [_cr(e_deleted=[_el("b", "B")])])
    assert res.status_code == 422, res.text
    assert "r-ab" in res.json()["detail"]


def test_propose_retype_422(seeded: TestClient) -> None:
    res = _propose(seeded, [_cr(e_modified=[_mod("a", _el("a", "A"), _el("a", "A", type_name="Other"))])])
    assert res.status_code == 422, res.text
    assert "'a'" in res.json()["detail"] and "type" in res.json()["detail"]


def test_propose_orders_relationship_delete_before_element_delete(seeded: TestClient) -> None:
    res = _propose(
        seeded,
        [_cr(e_deleted=[_el("b", "B")], r_deleted=[_rel("r-ab", "Contains", "a", "b")])],
    )
    assert res.status_code == 200, res.text
    assert [(op["kind"], op["id"]) for op in res.json()["ops"]] == [
        ("delete_relationship", "r-ab"),
        ("delete_element", "b"),
    ]


def test_propose_modified_becomes_patch(seeded: TestClient) -> None:
    res = _propose(seeded, [_cr(e_modified=[_mod("a", _el("a", "A"), _el("a", "A2", note="n"))])])
    assert res.status_code == 200, res.text
    assert res.json()["ops"] == [
        {"kind": "update_element", "id": "a", "properties_patch": {"name": "A2", "note": "n"}}
    ]


def test_propose_empty_list_422(seeded: TestClient) -> None:
    assert _propose(seeded, []).status_code == 422


def test_propose_without_model_404(client: TestClient) -> None:
    assert _propose(client, [_cr()]).status_code == 404


def test_propose_viewer_403(seeded: TestClient, viewer_headers: dict[str, str]) -> None:
    res = seeded.post(f"{API}/model/apply-cr", json={"crs": [_cr()]}, headers=viewer_headers)
    assert res.status_code == 403, res.text
```

In `tests/api/test_read_routes.py`, replace the tail of `test_changes_round_trip_through_apply_cr` (from `current = client.get(...)` to the end of the function) with:

```python
    current = client.get(f"{API}/model").json()
    session = get_session()
    assert session.metamodel is not None
    base_model = _build_model_from_payload(
        session.metamodel,
        [ElementOut(**e) for e in base["elements"]],
        [RelationshipOut(**r) for r in base["relationships"]],
    )
    result = apply_change_request(base_model, ChangeRequestIn(**changes).to_core())
    assert _entity_state(ModelOut.from_core(result).model_dump()) == _entity_state(current)
```

and rename the test to `test_changes_round_trip_through_apply_change_request` with docstring `"""base + GET /model/changes applied as a CR == current model."""`. Add the imports next to the existing ones:

```python
from data_rover.api.routes._snapshot import _build_model_from_payload
from data_rover.api.schemas import ChangeRequestIn, ElementOut, ModelOut, RelationshipOut
from data_rover.core.model.change_request import apply_change_request
```

In `tests/api/test_rules_callsites.py`: delete `test_apply_cr_session_rule_liveness` (the whole function, lines ~292-320) and change the module docstring to `"""User rules on the validation call sites outside POST /commits: the legacy ops/undo protocol, POST /model/validate and the metamodel-diff sandbox."""`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_apply_cr_route.py tests/api/test_read_routes.py -k "propose or round_trip" -v`
Expected: apply-cr tests FAIL with 422 (pydantic rejects the `crs` body — `cr` missing); the round-trip test PASSES already (it no longer touches the route).

- [ ] **Step 3: Replace the request/response schemas**

In `src/data_rover/api/schemas.py`, replace `ApplyCrRequest` and `ApplyCrResponse` with:

```python
class ProposeCrRequest(BaseModel):
    #: applied in order; each CR sees the result of the previous one
    crs: list[ChangeRequestIn] = Field(min_length=1)


class ProposeCrResponse(BaseModel):
    """Dry-run result of POST /model/apply-cr: nothing was applied."""

    model_config = ConfigDict(protected_namespaces=())

    #: the session rev the proposal was computed against; the client refuses
    #: to stage the batch if it has moved
    model_rev: int
    #: the COMBINED base -> final change request (what the preview renders)
    cr: ChangesOut
    #: the op batch that lands ``cr`` when staged and committed
    ops: list[ModelOpIn] = Field(default_factory=list)
```

(`ChangesOut` is defined later in the file than the old `ApplyCrRequest` position; move the two new classes to sit right after `ChangesSummaryOut` so the forward reference resolves.)

- [ ] **Step 4: Rewrite the route module**

Replace `src/data_rover/api/routes/change_request.py` with (keeping `_require_endpoint` and `_gate_cr_result` byte-identical to today's):

```python
"""POST /model/apply-cr — propose an op batch from an ordered CR list.

A dry run: the CRs are applied sequentially and TRANSIENTLY to the session
model (``apply_change_request`` is pure, so each step is a fresh copy), the
combined base -> final change request is derived, gated, and translated into
an op batch (``api/change_request_ops.py``). Nothing is applied, journalled
or validated here — the client stages the batch and ``POST /commits/preview``
validates it like any manual edit.

The session model is read WITHOUT the write mutex (the ``/snippets/run``
precedent): the response carries the ``model_rev`` it saw, and the client
refuses to stage a proposal whose rev has moved.

409 ``{cr_index, conflicts, model_rev}`` names the FIRST CR that conflicts
with the model as left by its predecessors; 422 is the metamodel gate
(unknown/abstract type, dangling endpoint, non-cascaded delete) or an
element type change, which the op protocol cannot express.
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.change_request import (
    ChangeRequest,
    CRConflictError,
    apply_change_request,
    diff_models,
)
from data_rover.core.model.model import Model

from ..change_request_ops import UnsupportedChangeError, ops_for_change
from ..deps import Session, get_request_session, require_model
from ..schemas import (
    ChangesOut,
    CrBaseline,
    CrElementOps,
    CrOps,
    CrRelationshipOps,
    ElementOut,
    ModifiedElementOut,
    ModifiedRelationshipOut,
    ProposeCrRequest,
    ProposeCrResponse,
    RelationshipOut,
)
from .read import _now_iso

router = APIRouter()


# (keep the existing _require_endpoint and _gate_cr_result definitions here, byte-identical)


def _changes_out(base: Model, cr: ChangeRequest) -> ChangesOut:
    """Serialize a core CR as a ``datarover.cr/v1`` document whose baseline
    describes *base*. ``filename`` is null — the server never knows the file."""
    return ChangesOut(
        createdAt=_now_iso(),
        baseline=CrBaseline(
            filename=None,
            elementCount=len(base.elements),
            relationshipCount=len(base.relationships),
        ),
        ops=CrOps(
            elements=CrElementOps(
                added=[ElementOut.from_core(e) for e in cr.elements_added],
                modified=[
                    ModifiedElementOut(
                        id=m.id,
                        before=ElementOut.from_core(m.before),
                        after=ElementOut.from_core(m.after),
                    )
                    for m in cr.elements_modified
                ],
                deleted=[ElementOut.from_core(e) for e in cr.elements_deleted],
            ),
            relationships=CrRelationshipOps(
                added=[RelationshipOut.from_core(r) for r in cr.relationships_added],
                modified=[
                    ModifiedRelationshipOut(
                        id=m.id,
                        before=RelationshipOut.from_core(m.before),
                        after=RelationshipOut.from_core(m.after),
                    )
                    for m in cr.relationships_modified
                ],
                deleted=[RelationshipOut.from_core(r) for r in cr.relationships_deleted],
            ),
        ),
    )


@router.post("/model/apply-cr", response_model=None)
def propose_cr(
    payload: ProposeCrRequest,
    session: Session = Depends(get_request_session),
) -> ProposeCrResponse | JSONResponse:
    """See the module docstring."""
    metamodel, base = require_model(session)
    model_rev = session.model_rev

    current = base
    for index, cr_in in enumerate(payload.crs):
        try:
            current = apply_change_request(current, cr_in.to_core())
        except CRConflictError as exc:
            return JSONResponse(
                status_code=409,
                content={
                    "cr_index": index,
                    "conflicts": [asdict(c) for c in exc.conflicts],
                    "model_rev": model_rev,
                },
            )

    combined = diff_models(base, current)
    _gate_cr_result(metamodel, base, current, combined)
    try:
        ops = ops_for_change(combined)
    except UnsupportedChangeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return ProposeCrResponse(
        model_rev=model_rev, cr=_changes_out(base, combined), ops=ops
    )
```

Drop every import the old modes needed (`ValidationState`, `default_pipeline`, `Scope`, `change_request_dirty_ids`, `expand_ids`, `session_pipeline`, `_build_model_from_payload`, `_ensure_validation_seeded`, `InlineModel`, `IssueOut`, `ModelOut`, `OpsResponse`, `ApplyCr*`). Keep `Metamodel` — `_gate_cr_result` uses it.

In `src/data_rover/api/routes/ops.py`, the `_ensure_validation_seeded` docstring says "Shared by the ops endpoints and session-mode apply-cr (routes/change_request.py)": change to "Shared by the ops and commit endpoints."

- [ ] **Step 5: Update the authz comment and the changes docstring**

In `src/data_rover/api/authz.py`, replace the three `#: Also NOT included: ``POST /model/apply-cr``…` lines with:

```python
#: Also NOT included: ``POST /model/apply-cr`` — a dry run that never mutates,
#: but its only consumer is staging edits, which a viewer cannot do, so it
#: stays a write. ``POST /model/compare`` only reads (a viewer may compare and
#: save the resulting CR file), so it IS included.
```

In `src/data_rover/api/routes/read.py::get_changes`, replace the sentence "and round-trip applicable: POSTing the BASE model snapshot together with this document to /model/apply-cr reproduces the current session model entity-wise." with "and round-trip applicable: applied to the BASE model it reproduces the current session model entity-wise."

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_apply_cr_route.py tests/api/test_read_routes.py tests/api/test_rules_callsites.py tests/api/test_authz.py -v`
Expected: all PASS.

- [ ] **Step 7: Lint and commit**

Run: `pixi run dr-tidy` — Expected: clean (pyright will flag any leftover import).

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/change_request.py src/data_rover/api/routes/ops.py src/data_rover/api/routes/read.py src/data_rover/api/authz.py tests/api/test_apply_cr_route.py tests/api/test_read_routes.py tests/api/test_rules_callsites.py
git commit -m "feat(api): apply-cr proposes an op batch from an ordered CR list, never mutates"
```

---

### Task 5: `POST /model/compare`

**Files:**
- Modify: `src/data_rover/api/schemas.py` (add `CompareResponse` after `ProposeCrResponse`)
- Modify: `src/data_rover/api/routes/change_request.py` (add route)
- Modify: `src/data_rover/api/authz.py:59-79` (allowlist)
- Test: `tests/api/test_compare_route.py` (create)

**Interfaces:**
- Consumes: `build_model_from_dicts` (`routes/_snapshot.py`), `diff_models`, `_changes_out` (Task 4).
- Produces: `CompareResponse {model_rev, cr: ChangesOut, other_element_count, other_relationship_count}`; direction session → body; viewer-allowed.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_compare_route.py`:

```python
"""POST /api/v1/projects/{id}/model/compare — diff the session model against a
raw other-model body (session -> other). Read-only."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from data_rover.api import tenancy
from data_rover.api.db import db_session
from data_rover.api.db_models import Role
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Item
    target: Item
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200, res.text
    return c


@pytest.fixture
def seeded(client: TestClient) -> TestClient:
    res = client.post(
        f"{API}/model",
        json={
            "elements": [_el("a", "A"), _el("b", "B")],
            "relationships": [_rel("r-ab", "a", "b")],
        },
    )
    assert res.status_code == 200, res.text
    return client


@pytest.fixture
def viewer_headers(client: TestClient) -> dict[str, str]:
    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1", role=Role.viewer)
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


def _el(eid: str, name: str, type_name: str = "Item") -> dict:
    return {"id": eid, "type_name": type_name, "properties": {"name": name}}


def _rel(rid: str, src: str, tgt: str) -> dict:
    return {"id": rid, "type_name": "Contains", "source_id": src, "target_id": tgt}


def _compare(client: TestClient, other: dict, **kw):
    return client.post(f"{API}/model/compare", content=json.dumps(other).encode(), **kw)


def test_compare_is_session_to_other(seeded: TestClient) -> None:
    other = {"elements": [_el("a", "A2"), _el("c", "C")], "relationships": []}
    res = _compare(seeded, other)
    assert res.status_code == 200, res.text
    body = res.json()
    ops = body["cr"]["ops"]
    assert [e["id"] for e in ops["elements"]["added"]] == ["c"]
    assert [(m["id"], m["before"]["properties"], m["after"]["properties"]) for m in ops["elements"]["modified"]] == [
        ("a", {"name": "A"}, {"name": "A2"})
    ]
    assert [e["id"] for e in ops["elements"]["deleted"]] == ["b"]
    assert [r["id"] for r in ops["relationships"]["deleted"]] == ["r-ab"]
    assert body["cr"]["baseline"] == {"filename": None, "elementCount": 2, "relationshipCount": 1}
    assert (body["other_element_count"], body["other_relationship_count"]) == (2, 0)
    assert body["model_rev"] == seeded.get(f"{API}/model/summary").json()["model_rev"]


def test_compare_identical_is_empty(seeded: TestClient) -> None:
    other = seeded.get(f"{API}/model").json()
    body = _compare(seeded, other).json()
    assert body["cr"]["ops"]["elements"] == {"added": [], "modified": [], "deleted": []}


def test_compare_tolerates_unknown_types(seeded: TestClient) -> None:
    other = {"elements": [_el("a", "A"), _el("b", "B"), _el("g", "G", type_name="Ghost")], "relationships": [_rel("r-ab", "a", "b")]}
    res = _compare(seeded, other)
    assert res.status_code == 200, res.text
    assert [e["id"] for e in res.json()["cr"]["ops"]["elements"]["added"]] == ["g"]


def test_compare_rejects_invalid_json_422(seeded: TestClient) -> None:
    res = seeded.post(f"{API}/model/compare", content=b"{not json")
    assert res.status_code == 422
    assert "not valid JSON" in res.json()["detail"]


def test_compare_rejects_dangling_endpoint_422(seeded: TestClient) -> None:
    other = {"elements": [_el("a", "A")], "relationships": [_rel("r-ax", "a", "x")]}
    assert _compare(seeded, other).status_code == 422


def test_compare_without_model_404(client: TestClient) -> None:
    assert _compare(client, {"elements": [], "relationships": []}).status_code == 404


def test_compare_viewer_allowed(seeded: TestClient, viewer_headers: dict[str, str]) -> None:
    res = _compare(seeded, {"elements": [], "relationships": []}, headers=viewer_headers)
    assert res.status_code == 200, res.text
    assert [e["id"] for e in res.json()["cr"]["ops"]["elements"]["deleted"]] == ["a", "b"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_compare_route.py -v`
Expected: FAIL with 404 (route not mounted) / 405.

- [ ] **Step 3: Implement**

In `src/data_rover/api/schemas.py`, after `ProposeCrResponse`:

```python
class CompareResponse(BaseModel):
    """POST /model/compare: the session -> other-model change request."""

    model_config = ConfigDict(protected_namespaces=())

    model_rev: int
    cr: ChangesOut
    #: entity counts of the OTHER model (the "to" side) so the client can
    #: report how many unchanged entities the diff hides
    other_element_count: int
    other_relationship_count: int
```

In `src/data_rover/api/routes/change_request.py`, add `import json`, `Request` to the fastapi import, `from ._snapshot import build_model_from_dicts`, `CompareResponse` to the schemas import, and append:

```python
@router.post("/model/compare")
async def compare_model(
    request: Request,
    session: Session = Depends(get_request_session),
) -> CompareResponse:
    """Diff the session model against the raw other-model JSON body.

    The body is the save-file shape (``{"elements": [...], "relationships":
    [...]}``), buffered and parsed like POST /model/upload. It is built
    ``strict=False``: an unknown type in the file is still comparable (only
    staging it is not — the propose route's gate catches that); reserved
    ids, duplicate ids and dangling endpoints stay 422 because the diff
    needs a well-formed model. Direction is always session -> other; the
    client inverts client-side. Read-only, so viewers may call it.
    """
    metamodel, base = require_model(session)
    body = await request.body()
    try:
        raw = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=422, detail=f"Request body is not valid JSON: {exc}"
        ) from exc
    other = build_model_from_dicts(metamodel, raw, strict=False)
    cr = diff_models(base, other)
    return CompareResponse(
        model_rev=session.model_rev,
        cr=_changes_out(base, cr),
        other_element_count=len(other.elements),
        other_relationship_count=len(other.relationships),
    )
```

Update the module docstring's first line to `"""POST /model/apply-cr and POST /model/compare — dry-run proposals.` and add one sentence: `POST /model/compare diffs the session model against an uploaded model and returns the same document shape; Replace in the UI is that CR fed straight back to apply-cr.`

In `src/data_rover/api/authz.py`, add `"/model/compare",` to `_READ_ONLY_POST_SUFFIXES` right after `"/model/validate",`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_compare_route.py tests/api/test_apply_cr_route.py tests/api/test_authz.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint, run the whole backend suite, commit**

Run: `pixi run dr-tidy && pixi run core-test` — Expected: clean, all PASS.

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/change_request.py src/data_rover/api/authz.py tests/api/test_compare_route.py
git commit -m "feat(api): POST /model/compare diffs the session model against an uploaded model"
```

---

### Task 6: Frontend API client (`compareModel`, `proposeCr`)

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (add `CompareOutSchema`, `ProposeCrOutSchema` after `ChangesSummarySchema`)
- Modify: `frontend/src/lib/api/changeRequest.ts` (rewrite)
- Modify: `frontend/src/lib/api/model-ops.ts:52-65` (delete `applyCrSession`)
- Test: `frontend/src/lib/api/__tests__/changeRequest.test.ts` (rewrite)

**Interfaces:**
- Produces: `compareModel(file: Blob, cfg?) -> Promise<CompareOut>`; `proposeCr(crs: ChangeRequest[], cfg?) -> Promise<ProposeCrResult>` where `ProposeCrResult = {ok: true; modelRev; cr: ChangesDoc; ops: ModelOp[]} | {ok: false; modelRev; crIndex; conflicts: Conflict[]}`; `type CompareOut = {model_rev; cr: ChangesDoc; other_element_count; other_relationship_count}`.

- [ ] **Step 1: Write the failing tests**

Replace `frontend/src/lib/api/__tests__/changeRequest.test.ts` with:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { compareModel, proposeCr } from '../changeRequest';
import { server } from './server';
import type { ChangeRequest } from '$lib/state/cr';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const emptyCr: ChangeRequest = {
	format: 'datarover.cr/v1',
	createdAt: '2026-01-01T00:00:00.000Z',
	baseline: { filename: null, elementCount: 0, relationshipCount: 0 },
	ops: {
		elements: { added: [], modified: [], deleted: [] },
		relationships: { added: [], modified: [], deleted: [] }
	}
};

const crDoc = {
	...emptyCr,
	ops: {
		elements: {
			added: [{ id: 'n1', type_name: 'Item', properties: { name: 'N' }, rev: 0 }],
			modified: [],
			deleted: []
		},
		relationships: { added: [], modified: [], deleted: [] }
	}
};

describe('proposeCr', () => {
	it('posts the ordered list and returns ok with cr + ops', async () => {
		let sent: unknown = null;
		server.use(
			http.post(`${BASE}/model/apply-cr`, async ({ request }) => {
				sent = await request.json();
				return HttpResponse.json({
					model_rev: 4,
					cr: crDoc,
					ops: [
						{
							kind: 'create_element',
							temp_id: 'tmp_1',
							id: 'n1',
							type_name: 'Item',
							properties: { name: 'N' }
						}
					]
				});
			})
		);
		const res = await proposeCr([emptyCr, crDoc], cfg);
		expect(sent).toEqual({ crs: [emptyCr, crDoc] });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.modelRev).toBe(4);
		expect(res.cr.ops.elements.added[0].id).toBe('n1');
		expect(res.ops[0]).toMatchObject({ kind: 'create_element', id: 'n1' });
	});

	it('409 → ok:false with crIndex and conflicts', async () => {
		server.use(
			http.post(`${BASE}/model/apply-cr`, () =>
				HttpResponse.json(
					{
						cr_index: 1,
						model_rev: 4,
						conflicts: [{ kind: 'missing', entity: 'element', id: 'zzz', reason: 'gone' }]
					},
					{ status: 409 }
				)
			)
		);
		const res = await proposeCr([emptyCr, emptyCr], cfg);
		expect(res).toEqual({
			ok: false,
			modelRev: 4,
			crIndex: 1,
			conflicts: [{ kind: 'missing', entity: 'element', id: 'zzz', reason: 'gone' }]
		});
	});

	it('422 propagates as an error', async () => {
		server.use(
			http.post(`${BASE}/model/apply-cr`, () =>
				HttpResponse.json({ detail: 'Unknown element type' }, { status: 422 })
			)
		);
		await expect(proposeCr([emptyCr], cfg)).rejects.toThrow(/Unknown element type/);
	});
});

describe('compareModel', () => {
	it('streams the file as the raw body and parses the response', async () => {
		let bodyText = '';
		server.use(
			http.post(`${BASE}/model/compare`, async ({ request }) => {
				bodyText = await request.text();
				return HttpResponse.json({
					model_rev: 2,
					cr: crDoc,
					other_element_count: 3,
					other_relationship_count: 1
				});
			})
		);
		const file = new Blob(['{"elements":[],"relationships":[]}'], { type: 'application/json' });
		const res = await compareModel(file, cfg);
		expect(bodyText).toBe('{"elements":[],"relationships":[]}');
		expect(res.other_element_count).toBe(3);
		expect(res.cr.ops.elements.added[0].id).toBe('n1');
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/api/__tests__/changeRequest.test.ts`
Expected: FAIL — `compareModel`/`proposeCr` are not exported.

- [ ] **Step 3: Add the zod schemas**

In `frontend/src/lib/api/types.ts`, right after `ChangesSummarySchema`'s `export type ChangesSummary = ...` line, add:

```ts
/** POST /model/compare — the session → other-model change request. */
export const CompareOutSchema = z.object({
	model_rev: z.number().int(),
	cr: ChangesDocSchema,
	other_element_count: z.number().int(),
	other_relationship_count: z.number().int()
});
export type CompareOut = z.infer<typeof CompareOutSchema>;

/**
 * POST /model/apply-cr — dry-run proposal. `ops` is the staged-buffer wire
 * format (`state/ops.ts` ModelOp); typed loosely here like SnippetRunOut and
 * narrowed by the client module.
 */
export const ProposeCrOutSchema = z.object({
	model_rev: z.number().int(),
	cr: ChangesDocSchema,
	ops: z.array(z.record(z.string(), z.unknown()))
});
```

- [ ] **Step 4: Rewrite the client module**

Replace `frontend/src/lib/api/changeRequest.ts` with:

```ts
import { apiFetch, type ClientConfig } from './client';
import { ConflictError } from './errors';
import {
	CompareOutSchema,
	ProposeCrOutSchema,
	type ChangesDoc,
	type CompareOut,
	type Conflict
} from './types';
import type { ChangeRequest } from '$lib/state/cr';
import type { ModelOp } from '$lib/state/ops';

export type { CompareOut };

export type ProposeCrResult =
	| { ok: true; modelRev: number; cr: ChangesDoc; ops: ModelOp[] }
	| { ok: false; modelRev: number; crIndex: number; conflicts: Conflict[] };

/**
 * POST /model/compare — diff the SESSION model against a model file
 * (direction session → file; invert client-side with `invertChangeRequest`).
 * The picked File streams as the raw body: no JS-side parse. Read-only.
 */
export function compareModel(file: Blob, cfg?: ClientConfig): Promise<CompareOut> {
	return apiFetch('/model/compare', { method: 'POST', body: file, schema: CompareOutSchema }, cfg);
}

/**
 * POST /model/apply-cr — dry-run proposal: the CRs are applied in order
 * transiently server-side and come back as the combined `cr` (for preview)
 * plus the `ops` batch to stage. Nothing is applied. A 409 names the first
 * conflicting CR by index.
 */
export async function proposeCr(crs: ChangeRequest[], cfg?: ClientConfig): Promise<ProposeCrResult> {
	try {
		const res = await apiFetch(
			'/model/apply-cr',
			{ method: 'POST', body: { crs }, schema: ProposeCrOutSchema },
			cfg
		);
		return { ok: true, modelRev: res.model_rev, cr: res.cr, ops: res.ops as unknown as ModelOp[] };
	} catch (err) {
		if (err instanceof ConflictError) {
			const body = (err.body ?? {}) as {
				cr_index?: number;
				conflicts?: Conflict[];
				model_rev?: number;
			};
			return {
				ok: false,
				modelRev: body.model_rev ?? -1,
				crIndex: body.cr_index ?? 0,
				conflicts: body.conflicts ?? []
			};
		}
		throw err;
	}
}
```

In `frontend/src/lib/api/model-ops.ts`, delete `applyCrSession` and its doc comment, and remove the now-unused `ChangeRequest` type import if nothing else in the file uses it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/api/__tests__/changeRequest.test.ts src/lib/api/__tests__/model-delta.test.ts`
Expected: PASS. `pixi run frontend-check` will now report `ApplyCrDialog.svelte` importing the removed `applyCr` — expected until Task 11 deletes it; do not fix it here.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/changeRequest.ts frontend/src/lib/api/model-ops.ts frontend/src/lib/api/__tests__/changeRequest.test.ts
git commit -m "feat(frontend): compareModel and proposeCr API clients"
```

---

### Task 7: `invertChangeRequest`, `crToDiff`, `crPrestate` (`state/cr.ts`)

**Files:**
- Modify: `frontend/src/lib/state/diff.ts` (export `elementModifiedFields`, `relationshipModifiedFields`)
- Modify: `frontend/src/lib/state/cr.ts` (append)
- Test: `frontend/src/lib/state/__tests__/cr.test.ts` (append)

**Interfaces:**
- Produces: `invertChangeRequest<T extends ChangeRequest>(cr: T): T`; `crToDiff(cr: ChangeRequest): Diff`; `crPrestate(cr: ChangeRequest): { elements: Element[]; relationships: Relationship[] }` (the `before` of every modified entity + every deleted entity); `interface CrPreview { diff: Diff; unchangedHidden: number }`; `interface CrConflictReport { crIndex: number | null; items: Conflict[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/state/__tests__/cr.test.ts` (the file already defines `el`, `rel`, `model` helpers and imports `buildChangeRequest`; extend the import to `{ buildChangeRequest, composeCrFilename, crPrestate, crToDiff, invertChangeRequest }`):

```ts
describe('invertChangeRequest', () => {
	it('swaps added/deleted and before/after, keeping the envelope', () => {
		const cr = buildChangeRequest(
			model([el('a', { n: 1 }), el('b')], [rel('r1', 'a', 'b')]),
			model([el('a', { n: 2 }), el('c')], [rel('r2', 'a', 'c')]),
			'base.json',
			() => new Date('2026-01-01T00:00:00Z')
		);
		const inv = invertChangeRequest(cr);
		expect(inv.format).toBe('datarover.cr/v1');
		expect(inv.createdAt).toBe(cr.createdAt);
		expect(inv.ops.elements.added.map((e) => e.id)).toEqual(['b']);
		expect(inv.ops.elements.deleted.map((e) => e.id)).toEqual(['c']);
		expect(inv.ops.elements.modified).toEqual([
			{ id: 'a', before: el('a', { n: 2 }), after: el('a', { n: 1 }) }
		]);
		expect(inv.ops.relationships.added.map((r) => r.id)).toEqual(['r1']);
		expect(inv.ops.relationships.deleted.map((r) => r.id)).toEqual(['r2']);
		expect(invertChangeRequest(inv)).toEqual(cr);
	});
});

describe('crToDiff', () => {
	it('is the inverse of buildChangeRequest', () => {
		const from = model([el('a', { n: 1 }), el('b')], [rel('r1', 'a', 'b'), rel('r2', 'a', 'b', { w: 1 })]);
		const to = model([el('a', { n: 2 }), el('c')], [rel('r2', 'b', 'a', { w: 1 }), rel('r3', 'a', 'c')]);
		const cr = buildChangeRequest(from, to, null);
		const diff = crToDiff(cr);
		expect(diff.counts).toEqual({ added: 2, modified: 2, deleted: 2 });
		expect(diff.elements.map((d) => [d.id, d.status])).toEqual([
			['c', 'added'],
			['a', 'modified'],
			['b', 'deleted']
		]);
		expect(diff.elements[1].modifiedFields).toEqual(['n']);
		const r2 = diff.relationships.find((d) => d.id === 'r2')!;
		expect(r2.status).toBe('modified');
		expect(r2.modifiedFields).toEqual(['source_id', 'target_id']);
	});
});

describe('crPrestate', () => {
	it('collects the before-state of modified and deleted entities only', () => {
		const cr = buildChangeRequest(
			model([el('a', { n: 1 }), el('b')], [rel('r1', 'a', 'b')]),
			model([el('a', { n: 2 }), el('c')], []),
			null
		);
		expect(crPrestate(cr)).toEqual({
			elements: [el('a', { n: 1 }), el('b')],
			relationships: [rel('r1', 'a', 'b')]
		});
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/state/__tests__/cr.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement**

In `frontend/src/lib/state/diff.ts`, add `export` to `function elementModifiedFields(...)` and `function relationshipModifiedFields(...)`.

Append to `frontend/src/lib/state/cr.ts` (extend the existing `./diff` import to `{ computeDiff, elementModifiedFields, relationshipModifiedFields, type Diff, type EntityDiff }` and add `import type { Conflict } from '$lib/api/types';`):

```ts
/** What the dialog's preview renders: the CR as a Diff plus the hidden count. */
export interface CrPreview {
	diff: Diff;
	unchangedHidden: number;
}

/** A 409 from POST /model/apply-cr: `crIndex` is null for a single-CR flow. */
export interface CrConflictReport {
	crIndex: number | null;
	items: Conflict[];
}

/**
 * The change request that undoes `cr` (added↔deleted, before↔after). Pure;
 * the envelope (format, createdAt, baseline, any extra field such as the
 * server's `complete`) is kept as-is — the caller relabels it.
 */
export function invertChangeRequest<T extends ChangeRequest>(cr: T): T {
	const { elements, relationships } = cr.ops;
	return {
		...cr,
		ops: {
			elements: {
				added: elements.deleted,
				modified: elements.modified.map((m) => ({ id: m.id, before: m.after, after: m.before })),
				deleted: elements.added
			},
			relationships: {
				added: relationships.deleted,
				modified: relationships.modified.map((m) => ({
					id: m.id,
					before: m.after,
					after: m.before
				})),
				deleted: relationships.added
			}
		}
	};
}

/** The inverse of `buildChangeRequest`'s partition: a CR as a renderable Diff. */
export function crToDiff(cr: ChangeRequest): Diff {
	const { elements, relationships } = cr.ops;
	const els: EntityDiff[] = [
		...elements.added.map((e) => ({ id: e.id, status: 'added' as const, after: e })),
		...elements.modified.map((m) => ({
			id: m.id,
			status: 'modified' as const,
			before: m.before,
			after: m.after,
			modifiedFields: elementModifiedFields(m.before, m.after)
		})),
		...elements.deleted.map((e) => ({ id: e.id, status: 'deleted' as const, before: e }))
	];
	const rels: EntityDiff[] = [
		...relationships.added.map((r) => ({ id: r.id, status: 'added' as const, after: r })),
		...relationships.modified.map((m) => ({
			id: m.id,
			status: 'modified' as const,
			before: m.before,
			after: m.after,
			modifiedFields: relationshipModifiedFields(m.before, m.after)
		})),
		...relationships.deleted.map((r) => ({ id: r.id, status: 'deleted' as const, before: r }))
	];
	const counts = { added: 0, modified: 0, deleted: 0 };
	for (const d of [...els, ...rels]) {
		if (d.status !== 'unchanged') counts[d.status]++;
	}
	return { elements: els, relationships: rels, counts };
}

/**
 * The pre-state a proposal already carries: the `before` of every modified
 * entity plus every deleted one — exactly the update/delete targets
 * `stageProposedOps` would otherwise fetch one by one.
 */
export function crPrestate(cr: ChangeRequest): { elements: Element[]; relationships: Relationship[] } {
	return {
		elements: [...cr.ops.elements.modified.map((m) => m.before), ...cr.ops.elements.deleted],
		relationships: [
			...cr.ops.relationships.modified.map((m) => m.before),
			...cr.ops.relationships.deleted
		]
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/state/__tests__/cr.test.ts src/lib/state/__tests__/diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/diff.ts frontend/src/lib/state/cr.ts frontend/src/lib/state/__tests__/cr.test.ts
git commit -m "feat(frontend): invertChangeRequest, crToDiff and crPrestate"
```

---

### Task 8: `stageProposedOps` (extract from `snippet-stage.ts`)

**Files:**
- Create: `frontend/src/lib/state/stage-proposed.ts`
- Modify: `frontend/src/lib/state/snippet-stage.ts` (thin wrapper)
- Modify: `frontend/src/lib/state/index.ts:295` (export)
- Test: `frontend/src/lib/state/__tests__/stage-proposed.test.ts` (create, from the moved snippet-stage tests), `frontend/src/lib/state/__tests__/snippet-stage.test.ts` (shrink)

**Interfaces:**
- Consumes: `emit`, `ensureElement`, `ensureRelationship`, `getModelRev`, `seedElements`, `seedRelationships` (`model.svelte.ts`); `acquireLocks` (`edit-gate.ts`); `createTempId`, `isTempId` (`ops.ts`); `remapProperties` (`remap.ts`).
- Produces: `stageProposedOps(ops: ModelOp[], modelRev: number, prestate?: Prestate): Promise<StageOutcome>`; `interface Prestate { elements: Element[]; relationships: Relationship[] }`; `StageOutcome` moves here (`snippet-stage.ts` re-exports it). `stageSnippetOps` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/state/__tests__/stage-proposed.test.ts` by MOVING every test body from `snippet-stage.test.ts` and replacing `stageSnippetOps(runOut(ops))` with `stageProposedOps(ops, 0)` and `stageSnippetOps(runOut(ops, { model_rev: 99 }))` with `stageProposedOps(ops, 99)` (drop the `stale: true` case — that flag belongs to the wrapper), then add these two tests:

```ts
	it('preserves the id hint on create ops through the temp-id remap', async () => {
		const ops = [
			{
				kind: 'create_element',
				temp_id: 'tmp_1',
				id: 'real-1',
				type_name: 'Building',
				properties: {}
			},
			{
				kind: 'create_relationship',
				temp_id: 'tmp_2',
				id: 'real-r',
				type_name: 'Owns',
				source_id: 'tmp_1',
				target_id: 'e2',
				properties: {}
			}
		] as ModelOp[];
		const res = await stageProposedOps(ops, 0);
		expect(res).toEqual({ ok: true, count: 2 });
		const [c, r] = getStagedOps() as [
			Extract<ModelOp, { kind: 'create_element' }>,
			Extract<ModelOp, { kind: 'create_relationship' }>
		];
		expect(isTempId(c.temp_id)).toBe(true);
		expect(c.id).toBe('real-1');
		expect(r.id).toBe('real-r');
		expect(r.source_id).toBe(c.temp_id);
	});

	it('seeds prestate so uncached targets need no fetch', async () => {
		// e9 is NOT in the cache; without prestate ensureElement would hit the
		// (unmocked) API and the stage would fail as 'missing'
		const ops = [
			{ kind: 'update_element', id: 'e9', properties_patch: { name: 'Renamed' } }
		] as ModelOp[];
		const prestate = {
			elements: [{ id: 'e9', type_name: 'Building', properties: { name: 'Old' }, rev: 1 }],
			relationships: []
		};
		const res = await stageProposedOps(ops, 0, prestate);
		expect(res).toEqual({ ok: true, count: 1 });
		expect(getCachedElements().get('e9')?.properties.name).toBe('Renamed');
	});
```

with the file header:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stageProposedOps } from '../stage-proposed';
import * as checkout from '../checkout.svelte';
import {
	getCachedElements,
	getStagedOps,
	resetModelStore,
	seedElements,
	seedRelationships
} from '../model.svelte';
import { isTempId, type ModelOp } from '../ops';
```

and the same `EL`/`REL` constants and `beforeEach`/`afterEach` as the original file. Wrap everything in `describe('stageProposedOps', …)`.

Shrink `frontend/src/lib/state/__tests__/snippet-stage.test.ts` to:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stageSnippetOps } from '../snippet-stage';
import * as checkout from '../checkout.svelte';
import { getStagedOps, resetModelStore, seedElements } from '../model.svelte';
import type { SnippetRunOut } from '$lib/api/snippets';

function runOut(ops: SnippetRunOut['ops'], overrides: Partial<SnippetRunOut> = {}): SnippetRunOut {
	return {
		run_id: 'r-1',
		stdout: '',
		result_repr: null,
		ops,
		error: null,
		duration_ms: 1,
		model_rev: 0,
		stale: false,
		truncated: false,
		...overrides
	};
}

const UPDATE = [
	{ kind: 'update_element', id: 'e1', properties_patch: { name: 'X' } }
] as SnippetRunOut['ops'];

beforeEach(() => {
	seedElements([{ id: 'e1', type_name: 'Building', properties: { name: 'Town Hall' }, rev: 1 }]);
	vi.spyOn(checkout, 'ensureCheckout').mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
	resetModelStore();
	vi.restoreAllMocks();
});

describe('stageSnippetOps (wrapper over stageProposedOps)', () => {
	it('refuses empty batches', async () => {
		expect(await stageSnippetOps(runOut([]))).toEqual({ ok: false, reason: 'empty' });
	});

	it("refuses a run the server flagged stale, or whose rev moved", async () => {
		expect(await stageSnippetOps(runOut(UPDATE, { stale: true }))).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(await stageSnippetOps(runOut(UPDATE, { model_rev: 99 }))).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(getStagedOps()).toHaveLength(0);
	});

	it('stages a fresh run', async () => {
		expect(await stageSnippetOps(runOut(UPDATE))).toEqual({ ok: true, count: 1 });
		expect(getStagedOps()).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/state/__tests__/stage-proposed.test.ts src/lib/state/__tests__/snippet-stage.test.ts`
Expected: stage-proposed FAILS to import; snippet-stage passes.

- [ ] **Step 3: Implement `stage-proposed.ts`**

Create `frontend/src/lib/state/stage-proposed.ts`:

```ts
/**
 * Folds a server-PROPOSED op batch (a snippet dry run, a CR / compare
 * proposal) into the staged-edits buffer so it becomes indistinguishable
 * from manual edits (optimistic apply, client-side undo, DiffDrawer, commit,
 * lock release). Three concerns the proposer cannot handle:
 *
 * 1. TEMP-ID REMAP — proposers number temp ids per batch (`tmp_1`, ...), so
 *    two staged batches would collide; every batch gets fresh `createTempId()`
 *    ids, rewritten across `temp_id`/`source_id`/`target_id`/`id` AND
 *    ref-shaped property values. A create's `id` HINT (the file's real id,
 *    CR/compare proposals) is not a temp id and rides through untouched.
 * 2. PRE-STATE — update/delete targets may be uncached (the proposer saw the
 *    server model, not the client cache); `emit`'s optimistic journal needs
 *    the entity present, and relationship ops need the rel's source_id for
 *    lock derivation. A proposal that already carries the pre-state passes
 *    it as `prestate` (seeded first, so nothing is fetched); otherwise each
 *    target is fetched.
 * 3. LOCKS — one acquireLocks call per intent group (edit/connect/delete),
 *    mirroring what the manual UI acquires for the same edits. Any refusal
 *    stages NOTHING (already-acquired leases from earlier groups just expire
 *    via TTL — same as a user who locked an element and never edited it).
 */
import type { Element, Relationship } from '$lib/api/types';
import type { LockTargetIn } from '$lib/api/types';
import type { ModelOp } from './ops';
import { createTempId, isTempId } from './ops';
import { remapProperties } from './remap';
import {
	emit,
	ensureElement,
	ensureRelationship,
	getModelRev,
	seedElements,
	seedRelationships
} from './model.svelte';
import { acquireLocks } from './edit-gate';

export type StageOutcome =
	| { ok: true; count: number }
	| { ok: false; reason: 'empty' | 'stale' | 'locks' | 'missing' };

export interface Prestate {
	elements: Element[];
	relationships: Relationship[];
}

export async function stageProposedOps(
	proposed: ModelOp[],
	modelRev: number,
	prestate?: Prestate
): Promise<StageOutcome> {
	if (proposed.length === 0) return { ok: false, reason: 'empty' };
	if (modelRev !== getModelRev()) return { ok: false, reason: 'stale' };

	// 1. Remap proposer temp ids to fresh client temp ids (id hints untouched).
	const mapping: Record<string, string> = {};
	for (const op of proposed) {
		if (op.kind === 'create_element' || op.kind === 'create_relationship') {
			mapping[op.temp_id] = createTempId();
		}
	}
	const mapId = (id: string): string => mapping[id] ?? id;
	const ops: ModelOp[] = proposed.map((op) => {
		switch (op.kind) {
			case 'create_element':
				return {
					...op,
					temp_id: mapping[op.temp_id],
					properties: remapProperties(op.properties, mapping)
				};
			case 'create_relationship':
				return {
					...op,
					temp_id: mapping[op.temp_id],
					source_id: mapId(op.source_id),
					target_id: mapId(op.target_id),
					properties: remapProperties(op.properties, mapping)
				};
			case 'update_element':
			case 'update_relationship':
				return {
					...op,
					id: mapId(op.id),
					properties_patch: remapProperties(op.properties_patch, mapping)
				};
			case 'delete_element':
			case 'delete_relationship':
				return { ...op, id: mapId(op.id) };
		}
	});

	// 2. Pre-state: seed what the proposal carries, fetch the rest.
	if (prestate) {
		seedElements(prestate.elements);
		seedRelationships(prestate.relationships);
	}
	const relSource = new Map<string, string>();
	for (const op of ops) {
		if ((op.kind === 'update_element' || op.kind === 'delete_element') && !isTempId(op.id)) {
			if ((await ensureElement(op.id)) === null) return { ok: false, reason: 'missing' };
		}
		if (
			(op.kind === 'update_relationship' || op.kind === 'delete_relationship') &&
			!isTempId(op.id)
		) {
			const rel = await ensureRelationship(op.id);
			if (rel === null) return { ok: false, reason: 'missing' };
			relSource.set(op.id, rel.source_id);
		}
	}

	// 3. Locks, grouped by intent — the same targets the manual UI acquires:
	//    edit   -> exclusive on updated elements / updated rels' sources
	//    delete -> exclusive on deleted elements / deleted rels' sources
	//    connect-> exclusive source + shared target per created relationship
	const edit = new Map<string, LockTargetIn>();
	const del = new Map<string, LockTargetIn>();
	const connect = new Map<string, LockTargetIn>();
	for (const op of ops) {
		if (op.kind === 'update_element' && !isTempId(op.id)) {
			edit.set(op.id, { resource_id: op.id, mode: 'exclusive' });
		} else if (op.kind === 'delete_element' && !isTempId(op.id)) {
			del.set(op.id, { resource_id: op.id, mode: 'exclusive' });
		} else if (op.kind === 'update_relationship' && !isTempId(op.id)) {
			const src = relSource.get(op.id);
			if (src !== undefined) edit.set(src, { resource_id: src, mode: 'exclusive' });
		} else if (op.kind === 'delete_relationship' && !isTempId(op.id)) {
			const src = relSource.get(op.id);
			if (src !== undefined) del.set(src, { resource_id: src, mode: 'exclusive' });
		} else if (op.kind === 'create_relationship') {
			if (!isTempId(op.source_id))
				connect.set(op.source_id, { resource_id: op.source_id, mode: 'exclusive' });
			if (!isTempId(op.target_id) && !connect.has(op.target_id)) {
				connect.set(op.target_id, { resource_id: op.target_id, mode: 'shared' });
			}
		}
	}
	const groups: Array<[LockTargetIn[], 'edit' | 'delete' | 'connect']> = [
		[[...edit.values()], 'edit'],
		[[...connect.values()], 'connect'],
		[[...del.values()], 'delete']
	];
	for (const [targets, intent] of groups) {
		if (targets.length === 0) continue;
		if (!(await acquireLocks(targets, intent))) return { ok: false, reason: 'locks' };
	}

	// 4. Stage — indistinguishable from manual edits from here on.
	for (const op of ops) emit(op);
	return { ok: true, count: ops.length };
}
```

Replace `frontend/src/lib/state/snippet-stage.ts` with:

```ts
/**
 * Snippet-run wrapper over `stageProposedOps`: the run's own `stale` flag
 * (a commit landed mid-run) is refused before the rev check.
 */
import type { SnippetRunOut } from '$lib/api/snippets';
import { stageProposedOps, type StageOutcome } from './stage-proposed';

export type { StageOutcome };

export async function stageSnippetOps(result: SnippetRunOut): Promise<StageOutcome> {
	if (result.ops.length === 0) return { ok: false, reason: 'empty' };
	if (result.stale) return { ok: false, reason: 'stale' };
	return stageProposedOps(result.ops, result.model_rev);
}
```

In `frontend/src/lib/state/index.ts`, after the `stageSnippetOps` export line add:

```ts
export { stageProposedOps, type Prestate } from './stage-proposed';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/state/__tests__/stage-proposed.test.ts src/lib/state/__tests__/snippet-stage.test.ts src/lib/components/Snippet`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/stage-proposed.ts frontend/src/lib/state/snippet-stage.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/stage-proposed.test.ts frontend/src/lib/state/__tests__/snippet-stage.test.ts
git commit -m "refactor(frontend): extract stageProposedOps from snippet-stage"
```

---

### Task 9: `ProposalPreview.svelte` + `ModelChangeDialog.svelte` (compare mode)

**Files:**
- Create: `frontend/src/lib/components/ProposalPreview.svelte`
- Create: `frontend/src/lib/components/ModelChangeDialog.svelte`
- Test: `frontend/src/lib/components/__tests__/ModelChangeDialog.test.ts` (create)

**Interfaces:**
- Consumes: `compareModel`, `proposeCr` (Task 6); `invertChangeRequest`, `crToDiff`, `crPrestate`, `composeCrFilename`, `CrPreview`, `CrConflictReport` (Task 7); `stageProposedOps` (Task 8); `canEdit`, `hasStagedOps`, `getFilename`, `getModelRev`, `getModelSummary`, `setLockNotice` (`$lib/state`); `saveJsonToFile`; `CompareDiff`.
- Produces: `ModelChangeDialog` props `{ open: boolean (bindable); mode: 'compare' | 'apply-cr' }`; `ProposalPreview` props `{ preview: CrPreview | null; conflicts: CrConflictReport | null; error: string | null }`. Test ids: `mcd-file-input`, `mcd-swap`, `mcd-preview`, `mcd-create-cr`, `mcd-replace`, `mcd-stage`, `mcd-gate-hint`, `mcd-cr-row-{i}`, `mcd-cr-up-{i}`, `mcd-cr-down-{i}`, `mcd-cr-remove-{i}`, `proposal-preview`, `proposal-conflicts`, `proposal-error`.
- The apply-cr mode's list UI is written here too (the component is one file) but its tests land in Task 10.

- [ ] **Step 1: Write the failing tests (compare mode)**

Create `frontend/src/lib/components/__tests__/ModelChangeDialog.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as crApi from '$lib/api/changeRequest';
import * as stageProposed from '$lib/state/stage-proposed';
import * as fileSave from '$lib/util/fileSave';
import { canEdit, hasStagedOps } from '$lib/state';
import ModelChangeDialog from '../ModelChangeDialog.svelte';

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		canEdit: vi.fn(() => true),
		hasStagedOps: vi.fn(() => false),
		getFilename: vi.fn(() => 'city.model.json'),
		getModelRev: vi.fn(() => 3),
		getModelSummary: vi.fn(() => ({
			model_rev: 3,
			element_count: 10,
			relationship_count: 5,
			elements_by_type: {},
			issue_counts: null,
			undo_depth: 0
		})),
		setLockNotice: vi.fn()
	};
});

const EL = (id: string, name: string) => ({ id, type_name: 'Item', properties: { name }, rev: 0 });

const CR_DOC = {
	format: 'datarover.cr/v1' as const,
	createdAt: '2026-01-01T00:00:00.000Z',
	baseline: { filename: null, elementCount: 10, relationshipCount: 5 },
	ops: {
		elements: {
			added: [EL('n1', 'N')],
			modified: [{ id: 'a', before: EL('a', 'A'), after: EL('a', 'A2') }],
			deleted: [EL('b', 'B')]
		},
		relationships: { added: [], modified: [], deleted: [] }
	},
	complete: true
};

const COMPARE_OUT = { model_rev: 3, cr: CR_DOC, other_element_count: 10, other_relationship_count: 5 };

const CREATE_OP = {
	kind: 'create_element' as const,
	temp_id: 'tmp_1',
	id: 'n1',
	type_name: 'Item',
	properties: { name: 'N' }
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	vi.mocked(canEdit).mockReturnValue(true);
	vi.mocked(hasStagedOps).mockReturnValue(false);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	vi.restoreAllMocks();
});

function open(mode: 'compare' | 'apply-cr') {
	app = mount(ModelChangeDialog, { target: host, props: { open: true, mode } });
	flushSync();
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
	const el = document.body.querySelector<T>(`[data-testid="${id}"]`);
	if (!el) throw new Error(`${id} not rendered`);
	return el;
}

function pickFiles(files: File[]): void {
	const input = byTestId<HTMLInputElement>('mcd-file-input');
	Object.defineProperty(input, 'files', { value: files, configurable: true });
	input.dispatchEvent(new Event('change'));
	flushSync();
}

async function settle(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const modelFile = () =>
	new File(['{"elements":[],"relationships":[]}'], 'other.model.json', { type: 'application/json' });

describe('ModelChangeDialog — compare mode', () => {
	it('fires no request on file pick; Preview diff calls compare and renders', async () => {
		const compare = vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		open('compare');
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(true);

		pickFiles([modelFile()]);
		expect(compare).not.toHaveBeenCalled();
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(false);

		byTestId('mcd-preview').click();
		await settle();
		expect(compare).toHaveBeenCalledTimes(1);
		const preview = byTestId('proposal-preview');
		expect(preview.textContent).toContain('+1 added');
		expect(preview.textContent).toContain('~1 modified');
		expect(preview.textContent).toContain('−1 deleted');
	});

	it('Swap inverts the preview and disables Replace', async () => {
		vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		open('compare');
		pickFiles([modelFile()]);
		byTestId('mcd-swap').click();
		flushSync();
		expect(byTestId<HTMLButtonElement>('mcd-replace').disabled).toBe(true);

		byTestId('mcd-preview').click();
		await settle();
		// inverted: the added n1 now reads as deleted and b as added
		const rows = byTestId('proposal-preview').textContent ?? '';
		expect(rows).toContain('+1 added');
		expect(rows).toContain('−1 deleted');
		expect(document.body.querySelector('[data-testid="proposal-preview"]')).not.toBeNull();
	});

	it('Create CR saves the (inverted when swapped) CR under the CR filename', async () => {
		vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		const save = vi
			.spyOn(fileSave, 'saveJsonToFile')
			.mockResolvedValue({ filename: 'x', handle: null } as never);
		open('compare');
		pickFiles([modelFile()]);
		byTestId('mcd-create-cr').click();
		await settle();
		expect(save).toHaveBeenCalledTimes(1);
		const [doc, name] = save.mock.calls[0] as [Record<string, unknown>, string];
		expect(name).toMatch(/_city\.model\.cr\.json$/);
		expect(doc.complete).toBeUndefined();
		expect((doc.ops as typeof CR_DOC.ops).elements.added.map((e) => e.id)).toEqual(['n1']);

		byTestId('mcd-swap').click();
		flushSync();
		byTestId('mcd-create-cr').click();
		await settle();
		const [inv, invName] = save.mock.calls[1] as [Record<string, unknown>, string];
		expect(invName).toMatch(/_other\.model\.cr\.json$/);
		expect((inv.ops as typeof CR_DOC.ops).elements.deleted.map((e) => e.id)).toEqual(['n1']);
	});

	it('Replace proposes the compare CR and stages the ops with prestate', async () => {
		vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		const propose = vi
			.spyOn(crApi, 'proposeCr')
			.mockResolvedValue({ ok: true, modelRev: 3, cr: CR_DOC, ops: [CREATE_OP] });
		const stage = vi
			.spyOn(stageProposed, 'stageProposedOps')
			.mockResolvedValue({ ok: true, count: 1 });
		open('compare');
		pickFiles([modelFile()]);
		byTestId('mcd-replace').click();
		await settle();
		expect(propose).toHaveBeenCalledWith([CR_DOC]);
		expect(stage).toHaveBeenCalledWith([CREATE_OP], 3, {
			elements: [EL('a', 'A'), EL('b', 'B')],
			relationships: []
		});
		// staged → the dialog closed itself
		expect(document.body.querySelector('[data-testid="mcd-replace"]')).toBeNull();
	});

	it('Replace renders a 409 as conflicts and stages nothing', async () => {
		vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		vi.spyOn(crApi, 'proposeCr').mockResolvedValue({
			ok: false,
			modelRev: 3,
			crIndex: 0,
			conflicts: [{ kind: 'before_mismatch', entity: 'element', id: 'a', reason: 'moved' }]
		});
		const stage = vi.spyOn(stageProposed, 'stageProposedOps');
		open('compare');
		pickFiles([modelFile()]);
		byTestId('mcd-replace').click();
		await settle();
		expect(stage).not.toHaveBeenCalled();
		expect(byTestId('proposal-conflicts').textContent).toContain('element a: before_mismatch');
	});

	it('Replace is gated on edit rights and a clean staged buffer', () => {
		vi.mocked(hasStagedOps).mockReturnValue(true);
		open('compare');
		pickFiles([modelFile()]);
		expect(byTestId<HTMLButtonElement>('mcd-replace').disabled).toBe(true);
		expect(byTestId('mcd-gate-hint').textContent).toMatch(/commit or discard/i);
		unmount(app!);
		app = null;

		vi.mocked(hasStagedOps).mockReturnValue(false);
		vi.mocked(canEdit).mockReturnValue(false);
		open('compare');
		pickFiles([modelFile()]);
		expect(byTestId<HTMLButtonElement>('mcd-replace').disabled).toBe(true);
		expect(byTestId('mcd-gate-hint').textContent).toMatch(/view-only/i);
		// a viewer can still preview and create a CR
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(false);
		expect(byTestId<HTMLButtonElement>('mcd-create-cr').disabled).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/components/__tests__/ModelChangeDialog.test.ts`
Expected: FAIL — cannot resolve `../ModelChangeDialog.svelte`.

- [ ] **Step 3: Create `ProposalPreview.svelte`**

```svelte
<script lang="ts">
	import type { CrConflictReport, CrPreview } from '$lib/state/cr';
	import CompareDiff from './CompareDiff.svelte';

	type Props = {
		preview: CrPreview | null;
		conflicts: CrConflictReport | null;
		error: string | null;
	};
	let { preview, conflicts, error }: Props = $props();
</script>

{#if error}
	<p class="text-xs text-destructive" data-testid="proposal-error" role="alert">{error}</p>
{/if}

{#if conflicts}
	<div
		class="flex flex-col gap-1 rounded border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive"
		role="alert"
		data-testid="proposal-conflicts"
	>
		<p class="font-semibold">
			{conflicts.crIndex === null ? 'Conflicts' : `CR #${conflicts.crIndex + 1} conflicts`} — nothing
			staged
		</p>
		{#each conflicts.items as c (c.entity + c.id + c.kind)}
			<p class="font-mono">{c.entity} {c.id}: {c.kind} — {c.reason}</p>
		{/each}
	</div>
{/if}

{#if preview}
	<div data-testid="proposal-preview">
		<CompareDiff diff={preview.diff} unchangedHidden={preview.unchangedHidden} />
	</div>
{/if}
```

- [ ] **Step 4: Create `ModelChangeDialog.svelte`**

```svelte
<script lang="ts">
	import { compareModel, proposeCr, type CompareOut } from '$lib/api/changeRequest';
	import {
		canEdit,
		getFilename,
		getModelRev,
		getModelSummary,
		hasStagedOps,
		setLockNotice
	} from '$lib/state';
	import { stageProposedOps } from '$lib/state/stage-proposed';
	import {
		composeCrFilename,
		crPrestate,
		crToDiff,
		invertChangeRequest,
		type ChangeRequest,
		type CrConflictReport,
		type CrPreview
	} from '$lib/state/cr';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import ProposalPreview from './ProposalPreview.svelte';

	// One dialog, two sources. Everything below the source strip is shared:
	// a proposal is previewed and staged the same way whether it came from a
	// model file (compare) or from CR files (apply-cr). Nothing runs on file
	// selection — every request sits behind an explicit button.
	type Mode = 'compare' | 'apply-cr';
	let { open = $bindable(false), mode }: { open: boolean; mode: Mode } = $props();

	// compare-mode source
	let otherFile: File | null = $state(null);
	let swapped = $state(false);
	// cached per rev: Preview then Replace must not upload the file twice
	let compared: { rev: number; out: CompareOut } | null = $state(null);
	// apply-cr-mode source (display order = apply order)
	let crFiles: { name: string; cr: ChangeRequest }[] = $state([]);
	// shared output
	let preview: CrPreview | null = $state(null);
	let conflicts: CrConflictReport | null = $state(null);
	let error: string | null = $state(null);
	let busy = $state(false);
	let fileInputRef: HTMLInputElement | null = $state(null);

	const editable = $derived(canEdit());
	const bufferDirty = $derived(hasStagedOps());
	const hasSource = $derived(mode === 'compare' ? otherFile !== null : crFiles.length > 0);
	// Replace/Stage compute against the COMMITTED model: pre-existing staged
	// edits would surface as conflicts or double edits, so a clean buffer is
	// required. Replace is session -> file by definition, hence off when swapped.
	const proceedDisabled = $derived(
		busy || !hasSource || !editable || bufferDirty || (mode === 'compare' && swapped)
	);
	const sessionLabel = $derived(getFilename() ?? 'model');
	const otherLabel = $derived(otherFile?.name ?? 'other');

	const STAGE_FAILURES = {
		empty: 'Nothing to stage — the models are identical.',
		stale: 'The model changed since the proposal — preview again.',
		locks: 'Could not acquire the locks needed to stage these edits.',
		missing: 'An entity the proposal touches no longer exists — preview again.'
	} as const;

	function clearOutput(): void {
		preview = null;
		conflicts = null;
		error = null;
	}

	function reset(): void {
		otherFile = null;
		swapped = false;
		compared = null;
		crFiles = [];
		busy = false;
		clearOutput();
	}

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) reset();
	}

	async function onFilesSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const files = [...(target.files ?? [])];
		target.value = '';
		if (files.length === 0) return;
		clearOutput();
		if (mode === 'compare') {
			otherFile = files[0];
			compared = null;
			return;
		}
		for (const file of files) {
			try {
				const parsed = JSON.parse(await file.text());
				if (parsed?.format !== 'datarover.cr/v1') {
					error = `${file.name}: not a CR file (expected format datarover.cr/v1)`;
					continue;
				}
				crFiles = [...crFiles, { name: file.name, cr: parsed as ChangeRequest }];
			} catch (err) {
				error = `${file.name}: ${err instanceof Error ? err.message : 'Invalid JSON'}`;
			}
		}
	}

	function moveCr(i: number, delta: number): void {
		const j = i + delta;
		if (j < 0 || j >= crFiles.length) return;
		const next = [...crFiles];
		[next[i], next[j]] = [next[j], next[i]];
		crFiles = next;
		clearOutput();
	}

	function removeCr(i: number): void {
		crFiles = crFiles.filter((_, k) => k !== i);
		clearOutput();
	}

	async function ensureCompared(): Promise<CompareOut> {
		const rev = getModelRev();
		if (compared && compared.rev === rev) return compared.out;
		if (!otherFile) throw new Error('Choose a model file first');
		const out = await compareModel(otherFile);
		compared = { rev, out };
		return out;
	}

	function directedCr(out: CompareOut): ChangeRequest {
		return swapped ? invertChangeRequest(out.cr) : out.cr;
	}

	function previewOf(cr: ChangeRequest, toTotal: number): CrPreview {
		const diff = crToDiff(cr);
		return {
			diff,
			unchangedHidden: Math.max(0, toTotal - diff.counts.added - diff.counts.modified)
		};
	}

	function sessionTotal(): number {
		const s = getModelSummary();
		return s ? s.element_count + s.relationship_count : 0;
	}

	async function run(fn: () => Promise<void>): Promise<void> {
		busy = true;
		clearOutput();
		try {
			await fn();
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	function onPreview(): Promise<void> {
		return run(async () => {
			if (mode === 'compare') {
				const out = await ensureCompared();
				const toTotal = swapped
					? sessionTotal()
					: out.other_element_count + out.other_relationship_count;
				preview = previewOf(directedCr(out), toTotal);
				return;
			}
			const res = await proposeCr(crFiles.map((f) => f.cr));
			if (!res.ok) {
				conflicts = { crIndex: res.crIndex, items: res.conflicts };
				return;
			}
			const { baseline, ops } = res.cr;
			const toTotal =
				baseline.elementCount +
				baseline.relationshipCount +
				ops.elements.added.length +
				ops.relationships.added.length -
				ops.elements.deleted.length -
				ops.relationships.deleted.length;
			preview = previewOf(res.cr, toTotal);
		});
	}

	function onCreateCr(): Promise<void> {
		return run(async () => {
			const out = await ensureCompared();
			// strip the transport-only `complete` flag so the file is exactly the
			// datarover.cr/v1 shape Apply CR expects (same as saveWithOptionalCr)
			const doc: Record<string, unknown> = { ...directedCr(out) };
			delete doc.complete;
			await saveJsonToFile(doc, composeCrFilename(swapped ? otherLabel : getFilename()));
		});
	}

	function onProceed(): Promise<void> {
		return run(async () => {
			const crs = mode === 'compare' ? [(await ensureCompared()).cr] : crFiles.map((f) => f.cr);
			const res = await proposeCr(crs);
			if (!res.ok) {
				conflicts = { crIndex: mode === 'compare' ? null : res.crIndex, items: res.conflicts };
				return;
			}
			const outcome = await stageProposedOps(res.ops, res.modelRev, crPrestate(res.cr));
			if (!outcome.ok) {
				error = STAGE_FAILURES[outcome.reason];
				return;
			}
			setLockNotice(`${outcome.count} edits staged — review with Ctrl+S`);
			onOpenChange(false);
		});
	}

	const rowBtn =
		'rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-4xl">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">
				{mode === 'compare' ? 'Compare models' : 'Apply change requests'}
			</Dialog.Title>
			<Dialog.Description>
				{#if mode === 'compare'}
					Diff the loaded model against another model file. Replace stages every edit that makes
					the loaded model match the file; Create CR saves the diff as a change request.
				{:else}
					Pick one or more CR files. They are applied in order against the loaded model and the
					result is staged for review — never committed directly.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3">
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<Button type="button" variant="outline" size="sm" onclick={() => fileInputRef?.click()}>
					{mode === 'compare' ? 'Choose model…' : 'Add CR files…'}
				</Button>
				<input
					bind:this={fileInputRef}
					type="file"
					accept=".json"
					multiple={mode === 'apply-cr'}
					class="hidden"
					data-testid="mcd-file-input"
					onchange={onFilesSelected}
				/>
				{#if mode === 'compare'}
					<span class="font-mono text-xs text-muted-foreground">
						{otherFile?.name ?? 'No file selected'}
					</span>
					{#if otherFile}
						<span class="ml-2 text-xs text-muted-foreground">
							From <span class="font-mono text-foreground/80">{swapped ? otherLabel : sessionLabel}</span>
							→ To <span class="font-mono text-foreground/80">{swapped ? sessionLabel : otherLabel}</span>
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							class="h-7 text-xs"
							data-testid="mcd-swap"
							onclick={() => {
								swapped = !swapped;
								clearOutput();
							}}
						>
							⇄ Swap
						</Button>
					{/if}
				{/if}
			</div>

			{#if mode === 'apply-cr'}
				{#if crFiles.length === 0}
					<p class="text-xs text-muted-foreground">No CR files added.</p>
				{:else}
					<ol class="flex flex-col gap-1">
						{#each crFiles as f, i (f.name + i)}
							<li
								class="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs"
								data-testid={`mcd-cr-row-${i}`}
							>
								<span class="w-6 text-muted-foreground">#{i + 1}</span>
								<span class="flex-1 truncate font-mono">{f.name}</span>
								<button
									type="button"
									class={rowBtn}
									data-testid={`mcd-cr-up-${i}`}
									aria-label="Move up"
									disabled={i === 0}
									onclick={() => moveCr(i, -1)}>↑</button
								>
								<button
									type="button"
									class={rowBtn}
									data-testid={`mcd-cr-down-${i}`}
									aria-label="Move down"
									disabled={i === crFiles.length - 1}
									onclick={() => moveCr(i, 1)}>↓</button
								>
								<button
									type="button"
									class={rowBtn}
									data-testid={`mcd-cr-remove-${i}`}
									aria-label="Remove"
									onclick={() => removeCr(i)}>✕</button
								>
							</li>
						{/each}
					</ol>
				{/if}
			{/if}

			{#if hasSource && !editable}
				<p class="text-xs text-muted-foreground" data-testid="mcd-gate-hint">
					You have view-only access — {mode === 'compare' ? 'Replace' : 'Stage edits'} is
					unavailable.
				</p>
			{:else if hasSource && bufferDirty}
				<p class="text-xs text-muted-foreground" data-testid="mcd-gate-hint">
					Commit or discard your staged edits first.
				</p>
			{/if}

			<div class="max-h-[60vh] overflow-y-auto">
				<ProposalPreview {preview} {conflicts} {error} />
			</div>
		</div>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={() => onOpenChange(false)} disabled={busy}>
				Close
			</Button>
			<Button
				type="button"
				variant="outline"
				data-testid="mcd-preview"
				disabled={busy || !hasSource}
				onclick={() => void onPreview()}
			>
				Preview diff
			</Button>
			{#if mode === 'compare'}
				<Button
					type="button"
					variant="outline"
					data-testid="mcd-create-cr"
					disabled={busy || !hasSource}
					onclick={() => void onCreateCr()}
				>
					Create CR
				</Button>
				<Button
					type="button"
					data-testid="mcd-replace"
					disabled={proceedDisabled}
					title={swapped
						? 'Replace always goes from the loaded model to the file — swap back to enable it'
						: undefined}
					onclick={() => void onProceed()}
				>
					{busy ? 'Working…' : 'Replace'}
				</Button>
			{:else}
				<Button
					type="button"
					data-testid="mcd-stage"
					disabled={proceedDisabled}
					onclick={() => void onProceed()}
				>
					{busy ? 'Working…' : 'Stage edits'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/components/__tests__/ModelChangeDialog.test.ts`
Expected: PASS. If happy-dom does not deliver `File.text()` for the apply-cr path, that is Task 10's concern; compare mode never reads the file client-side.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/ProposalPreview.svelte frontend/src/lib/components/ModelChangeDialog.svelte frontend/src/lib/components/__tests__/ModelChangeDialog.test.ts
git commit -m "feat(frontend): ModelChangeDialog (compare mode) with Preview / Create CR / Replace"
```

---

### Task 10: Apply-CR mode tests

**Files:**
- Test: `frontend/src/lib/components/__tests__/ModelChangeDialog.test.ts` (append)
- Modify (only if a test drives it): `frontend/src/lib/components/ModelChangeDialog.svelte`

**Interfaces:**
- Consumes: Task 9's component and test helpers (`open`, `pickFiles`, `settle`, `byTestId`, `CR_DOC`, `CREATE_OP`).

- [ ] **Step 1: Write the tests**

Append to `ModelChangeDialog.test.ts`:

```ts
const crFile = (name: string, cr = CR_DOC) => {
	const { complete: _c, ...doc } = cr;
	return new File([JSON.stringify(doc)], name, { type: 'application/json' });
};

describe('ModelChangeDialog — apply-cr mode', () => {
	it('lists picked CR files in order, rejects non-CR files, and fires no request', async () => {
		const propose = vi.spyOn(crApi, 'proposeCr');
		open('apply-cr');
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(true);
		pickFiles([
			crFile('one.cr.json'),
			new File(['{"elements":[]}'], 'not-a-cr.json', { type: 'application/json' }),
			crFile('two.cr.json')
		]);
		await settle();
		expect(byTestId('mcd-cr-row-0').textContent).toContain('one.cr.json');
		expect(byTestId('mcd-cr-row-1').textContent).toContain('two.cr.json');
		expect(document.body.querySelector('[data-testid="mcd-cr-row-2"]')).toBeNull();
		expect(byTestId('proposal-error').textContent).toContain('not-a-cr.json');
		expect(propose).not.toHaveBeenCalled();
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(false);
	});

	it('reorder changes the request order; Preview proposes and renders the combined cr', async () => {
		const propose = vi
			.spyOn(crApi, 'proposeCr')
			.mockResolvedValue({ ok: true, modelRev: 3, cr: CR_DOC, ops: [CREATE_OP] });
		const first = { ...CR_DOC, createdAt: 'first' };
		const second = { ...CR_DOC, createdAt: 'second' };
		open('apply-cr');
		pickFiles([crFile('first.cr.json', first), crFile('second.cr.json', second)]);
		await settle();
		byTestId('mcd-cr-down-0').click();
		flushSync();
		expect(byTestId('mcd-cr-row-0').textContent).toContain('second.cr.json');

		byTestId('mcd-preview').click();
		await settle();
		const sent = propose.mock.calls[0][0].map((cr) => cr.createdAt);
		expect(sent).toEqual(['second', 'first']);
		expect(byTestId('proposal-preview').textContent).toContain('+1 added');
	});

	it('remove drops a file', async () => {
		open('apply-cr');
		pickFiles([crFile('a.cr.json'), crFile('b.cr.json')]);
		await settle();
		byTestId('mcd-cr-remove-0').click();
		flushSync();
		expect(byTestId('mcd-cr-row-0').textContent).toContain('b.cr.json');
		expect(document.body.querySelector('[data-testid="mcd-cr-row-1"]')).toBeNull();
	});

	it('a 409 names the conflicting CR by index', async () => {
		vi.spyOn(crApi, 'proposeCr').mockResolvedValue({
			ok: false,
			modelRev: 3,
			crIndex: 1,
			conflicts: [{ kind: 'missing', entity: 'element', id: 'zzz', reason: 'gone' }]
		});
		open('apply-cr');
		pickFiles([crFile('a.cr.json'), crFile('b.cr.json')]);
		await settle();
		byTestId('mcd-stage').click();
		await settle();
		expect(byTestId('proposal-conflicts').textContent).toContain('CR #2 conflicts');
		expect(byTestId('proposal-conflicts').textContent).toContain('element zzz: missing');
	});

	it('Stage edits stages the proposal and closes', async () => {
		vi.spyOn(crApi, 'proposeCr').mockResolvedValue({
			ok: true,
			modelRev: 3,
			cr: CR_DOC,
			ops: [CREATE_OP]
		});
		const stage = vi
			.spyOn(stageProposed, 'stageProposedOps')
			.mockResolvedValue({ ok: true, count: 1 });
		open('apply-cr');
		pickFiles([crFile('a.cr.json')]);
		await settle();
		byTestId('mcd-stage').click();
		await settle();
		expect(stage).toHaveBeenCalledWith([CREATE_OP], 3, {
			elements: [EL('a', 'A'), EL('b', 'B')],
			relationships: []
		});
		expect(document.body.querySelector('[data-testid="mcd-stage"]')).toBeNull();
	});

	it('a stale stage outcome is reported, not swallowed', async () => {
		vi.spyOn(crApi, 'proposeCr').mockResolvedValue({
			ok: true,
			modelRev: 3,
			cr: CR_DOC,
			ops: [CREATE_OP]
		});
		vi.spyOn(stageProposed, 'stageProposedOps').mockResolvedValue({ ok: false, reason: 'stale' });
		open('apply-cr');
		pickFiles([crFile('a.cr.json')]);
		await settle();
		byTestId('mcd-stage').click();
		await settle();
		expect(byTestId('proposal-error').textContent).toMatch(/changed since the proposal/);
		expect(document.body.querySelector('[data-testid="mcd-stage"]')).not.toBeNull();
	});
});
```

- [ ] **Step 2: Run the tests**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/components/__tests__/ModelChangeDialog.test.ts`
Expected: PASS. If `file.text()` is undefined under happy-dom, change `onFilesSelected` to read through `new Response(file).text()` (a `Response` over a Blob is supported by happy-dom's fetch polyfill) and re-run — that is the only permitted component change in this task.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/__tests__/ModelChangeDialog.test.ts frontend/src/lib/components/ModelChangeDialog.svelte
git commit -m "test(frontend): ModelChangeDialog apply-cr mode"
```

---

### Task 11: Wire the top bar; delete the compare page and the old dialog

**Files:**
- Modify: `frontend/src/lib/components/TopBar.svelte`
- Delete: `frontend/src/lib/components/ApplyCrDialog.svelte`, `frontend/src/routes/p/[projectId]/compare/+page.svelte` (and its directory), `frontend/src/lib/state/compare.ts`, `frontend/src/lib/state/__tests__/compare.test.ts`
- Modify: `frontend/src/routes/p/[projectId]/+layout.ts:7` (comment), `frontend/src/lib/state/index.ts` (drop any `./compare` export, if present)
- Test: `frontend/src/lib/components/__tests__/TopBar.test.ts`, `frontend/src/lib/components/__tests__/TopBar.strict.test.ts`

**Interfaces:**
- Produces: Model menu items `History · Compare… · Apply CR… · Export`; top bar `Metamodel · Issues · Artifacts · Model · Settings`.

- [ ] **Step 1: Update the TopBar tests to the new layout**

In `TopBar.test.ts`:
- Delete the line `vi.mock('../ApplyCrDialog.svelte', () => ({ default: () => {} }));` (the real `ModelChangeDialog` mounts fine: it only reads `$lib/state`, which the test already mocks with `...actual`).
- In `'renders … in order'`: title → `'renders Metamodel · Issues · Artifacts · Model · Settings, in order'`, expectation → `['Metamodel', 'Issues', 'Artifacts', 'Model', 'Settings']`, and the leading comment → `// Five left-nav controls in a fixed order, with Compare/Apply CR/Export/History folded into the Model dropdown.`
- In the Model menu block: comment → `// History, Compare, Apply CR and Export live in the Model dropdown…`; `'offers History, Compare and Export, in order'` → expectation `['History', 'Compare…', 'Apply CR…', 'Export']` and title `'offers History, Compare…, Apply CR… and Export, in order'`.
- Replace `'Compare navigates to the compare page'` with:

```ts
		it('Compare… opens the compare dialog', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			openModelMenu();
			menuItem('Compare…')!.click();
			flushSync();

			expect(document.body.textContent).toContain('Compare models');
			expect(goto).not.toHaveBeenCalled();

			unmount(c);
		});

		it('Apply CR… opens the apply-cr dialog', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			openModelMenu();
			menuItem('Apply CR…')!.click();
			flushSync();

			expect(document.body.textContent).toContain('Apply change requests');

			unmount(c);
		});
```

In `TopBar.strict.test.ts`: delete its `vi.mock('../ApplyCrDialog.svelte', …)` line.

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/components/__tests__/TopBar.test.ts src/lib/components/__tests__/TopBar.strict.test.ts`
Expected: FAIL (old layout; `ApplyCrDialog` mock removed while the import still exists).

- [ ] **Step 2: Rewire `TopBar.svelte`**

- Replace `import ApplyCrDialog from './ApplyCrDialog.svelte';` with `import ModelChangeDialog from './ModelChangeDialog.svelte';`.
- Replace `let applyCrOpen = $state(false);` with `let compareOpen = $state(false);` and `let applyCrOpen = $state(false);`.
- Delete the flat Apply CR `<button>` (the three lines between `<ArtifactsMenu />` and `<DropdownMenu.Root>`), and remove `FileInput` from the lucide import.
- Replace the Compare menu item with two items:

```svelte
					<DropdownMenu.Item onSelect={() => (compareOpen = true)}>
						<GitCompareArrows class="h-3.5 w-3.5" /> Compare…
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={() => (applyCrOpen = true)}>
						<FileInput class="h-3.5 w-3.5" /> Apply CR…
					</DropdownMenu.Item>
```

  (keep `FileInput` in the lucide import after all — it is used here). Widen the menu: `class="w-40"` → `class="w-44"`.
- Replace `<ApplyCrDialog bind:open={applyCrOpen} />` with:

```svelte
<ModelChangeDialog mode="compare" bind:open={compareOpen} />
<ModelChangeDialog mode="apply-cr" bind:open={applyCrOpen} />
```

- `goto`/`resolve` stay imported (still used by the Projects navigation at line ~131).

- [ ] **Step 3: Delete the superseded files and fix stragglers**

```bash
git rm -q frontend/src/lib/components/ApplyCrDialog.svelte frontend/src/lib/state/compare.ts frontend/src/lib/state/__tests__/compare.test.ts
git rm -rq "frontend/src/routes/p/[projectId]/compare"
```

In `frontend/src/lib/state/changes.svelte.ts` (~line 10) the header comment says the change set is cleared "after apply-cr" — delete that mention (only load flows clear it now); keep the rest of the sentence intact.

In `frontend/src/routes/p/[projectId]/+layout.ts`, change the comment `// /p/[projectId] subtree (workspace AND /compare) so direct-link / hard-` to `// /p/[projectId] subtree so direct-link / hard-`.

Run `grep -rn "compare'\|ApplyCrDialog\|state/compare\|applyCrSession\|applyCr(" frontend/src` — Expected: no hits except `ModelChangeDialog`'s own `mode === 'compare'` comparisons and the `changeRequest.ts` client.

- [ ] **Step 4: Run the tests, the type check and the whole frontend suite**

Run: `cd frontend && pixi run -e frontend npx vitest run src/lib/components/__tests__/TopBar.test.ts src/lib/components/__tests__/TopBar.strict.test.ts && cd .. && pixi run frontend-check && pixi run frontend-test`
Expected: all PASS, 0 svelte-check errors.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): Compare… and Apply CR… in the Model menu; drop the compare page and ApplyCrDialog"
```

---

### Task 12: Docs, backlog, and full verification

**Files:**
- Modify: `CLAUDE.md`, `frontend/README.md`, `BACKLOG.md`

- [ ] **Step 1: CLAUDE.md**

1. In the `authz.py` bullet, replace "`/model/save` and `/model/apply-cr` are deliberately treated as writes (see comments)." with "`/model/save` and `/model/apply-cr` are deliberately treated as writes, `/model/compare` is read-only (see comments)."
2. In the `routes/ops.py (POST /model/ops)` bullet, append: "`create_element`/`create_relationship` accept an optional **`id` hint** (CR/compare proposals carry the file's real ids): the applier reinstates the entity under it via `Model.restore_*` or 422s the batch when the id is taken, and the journal keeps only the canonical `temp_id`, so replay, undo and the commit diff never see the hint."
3. After the `GET /model/issues` bullet, add a bullet:

   "- **Compare / Apply CR (`routes/change_request.py`)** — two **dry-run** routes that never mutate, journal or validate: `POST /model/compare` (raw other-model body parsed `strict=False`; returns the session→file `datarover.cr/v1` CR plus the file's counts; viewer-allowed, so a viewer can hand an editor a CR) and `POST /model/apply-cr` (`{crs: [...]}` applied **sequentially and transiently** via the pure `apply_change_request`; the first conflicting CR 409s with `{cr_index, conflicts, model_rev}`; the combined base→final CR (`diff_models`) is gated by `_gate_cr_result` and translated by `api/change_request_ops.ops_for_change` into a phase-ordered op batch — creates with `id` hints → updates → relationship deletes/rewires → element deletes — so `delete_element`'s cascade can never over-delete; an element type change is a 422). The client stages the batch through `state/stage-proposed.ts` (the snippet-run precedent) and commits it like manual edits; **Replace** is the compare CR fed straight to apply-cr. Both are rules-blind by design — staging → `POST /commits/preview` is the validation."
4. In the rules section's "Rules-aware call sites" bullet: drop "change-request session apply," from the list, and replace "Two sites stay deliberately **rules-blind** because they validate a caller-supplied candidate model rather than the session's: `change_request.py::_apply_cr_inline` and the validate route's inline branch." with "One site stays deliberately **rules-blind** because it validates a caller-supplied candidate model rather than the session's: the validate route's inline branch (the compare/apply-cr proposals validate nothing at all — staging → `/commits/preview` does)."

- [ ] **Step 2: frontend/README.md**

1. Replace the whole `- **TopBar** — …` paragraph (through "…and the staged-changes counter.") with:

   "- **TopBar** — a toolbar `<nav>` next to the logo holds **five flat icon+text controls**, in this order: **Metamodel** (opens the live metamodel editor tab), **Issues** (opens the singleton Issues tab), **Artifacts** (`ArtifactsMenu.svelte` — Export…/Import…, with Import hidden for viewers), **Model** (a dropdown: History (`HistoryDrawer`) · Compare… · Apply CR… · Export, the last gated on a loaded model) and **Settings** (`SettingsDialog`, where an owner can toggle **strict mode**). Compare… and Apply CR… open `ModelChangeDialog.svelte` in its two modes (see "Compare / Apply CR" below). There is no overflow/three-dots menu. The right side holds the validation chip, **Undo** the last staged edit, **Validate**, **Commit** (opens `DiffDrawer`), the strict-mode badge, and the staged-changes counter."
2. Routes line: `/p/[projectId]` (the workspace) + `/p/[projectId]/compare`.` → `/p/[projectId]` (the workspace).`
3. Delete the "Where to find things" line `p/[projectId]/compare/+page.svelte  Two-model compare screen`; under `lib/components/` add `ModelChangeDialog.svelte   Compare… / Apply CR… (one dialog, two modes)` and `ProposalPreview.svelte     Shared diff / conflicts block of ModelChangeDialog`; under `lib/api/` add `changeRequest.ts   compareModel + proposeCr (dry-run proposals)`; replace the `snippet-stage.ts — folds a snippet run's op batch into the staged-edits buffer (temp-id remap, pre-state prefetch, per-intent lock groups);` fragment with `stage-proposed.ts — folds a server-proposed op batch (snippet run, CR/compare proposal) into the staged-edits buffer (temp-id remap that preserves id hints, prestate seeding or prefetch, per-intent lock groups); snippet-stage.ts — the snippet-run wrapper over it;`.
4. After the "Artifact import/export" section, add:

   "### Compare / Apply CR (`ModelChangeDialog`)

   Both Model-menu items open `components/ModelChangeDialog.svelte` (`mode: 'compare' | 'apply-cr'`), whose lower half is the shared `ProposalPreview.svelte` (a `CompareDiff` over the proposal, a conflicts block, an error line). **Nothing runs on file selection** — every request sits behind a button:

   - **Compare…**: `Choose model…` → From/To + ⇄ Swap → **Preview diff** (`POST /model/compare`, cached per file + `model_rev`; inverted client-side by `invertChangeRequest` when swapped) · **Create CR** (saves the possibly-inverted CR via `saveJsonToFile`/`composeCrFilename`, `complete` stripped) · **Replace** (session → file by definition, so disabled while swapped; posts the compare CR to `POST /model/apply-cr` and stages the result).
   - **Apply CR…**: an ordered list of CR files (multi-select, ↑/↓/✕; each checked for `format === 'datarover.cr/v1'`) → **Preview diff** / **Stage edits**, both `POST /model/apply-cr` with the list in display order; a 409 renders "CR #k conflicts".
   - **Staging** goes through `state/stage-proposed.ts`'s `stageProposedOps(ops, modelRev, prestate)` — the snippet-run primitive generalized: temp-id remap that keeps each create's `id` hint, `crPrestate(cr)` seeded into the caches so a large Replace fetches nothing, per-intent lock groups, then `emit`. From there the edits are ordinary staged edits (DiffDrawer, Ctrl+S, commit).
   - **Gates**: Replace / Stage edits need `canEdit()` AND an empty model staged buffer (`hasStagedOps()` false — the proposal is computed against the committed model); a hint says why. Preview and Create CR are viewer-allowed."

- [ ] **Step 3: BACKLOG.md**

Change the P-23 heading to `### P-23 · Apply CR against the loaded model, staged not committed, multiple CRs · \`done\` (2026-08-25)` and replace its body with:

"Shipped as one feature with Compare's new **Replace** / **Create CR** (either direction): `POST /model/apply-cr` is a dry-run proposal over an ordered `crs` list (sequential, 409 names the failing index), `POST /model/compare` diffs the session against an uploaded model, create ops carry an `id` hint so file ids survive staging, and one `ModelChangeDialog` (Model menu → Compare… / Apply CR…) previews and stages through `stageProposedOps`. The old compare page and file→file apply are gone. Spec: `docs/superpowers/specs/2026-08-25-model-compare-apply-cr-design.md`."

- [ ] **Step 4: Full verification**

Run: `pixi run dr-tidy && pixi run dr-test && pixi run frontend-check`
Expected: format/lint/type clean; core pytest and frontend vitest all PASS; 0 svelte-check errors.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md frontend/README.md BACKLOG.md
git commit -m "docs: compare / apply-cr proposal flow, id hints, P-23 done"
```
