# Phase 6B — Metamodel Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only sandbox conformance diff and a non-destructive journaled metamodel rebind, superseding the destructive `POST /metamodel`.

**Architecture:** A core no-copy `Model` view validates the live model against a candidate metamodel (diff). A new owner-only route rebinds the model's metamodel as a normal commit (dedicated `from/to_metamodel_id` commit columns; hydration is unchanged because it reads the metamodel from `ModelRow`). The existing `POST /metamodel` becomes initial-bind-only.

**Tech Stack:** Python 3.14 (pyright floor 3.10), FastAPI, SQLAlchemy 2.0, Alembic, pytest. Everything runs through `pixi`.

## Global Constraints

- No global `python`/`node` — every command goes through `pixi run` (core tests: `pixi run -e core-dev pytest ...`; API tests need NO database service — `tests/api/conftest.py` runs in-memory SQLite).
- Python 3.14 runtime, pyright floor 3.10: import `Self`/`assert_never` from `typing_extensions`, not `typing`. Do not use stdlib newer than 3.10.
- All three of `ruff --fix`, `mypy`, `pyright` must pass (`pixi run tidy` / `pixi run lint-core` / `lint-backend`).
- `Model` is the mutation boundary; `Metamodel` is immutable/frozen. Never re-walk `extends` by hand — use metamodel cache methods.
- Validators read `model.metamodel`; construct one pipeline per request/thread (per-metamodel memo caches).
- API data tests use `client` fixture + `seed_default_project`/`AUTH_HEADERS`/`papi` from `tests/api/conftest.py`; every project-scoped request needs an identity header and a seeded project.
- Issue-key (diff identity) = `(category, severity, message, tuple(sorted(target_ids)))`, defined once in Task 5 and reused.
- Commit messages end with the Co-Authored-By trailer per repo policy. Branch off `main`; the spec/plan dirs are gitignored (local only).

---

## Task 1: Core no-copy rebind view

**Files:**
- Modify: `src/data_rover/core/model/model.py` (add module-level `build_rebind_view` after the `Model` class)
- Test: `tests/model/test_rebind_view.py`

**Interfaces:**
- Consumes: `Model(metamodel)` ctor, `IndexSet` (already imported in `model.py`), `Metamodel` (already imported).
- Produces: `build_rebind_view(live_model: Model, candidate: Metamodel) -> Model` — a read-only `Model` aliasing `live_model.elements`/`.relationships` with a fresh `IndexSet` rebuilt against `candidate`.

- [ ] **Step 1: Write the failing test**

```python
# tests/model/test_rebind_view.py
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model, build_rebind_view

_MM_A = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""
# Candidate where Contains is NOT containment.
_MM_B = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: false
    source: Node
    target: Node
"""


def _model_with_contains() -> Model:
    m = Model(load_metamodel_str(_MM_A))
    a = m.create_element("Node")
    b = m.create_element("Node")
    m.connect("Contains", a.id, b.id)
    return m, a.id, b.id


def test_view_shares_payload_by_reference() -> None:
    m, _a, _b = _model_with_contains()
    view = build_rebind_view(m, load_metamodel_str(_MM_B))
    assert view.elements is m.elements
    assert view.relationships is m.relationships
    assert view.metamodel is not m.metamodel


def test_view_rebuilds_index_against_candidate() -> None:
    # Under MM_A, b has a containment parent a; under MM_B (Contains not
    # containment) the view's index must report NO containment parent.
    m, a_id, b_id = _model_with_contains()
    assert list(m.indexes.parents_of(b_id)) == [a_id]  # live index unchanged
    view = build_rebind_view(m, load_metamodel_str(_MM_B))
    assert list(view.indexes.parents_of(b_id)) == []
    assert view.indexes is not m.indexes


def test_view_does_not_mutate_live_index() -> None:
    m, a_id, b_id = _model_with_contains()
    build_rebind_view(m, load_metamodel_str(_MM_B))
    assert list(m.indexes.parents_of(b_id)) == [a_id]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/model/test_rebind_view.py -v`
Expected: FAIL with `ImportError: cannot import name 'build_rebind_view'`

- [ ] **Step 3: Write minimal implementation**

Append to `src/data_rover/core/model/model.py` (after the `Model` class; uses the file's existing `Metamodel` and `IndexSet` imports):

```python
def build_rebind_view(live_model: Model, candidate: Metamodel) -> Model:
    """A READ-ONLY ``Model`` bound to ``candidate`` over ``live_model``'s data.

    Shares ``elements``/``relationships`` BY REFERENCE — the (potentially
    ~80 MB) instance payload is never copied — and rebuilds a fresh
    ``IndexSet`` against ``candidate``. The index is rebuilt, never shared,
    because containment classification and uniqueness grouping are
    metamodel-derived: sharing the live index would give wrong containment /
    uniqueness results under a candidate that changes them.

    The returned view ALIASES the live model's dicts, so mutating it would
    corrupt the live model. Use it only for read-only validation (the sandbox
    metamodel diff).
    """
    view = Model(candidate)
    view.elements = live_model.elements
    view.relationships = live_model.relationships
    view.indexes = IndexSet(view)
    view.indexes.rebuild()
    return view
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/model/test_rebind_view.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/model/model.py tests/model/test_rebind_view.py
git commit -m "feat(core): add build_rebind_view for no-copy metamodel diff"
```

---

## Task 2: Unknown-type CONFORMANCE check

**Files:**
- Modify: `src/data_rover/core/validation/validators/type_conformance.py` (guards in `validate_element`/`validate_relationship`)
- Test: `tests/validation/test_unknown_type.py`

**Interfaces:**
- Consumes: `model.metamodel.element_type(name) -> ElementType | None`, `relationship_type(name) -> RelationshipType | None`; `Issue`, `Severity`, `IssueCategory` (already imported in the file).
- Produces: an `IssueCategory.CONFORMANCE` issue per entity whose type the metamodel does not define.

- [ ] **Step 1: Write the failing test**

```python
# tests/validation/test_unknown_type.py
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model, build_rebind_view
from data_rover.core.validation.issue import IssueCategory
from data_rover.core.validation.pipeline import default_pipeline

_MM_WITH = """
elements:
  - name: Node
  - name: Gadget
relationships:
  - name: Link
    source: Node
    target: Node
"""
_MM_WITHOUT = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""


def test_unknown_element_type_is_conformance() -> None:
    m = Model(load_metamodel_str(_MM_WITH))
    g = m.create_element("Gadget")
    view = build_rebind_view(m, load_metamodel_str(_MM_WITHOUT))
    issues = default_pipeline().validate(view)
    unknown = [i for i in issues if g.id in i.target_ids and "unknown type" in i.message]
    assert len(unknown) == 1
    assert unknown[0].category is IssueCategory.CONFORMANCE


def test_known_type_emits_no_unknown_issue() -> None:
    m = Model(load_metamodel_str(_MM_WITH))
    n = m.create_element("Node")
    issues = default_pipeline().validate(m)
    assert not any("unknown type" in i.message for i in issues if n.id in i.target_ids)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/validation/test_unknown_type.py -v`
Expected: FAIL on `test_unknown_element_type_is_conformance` (`len(unknown) == 0`)

- [ ] **Step 3: Write minimal implementation**

In `src/data_rover/core/validation/validators/type_conformance.py`, replace the two hook methods:

```python
    def validate_element(self, model, el) -> list[Issue]:
        if model.metamodel.element_type(el.type_name) is None:
            return [
                Issue(
                    Severity.ERROR,
                    f"{el.id} is an instance of unknown type {el.type_name!r}",
                    [el.id],
                    IssueCategory.CONFORMANCE,
                )
            ]
        defs = self._defs(model.metamodel, el.type_name, of_element=True)
        return self._check(el.type_name, el.id, defs, el.properties, model)

    def validate_relationship(self, model, rel) -> list[Issue]:
        if model.metamodel.relationship_type(rel.type_name) is None:
            return [
                Issue(
                    Severity.ERROR,
                    f"{rel.id} is an instance of unknown type {rel.type_name!r}",
                    [rel.id],
                    IssueCategory.CONFORMANCE,
                )
            ]
        defs = self._defs(model.metamodel, rel.type_name, of_element=False)
        return self._check(rel.type_name, rel.id, defs, rel.properties, model)
```

- [ ] **Step 4: Run tests to verify they pass (and nothing regressed)**

Run: `pixi run -e core-dev pytest tests/validation/test_unknown_type.py tests/validation -v`
Expected: PASS (new tests pass; existing validation suite still green)

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/validation/validators/type_conformance.py tests/validation/test_unknown_type.py
git commit -m "feat(validation): flag instance-of-unknown-type as a CONFORMANCE issue"
```

---

## Task 3: Commit `from/to_metamodel_id` columns + Alembic 0004

**Files:**
- Modify: `src/data_rover/api/db_models.py` (`Commit`: two nullable columns)
- Modify: `src/data_rover/api/content.py` (`append_commit`: two optional kwargs)
- Create: `alembic/versions/0004_commit_metamodel_rebind.py`
- Test: `tests/api/test_commit_metamodel_columns.py`

**Interfaces:**
- Consumes: `content.append_commit(...)` existing signature.
- Produces: `Commit.from_metamodel_id: str | None`, `Commit.to_metamodel_id: str | None`; `append_commit(..., from_metamodel_id=None, to_metamodel_id=None)`.

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_commit_metamodel_columns.py
from data_rover.api import content, db
from data_rover.api.db_models import Commit, MetamodelRow, Project


def test_append_commit_records_rebind_metamodel_ids() -> None:
    db.init_engine("sqlite://")
    db.create_all()
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(Project(id="p1", name="P1"))
        old = content.create_metamodel(s, name="", version=1, blob="elements: []")
        new = content.create_metamodel(s, name="", version=2, blob="elements: []")
        content.upsert_model_row(s, "p1", metamodel_id=new.id)
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[], inverse_ops=[], id_map={},
            from_metamodel_id=old.id, to_metamodel_id=new.id,
        )
        s.commit()
        row = s.get(Commit, ("p1", 1))
        assert row.from_metamodel_id == old.id
        assert row.to_metamodel_id == new.id
    finally:
        gen.close()
        db.drop_all()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commit_metamodel_columns.py -v`
Expected: FAIL with `TypeError: append_commit() got an unexpected keyword argument 'from_metamodel_id'`

- [ ] **Step 3a: Add the ORM columns**

In `src/data_rover/api/db_models.py`, inside `class Commit`, after the `issues` column add:

```python
    #: metamodel rebind (Phase 6B): the model's metamodel_id before/after this
    #: commit. Both NULL for ordinary edit commits; set only by /metamodel/rebind.
    #: SET NULL on metamodel delete so history survives a retired metamodel.
    from_metamodel_id: Mapped[str | None] = mapped_column(
        ForeignKey("metamodels.id", ondelete="SET NULL"), nullable=True
    )
    to_metamodel_id: Mapped[str | None] = mapped_column(
        ForeignKey("metamodels.id", ondelete="SET NULL"), nullable=True
    )
```

- [ ] **Step 3b: Extend `append_commit`**

In `src/data_rover/api/content.py`, update `append_commit`'s signature and body:

```python
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
    message: str = "",
    validation_error_count: int = 0,
    issues: list[Any] | None = None,
    from_metamodel_id: str | None = None,
    to_metamodel_id: str | None = None,
) -> Commit:
    row = Commit(
        project_id=project_id,
        rev=rev,
        commit_id=commit_id,
        author_id=author_id,
        ops=ops,
        inverse_ops=inverse_ops,
        id_map=id_map,
        message=message,
        validation_error_count=validation_error_count,
        issues=issues or [],
        from_metamodel_id=from_metamodel_id,
        to_metamodel_id=to_metamodel_id,
    )
    db.add(row)
    db.flush()
    return row
```

- [ ] **Step 3c: Write the Alembic migration**

Create `alembic/versions/0004_commit_metamodel_rebind.py`:

```python
"""commit metamodel rebind columns: from_metamodel_id, to_metamodel_id

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("commits") as batch:
        batch.add_column(sa.Column("from_metamodel_id", sa.String(), nullable=True))
        batch.add_column(sa.Column("to_metamodel_id", sa.String(), nullable=True))
        batch.create_foreign_key(
            "fk_commits_from_metamodel_id", "metamodels",
            ["from_metamodel_id"], ["id"], ondelete="SET NULL",
        )
        batch.create_foreign_key(
            "fk_commits_to_metamodel_id", "metamodels",
            ["to_metamodel_id"], ["id"], ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("commits") as batch:
        batch.drop_constraint("fk_commits_to_metamodel_id", type_="foreignkey")
        batch.drop_constraint("fk_commits_from_metamodel_id", type_="foreignkey")
        batch.drop_column("to_metamodel_id")
        batch.drop_column("from_metamodel_id")
```

(`batch_alter_table` is used so the FK add works on SQLite as well as Postgres.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_commit_metamodel_columns.py tests/api/test_db_models.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/db_models.py src/data_rover/api/content.py alembic/versions/0004_commit_metamodel_rebind.py tests/api/test_commit_metamodel_columns.py
git commit -m "feat(db): commits from/to_metamodel_id columns + Alembic 0004"
```

---

## Task 4: Response schemas + `rebind_event` feed builder

**Files:**
- Modify: `src/data_rover/api/schemas.py` (`MetamodelDiffResponse`, `RebindResponse`)
- Modify: `src/data_rover/api/feed.py` (`rebind_event`)
- Test: `tests/api/test_rebind_event.py`

**Interfaces:**
- Consumes: `IssueOut` (in `schemas.py`).
- Produces: `MetamodelDiffResponse`, `RebindResponse` Pydantic models; `rebind_event(*, rev, from_metamodel_id, to_metamodel_id, validation_error_count) -> dict`.

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_rebind_event.py
from data_rover.api.feed import rebind_event
from data_rover.api.schemas import MetamodelDiffResponse, RebindResponse


def test_rebind_event_shape() -> None:
    ev = rebind_event(
        rev=5, from_metamodel_id="old", to_metamodel_id="new",
        validation_error_count=3,
    )
    assert ev == {
        "type": "rebind",
        "rev": 5,
        "from_metamodel_id": "old",
        "to_metamodel_id": "new",
        "validation_error_count": 3,
    }


def test_response_models_construct() -> None:
    d = MetamodelDiffResponse(
        now_failing=[], now_passing=[], unchanged_count=2,
        current_error_count=2, candidate_error_count=2,
    )
    assert d.unchanged_count == 2
    r = RebindResponse(
        model_rev=5, metamodel_id="new", validation_error_count=0,
        issue_counts={}, issues=[],
    )
    assert r.metamodel_id == "new"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_rebind_event.py -v`
Expected: FAIL with `ImportError: cannot import name 'rebind_event'`

- [ ] **Step 3a: Add the feed builder**

In `src/data_rover/api/feed.py`, after `presence_event`, add:

```python
def rebind_event(
    *,
    rev: int,
    from_metamodel_id: str | None,
    to_metamodel_id: str,
    validation_error_count: int,
) -> dict[str, Any]:
    """Whole-model metamodel rebind (Phase 6B): peers should reload."""
    return {
        "type": "rebind",
        "rev": rev,
        "from_metamodel_id": from_metamodel_id,
        "to_metamodel_id": to_metamodel_id,
        "validation_error_count": validation_error_count,
    }
```

- [ ] **Step 3b: Add the response models**

In `src/data_rover/api/schemas.py`, after `IssueOut`, add:

```python
class MetamodelDiffResponse(BaseModel):
    """Read-only sandbox conformance diff (Phase 6B). now_failing = issues the
    candidate metamodel introduces; now_passing = issues it resolves."""

    now_failing: list[IssueOut]
    now_passing: list[IssueOut]
    unchanged_count: int
    current_error_count: int
    candidate_error_count: int


class RebindResponse(BaseModel):
    """Result of a non-destructive metamodel rebind (Phase 6B)."""

    model_rev: int
    metamodel_id: str
    validation_error_count: int
    issue_counts: dict[str, int]
    issues: list[IssueOut]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_rebind_event.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/feed.py tests/api/test_rebind_event.py
git commit -m "feat(api): rebind_event + diff/rebind response schemas"
```

---

## Task 5: `POST /metamodel/diff` route

**Files:**
- Create: `src/data_rover/api/routes/metamodel_swap.py` (router + `_read_metamodel_blob` + `diff` route; `rebind` added in Task 6)
- Modify: `src/data_rover/api/main.py` (mount the router)
- Test: `tests/api/test_metamodel_diff.py`

**Interfaces:**
- Consumes: `get_request_session`, `require_membership`, `require_model`; `load_metamodel_str`, `MetamodelError`; `build_rebind_view`; `default_pipeline`; `_ensure_validation_seeded` (from `routes.ops`); `MetamodelDiffResponse`, `IssueOut`.
- Produces: `router` (mounted under the project prefix); `_read_metamodel_blob(request) -> str`; `_issue_key(issue) -> tuple`.

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_metamodel_diff.py
import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""
# Candidate adds a required property -> existing Nodes now fail.
_MM_REQUIRED = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
        multiplicity: "1"
relationships:
  - name: Link
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    # one Node with no label
    c.post(papi("/model/ops"), json={"base_rev": _rev(c), "ops": [
        {"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}]})
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_diff_identical_metamodel_is_empty(client: TestClient) -> None:
    r = client.post(papi("/metamodel/diff"), content=_MM,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["now_failing"] == []
    assert body["now_passing"] == []


def test_diff_new_required_property_now_failing(client: TestClient) -> None:
    r = client.post(papi("/metamodel/diff"), content=_MM_REQUIRED,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["candidate_error_count"] >= 1
    assert any("label" in i["message"] for i in body["now_failing"])


def test_diff_invalid_candidate_422(client: TestClient) -> None:
    r = client.post(papi("/metamodel/diff"), content="elements: [ {",
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_diff.py -v`
Expected: FAIL with 404 (route not mounted) on `test_diff_identical_metamodel_is_empty`

- [ ] **Step 3a: Create the route module**

Create `src/data_rover/api/routes/metamodel_swap.py`:

```python
"""Phase 6B metamodel swap: read-only sandbox diff + non-destructive rebind.

``/metamodel/diff`` validates the live model against a CANDIDATE metamodel via
a no-copy ``build_rebind_view`` (shares the instance payload, rebuilds indexes)
and returns a conformance diff. ``/metamodel/rebind`` (Task 6) changes the
model's metamodel binding as a journaled commit. Both run under the per-project
``write_mutex`` so the validation sweep can't race a concurrent commit.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

import yaml

from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str
from data_rover.core.model.model import build_rebind_view
from data_rover.core.validation.issue import Issue
from data_rover.core.validation.pipeline import default_pipeline

from fastapi import HTTPException

from ..authz import require_membership
from ..db_models import Membership
from ..deps import Session, get_request_session, require_model
from ..schemas import IssueOut, MetamodelDiffResponse
from .ops import _ensure_validation_seeded

router = APIRouter()


async def _read_metamodel_blob(request: Request) -> str:
    """Decode a metamodel request body to a YAML blob (JSON or YAML body),
    mirroring ``routes/metamodel.py``'s ``upload_metamodel`` content handling."""
    body = (await request.body()).decode("utf-8")
    if "json" in request.headers.get("content-type", ""):
        data = await request.json() if body else {}
        return yaml.safe_dump(data)
    return body


def _issue_key(issue: Issue) -> tuple[str, str, str, tuple[str, ...]]:
    """Stable identity for diffing two validation runs (Issue has no code)."""
    return (
        issue.category.value,
        issue.severity.value,
        issue.message,
        tuple(sorted(issue.target_ids)),
    )


def _load_candidate(blob: str):
    try:
        return load_metamodel_str(blob)
    except MetamodelError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/metamodel/diff", response_model=None)
async def diff_metamodel(
    request: Request,
    session: Session = Depends(get_request_session),
    membership: Membership = Depends(require_membership),
) -> MetamodelDiffResponse:
    _, model = require_model(session)
    candidate = _load_candidate(await _read_metamodel_blob(request))
    with session.write_mutex:
        current = _ensure_validation_seeded(session, model).all_issues()
        candidate_issues = default_pipeline().validate(
            build_rebind_view(model, candidate)
        )
    cur_by_key = {_issue_key(i): i for i in current}
    cand_by_key = {_issue_key(i): i for i in candidate_issues}
    now_failing = [v for k, v in cand_by_key.items() if k not in cur_by_key]
    now_passing = [v for k, v in cur_by_key.items() if k not in cand_by_key]
    unchanged = len(cur_by_key.keys() & cand_by_key.keys())
    return MetamodelDiffResponse(
        now_failing=[IssueOut.from_core(i) for i in now_failing],
        now_passing=[IssueOut.from_core(i) for i in now_passing],
        unchanged_count=unchanged,
        current_error_count=len(current),
        candidate_error_count=len(candidate_issues),
    )
```

- [ ] **Step 3b: Mount the router**

In `src/data_rover/api/main.py`, add `metamodel_swap` to the routes import block (line ~23, alongside `metamodel,`) and register it after the existing metamodel router (after line ~169):

```python
    app.include_router(metamodel_swap.router, prefix=proj, tags=["metamodel"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_diff.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/routes/metamodel_swap.py src/data_rover/api/main.py tests/api/test_metamodel_diff.py
git commit -m "feat(api): POST /metamodel/diff sandbox conformance diff"
```

---

## Task 6: `POST /metamodel/rebind` route

**Files:**
- Modify: `src/data_rover/api/routes/metamodel_swap.py` (add `rebind` route)
- Test: `tests/api/test_metamodel_rebind.py`

**Interfaces:**
- Consumes: everything in Task 5 plus `require_owner`, `get_current_user`, `get_db`, `content`, `write_snapshot` (from `hydration`), `default_pipeline`, `ValidationState` helpers, `RebindResponse`, `rebind_event`, `Scope`.
- Produces: `POST /metamodel/rebind` returning `RebindResponse`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_metamodel_rebind.py
import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.main import create_app
from data_rover.api.db_models import Commit, Role
from data_rover.api.tenancy import add_member
from data_rover.api.session import DEFAULT_PROJECT_ID
from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""
_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Link
    source: Widget
    target: Widget
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    c.post(papi("/model/ops"), json={"base_rev": _rev(c), "ops": [
        {"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}]})
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_rebind_succeeds_and_journals(client: TestClient) -> None:
    before = _rev(client)
    r = client.post(papi("/metamodel/rebind") + f"?base_rev={before}&message=swap",
                    content=_MM_RENAMED, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == before + 1
    # the existing Node is now an instance of an unknown type -> conformance issue
    assert body["validation_error_count"] >= 1
    # a commit row carries the from/to metamodel ids
    gen = db.get_db(); s = next(gen)
    try:
        row = s.get(Commit, (DEFAULT_PROJECT_ID, before + 1))
        assert row is not None
        assert row.to_metamodel_id and row.from_metamodel_id
        assert content.get_model_row(s, DEFAULT_PROJECT_ID).metamodel_id == row.to_metamodel_id
    finally:
        gen.close()
    # new metamodel is live
    mm = client.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    assert any(e["name"] == "Widget" for e in mm["elements"])


def test_rebind_stale_base_rev_409(client: TestClient) -> None:
    r = client.post(papi("/metamodel/rebind") + "?base_rev=999",
                    content=_MM_RENAMED, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 409


def test_rebind_invalid_candidate_422(client: TestClient) -> None:
    r = client.post(papi("/metamodel/rebind") + f"?base_rev={_rev(client)}",
                    content="elements: [ {", headers={"content-type": "application/x-yaml"})
    assert r.status_code == 422


def test_rebind_requires_owner_403(client: TestClient) -> None:
    # add an editor and authenticate as them
    gen = db.get_db(); s = next(gen)
    try:
        from data_rover.api.db_models import User
        s.add(User(id="ed", email="ed@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "ed", Role.editor)
        s.commit()
    finally:
        gen.close()
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={_rev(client)}",
        content=_MM_RENAMED,
        headers={"content-type": "application/x-yaml",
                 "x-user-id": "ed", "x-user-email": "ed@example.com"},
    )
    assert r.status_code == 403


def test_rebind_refuses_when_lock_active(client: TestClient) -> None:
    # acquire an exclusive lease on the Node, then attempt a rebind
    node_id = client.get(papi("/read/elements") + "?limit=1",
                         headers=AUTH_HEADERS).json()["items"][0]["id"]
    lk = client.post(papi("/locks"), headers=AUTH_HEADERS,
                     json={"targets": [{"resource_id": node_id, "intent": "edit"}]})
    assert lk.status_code == 200, lk.text
    r = client.post(papi("/metamodel/rebind") + f"?base_rev={_rev(client)}",
                    content=_MM_RENAMED, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 409
```

> Note: confirm the `/locks` and `/read/elements` request/response shapes against `tests/api/test_locks_route.py` and `tests/api/test_read_route.py` when implementing; adjust the two helper calls in `test_rebind_refuses_when_lock_active` to match (the assertion — 409 while a lease is held — is the contract).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_rebind.py -v`
Expected: FAIL with 404 / 405 (route not present)

- [ ] **Step 3: Add the rebind route**

Append to `src/data_rover/api/routes/metamodel_swap.py`. Extend the imports at the top:

```python
import time
import uuid

from sqlalchemy.orm import Session as DbSession

from .. import content
from ..authz import require_owner
from ..db import get_db
from ..db_models import User
from ..feed import rebind_event
from ..hydration import write_snapshot
from ..identity import get_current_user
from ..schemas import RebindResponse
from data_rover.core.validation.scope import Scope
from fastapi.responses import JSONResponse
```

Then add the route:

```python
@router.post("/metamodel/rebind", response_model=None)
async def rebind_metamodel(
    request: Request,
    project_id: str,
    base_rev: int,
    message: str = "",
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
    membership: Membership = Depends(require_owner),
) -> RebindResponse | JSONResponse:
    """Owner-only, non-destructive metamodel rebind journaled as a commit.

    Refuses (409) when any lease is active — a rebind retypes the whole model
    and must not silently invalidate an open check-out. Mirrors the commit
    route's durable-failure pattern: a DB error fully restores in-memory state.
    """
    _, model = require_model(session)
    if base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    candidate = _load_candidate(await _read_metamodel_blob(request))
    state = _ensure_validation_seeded(session, model)
    with session.write_mutex:
        if session.lock_table.active_leases(time.monotonic()):
            return JSONResponse(
                status_code=409,
                content={"detail": "active locks; rebind requires a quiet project"},
            )
        # capture rollback state
        old_mm = session.metamodel
        old_rev = session.model_rev
        model_row = content.get_model_row(db, project_id)
        from_id = model_row.metamodel_id if model_row is not None else None

        # persist the candidate as a new metamodel version
        prior_version = 0
        if from_id is not None:
            prior = content.get_metamodel_row(db, from_id)
            prior_version = prior.version if prior is not None else 0
        blob = yaml.safe_dump(candidate.model_dump(mode="json"))
        mm_row = content.create_metamodel(
            db, name="", version=prior_version + 1, blob=blob
        )

        # swap live + rebuild index + re-validate the whole model
        session.metamodel = candidate
        model.metamodel = candidate
        model.indexes.rebuild()
        issues = default_pipeline().validate(model, Scope.all())
        state.set_full(issues)
        session.validation = state
        session.model_rev += 1

        commit_id = uuid.uuid4().hex
        issues_json = [IssueOut.from_core(i).model_dump() for i in issues]
        try:
            content.upsert_model_row(db, project_id, metamodel_id=mm_row.id)
            content.set_model_rev(db, project_id, session.model_rev)
            content.append_commit(
                db, project_id,
                rev=session.model_rev, commit_id=commit_id, author_id=user.id,
                ops=[], inverse_ops=[], id_map={},
                message=message, validation_error_count=len(issues),
                issues=issues_json,
                from_metamodel_id=from_id, to_metamodel_id=mm_row.id,
            )
            db.commit()
        except Exception as exc:
            db.rollback()
            session.metamodel = old_mm
            model.metamodel = old_mm
            model.indexes.rebuild()
            session.model_rev = old_rev
            session.validation = None  # force a re-seed on next read
            raise HTTPException(status_code=500, detail="failed to persist rebind") from exc

        write_snapshot(project_id, session, session.model_rev)
        session.hub.broadcast(
            rebind_event(
                rev=session.model_rev,
                from_metamodel_id=from_id,
                to_metamodel_id=mm_row.id,
                validation_error_count=len(issues),
            )
        )
    return RebindResponse(
        model_rev=session.model_rev,
        metamodel_id=mm_row.id,
        validation_error_count=len(issues),
        issue_counts=state.counts(),
        issues=[IssueOut.from_core(i) for i in issues],
    )
```

> Implementation note: confirm `Metamodel` exposes `model_dump(mode="json")` round-trippable through `load_metamodel_str`/`yaml.safe_dump`. If the YAML loader expects the original source layout rather than the pydantic dump, persist the **request blob** instead (capture it from `_read_metamodel_blob` before parsing) — that is the safer choice. Prefer storing the original blob: change `_load_candidate` call site to keep `blob` and pass it to `create_metamodel`.

- [ ] **Step 3b: Prefer storing the original blob (apply the safer choice)**

Adjust the route so the persisted metamodel blob is the original request body, not a re-serialization:

```python
    raw_blob = await _read_metamodel_blob(request)
    candidate = _load_candidate(raw_blob)
    ...
        mm_row = content.create_metamodel(
            db, name="", version=prior_version + 1, blob=raw_blob
        )
```

(Remove the `yaml.safe_dump(candidate.model_dump(...))` line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_rebind.py -v`
Expected: PASS (5 passed). If `test_rebind_refuses_when_lock_active` fails on the lock/read helper shapes, fix those two calls per the note in Step 1, not the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/routes/metamodel_swap.py tests/api/test_metamodel_rebind.py
git commit -m "feat(api): POST /metamodel/rebind non-destructive journaled rebind"
```

---

## Task 7: Initial-bind-only guard on `POST /metamodel`

**Files:**
- Modify: `src/data_rover/api/routes/metamodel.py` (`upload_metamodel`: 409 when model non-empty)
- Test: `tests/api/test_metamodel_upload_guard.py`

**Interfaces:**
- Consumes: `session.model` (the live `Model | None`).
- Produces: `POST /metamodel` returns 409 when `session.model` has elements; unchanged otherwise.

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_metamodel_upload_guard.py
import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_initial_bind_on_empty_project_ok(client: TestClient) -> None:
    r = client.post(papi("/metamodel"), content=_MM,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200


def test_upload_on_nonempty_model_409(client: TestClient) -> None:
    assert client.post(papi("/metamodel"), content=_MM,
                       headers={"content-type": "application/x-yaml"}).status_code == 200
    assert client.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    client.post(papi("/model/ops"), json={"base_rev": _rev(client), "ops": [
        {"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}]})
    r = client.post(papi("/metamodel"), content=_MM,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 409
    assert "rebind" in r.json()["detail"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_upload_guard.py -v`
Expected: FAIL on `test_upload_on_nonempty_model_409` (currently returns 200, destructively clearing the model)

- [ ] **Step 3: Add the guard**

In `src/data_rover/api/routes/metamodel.py`, add to the top of `upload_metamodel` (before reading the body), and import `HTTPException`:

```python
from fastapi import APIRouter, Depends, HTTPException, Request, Response
```

```python
async def upload_metamodel(
    request: Request,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> Metamodel:
    # Phase 6B: this destructive path is initial-bind only. Once a model has
    # content, a metamodel change must go through the non-destructive,
    # journaled POST /metamodel/rebind (this one clears the model + history).
    if session.model is not None and session.model.elements:
        raise HTTPException(
            status_code=409,
            detail="model not empty; use POST /metamodel/rebind",
        )
    body = (await request.body()).decode("utf-8")
    ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_upload_guard.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/routes/metamodel.py tests/api/test_metamodel_upload_guard.py
git commit -m "feat(api): make POST /metamodel initial-bind only (use rebind otherwise)"
```

---

## Task 8: Full-suite green + lint/typecheck

**Files:** none (verification + any fixups)

- [ ] **Step 1: Run the whole core+API test suite**

Run: `pixi run test-core`
Expected: PASS (all green, including the new tests). Investigate any failure in pre-existing metamodel-upload tests — they may rely on the now-guarded destructive behaviour and need their fixtures updated to upload the metamodel *before* adding model content (which they already do) or to use `/metamodel/rebind`.

- [ ] **Step 2: Lint, format, typecheck**

Run: `pixi run lint-core && pixi run lint-backend`
Expected: ruff, mypy, and pyright all clean. Fix any issues (common: unused imports in `metamodel_swap.py`, missing `from __future__ import annotations`).

- [ ] **Step 3: Final commit (only if Step 1/2 required fixups)**

```bash
git add -A
git commit -m "test(api): keep suite green after Phase 6B metamodel swap"
```

---

## Self-Review (completed during authoring)

**Spec coverage:**
- §3.1 no-copy view → Task 1. §3.2 unknown-type check → Task 2. §3.3 diff route → Task 5. §3.4 rebind route → Task 6. §3.5 initial-bind guard → Task 7. §4.1 Alembic + columns → Task 3. §4.2 schemas → Task 4. §4.3 `rebind_event` → Task 4. §5 concurrency invariants → exercised by Task 5/6 (write_mutex, index rebuild, no live-index sharing, rollback). §6 error table → Tasks 5/6/7 tests. §7 test plan → Tasks 1–8. §8 §9-correction → Task 2 (behavioural). Hydration round-trip (§5/§7 in spec) → covered implicitly; **gap noted below**.

**Identified gap (addressed):** the spec's "eviction round-trip" rebind test is not a standalone task step. It is lower-value than the journaled-commit assertions (which already prove `ModelRow.metamodel_id` + snapshot are written, the two things hydration reads) and depends on the eviction test harness. Left out of the bite-sized steps deliberately; if desired, add a Task 6 step that calls `get_registry().evict(DEFAULT_PROJECT_ID)` then re-fetches and asserts the metamodel survived — model the harness on `tests/api/test_session_registry.py`.

**Placeholder scan:** none — every code step shows complete code.

**Type consistency:** `build_rebind_view(live_model, candidate)` (Task 1) matches its callers (Tasks 5/6). `append_commit(..., from_metamodel_id, to_metamodel_id)` (Task 3) matches the rebind call (Task 6). `_issue_key`/`_read_metamodel_blob`/`_load_candidate` defined in Task 5, reused in Task 6. `rebind_event`/`MetamodelDiffResponse`/`RebindResponse` signatures (Task 4) match Tasks 5/6 usage.
</content>
</invoke>
