# Journal-Only History Diff (K-6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the History drawer's per-commit **Diff** click cost O(commit) instead of O(model): at 320k elements it is ~22 s + ~2 GB transient today (two full model reconstructions), and after this plan it is a single journal-row read.

**Architecture:** Every durable journal writer (`POST /commits`, `/commits/revert`, `/model/ops`, `/model/undo`) captures the **full before/after state of every model entity its batch touched** at commit time — the applier snapshots the pre-mutation state on first touch (`_BatchResult.before_*`), the post-state is read off the live model right before persisting, and the pair lands in a new nullable `Commit.entity_states` JSON column (`api/commit_states.py`, capped at `ENTITY_STATES_MAX` touched entities → `NULL` past it). `commit_diff.diff_commit` renders the model half from that column when present and falls back to today's `reconstruct_model_at` pair when it is `NULL` (old rows, over-cap batches) — both paths feed one renderer, so the output is byte-identical. The frontend's per-commit Diff switches from two `GET /commits/{rev}/model` reconstructions + client `computeDiff` to `GET /commits/{rev}/diff` (rendered through the existing `crToDiff`), while the two-revision **Compare** deliberately stays reconstruction-based (inherently O(model)).

**Tech Stack:** Python 3.14 / FastAPI / SQLAlchemy 2 + Alembic / pydantic; SvelteKit 5 + zod + vitest; pytest via pixi (`pixi run -e core-dev pytest`).

**Spec:** `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Measurements", § "Program" item 2). The BACKLOG entry `K-6` (`BACKLOG.md:807`) carries the owner's proposal and the 2026-08-26 measurement.

## Global Constraints

- Every command goes through **pixi**: single test file `pixi run -e core-dev pytest tests/path/test_x.py -v`; whole backend suite `pixi run core-test`; frontend unit tests `pixi run frontend-test`; svelte-check `pixi run frontend-check`; lint/format/typecheck `pixi run dr-tidy` (ruff + mypy + pyright + prettier/eslint — all must pass; pyright covers `tests/` too, so no `# type: ignore` shortcuts). Ad-hoc frontend commands: `pixi run -e frontend bash -c "cd frontend && <cmd>"` (pixi runs ad-hoc commands from the repo root).
- Work on a branch `perf/journal-only-history-diff` off `main` (create it via `superpowers:using-git-worktrees` at execution time). In a fresh worktree run `pixi run frontend-install` before `dr-tidy` (it dies at `frontend-format` otherwise). The repo integrates feature branches into `main` with a merge commit (see `git log --oneline -5`), then pushes (`BACKLOG.md:1225`: pushing `main` is standing policy).
- Comments/docstrings: concise, present tense, only invariants and non-obvious contracts. No spec/plan references, no history narration.
- Python 3.14 idioms (`X | Y` unions, `collections.abc` imports, `Mapping` for read-only params).
- `docs/` is gitignored — the spec and this plan are never committed; every other step commits.
- **The `Commit.entity_states` column is nullable and `NULL` means "not captured — reconstruct".** Old rows keep rendering; never backfill.
- **Do not build a search index on a transient model** (K-20 standing constraint): `reconstruct_model_at` returns a model with `search_ready=False`, and that is correct. No `start_search_index_build` on any reconstruction path.
- **Do not touch `GET /commits/{rev}/model`** or the frontend's Compare (two-rev) path: they are inherently O(model) and stay reconstruction-based (recorded under Deferred in the prior handoff).
- `dataclasses.asdict` deep-copies nested containers, which is what makes `ElementOut.from_core(element)` a safe pre-mutation snapshot even though `Model.set_property` mutates `element.properties` in place. `from_core` is the only snapshot primitive this plan uses — do not hand-roll a shallow copy.
- API tests: conftest pins `DATA_ROVER_VALIDATION_SWEEP_SYNC=true` and `DATA_ROVER_SEARCH_INDEX_SYNC=true`; the `client` fixtures in `tests/api/test_commit_diff.py` / `test_commit_model_at.py` install a metamodel via `POST /metamodel` and an empty model via `POST /model` (which persists the durable baseline the journal needs).

---

### Task 1: Schema — `Commit.entity_states` column, Alembic `0013`, `content.append_commit` kwarg

**Files:**
- Modify: `src/data_rover/api/db_models.py:216-268` (class `Commit`)
- Create: `alembic/versions/0013_commit_entity_states.py`
- Modify: `src/data_rover/api/content.py:93-125` (`append_commit`)
- Test: `tests/api/test_alembic.py` (append), `tests/api/test_commit_metamodel_columns.py` (append)

**Interfaces:**
- Produces: `Commit.entity_states: Mapped[dict | None]` (JSON, nullable, default `None`); `content.append_commit(..., entity_states: dict[str, Any] | None = None)`.
- The column's shape (written by Task 2's `capture_entity_states`, read by Task 4's `load_entity_states`):
  ```json
  {"elements": {"<id>": {"before": <ElementOut JSON | null>, "after": <ElementOut JSON | null>}},
   "relationships": {"<id>": {"before": <RelationshipOut JSON | null>, "after": <RelationshipOut JSON | null>}}}
  ```
  `before: null` = the entity did not exist before the commit; `after: null` = it does not exist after it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_alembic.py`:

```python
def test_migration_0013_adds_commit_entity_states(tmp_path: Path) -> None:
    db_path = tmp_path / "t5.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")
    engine = create_engine(url)
    cols = {c["name"]: c for c in inspect(engine).get_columns("commits")}
    assert "entity_states" in cols
    assert cols["entity_states"]["nullable"] is True

    command.downgrade(cfg, "0012")
    cols = {c["name"] for c in inspect(engine).get_columns("commits")}
    assert "entity_states" not in cols
```

Append to `tests/api/test_commit_metamodel_columns.py` (same file shape: direct ORM round-trip):

```python
def test_append_commit_records_entity_states_and_defaults_to_null() -> None:
    db.init_engine("sqlite://")
    db.create_all()
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(Project(id="p1", name="P1"))
        states = {
            "elements": {
                "e1": {
                    "before": None,
                    "after": {"id": "e1", "type_name": "Node", "properties": {}, "rev": 0},
                }
            },
            "relationships": {},
        }
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[], inverse_ops=[], id_map={}, entity_states=states,
        )
        content.append_commit(
            s, "p1", rev=2, commit_id="c2", author_id=None,
            ops=[], inverse_ops=[], id_map={},
        )
        s.commit()
        row1 = s.get(Commit, ("p1", 1))
        row2 = s.get(Commit, ("p1", 2))
        assert row1 is not None and row1.entity_states == states
        assert row2 is not None and row2.entity_states is None
    finally:
        gen.close()
        db.drop_all()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_alembic.py tests/api/test_commit_metamodel_columns.py -v`
Expected: the two new tests FAIL (`entity_states` not in columns; `append_commit() got an unexpected keyword argument 'entity_states'`). The existing tests pass.

- [ ] **Step 3: Add the ORM column**

In `src/data_rover/api/db_models.py`, inside `class Commit`, right after the `to_metamodel_id` column (before `#: Declared so the ORM unit-of-work ...`):

```python
    #: Full before/after state of every model entity this commit touched
    #: (``commit_states`` has the shape). NULL means "not captured": rows
    #: written before the column existed, or a batch that touched more than
    #: ``ENTITY_STATES_MAX`` entities — the diff reader reconstructs the model
    #: instead. Never backfilled.
    entity_states: Mapped[dict | None] = mapped_column(JSON, nullable=True)
```

- [ ] **Step 4: Add the Alembic revision**

Create `alembic/versions/0013_commit_entity_states.py`:

```python
"""commits.entity_states — per-commit touched-entity before/after state

Revision ID: 0013
Revises: 0012
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("commits", sa.Column("entity_states", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("commits", "entity_states")
```

- [ ] **Step 5: Thread the kwarg through `content.append_commit`**

In `src/data_rover/api/content.py`, add the parameter after `to_metamodel_id`:

```python
    to_metamodel_id: str | None = None,
    entity_states: dict[str, Any] | None = None,
) -> Commit:
    row = Commit(
        ...
        to_metamodel_id=to_metamodel_id,
        entity_states=entity_states,
    )
```

(`Any` is already imported in `content.py` — `ops: list[Any]` uses it.)

- [ ] **Step 6: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_alembic.py tests/api/test_commit_metamodel_columns.py tests/api/test_content.py tests/api/test_hydration.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/db_models.py alembic/versions/0013_commit_entity_states.py src/data_rover/api/content.py tests/api/test_alembic.py tests/api/test_commit_metamodel_columns.py
git commit -m "feat(journal): nullable Commit.entity_states column (alembic 0013)"
```

---

### Task 2: Capture — `_BatchResult.before_*` first-touch snapshots + `api/commit_states.py`

**Files:**
- Modify: `src/data_rover/api/routes/ops.py:157-195` (`_BatchResult`), `:222-440` (`_apply_one`)
- Create: `src/data_rover/api/commit_states.py`
- Test: `tests/api/test_commit_states.py` (new)

**Interfaces:**
- Produces on `_BatchResult`:
  - `before_elements: dict[str, ElementOut | None]` — keyed by every element id the batch touched; the value is the entity's state **before its first touch** in this batch (`None` = did not exist). Later touches never overwrite.
  - `before_relationships: dict[str, RelationshipOut | None]` — same for relationships.
  - Invariant (Task 3 relies on it): every id in `changed_element_ids ∪ deleted_element_ids` has an entry in `before_elements`, and likewise for relationships.
- Produces in `api/commit_states.py`:
  - `ENTITY_STATES_MAX = 5000`
  - `ElementPair = tuple[ElementOut | None, ElementOut | None]`, `RelationshipPair = tuple[RelationshipOut | None, RelationshipOut | None]`
  - `@dataclass(frozen=True, slots=True) class EntityStates: elements: dict[str, ElementPair]; relationships: dict[str, RelationshipPair]`
  - `capture_entity_states(model: Model, res: _BatchResult) -> dict[str, Any] | None` — the JSON column value for the applied batch (`None` when the touched count exceeds `ENTITY_STATES_MAX`). `model` is the POST-apply model.
  - `load_entity_states(raw: Mapping[str, Any]) -> EntityStates` — inverse of the JSON shape.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_commit_states.py`:

```python
"""Per-batch entity-state capture: the applier snapshots every touched
entity's pre-mutation state on first touch, and ``capture_entity_states``
pairs it with the post-apply state for the journal row."""

from __future__ import annotations

import pytest

from data_rover.api import commit_states
from data_rover.api.commit_states import (
    EntityStates,
    capture_entity_states,
    load_entity_states,
)
from data_rover.api.routes.ops import _apply_batch
from data_rover.api.schemas import (
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ElementOut,
    ModelOpIn,
    UpdateElementOp,
    UpdateRelationshipOp,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
      - name: meta
        datatype: string
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
    properties:
      - name: note
        datatype: string
"""


def _model() -> Model:
    return Model(load_metamodel_str(_MM))


def _create(temp_id: str, **props: object) -> CreateElementOp:
    return CreateElementOp(
        kind="create_element", temp_id=temp_id, type_name="Node", properties=dict(props)
    )


def test_create_records_no_before_and_full_after() -> None:
    m = _model()
    res = _apply_batch(m, [_create("tmp_a", label="a")], restore=False)
    eid = res.id_map["tmp_a"]
    assert res.before_elements == {eid: None}
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["elements"][eid]["before"] is None
    assert states["elements"][eid]["after"] == ElementOut.from_core(
        m.elements[eid]
    ).model_dump(mode="json")
    assert states["relationships"] == {}


def test_update_snapshots_the_pre_mutation_state_once() -> None:
    m = _model()
    eid = _apply_batch(m, [_create("tmp_a", label="a")], restore=False).id_map["tmp_a"]
    ops: list[ModelOpIn] = [
        UpdateElementOp(kind="update_element", id=eid, properties_patch={"label": "b"}),
        UpdateElementOp(kind="update_element", id=eid, properties_patch={"label": "c"}),
    ]
    res = _apply_batch(m, ops, restore=False)
    before = res.before_elements[eid]
    assert before is not None and before.properties == {"label": "a"}  # first touch wins
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["elements"][eid]["before"]["properties"] == {"label": "a"}
    assert states["elements"][eid]["after"]["properties"] == {"label": "c"}


def test_before_snapshot_does_not_alias_the_live_properties() -> None:
    m = _model()
    eid = _apply_batch(m, [_create("tmp_a", meta="x")], restore=False).id_map["tmp_a"]
    res = _apply_batch(
        m,
        [UpdateElementOp(kind="update_element", id=eid, properties_patch={"label": "b"})],
        restore=False,
    )
    m.elements[eid].properties["meta"] = "mutated-in-place"
    before = res.before_elements[eid]
    assert before is not None and before.properties["meta"] == "x"


def test_cascade_delete_captures_every_victim() -> None:
    m = _model()
    setup = _apply_batch(
        m,
        [
            _create("tmp_p", label="p"),
            _create("tmp_c", label="c"),
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r",
                type_name="Contains",
                source_id="tmp_p",
                target_id="tmp_c",
                properties={"note": "n"},
            ),
        ],
        restore=False,
    )
    p, c, r = (setup.id_map[k] for k in ("tmp_p", "tmp_c", "tmp_r"))
    res = _apply_batch(m, [DeleteElementOp(kind="delete_element", id=p)], restore=False)
    states = capture_entity_states(m, res)
    assert states is not None
    assert set(states["elements"]) == {p, c}
    assert set(states["relationships"]) == {r}
    for entry in (*states["elements"].values(), *states["relationships"].values()):
        assert entry["before"] is not None and entry["after"] is None
    assert states["elements"][c]["before"]["properties"] == {"label": "c"}
    assert states["relationships"][r]["before"]["properties"] == {"note": "n"}


def test_create_then_delete_in_one_batch_is_none_none() -> None:
    m = _model()
    res = _apply_batch(
        m,
        [_create("tmp_a", label="a"), DeleteElementOp(kind="delete_element", id="tmp_a")],
        restore=False,
    )
    eid = res.id_map["tmp_a"]
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["elements"][eid] == {"before": None, "after": None}


def test_relationship_update_and_delete() -> None:
    m = _model()
    setup = _apply_batch(
        m,
        [
            _create("tmp_p"),
            _create("tmp_c"),
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r",
                type_name="Contains",
                source_id="tmp_p",
                target_id="tmp_c",
                properties={"note": "n1"},
            ),
        ],
        restore=False,
    )
    r = setup.id_map["tmp_r"]
    res = _apply_batch(
        m,
        [UpdateRelationshipOp(kind="update_relationship", id=r, properties_patch={"note": "n2"})],
        restore=False,
    )
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["elements"] == {}
    assert states["relationships"][r]["before"]["properties"] == {"note": "n1"}
    assert states["relationships"][r]["after"]["properties"] == {"note": "n2"}
    res = _apply_batch(m, [DeleteRelationshipOp(kind="delete_relationship", id=r)], restore=False)
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["relationships"][r]["before"]["properties"] == {"note": "n2"}
    assert states["relationships"][r]["after"] is None


def test_over_cap_batch_captures_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(commit_states, "ENTITY_STATES_MAX", 1)
    m = _model()
    res = _apply_batch(m, [_create("tmp_a"), _create("tmp_b")], restore=False)
    assert capture_entity_states(m, res) is None
    res = _apply_batch(m, [_create("tmp_c")], restore=False)
    assert capture_entity_states(m, res) is not None  # exactly at the cap is fine


def test_load_round_trips_capture() -> None:
    m = _model()
    eid = _apply_batch(m, [_create("tmp_a", label="a")], restore=False).id_map["tmp_a"]
    res = _apply_batch(
        m,
        [UpdateElementOp(kind="update_element", id=eid, properties_patch={"label": "b"})],
        restore=False,
    )
    raw = capture_entity_states(m, res)
    assert raw is not None
    loaded = load_entity_states(raw)
    assert isinstance(loaded, EntityStates)
    before, after = loaded.elements[eid]
    assert before is not None and after is not None
    assert before.properties == {"label": "a"} and after.properties == {"label": "b"}
    assert after == ElementOut.from_core(m.elements[eid])
    assert loaded.relationships == {}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_states.py -v`
Expected: FAIL at import (`ModuleNotFoundError: data_rover.api.commit_states`).

- [ ] **Step 3: Add the first-touch snapshots to `_BatchResult` and `_apply_one`**

In `src/data_rover/api/routes/ops.py`, in `class _BatchResult` add two fields after `deleted_relationship_ids` and two helpers after `mark_relationship_deleted`:

```python
    deleted_relationship_ids: dict[str, None] = field(default_factory=dict)
    #: pre-batch state per touched id, captured on FIRST touch (None = did
    #: not exist). Later touches in the same batch never overwrite, so an
    #: entity created-then-updated stays None and one deleted-then-restored
    #: keeps its original state. Every id in changed_*/deleted_* has an entry.
    before_elements: dict[str, ElementOut | None] = field(default_factory=dict)
    before_relationships: dict[str, RelationshipOut | None] = field(default_factory=dict)
```

```python
    def note_element_before(self, element_id: str, element: Element | None) -> None:
        """Record ``element``'s current state as its pre-batch state unless an
        earlier op in this batch already did. Call BEFORE mutating it."""
        if element_id not in self.before_elements:
            self.before_elements[element_id] = (
                ElementOut.from_core(element) if element is not None else None
            )

    def note_relationship_before(self, rel_id: str, rel: Relationship | None) -> None:
        if rel_id not in self.before_relationships:
            self.before_relationships[rel_id] = (
                RelationshipOut.from_core(rel) if rel is not None else None
            )
```

`ops.py` imports only `Model` from the core model package (`:73`); add `from data_rover.core.model.element import Element` and `from data_rover.core.model.relationship import Relationship` beside it. `ElementOut`/`RelationshipOut` are already imported from `..schemas` (used by `_finalize`).

Then in `_apply_one`, one line per branch — the placement is what matters (BEFORE any mutation of that entity, AFTER the id is resolved):

(a) `CreateElementOp` branch — right after `res.id_map[op.temp_id] = element.id` / the `restore` `element = ...` assignment, i.e. immediately before the `# inverse recorded BEFORE the property sets` comment:

```python
        res.note_element_before(element.id, None)
```

(b) `UpdateElementOp` branch — right after `element = model.get_element(eid)`:

```python
        res.note_element_before(eid, element)
```

(c) `DeleteElementOp` branch — inside the two loops that build the inverse unit:

```python
        for ce in closure:
            e = model.elements[ce]
            res.note_element_before(ce, e)
            unit.append(
                CreateElementOp(...)   # unchanged
            )
        for rid in removed_rel_ids:
            r = model.relationships[rid]
            res.note_relationship_before(rid, r)
            unit.append(
                CreateRelationshipOp(...)   # unchanged
            )
```

(d) `CreateRelationshipOp` branch — immediately before `res.inverse_units.append([DeleteRelationshipOp(...)])`:

```python
        res.note_relationship_before(rel.id, None)
```

(e) `UpdateRelationshipOp` branch — right after `rel = model.get_relationship(rid)`:

```python
        res.note_relationship_before(rid, rel)
```

(f) `DeleteRelationshipOp` branch — right after `rel = model.get_relationship(rid)`:

```python
        res.note_relationship_before(rid, rel)
```

`_rollback`'s scratch `_BatchResult` and hydration's replay also collect these snapshots and discard them; the cost is one `asdict` per touched entity, the same order as the inverse-unit construction that already runs there, so no opt-out flag.

- [ ] **Step 4: Create `src/data_rover/api/commit_states.py`**

```python
"""Per-commit touched-entity state: capture at commit time, load at diff time.

The journal's inverse ops cannot render a ``modified`` diff entry on their
own — an update's inverse ``properties_patch`` carries only the touched
keys, not the whole entity — so the full before/after state of every entity
a batch touched is captured while the live model is still in scope and
stored on the ``Commit`` row (``entity_states``). The diff reader then never
reconstructs the model for a commit that carries it.

Column shape::

    {"elements":      {id: {"before": ElementOut | null, "after": ElementOut | null}},
     "relationships": {id: {"before": RelationshipOut | null, "after": RelationshipOut | null}}}

``before: null`` = did not exist before the commit; ``after: null`` = does
not exist after it. A batch touching more than ``ENTITY_STATES_MAX`` entities
stores NULL instead (the row would otherwise grow with the batch — a subtree
delete can touch a large share of the model), and NULL means "reconstruct".
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from data_rover.core.model.model import Model

from .schemas import ElementOut, RelationshipOut

if TYPE_CHECKING:
    from .routes.ops import _BatchResult

#: touched-entity cap (elements + relationships) above which a commit stores
#: no states; same order as ISSUES_RESPONSE_MAX, bounding the row size.
ENTITY_STATES_MAX = 5000

ElementPair = tuple[ElementOut | None, ElementOut | None]
RelationshipPair = tuple[RelationshipOut | None, RelationshipOut | None]


@dataclass(frozen=True, slots=True)
class EntityStates:
    """(before, after) per touched id — the diff renderer's single input
    shape, whether it came from the journal row or from reconstruction."""

    elements: dict[str, ElementPair]
    relationships: dict[str, RelationshipPair]


def _dump(out: ElementOut | RelationshipOut | None) -> dict[str, Any] | None:
    return out.model_dump(mode="json") if out is not None else None


def capture_entity_states(model: Model, res: _BatchResult) -> dict[str, Any] | None:
    """The ``entity_states`` column value for an applied batch, or None when
    the batch exceeds ``ENTITY_STATES_MAX``. ``model`` is the POST-apply model
    (changed entities present, deleted ones gone); the before side comes from
    the applier's first-touch snapshots (``_BatchResult.before_*``)."""
    touched = (
        len(res.changed_element_ids)
        + len(res.deleted_element_ids)
        + len(res.changed_relationship_ids)
        + len(res.deleted_relationship_ids)
    )
    if touched > ENTITY_STATES_MAX:
        return None
    elements: dict[str, Any] = {}
    for eid in res.changed_element_ids:
        elements[eid] = {
            "before": _dump(res.before_elements[eid]),
            "after": _dump(ElementOut.from_core(model.elements[eid])),
        }
    for eid in res.deleted_element_ids:
        elements[eid] = {"before": _dump(res.before_elements[eid]), "after": None}
    relationships: dict[str, Any] = {}
    for rid in res.changed_relationship_ids:
        relationships[rid] = {
            "before": _dump(res.before_relationships[rid]),
            "after": _dump(RelationshipOut.from_core(model.relationships[rid])),
        }
    for rid in res.deleted_relationship_ids:
        relationships[rid] = {
            "before": _dump(res.before_relationships[rid]),
            "after": None,
        }
    return {"elements": elements, "relationships": relationships}


def load_entity_states(raw: Mapping[str, Any]) -> EntityStates:
    """Parse a stored ``entity_states`` value back into typed pairs."""

    def el(v: Any) -> ElementOut | None:
        return ElementOut.model_validate(v) if v is not None else None

    def rel(v: Any) -> RelationshipOut | None:
        return RelationshipOut.model_validate(v) if v is not None else None

    return EntityStates(
        elements={
            eid: (el(entry.get("before")), el(entry.get("after")))
            for eid, entry in raw.get("elements", {}).items()
        },
        relationships={
            rid: (rel(entry.get("before")), rel(entry.get("after")))
            for rid, entry in raw.get("relationships", {}).items()
        },
    )
```

- [ ] **Step 5: Run the new tests**

Run: `pixi run -e core-dev pytest tests/api/test_commit_states.py -v`
Expected: all PASS.

- [ ] **Step 6: Run the applier's neighbours**

Run: `pixi run -e core-dev pytest tests/api/test_ops_route.py tests/api/test_ops_persistence.py tests/api/test_undo_artifact_ops.py tests/api/test_undo_view_ops.py tests/api/test_commits_route.py tests/api/test_commits_revert.py tests/api/test_hydration.py tests/api/test_reconstruct.py -q`
Expected: PASS — the snapshots are pure bookkeeping.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/ops.py src/data_rover/api/commit_states.py tests/api/test_commit_states.py
git commit -m "feat(journal): capture touched entities' before/after state per applied batch"
```

---

### Task 3: Persist — every journal writer stores `entity_states`

**Files:**
- Modify: `src/data_rover/api/routes/ops.py:539-606` (`_persist_commit`), `:609-642` (`_persist_undo_commit`), the `apply_ops` persist call (~`:718`), the `undo` persist call (~`:1040`)
- Modify: `src/data_rover/api/routes/commits.py` — the `create_commit` persist call (~`:1373`) and the `revert_commit` persist call (~`:1746`)
- Test: `tests/api/test_commit_states.py` (append)

**Interfaces:**
- Consumes: `capture_entity_states(model, res)` (Task 2), `content.append_commit(entity_states=...)` (Task 1).
- Produces: `_persist_commit(..., _entity_states: dict[str, Any] | None = None)`, `_persist_undo_commit(..., entity_states: dict[str, Any] | None = None)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_commit_states.py` (HTTP-level; these need the API `client` fixture shape used by `tests/api/test_commit_diff.py`):

```python
# --- persistence through every journal writer ------------------------------

from fastapi.testclient import TestClient  # noqa: E402

from data_rover.api import content, db  # noqa: E402
from data_rover.api.main import create_app  # noqa: E402
from data_rover.api.session import DEFAULT_PROJECT_ID  # noqa: E402

from .conftest import AUTH_HEADERS, papi, seed_default_project  # noqa: E402


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    rev: int = c.get(papi("/model/summary")).json()["model_rev"]
    return rev


def _lock(c: TestClient, resource_id: str, intent: str = "edit") -> str:
    r = c.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": resource_id, "mode": "exclusive", "type": "element"}],
            "intent": intent,
        },
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def _states_at(rev: int) -> dict | None:
    gen = db.get_db()
    s = next(gen)
    try:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, rev)
        assert row is not None
        return row.entity_states
    finally:
        gen.close()


def _commit(c: TestClient, ops: list[dict], tokens: list[str] | None = None) -> dict:
    """POST /commits; returns the response body (``model_rev``, ``id_map``, ...)."""
    r = c.post(
        papi("/commits"),
        json={"base_rev": _rev(c), "ops": ops, "lock_tokens": tokens or []},
    )
    assert r.status_code == 200, r.text
    body: dict = r.json()
    return body


def test_post_commits_persists_states(client: TestClient) -> None:
    body = _commit(
        client,
        [{"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node",
          "properties": {"label": "before"}}],
    )
    eid = body["id_map"]["tmp_e"]
    states = _states_at(body["model_rev"])
    assert states is not None
    assert states["elements"][eid]["before"] is None
    assert states["elements"][eid]["after"]["properties"] == {"label": "before"}

    tok = _lock(client, eid)
    body = _commit(
        client,
        [{"kind": "update_element", "id": eid, "properties_patch": {"label": "after"}}],
        [tok],
    )
    states = _states_at(body["model_rev"])
    assert states is not None
    assert states["elements"][eid]["before"]["properties"] == {"label": "before"}
    assert states["elements"][eid]["after"]["properties"] == {"label": "after"}


def test_artifact_only_commit_persists_empty_states(client: TestClient) -> None:
    body = _commit(
        client,
        [{
            "kind": "create_artifact", "temp_id": "tmp_a", "artifact_kind": "code_snippet",
            "name": "s1",
            "payload": {"schema_version": 1, "language": "python",
                        "code": "def value(el):\n    return 1\n"},
        }],
    )
    assert _states_at(body["model_rev"]) == {"elements": {}, "relationships": {}}


def test_legacy_ops_and_undo_persist_states(client: TestClient) -> None:
    r = client.post(
        papi("/model/ops"),
        json={"base_rev": _rev(client), "ops": [
            {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node",
             "properties": {"label": "v1"}}]},
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id_map"]["tmp_e"]
    r = client.post(
        papi("/model/ops"),
        json={"base_rev": _rev(client), "ops": [
            {"kind": "update_element", "id": eid, "properties_patch": {"label": "v2"}}]},
    )
    assert r.status_code == 200, r.text
    rev_update = r.json()["model_rev"]
    states = _states_at(rev_update)
    assert states is not None
    assert states["elements"][eid]["before"]["properties"] == {"label": "v1"}
    assert states["elements"][eid]["after"]["properties"] == {"label": "v2"}

    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    rev_undo = r.json()["model_rev"]
    states = _states_at(rev_undo)
    assert states is not None  # the compensating commit is journal-diffable too
    assert states["elements"][eid]["before"]["properties"] == {"label": "v2"}
    assert states["elements"][eid]["after"]["properties"] == {"label": "v1"}


def test_revert_persists_states(client: TestClient) -> None:
    body = _commit(
        client,
        [{"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node",
          "properties": {"label": "a"}}],
    )
    rev_a, eid = body["model_rev"], body["id_map"]["tmp_e"]
    tok = _lock(client, eid)
    _commit(
        client,
        [{"kind": "update_element", "id": eid, "properties_patch": {"label": "b"}}],
        [tok],
    )
    r = client.post(
        papi("/commits/revert"),
        json={"target_rev": rev_a, "base_rev": _rev(client)},
    )
    assert r.status_code == 200, r.text
    states = _states_at(r.json()["model_rev"])
    assert states is not None
    assert states["elements"][eid]["before"]["properties"] == {"label": "b"}
    assert states["elements"][eid]["after"]["properties"] == {"label": "a"}


def test_over_cap_commit_persists_null(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(commit_states, "ENTITY_STATES_MAX", 1)
    body = _commit(
        client,
        [
            {"kind": "create_element", "temp_id": "tmp_a", "type_name": "Node"},
            {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Node"},
        ],
    )
    assert _states_at(body["model_rev"]) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_states.py -v -k "persists"`
Expected: the five HTTP tests FAIL on `assert states is not None` / `== {"elements": {}, ...}` (the column is still NULL for every row).

- [ ] **Step 3: Thread the value through the two persist helpers**

In `src/data_rover/api/routes/ops.py`:

`_persist_commit` — add the parameter after `_to_metamodel_id` and pass it on:

```python
    _to_metamodel_id: str | None = None,
    _entity_states: dict[str, Any] | None = None,
) -> bool:
```

docstring addition (after the `_from_metamodel_id` paragraph):

```
    ``_entity_states`` is ``capture_entity_states(model, res)`` for the
    applied batch — the diff reader's journal-only input; None (over-cap or
    a writer that has no model batch) means the reader reconstructs.
```

and in the `content.append_commit(...)` call: `entity_states=_entity_states,` after `to_metamodel_id=_to_metamodel_id,`.

`_persist_undo_commit` — add `entity_states: dict[str, Any] | None = None,` after `id_map` and pass `entity_states=entity_states,` to `content.append_commit`.

Add the import near `from ..invalidation import touched_keys`: `from ..commit_states import capture_entity_states`. Confirm `Any` is imported in `ops.py` (it is used by `_check_patch_keys`'s signature).

- [ ] **Step 4: Pass it at the four writer sites**

(a) `ops.py` `apply_ops` — inside the existing `try:` around `_persist_commit(...)`, add the kwarg (evaluated inside the `try`, so a capture failure takes the same rollback as a persist failure):

```python
            persisted = _persist_commit(
                db,
                project_id,
                rev=session.model_rev,
                author_id=user.id,
                ops=res.canonical_ops,
                inverse_ops=res.inverse_ops(),
                id_map=dict(res.id_map),
                _entity_states=capture_entity_states(model, res),
            )
```

(b) `ops.py` `undo` — the `_persist_undo_commit(...)` call gains `entity_states=capture_entity_states(model, res),` (`res` is the model-half `_BatchResult` from `_apply_batch(model, model_inv, restore=True)`).

(c) `commits.py` `create_commit` — the `_persist_commit(...)` call at ~`:1373` gains `_entity_states=capture_entity_states(model, res),` after `_to_metamodel_id=...`. Add `from ..commit_states import capture_entity_states` next to the `from ..invalidation import touched_keys` import (`:59`).

(d) `commits.py` `revert_commit` — the `_persist_commit(...)` call at ~`:1746` gains `_entity_states=capture_entity_states(model, res),`.

`hydration.persist_baseline` and `importer.import_project` write empty-ops baseline rows and are deliberately left at `None`: a baseline commit has no diff to render.

- [ ] **Step 5: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_commit_states.py tests/api/test_commits_route.py tests/api/test_commits_revert.py tests/api/test_commits_artifact_ops.py tests/api/test_commits_view_ops.py tests/api/test_commits_metamodel_ops.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/ops.py src/data_rover/api/routes/commits.py tests/api/test_commit_states.py
git commit -m "feat(journal): persist entity_states on every commit, undo and revert row"
```

---

### Task 4: Read — `diff_commit` renders the model half journal-only, reconstruction only on `NULL`

**Files:**
- Modify: `src/data_rover/api/commit_diff.py` (module docstring `:1-10`, `_element_diffs`/`_relationship_diffs` `:203-236`, `diff_commit` `:436-507`)
- Modify: `src/data_rover/api/routes/commits.py:741-762` (`commit_diff_endpoint` docstring)
- Test: `tests/api/test_commit_diff.py` (append)

**Interfaces:**
- Consumes: `EntityStates`, `ElementPair`, `RelationshipPair`, `load_entity_states` (Task 2); `Commit.entity_states` (Task 1).
- Produces: unchanged wire shape (`CommitDiffOut`). Internal: `_element_diffs(states: Mapping[str, ElementPair]) -> CrElementOps`, `_relationship_diffs(states: Mapping[str, RelationshipPair]) -> CrRelationshipOps`, `_states_from_models(el_ids, rel_ids, before: Model | None, after: Model | None) -> EntityStates`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_commit_diff.py` (the file already has `client`, `_rev`, `_lock`, `papi`, `db`, `DEFAULT_PROJECT_ID`, `pytest`, `TestClient`; add `from data_rover.api import commit_diff, content` to its imports):

```python
def _null_states(rev: int) -> None:
    """Simulate a pre-column journal row: drop the captured states so the
    reader must reconstruct."""
    gen = db.get_db()
    s = next(gen)
    try:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, rev)
        assert row is not None and row.entity_states is not None
        row.entity_states = None
        s.commit()
    finally:
        gen.close()


def _three_commits(client: TestClient) -> tuple[int, int, int, str, str]:
    """create parent+child+containment; update child; delete parent (cascade).
    Returns (rev_create, rev_update, rev_delete, parent_id, child_id)."""
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_p", "type_name": "Node",
                 "properties": {"label": "p"}},
                {"kind": "create_element", "temp_id": "tmp_c", "type_name": "Node",
                 "properties": {"label": "c1"}},
                {"kind": "create_relationship", "temp_id": "tmp_r", "type_name": "Contains",
                 "source_id": "tmp_p", "target_id": "tmp_c"},
            ],
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    rev_create = r.json()["model_rev"]
    p, c = r.json()["id_map"]["tmp_p"], r.json()["id_map"]["tmp_c"]

    tok = _lock(client, c)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "update_element", "id": c, "properties_patch": {"label": "c2"}}],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    rev_update = r.json()["model_rev"]

    tok = _lock(client, p, intent="delete")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "delete_element", "id": p}],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    return rev_create, rev_update, r.json()["model_rev"], p, c


def test_diff_is_journal_only_when_states_are_present(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A commit row carrying entity_states never reconstructs the model."""
    rev_create, rev_update, rev_delete, p, c = _three_commits(client)

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("reconstruct_model_at must not run on the journal path")

    monkeypatch.setattr(commit_diff, "reconstruct_model_at", boom)

    d = client.get(papi(f"/commits/{rev_update}/diff"))
    assert d.status_code == 200, d.text
    mod = d.json()["elements"]["modified"]
    assert [m["id"] for m in mod] == [c]
    assert mod[0]["before"]["properties"] == {"label": "c1"}
    assert mod[0]["after"]["properties"] == {"label": "c2"}

    d = client.get(papi(f"/commits/{rev_delete}/diff"))
    assert d.status_code == 200, d.text
    body = d.json()
    assert sorted(e["id"] for e in body["elements"]["deleted"]) == sorted([p, c])
    assert len(body["relationships"]["deleted"]) == 1
    assert body["elements"]["added"] == [] and body["elements"]["modified"] == []

    d = client.get(papi(f"/commits/{rev_create}/diff"))
    assert sorted(e["id"] for e in d.json()["elements"]["added"]) == sorted([p, c])
    assert len(d.json()["relationships"]["added"]) == 1


def test_null_states_fall_back_to_reconstruction_byte_identically(
    client: TestClient,
) -> None:
    """The two paths render the same model half: capture the journal-path
    output, null the column, and re-render through reconstruction."""
    revs = _three_commits(client)[:3]
    journal = {rev: client.get(papi(f"/commits/{rev}/diff")).json() for rev in revs}
    for rev in revs:
        _null_states(rev)
    for rev in revs:
        d = client.get(papi(f"/commits/{rev}/diff"))
        assert d.status_code == 200, d.text
        assert d.json()["elements"] == journal[rev]["elements"]
        assert d.json()["relationships"] == journal[rev]["relationships"]
        assert d.json()["scope"] == journal[rev]["scope"]


def test_over_cap_commit_diff_still_renders(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from data_rover.api import commit_states

    monkeypatch.setattr(commit_states, "ENTITY_STATES_MAX", 1)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_a", "type_name": "Node"},
                {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Node"},
            ],
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    rev = r.json()["model_rev"]
    d = client.get(papi(f"/commits/{rev}/diff"))
    assert d.status_code == 200, d.text
    assert len(d.json()["elements"]["added"]) == 2  # reconstruction fallback


def test_undo_commit_diff_is_journal_only(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    r = client.post(
        papi("/model/ops"),
        json={"base_rev": _rev(client), "ops": [
            {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node",
             "properties": {"label": "v1"}}]},
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id_map"]["tmp_e"]
    r = client.post(
        papi("/model/ops"),
        json={"base_rev": _rev(client), "ops": [
            {"kind": "update_element", "id": eid, "properties_patch": {"label": "v2"}}]},
    )
    assert r.status_code == 200, r.text
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    rev_undo = r.json()["model_rev"]

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("reconstruct_model_at must not run on the journal path")

    monkeypatch.setattr(commit_diff, "reconstruct_model_at", boom)
    d = client.get(papi(f"/commits/{rev_undo}/diff"))
    assert d.status_code == 200, d.text
    mod = d.json()["elements"]["modified"][0]
    assert mod["before"]["properties"] == {"label": "v2"}
    assert mod["after"]["properties"] == {"label": "v1"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_diff.py -v -k "journal_only or byte_identically or over_cap or undo_commit"`
Expected: `test_diff_is_journal_only_when_states_are_present` and `test_undo_commit_diff_is_journal_only` FAIL (500 — the reader still reconstructs and hits `boom`); the other two PASS already (they exercise today's path) and must keep passing.

- [ ] **Step 3: Rewrite the model half of `commit_diff.py`**

(a) Replace the module docstring's first paragraph ("Model entities: reconstruct the model at rev-1 and rev ... like the model-at-rev endpoint.") with:

```
Model entities: journal-only when the commit row carries ``entity_states``
— the full before/after state of every entity the batch touched, captured
at commit time (``commit_states``) because the inverse ops alone cannot
render a ``modified`` entry: an update's inverse patch carries only the
touched keys, never the whole entity. A row without it (written before the
column existed, or a batch over ``ENTITY_STATES_MAX``) falls back to
reconstructing the model at rev-1 and rev (same machinery and cost class as
GET /commits/{rev}/model) and comparing only the ids the commit's ops name.
Both paths feed the same renderer, so the output is identical.
```

(b) Imports: replace `from data_rover.core.model.element import Element` / `from data_rover.core.model.relationship import Relationship` with `from data_rover.core.model.model import Model`, and add:

```python
from .commit_states import ElementPair, EntityStates, RelationshipPair, load_entity_states
```

(c) Replace `_element_diffs` and `_relationship_diffs` (`:203-236`) with the pair-based renderers plus the reconstruction adapter:

```python
def _element_diffs(states: Mapping[str, ElementPair]) -> CrElementOps:
    out = CrElementOps()
    for eid in sorted(states):
        bo, ao = states[eid]
        if bo is None and ao is not None:
            out.added.append(ao)
        elif bo is not None and ao is None:
            out.deleted.append(bo)
        elif bo is not None and ao is not None and bo != ao:
            out.modified.append(ModifiedElementOut(id=eid, before=bo, after=ao))
    return out


def _relationship_diffs(states: Mapping[str, RelationshipPair]) -> CrRelationshipOps:
    out = CrRelationshipOps()
    for rid in sorted(states):
        bo, ao = states[rid]
        if bo is None and ao is not None:
            out.added.append(ao)
        elif bo is not None and ao is None:
            out.deleted.append(bo)
        elif bo is not None and ao is not None and bo != ao:
            out.modified.append(ModifiedRelationshipOut(id=rid, before=bo, after=ao))
    return out


def _states_from_models(
    el_ids: set[str],
    rel_ids: set[str],
    before: Model | None,
    after: Model | None,
) -> EntityStates:
    """The reconstruction fallback's input: pairs for exactly the ids the
    commit's ops name, read off two throwaway models (None = contentless)."""
    b_el = before.elements if before is not None else {}
    a_el = after.elements if after is not None else {}
    b_rel = before.relationships if before is not None else {}
    a_rel = after.relationships if after is not None else {}
    elements: dict[str, ElementPair] = {}
    for eid in el_ids:
        b, a = b_el.get(eid), a_el.get(eid)
        elements[eid] = (
            ElementOut.from_core(b) if b is not None else None,
            ElementOut.from_core(a) if a is not None else None,
        )
    relationships: dict[str, RelationshipPair] = {}
    for rid in rel_ids:
        b, a = b_rel.get(rid), a_rel.get(rid)
        relationships[rid] = (
            RelationshipOut.from_core(b) if b is not None else None,
            RelationshipOut.from_core(a) if a is not None else None,
        )
    return EntityStates(elements=elements, relationships=relationships)
```

Add `from collections.abc import Mapping` to the imports.

(d) In `diff_commit`, replace the block from `raw = [*commit.ops, *commit.inverse_ops]` through the `if m_after is not None: a_el, a_rel = ...` lines with:

```python
    if commit.entity_states is not None:
        states = load_entity_states(commit.entity_states)
    else:
        raw = [*commit.ops, *commit.inverse_ops]
        el_ids = _entity_ids(raw, _EL_KINDS)
        rel_ids = _entity_ids(raw, _REL_KINDS)
        m_before = m_after = None
        if el_ids or rel_ids:
            m_before = reconstruct_model_at(project_id, commit.rev - 1)
            m_after = reconstruct_model_at(project_id, commit.rev)
        states = _states_from_models(el_ids, rel_ids, m_before, m_after)
```

and the two renderer calls in the return become `elements=_element_diffs(states.elements)` / `relationships=_relationship_diffs(states.relationships)`. Update `diff_commit`'s docstring first sentence group: "model entities are read from the row's captured ``entity_states`` when present and reconstructed at rev-1 and rev only for rows without them (pre-column rows, over-cap batches)"; keep the short-circuit paragraph, rephrased so it applies to the fallback branch only.

(e) `routes/commits.py` `commit_diff_endpoint` docstring: replace "O(model) like GET /commits/{rev}/model, since the model half reconstructs both sides; the artifact half is journal-only." with "O(commit) for rows that carry ``entity_states`` (every commit written since the column exists); a row without them reconstructs both sides like GET /commits/{rev}/model."

- [ ] **Step 4: Run the diff tests**

Run: `pixi run -e core-dev pytest tests/api/test_commit_diff.py tests/api/test_commit_states.py tests/api/test_reconstruct.py tests/api/test_commit_model_at.py tests/api/test_artifact_bundle_routes.py -q`
Expected: PASS (the pre-existing diff tests now run through the journal path and must be unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/commit_diff.py src/data_rover/api/routes/commits.py tests/api/test_commit_diff.py
git commit -m "perf(history): render GET /commits/{rev}/diff from the journal row; reconstruct only on NULL"
```

---

### Task 5: Frontend — the per-commit Diff uses `GET /commits/{rev}/diff`

**Files:**
- Modify: `frontend/src/lib/api/types.ts:645-684` (extract `CrOpsSchema`, add `CommitDiffSchema`)
- Modify: `frontend/src/lib/api/history.ts` (add `getCommitDiff`)
- Modify: `frontend/src/lib/state/cr.ts:243` (`crToDiff` input type)
- Modify: `frontend/src/lib/components/HistoryDrawer.svelte:37-66`
- Test: `frontend/src/lib/api/__tests__/history.test.ts`, `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`

**Interfaces:**
- Consumes: the unchanged `CommitDiffOut` wire shape (`elements`/`relationships` in `CrElementOps`/`CrRelationshipOps` form).
- Produces: `CommitDiffSchema` / `type CommitDiff` in `types.ts`; `getCommitDiff(rev: number, cfg?: ClientConfig): Promise<CommitDiff>` in `api/history.ts`; `crToDiff(cr: Pick<ChangeRequest, 'ops'>): Diff`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/api/__tests__/history.test.ts` inside the `describe('history api', ...)` block (and add `getCommitDiff` to the import from `'../history'`):

```ts
	it('getCommitDiff hits /commits/{rev}/diff and parses the model half', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await getCommitDiff(4, {
			fetch: jsonFetch(cap, {
				rev: 4,
				commit_id: 'c4',
				author_id: null,
				ts: '2026-01-01T00:00:00Z',
				message: '',
				scope: ['model'],
				is_rebind: false,
				elements: {
					added: [{ id: 'e1', type_name: 'Node', properties: { label: 'A' }, rev: 1 }],
					modified: [],
					deleted: []
				},
				relationships: { added: [], modified: [], deleted: [] },
				artifacts: { added: [], modified: [], deleted: [] },
				view: [],
				metamodel: null,
				layout_moves: []
			})
		});
		expect(cap.path).toContain('/commits/4/diff');
		expect(res.elements.added.map((e) => e.id)).toEqual(['e1']);
		expect(res.scope).toEqual(['model']);
	});
```

In `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`:

(a) extend the `$lib/api/history` mock and import:

```ts
vi.mock('$lib/api/history', async (orig) => {
	const actual = await orig<typeof import('$lib/api/history')>();
	return { ...actual, revertToCommit: vi.fn(), getCommitDiff: vi.fn() };
});
...
import { getCommitDiff, revertToCommit } from '$lib/api/history';
```

(b) replace the body of `describe('HistoryDrawer diff', ...)` with:

```ts
describe('HistoryDrawer diff', () => {
	it('renders a per-commit diff from GET /commits/{rev}/diff — no reconstruction', async () => {
		vi.mocked(getCommitDiff).mockResolvedValue({
			rev: 2,
			commit_id: 'c2',
			scope: ['model'],
			is_rebind: false,
			elements: {
				added: [{ id: 'e1', type_name: 'Node', properties: { label: 'A' }, rev: 2 }],
				modified: [],
				deleted: []
			},
			relationships: { added: [], modified: [], deleted: [] }
		});
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		const btn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Diff')
		)!;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(getCommitDiff).toHaveBeenCalledWith(2);
		expect(modelAt).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain('+1 added');
		unmount(c);
	});

	it('the two-revision Compare still reconstructs both sides', async () => {
		vi.mocked(modelAt).mockImplementation(async (rev: number) =>
			rev <= 1
				? { elements: [], relationships: [] }
				: {
						elements: [{ id: 'e1', type_name: 'Node', properties: { label: 'A' }, rev: 2 }],
						relationships: []
					}
		);
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		const buttons = () => Array.from(document.querySelectorAll('button'));
		buttons()
			.find((b) => b.textContent?.trim() === 'Compare')!
			.click();
		flushSync();
		buttons()
			.find((b) => b.textContent?.trim() === 'Select B')!
			.click();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(modelAt).toHaveBeenCalledWith(1);
		expect(modelAt).toHaveBeenCalledWith(2);
		expect(getCommitDiff).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain('+1 added');
		unmount(c);
	});
});
```

- [ ] **Step 2: Run the two test files to verify they fail**

Run: `pixi run -e frontend bash -c "cd frontend && npx vitest run src/lib/api/__tests__/history.test.ts src/lib/components/__tests__/HistoryDrawer.test.ts"`
Expected: FAIL — `getCommitDiff` is not exported (the api test errors at import; the drawer test's `getCommitDiff` mock is never called).

- [ ] **Step 3: Schema + client**

In `frontend/src/lib/api/types.ts`, right after `ModifiedRelationshipSchema` (`:651-655`) add the shared CR ops schema and use it in `ChangesDocSchema`:

```ts
/** The six op buckets a change request / commit diff carries per entity kind
 * (`CrOps` on the server). */
export const CrOpsSchema = z.object({
	elements: z.object({
		added: z.array(ElementSchema).default([]),
		modified: z.array(ModifiedElementSchema).default([]),
		deleted: z.array(ElementSchema).default([])
	}),
	relationships: z.object({
		added: z.array(RelationshipSchema).default([]),
		modified: z.array(ModifiedRelationshipSchema).default([]),
		deleted: z.array(RelationshipSchema).default([])
	})
});
export type CrOps = z.infer<typeof CrOpsSchema>;
```

and in `ChangesDocSchema` replace the inline `ops: z.object({ elements: ..., relationships: ... })` literal with `ops: CrOpsSchema,`.

Then, right after `CommitHistoryResponseSchema` (`:817-821`):

```ts
/**
 * GET /commits/{rev}/diff — the model half only. The server also ships
 * artifact/view/metamodel sections; zod strips what is not declared here, so
 * adding a section later is a schema change, not a parse failure.
 */
export const CommitDiffSchema = z.object({
	rev: z.number(),
	commit_id: z.string(),
	scope: z.array(z.string()).default([]),
	is_rebind: z.boolean().default(false),
	elements: CrOpsSchema.shape.elements,
	relationships: CrOpsSchema.shape.relationships
});
export type CommitDiff = z.infer<typeof CommitDiffSchema>;
```

In `frontend/src/lib/api/history.ts`, add to the `./types` import `CommitDiffSchema, type CommitDiff` and append:

```ts
/** GET /commits/{rev}/diff — one commit's changes, rendered by the server
 * from the journal row (no model reconstruction on either side). */
export function getCommitDiff(rev: number, cfg?: ClientConfig): Promise<CommitDiff> {
	return apiFetch(`/commits/${rev}/diff`, { method: 'GET', schema: CommitDiffSchema }, cfg);
}
```

In `frontend/src/lib/state/cr.ts`, change the signature only: `export function crToDiff(cr: Pick<ChangeRequest, 'ops'>): Diff {` (the body reads nothing but `cr.ops`).

- [ ] **Step 4: Split `showDiff` in `HistoryDrawer.svelte`**

Replace the imports `import { revertToCommit } from '$lib/api/history';` with `import { getCommitDiff, revertToCommit } from '$lib/api/history';` and add `import { crToDiff } from '$lib/state/cr';`. Replace `showDiff`, `diffCommit` and the `pickCompare` call site (`:37-66`) with:

```ts
	function beginDiff(title: string, crossesRebind: boolean): void {
		mode = 'diff';
		diff = null;
		diffError = null;
		diffTitle = title;
		spanRebind = crossesRebind;
	}

	// One commit: the server renders it from the journal row, so the cost
	// tracks the commit, not the model.
	async function showCommitDiff(rev: number): Promise<void> {
		beginDiff(`Changes in r${rev}`, spanCrossesRebind(rev - 1, rev));
		try {
			const d = await getCommitDiff(rev);
			diff = crToDiff({ ops: { elements: d.elements, relationships: d.relationships } });
		} catch (e) {
			diffError = e instanceof Error ? e.message : 'Failed to load diff';
		}
	}

	// Two arbitrary revisions: both sides are reconstructed on the server and
	// diffed here — inherently O(model).
	async function showRangeDiff(fromRev: number, toRev: number): Promise<void> {
		beginDiff(`r${fromRev} → r${toRev}`, spanCrossesRebind(fromRev, toRev));
		try {
			const [from, to] = await Promise.all([modelAt(fromRev), modelAt(toRev)]);
			diff = computeDiff(from, to);
		} catch (e) {
			diffError = e instanceof Error ? e.message : 'Failed to load diff';
		}
	}

	function diffCommit(rev: number): void {
		void showCommitDiff(rev);
	}
```

and in `pickCompare` replace `void showDiff(lo, hi, \`r${lo} → r${hi}\`);` with `void showRangeDiff(lo, hi);`.

- [ ] **Step 5: Run the frontend tests and checks**

Run: `pixi run -e frontend bash -c "cd frontend && npx vitest run src/lib/api/__tests__/history.test.ts src/lib/components/__tests__/HistoryDrawer.test.ts src/lib/state/__tests__/history.test.ts"`
Expected: PASS.

Run: `pixi run frontend-check`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/history.ts frontend/src/lib/state/cr.ts frontend/src/lib/components/HistoryDrawer.svelte frontend/src/lib/api/__tests__/history.test.ts frontend/src/lib/components/__tests__/HistoryDrawer.test.ts
git commit -m "perf(history): per-commit Diff reads GET /commits/{rev}/diff instead of reconstructing twice"
```

---

### Task 6: Docs and backlog

**Files:**
- Modify: `CLAUDE.md:138` (the "Artifact ops" bullet's `GET /commits/{rev}/diff` clause) and the "Durable persistence" section (new bullet after the `POST /model/ops` appends-a-Commit bullet)
- Modify: `frontend/README.md:1087-1092` ("Per-commit diff") and `:1634-1636` (state-model listing of `history.svelte.ts`)
- Modify: `BACKLOG.md:807` (K-6), header `:29-30`

- [ ] **Step 1: CLAUDE.md**

(a) In the "Artifact ops" bullet (`:138`), replace "and `GET /commits/{rev}/diff` can render them journal-only alongside model entities' before/after reconstruction (`api/commit_diff.py`)" with "and `GET /commits/{rev}/diff` can render them journal-only, like the model half (`api/commit_diff.py`)".

(b) In "Durable persistence", after the bullet starting "**`POST /model/ops`** appends a `Commit` and bumps `models.model_rev`", add:

```markdown
- **`Commit.entity_states`** (nullable JSON) is the full before/after state of every model
  entity a batch touched, captured by every journal writer (`POST /commits`, `/commits/revert`,
  `/model/ops`, `/model/undo`) via `api/commit_states.capture_entity_states` — the applier
  snapshots each entity on first touch (`_BatchResult.before_*`), the post-state is read off the
  live model right before `_persist_commit`. It exists because the inverse ops cannot render a
  `modified` diff entry (an update's inverse patch carries only the touched keys).
  `GET /commits/{rev}/diff` renders the model half from it and reconstructs the model at
  rev-1/rev **only** when it is `NULL` (rows older than the column, or a batch over
  `ENTITY_STATES_MAX` = 5000 touched entities). Baseline rows (`persist_baseline`, the importer)
  store `NULL` on purpose. The frontend's per-commit Diff calls this route; its two-revision
  Compare still uses `GET /commits/{rev}/model`, which stays O(model) by design.
```

- [ ] **Step 2: frontend/README.md**

(a) Replace the "Per-commit diff" bullet (`:1087-1092`) with:

```markdown
- **Per-commit diff** — clicking a row's "Diff" button fetches
  `GET /commits/{rev}/diff` (`getCommitDiff`), which the server renders from
  the commit row's captured entity states — no model reconstruction on either
  side — and converts it with `crToDiff` for `CompareDiff`, so the click costs
  O(commit) regardless of model size.
```

(b) In the "Two-commit compare" bullet keep the text but make the cost explicit: append "This path is O(model) by design; only the per-commit Diff is journal-backed."

(c) In the state-model listing (`:1634-1636`) change "rev→ModelOut reconstruction cache" to "rev→ModelOut reconstruction cache (Compare only; the per-commit Diff bypasses it)".

- [ ] **Step 3: BACKLOG.md**

(a) Change the K-6 heading to:

`### K-6 · History diff is slow on a big model · \`done\` (2026-08-26, perf/journal-only-history-diff) · owner-reported · *2026-08-12*`

and prepend this paragraph to its body (keep the existing text below it — the measurement and the owner's proposal remain the record of why):

```markdown
Closed as the owner proposed, one step further: instead of a reference list, every journal
writer stores the touched entities' FULL before/after state on the row (`Commit.entity_states`,
nullable JSON, capped at `ENTITY_STATES_MAX` = 5000 touched entities → NULL → reconstruction
fallback, alembic `0013`), because a reference list alone cannot render `modified` — the
inverse patch only carries touched keys. `GET /commits/{rev}/diff` is now O(commit); the
frontend's per-commit Diff was switched to it (it previously fetched `GET /commits/{rev}/model`
twice and diffed client-side, so the backend route had no app caller). Measured at 320k:
<fill in Task 7's two numbers>. The two-revision Compare still reconstructs (O(model), deferred
by design). Baseline rows keep NULL. Also folds the "backfill or tolerate NULL" question: NULL is
tolerated, never backfilled.
```

(b) Update the header line (`:29`) `Last updated: ... repo head at time of writing: ...` to name this branch's head after the final commit, and mention "K-6 done (journal-only history diff)".

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md frontend/README.md BACKLOG.md
git commit -m "docs: journal-only history diff — CLAUDE.md, frontend README, backlog (K-6 done)"
```

---

### Task 7: Full verification, measurement, and integration

**Files:** none new (the measurement script lives in the session scratchpad).

- [ ] **Step 1: Lint/format/typecheck**

Run: `pixi run dr-tidy`
Expected: ruff, mypy, pyright, prettier and eslint all pass. Fix anything reported (typical: an unused import left in `commit_diff.py` after the `Element`/`Relationship` → `Model` swap; the `Mapping` import; prettier line wraps in `HistoryDrawer.svelte`) and amend into the relevant commit or add a `chore:` commit.

- [ ] **Step 2: Whole suites**

Run: `pixi run core-test`
Expected: PASS, count ≥ 2152 + the new tests (Task 1: 2, Task 2: 8, Task 3: 5, Task 4: 4), zero new skips.

Run: `pixi run frontend-test`
Expected: PASS.

Run: `pixi run -e frontend bash -c "cd frontend && npx playwright test e2e/history.spec.ts"`
Expected: 1 passed (the spec clicks the real Diff button; it now exercises the journal route end-to-end). If the environment cannot boot the e2e stack (Playwright browsers missing, no Postgres), record that verbatim in the recap rather than skipping silently — the vitest drawer tests cover the click path.

- [ ] **Step 3: Measure the win on the 320k fixture**

Regenerate the production-scale fixture into the scratchpad and time both diff paths through the real app (in-memory SQLite + memory snapshot store, exactly the API conftest's environment, hydration made synchronous so background sweeps do not compete for the GIL during the timing):

```bash
pixi run -e core-dev python examples/generate_large_model.py --scale 320 --out "$SCRATCH/prod.model.json"
pixi run -e core-dev python - <<'EOF'
import os, resource, sys, time
os.environ.update({
    "DATA_ROVER_DATABASE_URL": "sqlite://", "DATA_ROVER_DEV_SEED": "false",
    "DATA_ROVER_SNAPSHOT_STORE": "memory", "DATA_ROVER_IDLE_EVICT_SECONDS": "0",
    "DATA_ROVER_LOCK_SWEEP_SECONDS": "0", "DATA_ROVER_VALIDATION_SWEEP_SYNC": "true",
    "DATA_ROVER_SEARCH_INDEX_SYNC": "true", "DATA_ROVER_IDENTITY_PROVIDER": "header",
    "DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL": "", "DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD": "",
})
sys.path.insert(0, "src")
SCRATCH = os.environ["SCRATCH"]
from fastapi.testclient import TestClient
from data_rover.api import content, db, db_models  # noqa: F401
from data_rover.api.db import db_session
from data_rover.api.importer import import_project
from data_rover.api.lock_mirror import MemoryLeaseMirror, set_lease_mirror
from data_rover.api.main import create_app
from data_rover.api.session import install_persistent_registry
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store

db.init_engine("sqlite://"); db.create_all()
set_snapshot_store(MemorySnapshotStore()); set_lease_mirror(MemoryLeaseMirror())
install_persistent_registry()
import_project(project_id="big", name="big", owner_id="u1",
               metamodel_yaml=open("examples/smart-city.metamodel.yaml").read(),
               model_json=open(f"{SCRATCH}/prod.model.json").read())
c = TestClient(create_app()); c.headers.update({"x-user-id": "u1", "x-user-email": "u1@example.com"})
P = "/api/v1/projects/big"
t0 = time.perf_counter(); rev = c.get(f"{P}/model/summary").json()["model_rev"]
print(f"hydrate: {time.perf_counter()-t0:.1f}s  rev={rev}")
el = c.get(f"{P}/model/elements", params={"limit": 1}).json()["items"][0]
key = next(iter(el["properties"]))
tok = c.post(f"{P}/locks", json={"targets": [{"resource_id": el["id"], "mode": "exclusive", "type": "element"}], "intent": "edit"}).json()["token"]
r = c.post(f"{P}/commits", json={"base_rev": rev, "ops": [{"kind": "update_element", "id": el["id"], "properties_patch": {key: "bench"}}], "lock_tokens": [tok]})
assert r.status_code == 200, r.text
rev = r.json()["model_rev"]
rss0 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
t0 = time.perf_counter(); d = c.get(f"{P}/commits/{rev}/diff"); t_journal = time.perf_counter() - t0
assert d.status_code == 200 and len(d.json()["elements"]["modified"]) == 1, d.text
print(f"diff (journal):        {t_journal*1000:.0f} ms   maxrss {rss0:.0f} MB")
with db_session() as s:
    row = content.get_commit(s, "big", rev); assert row is not None; row.entity_states = None
t0 = time.perf_counter(); d = c.get(f"{P}/commits/{rev}/diff"); t_recon = time.perf_counter() - t0
rss1 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
assert d.status_code == 200 and len(d.json()["elements"]["modified"]) == 1, d.text
print(f"diff (reconstruction): {t_recon:.1f} s   maxrss {rss1:.0f} MB (+{rss1-rss0:.0f} MB transient)")
EOF
```

(`SCRATCH` = the session scratchpad directory from the system prompt; export it before running.) Expected: journal path in the low tens of milliseconds; reconstruction ≈ 2 × (3 s parse + 8 s build) ≈ 20–25 s with +1–2 GB `maxrss` growth. Put both numbers into the BACKLOG K-6 paragraph's `<fill in ...>` placeholder (amend the Task 6 docs commit) and into the merge commit message.

- [ ] **Step 4: Integrate**

Use `superpowers:finishing-a-development-branch`: merge `perf/journal-only-history-diff` into `main` with a merge commit (repo convention), push `main` (standing policy, `BACKLOG.md:1225`), and remove the worktree.

---

### Task 8: Hand off to the next plan (K-21 — compressed, compact snapshots)

**Files:** none in the repo (the handoff lives in `~/.claude/handoffs/`).

- [ ] **Step 1: Reconstruct state**

Run: `git status --short && git branch --show-current && git log --oneline -5 && pixi run core-test -q | tail -3`

- [ ] **Step 2: Invoke the handoff skill**

Invoke `handoff` (the `Skill` tool, name `handoff`). Fill its sections with these facts (pointers, not payload):

- **Mission:** the large-model performance program from `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program"); K-20 and K-6 are merged; the next session writes and executes the plan for **K-21** (compressed, compact snapshots: `.json.gz`, compact JSON, read path branching on key/encoding; then re-measure whether the every-200-commits synchronous snapshot in `routes/ops.py::_maybe_periodic_snapshot` must leave the commit's critical section), then hands off to K-22, and so on down the program list — every plan's last task is this same handoff step.
- **Orient First:** the spec above; `BACKLOG.md` K-21 → K-25 (with measurements); `src/data_rover/api/hydration.py` (`write_snapshot` `:75-82`, `reconstruct_model_at`, `_hydrate_session`'s download/parse phases); `src/data_rover/api/storage.py` / `storage_gcs.py` (the `SnapshotStore` seam — `put` takes an iterator of byte chunks, `get` returns bytes; the key format is `snapshot_key(project_id, rev)`); `src/data_rover/api/serialize.py` (`iter_model_json`, the indented streaming writer); `src/data_rover/api/routes/_snapshot.py::build_model_from_dicts`; `tests/api/test_hydration.py`, `tests/api/test_storage*.py`; this plan (`docs/superpowers/plans/2026-08-26-journal-only-history-diff.md`) as the shape to match.
- **Standing Constraints:** K-20 (no search index on transient models; `keep_search=True` only at the four rebind sites); K-6 (`Commit.entity_states` NULL = reconstruct, never backfilled; `GET /commits/{rev}/model` and the Compare path stay reconstruction-based); existing snapshot rows/keys must keep loading (the read path must accept both the old indented `.json` and the new compressed key — never a migration that rewrites blobs); `docs/` gitignored; pixi for everything; merge-commit integration; `pixi run frontend-install` before `dr-tidy` in a fresh worktree.
- **Known Issues, Not Yet Fixed:** K-21 → K-25 as listed in the BACKLOG; `scripts/bench.py:208` pyright note (pre-existing, invisible to `dr-tidy`).
- **Plan:** 1. `superpowers:writing-plans` for K-21 (`docs/superpowers/plans/<date>-compressed-snapshots.md`). 2. Execute with `superpowers:subagent-driven-development` on `perf/compressed-snapshots`. 3. Run the pre-flight conflict scan checking each task's *test preconditions* against what earlier tasks install.
- **Open Questions:** none, unless Task 7's measurement showed the reconstruction fallback still mattering in practice (e.g. large subtree deletes routinely exceeding `ENTITY_STATES_MAX`) — record the observed touched-count distribution if so.

- [ ] **Step 3: Deliver**

Reply exactly as the handoff skill prescribes: the file path, the one-line paste command, and the full handoff in one fenced block.
