# Compare Models & Change Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user compare the loaded model against another model file (GitHub-style diff), export a Change Request describing the difference in either direction, and apply a Change Request to a model file to produce a new model.

**Architecture:** Diff and CR-generation reuse the existing pure frontend code (`diff.ts`, `cr.ts`) unchanged. CR application is new: a pure backend core function (`core/model/change_request.py`) does strict precondition checks (abort-all on conflict) and is exposed via `POST /api/v1/model/apply-cr`, which then runs the metamodel validation pipeline. A mirrored pure frontend function (`applyCr.ts`) enables unit testing and optimistic checks. UI adds a `/compare` route (A+B mixed diff view) and an Apply-CR dialog.

**Tech Stack:** Python 3 / FastAPI / pytest (backend); SvelteKit 5 + Svelte runes / TypeScript / Tailwind / shadcn-svelte / Vitest + MSW (frontend).

Spec: `docs/superpowers/specs/2026-05-29-compare-models-and-change-requests-design.md`

---

## File Structure

**Backend (new):**
- `src/data_rover/core/model/change_request.py` — pure CR types + `apply_change_request(model, cr)` with strict conflict checks. Raises `CRConflictError`.
- `src/data_rover/api/routes/change_request.py` — `POST /model/apply-cr` route.
- `tests/model/test_apply_change_request.py` — core apply tests.
- `tests/api/test_apply_cr_route.py` — route tests.

**Backend (modify):**
- `src/data_rover/api/schemas.py` — add `ChangeRequestIn` (+ nested ops/baseline mirrors), `ApplyCrRequest`, `ApplyCrResponse`, `CRConflictOut`.
- `src/data_rover/api/main.py` — register the new router.

**Frontend (new):**
- `frontend/src/lib/state/applyCr.ts` — pure `applyChangeRequest(model, cr)` mirror + `Conflict` type.
- `frontend/src/lib/state/compare.ts` — pure `comparePair(...)` direction helper.
- `frontend/src/lib/api/changeRequest.ts` — `applyCr(model, cr)` client.
- `frontend/src/lib/components/CompareEntityCard.svelte` — one A+B entity card.
- `frontend/src/lib/components/CompareDiff.svelte` — header (counts + toggle) + sections.
- `frontend/src/lib/components/ApplyCrDialog.svelte` — load model + CR, call endpoint, handle result.
- `frontend/src/routes/compare/+page.svelte` — Compare screen.
- `frontend/src/lib/state/__tests__/applyCr.test.ts`, `compare.test.ts`, and `frontend/src/lib/api/__tests__/changeRequest.test.ts`.

**Frontend (modify):**
- `frontend/src/lib/components/TopBar.svelte` — add Compare link + Apply-CR button.

**Conventions:** TDD (red → green), backend tests run with `pixi run -e core-dev test-core`, frontend with `cd frontend && npm test`. Commit after each task.

---

## Phase 1 — Backend core: pure CR apply

### Task 1: CR core types

**Files:**
- Create: `src/data_rover/core/model/change_request.py`
- Test: `tests/model/test_apply_change_request.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/model/test_apply_change_request.py
from dataclasses import asdict

import pytest

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.change_request import (
    ChangeRequest,
    CRConflict,
    CRConflictError,
    ModifiedElement,
    ModifiedRelationship,
    apply_change_request,
)
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(name="Block", properties=[PropertyDef(name="name", datatype="string")]),
        ],
        relationships=[
            RelationshipType(name="Link", source="Block", target="Block"),
        ],
    )


def _empty_cr() -> ChangeRequest:
    return ChangeRequest([], [], [], [], [], [])


def test_cr_types_construct():
    cr = _empty_cr()
    assert cr.elements_added == []
    c = CRConflict(kind="missing", entity="element", id="e1", reason="x")
    assert asdict(c)["kind"] == "missing"
    err = CRConflictError([c])
    assert err.conflicts == [c]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev test-core tests/model/test_apply_change_request.py::test_cr_types_construct`
Expected: FAIL with `ModuleNotFoundError: data_rover.core.model.change_request`

- [ ] **Step 3: Write minimal implementation**

```python
# src/data_rover/core/model/change_request.py
from __future__ import annotations

from dataclasses import dataclass, field

from .element import Element
from .model import Model
from .relationship import Relationship


@dataclass
class ModifiedElement:
    id: str
    before: Element
    after: Element


@dataclass
class ModifiedRelationship:
    id: str
    before: Relationship
    after: Relationship


@dataclass
class ChangeRequest:
    elements_added: list[Element] = field(default_factory=list)
    elements_modified: list[ModifiedElement] = field(default_factory=list)
    elements_deleted: list[Element] = field(default_factory=list)
    relationships_added: list[Relationship] = field(default_factory=list)
    relationships_modified: list[ModifiedRelationship] = field(default_factory=list)
    relationships_deleted: list[Relationship] = field(default_factory=list)


@dataclass
class CRConflict:
    kind: str  # "id_exists" | "missing" | "before_mismatch"
    entity: str  # "element" | "relationship"
    id: str
    reason: str


class CRConflictError(Exception):
    def __init__(self, conflicts: list[CRConflict]) -> None:
        self.conflicts = conflicts
        super().__init__(f"{len(conflicts)} change-request conflict(s)")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev test-core tests/model/test_apply_change_request.py::test_cr_types_construct`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/model/change_request.py tests/model/test_apply_change_request.py
git commit -m "feat(core): change-request data types"
```

---

### Task 2: Precondition checks (abort-all on conflict)

**Files:**
- Modify: `src/data_rover/core/model/change_request.py`
- Test: `tests/model/test_apply_change_request.py`

- [ ] **Step 1: Write the failing tests** (append to the test file; reuse `_mm`, `_empty_cr` from Task 1)

```python
def _model_with_block(eid: str = "e1", name: str = "A") -> Model:
    model = Model(_mm())
    model.elements[eid] = Element(id=eid, type_name="Block", properties={"name": name})
    return model


def test_added_id_already_exists_conflicts():
    model = _model_with_block()
    cr = _empty_cr()
    cr.elements_added.append(Element(id="e1", type_name="Block", properties={"name": "B"}))
    with pytest.raises(CRConflictError) as exc:
        apply_change_request(model, cr)
    assert [c.kind for c in exc.value.conflicts] == ["id_exists"]
    assert exc.value.conflicts[0].entity == "element"


def test_modified_missing_id_conflicts():
    model = Model(_mm())
    cr = _empty_cr()
    cr.elements_modified.append(
        ModifiedElement(
            id="e1",
            before=Element(id="e1", type_name="Block", properties={"name": "A"}),
            after=Element(id="e1", type_name="Block", properties={"name": "B"}),
        )
    )
    with pytest.raises(CRConflictError) as exc:
        apply_change_request(model, cr)
    assert exc.value.conflicts[0].kind == "missing"


def test_modified_before_mismatch_conflicts():
    model = _model_with_block(name="DIFFERENT")
    cr = _empty_cr()
    cr.elements_modified.append(
        ModifiedElement(
            id="e1",
            before=Element(id="e1", type_name="Block", properties={"name": "A"}),
            after=Element(id="e1", type_name="Block", properties={"name": "B"}),
        )
    )
    with pytest.raises(CRConflictError) as exc:
        apply_change_request(model, cr)
    assert exc.value.conflicts[0].kind == "before_mismatch"


def test_modified_before_ignores_rev():
    # current rev differs from CR 'before' rev, but content matches -> no conflict
    model = Model(_mm())
    model.elements["e1"] = Element(id="e1", type_name="Block", properties={"name": "A"}, rev=7)
    cr = _empty_cr()
    cr.elements_modified.append(
        ModifiedElement(
            id="e1",
            before=Element(id="e1", type_name="Block", properties={"name": "A"}, rev=0),
            after=Element(id="e1", type_name="Block", properties={"name": "B"}, rev=0),
        )
    )
    result = apply_change_request(model, cr)
    assert result.elements["e1"].properties["name"] == "B"


def test_deleted_missing_id_conflicts():
    model = Model(_mm())
    cr = _empty_cr()
    cr.elements_deleted.append(Element(id="e1", type_name="Block", properties={"name": "A"}))
    with pytest.raises(CRConflictError) as exc:
        apply_change_request(model, cr)
    assert exc.value.conflicts[0].kind == "missing"


def test_relationship_added_id_exists_conflicts():
    model = _model_with_block()
    model.elements["e2"] = Element(id="e2", type_name="Block", properties={"name": "B"})
    model.relationships["r1"] = Relationship(
        id="r1", type_name="Link", source_id="e1", target_id="e2"
    )
    cr = _empty_cr()
    cr.relationships_added.append(
        Relationship(id="r1", type_name="Link", source_id="e1", target_id="e2")
    )
    with pytest.raises(CRConflictError) as exc:
        apply_change_request(model, cr)
    assert exc.value.conflicts[0].entity == "relationship"
    assert exc.value.conflicts[0].kind == "id_exists"


def test_abort_all_reports_every_conflict_and_applies_nothing():
    model = _model_with_block()  # has e1
    cr = _empty_cr()
    cr.elements_added.append(Element(id="e1", type_name="Block", properties={"name": "B"}))  # id_exists
    cr.elements_deleted.append(Element(id="missing", type_name="Block", properties={"name": "Z"}))  # missing
    with pytest.raises(CRConflictError) as exc:
        apply_change_request(model, cr)
    kinds = sorted(c.kind for c in exc.value.conflicts)
    assert kinds == ["id_exists", "missing"]
    # model untouched
    assert set(model.elements) == {"e1"}
    assert model.elements["e1"].properties["name"] == "A"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev test-core tests/model/test_apply_change_request.py -k "conflict or ignores_rev or abort_all"`
Expected: FAIL with `ImportError: cannot import name 'apply_change_request'` (or AttributeError once stub added)

- [ ] **Step 3: Write the check + apply skeleton**

Append to `src/data_rover/core/model/change_request.py`:

```python
def _element_matches(before: Element, current: Element) -> bool:
    return (
        before.type_name == current.type_name
        and before.properties == current.properties
    )


def _relationship_matches(before: Relationship, current: Relationship) -> bool:
    return (
        before.type_name == current.type_name
        and before.source_id == current.source_id
        and before.target_id == current.target_id
        and before.properties == current.properties
    )


def _check(model: Model, cr: ChangeRequest) -> list[CRConflict]:
    conflicts: list[CRConflict] = []

    for e in cr.elements_added:
        if e.id in model.elements:
            conflicts.append(
                CRConflict("id_exists", "element", e.id, f"element {e.id!r} already exists")
            )
    for m in cr.elements_modified:
        cur = model.elements.get(m.id)
        if cur is None:
            conflicts.append(CRConflict("missing", "element", m.id, f"element {m.id!r} not found"))
        elif not _element_matches(m.before, cur):
            conflicts.append(
                CRConflict("before_mismatch", "element", m.id, f"element {m.id!r} differs from CR 'before'")
            )
    for e in cr.elements_deleted:
        cur = model.elements.get(e.id)
        if cur is None:
            conflicts.append(CRConflict("missing", "element", e.id, f"element {e.id!r} not found"))
        elif not _element_matches(e, cur):
            conflicts.append(
                CRConflict("before_mismatch", "element", e.id, f"element {e.id!r} differs from CR 'before'")
            )

    for r in cr.relationships_added:
        if r.id in model.relationships:
            conflicts.append(
                CRConflict("id_exists", "relationship", r.id, f"relationship {r.id!r} already exists")
            )
    for m in cr.relationships_modified:
        cur = model.relationships.get(m.id)
        if cur is None:
            conflicts.append(CRConflict("missing", "relationship", m.id, f"relationship {m.id!r} not found"))
        elif not _relationship_matches(m.before, cur):
            conflicts.append(
                CRConflict("before_mismatch", "relationship", m.id, f"relationship {m.id!r} differs from CR 'before'")
            )
    for r in cr.relationships_deleted:
        cur = model.relationships.get(r.id)
        if cur is None:
            conflicts.append(CRConflict("missing", "relationship", r.id, f"relationship {r.id!r} not found"))
        elif not _relationship_matches(r, cur):
            conflicts.append(
                CRConflict("before_mismatch", "relationship", r.id, f"relationship {r.id!r} differs from CR 'before'")
            )

    return conflicts


def apply_change_request(model: Model, cr: ChangeRequest) -> Model:
    """Apply a change request to a copy of `model`. Pure: `model` is not mutated.

    Strict: if any precondition fails, raises `CRConflictError` with the full
    conflict list and applies nothing. `rev` is ignored when comparing the CR's
    `before` snapshot to the current entity.
    """
    conflicts = _check(model, cr)
    if conflicts:
        raise CRConflictError(conflicts)
    return _materialize(model, cr)
```

(`_materialize` is added in Task 3; the rev-ignore + abort-all tests pass once Task 3 lands. To keep this task green on its own, also add the Task-3 `_materialize` now — see Task 3 Step 3 code — since `apply_change_request` references it.)

- [ ] **Step 4: Run to verify pass** (after `_materialize` from Task 3 is present)

Run: `pixi run -e core-dev test-core tests/model/test_apply_change_request.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/model/change_request.py tests/model/test_apply_change_request.py
git commit -m "feat(core): strict change-request precondition checks"
```

---

### Task 3: Materialize the applied model

**Files:**
- Modify: `src/data_rover/core/model/change_request.py`
- Test: `tests/model/test_apply_change_request.py`

- [ ] **Step 1: Write the failing tests** (append)

```python
def test_clean_apply_add_modify_delete():
    model = _model_with_block(name="A")  # e1
    model.elements["e2"] = Element(id="e2", type_name="Block", properties={"name": "ToDelete"})
    cr = _empty_cr()
    cr.elements_added.append(Element(id="e3", type_name="Block", properties={"name": "New"}))
    cr.elements_modified.append(
        ModifiedElement(
            id="e1",
            before=Element(id="e1", type_name="Block", properties={"name": "A"}),
            after=Element(id="e1", type_name="Block", properties={"name": "A2"}),
        )
    )
    cr.elements_deleted.append(Element(id="e2", type_name="Block", properties={"name": "ToDelete"}))

    result = apply_change_request(model, cr)

    assert set(result.elements) == {"e1", "e3"}
    assert result.elements["e1"].properties["name"] == "A2"
    assert result.elements["e3"].properties["name"] == "New"
    # input untouched
    assert set(model.elements) == {"e1", "e2"}


def test_modify_bumps_rev():
    model = Model(_mm())
    model.elements["e1"] = Element(id="e1", type_name="Block", properties={"name": "A"}, rev=4)
    cr = _empty_cr()
    cr.elements_modified.append(
        ModifiedElement(
            id="e1",
            before=Element(id="e1", type_name="Block", properties={"name": "A"}, rev=4),
            after=Element(id="e1", type_name="Block", properties={"name": "B"}, rev=4),
        )
    )
    result = apply_change_request(model, cr)
    assert result.elements["e1"].rev == 5


def test_relationship_apply_roundtrip():
    model = _model_with_block()  # e1
    model.elements["e2"] = Element(id="e2", type_name="Block", properties={"name": "B"})
    cr = _empty_cr()
    cr.relationships_added.append(
        Relationship(id="r1", type_name="Link", source_id="e1", target_id="e2")
    )
    result = apply_change_request(model, cr)
    assert result.relationships["r1"].source_id == "e1"
```

- [ ] **Step 2: Run to verify it fails** (if `_materialize` not yet written)

Run: `pixi run -e core-dev test-core tests/model/test_apply_change_request.py -k "clean_apply or bumps_rev or roundtrip"`
Expected: FAIL with `NameError: _materialize` (or assertion failure)

- [ ] **Step 3: Write `_materialize`** (append to `change_request.py`)

```python
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


def _materialize(model: Model, cr: ChangeRequest) -> Model:
    elements = {eid: _copy_element(e) for eid, e in model.elements.items()}
    relationships = {rid: _copy_relationship(r) for rid, r in model.relationships.items()}

    for e in cr.elements_added:
        elements[e.id] = _copy_element(e)
    for m in cr.elements_modified:
        cur = elements[m.id]
        elements[m.id] = Element(
            id=m.id,
            type_name=m.after.type_name,
            properties=dict(m.after.properties),
            rev=cur.rev + 1,
        )
    for e in cr.elements_deleted:
        elements.pop(e.id, None)

    for r in cr.relationships_added:
        relationships[r.id] = _copy_relationship(r)
    for m in cr.relationships_modified:
        cur = relationships[m.id]
        relationships[m.id] = Relationship(
            id=m.id,
            type_name=m.after.type_name,
            source_id=m.after.source_id,
            target_id=m.after.target_id,
            properties=dict(m.after.properties),
            rev=cur.rev + 1,
        )
    for r in cr.relationships_deleted:
        relationships.pop(r.id, None)

    result = Model(model.metamodel)
    result.elements = elements
    result.relationships = relationships
    return result
```

> Note: deletes are applied exactly as listed (no cascade) — the CR is the authoritative complete diff, so we do not call `Model.delete_element`. Structural validity (e.g. dangling relationship endpoints) is checked later by the route's validation pipeline.

- [ ] **Step 4: Run full file to verify pass**

Run: `pixi run -e core-dev test-core tests/model/test_apply_change_request.py`
Expected: PASS (all tasks 1-3 tests green)

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/model/change_request.py tests/model/test_apply_change_request.py
git commit -m "feat(core): materialize applied change request (non-mutating)"
```

---

## Phase 2 — Backend API: schema + route

### Task 4: Pydantic CR mirror + apply schemas

**Files:**
- Modify: `src/data_rover/api/schemas.py`
- Test: `tests/api/test_apply_cr_schema.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_apply_cr_schema.py
from data_rover.api.schemas import ChangeRequestIn


def _sample_cr() -> dict:
    return {
        "format": "datarover.cr/v1",
        "createdAt": "2026-05-29T10:00:00.000Z",
        "baseline": {"filename": "m.json", "elementCount": 1, "relationshipCount": 0},
        "ops": {
            "elements": {
                "added": [
                    {"id": "e3", "type_name": "Block", "properties": {"name": "New"}, "rev": 0}
                ],
                "modified": [
                    {
                        "id": "e1",
                        "before": {"id": "e1", "type_name": "Block", "properties": {"name": "A"}, "rev": 0},
                        "after": {"id": "e1", "type_name": "Block", "properties": {"name": "B"}, "rev": 1},
                    }
                ],
                "deleted": [
                    {"id": "e2", "type_name": "Block", "properties": {"name": "Old"}, "rev": 0}
                ],
            },
            "relationships": {"added": [], "modified": [], "deleted": []},
        },
    }


def test_change_request_in_parses_and_to_core():
    cr_in = ChangeRequestIn.model_validate(_sample_cr())
    core = cr_in.to_core()
    assert core.elements_added[0].id == "e3"
    assert core.elements_modified[0].before.properties["name"] == "A"
    assert core.elements_modified[0].after.properties["name"] == "B"
    assert core.elements_deleted[0].id == "e2"
    assert core.relationships_added == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev test-core tests/api/test_apply_cr_schema.py`
Expected: FAIL with `ImportError: cannot import name 'ChangeRequestIn'`

- [ ] **Step 3: Add schemas** (append to `src/data_rover/api/schemas.py`; add `from typing import Literal` and `from pydantic import ConfigDict` to imports, and import the core CR types)

```python
# add near the top imports
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field

from data_rover.core.model.change_request import (
    ChangeRequest as CoreChangeRequest,
    ModifiedElement as CoreModifiedElement,
    ModifiedRelationship as CoreModifiedRelationship,
)
```

```python
# append at the end of schemas.py
class ModifiedElementOut(BaseModel):
    id: str
    before: ElementOut
    after: ElementOut


class ModifiedRelationshipOut(BaseModel):
    id: str
    before: RelationshipOut
    after: RelationshipOut


class CrElementOps(BaseModel):
    added: list[ElementOut] = Field(default_factory=list)
    modified: list[ModifiedElementOut] = Field(default_factory=list)
    deleted: list[ElementOut] = Field(default_factory=list)


class CrRelationshipOps(BaseModel):
    added: list[RelationshipOut] = Field(default_factory=list)
    modified: list[ModifiedRelationshipOut] = Field(default_factory=list)
    deleted: list[RelationshipOut] = Field(default_factory=list)


class CrOps(BaseModel):
    elements: CrElementOps = Field(default_factory=CrElementOps)
    relationships: CrRelationshipOps = Field(default_factory=CrRelationshipOps)


class CrBaseline(BaseModel):
    filename: str | None = None
    elementCount: int = 0
    relationshipCount: int = 0


def _el(e: ElementOut) -> Element:
    return Element(id=e.id, type_name=e.type_name, properties=dict(e.properties), rev=e.rev)


def _rel(r: RelationshipOut) -> Relationship:
    return Relationship(
        id=r.id,
        type_name=r.type_name,
        source_id=r.source_id,
        target_id=r.target_id,
        properties=dict(r.properties),
        rev=r.rev,
    )


class ChangeRequestIn(BaseModel):
    format: Literal["datarover.cr/v1"]
    createdAt: str
    baseline: CrBaseline
    ops: CrOps

    def to_core(self) -> CoreChangeRequest:
        e = self.ops.elements
        r = self.ops.relationships
        return CoreChangeRequest(
            elements_added=[_el(x) for x in e.added],
            elements_modified=[
                CoreModifiedElement(id=m.id, before=_el(m.before), after=_el(m.after))
                for m in e.modified
            ],
            elements_deleted=[_el(x) for x in e.deleted],
            relationships_added=[_rel(x) for x in r.added],
            relationships_modified=[
                CoreModifiedRelationship(id=m.id, before=_rel(m.before), after=_rel(m.after))
                for m in r.modified
            ],
            relationships_deleted=[_rel(x) for x in r.deleted],
        )


class CRConflictOut(BaseModel):
    kind: str
    entity: str
    id: str
    reason: str


class ApplyCrRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    model: InlineModel
    cr: ChangeRequestIn


class ApplyCrResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    model: ModelOut
    issues: list[IssueOut] = Field(default_factory=list)
```

> Note: `Element` and `Relationship` are already imported at the top of `schemas.py`. `ConfigDict(protected_namespaces=())` silences Pydantic's warning about the `model` field name.

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev test-core tests/api/test_apply_cr_schema.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/schemas.py tests/api/test_apply_cr_schema.py
git commit -m "feat(api): pydantic mirror for datarover.cr/v1 + apply schemas"
```

---

### Task 5: `POST /model/apply-cr` route

**Files:**
- Create: `src/data_rover/api/routes/change_request.py`
- Modify: `src/data_rover/api/main.py`
- Test: `tests/api/test_apply_cr_route.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_apply_cr_route.py
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import reset_session

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"


@pytest.fixture
def client() -> TestClient:
    reset_session()
    app = create_app()
    return TestClient(app)


def _load_mm(client: TestClient) -> None:
    res = client.post(
        "/api/v1/metamodel",
        content=EXAMPLE.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text


def _block(eid: str, name: str) -> dict:
    return {"id": eid, "type_name": "Block", "properties": {"name": name}, "rev": 0}


def _cr(ops: dict) -> dict:
    return {
        "format": "datarover.cr/v1",
        "createdAt": "2026-05-29T10:00:00.000Z",
        "baseline": {"filename": "m.json", "elementCount": 1, "relationshipCount": 0},
        "ops": ops,
    }


def test_apply_cr_happy_path(client: TestClient) -> None:
    _load_mm(client)
    payload = {
        "model": {"elements": [_block("e1", "A")], "relationships": []},
        "cr": _cr(
            {
                "elements": {
                    "added": [_block("e2", "New")],
                    "modified": [],
                    "deleted": [],
                },
                "relationships": {"added": [], "modified": [], "deleted": []},
            }
        ),
    }
    res = client.post("/api/v1/model/apply-cr", json=payload)
    assert res.status_code == 200, res.text
    body = res.json()
    ids = {e["id"] for e in body["model"]["elements"]}
    assert ids == {"e1", "e2"}
    assert "issues" in body
    # session model not mutated by apply
    assert client.get("/api/v1/model").status_code == 404


def test_apply_cr_conflict_returns_409(client: TestClient) -> None:
    _load_mm(client)
    payload = {
        "model": {"elements": [_block("e1", "A")], "relationships": []},
        "cr": _cr(
            {
                "elements": {
                    "added": [_block("e1", "dup")],  # id_exists
                    "modified": [],
                    "deleted": [],
                },
                "relationships": {"added": [], "modified": [], "deleted": []},
            }
        ),
    }
    res = client.post("/api/v1/model/apply-cr", json=payload)
    assert res.status_code == 409, res.text
    conflicts = res.json()["conflicts"]
    assert conflicts[0]["kind"] == "id_exists"
    assert conflicts[0]["entity"] == "element"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev test-core tests/api/test_apply_cr_route.py`
Expected: FAIL with 404/405 (route not registered)

- [ ] **Step 3: Write the route + register it**

```python
# src/data_rover/api/routes/change_request.py
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from data_rover.core.model.change_request import CRConflictError, apply_change_request
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

from ..deps import Session, get_session, require_metamodel
from ..schemas import ApplyCrRequest, ApplyCrResponse, IssueOut, ModelOut
from ._snapshot import _build_model_from_payload

router = APIRouter()


@router.post("/model/apply-cr")
def apply_cr(
    payload: ApplyCrRequest,
    session: Session = Depends(get_session),
) -> ApplyCrResponse | JSONResponse:
    metamodel = require_metamodel(session)
    target = _build_model_from_payload(
        metamodel, payload.model.elements, payload.model.relationships
    )
    try:
        result = apply_change_request(target, payload.cr.to_core())
    except CRConflictError as exc:
        return JSONResponse(
            status_code=409,
            content={"conflicts": [asdict(c) for c in exc.conflicts]},
        )
    issues = default_pipeline().validate(result, Scope.all())
    return ApplyCrResponse(
        model=ModelOut.from_core(result),
        issues=[IssueOut.from_core(i) for i in issues],
    )
```

In `src/data_rover/api/main.py`, add `change_request` to the routes import and register it after `model`:

```python
from .routes import (
    change_request,
    elements,
    health,
    metamodel,
    model,
    relationships,
    validation,
    view,
)
```

```python
    app.include_router(model.router, prefix=prefix, tags=["model"])
    app.include_router(change_request.router, prefix=prefix, tags=["change-request"])
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev test-core tests/api/test_apply_cr_route.py`
Expected: PASS

- [ ] **Step 5: Run full backend suite + commit**

Run: `pixi run -e core-dev test-core`
Expected: PASS

```bash
git add src/data_rover/api/routes/change_request.py src/data_rover/api/main.py tests/api/test_apply_cr_route.py
git commit -m "feat(api): POST /model/apply-cr endpoint (strict, non-mutating)"
```

---

## Phase 3 — Frontend pure logic

### Task 6: `applyCr.ts` client-side parity logic

**Files:**
- Create: `frontend/src/lib/state/applyCr.ts`
- Test: `frontend/src/lib/state/__tests__/applyCr.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/state/__tests__/applyCr.test.ts
import { describe, expect, it } from 'vitest';
import type { ModelOut } from '$lib/api/types';
import type { ChangeRequest } from '../cr';
import { applyChangeRequest } from '../applyCr';

function el(id: string, name: string, rev = 0) {
	return { id, type_name: 'Block', properties: { name }, rev };
}

function emptyCr(): ChangeRequest {
	return {
		format: 'datarover.cr/v1',
		createdAt: '2026-05-29T10:00:00.000Z',
		baseline: { filename: 'm.json', elementCount: 0, relationshipCount: 0 },
		ops: {
			elements: { added: [], modified: [], deleted: [] },
			relationships: { added: [], modified: [], deleted: [] }
		}
	};
}

const base = (): ModelOut => ({ elements: [el('e1', 'A')], relationships: [] });

describe('applyChangeRequest', () => {
	it('applies add/modify/delete cleanly', () => {
		const model: ModelOut = {
			elements: [el('e1', 'A'), el('e2', 'Old')],
			relationships: []
		};
		const cr = emptyCr();
		cr.ops.elements.added.push(el('e3', 'New'));
		cr.ops.elements.modified.push({ id: 'e1', before: el('e1', 'A'), after: el('e1', 'A2') });
		cr.ops.elements.deleted.push(el('e2', 'Old'));

		const res = applyChangeRequest(model, cr);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.model.elements.map((e) => e.id).sort()).toEqual(['e1', 'e3']);
		expect(res.model.elements.find((e) => e.id === 'e1')!.properties.name).toBe('A2');
	});

	it('reports id_exists for added', () => {
		const cr = emptyCr();
		cr.ops.elements.added.push(el('e1', 'dup'));
		const res = applyChangeRequest(base(), cr);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.conflicts[0]).toMatchObject({ kind: 'id_exists', entity: 'element', id: 'e1' });
	});

	it('reports missing + before_mismatch and aborts all', () => {
		const cr = emptyCr();
		cr.ops.elements.deleted.push(el('missing', 'Z'));
		cr.ops.elements.modified.push({ id: 'e1', before: el('e1', 'WRONG'), after: el('e1', 'B') });
		const res = applyChangeRequest(base(), cr);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.conflicts.map((c) => c.kind).sort()).toEqual(['before_mismatch', 'missing']);
	});

	it('ignores rev when matching before', () => {
		const model: ModelOut = { elements: [el('e1', 'A', 9)], relationships: [] };
		const cr = emptyCr();
		cr.ops.elements.modified.push({ id: 'e1', before: el('e1', 'A', 0), after: el('e1', 'B', 0) });
		const res = applyChangeRequest(model, cr);
		expect(res.ok).toBe(true);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- applyCr`
Expected: FAIL — cannot resolve `../applyCr`

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/state/applyCr.ts
import type { Element, ModelOut, Relationship } from '$lib/api/types';
import type { ChangeRequest } from './cr';
import { deepEqual } from './diff';

export interface Conflict {
	kind: 'id_exists' | 'missing' | 'before_mismatch';
	entity: 'element' | 'relationship';
	id: string;
	reason: string;
}

export type ApplyResult =
	| { ok: true; model: ModelOut }
	| { ok: false; conflicts: Conflict[] };

function elementMatches(before: Element, current: Element): boolean {
	return before.type_name === current.type_name && deepEqual(before.properties, current.properties);
}

function relationshipMatches(before: Relationship, current: Relationship): boolean {
	return (
		before.type_name === current.type_name &&
		before.source_id === current.source_id &&
		before.target_id === current.target_id &&
		deepEqual(before.properties, current.properties)
	);
}

function indexById<T extends { id: string }>(list: T[]): Map<string, T> {
	const m = new Map<string, T>();
	for (const item of list) m.set(item.id, item);
	return m;
}

function checkConflicts(model: ModelOut, cr: ChangeRequest): Conflict[] {
	const conflicts: Conflict[] = [];
	const els = indexById(model.elements);
	const rels = indexById(model.relationships);

	for (const e of cr.ops.elements.added) {
		if (els.has(e.id))
			conflicts.push({ kind: 'id_exists', entity: 'element', id: e.id, reason: `element ${e.id} already exists` });
	}
	for (const m of cr.ops.elements.modified) {
		const cur = els.get(m.id);
		if (!cur) conflicts.push({ kind: 'missing', entity: 'element', id: m.id, reason: `element ${m.id} not found` });
		else if (!elementMatches(m.before, cur))
			conflicts.push({ kind: 'before_mismatch', entity: 'element', id: m.id, reason: `element ${m.id} differs from CR 'before'` });
	}
	for (const e of cr.ops.elements.deleted) {
		const cur = els.get(e.id);
		if (!cur) conflicts.push({ kind: 'missing', entity: 'element', id: e.id, reason: `element ${e.id} not found` });
		else if (!elementMatches(e, cur))
			conflicts.push({ kind: 'before_mismatch', entity: 'element', id: e.id, reason: `element ${e.id} differs from CR 'before'` });
	}

	for (const r of cr.ops.relationships.added) {
		if (rels.has(r.id))
			conflicts.push({ kind: 'id_exists', entity: 'relationship', id: r.id, reason: `relationship ${r.id} already exists` });
	}
	for (const m of cr.ops.relationships.modified) {
		const cur = rels.get(m.id);
		if (!cur) conflicts.push({ kind: 'missing', entity: 'relationship', id: m.id, reason: `relationship ${m.id} not found` });
		else if (!relationshipMatches(m.before, cur))
			conflicts.push({ kind: 'before_mismatch', entity: 'relationship', id: m.id, reason: `relationship ${m.id} differs from CR 'before'` });
	}
	for (const r of cr.ops.relationships.deleted) {
		const cur = rels.get(r.id);
		if (!cur) conflicts.push({ kind: 'missing', entity: 'relationship', id: r.id, reason: `relationship ${r.id} not found` });
		else if (!relationshipMatches(r, cur))
			conflicts.push({ kind: 'before_mismatch', entity: 'relationship', id: r.id, reason: `relationship ${r.id} differs from CR 'before'` });
	}

	return conflicts;
}

function materialize(model: ModelOut, cr: ChangeRequest): ModelOut {
	const els = indexById(model.elements.map((e) => ({ ...e, properties: { ...e.properties } })));
	const rels = indexById(model.relationships.map((r) => ({ ...r, properties: { ...r.properties } })));

	for (const e of cr.ops.elements.added) els.set(e.id, { ...e, properties: { ...e.properties } });
	for (const m of cr.ops.elements.modified) {
		const cur = els.get(m.id)!;
		els.set(m.id, { ...m.after, properties: { ...m.after.properties }, rev: cur.rev + 1 });
	}
	for (const e of cr.ops.elements.deleted) els.delete(e.id);

	for (const r of cr.ops.relationships.added) rels.set(r.id, { ...r, properties: { ...r.properties } });
	for (const m of cr.ops.relationships.modified) {
		const cur = rels.get(m.id)!;
		rels.set(m.id, { ...m.after, properties: { ...m.after.properties }, rev: cur.rev + 1 });
	}
	for (const r of cr.ops.relationships.deleted) rels.delete(r.id);

	return { elements: [...els.values()], relationships: [...rels.values()] };
}

export function applyChangeRequest(model: ModelOut, cr: ChangeRequest): ApplyResult {
	const conflicts = checkConflicts(model, cr);
	if (conflicts.length > 0) return { ok: false, conflicts };
	return { ok: true, model: materialize(model, cr) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npm test -- applyCr`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/applyCr.ts frontend/src/lib/state/__tests__/applyCr.test.ts
git commit -m "feat(frontend): pure client-side change-request apply with parity checks"
```

---

### Task 7: `compare.ts` direction helper

**Files:**
- Create: `frontend/src/lib/state/compare.ts`
- Test: `frontend/src/lib/state/__tests__/compare.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/state/__tests__/compare.test.ts
import { describe, expect, it } from 'vitest';
import type { ModelOut } from '$lib/api/types';
import { comparePair } from '../compare';

const loaded: ModelOut = { elements: [{ id: 'L', type_name: 'Block', properties: {}, rev: 0 }], relationships: [] };
const other: ModelOut = { elements: [{ id: 'O', type_name: 'Block', properties: {}, rev: 0 }], relationships: [] };

describe('comparePair', () => {
	it('defaults to loaded -> other', () => {
		const p = comparePair(loaded, 'loaded.json', other, 'other.json', false);
		expect(p.from.elements[0].id).toBe('L');
		expect(p.to.elements[0].id).toBe('O');
		expect(p.fromFilename).toBe('loaded.json');
	});

	it('swap flips direction and fromFilename', () => {
		const p = comparePair(loaded, 'loaded.json', other, 'other.json', true);
		expect(p.from.elements[0].id).toBe('O');
		expect(p.to.elements[0].id).toBe('L');
		expect(p.fromFilename).toBe('other.json');
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- compare`
Expected: FAIL — cannot resolve `../compare`

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/state/compare.ts
import type { ModelOut } from '$lib/api/types';

export interface ComparePair {
	from: ModelOut;
	to: ModelOut;
	fromFilename: string | null;
}

/**
 * Resolve which model is the "from" (baseline) side. Default direction is
 * loaded -> other; `swapped` flips it. The returned `fromFilename` is the
 * filename of whichever model ended up on the "from" side (used to name the CR).
 */
export function comparePair(
	loaded: ModelOut,
	loadedFilename: string | null,
	other: ModelOut,
	otherFilename: string | null,
	swapped: boolean
): ComparePair {
	if (!swapped) return { from: loaded, to: other, fromFilename: loadedFilename };
	return { from: other, to: loaded, fromFilename: otherFilename };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npm test -- compare`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/compare.ts frontend/src/lib/state/__tests__/compare.test.ts
git commit -m "feat(frontend): compare-direction helper"
```

---

## Phase 4 — Frontend API client + UI

### Task 8: `applyCr` API client

**Files:**
- Create: `frontend/src/lib/api/changeRequest.ts`
- Test: `frontend/src/lib/api/__tests__/changeRequest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/api/__tests__/changeRequest.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { applyCr } from '../changeRequest';
import type { ChangeRequest } from '$lib/state/cr';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const cr: ChangeRequest = {
	format: 'datarover.cr/v1',
	createdAt: '2026-05-29T10:00:00.000Z',
	baseline: { filename: 'm.json', elementCount: 0, relationshipCount: 0 },
	ops: {
		elements: { added: [], modified: [], deleted: [] },
		relationships: { added: [], modified: [], deleted: [] }
	}
};

describe('applyCr client', () => {
	it('returns model + issues on 200', async () => {
		server.use(
			http.post(`${BASE}/model/apply-cr`, () =>
				HttpResponse.json({
					model: { elements: [{ id: 'e1', type_name: 'Block', properties: {}, rev: 1 }], relationships: [] },
					issues: [{ severity: 'warning', message: 'heads up', target_ids: ['e1'] }]
				})
			)
		);
		const res = await applyCr({ elements: [], relationships: [] }, cr, cfg);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.model.elements[0].id).toBe('e1');
		expect(res.issues[0].message).toBe('heads up');
	});

	it('returns conflicts on 409', async () => {
		server.use(
			http.post(`${BASE}/model/apply-cr`, () =>
				HttpResponse.json(
					{ conflicts: [{ kind: 'id_exists', entity: 'element', id: 'e1', reason: 'dup' }] },
					{ status: 409 }
				)
			)
		);
		const res = await applyCr({ elements: [], relationships: [] }, cr, cfg);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.conflicts[0].kind).toBe('id_exists');
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- changeRequest`
Expected: FAIL — cannot resolve `../changeRequest`

- [ ] **Step 3: Write the client**

```ts
// frontend/src/lib/api/changeRequest.ts
import { apiFetch, type ClientConfig } from './client';
import { ConflictError } from './errors';
import { IssueListSchema, ModelOutSchema, type InlineModel, type Issue, type ModelOut } from './types';
import type { ChangeRequest } from '$lib/state/cr';
import type { Conflict } from '$lib/state/applyCr';

export type ApplyCrResult =
	| { ok: true; model: ModelOut; issues: Issue[] }
	| { ok: false; conflicts: Conflict[] };

/**
 * Apply a Change Request to a model on the backend. The backend uses the active
 * session metamodel and does NOT mutate the session model. Returns conflicts on
 * a 409 instead of throwing.
 */
export async function applyCr(
	model: InlineModel,
	cr: ChangeRequest,
	cfg?: ClientConfig
): Promise<ApplyCrResult> {
	try {
		const res = await apiFetch<{ model: unknown; issues: unknown }>(
			'/model/apply-cr',
			{ method: 'POST', body: { model, cr } },
			cfg
		);
		return {
			ok: true,
			model: ModelOutSchema.parse(res.model),
			issues: IssueListSchema.parse(res.issues)
		};
	} catch (err) {
		if (err instanceof ConflictError) {
			const body = err.body as { conflicts?: Conflict[] } | null;
			return { ok: false, conflicts: body?.conflicts ?? [] };
		}
		throw err;
	}
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npm test -- changeRequest`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api/changeRequest.ts frontend/src/lib/api/__tests__/changeRequest.test.ts
git commit -m "feat(frontend): apply-cr API client"
```

---

### Task 9: `CompareEntityCard.svelte` (A+B card)

**Files:**
- Create: `frontend/src/lib/components/CompareEntityCard.svelte`

- [ ] **Step 1: Write the component**

```svelte
<!-- frontend/src/lib/components/CompareEntityCard.svelte -->
<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import type { EntityDiff } from '$lib/state/diff';

	type Props = { diff: EntityDiff; mode: 'split' | 'unified' };
	let { diff, mode }: Props = $props();

	const badge = $derived(diff.status === 'added' ? '+' : diff.status === 'deleted' ? '-' : '~');
	const badgeClass = $derived(
		diff.status === 'added'
			? 'bg-green-500/20 text-green-300'
			: diff.status === 'deleted'
				? 'bg-red-500/20 text-red-300'
				: 'bg-yellow-500/20 text-yellow-200'
	);

	const before = $derived(diff.before ?? null);
	const after = $derived(diff.after ?? null);
	const entity = $derived((after ?? before) as Element | Relationship);

	function propKeys(b: typeof before, a: typeof after): string[] {
		const keys = new Set<string>();
		if (b) for (const k of Object.keys(b.properties)) keys.add(k);
		if (a) for (const k of Object.keys(a.properties)) keys.add(k);
		return [...keys];
	}
	function changed(key: string): boolean {
		return JSON.stringify(before?.properties?.[key]) !== JSON.stringify(after?.properties?.[key]);
	}
	function fmt(v: unknown): string {
		return v === undefined ? '—' : JSON.stringify(v);
	}
</script>

<div class="border-t border-zinc-700">
	<div class="flex items-center gap-2 px-3 py-2 text-sm">
		<span class={`inline-flex h-5 w-5 items-center justify-center rounded font-mono font-bold ${badgeClass}`}>{badge}</span>
		<span class="font-semibold text-indigo-300">{entity.type_name}</span>
		<span class="font-mono text-xs text-zinc-400">{diff.id}</span>
	</div>

	{#if mode === 'split'}
		<div class="grid grid-cols-2 font-mono text-xs">
			<div class="border-r border-zinc-700 px-3 pb-3">
				<div class="mb-1 text-[10px] uppercase text-zinc-500">Before</div>
				{#if before}
					{#each propKeys(before, after) as key (key)}
						<div class={`rounded px-1.5 py-0.5 ${changed(key) ? 'bg-red-500/15 text-red-300' : 'text-zinc-400'}`}>
							{key}: {fmt(before.properties[key])}
						</div>
					{/each}
				{:else}
					<div class="italic text-zinc-600">— not present —</div>
				{/if}
			</div>
			<div class="px-3 pb-3">
				<div class="mb-1 text-[10px] uppercase text-zinc-500">After</div>
				{#if after}
					{#each propKeys(before, after) as key (key)}
						<div class={`rounded px-1.5 py-0.5 ${changed(key) ? 'bg-green-500/15 text-green-300' : 'text-zinc-400'}`}>
							{key}: {fmt(after.properties[key])}
						</div>
					{/each}
				{:else}
					<div class="italic text-zinc-600">— removed —</div>
				{/if}
			</div>
		</div>
	{:else}
		<div class="px-3 pb-3 font-mono text-xs">
			{#each propKeys(before, after) as key (key)}
				{#if changed(key)}
					{#if before}<div class="rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">- {key}: {fmt(before.properties[key])}</div>{/if}
					{#if after}<div class="rounded bg-green-500/15 px-1.5 py-0.5 text-green-300">+ {key}: {fmt(after.properties[key])}</div>{/if}
				{:else}
					<div class="px-1.5 py-0.5 text-zinc-400">{key}: {fmt((after ?? before)?.properties[key])}</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
```

- [ ] **Step 2: Verify it builds**

Run: `cd frontend && npm run build`
Expected: build succeeds (no type errors)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/CompareEntityCard.svelte
git commit -m "feat(frontend): A+B compare entity card"
```

---

### Task 10: `CompareDiff.svelte` (header + sections)

**Files:**
- Create: `frontend/src/lib/components/CompareDiff.svelte`

- [ ] **Step 1: Write the component**

```svelte
<!-- frontend/src/lib/components/CompareDiff.svelte -->
<script lang="ts">
	import type { Diff } from '$lib/state/diff';
	import CompareEntityCard from './CompareEntityCard.svelte';

	type Props = { diff: Diff; unchangedHidden: number };
	let { diff, unchangedHidden }: Props = $props();

	let mode: 'split' | 'unified' = $state('split');
</script>

<div>
	<div class="flex items-center gap-3 rounded-t-lg border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-xs">
		<span class="text-green-300">+{diff.counts.added} added</span>
		<span class="text-yellow-200">~{diff.counts.modified} modified</span>
		<span class="text-red-300">−{diff.counts.deleted} deleted</span>
		<span class="text-zinc-500">{unchangedHidden} unchanged hidden</span>
		<div class="ml-auto flex overflow-hidden rounded border border-zinc-700">
			<button
				class={`px-3 py-1 ${mode === 'split' ? 'bg-indigo-500 text-white' : 'text-zinc-300'}`}
				onclick={() => (mode = 'split')}
			>Split</button>
			<button
				class={`px-3 py-1 ${mode === 'unified' ? 'bg-indigo-500 text-white' : 'text-zinc-300'}`}
				onclick={() => (mode = 'unified')}
			>Unified</button>
		</div>
	</div>

	<div class="rounded-b-lg border border-t-0 border-zinc-700">
		{#if diff.elements.length > 0}
			<div class="px-3 pt-2 text-[11px] uppercase tracking-wide text-zinc-500">Elements</div>
			{#each diff.elements as d (d.id)}
				<CompareEntityCard diff={d} {mode} />
			{/each}
		{/if}
		{#if diff.relationships.length > 0}
			<div class="px-3 pt-2 text-[11px] uppercase tracking-wide text-zinc-500">Relationships</div>
			{#each diff.relationships as d (d.id)}
				<CompareEntityCard diff={d} {mode} />
			{/each}
		{/if}
		{#if diff.elements.length === 0 && diff.relationships.length === 0}
			<div class="px-3 py-6 text-center text-sm text-zinc-500">No differences.</div>
		{/if}
	</div>
</div>
```

- [ ] **Step 2: Verify it builds**

Run: `cd frontend && npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/CompareDiff.svelte
git commit -m "feat(frontend): compare diff header + sections"
```

---

### Task 11: Compare screen `/compare`

**Files:**
- Create: `frontend/src/routes/compare/+page.svelte`

- [ ] **Step 1: Write the screen**

```svelte
<!-- frontend/src/routes/compare/+page.svelte -->
<script lang="ts">
	import type { ModelOut } from '$lib/api/types';
	import { getBaseline, getFilename } from '$lib/state';
	import { computeDiff } from '$lib/state/diff';
	import { comparePair } from '$lib/state/compare';
	import { buildChangeRequest, composeCrFilename } from '$lib/state/cr';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { Button } from '$lib/components/ui/button';
	import CompareDiff from '$lib/components/CompareDiff.svelte';

	const loaded = $derived(getBaseline());
	const loadedFilename = $derived(getFilename());

	let other: ModelOut | null = $state(null);
	let otherFilename: string | null = $state(null);
	let swapped = $state(false);
	let fileInputRef: HTMLInputElement | null = $state(null);
	let errorMessage: string | null = $state(null);

	const pair = $derived(
		loaded && other ? comparePair(loaded, loadedFilename, other, otherFilename, swapped) : null
	);
	const diff = $derived(pair ? computeDiff(pair.from, pair.to) : null);
	const totalEntities = $derived(
		pair ? pair.to.elements.length + pair.to.relationships.length : 0
	);
	const unchangedHidden = $derived(
		diff ? Math.max(0, totalEntities - (diff.counts.added + diff.counts.modified)) : 0
	);

	async function onFileSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		try {
			const parsed = JSON.parse(await file.text());
			other = { elements: parsed.elements ?? [], relationships: parsed.relationships ?? [] };
			otherFilename = file.name;
			errorMessage = null;
		} catch (err) {
			other = null;
			errorMessage = err instanceof Error ? err.message : 'Invalid JSON';
		}
	}

	async function exportCr(): Promise<void> {
		if (!pair) return;
		const cr = buildChangeRequest(pair.from, pair.to, pair.fromFilename);
		await saveJsonToFile(cr, composeCrFilename(pair.fromFilename));
	}
</script>

<div class="mx-auto flex max-w-4xl flex-col gap-4 p-6">
	<h1 class="text-lg font-semibold">Compare models</h1>

	{#if !loaded}
		<p class="text-sm text-zinc-400">Load a model first, then return here to compare.</p>
	{:else}
		<div class="flex items-center gap-2 text-sm">
			<span class="text-zinc-400">Loaded:</span>
			<span class="font-mono text-xs">{loadedFilename ?? 'model'}</span>
			<Button type="button" variant="outline" size="sm" onclick={() => fileInputRef?.click()}>
				Choose other model…
			</Button>
			<span class="font-mono text-xs text-zinc-400">{otherFilename ?? 'No file selected'}</span>
			<input bind:this={fileInputRef} type="file" accept=".json" class="hidden" onchange={onFileSelected} />
			{#if other}
				<Button type="button" variant="ghost" size="sm" onclick={() => (swapped = !swapped)}>⇄ Swap</Button>
			{/if}
		</div>

		{#if errorMessage}<p class="text-xs text-red-400">{errorMessage}</p>{/if}

		{#if pair && diff}
			<div class="flex items-center gap-2 text-xs text-zinc-400">
				<span>From: <span class="font-mono">{swapped ? otherFilename : (loadedFilename ?? 'model')}</span></span>
				<span>→ To: <span class="font-mono">{swapped ? (loadedFilename ?? 'model') : otherFilename}</span></span>
				<Button class="ml-auto" type="button" size="sm" onclick={exportCr}>Export CR</Button>
			</div>
			<CompareDiff {diff} {unchangedHidden} />
		{/if}
	{/if}
</div>
```

- [ ] **Step 2: Verify it builds**

Run: `cd frontend && npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/routes/compare/+page.svelte
git commit -m "feat(frontend): /compare screen with diff view + export CR"
```

---

### Task 12: `ApplyCrDialog.svelte`

**Files:**
- Create: `frontend/src/lib/components/ApplyCrDialog.svelte`

- [ ] **Step 1: Write the dialog**

```svelte
<!-- frontend/src/lib/components/ApplyCrDialog.svelte -->
<script lang="ts">
	import { applyCr, type ApplyCrResult } from '$lib/api/changeRequest';
	import type { ChangeRequest } from '$lib/state/cr';
	import type { InlineModel } from '$lib/api/types';
	import { composeCrFilename } from '$lib/state/cr';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	let { open = $bindable(false) }: { open: boolean } = $props();

	let model: InlineModel | null = $state(null);
	let modelFilename: string | null = $state(null);
	let cr: ChangeRequest | null = $state(null);
	let result: ApplyCrResult | null = $state(null);
	let errorMessage: string | null = $state(null);
	let busy = $state(false);
	let modelInputRef: HTMLInputElement | null = $state(null);
	let crInputRef: HTMLInputElement | null = $state(null);

	async function readJson(event: Event): Promise<unknown | null> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return null;
		modelFilename = modelFilename; // no-op to keep reactivity clear
		try {
			return { name: file.name, data: JSON.parse(await file.text()) };
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Invalid JSON';
			return null;
		}
	}

	async function onModelSelected(event: Event): Promise<void> {
		const r = (await readJson(event)) as { name: string; data: { elements?: []; relationships?: [] } } | null;
		if (!r) return;
		model = { elements: r.data.elements ?? [], relationships: r.data.relationships ?? [] };
		modelFilename = r.name;
		errorMessage = null;
	}

	async function onCrSelected(event: Event): Promise<void> {
		const r = (await readJson(event)) as { name: string; data: ChangeRequest } | null;
		if (!r) return;
		cr = r.data;
		errorMessage = null;
	}

	async function onApply(): Promise<void> {
		if (!model || !cr) {
			errorMessage = 'Choose both a model file and a CR file';
			return;
		}
		busy = true;
		result = null;
		try {
			result = await applyCr(model, cr);
			if (result.ok) {
				await saveJsonToFile(result.model, modelFilename ?? 'model.json');
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Apply failed';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Apply change request</Dialog.Title>
			<Dialog.Description>Pick a model and a CR. The result is saved as a new model file.</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3 text-sm">
			<div class="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" onclick={() => modelInputRef?.click()}>Model file…</Button>
				<span class="font-mono text-xs text-zinc-400">{modelFilename ?? 'none'}</span>
				<input bind:this={modelInputRef} type="file" accept=".json" class="hidden" onchange={onModelSelected} />
			</div>
			<div class="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" onclick={() => crInputRef?.click()}>CR file…</Button>
				<span class="font-mono text-xs text-zinc-400">{cr ? 'loaded' : 'none'}</span>
				<input bind:this={crInputRef} type="file" accept=".json" class="hidden" onchange={onCrSelected} />
			</div>

			{#if errorMessage}<p class="text-xs text-red-400">{errorMessage}</p>{/if}

			{#if result && !result.ok}
				<div class="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs">
					<div class="mb-1 font-semibold text-red-300">{result.conflicts.length} conflict(s) — nothing applied</div>
					{#each result.conflicts as c}
						<div class="font-mono text-red-200">{c.entity} {c.id}: {c.kind} — {c.reason}</div>
					{/each}
				</div>
			{/if}
			{#if result && result.ok}
				<div class="rounded border border-green-500/40 bg-green-500/10 p-2 text-xs text-green-200">
					Applied. Saved new model.{result.issues.length ? ` ${result.issues.length} validation issue(s).` : ''}
				</div>
				{#each result.issues as i}
					<div class="font-mono text-xs text-yellow-300">{i.severity}: {i.message}</div>
				{/each}
			{/if}
		</div>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={() => (open = false)} disabled={busy}>Close</Button>
			<Button type="button" onclick={onApply} disabled={busy || !model || !cr}>
				{busy ? 'Applying…' : 'Apply'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
```

- [ ] **Step 2: Verify it builds**

Run: `cd frontend && npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/ApplyCrDialog.svelte
git commit -m "feat(frontend): apply-CR dialog"
```

---

### Task 13: Wire entry points into TopBar

**Files:**
- Modify: `frontend/src/lib/components/TopBar.svelte`

- [ ] **Step 1: Read the file and add entry points**

Open `frontend/src/lib/components/TopBar.svelte`. In the `<script>`, add the dialog state and import:

```ts
	import ApplyCrDialog from '$lib/components/ApplyCrDialog.svelte';
	let applyCrOpen = $state(false);
```

In the toolbar markup (next to the existing Save/Load buttons), add:

```svelte
<a href="/compare" class="rounded px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-700">Compare</a>
<button type="button" class="rounded px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-700" onclick={() => (applyCrOpen = true)}>Apply CR</button>
```

At the end of the markup (sibling of the root toolbar element), add:

```svelte
<ApplyCrDialog bind:open={applyCrOpen} />
```

> Match the existing button styling in TopBar.svelte rather than the literal classes above if they differ; the goal is a "Compare" navigation link and an "Apply CR" trigger consistent with the current toolbar.

- [ ] **Step 2: Verify it builds**

Run: `cd frontend && npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/TopBar.svelte
git commit -m "feat(frontend): toolbar entry points for compare & apply-CR"
```

---

## Phase 5 — Integration verification

### Task 14: Full suites + manual smoke

- [ ] **Step 1: Backend suite green**

Run: `pixi run -e core-dev test-core`
Expected: PASS

- [ ] **Step 2: Frontend suite + build green**

Run: `cd frontend && npm test && npm run build`
Expected: PASS

- [ ] **Step 3: Manual smoke (real app)**

1. Start backend: `pixi run -e api start-backend`.
2. Start frontend: `pixi run -e frontend start-frontend --metamodel examples/smart-city.metamodel.yaml --model examples/smart-city.model.json --view examples/smart-city.view.json`.
3. Make an edited copy of `examples/smart-city.model.json` (change one property, add one element, delete one).
4. Go to `/compare`, choose the edited copy. Confirm: counts header, only changed entities shown, "N unchanged hidden", Split/Unified toggle, Swap flips direction.
5. Click **Export CR**; open the saved `*.cr.json` and confirm `format: "datarover.cr/v1"` and the expected ops.
6. Toolbar → **Apply CR**: pick the *original* model + the CR just exported → confirm a new model file is saved equal to the edited copy.
7. Apply the same CR a second time to the already-applied model → confirm a 409 conflict list is shown and no file is written.

- [ ] **Step 4: Commit any smoke-fix changes**

```bash
git add -A
git commit -m "test: integration verification for compare & change-request flows"
```

### Task 15 (optional): Playwright happy path

**Files:**
- Create: `frontend/e2e/compare.spec.ts`

- [ ] Add an e2e test that loads a model, opens `/compare`, selects a second file fixture, asserts the diff counts render, exports a CR, and applies it. Run: `cd frontend && npm run test:e2e -- compare`.

---

## Self-Review (completed by author)

**Spec coverage:**
- Compare via loaded + other file → Tasks 7, 11. ✓
- A+B mixed diff, hide unchanged, split/unified → Tasks 9, 10, 11 (`unchangedHidden`, `mode`). ✓
- Generate CR either direction → Task 11 `exportCr` + `comparePair` swap, reusing `buildChangeRequest`. ✓
- Apply CR → new file, strict abort-on-conflict, backend metamodel validation, non-mutating → Tasks 1-5, 12. ✓
- Frontend parity apply for tests → Task 6. ✓
- Entry points (compare screen + separate apply action) → Tasks 11, 12, 13. ✓
- Metamodel issues non-blocking warnings → Task 5 returns `issues`; Task 12 surfaces them. ✓

**Type consistency:** `ChangeRequest` (TS, from `cr.ts`) and `ChangeRequestIn` (Py) both keyed on `format`/`ops`/`baseline`; `Conflict`/`CRConflict` fields (`kind`,`entity`,`id`,`reason`) match across `applyCr.ts`, core, and `CRConflictOut`. `applyChangeRequest` (returns `ApplyResult`) vs `applyCr` (client, returns `ApplyCrResult`) are intentionally distinct names. `saveJsonToFile`, `buildChangeRequest`, `composeCrFilename`, `computeDiff`, `getBaseline`, `getFilename` confirmed against current source.

**Open items to confirm while coding:**
- `RelationshipType(name, source, target)` minimal construction is valid in the test metamodel (used in Task 1/2 fixtures) — adjust required fields if the schema demands more.
- TopBar button styling (Task 13) — match existing toolbar classes.
