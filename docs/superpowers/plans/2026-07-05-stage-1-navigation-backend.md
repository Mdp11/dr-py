# Stage 1 Navigation Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend half of Stage 1 (spec: `docs/superpowers/specs/2026-07-05-stage-1-navigation-engine-builder-design.md`): a pure navigation-chain evaluator in `core/`, the `project_artifacts` storage layer, an artifacts CRUD router, and `POST /navigations/evaluate`.

**Architecture:** The search criterion models move from `api/search.py` down into `core/search/criteria.py` (wire format unchanged) so the new `core/navigation/` package can reuse them. The evaluator is pure/read-only over `(Metamodel, Model)` using `model.indexes` adjacency and two new `Metamodel` caches. Artifacts are plain DB rows (ViewRow precedent): optimistic `artifact_rev`, no leases, no commits, `artifact_event` on the FeedHub.

**Tech Stack:** Python 3.14 (pyright floor 3.10), Pydantic v2, FastAPI, SQLAlchemy 2.0, Alembic, pytest.

## Global Constraints

- Run everything through pixi: tests `pixi run -e core-dev pytest <path> -v`, lint `pixi run lint-core` and `pixi run lint-backend` (ruff + mypy + pyright must ALL pass).
- Import as `from data_rover. ...` (pytest.ini sets `pythonpath=src`).
- Don't use stdlib typing features newer than Python 3.10 (`assert_never`/`Self` come from `typing_extensions` if needed).
- API tests need no DB service — `tests/api/conftest.py` runs in-memory SQLite; every project-scoped request needs `AUTH_HEADERS` and `seed_default_project()`.
- `Metamodel` is immutable with lazily-built `_Caches`; `IndexSet` accessors return live views — never mutate them; evaluation code must never scan `model.elements`/`model.relationships` when an index exists.
- Preserve the dense-docstring style: new modules explain *why* invariants exist.
- Commit after every green task with the trailer lines used in this repo (Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>).

---

### Task 1: Lift search criteria into `core/search/criteria.py`

The advanced-search criterion models and matchers currently live in `src/data_rover/api/search.py:38-305`. The navigation engine (core layer) must reuse them without importing from the API layer. Move them down; `api/search.py` re-imports so its public surface and the `/model/search` wire format stay byte-identical.

**Files:**
- Create: `src/data_rover/core/search/__init__.py`
- Create: `src/data_rover/core/search/criteria.py`
- Modify: `src/data_rover/api/search.py`
- Test: `tests/api/test_search_routes.py` (existing — must stay green), `tests/core_search/` not needed (moved code keeps its existing coverage)

**Interfaces:**
- Produces: `core.search.criteria` exporting `Direction`, `EntityTypeCriterion`, `PropertyCriterion`, `NameIdCriterion`, `RelationCountCriterion`, `OrphanCriterion`, `ConnectedToTypeCriterion`, `EndpointTypeCriterion`, `Criterion` (annotated union), `match_element(model, e, c) -> bool`, `match_relationship(model, r, c) -> bool`, `name_prop(props) -> str | None`.
- Consumed by: Task 3 (schema imports `Criterion`), Task 5 (evaluator imports `match_element`).

- [ ] **Step 1: Create `core/search/` package with the moved code**

`src/data_rover/core/search/__init__.py`:

```python
```

(empty file, matching `core/view/__init__.py` style — check that file first and mirror it if it re-exports).

`src/data_rover/core/search/criteria.py` — move, verbatim, from `api/search.py`: the module-docstring paragraphs about JS-parity coercion, `Direction` (line 38), the seven criterion classes and the `Criterion` union (lines 46-113), `_MISSING`, `_js_str`, `_nullish_str`, `_to_number`, `_safe_regex` (lines 138-189), `_name_prop` → renamed **`name_prop`** (public; `read.py`'s `_display_name` docstring references the same semantics), `_rels_for` (lines 249-259), and `_match_element`/`_match_relationship` → renamed **`match_element`**/**`match_relationship`** (public). Imports at top:

```python
from __future__ import annotations

import math
import re
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
```

Add a module docstring stating the layering rule this move creates:

```python
"""Shared entity-filter vocabulary: criterion models + matchers.

Historically these lived in ``api/search.py``; they moved to core so the
navigation engine (``core/navigation``) can filter start sets and hop targets
with the exact same semantics (and wire format) as ``POST /model/search``.
``api/search.py`` re-exports everything, so the API surface is unchanged.
Matching is pure and O(criteria) per entity; relationship-aware criteria go
through ``model.indexes``, never a scan.
"""
```

- [ ] **Step 2: Rewrite `api/search.py` to delegate**

Keep in `api/search.py`: its module docstring, `_MAX_LIMIT`, `SearchQueryIn`, `SearchResultPage`, `run_query`. Replace the moved block with:

```python
from data_rover.core.search.criteria import (
    ConnectedToTypeCriterion,
    Criterion,
    Direction,
    EndpointTypeCriterion,
    EntityTypeCriterion,
    NameIdCriterion,
    OrphanCriterion,
    PropertyCriterion,
    RelationCountCriterion,
    match_element,
    match_relationship,
)

__all__ = [
    "ConnectedToTypeCriterion", "Criterion", "Direction",
    "EndpointTypeCriterion", "EntityTypeCriterion", "NameIdCriterion",
    "OrphanCriterion", "PropertyCriterion", "RelationCountCriterion",
    "SearchQueryIn", "SearchResultPage", "run_query",
]
```

and change `run_query`'s body to call `match_element` / `match_relationship` instead of `_match_element` / `_match_relationship`. Delete the moved definitions. Note `ruff` will flag unused re-imports without the `__all__` — keep it.

- [ ] **Step 3: Run the full existing test suite to prove the move is invisible**

Run: `pixi run -e core-dev pytest tests/api -v -k "search"`
Expected: all existing search tests PASS unchanged.

Run: `pixi run -e core-dev pytest tests -x -q`
Expected: full suite PASS (no other module imported the moved privates).

- [ ] **Step 4: Lint**

Run: `pixi run lint-core && pixi run lint-backend`
Expected: ruff, mypy, pyright all clean.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/search src/data_rover/api/search.py
git commit -m "refactor(core): lift search criteria + matchers into core/search"
```

---

### Task 2: Metamodel caches — `element_descendants` + `relationship_types_from/to`

`elements_by_type` on `IndexSet` is exact-type only and `Metamodel` only caches the *ancestor* direction. The evaluator needs subtype-inclusive start sets; the hop machinery needs "which relationship types attach to type X".

**Files:**
- Modify: `src/data_rover/core/metamodel/schema.py` (`_Caches` at :148, `_build_caches` at :244, `Metamodel` methods after :389)
- Test: `tests/metamodel/test_navigation_caches.py` (create)

**Interfaces:**
- Produces: `Metamodel.element_descendants(name: str) -> frozenset[str]` (self + all subtypes; empty frozenset for unknown names), `Metamodel.relationship_types_from(name: str) -> list[str]` (non-abstract rel types with a mapping whose source matches the type or an ancestor), `Metamodel.relationship_types_to(name: str) -> list[str]` (same for target).
- Consumes: existing `element_ancestor_sets` internals.

- [ ] **Step 1: Write the failing tests**

`tests/metamodel/test_navigation_caches.py`:

```python
"""Tests for the navigation-support caches on Metamodel:

- element_descendants: the DOWNWARD closure (self + subtypes), inverting the
  cached ancestor sets. Abstract types are included (a scope naming an
  abstract type must expand to its concrete subtypes' instances).
- relationship_types_from/to: non-abstract relationship types whose mappings
  accept the element type (or an ancestor) as source/target respectively.
  Abstract relationship types contribute nothing (they cannot be instantiated).
"""

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    RelationshipType,
)


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(name="Base", abstract=True),
            ElementType(name="Block", extends="Base"),
            ElementType(name="Sensor", extends="Block"),
            ElementType(name="Other"),
        ],
        relationships=[
            RelationshipType(name="AbsRel", abstract=True, source="Block", target="Block"),
            RelationshipType(name="HasPart", source="Block", target="Block"),
            RelationshipType(name="Feeds", source="Sensor", target="Other"),
            RelationshipType(name="Owns", source="Base", target="Other"),
        ],
    )


def test_descendants_include_self_and_transitive_subtypes() -> None:
    mm = _mm()
    assert mm.element_descendants("Base") == frozenset({"Base", "Block", "Sensor"})
    assert mm.element_descendants("Block") == frozenset({"Block", "Sensor"})
    assert mm.element_descendants("Sensor") == frozenset({"Sensor"})
    assert mm.element_descendants("Other") == frozenset({"Other"})


def test_descendants_unknown_type_is_empty() -> None:
    assert _mm().element_descendants("Nope") == frozenset()


def test_relationship_types_from_matches_ancestors() -> None:
    mm = _mm()
    # Sensor is a Block and a Base: HasPart (source Block), Feeds (source
    # Sensor), Owns (source Base) — but never the abstract AbsRel.
    assert sorted(mm.relationship_types_from("Sensor")) == ["Feeds", "HasPart", "Owns"]
    assert sorted(mm.relationship_types_from("Block")) == ["HasPart", "Owns"]
    assert mm.relationship_types_from("Other") == []


def test_relationship_types_to_matches_ancestors() -> None:
    mm = _mm()
    assert sorted(mm.relationship_types_to("Other")) == ["Feeds", "Owns"]
    assert sorted(mm.relationship_types_to("Sensor")) == ["HasPart"]
    assert mm.relationship_types_to("Base") == []  # abstract, no instances but
    # the cache is name-based: Base IS a mapping target nowhere, hence empty.


def test_unknown_type_rel_lookups_are_empty() -> None:
    mm = _mm()
    assert mm.relationship_types_from("Nope") == []
    assert mm.relationship_types_to("Nope") == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/metamodel/test_navigation_caches.py -v`
Expected: FAIL — `AttributeError: 'Metamodel' object has no attribute 'element_descendants'`.

- [ ] **Step 3: Implement the caches**

In `_Caches` (schema.py:148), add three fields after `end_constraints`:

```python
    element_descendants: dict[str, frozenset[str]]
    rel_types_from: dict[str, tuple[str, ...]]
    rel_types_to: dict[str, tuple[str, ...]]
```

In `_build_caches` (schema.py:244), before the `return _Caches(...)`:

```python
    # downward closure: invert the ancestor sets (self included on both sides)
    descendants: dict[str, set[str]] = {n: set() for n in types_by_name}
    for name, ancestors in element_ancestor_sets.items():
        for ancestor in ancestors:
            descendants[ancestor].add(name)

    # relationship types attachable to each element type, by end. Mirrors
    # _build_end_constraints' ancestor-set membership test but without the
    # multiplicity gating: this answers "what CAN attach", not "what binds".
    rel_types_from: dict[str, list[str]] = {n: [] for n in types_by_name}
    rel_types_to: dict[str, list[str]] = {n: [] for n in types_by_name}
    for rt in mm.relationships:
        if rt.abstract or not rt.mappings:
            continue
        mapping_sources = {m.source for m in rt.mappings}
        mapping_targets = {m.target for m in rt.mappings}
        for type_name, ancestors in element_ancestor_sets.items():
            if not mapping_sources.isdisjoint(ancestors):
                rel_types_from[type_name].append(rt.name)
            if not mapping_targets.isdisjoint(ancestors):
                rel_types_to[type_name].append(rt.name)
```

and pass to the constructor:

```python
        element_descendants={n: frozenset(s) for n, s in descendants.items()},
        rel_types_from={n: tuple(v) for n, v in rel_types_from.items()},
        rel_types_to={n: tuple(v) for n, v in rel_types_to.items()},
```

On `Metamodel` (after `end_constraints`, schema.py:389):

```python
    def element_descendants(self, name: str) -> frozenset[str]:
        """`name` plus every transitive subtype (empty for unknown names).

        The downward complement of `element_ancestors`; used to expand a
        navigation scope's type list over `IndexSet.elements_by_type`, which
        is exact-type keyed.
        """
        return self._caches().element_descendants.get(name, frozenset())

    def relationship_types_from(self, name: str) -> list[str]:
        """Non-abstract relationship types that accept `name` (or an
        ancestor) as a mapping SOURCE — i.e. valid outgoing hop types."""
        return list(self._caches().rel_types_from.get(name, ()))

    def relationship_types_to(self, name: str) -> list[str]:
        """Non-abstract relationship types that accept `name` (or an
        ancestor) as a mapping TARGET — i.e. valid incoming hop types."""
        return list(self._caches().rel_types_to.get(name, ()))
```

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/metamodel/test_navigation_caches.py tests/metamodel -v`
Expected: new tests PASS; all existing metamodel tests PASS (the `_Caches.__eq__` override keeps equality unaffected).

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-core`

```bash
git add src/data_rover/core/metamodel/schema.py tests/metamodel/test_navigation_caches.py
git commit -m "feat(metamodel): cache element descendants + attachable relationship types"
```

---

### Task 3: `NavigationDefinition` schema (`core/navigation/schema.py`)

**Files:**
- Create: `src/data_rover/core/navigation/__init__.py` (empty)
- Create: `src/data_rover/core/navigation/schema.py`
- Test: `tests/navigation/__init__.py` (empty), `tests/navigation/test_schema.py`

**Interfaces:**
- Consumes: `Criterion` from Task 1.
- Produces: `Scope(kind="scope", types, criteria)`, `Step(relationship_type, direction, target, children)`, `PathNavigation(kind="path", schema_version, start, steps)`, `Operand(ref | definition, step_index)`, `SetExpression(kind="set_op", schema_version, op, operands)`, `NavigationDefinition` (discriminated union on `kind`), `NAVIGATION_ADAPTER: TypeAdapter[NavigationDefinition]`, constants `MAX_STEPS = 10`, `SCHEMA_VERSION = 1`. Chain convention (documented here, relied on by Tasks 5-6 and the API): **a chain includes the start element at index 0**, so a path with N steps yields chains of length N+1 and `step_index k` addresses `chain[k]` directly (`None` = terminal).

- [ ] **Step 1: Write the failing tests**

`tests/navigation/test_schema.py`:

```python
"""NavigationDefinition schema-shape tests: the format is branch-READY
(steps carry a `children` slot) but v1 is strictly LINEAR (children must be
empty), capped at MAX_STEPS, and set-operation operands carry exactly one of
`ref` (artifact id) / `definition` (inline)."""

import pytest
from pydantic import ValidationError

from data_rover.core.navigation.schema import (
    MAX_STEPS,
    NAVIGATION_ADAPTER,
    Operand,
    PathNavigation,
    Scope,
    SetExpression,
    Step,
)


def _path(n_steps: int = 1) -> dict:
    return {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Block"]},
        "steps": [{"relationship_type": "Owns"} for _ in range(n_steps)],
    }


def test_minimal_path_parses_with_defaults() -> None:
    nav = NAVIGATION_ADAPTER.validate_python(_path())
    assert isinstance(nav, PathNavigation)
    assert nav.schema_version == 1
    step = nav.steps[0]
    assert step.direction == "out"
    assert step.target == Scope()
    assert step.children == []


def test_children_rejected_in_v1() -> None:
    doc = _path()
    doc["steps"][0]["children"] = [{"relationship_type": "Feeds"}]
    with pytest.raises(ValidationError, match="branching"):
        NAVIGATION_ADAPTER.validate_python(doc)


def test_step_cap() -> None:
    with pytest.raises(ValidationError, match="at most"):
        NAVIGATION_ADAPTER.validate_python(_path(MAX_STEPS + 1))
    NAVIGATION_ADAPTER.validate_python(_path(MAX_STEPS))  # boundary OK


def test_set_expression_parses_and_nests() -> None:
    doc = {
        "kind": "set_op",
        "op": "intersection",
        "operands": [
            {"ref": "abc123"},
            {"definition": _path(), "step_index": 0},
            {"definition": {"kind": "set_op", "op": "union",
                            "operands": [{"ref": "def456"}]}},
        ],
    }
    expr = NAVIGATION_ADAPTER.validate_python(doc)
    assert isinstance(expr, SetExpression)
    assert expr.operands[0].ref == "abc123"
    assert isinstance(expr.operands[1].definition, PathNavigation)
    assert expr.operands[1].step_index == 0
    assert isinstance(expr.operands[2].definition, SetExpression)


def test_operand_needs_exactly_one_source() -> None:
    with pytest.raises(ValidationError, match="exactly one"):
        Operand()
    with pytest.raises(ValidationError, match="exactly one"):
        Operand(ref="a", definition=NAVIGATION_ADAPTER.validate_python(_path()))


def test_set_expression_requires_operands() -> None:
    with pytest.raises(ValidationError):
        NAVIGATION_ADAPTER.validate_python(
            {"kind": "set_op", "op": "union", "operands": []}
        )


def test_path_start_may_be_set_expression() -> None:
    doc = _path()
    doc["start"] = {"kind": "set_op", "op": "union", "operands": [{"ref": "a"}]}
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    assert isinstance(nav, PathNavigation)
    assert isinstance(nav.start, SetExpression)


def test_criteria_reuse_search_vocabulary() -> None:
    doc = _path()
    doc["start"]["criteria"] = [
        {"type": "property", "name": "status", "op": "equals", "value": "active"}
    ]
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    assert isinstance(nav, PathNavigation)
    assert isinstance(nav.start, Scope)
    assert nav.start.criteria[0].op == "equals"


def test_round_trip_preserves_document() -> None:
    doc = _path(2)
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    dumped = NAVIGATION_ADAPTER.dump_python(nav, mode="json")
    assert NAVIGATION_ADAPTER.validate_python(dumped) == nav
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/navigation/test_schema.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'data_rover.core.navigation'`.

- [ ] **Step 3: Implement the schema**

`src/data_rover/core/navigation/schema.py`:

```python
"""Navigation definitions: walk chains of relationships from a filtered
start set, or combine navigation results with set operations.

Format contract (Stage 1 of the navigation/tables/diagrams mega-plan):

- The document is VERSIONED (`schema_version`) and branch-READY: every step
  carries a `children` slot so branching can be added later without migrating
  saved artifacts — but v1 validation rejects non-empty `children` (linear
  chains only) and caps chains at MAX_STEPS.
- Filters reuse the advanced-search criterion vocabulary
  (`core.search.criteria`) verbatim, so a navigation filter and a search
  criterion are the same wire object.
- CHAIN CONVENTION: an evaluated chain includes its start element at index 0
  (a path with N steps yields chains of length N+1). `Operand.step_index`
  addresses that tuple directly: 0 = start elements, k = elements after step
  k, None = terminal step.
- Set operations act on ELEMENT SETS (the elements a navigation reaches at
  one step), never on chain tuples; `difference` is a left fold over the
  operand list.

Definitions are stored as `kind="navigation"` project artifacts; `Operand.ref`
holds such an artifact's id and is inlined by `core.navigation.resolve` before
evaluation (the evaluator itself never sees a ref).
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

from data_rover.core.search.criteria import Criterion

SCHEMA_VERSION = 1
#: hard ceiling on chain length; also the recursion depth of the evaluator.
MAX_STEPS = 10


class Scope(BaseModel):
    """An element filter: any of `types` (subtype-inclusive; empty = every
    type) AND all of `criteria`."""

    kind: Literal["scope"] = "scope"
    types: list[str] = Field(default_factory=list)
    criteria: list[Criterion] = Field(default_factory=list)


class Step(BaseModel):
    relationship_type: str
    direction: Literal["out", "in", "either"] = "out"
    target: Scope = Field(default_factory=Scope)
    #: reserved for post-Stage-1 branching; MUST be empty in schema v1.
    children: list["Step"] = Field(default_factory=list)

    @model_validator(mode="after")
    def _v1_is_linear(self) -> "Step":
        if self.children:
            raise ValueError(
                "branching steps (`children`) are not supported in schema v1"
            )
        return self


class PathNavigation(BaseModel):
    kind: Literal["path"]
    schema_version: int = SCHEMA_VERSION
    start: "StartNode"
    steps: list[Step] = Field(default_factory=list)

    @model_validator(mode="after")
    def _cap_steps(self) -> "PathNavigation":
        if len(self.steps) > MAX_STEPS:
            raise ValueError(f"a navigation may have at most {MAX_STEPS} steps")
        return self


class Operand(BaseModel):
    """One input to a set operation: a saved navigation (`ref` = artifact id)
    XOR an inline `definition`, contributing its elements at `step_index`
    (see the chain convention in the module docstring)."""

    ref: Optional[str] = None
    definition: Optional["NavigationDefinition"] = None
    step_index: Optional[int] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "Operand":
        if (self.ref is None) == (self.definition is None):
            raise ValueError("an operand needs exactly one of `ref` / `definition`")
        return self


class SetExpression(BaseModel):
    kind: Literal["set_op"]
    schema_version: int = SCHEMA_VERSION
    op: Literal["union", "intersection", "difference", "symmetric_difference"]
    operands: list[Operand] = Field(min_length=1)


StartNode = Annotated[Union[Scope, SetExpression], Field(discriminator="kind")]
NavigationDefinition = Annotated[
    Union[PathNavigation, SetExpression], Field(discriminator="kind")
]

Step.model_rebuild()
PathNavigation.model_rebuild()
Operand.model_rebuild()
SetExpression.model_rebuild()

#: validates/dumps a full definition document (artifact payloads, API bodies).
NAVIGATION_ADAPTER: TypeAdapter[NavigationDefinition] = TypeAdapter(
    NavigationDefinition
)
```

(`Optional[...]` rather than `X | None` inside `Operand` because the forward-ref string `"NavigationDefinition | None"` does not resolve under the pyright 3.10 floor; `Optional` with a quoted inner name does.)

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/navigation/test_schema.py -v`
Expected: PASS (all 9).

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-core`

```bash
git add src/data_rover/core/navigation tests/navigation
git commit -m "feat(navigation): NavigationDefinition schema (path + set expressions)"
```

---

### Task 4: Ref resolver (`core/navigation/resolve.py`)

Inline every `Operand.ref` by fetching the referenced artifact's definition; detect reference cycles. Pure: the fetch is an injected callable, so this is core-testable without a DB.

**Files:**
- Create: `src/data_rover/core/navigation/resolve.py`
- Test: `tests/navigation/test_resolve.py`

**Interfaces:**
- Consumes: Task 3 types.
- Produces: `resolve_refs(defn: NavigationDefinition, fetch: Callable[[str], NavigationDefinition]) -> NavigationDefinition` (returns a fully-inlined copy; input is never mutated), `NavigationResolveError(Exception)` with subclasses `RefNotFoundError(artifact_id)` and `RefCycleError(artifact_id)`. `fetch` raises `LookupError` for unknown ids.

- [ ] **Step 1: Write the failing tests**

`tests/navigation/test_resolve.py`:

```python
"""resolve_refs inlines Operand.ref via an injected fetch callable; a ref
chain that revisits an artifact id is a cycle (RefCycleError), an unknown id
is RefNotFoundError. The evaluator never sees a ref."""

import pytest

from data_rover.core.navigation.resolve import (
    RefCycleError,
    RefNotFoundError,
    resolve_refs,
)
from data_rover.core.navigation.schema import (
    NAVIGATION_ADAPTER,
    PathNavigation,
    SetExpression,
)


def _nav(doc: dict):
    return NAVIGATION_ADAPTER.validate_python(doc)


PATH = {"kind": "path", "start": {"kind": "scope", "types": ["Block"]},
        "steps": [{"relationship_type": "Owns"}]}


def test_path_without_refs_is_returned_as_is() -> None:
    nav = _nav(PATH)
    assert resolve_refs(nav, fetch=lambda _id: (_ for _ in ()).throw(LookupError())) == nav


def test_ref_operand_is_inlined() -> None:
    expr = _nav({"kind": "set_op", "op": "union",
                 "operands": [{"ref": "a", "step_index": 0}]})
    resolved = resolve_refs(expr, fetch={"a": _nav(PATH)}.__getitem__)
    assert isinstance(resolved, SetExpression)
    op = resolved.operands[0]
    assert op.ref is None
    assert isinstance(op.definition, PathNavigation)
    assert op.step_index == 0  # preserved through inlining


def test_nested_refs_resolve_through_set_expression_start() -> None:
    doc = dict(PATH)
    doc["start"] = {"kind": "set_op", "op": "union", "operands": [{"ref": "a"}]}
    resolved = resolve_refs(_nav(doc), fetch={"a": _nav(PATH)}.__getitem__)
    assert isinstance(resolved, PathNavigation)
    assert isinstance(resolved.start, SetExpression)
    assert isinstance(resolved.start.operands[0].definition, PathNavigation)


def test_unknown_ref_raises() -> None:
    expr = _nav({"kind": "set_op", "op": "union", "operands": [{"ref": "ghost"}]})
    with pytest.raises(RefNotFoundError) as exc:
        resolve_refs(expr, fetch={}.__getitem__)
    assert exc.value.artifact_id == "ghost"


def test_ref_cycle_raises() -> None:
    # a -> b -> a
    a = _nav({"kind": "set_op", "op": "union", "operands": [{"ref": "b"}]})
    b = _nav({"kind": "set_op", "op": "union", "operands": [{"ref": "a"}]})
    with pytest.raises(RefCycleError) as exc:
        resolve_refs(a, fetch={"a": a, "b": b}.__getitem__)
    assert exc.value.artifact_id in {"a", "b"}


def test_self_cycle_raises() -> None:
    a = _nav({"kind": "set_op", "op": "union", "operands": [{"ref": "a"}]})
    with pytest.raises(RefCycleError):
        resolve_refs(a, fetch={"a": a}.__getitem__)
```

Note `{}.__getitem__` raises `KeyError`, a `LookupError` subclass — exactly the fetch contract.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/navigation/test_resolve.py -v`
Expected: FAIL — no module `resolve`.

- [ ] **Step 3: Implement**

`src/data_rover/core/navigation/resolve.py`:

```python
"""Inline artifact references inside a NavigationDefinition.

`Operand.ref` names a stored `kind="navigation"` artifact. The evaluator is
deliberately ref-free (pure over the definition it is handed), so the API
layer resolves refs first via this module, injecting a `fetch` callable that
loads+parses an artifact's payload. Cycle detection is by the PATH of ids
being expanded (`_seen`): the same artifact may appear twice as a sibling
(diamond), but not on its own expansion path.
"""

from __future__ import annotations

from collections.abc import Callable

from .schema import (
    NavigationDefinition,
    Operand,
    PathNavigation,
    Scope,
    SetExpression,
)


class NavigationResolveError(Exception):
    def __init__(self, artifact_id: str, message: str) -> None:
        super().__init__(message)
        self.artifact_id = artifact_id


class RefNotFoundError(NavigationResolveError):
    def __init__(self, artifact_id: str) -> None:
        super().__init__(artifact_id, f"unknown navigation artifact {artifact_id!r}")


class RefCycleError(NavigationResolveError):
    def __init__(self, artifact_id: str) -> None:
        super().__init__(
            artifact_id, f"navigation reference cycle through {artifact_id!r}"
        )


Fetch = Callable[[str], NavigationDefinition]


def resolve_refs(
    defn: NavigationDefinition, fetch: Fetch, _seen: frozenset[str] = frozenset()
) -> NavigationDefinition:
    """A copy of `defn` with every `Operand.ref` replaced by its fetched,
    recursively-resolved definition. `fetch` raises LookupError for unknown
    ids. Never mutates its input."""
    if isinstance(defn, PathNavigation):
        if isinstance(defn.start, Scope):
            return defn
        return defn.model_copy(
            update={"start": _resolve_expr(defn.start, fetch, _seen)}
        )
    return _resolve_expr(defn, fetch, _seen)


def _resolve_expr(
    expr: SetExpression, fetch: Fetch, seen: frozenset[str]
) -> SetExpression:
    operands: list[Operand] = []
    for op in expr.operands:
        if op.ref is not None:
            if op.ref in seen:
                raise RefCycleError(op.ref)
            try:
                fetched = fetch(op.ref)
            except LookupError:
                raise RefNotFoundError(op.ref) from None
            inner = resolve_refs(fetched, fetch, seen | {op.ref})
            operands.append(
                Operand(definition=inner, step_index=op.step_index)
            )
        else:
            assert op.definition is not None  # schema: exactly one source
            inner = resolve_refs(op.definition, fetch, seen)
            operands.append(op.model_copy(update={"definition": inner}))
    return expr.model_copy(update={"operands": operands})
```

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/navigation -v`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-core`

```bash
git add src/data_rover/core/navigation/resolve.py tests/navigation/test_resolve.py
git commit -m "feat(navigation): ref resolver with cycle detection"
```

---

### Task 5: Path evaluator (`core/navigation/evaluate.py`)

Deterministic DFS chain enumeration with caps. Set expressions come in Task 6; this task raises `NotImplementedError` for them.

**Files:**
- Create: `src/data_rover/core/navigation/evaluate.py`
- Test: `tests/navigation/test_evaluate_path.py`

**Interfaces:**
- Consumes: Tasks 1-3 (`match_element`, `element_descendants`, `is_relationship_subtype`, schema types, `IndexSet` accessors).
- Produces:
  - `EvalLimits(max_visited: int = 100_000, max_chains: int = 5_000)` (frozen dataclass)
  - `ChainResult(step_types: list[str], chains: list[tuple[str, ...]], truncated: bool)` (dataclass) — chains include the start element (index 0), are deduplicated, and are in lexicographic element-id order; `step_types` lists each step's `relationship_type` (empty for set expressions).
  - `evaluate(metamodel: Metamodel, model: Model, defn: NavigationDefinition, limits: EvalLimits = EvalLimits()) -> ChainResult` — `defn` must be ref-free (run `resolve_refs` first).

- [ ] **Step 1: Write the failing tests**

`tests/navigation/test_evaluate_path.py`:

```python
"""Path-evaluation semantics:

- start scope: subtype-INCLUSIVE type match (via element_descendants) +
  criteria (advanced-search matchers); empty types = every element.
- hop: relationship-type match is subtype-inclusive; direction out/in/either;
  target scope filters; parallel edges to the same endpoint yield ONE chain
  (chains are element tuples, deduped per expansion).
- a chain never revisits one of its own elements (cycle guard).
- determinism: chains come out in lexicographic element-id order.
- caps: max_chains / max_visited stop enumeration and set truncated=True.
"""

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import ChainResult, EvalLimits, evaluate
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER


def _mm() -> Metamodel:
    # `name` must be DECLARED: Model.set_property rejects properties absent
    # from the type's effective schema (model.py mutation boundary).
    return Metamodel(
        elements=[
            ElementType(
                name="Node",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(name="Building", extends="Node"),
            ElementType(name="Sensor", extends="Node"),
        ],
        relationships=[
            RelationshipType(name="Rel", source="Node", target="Node"),
            RelationshipType(name="Owns", extends="Rel", source="Node", target="Node"),
        ],
    )


def _fixture() -> tuple[Model, dict[str, str]]:
    """b1,b2: Buildings; s1,s2,s3: Sensors. Owns: b1->s1, b1->s2, b2->s3.
    Plus a parallel duplicate b1->s1 edge and a plain Rel b1->s3."""
    model = Model(_mm())
    ids: dict[str, str] = {}
    for key, type_name, name in [
        ("b1", "Building", "Plant 1"), ("b2", "Building", "Plant 2"),
        ("s1", "Sensor", "T-1"), ("s2", "Sensor", "T-2"), ("s3", "Sensor", "T-3"),
    ]:
        el = model.create_element(type_name)
        model.set_property(el, "name", name)
        ids[key] = el.id
    model.connect("Owns", ids["b1"], ids["s1"])
    model.connect("Owns", ids["b1"], ids["s1"])  # parallel duplicate
    model.connect("Owns", ids["b1"], ids["s2"])
    model.connect("Owns", ids["b2"], ids["s3"])
    model.connect("Rel", ids["b1"], ids["s3"])
    return model, ids


def _path(**overrides):
    doc = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Building"]},
        "steps": [{"relationship_type": "Owns"}],
    }
    doc.update(overrides)
    return NAVIGATION_ADAPTER.validate_python(doc)


def test_linear_hop_dedupes_parallel_edges_and_sorts() -> None:
    model, ids = _fixture()
    result = evaluate(model.metamodel, model, _path())
    expected = sorted([
        (ids["b1"], ids["s1"]), (ids["b1"], ids["s2"]), (ids["b2"], ids["s3"]),
    ])
    assert result.chains == expected
    assert result.step_types == ["Owns"]
    assert result.truncated is False


def test_rel_type_match_is_subtype_inclusive() -> None:
    model, ids = _fixture()
    result = evaluate(model.metamodel, model,
                      _path(steps=[{"relationship_type": "Rel"}]))
    # Owns extends Rel, so all four distinct edges match
    assert (ids["b1"], ids["s3"]) in result.chains
    assert (ids["b1"], ids["s1"]) in result.chains


def test_start_scope_is_subtype_inclusive_and_filtered() -> None:
    model, ids = _fixture()
    nav = _path(start={"kind": "scope", "types": ["Node"],
                       "criteria": [{"type": "property", "name": "name",
                                     "op": "equals", "value": "Plant 1"}]},
                steps=[])
    result = evaluate(model.metamodel, model, nav)
    assert result.chains == [(ids["b1"],)]  # zero steps -> 1-tuples


def test_incoming_and_either_directions() -> None:
    model, ids = _fixture()
    nav = _path(start={"kind": "scope", "types": ["Sensor"]},
                steps=[{"relationship_type": "Owns", "direction": "in"}])
    result = evaluate(model.metamodel, model, nav)
    assert (ids["s1"], ids["b1"]) in result.chains
    nav = _path(start={"kind": "scope", "types": ["Sensor"]},
                steps=[{"relationship_type": "Owns", "direction": "either"}])
    assert (ids["s1"], ids["b1"]) in evaluate(model.metamodel, model, nav).chains


def test_target_scope_filters_hop() -> None:
    model, ids = _fixture()
    nav = _path(steps=[{"relationship_type": "Owns",
                        "target": {"kind": "scope",
                                   "criteria": [{"type": "property", "name": "name",
                                                 "op": "equals", "value": "T-2"}]}}])
    result = evaluate(model.metamodel, model, nav)
    assert result.chains == [(ids["b1"], ids["s2"])]


def test_chain_cycle_guard() -> None:
    mm = _mm()
    model = Model(mm)
    a = model.create_element("Node")
    b = model.create_element("Node")
    model.connect("Rel", a.id, b.id)
    model.connect("Rel", b.id, a.id)
    nav = _path(start={"kind": "scope", "types": ["Node"]},
                steps=[{"relationship_type": "Rel", "direction": "either"},
                       {"relationship_type": "Rel", "direction": "either"}])
    result = evaluate(mm, model, nav)
    # a->b->a and b->a->b are forbidden; with only two nodes there is no
    # 3-element chain at all.
    assert result.chains == []


def test_max_chains_truncates() -> None:
    model, _ids = _fixture()
    limits = EvalLimits(max_chains=2)
    result = evaluate(model.metamodel, model, _path(), limits)
    assert len(result.chains) == 2
    assert result.truncated is True


def test_max_visited_truncates() -> None:
    model, _ids = _fixture()
    limits = EvalLimits(max_visited=1)
    result = evaluate(model.metamodel, model, _path(), limits)
    assert result.truncated is True


def test_empty_types_means_all_elements() -> None:
    model, _ids = _fixture()
    nav = _path(start={"kind": "scope"}, steps=[])
    result = evaluate(model.metamodel, model, nav)
    assert len(result.chains) == 5


def test_determinism() -> None:
    model, _ids = _fixture()
    r1 = evaluate(model.metamodel, model, _path())
    r2 = evaluate(model.metamodel, model, _path())
    assert r1 == r2 == ChainResult(r1.step_types, r1.chains, r1.truncated)
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/navigation/test_evaluate_path.py -v`
Expected: FAIL — no module `evaluate`.

- [ ] **Step 3: Implement**

`src/data_rover/core/navigation/evaluate.py`:

```python
"""Pure navigation evaluator over (Metamodel, Model).

Read-only and session-free: hops go through `model.indexes` adjacency (never
a model scan), scopes filter with the shared search matchers, and type checks
use the Metamodel's cached descendant/ancestor sets — so one hop is
O(edges touching the frontier), matching the read-layer O(entity) rule.
Like routes/read.py, callers do NOT take the session write_mutex: reads race
benignly against in-memory mutation.

Enumeration is depth-first over SORTED element ids with per-expansion
dedup (parallel edges to the same endpoint yield one continuation), which
makes the chain order deterministic — that determinism is what lets the API
layer do stateless offset/limit paging by re-evaluating.

Two caps bound the work on 80 MB models: `max_visited` counts every edge
examined; `max_chains` bounds the collected output. Hitting either stops
enumeration and flags the result `truncated`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.search.criteria import match_element

from .schema import (
    NavigationDefinition,
    PathNavigation,
    Scope,
    SetExpression,
    Step,
)


@dataclass(frozen=True)
class EvalLimits:
    max_visited: int = 100_000
    max_chains: int = 5_000


@dataclass
class ChainResult:
    """Chains INCLUDE the start element at index 0 (see schema docstring)."""

    step_types: list[str]
    chains: list[tuple[str, ...]]
    truncated: bool


@dataclass
class _Budget:
    max_visited: int
    visited: int = 0
    exhausted: bool = field(default=False)

    def spend(self, n: int) -> bool:
        """Charge n edge-examinations; False once the budget is gone."""
        self.visited += n
        if self.visited > self.max_visited:
            self.exhausted = True
        return not self.exhausted


def evaluate(
    metamodel: Metamodel,
    model: Model,
    defn: NavigationDefinition,
    limits: EvalLimits = EvalLimits(),
) -> ChainResult:
    """Evaluate a ref-free definition (run `resolve_refs` first)."""
    if isinstance(defn, SetExpression):
        raise NotImplementedError  # Task 6
    budget = _Budget(max_visited=limits.max_visited)
    start_ids = _start_ids(metamodel, model, defn, limits, budget)
    chains: list[tuple[str, ...]] = []
    truncated = _walk(
        metamodel, model, defn.steps, start_ids, (), chains, limits, budget
    )
    return ChainResult(
        step_types=[s.relationship_type for s in defn.steps],
        chains=chains,
        truncated=truncated or budget.exhausted,
    )


def _start_ids(
    metamodel: Metamodel,
    model: Model,
    defn: PathNavigation,
    limits: EvalLimits,
    budget: _Budget,
) -> list[str]:
    if isinstance(defn.start, SetExpression):
        raise NotImplementedError  # Task 6
    return _scope_ids(metamodel, model, defn.start)


def _scope_ids(metamodel: Metamodel, model: Model, scope: Scope) -> list[str]:
    if scope.types:
        ids: set[str] = set()
        for type_name in scope.types:
            for concrete in metamodel.element_descendants(type_name):
                ids |= model.indexes.elements_by_type.get(concrete, set())
    else:
        ids = set(model.elements.keys())
    return sorted(
        i for i in ids if _matches_criteria(model, model.elements[i], scope)
    )


def _matches_criteria(model: Model, element: Element, scope: Scope) -> bool:
    return all(match_element(model, element, c) for c in scope.criteria)


def _matches_target(
    metamodel: Metamodel, model: Model, element: Element, scope: Scope
) -> bool:
    if scope.types and not any(
        metamodel.is_element_subtype(element.type_name, t) for t in scope.types
    ):
        return False
    return _matches_criteria(model, element, scope)


def _next_ids(
    metamodel: Metamodel,
    model: Model,
    element_id: str,
    step: Step,
    budget: _Budget,
) -> list[str]:
    idx = model.indexes
    if step.direction == "out":
        rel_ids = set(idx.outgoing_ids(element_id))
    elif step.direction == "in":
        rel_ids = set(idx.incoming_ids(element_id))
    else:  # either — union dedupes self-loops present in both directions
        rel_ids = set(idx.outgoing_ids(element_id)) | set(idx.incoming_ids(element_id))
    if not budget.spend(len(rel_ids)):
        return []
    nxt: set[str] = set()
    for rid in rel_ids:
        rel = model.relationships[rid]
        if not metamodel.is_relationship_subtype(
            rel.type_name, step.relationship_type
        ):
            continue
        other = rel.target_id if rel.source_id == element_id else rel.source_id
        el = model.elements.get(other)
        if el is not None and _matches_target(metamodel, model, el, step.target):
            nxt.add(other)
    return sorted(nxt)


def _walk(
    metamodel: Metamodel,
    model: Model,
    steps: list[Step],
    frontier: list[str],
    prefix: tuple[str, ...],
    chains: list[tuple[str, ...]],
    limits: EvalLimits,
    budget: _Budget,
) -> bool:
    """DFS continuation; returns True when enumeration stopped early."""
    for element_id in frontier:
        if element_id in prefix:
            continue  # cycle guard: a chain never revisits its own elements
        chain = prefix + (element_id,)
        if len(chain) == len(steps) + 1:
            if len(chains) >= limits.max_chains:
                return True
            chains.append(chain)
            continue
        step = steps[len(chain) - 1]
        nxt = _next_ids(metamodel, model, element_id, step, budget)
        if budget.exhausted:
            return True
        if _walk(metamodel, model, steps, nxt, chain, chains, limits, budget):
            return True
    return False
```

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/navigation -v`
Expected: all PASS (schema + resolve + path evaluation).

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-core`

```bash
git add src/data_rover/core/navigation/evaluate.py tests/navigation/test_evaluate_path.py
git commit -m "feat(navigation): deterministic capped path evaluator"
```

---

### Task 6: Set-expression evaluation

**Files:**
- Modify: `src/data_rover/core/navigation/evaluate.py`
- Test: `tests/navigation/test_evaluate_sets.py`

**Interfaces:**
- Produces: `evaluate(...)` now also accepts `SetExpression` (top-level and as a path's `start`), returning 1-tuple chains in sorted order with `step_types == []`. Internal helpers `_evaluate_set` / `_operand_members` (module-private; tested through `evaluate`). `Operand.step_index` out of range raises `ValueError` (message contains "step_index").

- [ ] **Step 1: Write the failing tests**

`tests/navigation/test_evaluate_sets.py`:

```python
"""Set operations act on ELEMENT SETS drawn from operand chains at
step_index (0 = start, k = after step k, None = terminal); difference is a
left fold; results surface as sorted 1-tuple chains; operand truncation
propagates to the result."""

import pytest

from data_rover.core.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import EvalLimits, evaluate
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER


def _model() -> tuple[Model, dict[str, str]]:
    mm = Metamodel(
        elements=[ElementType(name="B"), ElementType(name="S")],
        relationships=[
            RelationshipType(name="Owns", source="B", target="S"),
            RelationshipType(name="Watches", source="B", target="S"),
        ],
    )
    model = Model(mm)
    ids: dict[str, str] = {}
    for key, tn in [("b1", "B"), ("b2", "B"), ("s1", "S"), ("s2", "S"), ("s3", "S")]:
        ids[key] = model.create_element(tn).id
    model.connect("Owns", ids["b1"], ids["s1"])
    model.connect("Owns", ids["b1"], ids["s2"])
    model.connect("Watches", ids["b2"], ids["s2"])
    model.connect("Watches", ids["b2"], ids["s3"])
    return model, ids


def _owns():
    return {"kind": "path", "start": {"kind": "scope", "types": ["B"]},
            "steps": [{"relationship_type": "Owns"}]}


def _watches():
    return {"kind": "path", "start": {"kind": "scope", "types": ["B"]},
            "steps": [{"relationship_type": "Watches"}]}


def _expr(op, *operands):
    return NAVIGATION_ADAPTER.validate_python(
        {"kind": "set_op", "op": op, "operands": list(operands)}
    )


def test_union_intersection_difference_symmetric_difference() -> None:
    model, ids = _model()
    mm = model.metamodel
    owned = {ids["s1"], ids["s2"]}
    watched = {ids["s2"], ids["s3"]}
    cases = {
        "union": owned | watched,
        "intersection": owned & watched,
        "difference": owned - watched,
        "symmetric_difference": owned ^ watched,
    }
    for op, want in cases.items():
        result = evaluate(mm, model, _expr(op, {"definition": _owns()},
                                          {"definition": _watches()}))
        assert result.chains == [(i,) for i in sorted(want)], op
        assert result.step_types == []


def test_step_index_zero_only_includes_elements_with_chains() -> None:
    # b2 has no Owns edge, so no chain starts at b2 — only elements that
    # actually head a chain contribute to the step-0 set.
    model, ids = _model()
    result = evaluate(model.metamodel, model,
                      _expr("union", {"definition": _owns(), "step_index": 0}))
    assert result.chains == [(ids["b1"],)]


def test_step_index_out_of_range_raises() -> None:
    model, _ids = _model()
    with pytest.raises(ValueError, match="step_index"):
        evaluate(model.metamodel, model,
                 _expr("union", {"definition": _owns(), "step_index": 5}))


def test_path_with_set_expression_start() -> None:
    model, ids = _model()
    doc = {"kind": "path",
           "start": {"kind": "set_op", "op": "intersection",
                     "operands": [{"definition": _owns()},
                                  {"definition": _watches()}]},
           "steps": [{"relationship_type": "Watches", "direction": "in"}]}
    result = evaluate(model.metamodel, model, NAVIGATION_ADAPTER.validate_python(doc))
    # start set = {s2}; incoming Watches -> b2
    assert result.chains == [(ids["s2"], ids["b2"])]
    assert result.step_types == ["Watches"]


def test_nested_expression_and_left_fold_difference() -> None:
    model, ids = _model()
    inner = {"kind": "set_op", "op": "union",
             "operands": [{"definition": _owns()}, {"definition": _watches()}]}
    result = evaluate(model.metamodel, model,
                      _expr("difference", {"definition": inner},
                            {"definition": _watches()}))
    assert result.chains == [(ids["s1"],)]


def test_truncation_propagates_from_operand() -> None:
    model, _ids = _model()
    result = evaluate(model.metamodel, model,
                      _expr("union", {"definition": _owns()}),
                      EvalLimits(max_chains=1))
    assert result.truncated is True
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/navigation/test_evaluate_sets.py -v`
Expected: FAIL with `NotImplementedError`.

- [ ] **Step 3: Implement**

In `evaluate.py`, replace both `NotImplementedError` sites and add the set walker. `evaluate` becomes:

```python
def evaluate(
    metamodel: Metamodel,
    model: Model,
    defn: NavigationDefinition,
    limits: EvalLimits = EvalLimits(),
) -> ChainResult:
    """Evaluate a ref-free definition (run `resolve_refs` first)."""
    budget = _Budget(max_visited=limits.max_visited)
    if isinstance(defn, SetExpression):
        members, truncated = _evaluate_set(metamodel, model, defn, limits, budget)
        return ChainResult(
            step_types=[],
            chains=[(i,) for i in sorted(members)],
            truncated=truncated or budget.exhausted,
        )
    start_ids = _start_ids(metamodel, model, defn, limits, budget)
    chains: list[tuple[str, ...]] = []
    truncated = _walk(
        metamodel, model, defn.steps, start_ids, (), chains, limits, budget
    )
    return ChainResult(
        step_types=[s.relationship_type for s in defn.steps],
        chains=chains,
        truncated=truncated or budget.exhausted,
    )
```

`_start_ids` set-expression branch:

```python
def _start_ids(
    metamodel: Metamodel,
    model: Model,
    defn: PathNavigation,
    limits: EvalLimits,
    budget: _Budget,
) -> list[str]:
    if isinstance(defn.start, SetExpression):
        members, truncated = _evaluate_set(
            metamodel, model, defn.start, limits, budget
        )
        if truncated:
            budget.exhausted = True
        return sorted(members)
    return _scope_ids(metamodel, model, defn.start)
```

New functions:

```python
def _evaluate_set(
    metamodel: Metamodel,
    model: Model,
    expr: SetExpression,
    limits: EvalLimits,
    budget: _Budget,
) -> tuple[set[str], bool]:
    """(member ids, any-operand-truncated). `difference` folds left-to-right
    over the operand list; the other ops are order-insensitive."""
    truncated = False
    result: set[str] | None = None
    for operand in expr.operands:
        assert operand.definition is not None  # resolver inlined every ref
        members, op_truncated = _operand_members(
            metamodel, model, operand.definition, operand.step_index, limits, budget
        )
        truncated = truncated or op_truncated
        if result is None:
            result = members
        elif expr.op == "union":
            result |= members
        elif expr.op == "intersection":
            result &= members
        elif expr.op == "difference":
            result -= members
        else:  # symmetric_difference
            result ^= members
    return result or set(), truncated


def _operand_members(
    metamodel: Metamodel,
    model: Model,
    defn: NavigationDefinition,
    step_index: int | None,
    limits: EvalLimits,
    budget: _Budget,
) -> tuple[set[str], bool]:
    if isinstance(defn, SetExpression):
        # a set has no steps; any explicit index other than 0 is an error
        if step_index not in (None, 0):
            raise ValueError(
                f"step_index {step_index} out of range for a set operand"
            )
        return _evaluate_set(metamodel, model, defn, limits, budget)
    inner = evaluate(metamodel, model, defn, limits)
    n_steps = len(inner.step_types)
    index = n_steps if step_index is None else step_index
    if index > n_steps:
        raise ValueError(
            f"step_index {step_index} out of range: path has {n_steps} steps"
        )
    return {chain[index] for chain in inner.chains}, inner.truncated
```

Note `_operand_members` recurses into `evaluate` with a fresh budget for the inner path (each operand gets the full `max_visited`/`max_chains`); operand truncation still propagates. This keeps limits per-navigation and easy to reason about — document it in the `_evaluate_set` docstring.

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/navigation -v`
Expected: all PASS.

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-core`

```bash
git add src/data_rover/core/navigation/evaluate.py tests/navigation/test_evaluate_sets.py
git commit -m "feat(navigation): element-set operations over navigation results"
```

---

### Task 7: `ArtifactRow` + Alembic `0008` + `content.py` service functions

**Files:**
- Modify: `src/data_rover/api/db_models.py` (append after `Snapshot`, :243)
- Create: `alembic/versions/0008_project_artifacts.py`
- Modify: `src/data_rover/api/content.py` (append)
- Test: `tests/api/test_content.py` (append), `tests/api/test_alembic.py` (existing — must stay green)

**Interfaces:**
- Produces:
  - `db_models.ArtifactKind(str, enum.Enum)`: `navigation`, `table`, `diagram`, `diagram_kind` (all four now — VARCHAR+CHECK either way, saves later migrations).
  - `db_models.ArtifactRow`: table `project_artifacts` (columns below).
  - `content.StaleArtifactError(Exception)` with `.current_rev: int`.
  - `content.create_artifact(db, project_id, *, kind: ArtifactKind, name: str, payload: dict, updated_by: str | None) -> ArtifactRow`
  - `content.get_artifact(db, artifact_id: str) -> ArtifactRow | None`
  - `content.find_artifact(db, project_id: str, kind: ArtifactKind, name: str) -> ArtifactRow | None`
  - `content.list_artifacts(db, project_id: str, kind: ArtifactKind | None = None) -> list[ArtifactRow]` (ordered by kind, then name)
  - `content.update_artifact(db, row: ArtifactRow, *, expected_rev: int, name: str | None = None, payload: dict | None = None, updated_by: str | None) -> ArtifactRow` (bumps `artifact_rev`; raises `StaleArtifactError`)
  - `content.delete_artifact(db, row: ArtifactRow) -> None`

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_content.py` (reuse its `_setup()` helper that creates the engine + a `Project`; check its exact name/signature first and follow the file's local conventions):

```python
def test_artifact_crud_roundtrip() -> None:
    _setup()
    with db.db_session() as s:
        row = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="Sensors",
            payload={"kind": "path"}, updated_by=None,
        )
        aid = row.id
        assert row.artifact_rev == 1
    with db.db_session() as s:
        row = content.get_artifact(s, aid)
        assert row is not None and row.name == "Sensors"
        assert content.find_artifact(s, "p1", ArtifactKind.navigation, "Sensors") is not None
        assert [r.id for r in content.list_artifacts(s, "p1")] == [aid]
        assert content.list_artifacts(s, "p1", ArtifactKind.table) == []


def test_artifact_update_bumps_rev_and_rejects_stale() -> None:
    _setup()
    with db.db_session() as s:
        row = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="N",
            payload={}, updated_by=None,
        )
        aid = row.id
    with db.db_session() as s:
        row = content.get_artifact(s, aid)
        assert row is not None
        # updated_by=None: this test seeds no User row and updated_by is an FK
        # (SQLite runs with PRAGMA foreign_keys=ON); route tests cover the id.
        content.update_artifact(s, row, expected_rev=1, name="N2", updated_by=None)
        assert row.artifact_rev == 2
    with db.db_session() as s:
        row = content.get_artifact(s, aid)
        assert row is not None
        with pytest.raises(content.StaleArtifactError) as exc:
            content.update_artifact(s, row, expected_rev=1, payload={"x": 1},
                                    updated_by=None)
        assert exc.value.current_rev == 2


def test_artifact_delete_and_project_cascade() -> None:
    _setup()
    with db.db_session() as s:
        row = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="N",
            payload={}, updated_by=None,
        )
        aid = row.id
        content.delete_artifact(s, row)
        assert content.get_artifact(s, aid) is None
```

Add the imports the file needs (`pytest`, `ArtifactKind` from `data_rover.api.db_models`) alongside its existing ones.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_content.py -v -k artifact`
Expected: FAIL — `ImportError: cannot import name 'ArtifactKind'`.

- [ ] **Step 3: Implement ORM model + migration + services**

Append to `db_models.py` (after `Snapshot`):

```python
class ArtifactKind(str, enum.Enum):
    """Kinds of project artifacts. All four mega-plan kinds are declared up
    front (the column is VARCHAR+CHECK, so this costs nothing); Stage 1 only
    accepts `navigation` payloads at the route layer."""

    navigation = "navigation"
    table = "table"
    diagram = "diagram"
    diagram_kind = "diagram_kind"


class ArtifactRow(Base):
    """A project-shared, model-external artifact (saved navigation, table,
    diagram...). `payload` is the kind-specific JSON document, validated at
    the route layer; it is NEVER part of the model or the op journal.
    `artifact_rev` is the optimistic-concurrency counter: writers echo the
    rev they loaded and a mismatch is a 409 (no leases — artifact edits never
    touch the model)."""

    __tablename__ = "project_artifacts"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "kind", "name", name="uq_artifact_project_kind_name"
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[ArtifactKind] = mapped_column(
        SAEnum(ArtifactKind, name="artifact_kind", native_enum=False),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    artifact_rev: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )
    #: SET NULL so artifacts survive their last editor's account deletion.
    updated_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
```

`alembic/versions/0008_project_artifacts.py`:

```python
"""project_artifacts table (Stage 1 navigation artifacts)

Revision ID: 0008
Revises: 0007
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_artifacts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "kind",
            sa.Enum(
                "navigation", "table", "diagram", "diagram_kind",
                name="artifact_kind", native_enum=False,
            ),
            nullable=False,
        ),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("artifact_rev", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "updated_by",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.UniqueConstraint(
            "project_id", "kind", "name", name="uq_artifact_project_kind_name"
        ),
    )


def downgrade() -> None:
    op.drop_table("project_artifacts")
```

Append to `content.py`:

```python
class StaleArtifactError(Exception):
    """Optimistic-concurrency failure: the caller's expected_rev is behind."""

    def __init__(self, current_rev: int) -> None:
        super().__init__(f"artifact is at rev {current_rev}")
        self.current_rev = current_rev


def create_artifact(
    db: Session,
    project_id: str,
    *,
    kind: ArtifactKind,
    name: str,
    payload: dict,
    updated_by: str | None,
) -> ArtifactRow:
    row = ArtifactRow(
        id=uuid.uuid4().hex,
        project_id=project_id,
        kind=kind,
        name=name,
        payload=payload,
        updated_by=updated_by,
    )
    db.add(row)
    db.flush()
    return row


def get_artifact(db: Session, artifact_id: str) -> ArtifactRow | None:
    return db.get(ArtifactRow, artifact_id)


def find_artifact(
    db: Session, project_id: str, kind: ArtifactKind, name: str
) -> ArtifactRow | None:
    return db.execute(
        select(ArtifactRow).where(
            ArtifactRow.project_id == project_id,
            ArtifactRow.kind == kind,
            ArtifactRow.name == name,
        )
    ).scalar_one_or_none()


def list_artifacts(
    db: Session, project_id: str, kind: ArtifactKind | None = None
) -> list[ArtifactRow]:
    q = select(ArtifactRow).where(ArtifactRow.project_id == project_id)
    if kind is not None:
        q = q.where(ArtifactRow.kind == kind)
    q = q.order_by(ArtifactRow.kind, ArtifactRow.name)
    return list(db.execute(q).scalars())


def update_artifact(
    db: Session,
    row: ArtifactRow,
    *,
    expected_rev: int,
    name: str | None = None,
    payload: dict | None = None,
    updated_by: str | None,
) -> ArtifactRow:
    """Rev-checked update. `payload` is reassigned wholesale (never mutated in
    place) so SQLAlchemy's JSON change-tracking fires — same rule as
    `set_strict_mode` above."""
    if row.artifact_rev != expected_rev:
        raise StaleArtifactError(row.artifact_rev)
    if name is not None:
        row.name = name
    if payload is not None:
        row.payload = payload
    row.artifact_rev = expected_rev + 1
    row.updated_by = updated_by
    db.flush()
    return row


def delete_artifact(db: Session, row: ArtifactRow) -> None:
    db.delete(row)
```

Extend the `db_models` import line in `content.py` to include `ArtifactKind, ArtifactRow`.

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_content.py tests/api/test_alembic.py -v`
Expected: PASS, including the existing alembic consistency test picking up `0008`. If `test_alembic.py` compares ORM metadata against migrations and fails, fix the migration (not the model) until they match.

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-backend`

```bash
git add src/data_rover/api/db_models.py src/data_rover/api/content.py alembic/versions/0008_project_artifacts.py tests/api/test_content.py
git commit -m "feat(api): project_artifacts table + content service functions"
```

---

### Task 8: Artifacts CRUD router + feed event

**Files:**
- Create: `src/data_rover/api/routes/artifacts.py`
- Modify: `src/data_rover/api/schemas.py` (append artifact schemas)
- Modify: `src/data_rover/api/feed.py` (append `artifact_event` after `rebind_event`, :174)
- Modify: `src/data_rover/api/main.py` (routes import list :16-35, router mounting :216-230)
- Test: `tests/api/test_artifacts_routes.py` (create)

**Interfaces:**
- Consumes: Task 7 content functions, Task 3 `NAVIGATION_ADAPTER`.
- Produces (wire, all under `/api/v1/projects/{project_id}`):
  - `GET /artifacts?kind=` → `ArtifactListOut{items: [ArtifactHeaderOut]}`
  - `POST /artifacts` body `ArtifactCreateIn{kind, name, payload}` → 201 `ArtifactOut` | 409 name conflict | 422 bad payload/kind
  - `GET /artifacts/{artifact_id}` → `ArtifactOut` | 404
  - `PUT /artifacts/{artifact_id}` body `ArtifactUpdateIn{artifact_rev, name?, payload?}` → `ArtifactOut` | 409 stale (detail carries `current_rev`) | 409 name conflict | 404
  - `DELETE /artifacts/{artifact_id}` → 204 | 404
  - `feed.artifact_event(action: str, artifact: dict) -> dict` — `{"type": "artifact", "action": ..., "artifact": <header dict>}`, broadcast on every successful write.
  - Schemas: `ArtifactHeaderOut{id, kind, name, artifact_rev, updated_at, updated_by}`, `ArtifactOut(ArtifactHeaderOut){payload: dict}`, `ArtifactCreateIn`, `ArtifactUpdateIn`, `ArtifactListOut`.

- [ ] **Step 1: Write the failing tests**

`tests/api/test_artifacts_routes.py`:

```python
"""Artifacts CRUD: project-scoped, membership-authorized, optimistic-rev
guarded, payload-validated per kind (Stage 1: navigation only)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

NAV_PAYLOAD = {
    "kind": "path",
    "start": {"kind": "scope", "types": ["Block"]},
    "steps": [{"relationship_type": "BlockHasPart"}],
}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _create(client: TestClient, name: str = "My nav") -> dict:
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": name, "payload": NAV_PAYLOAD},
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_create_get_list_roundtrip(client: TestClient) -> None:
    created = _create(client)
    assert created["artifact_rev"] == 1
    assert created["payload"]["kind"] == "path"

    got = client.get(f"{API}/artifacts/{created['id']}").json()
    assert got["name"] == "My nav"

    listed = client.get(f"{API}/artifacts", params={"kind": "navigation"}).json()
    assert [a["id"] for a in listed["items"]] == [created["id"]]
    # headers carry no payload
    assert "payload" not in listed["items"][0]


def test_create_duplicate_name_409(client: TestClient) -> None:
    _create(client)
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "My nav", "payload": NAV_PAYLOAD},
    )
    assert res.status_code == 409


def test_create_invalid_payload_422(client: TestClient) -> None:
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "bad", "payload": {"kind": "nope"}},
    )
    assert res.status_code == 422


def test_create_unsupported_kind_422(client: TestClient) -> None:
    res = client.post(
        f"{API}/artifacts", json={"kind": "table", "name": "t", "payload": {}}
    )
    assert res.status_code == 422


def test_update_rev_conflict_and_success(client: TestClient) -> None:
    created = _create(client)
    stale = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 99, "name": "renamed"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_rev"] == 1

    ok = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 1, "name": "renamed"},
    )
    assert ok.status_code == 200
    assert ok.json()["artifact_rev"] == 2
    assert ok.json()["name"] == "renamed"


def test_delete_then_404(client: TestClient) -> None:
    created = _create(client)
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 204
    assert client.get(f"{API}/artifacts/{created['id']}").status_code == 404
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 404


def test_writes_broadcast_artifact_events(client: TestClient) -> None:
    events: list[dict] = []
    hub = get_session().hub
    original = hub.broadcast
    hub.broadcast = events.append  # type: ignore[method-assign]
    try:
        created = _create(client)
        client.put(
            f"{API}/artifacts/{created['id']}",
            json={"artifact_rev": 1, "name": "n2"},
        )
        client.delete(f"{API}/artifacts/{created['id']}")
    finally:
        hub.broadcast = original  # type: ignore[method-assign]
    kinds = [(e["type"], e["action"]) for e in events]
    assert kinds == [("artifact", "created"), ("artifact", "updated"),
                     ("artifact", "deleted")]
    assert events[0]["artifact"]["name"] == "My nav"
```

Note: `get_session()` returns the default project's session — the same object the route resolves via the path (see conftest docs). If the monkeypatched-broadcast pattern differs from how existing feed tests intercept events, mirror the existing pattern in `tests/api/` instead (search for `hub.broadcast` there first).

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -v`
Expected: FAIL — 404s (router not mounted).

- [ ] **Step 3: Implement schemas, feed builder, router, mounting**

Append to `schemas.py`:

```python
class ArtifactHeaderOut(BaseModel):
    """Artifact list row: everything the sidebar renders, payload omitted."""

    id: str
    kind: str
    name: str
    artifact_rev: int
    updated_at: datetime
    updated_by: str | None = None


class ArtifactOut(ArtifactHeaderOut):
    payload: dict[str, Any] = Field(default_factory=dict)


class ArtifactListOut(BaseModel):
    items: list[ArtifactHeaderOut] = Field(default_factory=list)


class ArtifactCreateIn(BaseModel):
    kind: Literal["navigation", "table", "diagram", "diagram_kind"]
    name: str = Field(min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)


class ArtifactUpdateIn(BaseModel):
    artifact_rev: int
    name: str | None = Field(default=None, min_length=1)
    payload: dict[str, Any] | None = None
```

Append to `feed.py` after `rebind_event`:

```python
def artifact_event(action: str, artifact: dict[str, Any]) -> dict[str, Any]:
    """Artifact library change (action: created|updated|deleted). Carries the
    HEADER only (no payload): clients refresh their artifact list; an open
    editor refetches the payload itself if it cares."""
    return {"type": "artifact", "action": action, "artifact": artifact}
```

Create `src/data_rover/api/routes/artifacts.py`:

```python
"""Project-artifact CRUD (saved navigations; tables/diagrams in later stages).

Artifacts are DB rows, NOT model content: no leases, no commits, no op-log.
Concurrency is optimistic via `artifact_rev` (PUT echoes the loaded rev;
mismatch -> 409 carrying `current_rev`). Every successful write broadcasts an
`artifact_event` on the session's FeedHub — safe without the write_mutex
because artifact writes never touch the in-memory model.

Payloads are validated per kind on write; Stage 1 only `navigation`
(`NAVIGATION_ADAPTER`) is accepted — other kinds 422 until their stage lands.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session as DbSession

from data_rover.core.navigation.schema import NAVIGATION_ADAPTER

from .. import content
from ..db import get_db
from ..db_models import ArtifactKind, ArtifactRow, User
from ..deps import Session, get_request_session
from ..feed import artifact_event
from ..identity import get_current_user
from ..schemas import (
    ArtifactCreateIn,
    ArtifactHeaderOut,
    ArtifactListOut,
    ArtifactOut,
    ArtifactUpdateIn,
)

router = APIRouter()

#: kind -> payload validator. The route 422s on kinds absent here, so adding
#: a stage's kind means adding one entry (and its schema) — nothing else.
_PAYLOAD_ADAPTERS = {ArtifactKind.navigation: NAVIGATION_ADAPTER}


def _header(row: ArtifactRow) -> ArtifactHeaderOut:
    return ArtifactHeaderOut(
        id=row.id,
        kind=row.kind.value,
        name=row.name,
        artifact_rev=row.artifact_rev,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
    )


def _full(row: ArtifactRow) -> ArtifactOut:
    return ArtifactOut(**_header(row).model_dump(), payload=row.payload)


def _validate_payload(kind: ArtifactKind, payload: dict[str, Any]) -> None:
    adapter = _PAYLOAD_ADAPTERS.get(kind)
    if adapter is None:
        raise HTTPException(
            status_code=422,
            detail=f"artifact kind {kind.value!r} is not supported yet",
        )
    try:
        adapter.validate_python(payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid {kind.value} payload: {exc}"
        ) from exc


def _require_artifact(
    db: DbSession, project_id: str, artifact_id: str
) -> ArtifactRow:
    row = content.get_artifact(db, artifact_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="artifact not found")
    return row


@router.get("/artifacts")
def list_artifacts(
    project_id: str,
    kind: ArtifactKind | None = None,
    _session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ArtifactListOut:
    rows = content.list_artifacts(db, project_id, kind)
    return ArtifactListOut(items=[_header(r) for r in rows])


@router.get("/artifacts/{artifact_id}")
def get_artifact(
    project_id: str,
    artifact_id: str,
    _session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ArtifactOut:
    return _full(_require_artifact(db, project_id, artifact_id))


@router.post("/artifacts", status_code=201)
def create_artifact(
    payload: ArtifactCreateIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ArtifactOut:
    kind = ArtifactKind(payload.kind)
    _validate_payload(kind, payload.payload)
    if content.find_artifact(db, project_id, kind, payload.name) is not None:
        raise HTTPException(
            status_code=409,
            detail=f"a {kind.value} named {payload.name!r} already exists",
        )
    row = content.create_artifact(
        db, project_id, kind=kind, name=payload.name,
        payload=payload.payload, updated_by=user.id,
    )
    db.commit()
    session.hub.broadcast(
        artifact_event("created", _header(row).model_dump(mode="json"))
    )
    return _full(row)


@router.put("/artifacts/{artifact_id}")
def update_artifact(
    payload: ArtifactUpdateIn,
    project_id: str,
    artifact_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ArtifactOut:
    row = _require_artifact(db, project_id, artifact_id)
    if payload.payload is not None:
        _validate_payload(row.kind, payload.payload)
    if payload.name is not None and payload.name != row.name:
        clash = content.find_artifact(db, project_id, row.kind, payload.name)
        if clash is not None and clash.id != row.id:
            raise HTTPException(
                status_code=409,
                detail=f"a {row.kind.value} named {payload.name!r} already exists",
            )
    try:
        content.update_artifact(
            db, row, expected_rev=payload.artifact_rev,
            name=payload.name, payload=payload.payload, updated_by=user.id,
        )
    except content.StaleArtifactError as exc:
        raise HTTPException(
            status_code=409,
            detail={"message": "artifact was modified by someone else",
                    "current_rev": exc.current_rev},
        ) from exc
    db.commit()
    session.hub.broadcast(
        artifact_event("updated", _header(row).model_dump(mode="json"))
    )
    return _full(row)


@router.delete("/artifacts/{artifact_id}", status_code=204)
def delete_artifact(
    project_id: str,
    artifact_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> Response:
    row = _require_artifact(db, project_id, artifact_id)
    header = _header(row).model_dump(mode="json")
    content.delete_artifact(db, row)
    db.commit()
    session.hub.broadcast(artifact_event("deleted", header))
    return Response(status_code=204)
```

In `main.py`: add `artifacts,` to the `from .routes import (...)` list (alphabetical — after `admin`) and mount after the commits line:

```python
    app.include_router(artifacts.router, prefix=proj, tags=["artifacts"])
```

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -v`
Expected: all PASS.

Also run: `pixi run -e core-dev pytest tests/api -q`
Expected: no regressions.

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-backend`

```bash
git add src/data_rover/api/routes/artifacts.py src/data_rover/api/schemas.py src/data_rover/api/feed.py src/data_rover/api/main.py tests/api/test_artifacts_routes.py
git commit -m "feat(api): project artifacts CRUD router + feed events"
```

---

### Task 9: `POST /navigations/evaluate` + authz allowlist

**Files:**
- Modify: `src/data_rover/api/routes/artifacts.py` (add the endpoint)
- Modify: `src/data_rover/api/schemas.py` (add `EvaluateNavigationIn`, `ChainPageOut`)
- Modify: `src/data_rover/api/authz.py` (`_READ_ONLY_POST_SUFFIXES`, :45)
- Test: `tests/api/test_artifacts_routes.py` (append)

**Interfaces:**
- Produces (wire): `POST /navigations/evaluate` body `{definition? | artifact_id?, limit<=500 (default 100), offset}` → `ChainPageOut{step_types: [str], chains: [[TreeItem,...]], total: int, truncated: bool}`. 422 on: neither/both of definition+artifact_id, ref cycle, unknown ref, step_index out of range, or no model loaded (404 for the latter, via `require_model`). Viewer-callable (read-only allowlist).

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_artifacts_routes.py`:

```python
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"


def _bootstrap_model(client: TestClient) -> dict[str, str]:
    """example.metamodel.yaml: Block (mass), BlockHasPart (containment,
    Block->Block), Satisfies (Block->Requirement). Build: root -has-> p1, p2."""
    client.post(
        f"{API}/metamodel",
        content=EXAMPLE.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    client.post(f"{API}/model", json={"elements": [], "relationships": []})
    ids: dict[str, str] = {}
    for name in ["root", "p1", "p2"]:
        res = client.post(
            f"{API}/model/elements",
            json={"type": "Block", "properties": {"name": name, "mass": 1.0}},
        )
        ids[name] = res.json()["id"]
    for child in ["p1", "p2"]:
        client.post(
            f"{API}/model/relationships",
            json={"type": "BlockHasPart", "source_id": ids["root"],
                  "target_id": ids[child]},
        )
    return ids


def test_evaluate_inline_definition(client: TestClient) -> None:
    ids = _bootstrap_model(client)
    res = client.post(
        f"{API}/navigations/evaluate",
        json={"definition": {
            "kind": "path",
            "start": {"kind": "scope", "types": ["Block"],
                      "criteria": [{"type": "name_id", "field": "name",
                                    "op": "equals", "value": "root"}]},
            "steps": [{"relationship_type": "BlockHasPart"}],
        }},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["step_types"] == ["BlockHasPart"]
    assert body["total"] == 2 and body["truncated"] is False
    chains = body["chains"]
    assert all(len(c) == 2 for c in chains)
    assert {c[1]["id"] for c in chains} == {ids["p1"], ids["p2"]}
    assert chains[0][0]["display_name"] == "root"  # TreeItem projection


def test_evaluate_saved_artifact_and_paging(client: TestClient) -> None:
    _bootstrap_model(client)
    nav = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Block"]},
        "steps": [],
    }
    created = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "all blocks", "payload": nav},
    ).json()
    page = client.post(
        f"{API}/navigations/evaluate",
        json={"artifact_id": created["id"], "limit": 2, "offset": 2},
    ).json()
    assert page["total"] == 3
    assert len(page["chains"]) == 1  # 3 chains, offset 2


def test_evaluate_requires_exactly_one_source(client: TestClient) -> None:
    _bootstrap_model(client)
    assert client.post(f"{API}/navigations/evaluate", json={}).status_code == 422


def test_evaluate_unknown_artifact_422(client: TestClient) -> None:
    _bootstrap_model(client)
    res = client.post(
        f"{API}/navigations/evaluate", json={"artifact_id": "ghost"}
    )
    assert res.status_code == 422


def test_evaluate_ref_cycle_422(client: TestClient) -> None:
    _bootstrap_model(client)
    a = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "a",
              "payload": {"kind": "set_op", "op": "union",
                          "operands": [{"ref": "placeholder"}]}},
    ).json()
    # point a at itself
    client.put(
        f"{API}/artifacts/{a['id']}",
        json={"artifact_rev": 1,
              "payload": {"kind": "set_op", "op": "union",
                          "operands": [{"ref": a["id"]}]}},
    )
    res = client.post(
        f"{API}/navigations/evaluate", json={"artifact_id": a["id"]}
    )
    assert res.status_code == 422
    assert "cycle" in res.text


def test_viewer_can_evaluate_but_not_create(client: TestClient) -> None:
    """/navigations/evaluate must be on the read-only POST allowlist."""
    _bootstrap_model(client)
    from data_rover.api import tenancy
    from data_rover.api.db import db_session
    from data_rover.api.db_models import Role

    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1",
                           role=Role.viewer)
    viewer = TestClient(create_app())
    viewer.headers.update({"x-user-id": "viewer-1", "x-user-email": "v@example.com"})
    ok = viewer.post(
        f"{API}/navigations/evaluate",
        json={"definition": {"kind": "path",
                             "start": {"kind": "scope", "types": ["Block"]},
                             "steps": []}},
    )
    assert ok.status_code == 200
    denied = viewer.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "x",
              "payload": {"kind": "path",
                          "start": {"kind": "scope"}, "steps": []}},
    )
    assert denied.status_code == 403
```

Before writing, check `tenancy.py` for the exact member-add function name (`add_member` vs `create_membership` — use what exists; `upsert_user`'s signature likewise).

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -v -k evaluate`
Expected: FAIL — 404 (endpoint missing).

- [ ] **Step 3: Implement**

Append to `schemas.py` (imports: add `from data_rover.core.navigation.schema import NavigationDefinition` at the top with the other core imports):

```python
class EvaluateNavigationIn(BaseModel):
    """Exactly one of `definition` (inline) / `artifact_id` (saved)."""

    definition: NavigationDefinition | None = None
    artifact_id: str | None = None
    limit: int = Field(100, ge=1, le=500)
    offset: int = Field(0, ge=0)

    @model_validator(mode="after")
    def _exactly_one(self) -> "EvaluateNavigationIn":
        if (self.definition is None) == (self.artifact_id is None):
            raise ValueError(
                "provide exactly one of `definition` / `artifact_id`"
            )
        return self


class ChainPageOut(BaseModel):
    """One page of navigation chains, each element as a TreeItem projection.
    `total` counts chains found WITHIN the evaluation caps; `truncated` means
    the caps stopped enumeration (there may be more matches than `total`)."""

    step_types: list[str] = Field(default_factory=list)
    chains: list[list[TreeItem]] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False
```

(`model_validator` is already imported in `schemas.py`? Check — if not, extend the pydantic import line.)

Append to `routes/artifacts.py`:

```python
@router.post("/navigations/evaluate")
def evaluate_navigation(
    payload: EvaluateNavigationIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ChainPageOut:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).
    Stateless offset paging: the evaluator's deterministic chain order makes
    re-evaluating per page sound. No write_mutex — same benign-race stance as
    routes/read.py."""
    metamodel, model = require_model(session)

    def _fetch(artifact_id: str) -> NavigationDefinition:
        row = content.get_artifact(db, artifact_id)
        if (
            row is None
            or row.project_id != project_id
            or row.kind is not ArtifactKind.navigation
        ):
            raise LookupError(artifact_id)
        return NAVIGATION_ADAPTER.validate_python(row.payload)

    try:
        if payload.artifact_id is not None:
            defn = _fetch(payload.artifact_id)
            defn = resolve_refs(defn, _fetch, frozenset({payload.artifact_id}))
        else:
            assert payload.definition is not None  # schema: exactly one
            defn = resolve_refs(payload.definition, _fetch)
        result = evaluate(metamodel, model, defn)
    except LookupError as exc:
        raise HTTPException(
            status_code=422, detail=f"unknown navigation artifact {exc}"
        ) from exc
    except NavigationResolveError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    window = result.chains[payload.offset : payload.offset + payload.limit]
    return ChainPageOut(
        step_types=result.step_types,
        chains=[[_tree_item(model, eid) for eid in chain] for chain in window],
        total=len(result.chains),
        truncated=result.truncated,
    )
```

New imports in `routes/artifacts.py`:

```python
from data_rover.core.navigation.evaluate import evaluate
from data_rover.core.navigation.resolve import NavigationResolveError, resolve_refs
from data_rover.core.navigation.schema import NavigationDefinition

from ..deps import require_model
from ..schemas import ChainPageOut, EvaluateNavigationIn
from .read import _tree_item
```

(`_tree_item` at `routes/read.py:484` is module-private by convention but in-package reuse beats duplicating the display-name/child-count logic; add a `# shared lite projection` comment at the import.)

In `authz.py`, extend the tuple (and its docstring list) at :45:

```python
_READ_ONLY_POST_SUFFIXES = (
    "/model/search",
    "/model/elements/batch",
    "/model/elements/tree-items",
    "/model/validate",
    "/commits/preview",
    "/metamodel/diff",
    "/clone",
    "/navigations/evaluate",
)
```

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-backend`

```bash
git add src/data_rover/api/routes/artifacts.py src/data_rover/api/schemas.py src/data_rover/api/authz.py tests/api/test_artifacts_routes.py
git commit -m "feat(api): POST /navigations/evaluate with ref resolution + paging"
```

---

### Task 10: View schema — artifact references (`Folder.artifacts`)

The frontend places artifacts in view folders (Stage 1 frontend plan). The core `Folder` and the wire `FolderOut`/`ViewIn` must carry the new field. Additive: old view blobs (no `artifacts` key) parse unchanged. Per the approved spec deviation, there is NO pruning and NO server-side existence warning in Stage 1 (`validate_view` can't see the DB; clients skip unknown ids at render).

**Files:**
- Modify: `src/data_rover/core/view/schema.py`
- Modify: `src/data_rover/api/schemas.py` (`FolderOut` at :153, `ViewIn` at :182)
- Test: `tests/view/test_loader.py` or a new `tests/view/test_artifact_refs.py` (create), `tests/api/test_view_routes.py` (append one round-trip test)

**Interfaces:**
- Produces: `core.view.schema.ArtifactRef(id: str, kind: str)`; `Folder.artifacts: list[ArtifactRef] = []`; wire mirror on `FolderOut`. The frontend `FolderSchema` mirrors this shape (`{id, kind}` objects) — field names are load-bearing for the frontend plan.

- [ ] **Step 1: Write the failing tests**

`tests/view/test_artifact_refs.py`:

```python
"""Folder.artifacts: additive artifact references ({id, kind}) alongside
element ids. Old view documents without the key parse unchanged; validation
does NOT check artifact existence (artifacts live in the DB, invisible to
core; renderers skip unknown ids)."""

from data_rover.core.view.schema import ArtifactRef, Folder, View


def test_old_documents_parse_without_artifacts() -> None:
    view = View.model_validate(
        {"name": "v", "folders": [{"name": "f", "folders": [], "elements": ["e1"]}]}
    )
    assert view.folders[0].artifacts == []


def test_artifact_refs_round_trip() -> None:
    view = View.model_validate(
        {"name": "v", "folders": [{
            "name": "f",
            "artifacts": [{"id": "a1", "kind": "navigation"}],
        }]}
    )
    ref = view.folders[0].artifacts[0]
    assert ref == ArtifactRef(id="a1", kind="navigation")
    dumped = view.model_dump()
    assert dumped["folders"][0]["artifacts"] == [{"id": "a1", "kind": "navigation"}]
```

Append to `tests/api/test_view_routes.py`:

```python
def test_view_snapshot_round_trips_artifact_refs(client: TestClient) -> None:
    _bootstrap(client)
    res = client.put(
        f"{API}/view/snapshot",
        json={"name": "V", "folders": [{
            "name": "F", "folders": [], "elements": [],
            "artifacts": [{"id": "a1", "kind": "navigation"}],
        }]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["view"]["folders"][0]["artifacts"] == [
        {"id": "a1", "kind": "navigation"}
    ]
    got = client.get(f"{API}/view")
    assert got.json()["view"]["folders"][0]["artifacts"] == [
        {"id": "a1", "kind": "navigation"}
    ]
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/view/test_artifact_refs.py -v`
Expected: FAIL — `ImportError: cannot import name 'ArtifactRef'`.

- [ ] **Step 3: Implement**

In `core/view/schema.py`, add before `Folder`:

```python
class ArtifactRef(BaseModel):
    """A reference to a project artifact (saved navigation/table/diagram)
    placed in this folder. Like element refs, the view does not OWN the
    artifact: deleting the artifact leaves the ref dangling and renderers
    skip ids they cannot resolve (the same tolerate-don't-prune stance as
    element refs — see validate_view)."""

    id: str
    kind: str
```

and on `Folder`, after `elements`:

```python
    artifacts: list[ArtifactRef] = Field(default_factory=list)
```

In `api/schemas.py`, extend `FolderOut`:

```python
class FolderOut(BaseModel):
    name: str
    folders: list["FolderOut"] = Field(default_factory=list)
    elements: list[str] = Field(default_factory=list)
    artifacts: list[ArtifactRefOut] = Field(default_factory=list)

    @classmethod
    def from_core(cls, folder: Folder) -> "FolderOut":
        return cls(
            name=folder.name,
            folders=[FolderOut.from_core(f) for f in folder.folders],
            elements=list(folder.elements),
            artifacts=[
                ArtifactRefOut(id=a.id, kind=a.kind) for a in folder.artifacts
            ],
        )
```

with, defined just above `FolderOut`:

```python
class ArtifactRefOut(BaseModel):
    id: str
    kind: str
```

`ViewIn.to_core()` already round-trips via `model_dump()` → `View.model_validate`, so it picks the field up from `FolderOut` with no further change.

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/view tests/api/test_view_routes.py -v`
Expected: PASS (new + existing).

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-core && pixi run lint-backend`

```bash
git add src/data_rover/core/view/schema.py src/data_rover/api/schemas.py tests/view/test_artifact_refs.py tests/api/test_view_routes.py
git commit -m "feat(view): artifact references in view folders (additive)"
```

---

### Task 11: Full verification

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `pixi run test-core`
Expected: everything green (core + api + migration + view suites).

- [ ] **Step 2: Full lint/typecheck**

Run: `pixi run tidy`
Expected: ruff format/lint, mypy, pyright all pass across core + backend (frontend untouched — no diffs there).

- [ ] **Step 3: Manual smoke via the running server (optional but recommended)**

Start `pixi run start-backend` with a sqlite DSN + `DATA_ROVER_DEV_SEED=true`, import the smart-city example via the importer CLI (see CLAUDE.md), then:

```bash
curl -s -X POST "http://127.0.0.1:8000/api/v1/projects/<id>/navigations/evaluate" \
  -H 'content-type: application/json' -H 'X-User-Id: dev' \
  -d '{"definition": {"kind": "path", "start": {"kind": "scope"}, "steps": []}}' | head -c 400
```

Expected: JSON with `chains`, `total`, `truncated: false`.

- [ ] **Step 4: Commit any straggling fixes**

```bash
git status  # should be clean; commit fixes if lint/tests required any
```
