# Stage 2 — Table System — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server side of the table system — a `RowStart` navigation
sentinel, a `core/table/` schema + evaluator, two read-only API routes
(`/tables/evaluate`, `/tables/export`), a per-session row-order cache, and
root-level artifact placement in the view schema.

**Architecture:** Tables are `project_artifacts` rows with `kind='table'`; the
definition is the row's `payload` JSON. A pure evaluator over `(metamodel, model)`
turns a definition into ordered `RowKey` tuples and paged cells; a session LRU
caches the ordered row list per `(resolved-definition fingerprint, sort,
model_rev)`. Excel export is an `openpyxl` writer in the API layer consuming a core
row iterator — core stays xlsx-free.

**Tech Stack:** Python 3.14 (pyright floor 3.10), pydantic 2, FastAPI, SQLAlchemy
2, openpyxl (new), pytest. Everything runs through **pixi**.

## Global Constraints

- Run everything through pixi: `pixi run -e core-dev pytest <args>` for tests,
  `pixi run tidy` before finishing. There is no global `python`.
- **All three of ruff, mypy, and pyright must pass** (`pixi run lint-core`,
  `lint-backend`).
- Pyright floor is **3.10**: import `Self`/`assert_never` from `typing_extensions`,
  not `typing`. No stdlib features newer than 3.10.
- Core stays dependency-light: `core/` must not import `openpyxl`, FastAPI, or
  SQLAlchemy. The xlsx writer lives in `api/`.
- API tests need no DB service — `tests/api/conftest.py` runs in-memory SQLite.
  Data-route tests use `client` + `seed_default_project`/`AUTH_HEADERS`/`papi`.
- `Metamodel` is immutable with lazy caches; use its cached lookups
  (`element_descendants`, `effective_element_properties`, `is_element_subtype`),
  never re-walk `extends`.
- `Model` mutations go only through `Model` methods; the evaluator is **read-only**
  over `(metamodel, model)` and takes no `Session`.
- Chain convention (from Stage 1): an evaluated chain **includes its start element
  at index 0**; N relationship steps → chains of length N+1.

---

### Task 1: `RowStart` navigation sentinel

**Files:**
- Modify: `src/data_rover/core/navigation/schema.py`
- Modify: `src/data_rover/core/navigation/evaluate.py`
- Test: `tests/navigation/test_schema.py`, `tests/navigation/test_evaluate_path.py`

**Interfaces:**
- Consumes: existing `Scope`, `SetExpression`, `PathNavigation`, `evaluate()`.
- Produces: `RowStart` (BaseModel, `kind: Literal["row"]`); `StartNode` union now
  includes it; `evaluate(metamodel, model, defn, limits=EvalLimits(), *,
  row_elements: Sequence[str] | None = None) -> ChainResult`.

- [ ] **Step 1: Write the failing schema test**

In `tests/navigation/test_schema.py`:

```python
def test_row_start_parses_and_is_discriminated():
    from data_rover.core.navigation.schema import NAVIGATION_ADAPTER, RowStart
    defn = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "row"}, "steps": []}
    )
    assert defn.start == RowStart()

def test_schema_version_is_3():
    from data_rover.core.navigation.schema import SCHEMA_VERSION
    assert SCHEMA_VERSION == 3

def test_old_v2_payload_still_valid():
    from data_rover.core.navigation.schema import NAVIGATION_ADAPTER
    defn = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "schema_version": 2,
         "start": {"kind": "scope", "types": ["Block"]}, "steps": []}
    )
    assert defn.kind == "path"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/navigation/test_schema.py -k "row_start or schema_version_is_3 or old_v2" -v`
Expected: FAIL (`RowStart` undefined / `SCHEMA_VERSION` still 2).

- [ ] **Step 3: Add `RowStart` and bump the version**

In `schema.py`, change `SCHEMA_VERSION = 2` to `SCHEMA_VERSION = 3`, and add
before the `StartNode` alias:

```python
class RowStart(BaseModel):
    """Start = the element(s) this navigation is rooted at by its caller.

    Only meaningful when `evaluate()` is given a row binding (table columns
    supply one per row). Reaching a RowStart with no binding is a ValueError:
    a row-rooted definition is not evaluable on its own."""

    kind: Literal["row"] = "row"
```

Change the alias:

```python
StartNode = Annotated[
    Union[Scope, SetExpression, RowStart], Field(discriminator="kind")
]
```

- [ ] **Step 4: Write the failing evaluator test**

In `tests/navigation/test_evaluate_path.py` (reuse the module's `_mm()`/`_fixture()`
helpers — read the top of the file first):

```python
def test_row_start_binds_to_given_elements():
    mm = _mm()
    model, ids = _fixture(mm)
    defn = _path(start={"kind": "row"}, steps=[])
    from data_rover.core.navigation.schema import NAVIGATION_ADAPTER
    d = NAVIGATION_ADAPTER.validate_python(defn)
    res = evaluate(mm, model, d, row_elements=[ids["a"]])
    assert res.chains == [(ids["a"],)]

def test_row_start_without_binding_raises():
    mm = _mm()
    model, ids = _fixture(mm)
    from data_rover.core.navigation.schema import NAVIGATION_ADAPTER
    d = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "row"}, "steps": []}
    )
    import pytest
    with pytest.raises(ValueError):
        evaluate(mm, model, d)
```

(If the helper element key is not `"a"`, adjust to whatever `_fixture` returns.)

- [ ] **Step 5: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/navigation/test_evaluate_path.py -k row_start -v`
Expected: FAIL (`evaluate()` has no `row_elements` kwarg).

- [ ] **Step 6: Thread `row_elements` through the evaluator**

In `evaluate.py`, add the keyword-only parameter to `evaluate()`:

```python
def evaluate(
    metamodel: Metamodel,
    model: Model,
    defn: NavigationDefinition,
    limits: EvalLimits = EvalLimits(),
    *,
    row_elements: Sequence[str] | None = None,
) -> ChainResult:
```

Import `Sequence` from `collections.abc` and `RowStart` from `.schema`. In
`_start_ids`, add a branch **before** the `SetExpression` check:

```python
    if isinstance(defn.start, RowStart):
        if row_elements is None:
            raise ValueError(
                "navigation is row-rooted; no row element bound"
            )
        return sorted(dict.fromkeys(row_elements))
```

`_start_ids` must receive `row_elements`; pass it from `evaluate()` and from the
set-expression path (`_evaluate_set` → operand definitions). For Task 1 scope,
thread it only into the top-level `_start_ids` call; a row-rooted definition inside
a set operand is covered by Task 2's tests (the same parameter, passed down through
`_evaluate_set` and `_operand_members`). Add `row_elements=row_elements` to those
internal calls so a `{kind:"row"}` start nested in a set expression also binds.

- [ ] **Step 7: Run to verify all navigation tests pass**

Run: `pixi run -e core-dev pytest tests/navigation/ -v`
Expected: PASS (new tests green, all prior tests still green).

- [ ] **Step 8: Lint**

Run: `pixi run lint-core`
Expected: ruff + mypy + pyright clean.

- [ ] **Step 9: Commit**

```bash
git add src/data_rover/core/navigation/ tests/navigation/
git commit -m "feat(navigation): add RowStart sentinel bound to caller-supplied elements"
```

---

### Task 2: Row-rooted resolve support + evaluate endpoint binding

**Files:**
- Modify: `src/data_rover/api/schemas.py:681` (`EvaluateNavigationIn`)
- Modify: `src/data_rover/api/routes/artifacts.py:195-241` (`evaluate_navigation`)
- Test: `tests/api/test_artifacts_routes.py`

**Interfaces:**
- Consumes: `evaluate(..., row_elements=...)` from Task 1.
- Produces: `EvaluateNavigationIn.row_element_id: str | None = None`; the evaluate
  route passes `row_elements=[row_element_id]` when present.

- [ ] **Step 1: Write the failing API test**

In `tests/api/test_artifacts_routes.py` (reuse `_bootstrap_model` — read the top of
the file first; it returns a `{name: id}` map of seeded Block elements):

```python
def test_evaluate_row_rooted_navigation_binds_row_element(client):
    names = _bootstrap_model(client)
    root_id = names["Vehicle"]  # any seeded element with an outgoing BlockHasPart
    body = {
        "definition": {
            "kind": "path",
            "start": {"kind": "row"},
            "steps": [{"kind": "relationship",
                       "relationship_type": "BlockHasPart", "direction": "out"}],
        },
        "row_element_id": root_id,
    }
    r = client.post(papi("/navigations/evaluate"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    chains = r.json()["chains"]
    assert all(chain[0]["id"] == root_id for chain in chains)

def test_evaluate_row_rooted_without_binding_422(client):
    _bootstrap_model(client)
    body = {"definition": {"kind": "path", "start": {"kind": "row"}, "steps": []}}
    r = client.post(papi("/navigations/evaluate"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 422
```

(Adjust `names[...]` to a real seeded name; check `_bootstrap_model`'s return.)

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -k row_rooted -v`
Expected: FAIL (`row_element_id` rejected as extra field).

- [ ] **Step 3: Add the field to `EvaluateNavigationIn`**

In `schemas.py`, inside `EvaluateNavigationIn`, add:

```python
    row_element_id: str | None = None
```

- [ ] **Step 4: Pass the binding through the route**

In `artifacts.py`, change the `evaluate()` call inside `evaluate_navigation`:

```python
        row_elements = (
            [payload.row_element_id] if payload.row_element_id is not None else None
        )
        result = evaluate(metamodel, model, defn, row_elements=row_elements)
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -k row_rooted -v`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

```bash
pixi run lint-backend
git add src/data_rover/api/ tests/api/test_artifacts_routes.py
git commit -m "feat(api): bind evaluate endpoint to an optional row element"
```

---

### Task 3: Table definition schema

**Files:**
- Create: `src/data_rover/core/table/__init__.py` (empty)
- Create: `src/data_rover/core/table/schema.py`
- Test: `tests/table/__init__.py` (empty), `tests/table/test_schema.py`

**Interfaces:**
- Consumes: `Criterion` (`core.search.criteria`), `NavigationDefinition`
  (`core.navigation.schema`).
- Produces: `TableDefinition`, `TABLE_ADAPTER: TypeAdapter[TableDefinition]`,
  `SCHEMA_VERSION = 1`, `MAX_COLUMNS = 50`, and the models `NavigationSource`,
  `ScopeRows`, `NavigationRows`, `ChainRows`, `RowSlot`, `ColumnRef`,
  `ElementColumn`, `PropertyColumn`, `NavigationColumn`, and the aliases
  `RowSource`, `ColumnSource`, `Column`.

- [ ] **Step 1: Write the failing schema tests**

In `tests/table/test_schema.py`:

```python
import pytest
from pydantic import ValidationError
from data_rover.core.table.schema import TABLE_ADAPTER, SCHEMA_VERSION


def _table(**kw):
    base = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row", "chain_index": 0}}],
    }
    base.update(kw)
    return TABLE_ADAPTER.validate_python(base)


def test_minimal_table_parses():
    t = _table()
    assert t.schema_version == SCHEMA_VERSION
    assert t.default_cell_mode == "collapse"


def test_columns_min_length_one():
    with pytest.raises(ValidationError):
        _table(columns=[])


def test_column_ref_must_point_backward():
    with pytest.raises(ValidationError):
        _table(columns=[
            {"kind": "element", "source": {"kind": "column", "index": 1}},
            {"kind": "element", "source": {"kind": "row"}},
        ])


def test_navigation_column_source_must_be_element_producing():
    # a property column produces values, not elements
    with pytest.raises(ValidationError):
        _table(columns=[
            {"kind": "property", "source": {"kind": "row"}, "name": "mass"},
            {"kind": "navigation", "source": {"kind": "column", "index": 0},
             "navigation": {"definition": {"kind": "path",
                             "start": {"kind": "row"}, "steps": []}}},
        ])


def test_element_column_source_must_be_single_binding():
    # sourcing an element column from a collapse navigation column (n elements)
    with pytest.raises(ValidationError):
        _table(columns=[
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
             "navigation": {"definition": {"kind": "path",
                             "start": {"kind": "row"}, "steps": []}}},
            {"kind": "element", "source": {"kind": "column", "index": 0}},
        ])


def test_chain_index_nonzero_requires_chains_source():
    with pytest.raises(ValidationError):
        _table(columns=[{"kind": "element", "source": {"kind": "row", "chain_index": 2}}])


def test_chain_index_nonzero_ok_with_chains_source():
    t = _table(
        row_source={"kind": "chains",
                    "navigation": {"definition": {"kind": "path",
                                   "start": {"kind": "scope", "types": ["Block"]},
                                   "steps": []}}},
        columns=[{"kind": "element", "source": {"kind": "row", "chain_index": 2}}],
    )
    assert t.columns[0].source.chain_index == 2
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_schema.py -v`
Expected: FAIL (module `data_rover.core.table.schema` does not exist).

- [ ] **Step 3: Write the schema module**

Create `src/data_rover/core/table/schema.py`:

```python
"""The `kind='table'` artifact payload schema.

A table's rows are TUPLES OF BINDINGS: the row source contributes one binding
slot (scope / navigation) or N (chains, one per chain column), and every
`expand` column contributes one more. Each column names a `source` — an earlier
binding slot or an earlier column — that resolves to an ordered set of elements;
the column maps over it. `collapse` keeps the mapped values in one cell;
`expand` promotes them to a new binding slot (one row per value).

Static validation here rejects cycles (a ColumnRef must point strictly
backward), non-element navigation sources, multi-binding element sources, and
chain_index on a non-chains row source. Two further rules need the metamodel or
the resolved navigation and are checked at evaluation time (see evaluate.py):
expand-on-a-scalar-property and chain_index-out-of-range.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

from data_rover.core.navigation.schema import NavigationDefinition
from data_rover.core.search.criteria import Criterion

SCHEMA_VERSION = 1
MAX_COLUMNS = 50


class NavigationSource(BaseModel):
    """Exactly one of `ref` (saved artifact id) / `definition` (inline)."""

    ref: str | None = None
    definition: NavigationDefinition | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "NavigationSource":
        if (self.ref is None) == (self.definition is None):
            raise ValueError("provide exactly one of `ref` / `definition`")
        return self


# ---- row source -------------------------------------------------------------
class ScopeRows(BaseModel):
    kind: Literal["scope"] = "scope"
    types: list[str] = Field(default_factory=list)
    criteria: list[Criterion] = Field(default_factory=list)


class NavigationRows(BaseModel):
    kind: Literal["navigation"] = "navigation"
    navigation: NavigationSource
    step_index: int | None = None


class ChainRows(BaseModel):
    kind: Literal["chains"] = "chains"
    navigation: NavigationSource


RowSource = Annotated[
    Union[ScopeRows, NavigationRows, ChainRows], Field(discriminator="kind")
]


# ---- column source ----------------------------------------------------------
class RowSlot(BaseModel):
    kind: Literal["row"] = "row"
    chain_index: int = Field(default=0, ge=0)


class ColumnRef(BaseModel):
    kind: Literal["column"] = "column"
    index: int = Field(ge=0)


ColumnSource = Annotated[Union[RowSlot, ColumnRef], Field(discriminator="kind")]


# ---- columns ----------------------------------------------------------------
class ElementColumn(BaseModel):
    kind: Literal["element"] = "element"
    source: ColumnSource = Field(default_factory=RowSlot)
    header: str = ""
    width_px: int | None = None


class PropertyColumn(BaseModel):
    kind: Literal["property"] = "property"
    source: ColumnSource = Field(default_factory=RowSlot)
    name: str
    mode: Literal["collapse", "expand"] = "collapse"
    keep_empty: bool = True
    header: str = ""
    width_px: int | None = None


class NavigationColumn(BaseModel):
    kind: Literal["navigation"] = "navigation"
    source: ColumnSource = Field(default_factory=RowSlot)
    navigation: NavigationSource
    step_index: int | None = None
    mode: Literal["collapse", "expand"] = "collapse"
    keep_empty: bool = True
    sort_mode: Literal["value", "count"] = "value"
    cell_cap: int = Field(default=20, ge=1)
    header: str = ""
    width_px: int | None = None


Column = Annotated[
    Union[ElementColumn, PropertyColumn, NavigationColumn],
    Field(discriminator="kind"),
]


class TableDefinition(BaseModel):
    schema_version: int = SCHEMA_VERSION
    row_source: RowSource
    columns: list[Column] = Field(min_length=1, max_length=MAX_COLUMNS)
    default_cell_mode: Literal["collapse", "expand"] = "collapse"

    @model_validator(mode="after")
    def _validate_sources(self) -> "TableDefinition":
        is_chains = self.row_source.kind == "chains"
        for i, col in enumerate(self.columns):
            src = col.source
            # backward-only column refs
            if isinstance(src, ColumnRef) and src.index >= i:
                raise ValueError(
                    f"column {i} sources column {src.index} (must be < {i})"
                )
            # chain_index only on a chains row source
            if isinstance(src, RowSlot) and src.chain_index != 0 and not is_chains:
                raise ValueError("chain_index != 0 requires a chains row source")
            # is the source element-producing, and is it single-binding?
            producing, single = self._source_arity(src)
            if col.kind == "navigation" and not producing:
                raise ValueError(f"column {i}: navigation source is not element-producing")
            if col.kind == "element" and not single:
                raise ValueError(f"column {i}: element column needs a single-binding source")
            if (
                col.kind == "property"
                and col.mode == "expand"
                and not single
            ):
                raise ValueError(
                    f"column {i}: expanded property needs a single-binding source"
                )
        return self

    def _source_arity(self, src: "ColumnSource") -> tuple[bool, bool]:
        """(element_producing, single_binding) for a column source.

        A row slot is always element-producing and single. A ColumnRef inherits
        from the referenced column: element/expand columns are single-binding
        elements; a collapse navigation column is multi-binding elements; a
        property column is not element-producing.
        """
        if isinstance(src, RowSlot):
            return True, True
        ref = self.columns[src.index]
        if ref.kind == "element":
            return True, True
        if ref.kind == "navigation":
            single = ref.mode == "expand"
            return True, single
        # property column
        return False, ref.mode == "expand"


TABLE_ADAPTER: TypeAdapter[TableDefinition] = TypeAdapter(TableDefinition)
```

Create empty `src/data_rover/core/table/__init__.py` and `tests/table/__init__.py`.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/table/test_schema.py -v`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-core
git add src/data_rover/core/table/ tests/table/
git commit -m "feat(table): add TableDefinition schema with static source validation"
```

---

### Task 4: Row building — scope, navigation, chains, expand

**Files:**
- Create: `src/data_rover/core/table/evaluate.py`
- Test: `tests/table/test_build_rows.py`

**Interfaces:**
- Consumes: `TableDefinition` (Task 3); `evaluate(..., row_elements=...)`,
  `EvalLimits`, `resolve_refs` (navigation); `Metamodel`, `Model`.
- Produces:
  - `Binding = str | int | float | bool | None`, `RowKey = tuple[Binding, ...]`.
  - `@dataclass(frozen=True) TableLimits` (`max_rows=50_000`,
    `max_sort_rows=20_000`, `max_cell_elements=20`,
    `nav_limits: EvalLimits = EvalLimits()`).
  - `def build_rows(mm, model, defn, limits=TableLimits()) -> tuple[list[RowKey], bool]`.
  - `def resolve_source_elements(mm, model, defn, key, source, base_slots, limits) -> list[str]`
    (used by build + cells + sort; ordered element ids a column source resolves to
    for one row; `base_slots` = leading row-source slot count).
  - `def _row_source_base_slots(defn, base_keys) -> int` and
    `def _expand_slot_of(defn, base_slots, col_index) -> int` (slot arithmetic
    shared with cells/sort).

The table evaluator assumes a **ref-free** definition (the API layer resolves
navigation refs before calling — mirroring `navigation.evaluate`). Add a module
docstring saying so.

- [ ] **Step 1: Write the failing tests**

In `tests/table/test_build_rows.py`. Build a small metamodel/model in-process
following `tests/navigation/test_evaluate_path.py`'s `_mm()`/`_fixture()` pattern —
read that file first, then adapt: a `Block` type with a `mass` property
(`datatype="integer"`, `multiplicity="0..*"` for one Block to exercise expand) and
a `BlockHasPart` relationship.

```python
from data_rover.core.table.schema import TABLE_ADAPTER
from data_rover.core.table.evaluate import build_rows, TableLimits
# _mm(), _fixture() copied/adapted from tests/navigation/test_evaluate_path.py


def test_scope_rows_one_binding_per_element():
    mm = _mm(); model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    keys, truncated = build_rows(mm, model, defn)
    assert not truncated
    assert sorted(keys) == sorted((eid,) for eid in ids.values())


def test_expand_navigation_column_cross_product():
    mm = _mm(); model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    # every key is (block_id, part_id); the parent appears once per owned part
    parent = ids["root"]
    part_keys = [k for k in keys if k[0] == parent]
    assert len(part_keys) == 2  # root owns 2 parts in the fixture
    assert all(len(k) == 2 for k in part_keys)


def test_expand_keep_empty_true_keeps_barren_row():
    mm = _mm(); model, ids = _fixture(mm)
    leaf = ids["leaf"]  # a Block with no outgoing BlockHasPart
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "keep_empty": True,
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    assert (leaf, None) in keys


def test_expand_keep_empty_false_drops_barren_row():
    mm = _mm(); model, ids = _fixture(mm)
    leaf = ids["leaf"]
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "keep_empty": False,
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    assert all(k[0] != leaf for k in keys)


def test_max_rows_truncates():
    mm = _mm(); model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    keys, truncated = build_rows(mm, model, defn, TableLimits(max_rows=1))
    assert truncated and len(keys) == 1


def test_column_sourced_from_expand_column_binds_that_rows_element():
    # col0 expands owned parts (one row per part); col1 navigates FROM col0.
    # Each row's col1 must root at THAT row's part, not the parent's whole set.
    mm = _mm(); model, ids = _fixture(mm)
    from data_rover.core.table.evaluate import (
        resolve_source_elements, _row_source_base_slots, _base_row_keys,
    )
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
            {"kind": "navigation", "source": {"kind": "column", "index": 1},
             "mode": "collapse",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": []}}},  # identity nav: returns the source element itself
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    base_slots = 1
    # for a row whose expand slot is a specific part, col2's source resolves to
    # exactly that part (length-1), never the parent's full part set.
    a_row = next(k for k in keys if k[0] == ids["root"] and k[1] is not None)
    src = defn.columns[2].source
    resolved = resolve_source_elements(mm, model, defn, a_row, src, base_slots, TableLimits())
    assert resolved == [a_row[1]]
```

Ensure `_fixture` yields keys named `root` (owns 2 parts) and `leaf` (owns none);
adjust names to match your fixture.

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_build_rows.py -v`
Expected: FAIL (`data_rover.core.table.evaluate` does not exist).

- [ ] **Step 3: Write the row builder**

Create `src/data_rover/core/table/evaluate.py`. This task implements the row
builder and the shared source resolver; cell evaluation and sorting come in Tasks
5–6. Full code:

```python
"""Pure table evaluator over (metamodel, model). REF-FREE: navigation refs must
be resolved before calling (the API layer does this via resolve_refs).

Rows are tuples of bindings (RowKey). `build_rows` evaluates the row source and
every expand column across the WHOLE table (expansion determines the total, so
it can't be page-local); it is guarded by `max_rows`. Cell evaluation (Task 5)
runs per page. See core/table/schema.py for the binding model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Union

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import EvalLimits, evaluate
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER

from .schema import (
    ChainRows,
    Column,
    ColumnRef,
    ColumnSource,
    NavigationColumn,
    NavigationRows,
    RowSlot,
    ScopeRows,
    TableDefinition,
)

Binding = Union[str, int, float, bool, None]
RowKey = tuple[Binding, ...]


@dataclass(frozen=True)
class TableLimits:
    max_rows: int = 50_000
    max_sort_rows: int = 20_000
    max_cell_elements: int = 20
    nav_limits: EvalLimits = field(default_factory=EvalLimits)


def _scope_row_keys(mm: Metamodel, model: Model, rs: ScopeRows) -> list[RowKey]:
    from data_rover.core.navigation.schema import Scope
    from data_rover.core.navigation.evaluate import _scope_ids  # reuse Stage 1

    scope = Scope(types=rs.types, criteria=rs.criteria)
    return [(eid,) for eid in _scope_ids(mm, model, scope)]


def _nav_definition(nav) -> object:
    # ref-free: definition is present (API resolved refs). Validate to the model.
    assert nav.definition is not None, "table evaluator requires ref-free navigation"
    return NAVIGATION_ADAPTER.validate_python(
        nav.definition.model_dump()
    ) if not hasattr(nav.definition, "kind") else nav.definition


def _navigation_row_keys(
    mm: Metamodel, model: Model, rs: NavigationRows, limits: TableLimits
) -> list[RowKey]:
    defn = rs.navigation.definition
    assert defn is not None
    result = evaluate(mm, model, defn, limits.nav_limits)
    idx = rs.step_index if rs.step_index is not None else -1
    seen: dict[str, None] = {}
    for chain in result.chains:
        seen[chain[idx]] = None
    return [(eid,) for eid in seen]


def _chain_row_keys(
    mm: Metamodel, model: Model, rs: ChainRows, limits: TableLimits
) -> list[RowKey]:
    defn = rs.navigation.definition
    assert defn is not None
    result = evaluate(mm, model, defn, limits.nav_limits)
    return [tuple(chain) for chain in result.chains]


def _base_row_keys(
    mm: Metamodel, model: Model, defn: TableDefinition, limits: TableLimits
) -> list[RowKey]:
    rs = defn.row_source
    if isinstance(rs, ScopeRows):
        return _scope_row_keys(mm, model, rs)
    if isinstance(rs, NavigationRows):
        return _navigation_row_keys(mm, model, rs, limits)
    return _chain_row_keys(mm, model, rs, limits)


def _expand_slot_of(defn: TableDefinition, base_slots: int, col_index: int) -> int:
    """Key slot holding the binding produced by the expand column at
    `col_index`: base slots + the number of expand columns strictly before it.

    Correct for BOTH a fully-built key and a partial key mid-`build_rows`,
    because a column's source can only reference EARLIER columns (schema
    guarantee), so the referenced expand slot is always already present."""
    before = sum(
        1
        for i, c in enumerate(defn.columns)
        if i < col_index and getattr(c, "mode", "collapse") == "expand"
    )
    return base_slots + before


def resolve_source_elements(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    source: ColumnSource,
    base_slots: int,
    limits: TableLimits,
) -> list[str]:
    """Ordered element ids a column source resolves to for ONE row.

    `base_slots` is the number of leading row-source slots (1 for scope/nav; the
    chain length for chains) — passed explicitly because a partial key mid-build
    can't reveal it. A RowSlot reads key[chain_index]. A ColumnRef resolves per
    the referenced column: an element column passes its own source through; an
    EXPAND column (navigation or property) already put one binding per row, so we
    read that row's key slot directly (this is what makes source-from-another-cell
    row-correct); a COLLAPSE navigation column is re-evaluated from its source.
    """
    if isinstance(source, RowSlot):
        b = key[source.chain_index]
        return [b] if isinstance(b, str) else []
    ref_col = defn.columns[source.index]
    if getattr(ref_col, "mode", "collapse") == "expand":
        b = key[_expand_slot_of(defn, base_slots, source.index)]
        return [b] if isinstance(b, str) else []
    if ref_col.kind == "element":
        return resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits
        )
    if ref_col.kind == "navigation":
        roots = resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits
        )
        return _navigation_reached(mm, model, ref_col, roots, limits)
    return []  # property columns are not element-producing (schema rejects this)


def _navigation_reached(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn,
    roots: list[str],
    limits: TableLimits,
) -> list[str]:
    defn = col.navigation.definition
    assert defn is not None
    if not roots:
        return []
    result = evaluate(mm, model, defn, limits.nav_limits, row_elements=roots)
    idx = col.step_index if col.step_index is not None else -1
    seen: dict[str, None] = {}
    for chain in result.chains:
        seen[chain[idx]] = None
    return list(seen)


def _row_source_base_slots(defn: TableDefinition, base_keys: list[RowKey]) -> int:
    """1 for scope/navigation; the chain length for chains (read off any key)."""
    if defn.row_source.kind != "chains":
        return 1
    return len(base_keys[0]) if base_keys else 1


def build_rows(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    limits: TableLimits = TableLimits(),
) -> tuple[list[RowKey], bool]:
    keys = _base_row_keys(mm, model, defn, limits)
    base_slots = _row_source_base_slots(defn, keys)
    truncated = False
    # apply each expand column in declaration order, extending the key tuple
    for col in defn.columns:
        mode = getattr(col, "mode", "collapse")
        if mode != "expand":
            continue
        new_keys: list[RowKey] = []
        for key in keys:
            roots = resolve_source_elements(
                mm, model, defn, key, col.source, base_slots, limits
            )
            reached = _expand_values(mm, model, defn, col, key, roots, limits)
            if not reached:
                if col.keep_empty:
                    new_keys.append((*key, None))
            else:
                for v in reached:
                    new_keys.append((*key, v))
            if len(new_keys) > limits.max_rows:
                truncated = True
                new_keys = new_keys[: limits.max_rows]
                break
        keys = new_keys
        if truncated:
            break
    if len(keys) > limits.max_rows:
        keys = keys[: limits.max_rows]
        truncated = True
    return keys, truncated


def _expand_values(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    col: Column,
    key: RowKey,
    roots: list[str],
    limits: TableLimits,
) -> list[Binding]:
    if isinstance(col, NavigationColumn):
        return list(_navigation_reached(mm, model, col, roots, limits))
    # PropertyColumn expand: one row per property value. Single-binding source
    # guaranteed by schema; missing/scalar handled in Task 5's helper.
    from .cells import expand_property_values  # Task 5

    return expand_property_values(mm, model, col, roots)
```

Note: `_expand_values`'s `PropertyColumn` branch imports from `cells` (Task 5).
For **this task**, tests only exercise navigation-expand, scope, chains, and
`keep_empty`; add a `# pragma: no cover` or a temporary local stub only if the
import fails at collection — but Task 5 lands `cells.py` right after, so prefer
implementing Task 5 before running the full suite. If needed for Task 4 isolation,
inline a minimal `expand_property_values` returning `[]` and replace it in Task 5.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/table/test_build_rows.py -v`
Expected: PASS. (If the `cells` import blocks collection, temporarily stub
`expand_property_values` inline, then remove it in Task 5.)

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-core
git add src/data_rover/core/table/evaluate.py tests/table/test_build_rows.py
git commit -m "feat(table): build row keys from scope/navigation/chains with expand"
```

---

### Task 5: Cell evaluation

**Files:**
- Create: `src/data_rover/core/table/cells.py`
- Modify: `src/data_rover/core/table/evaluate.py` (import `cells`)
- Test: `tests/table/test_cells.py`

**Interfaces:**
- Consumes: `resolve_source_elements`, `RowKey`, `TableLimits` (Task 4);
  `Metamodel.effective_element_properties`; `_tree_item` is API-layer, so cells
  produce **plain dicts/dataclasses**, not `TreeItem` (keep core API-free — the
  route maps element ids to `TreeItem`).
- Produces:
  - `@dataclass Cell` variants as dataclasses: `ElementCell(element_id | None)`,
    `ValueCell(present, value, element_id, editable)`,
    `ValuesCell(present, values, total, truncated)`,
    `ElementsCell(element_ids, total, truncated)`.
  - `def evaluate_cells(mm, model, defn, keys, limits=TableLimits()) -> list[list[Cell]]`.
  - `def expand_property_values(mm, model, col, roots) -> list[Binding]`.
  - `def property_multiplicity_is_many(mm, type_name, prop) -> bool`.

Core produces element **ids** in cells; the route projects them to `TreeItem`.

- [ ] **Step 1: Write the failing tests**

In `tests/table/test_cells.py` (reuse the Task 4 fixture):

```python
from data_rover.core.table.schema import TABLE_ADAPTER
from data_rover.core.table.evaluate import build_rows
from data_rover.core.table.cells import (
    evaluate_cells, ElementCell, ValueCell, ValuesCell, ElementsCell,
)


def _eval(mm, model, doc):
    defn = TABLE_ADAPTER.validate_python(doc)
    keys, _ = build_rows(mm, model, defn)
    return defn, keys, evaluate_cells(mm, model, defn, keys)


def test_property_present_false_when_type_lacks_property():
    mm = _mm(); model, ids = _fixture(mm)
    # 'Widget' type has no 'mass' property; scope over both Block and Widget
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block", "Widget"]},
        "columns": [{"kind": "property", "source": {"kind": "row"}, "name": "mass"}],
    })
    widget_row = next(i for i, k in enumerate(keys) if k[0] == ids["widget"])
    cell = cells[widget_row][0]
    assert isinstance(cell, ValueCell) and cell.present is False and cell.editable is False


def test_property_present_true_unset_is_editable():
    mm = _mm(); model, ids = _fixture(mm)
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "property", "source": {"kind": "row"}, "name": "mass"}],
    })
    row0 = 0
    cell = cells[row0][0]
    assert isinstance(cell, ValueCell) and cell.present is True and cell.editable is True
    assert cell.element_id == keys[row0][0]


def test_collapse_navigation_cell_is_elements_cell_capped():
    mm = _mm(); model, ids = _fixture(mm)
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
            "cell_cap": 1,
            "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                "steps": [{"kind": "relationship",
                           "relationship_type": "BlockHasPart", "direction": "out"}]}}}],
    })
    root_row = next(i for i, k in enumerate(keys) if k[0] == ids["root"])
    cell = cells[root_row][0]
    assert isinstance(cell, ElementsCell)
    assert len(cell.element_ids) == 1 and cell.total == 2 and cell.truncated is True


def test_expanded_property_cell_not_editable():
    mm = _mm(); model, ids = _fixture(mm)
    # a Block whose 'tags' property is multiplicity many
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "property", "source": {"kind": "row"}, "name": "tags",
                     "mode": "expand"}],
    })
    cell = cells[0][0]
    assert isinstance(cell, ValueCell) and cell.editable is False
```

Add a `Widget` type (no `mass`) and a `tags` many-valued property to the fixture.

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_cells.py -v`
Expected: FAIL (`data_rover.core.table.cells` missing).

- [ ] **Step 3: Write `cells.py`**

Create `src/data_rover/core/table/cells.py`:

```python
"""Per-cell evaluation. Core produces element IDS (not TreeItem — that is an
API projection); the route maps ids → TreeItem. Cell kind is derived from
column kind × mode × source arity per the design table."""

from __future__ import annotations

from dataclasses import dataclass, field

from data_rover.core.metamodel.multiplicity import Multiplicity
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model

from .evaluate import (
    Binding,
    RowKey,
    TableLimits,
    _navigation_reached,
    resolve_source_elements,
)
from .schema import (
    Column,
    ElementColumn,
    NavigationColumn,
    PropertyColumn,
    TableDefinition,
)


@dataclass
class ElementCell:
    element_id: str | None


@dataclass
class ValueCell:
    present: bool
    value: object
    element_id: str | None
    editable: bool


@dataclass
class ValuesCell:
    present: bool
    values: list[object]
    total: int
    truncated: bool


@dataclass
class ElementsCell:
    element_ids: list[str]
    total: int
    truncated: bool


Cell = ElementCell | ValueCell | ValuesCell | ElementsCell


def property_multiplicity_is_many(mm: Metamodel, type_name: str, prop: str) -> bool:
    for pd in mm.effective_element_properties(type_name):
        if pd.name == prop:
            m = Multiplicity.parse(pd.multiplicity)
            return not m.is_single()
    return False


def _prop_present(mm: Metamodel, type_name: str, prop: str) -> bool:
    return any(pd.name == prop for pd in mm.effective_element_properties(type_name))


def expand_property_values(
    mm: Metamodel, model: Model, col: PropertyColumn, roots: list[str]
) -> list[Binding]:
    if not roots:
        return []
    eid = roots[0]  # single-binding source guaranteed by schema
    el = model.elements[eid]
    if not property_multiplicity_is_many(mm, el.type_name, col.name):
        raise ValueError(
            f"property {col.name!r} on {el.type_name} is not multi-valued; cannot expand"
        )
    raw = el.properties.get(col.name)
    if raw is None:
        return []
    return list(raw) if isinstance(raw, (list, tuple)) else [raw]


def _element_cell(mm, model, defn, key, col: ElementColumn, limits) -> ElementCell:
    els = resolve_source_elements(mm, model, defn, key, col.source, limits)
    return ElementCell(element_id=els[0] if els else None)


def _property_cell(mm, model, defn, key, col: PropertyColumn, limits) -> Cell:
    els = resolve_source_elements(mm, model, defn, key, col.source, limits)
    if col.mode == "expand":
        # the value already sits in a key slot; find it by re-reading is complex,
        # so render the value carried on the row: expand appended it last relative
        # to this column's position. Simplest correct approach: recompute the one
        # value for this row from the single source element + property, but expand
        # rows can carry duplicates; instead read the binding the builder stored.
        # The builder appends expand bindings in column order, so the slot index
        # equals len(base slots) + (# expand columns strictly before this one).
        slot = _expand_slot_index(defn, col)
        val = key[slot]
        return ValueCell(present=els != [] or val is not None, value=val,
                         element_id=None, editable=False)
    if not els:
        return ValueCell(present=False, value=None, element_id=None, editable=False)
    eid = els[0] if len(els) == 1 else None
    # arity: single element → value/editable; many → values/read-only
    if len(els) == 1:
        el = model.elements[els[0]]
        present = _prop_present(mm, el.type_name, col.name)
        val = el.properties.get(col.name) if present else None
        return ValueCell(present=present, value=val, element_id=els[0],
                         editable=present)
    # many-element collapse → joined read-only values
    vals: list[object] = []
    for e in els:
        el = model.elements[e]
        if _prop_present(mm, el.type_name, col.name):
            v = el.properties.get(col.name)
            if isinstance(v, (list, tuple)):
                vals.extend(v)
            elif v is not None:
                vals.append(v)
    return ValuesCell(present=True, values=vals, total=len(vals), truncated=False)


def _navigation_cell(mm, model, defn, key, col: NavigationColumn, limits) -> Cell:
    if col.mode == "expand":
        slot = _expand_slot_index(defn, col)
        b = key[slot]
        return ElementCell(element_id=b if isinstance(b, str) else None)
    roots = resolve_source_elements(mm, model, defn, key, col.source, limits)
    reached = _navigation_reached(mm, model, col, roots, limits)
    cap = min(col.cell_cap, limits.max_cell_elements)
    return ElementsCell(
        element_ids=reached[:cap], total=len(reached), truncated=len(reached) > cap
    )


def _expand_slot_index(defn: TableDefinition, col: Column) -> int:
    """Key slot that holds this expand column's binding: base slots + the number
    of expand columns declared strictly before it."""
    base = _base_slot_count(defn)
    before = 0
    for c in defn.columns:
        if c is col:
            break
        if getattr(c, "mode", "collapse") == "expand":
            before += 1
    return base + before


def _base_slot_count(defn: TableDefinition) -> int:
    if defn.row_source.kind == "chains":
        # a chains key has one slot per chain column; compute from a sample is
        # not available here, so store it: the builder pads all keys equally.
        # Base slots = length of any key minus the expand-column count. Callers
        # pass full keys, so we derive lazily in evaluate_cells instead.
        raise NotImplementedError  # replaced below
    return 1


def evaluate_cells(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    keys: list[RowKey],
    limits: TableLimits = TableLimits(),
) -> list[list[Cell]]:
    expand_count = sum(
        1 for c in defn.columns if getattr(c, "mode", "collapse") == "expand"
    )
    base_slots = (len(keys[0]) - expand_count) if keys else 1

    def expand_slot(col: Column) -> int:
        before = 0
        for c in defn.columns:
            if c is col:
                break
            if getattr(c, "mode", "collapse") == "expand":
                before += 1
        return base_slots + before

    rows: list[list[Cell]] = []
    for key in keys:
        row: list[Cell] = []
        for col in defn.columns:
            if isinstance(col, ElementColumn):
                row.append(_element_cell(mm, model, defn, key, col, limits))
            elif isinstance(col, PropertyColumn):
                row.append(
                    _property_cell_with_slot(mm, model, defn, key, col, limits, expand_slot)
                )
            else:
                row.append(
                    _navigation_cell_with_slot(mm, model, defn, key, col, limits, expand_slot)
                )
        rows.append(row)
    return rows
```

Replace the earlier `_expand_slot_index`/`_base_slot_count`/`_property_cell`/
`_navigation_cell` stubs with slot-aware variants `_property_cell_with_slot` and
`_navigation_cell_with_slot`. In `evaluate_cells`, compute
`base_slots = len(keys[0]) - expand_count` from the **full** keys (correct here,
unlike mid-build) and pass it to every `resolve_source_elements(...)` call and to
`_expand_slot_of(defn, base_slots, col_index)` (imported from `evaluate.py`) for the
expand-branch slot lookup. Drop the local `expand_slot` closure in favour of the
shared `_expand_slot_of`. Keep the `collapse`/single/many logic identical to the
sketch above; only the signatures gain `base_slots` and the expand-branch reads
`key[_expand_slot_of(defn, base_slots, source.index)]`.

Then in `evaluate.py`, replace the temporary `expand_property_values` import
guidance from Task 4 with the real import (`from .cells import expand_property_values`
inside `_expand_values`, kept function-local to avoid a circular import at module
load).

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/table/ -v`
Expected: PASS (schema, build_rows, cells).

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-core
git add src/data_rover/core/table/ tests/table/test_cells.py
git commit -m "feat(table): per-cell evaluation with present/editable derivation"
```

---

### Task 6: Sorting

**Files:**
- Modify: `src/data_rover/core/table/evaluate.py`
- Test: `tests/table/test_sort.py`

**Interfaces:**
- Consumes: `RowKey`, `TableLimits`, `resolve_source_elements`,
  `_navigation_reached`, cell helpers.
- Produces:
  - `@dataclass(frozen=True) SortSpec(column: int, direction: Literal["asc","desc"])`.
  - `def order_rows(mm, model, defn, keys, sort, limits=TableLimits()) -> list[RowKey]`
    (returns a new ordered list; `sort=None` → the input order unchanged).
  - `class SortTooLargeError(ValueError)` raised when a collapse-column sort
    exceeds `max_sort_rows`.

- [ ] **Step 1: Write the failing tests**

In `tests/table/test_sort.py`:

```python
import pytest
from data_rover.core.table.schema import TABLE_ADAPTER
from data_rover.core.table.evaluate import (
    build_rows, order_rows, SortSpec, SortTooLargeError, TableLimits,
)


def test_property_numeric_sort_empty_last_both_directions():
    mm = _mm(); model, ids = _fixture(mm)  # masses: root=10, mid=2, leaf unset
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "property", "source": {"kind": "row"}, "name": "mass"},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    asc = order_rows(mm, model, defn, keys, SortSpec(column=1, direction="asc"))
    desc = order_rows(mm, model, defn, keys, SortSpec(column=1, direction="desc"))
    assert asc[0][0] == ids["mid"]   # 2 before 10
    assert asc[-1][0] == ids["leaf"] # empty last
    assert desc[0][0] == ids["root"] # 10 first
    assert desc[-1][0] == ids["leaf"]# still empty last


def test_navigation_count_sort():
    mm = _mm(); model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "sort_mode": "count",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    desc = order_rows(mm, model, defn, keys, SortSpec(column=1, direction="desc"))
    assert desc[0][0] == ids["root"]  # owns the most parts


def test_binding_column_sort_uses_row_key():
    mm = _mm(); model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    keys, _ = build_rows(mm, model, defn)
    asc = order_rows(mm, model, defn, keys, SortSpec(column=0, direction="asc"))
    names = [model.elements[k[0]].properties.get("name", "") for k in asc]
    assert names == sorted(names, key=str.casefold)


def test_collapse_sort_over_budget_raises():
    mm = _mm(); model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"},
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    with pytest.raises(SortTooLargeError):
        order_rows(mm, model, defn, keys, SortSpec(column=1, direction="asc"),
                   TableLimits(max_sort_rows=0))
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_sort.py -v`
Expected: FAIL (`order_rows`/`SortSpec` undefined).

- [ ] **Step 3: Implement sorting**

Add to `evaluate.py`. A sentinel makes missing/empty sort last **regardless of
direction** — sort ascending on a `(is_empty, value)` tuple, then reverse only the
non-empty partition for desc, or simpler: build a key and, for desc, negate the
comparison of the value part while keeping empties last. Concretely:

```python
from dataclasses import dataclass
from typing import Literal


class SortTooLargeError(ValueError):
    pass


@dataclass(frozen=True)
class SortSpec:
    column: int
    direction: Literal["asc", "desc"]


def _display_name(model: Model, eid: str) -> str:
    el = model.elements[eid]
    n = el.properties.get("name")
    return str(n) if n is not None else el.id


def _sort_value(mm, model, defn, key, col, base_slots, limits):
    """Return (is_empty, comparable) for one row's sort column."""
    from .schema import ElementColumn, PropertyColumn, NavigationColumn
    if isinstance(col, ElementColumn):
        els = resolve_source_elements(mm, model, defn, key, col.source, base_slots, limits)
        if not els:
            return (1, "")
        return (0, (_display_name(model, els[0]).casefold(), els[0]))
    if isinstance(col, PropertyColumn):
        els = resolve_source_elements(mm, model, defn, key, col.source, base_slots, limits)
        vals = []
        numeric = _property_is_numeric(mm, defn, col)
        for e in els:
            el = model.elements[e]
            v = el.properties.get(col.name)
            if v is None:
                continue
            vals.extend(v if isinstance(v, (list, tuple)) else [v])
        if not vals:
            return (1, ())
        if numeric:
            return (0, tuple(float(x) for x in vals))
        return (0, tuple(str(x).casefold() for x in vals))
    # NavigationColumn
    roots = resolve_source_elements(mm, model, defn, key, col.source, base_slots, limits)
    reached = _navigation_reached(mm, model, col, roots, limits)
    if col.sort_mode == "count":
        return (0, len(reached)) if reached else (1, 0)
    names = tuple(sorted(_display_name(model, e).casefold() for e in reached))
    return (0, names) if reached else (1, ())


def _property_is_numeric(mm, defn, col) -> bool:
    """True only if EVERY scoped type declaring the property gives it an
    integer/float datatype."""
    types = defn.row_source.types if defn.row_source.kind == "scope" else []
    declaring = []
    for t in types:
        for pd in mm.effective_element_properties(t):
            if pd.name == col.name:
                declaring.append(pd.datatype)
    return bool(declaring) and all(dt in ("integer", "float") for dt in declaring)


def _needs_full_eval(defn, col) -> bool:
    """A collapse navigation/property column is not a plain binding → full pass."""
    return getattr(col, "mode", "collapse") != "expand" and col.kind != "element"


def order_rows(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    keys: list[RowKey],
    sort: SortSpec | None,
    limits: TableLimits = TableLimits(),
) -> list[RowKey]:
    if sort is None:
        return list(keys)
    col = defn.columns[sort.column]
    if _needs_full_eval(defn, col) and len(keys) > limits.max_sort_rows:
        raise SortTooLargeError(
            f"sorting {len(keys)} rows by a computed column exceeds "
            f"max_sort_rows={limits.max_sort_rows}"
        )
    reverse = sort.direction == "desc"
    expand_count = sum(
        1 for c in defn.columns if getattr(c, "mode", "collapse") == "expand"
    )
    base_slots = (len(keys[0]) - expand_count) if keys else 1
    decorated = []
    for k in keys:
        empty, val = _sort_value(mm, model, defn, k, col, base_slots, limits)
        decorated.append((empty, val, k))
    # empties always last: sort empties to the end in BOTH directions by keying
    # the empty flag ascending, and applying reverse only to the value part.
    non_empty = [d for d in decorated if d[0] == 0]
    empty = [d for d in decorated if d[0] == 1]
    non_empty.sort(key=lambda d: d[1], reverse=reverse)
    return [d[2] for d in non_empty] + [d[2] for d in empty]
```

Ties: `_sort_value` element/property keys already embed the id / value tuple; for
full totality, if two decorated tuples compare equal Python's sort is stable and
preserves `build_rows` order, which is deterministic — acceptable.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/table/test_sort.py -v`
Expected: PASS.

- [ ] **Step 5: Full core suite + lint + commit**

```bash
pixi run -e core-dev pytest tests/table tests/navigation -q
pixi run lint-core
git add src/data_rover/core/table/evaluate.py tests/table/test_sort.py
git commit -m "feat(table): datatype-aware sorting with empties-last and budget guard"
```

---

### Task 7: Session row-order cache

**Files:**
- Modify: `src/data_rover/api/session.py:49-97` (add field), `set_model`/`touch_model`
- Create: `src/data_rover/api/table_cache.py`
- Test: `tests/api/test_table_cache.py`

**Interfaces:**
- Consumes: `RowKey` (core), `Session`.
- Produces:
  - `class TableOrderCache` with `get(fingerprint, sort_key, model_rev) -> tuple[RowKey, ...] | None`
    and `put(fingerprint, sort_key, model_rev, rows)` and `clear()`; internal LRU
    cap 16, guarded by a `threading.Lock`.
  - `def table_fingerprint(resolved_defn_json: str, sort: SortSpec | None) -> str`
    (sha256 hex of canonical JSON + sort).
  - `Session.table_order_cache: TableOrderCache` (default factory); cleared in
    both `set_model` and `touch_model`.

- [ ] **Step 1: Write the failing tests**

In `tests/api/test_table_cache.py`:

```python
from data_rover.api.table_cache import TableOrderCache, table_fingerprint
from data_rover.core.table.evaluate import SortSpec


def test_put_get_roundtrip():
    c = TableOrderCache()
    fp = table_fingerprint('{"a":1}', None)
    c.put(fp, "none", 5, (("x",), ("y",)))
    assert c.get(fp, "none", 5) == (("x",), ("y",))


def test_stale_rev_is_a_miss():
    c = TableOrderCache()
    fp = table_fingerprint('{"a":1}', None)
    c.put(fp, "none", 5, (("x",),))
    assert c.get(fp, "none", 6) is None


def test_lru_evicts_beyond_cap():
    c = TableOrderCache(cap=2)
    for i in range(3):
        c.put(table_fingerprint(f'{{"a":{i}}}', None), "none", 1, ((str(i),),))
    # oldest (i=0) evicted
    assert c.get(table_fingerprint('{"a":0}', None), "none", 1) is None
    assert c.get(table_fingerprint('{"a":2}', None), "none", 1) is not None


def test_fingerprint_differs_by_sort():
    a = table_fingerprint('{"a":1}', None)
    b = table_fingerprint('{"a":1}', SortSpec(column=0, direction="asc"))
    assert a != b


def test_session_touch_model_clears_cache():
    from data_rover.api.session import Session
    s = Session()
    s.table_order_cache.put(table_fingerprint("{}", None), "none", 0, (("x",),))
    s.touch_model()
    assert s.table_order_cache.get(table_fingerprint("{}", None), "none", 1) is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_table_cache.py -v`
Expected: FAIL (module missing; `Session` has no `table_order_cache`).

- [ ] **Step 3: Write the cache**

Create `src/data_rover/api/table_cache.py`:

```python
"""Per-session LRU of ordered table row keys, keyed by (resolved-definition
fingerprint, sort). A stored entry also records the model_rev it was computed
at; a lookup at a different rev is a miss. Session.touch_model()/set_model clear
the whole cache. Guards dict ops with a Lock; evaluation runs OUTSIDE the lock
(a lost race merely recomputes)."""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from data_rover.core.table.evaluate import RowKey, SortSpec


def table_fingerprint(resolved_defn_json: str, sort: "SortSpec | None") -> str:
    payload = {
        "defn": resolved_defn_json,
        "sort": None if sort is None else [sort.column, sort.direction],
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class TableOrderCache:
    def __init__(self, cap: int = 16) -> None:
        self._cap = cap
        self._lock = threading.Lock()
        self._d: "OrderedDict[tuple[str, str], tuple[int, tuple[RowKey, ...]]]" = (
            OrderedDict()
        )

    def get(
        self, fingerprint: str, sort_key: str, model_rev: int
    ) -> "tuple[RowKey, ...] | None":
        key = (fingerprint, sort_key)
        with self._lock:
            hit = self._d.get(key)
            if hit is None:
                return None
            rev, rows = hit
            if rev != model_rev:
                del self._d[key]
                return None
            self._d.move_to_end(key)
            return rows

    def put(
        self,
        fingerprint: str,
        sort_key: str,
        model_rev: int,
        rows: "tuple[RowKey, ...]",
    ) -> None:
        key = (fingerprint, sort_key)
        with self._lock:
            self._d[key] = (model_rev, rows)
            self._d.move_to_end(key)
            while len(self._d) > self._cap:
                self._d.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._d.clear()
```

In `session.py`, add the field to `Session`:

```python
    table_order_cache: "TableOrderCache" = field(
        default_factory=lambda: TableOrderCache(), repr=False
    )
```

Import `TableOrderCache` at module top. In both `set_model` and `touch_model`, add
`self.table_order_cache.clear()`.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_table_cache.py -v`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-backend
git add src/data_rover/api/table_cache.py src/data_rover/api/session.py tests/api/test_table_cache.py
git commit -m "feat(api): per-session row-order LRU cache with rev invalidation"
```

---

### Task 8: `POST /tables/evaluate` route + schemas

**Files:**
- Modify: `src/data_rover/api/schemas.py` (add table I/O schemas)
- Create: `src/data_rover/api/routes/tables.py`
- Modify: `src/data_rover/api/main.py` (mount the router under the project prefix)
- Modify: `src/data_rover/api/authz.py:45-53` (add `/tables/evaluate`, `/tables/export`)
- Modify: `src/data_rover/api/routes/artifacts.py:46` (`_PAYLOAD_ADAPTERS` += table)
- Test: `tests/api/test_tables_routes.py`

**Interfaces:**
- Consumes: `build_rows`, `order_rows`, `evaluate_cells`, `SortSpec`,
  `SortTooLargeError`, `TableLimits` (core); `resolve_refs`/`NAVIGATION_ADAPTER`;
  `TableOrderCache`/`table_fingerprint`; `_tree_item`.
- Produces: `POST /projects/{project_id}/tables/evaluate` returning a
  `TablePageOut`.

- [ ] **Step 1: Write the failing route tests**

In `tests/api/test_tables_routes.py` (reuse `_bootstrap_model` from
`test_artifacts_routes.py` — import it or copy the helper):

```python
from tests.api.test_artifacts_routes import _bootstrap_model  # if importable
from tests.api.conftest import papi, AUTH_HEADERS


def test_create_table_artifact_and_evaluate(client):
    _bootstrap_model(client)
    payload = {"kind": "table", "name": "blocks",
               "payload": {"row_source": {"kind": "scope", "types": ["Block"]},
                           "columns": [{"kind": "element", "source": {"kind": "row"}},
                                       {"kind": "property", "source": {"kind": "row"},
                                        "name": "mass"}]}}
    r = client.post(papi("/artifacts"), json=payload, headers=AUTH_HEADERS)
    assert r.status_code == 201
    art_id = r.json()["id"]
    r = client.post(papi("/tables/evaluate"),
                    json={"artifact_id": art_id, "offset": 0, "limit": 50},
                    headers=AUTH_HEADERS)
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1
    assert body["rows"][0]["cells"][0]["kind"] == "element"
    assert "model_rev" in body


def test_evaluate_inline_with_sort(client):
    _bootstrap_model(client)
    r = client.post(papi("/tables/evaluate"), json={
        "definition": {"row_source": {"kind": "scope", "types": ["Block"]},
                       "columns": [{"kind": "element", "source": {"kind": "row"}},
                                   {"kind": "property", "source": {"kind": "row"},
                                    "name": "mass"}]},
        "sort": {"column": 1, "direction": "asc"},
    }, headers=AUTH_HEADERS)
    assert r.status_code == 200


def test_bad_expand_on_scalar_property_422(client):
    _bootstrap_model(client)
    r = client.post(papi("/tables/evaluate"), json={
        "definition": {"row_source": {"kind": "scope", "types": ["Block"]},
                       "columns": [{"kind": "property", "source": {"kind": "row"},
                                    "name": "mass", "mode": "expand"}]},
    }, headers=AUTH_HEADERS)
    assert r.status_code == 422


def test_cache_hit_second_page(client):
    _bootstrap_model(client)
    body = {"definition": {"row_source": {"kind": "scope", "types": ["Block"]},
                           "columns": [{"kind": "element", "source": {"kind": "row"}}]},
            "sort": {"column": 0, "direction": "asc"}}
    r1 = client.post(papi("/tables/evaluate"), json={**body, "offset": 0, "limit": 1},
                     headers=AUTH_HEADERS)
    r2 = client.post(papi("/tables/evaluate"), json={**body, "offset": 1, "limit": 1},
                     headers=AUTH_HEADERS)
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["total"] == r2.json()["total"]


def test_viewer_can_evaluate_not_create(client, viewer_headers):
    # viewer_headers: a membership with role=viewer on the default project.
    _bootstrap_model(client)
    r = client.post(papi("/tables/evaluate"), json={
        "definition": {"row_source": {"kind": "scope", "types": ["Block"]},
                       "columns": [{"kind": "element", "source": {"kind": "row"}}]},
    }, headers=viewer_headers)
    assert r.status_code == 200
```

If no `viewer_headers` fixture exists, mirror the viewer setup used in
`test_artifacts_routes.py::test_viewer_*`; reuse that exact pattern.

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_tables_routes.py -v`
Expected: FAIL (route not mounted; kind `table` unsupported → 422 on create).

- [ ] **Step 3: Add schemas**

In `schemas.py`, add (near the artifact/eval schemas):

```python
class EvaluateTableIn(BaseModel):
    definition: TableDefinition | None = None
    artifact_id: str | None = None
    offset: int = Field(0, ge=0)
    limit: int = Field(100, ge=1, le=500)
    sort: "TableSortIn | None" = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "EvaluateTableIn":
        if (self.definition is None) == (self.artifact_id is None):
            raise ValueError("provide exactly one of `definition` / `artifact_id`")
        return self


class TableSortIn(BaseModel):
    column: int = Field(ge=0)
    direction: Literal["asc", "desc"] = "asc"


class TableColumnOut(BaseModel):
    kind: str
    header: str
    width_px: int | None = None


class TableCellOut(BaseModel):
    kind: Literal["element", "value", "values", "elements"]
    # element
    item: TreeItem | None = None
    # value
    present: bool | None = None
    value: object | None = None
    element_id: str | None = None
    editable: bool | None = None
    # values / elements
    items: list[TreeItem] | None = None
    values: list[object] | None = None
    total: int | None = None
    truncated: bool | None = None


class TableRowOut(BaseModel):
    key: list[object]
    cells: list[TableCellOut]


class TablePageOut(BaseModel):
    columns: list[TableColumnOut]
    rows: list[TableRowOut]
    total: int
    truncated: bool
    offset: int
    model_rev: int
```

Import `TableDefinition` and `Literal` at the top of `schemas.py` if not already.

- [ ] **Step 4: Write the route**

Create `src/data_rover/api/routes/tables.py`:

```python
"""Table evaluation (read-only; viewer-callable). Resolves navigation refs, then
builds/sorts/pages rows through the pure core evaluator, caching the ordered row
list per session. No write_mutex — same benign-race stance as routes/read.py."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DbSession

from data_rover.core.navigation.resolve import NavigationResolveError, resolve_refs
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER, NavigationDefinition
from data_rover.core.table.cells import (
    ElementCell,
    ElementsCell,
    ValueCell,
    ValuesCell,
    evaluate_cells,
)
from data_rover.core.table.evaluate import (
    SortSpec,
    SortTooLargeError,
    TableLimits,
    build_rows,
    order_rows,
)
from data_rover.core.table.schema import TABLE_ADAPTER, TableDefinition

from .. import content
from ..db import get_db
from ..db_models import ArtifactKind
from ..deps import Session, get_request_session, require_model
from ..schemas import (
    EvaluateTableIn,
    TableCellOut,
    TableColumnOut,
    TablePageOut,
    TableRowOut,
)
from ..table_cache import table_fingerprint
from .read import _tree_item

router = APIRouter()


def _resolve_table(payload, project_id, db) -> TableDefinition:
    if payload.artifact_id is not None:
        row = content.get_artifact(db, payload.artifact_id)
        if row is None or row.project_id != project_id or row.kind is not ArtifactKind.table:
            raise LookupError(payload.artifact_id)
        defn = TABLE_ADAPTER.validate_python(row.payload)
    else:
        assert payload.definition is not None
        defn = payload.definition

    def _fetch(aid: str) -> NavigationDefinition:
        r = content.get_artifact(db, aid)
        if r is None or r.project_id != project_id or r.kind is not ArtifactKind.navigation:
            raise LookupError(aid)
        return NAVIGATION_ADAPTER.validate_python(r.payload)

    # resolve navigation refs inside every NavigationSource in the table
    return _resolve_table_navigation_refs(defn, _fetch)


def _cell_out(model, cell) -> TableCellOut:
    if isinstance(cell, ElementCell):
        return TableCellOut(
            kind="element",
            item=_tree_item(model, cell.element_id) if cell.element_id else None,
        )
    if isinstance(cell, ValueCell):
        return TableCellOut(kind="value", present=cell.present, value=cell.value,
                            element_id=cell.element_id, editable=cell.editable)
    if isinstance(cell, ValuesCell):
        return TableCellOut(kind="values", present=cell.present, values=cell.values,
                            total=cell.total, truncated=cell.truncated)
    assert isinstance(cell, ElementsCell)
    return TableCellOut(kind="elements",
                        items=[_tree_item(model, e) for e in cell.element_ids],
                        total=cell.total, truncated=cell.truncated)


@router.post("/tables/evaluate")
def evaluate_table(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> TablePageOut:
    metamodel, model = require_model(session)
    try:
        defn = _resolve_table(payload, project_id, db)
        sort = (
            SortSpec(column=payload.sort.column, direction=payload.sort.direction)
            if payload.sort is not None
            else None
        )
        limits = TableLimits()
        fp = table_fingerprint(
            TABLE_ADAPTER.dump_json(defn).decode(), sort
        )
        sort_key = "none" if sort is None else f"{sort.column}:{sort.direction}"
        cached = session.table_order_cache.get(fp, sort_key, session.model_rev)
        if cached is not None:
            ordered = list(cached)
            truncated = False
        else:
            keys, truncated = build_rows(metamodel, model, defn, limits)
            ordered = order_rows(metamodel, model, defn, keys, sort, limits)
            session.table_order_cache.put(
                fp, sort_key, session.model_rev, tuple(ordered)
            )
        window = ordered[payload.offset : payload.offset + payload.limit]
        cells = evaluate_cells(metamodel, model, defn, window, limits)
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=f"unknown artifact {exc}") from exc
    except (NavigationResolveError, SortTooLargeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    columns = [
        TableColumnOut(kind=c.kind, header=c.header, width_px=c.width_px)
        for c in defn.columns
    ]
    rows = [
        TableRowOut(key=list(k), cells=[_cell_out(model, cell) for cell in row])
        for k, row in zip(window, cells)
    ]
    return TablePageOut(
        columns=columns, rows=rows, total=len(ordered),
        truncated=truncated, offset=payload.offset, model_rev=session.model_rev,
    )
```

Add the ref-resolution helper `_resolve_table_navigation_refs(defn, fetch)` in
`core/table/resolve.py` (new small module): it deep-copies the `TableDefinition`
and replaces every `NavigationSource` (`row_source` + each column) that has a
`ref` with `{definition: resolve_refs(fetched, fetch)}`. Write a focused unit test
`tests/table/test_resolve.py` mirroring `tests/navigation/test_resolve.py`
(unknown ref → `LookupError`; a ref replaced by its inlined definition). This keeps
the table evaluator ref-free as assumed in Task 4.

Mount in `main.py` alongside the other project-prefixed routers:

```python
    app.include_router(tables.router, prefix=_PROJECT_PREFIX, tags=["tables"])
```

(Find the existing `artifacts.router` include and copy its prefix/dependencies
exactly.)

In `authz.py`, extend `_READ_ONLY_POST_SUFFIXES`:

```python
    "/tables/evaluate",
    "/tables/export",
```

In `artifacts.py`, add the adapter:

```python
from data_rover.core.table.schema import TABLE_ADAPTER
...
_PAYLOAD_ADAPTERS = {
    ArtifactKind.navigation: NAVIGATION_ADAPTER,
    ArtifactKind.table: TABLE_ADAPTER,
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_tables_routes.py tests/table/test_resolve.py -v`
Expected: PASS.

- [ ] **Step 6: Regression + lint + commit**

```bash
pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -q
pixi run lint-backend
git add src/data_rover/api tests/api/test_tables_routes.py src/data_rover/core/table/resolve.py tests/table/test_resolve.py
git commit -m "feat(api): POST /tables/evaluate with row-order cache and table artifact kind"
```

---

### Task 9: Cache invalidation on referenced-navigation edit

**Files:**
- Test: `tests/api/test_tables_routes.py`

The design says editing a referenced library navigation must invalidate a table's
cached order **without** a `model_rev` bump — achieved by fingerprinting the
**resolved** definition. Verify it end to end.

**Interfaces:**
- Consumes: the Task 8 route; `PUT /artifacts/{id}`.

- [ ] **Step 1: Write the failing/So-verify test**

```python
def test_table_reflects_referenced_navigation_edit(client):
    names = _bootstrap_model(client)
    # save a navigation the table will reference
    nav = {"kind": "navigation", "name": "parts",
           "payload": {"kind": "path", "start": {"kind": "row"},
                       "steps": [{"kind": "relationship",
                                  "relationship_type": "BlockHasPart", "direction": "out"}]}}
    nr = client.post(papi("/artifacts"), json=nav, headers=AUTH_HEADERS)
    nav_id, nav_rev = nr.json()["id"], nr.json()["artifact_rev"]
    table = {"row_source": {"kind": "scope", "types": ["Block"]},
             "columns": [{"kind": "element", "source": {"kind": "row"}},
                         {"kind": "navigation", "source": {"kind": "row"},
                          "navigation": {"ref": nav_id}}]}
    r1 = client.post(papi("/tables/evaluate"),
                     json={"definition": table, "sort": {"column": 1, "direction": "count"}}
                     if False else {"definition": table},
                     headers=AUTH_HEADERS)
    assert r1.status_code == 200
    # now edit the navigation to follow NO relationship (empty steps) → cells empty
    client.put(papi(f"/artifacts/{nav_id}"),
               json={"artifact_rev": nav_rev,
                     "payload": {"kind": "path", "start": {"kind": "row"}, "steps": []}},
               headers=AUTH_HEADERS)
    r2 = client.post(papi("/tables/evaluate"), json={"definition": table},
                     headers=AUTH_HEADERS)
    # the navigation column now returns only the start element (chain length 1)
    root_row = next(row for row in r2.json()["rows"]
                    if row["cells"][0]["item"]["id"] == names["root"])
    nav_cell = root_row["cells"][1]
    assert nav_cell["kind"] == "elements"
    assert nav_cell["total"] == 1  # only the row element itself, no parts
```

(The empty-steps navigation yields a length-1 chain = the row element; its
terminal set is just the row element. Adjust the exact assertion to the fixture.)

- [ ] **Step 2: Run**

Run: `pixi run -e core-dev pytest tests/api/test_tables_routes.py -k referenced_navigation -v`
Expected: PASS if fingerprinting uses the resolved definition (Task 8 already
does). If it fails, the route is fingerprinting the *unresolved* body — fix by
computing `fp` from the resolved `defn`, which Task 8 already specifies.

- [ ] **Step 3: Commit**

```bash
git add tests/api/test_tables_routes.py
git commit -m "test(api): table order cache reflects referenced-navigation edits"
```

---

### Task 10: `POST /tables/export` — Excel

**Files:**
- Modify: `pixi.toml` (`openpyxl` dep in `[feature.api.dependencies]`)
- Create: `src/data_rover/api/table_export.py`
- Modify: `src/data_rover/api/routes/tables.py` (add the export route)
- Modify: `src/data_rover/core/table/evaluate.py` (add `iter_export_rows`)
- Test: `tests/api/test_table_export.py`, `tests/table/test_build_rows.py` (iterator)

**Interfaces:**
- Consumes: `build_rows`, `order_rows`, `evaluate_cells` (core); the table route
  helpers.
- Produces:
  - `def iter_export_rows(mm, model, defn, keys, limits, chunk=1000) -> Iterator[list[Cell]]`.
  - `def build_workbook(defn, columns, name, row_iter) -> bytes` (`api/table_export.py`).
  - `POST /projects/{project_id}/tables/export` returning an `.xlsx` Response.

- [ ] **Step 1: Add the dependency**

In `pixi.toml`, under `[feature.api.dependencies]`, add:

```toml
openpyxl = "3.1.*"
```

Run: `pixi install` (or let the next `pixi run` resolve it). Verify:
`pixi run -e core-dev python -c "import openpyxl; print(openpyxl.__version__)"`.

- [ ] **Step 2: Write the failing export test**

In `tests/api/test_table_export.py`:

```python
import io
from openpyxl import load_workbook
from tests.api.conftest import papi, AUTH_HEADERS
from tests.api.test_artifacts_routes import _bootstrap_model


def test_export_xlsx_has_header_and_rows(client):
    _bootstrap_model(client)
    body = {"definition": {"row_source": {"kind": "scope", "types": ["Block"]},
                           "columns": [{"kind": "element", "source": {"kind": "row"},
                                        "header": "Block"},
                                       {"kind": "property", "source": {"kind": "row"},
                                        "name": "mass", "header": "Mass"}]}}
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert [c.value for c in ws[1]] == ["Block", "Mass"]  # header row
    assert ws.max_row >= 2


def test_export_truncation_header(client):
    _bootstrap_model(client)
    # not asserting the exact flag here unless the fixture exceeds max_rows;
    # assert the header key is absent for a small table
    body = {"definition": {"row_source": {"kind": "scope", "types": ["Block"]},
                           "columns": [{"kind": "element", "source": {"kind": "row"}}]}}
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert "x-table-truncated" not in {k.lower() for k in r.headers}
```

- [ ] **Step 3: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py -v`
Expected: FAIL (route missing).

- [ ] **Step 4: Add `iter_export_rows` to core**

In `core/table/evaluate.py`:

```python
from collections.abc import Iterator


def iter_export_rows(
    mm, model, defn, keys, limits: TableLimits = TableLimits(), chunk: int = 1000
):
    """Yield evaluated cell rows in `keys` order, chunked to bound peak memory."""
    from .cells import evaluate_cells

    for i in range(0, len(keys), chunk):
        yield from evaluate_cells(mm, model, defn, keys[i : i + chunk], limits)
```

- [ ] **Step 5: Write the workbook writer**

Create `src/data_rover/api/table_export.py`:

```python
"""xlsx writer for table export. Lives in the API layer (core stays xlsx-free).
Consumes core cell dataclasses and produces workbook bytes."""

from __future__ import annotations

import io
from collections.abc import Iterable

from openpyxl import Workbook
from openpyxl.styles import Font

from data_rover.core.model.model import Model
from data_rover.core.table.cells import (
    Cell,
    ElementCell,
    ElementsCell,
    ValueCell,
    ValuesCell,
)


def _display(model: Model, eid: str) -> str:
    el = model.elements[eid]
    n = el.properties.get("name")
    return str(n) if n is not None else el.id


def _cell_text(model: Model, cell: Cell) -> object:
    if isinstance(cell, ElementCell):
        return _display(model, cell.element_id) if cell.element_id else ""
    if isinstance(cell, ValueCell):
        return "" if not cell.present or cell.value is None else cell.value
    if isinstance(cell, ValuesCell):
        return "; ".join(str(v) for v in cell.values)
    assert isinstance(cell, ElementsCell)
    return "; ".join(_display(model, e) for e in cell.element_ids)


def build_workbook(
    model: Model,
    headers: list[str],
    widths: list[int | None],
    sheet_name: str,
    row_iter: Iterable[list[Cell]],
) -> bytes:
    wb = Workbook(write_only=True)
    ws = wb.create_sheet(title=(sheet_name or "Table")[:31])
    from openpyxl.cell import WriteOnlyCell

    header_cells = []
    for h in headers:
        c = WriteOnlyCell(ws, value=h)
        c.font = Font(bold=True)
        header_cells.append(c)
    ws.append(header_cells)
    ws.freeze_panes = "A2"
    for i, w in enumerate(widths):
        if w:
            ws.column_dimensions[chr(ord("A") + i)].width = max(4, w / 7)
    for row in row_iter:
        ws.append([_cell_text(model, c) for c in row])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
```

Note: `ElementsCell` in export must NOT be capped at `cell_cap`. Because the route
runs export with the same `evaluate_cells`, and `cell_cap` truncates, the export
path must evaluate cells with an **uncapped** limit. Add a `TableLimits` variant
for export: `limits = TableLimits(max_cell_elements=10**9)` when calling
`iter_export_rows`, and set each column's effective cap to its own `cell_cap` only
in the interactive route — OR simpler: have `iter_export_rows` accept an
`uncapped: bool` and, when true, evaluate elements cells without truncation. Choose
the `max_cell_elements` override (least code) and additionally pass a per-call flag
so a column's own `cell_cap` is ignored for export. Document this in the route.

- [ ] **Step 6: Add the export route**

In `routes/tables.py`:

```python
from fastapi import Response

from ..table_export import build_workbook
from data_rover.core.table.evaluate import iter_export_rows


@router.post("/tables/export")
def export_table(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> Response:
    metamodel, model = require_model(session)
    try:
        defn = _resolve_table(payload, project_id, db)
        sort = (
            SortSpec(column=payload.sort.column, direction=payload.sort.direction)
            if payload.sort is not None else None
        )
        limits = TableLimits(max_cell_elements=10**9)  # export never caps cells
        keys, truncated = build_rows(metamodel, model, defn, limits)
        ordered = order_rows(metamodel, model, defn, keys, sort, limits)
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=f"unknown artifact {exc}") from exc
    except (NavigationResolveError, SortTooLargeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    name = payload.artifact_id or "table"
    if payload.artifact_id is not None:
        row = content.get_artifact(db, payload.artifact_id)
        if row is not None:
            name = row.name
    headers = [c.header or c.kind for c in defn.columns]
    widths = [c.width_px for c in defn.columns]
    blob = build_workbook(
        model, headers, widths, name,
        iter_export_rows(metamodel, model, defn, ordered, limits),
    )
    resp_headers = {
        "Content-Disposition": f'attachment; filename="{name}.xlsx"',
    }
    if truncated:
        resp_headers["X-Table-Truncated"] = "true"
    return Response(
        content=blob,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=resp_headers,
    )
```

- [ ] **Step 7: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py -v`
Expected: PASS.

- [ ] **Step 8: Lint + commit**

```bash
pixi run lint-backend
git add pixi.toml src/data_rover/api/table_export.py src/data_rover/api/routes/tables.py src/data_rover/core/table/evaluate.py tests/api/test_table_export.py
git commit -m "feat(api): POST /tables/export streaming an .xlsx via openpyxl"
```

---

### Task 11: Root-level artifact placement in the view schema

**Files:**
- Modify: `src/data_rover/core/view/schema.py`
- Modify: `src/data_rover/core/view/validate.py` (if it walks folders for artifact refs — add root)
- Test: `tests/view/test_view_schema.py` (or the existing view test module)

**Interfaces:**
- Consumes: existing `ArtifactRef`, `Folder`, `View`.
- Produces: `View.artifacts: list[ArtifactRef]` (root-level).

- [ ] **Step 1: Write the failing test**

In the view tests (find the existing module, e.g. `tests/view/test_view.py`):

```python
def test_view_carries_root_artifacts():
    from data_rover.core.view.schema import View, ArtifactRef
    v = View.model_validate({
        "name": "v",
        "folders": [],
        "artifacts": [{"id": "tbl1", "kind": "table"}],
    })
    assert v.artifacts == [ArtifactRef(id="tbl1", kind="table")]


def test_old_view_without_artifacts_still_valid():
    from data_rover.core.view.schema import View
    v = View.model_validate({"name": "v", "folders": []})
    assert v.artifacts == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/view -k root_artifacts -v`
Expected: FAIL (extra field / attribute missing).

- [ ] **Step 3: Add the field**

In `view/schema.py`, add to `View`:

```python
    artifacts: list[ArtifactRef] = Field(default_factory=list)
```

If `validate.py` enumerates artifact refs (for dangling-ref warnings), include
`view.artifacts` in that walk exactly as it includes each `folder.artifacts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/view -v`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-core
git add src/data_rover/core/view tests/view
git commit -m "feat(view): allow root-level artifact references"
```

---

### Task 12: Backend integration sweep

**Files:**
- No new code; a full-suite gate.

- [ ] **Step 1: Full backend + core suite**

Run: `pixi run -e core-dev pytest tests/ -q`
Expected: all green (no regressions in navigation, artifacts, commits, locks, view).

- [ ] **Step 2: Full lint**

Run: `pixi run lint-core && pixi run lint-backend`
Expected: ruff + mypy + pyright clean across core and api.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore(table): backend integration fixups"
```

## Self-Review notes (for the executor)

- There is exactly ONE slot-arithmetic implementation: `_expand_slot_of(defn,
  base_slots, col_index)` in `evaluate.py`, shared by `build_rows`,
  `evaluate_cells`, and `order_rows`. `base_slots` is passed explicitly (1 for
  scope/nav, chain length for chains) — never re-derived from a key length inside
  `build_rows`, because mid-build keys are partial. `evaluate_cells`/`order_rows`
  may derive it from `len(keys[0]) - expand_count` since they hold full keys.
  Delete the Task 5 `_expand_slot_index`/`_base_slot_count`/`raise
  NotImplementedError` stubs entirely.
- The critical regression test is
  `test_column_sourced_from_expand_column_binds_that_rows_element` — without the
  explicit `base_slots` thread, a column sourced from an expand column silently
  binds the parent's whole set instead of the row's single element.
- Element ids in cells are projected to `TreeItem` **only** at the route
  (`_cell_out`), never in core.
- `cell_cap` truncates display in `/tables/evaluate`; `/tables/export` overrides
  `max_cell_elements` so exported element cells are complete.
