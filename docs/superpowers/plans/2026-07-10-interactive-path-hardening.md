# Interactive-Path Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tree navigation instant at 500k elements (O(page) containment-roots reads), move full-model validation off the load path with visible progress, add a determinate progress overlay (upload / open / validation), and eliminate the flash of un-collapsed tree when a project has a view.

**Architecture:** A `SortedList`-backed containment-roots order index maintained at the `Model` mutation boundary (inside `IndexSet`); a chunked background validation sweep that interleaves with edits under the session `write_mutex`; a non-hydrating `GET /model/status` endpoint the frontend polls; an XHR upload path (fetch cannot report upload progress); a `viewResolved` gate + `boot()` reorder for the view flash.

**Tech Stack:** Python 3.14 (pyright floor 3.10), FastAPI, sortedcontainers, SvelteKit/Svelte 5, vitest + MSW, pixi.

**Spec:** `docs/superpowers/specs/2026-07-10-interactive-path-hardening-design.md` (including its "Design deltas" section).

## Global Constraints

- All commands run through pixi: `pixi run -e core-dev pytest …`; frontend npm MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'`.
- Python floor is 3.10 for pyright even though runtime is 3.14 — no stdlib newer than 3.10 (`typing_extensions` for `Self`/`assert_never`).
- Lint = ruff + mypy + pyright, ALL must pass: `pixi run lint-core`, `pixi run lint-backend`.
- The existing HTTP API contracts are unchanged: same paths, same shapes, same orderings (containment roots stay display-name-then-id ascending; `/model/elements` stays insertion order). One NEW endpoint is added (`GET /model/status`).
- Preserve the dense docstring style explaining invariants; extend docstrings where invariants change (they are load-bearing per CLAUDE.md).
- Property values are replaced wholesale, never mutated in place (op-log inverse aliasing).
- `IndexSet` structures must stay SPARSE and must compare equal to a fresh `rebuild()` (that is what `verify_consistent` asserts).
- Commit messages: conventional style (`feat(...)`, `fix(...)`, `test(...)`), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `docs/superpowers/{plans,specs}` are gitignored — never `git add` them.

---

### Task 1: Perf probe (baseline)

An opt-in, `perf`-marked pytest that builds a synthetic model over HTTP and prints endpoint timings. Run it ONCE now to record "before" numbers; Task 11 re-runs it for "after".

**Files:**
- Modify: `pytest.ini` (register `perf` marker, exclude by default)
- Create: `tests/api/test_perf_probe.py`

**Interfaces:**
- Consumes: `tests/api/conftest.py` helpers `AUTH_HEADERS`, `seed_default_project` (already exist).
- Produces: nothing other tasks import; a manual runbook: `pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s`.

- [ ] **Step 1: Register the marker**

In `pytest.ini`, change the markers/addopts lines to:

```ini
markers =
    integration: opt-in tests needing an external service (e.g. fake-gcs-server); deselect with -m "not integration"
    perf: opt-in perf probes that build large synthetic models; run explicitly with -m perf -s
addopts = -m "not integration and not perf"
```

- [ ] **Step 2: Write the probe**

Create `tests/api/test_perf_probe.py`:

```python
"""Opt-in perf probe for the interactive read path (spec §1).

Run:  pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s
Env:  PERF_N (default 50000) controls the synthetic element count.

Half the elements are containment roots, each containing one child, so the
roots endpoints see a large root set (the audited hot spot). Numbers are
printed, not asserted — this is a measurement harness, not a regression gate.
"""

from __future__ import annotations

import os
import time

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, seed_default_project

pytestmark = pytest.mark.perf

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


def _timed_get(client: TestClient, label: str, path: str, params: dict | None = None) -> None:
    t0 = time.perf_counter()
    res = client.get(path, params=params or {})
    dt_ms = (time.perf_counter() - t0) * 1000
    assert res.status_code == 200, res.text
    print(f"{label:<44} {dt_ms:8.1f} ms")


def test_perf_probe() -> None:
    n = int(os.environ.get("PERF_N", "50000"))
    half = n // 2
    seed_default_project()
    client = TestClient(create_app())
    client.headers.update(AUTH_HEADERS)
    res = client.post(
        f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text

    elements = [
        {"id": f"e{i}", "type_name": "Item", "properties": {"name": f"Element {i:07d}"}}
        for i in range(n)
    ]
    relationships = [
        {
            "id": f"r{i}",
            "type_name": "Contains",
            "source_id": f"e{i}",
            "target_id": f"e{half + i}",
            "properties": {},
        }
        for i in range(half)
    ]
    t0 = time.perf_counter()
    res = client.post(
        f"{API}/model/upload",
        json={"elements": elements, "relationships": relationships},
    )
    assert res.status_code == 200, res.text
    print(f"\nupload+install ({n} elements)              {(time.perf_counter() - t0) * 1000:8.1f} ms")

    _timed_get(client, "containment roots, first page", f"{API}/model/containment/roots", {"limit": 100})
    _timed_get(client, "containment roots, deep page", f"{API}/model/containment/roots", {"limit": 100, "offset": max(half - 200, 0)})
    _timed_get(client, "excluded roots, first page", f"{API}/model/containment/roots/excluded", {"limit": 100})
    _timed_get(client, "children of e0", f"{API}/model/elements/e0/children", {"limit": 100})
    _timed_get(client, "elements, deep page (insertion order)", f"{API}/model/elements", {"limit": 100, "offset": max(n - 200, 0)})
    _timed_get(client, "summary", f"{API}/model/summary")
```

- [ ] **Step 3: Run it and record the BEFORE numbers**

Run: `pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s`
Expected: PASS, with a printed timing table. Copy the table into the task-completion notes (it is the baseline Task 11 compares against). Roots pages are expected in the 100+ ms range at 50k.

- [ ] **Step 4: Verify the default suite still deselects it**

Run: `pixi run -e core-dev pytest tests/api/test_perf_probe.py`
Expected: `1 deselected`.

- [ ] **Step 5: Commit**

```bash
git add pytest.ini tests/api/test_perf_probe.py
git commit -m "test(perf): opt-in probe for interactive read-path endpoints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Move display-name derivation into core

The roots order index (Task 3) sorts by display name, which today lives as `_display_name` in `src/data_rover/api/routes/read.py:447-460`. Move it to core so `IndexSet` can use it; the API keeps importing it (behaviour identical).

**Files:**
- Create: `src/data_rover/core/model/naming.py`
- Modify: `src/data_rover/api/routes/read.py` (delete `_display_name`, import instead)
- Test: `tests/model/test_naming.py`

**Interfaces:**
- Produces: `data_rover.core.model.naming.display_name(element: Element) -> str` — Task 3 (`IndexSet`) and `read.py` both call this.

- [ ] **Step 1: Write the failing test**

Create `tests/model/test_naming.py`:

```python
from data_rover.core.model.element import Element
from data_rover.core.model.naming import display_name


def _el(eid: str, props: dict) -> Element:
    return Element(id=eid, type_name="Item", properties=props)


def test_exact_name_wins() -> None:
    assert display_name(_el("e1", {"name": "Alpha", "Name": "Beta"})) == "Alpha"


def test_case_insensitive_fallback() -> None:
    assert display_name(_el("e1", {"NAME": "Gamma"})) == "Gamma"


def test_empty_and_non_string_fall_back_to_id() -> None:
    assert display_name(_el("e1", {"name": ""})) == "e1"
    assert display_name(_el("e2", {"name": 7})) == "e2"
    assert display_name(_el("e3", {})) == "e3"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/model/test_naming.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'data_rover.core.model.naming'`.

- [ ] **Step 3: Create the core module**

Create `src/data_rover/core/model/naming.py` — the body is `_display_name` from `read.py` verbatim:

```python
"""Display-name derivation shared by the API read routes and the IndexSet.

Kept in lock-step with the frontend's ``elementDisplayName``
(``frontend/src/lib/util/element-name.ts``) so a row's label is identical
whether it comes from the lite (server) or full (client) source. The roots
order index sorts by this value, so moving/changing it changes server-side
tree ordering — treat the semantics as frozen.
"""

from __future__ import annotations

from .element import Element


def display_name(element: Element) -> str:
    """The case-insensitive non-empty ``name`` property, else the id.

    An exact lowercase ``name`` wins over other casings (``Name``/``NAME``).
    """
    props = element.properties
    exact = props.get("name")
    if isinstance(exact, str) and exact:
        return exact
    for key, value in props.items():
        if key != "name" and key.lower() == "name" and isinstance(value, str) and value:
            return value
    return element.id
```

- [ ] **Step 4: Point read.py at it**

In `src/data_rover/api/routes/read.py`: delete the whole `_display_name` function (lines 447-460) and add to the imports near the top (next to the other `data_rover.core.model` imports):

```python
from data_rover.core.model.naming import display_name as _display_name
```

All existing `_display_name(...)` call sites keep working unchanged.

- [ ] **Step 5: Run tests**

Run: `pixi run -e core-dev pytest tests/model/test_naming.py tests/api/test_read_routes.py -v`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/model/naming.py src/data_rover/api/routes/read.py tests/model/test_naming.py
git commit -m "refactor(core): move display-name derivation into core.model.naming

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Containment-roots order index in IndexSet

An incrementally-maintained sorted collection of `(display_name, id)` pairs for elements with no containment parent. This turns the O(model·log n)-per-request roots endpoints into O(page + log n) slices (Task 4).

**Files:**
- Modify: `pixi.toml` (add `sortedcontainers` to `[feature.core.dependencies]`)
- Create: `src/data_rover/core/model/_sorted.py`
- Modify: `src/data_rover/core/model/indexes.py`
- Test: `tests/model/test_roots_order.py`

**Interfaces:**
- Consumes: `display_name` from Task 2.
- Produces (on `IndexSet`, used by Task 4):
  - `roots_count() -> int`
  - `roots_page(offset: int, limit: int) -> list[str]` — root element ids in `(display_name, id)` ascending order
  - `iter_roots() -> Iterator[str]` — all root ids in the same order
  - internal fields `roots_order: SortedPairs`, `_root_key_of: dict[str, tuple[str, str]]`

- [ ] **Step 1: Add the dependency**

In `pixi.toml` under `[feature.core.dependencies]` add:

```toml
sortedcontainers = "2.4.*"
```

Run: `pixi run -e core-dev python -c "import sortedcontainers; print(sortedcontainers.__version__)"`
Expected: `2.4.0` (pixi re-solves the env automatically).

- [ ] **Step 2: Write the typed facade**

Create `src/data_rover/core/model/_sorted.py` (sortedcontainers ships no py.typed, so the type-ignore is quarantined here):

```python
"""Typed facade over ``sortedcontainers.SortedList`` for (str, str) pairs.

sortedcontainers ships no type information, so this module owns the single
``type: ignore`` and exposes the narrow, fully-typed surface the IndexSet
order indexes need: O(sqrt n)-amortized add/remove, O(log n + k) paging.
"""

from __future__ import annotations

from typing import Any, Iterable, Iterator

from sortedcontainers import SortedList  # type: ignore[import-untyped]

Pair = tuple[str, str]


class SortedPairs:
    """A sorted multiset of (sort_key, id) pairs."""

    def __init__(self, items: Iterable[Pair] = ()) -> None:
        self._sl: Any = SortedList(items)

    def add(self, pair: Pair) -> None:
        self._sl.add(pair)

    def remove(self, pair: Pair) -> None:
        """Remove one occurrence; raises ValueError if absent (a desync bug)."""
        self._sl.remove(pair)

    def clear(self) -> None:
        self._sl.clear()

    def __len__(self) -> int:
        return len(self._sl)

    def page(self, offset: int, limit: int) -> list[Pair]:
        return list(self._sl.islice(offset, offset + limit))

    def iter_all(self) -> Iterator[Pair]:
        return iter(self._sl)

    def as_list(self) -> list[Pair]:
        return list(self._sl)
```

- [ ] **Step 3: Write the failing tests**

Create `tests/model/test_roots_order.py`:

```python
"""Order-index maintenance: the roots order must track every mutation path
and always equal what a fresh rebuild() computes (verify_consistent)."""

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

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
  - name: Links
    containment: false
    source: Item
    target: Item
"""


def _model() -> Model:
    return Model(load_metamodel_str(MM))


def _named(model: Model, name: str):
    el = model.create_element("Item")
    model.set_property(el, "name", name)
    return el


def test_create_orders_by_display_name_then_id() -> None:
    m = _model()
    beta = _named(m, "Beta")
    alpha = _named(m, "Alpha")
    unnamed = m.create_element("Item")  # display name falls back to id
    assert m.indexes.roots_page(0, 10)[:2] == [alpha.id, beta.id]
    assert m.indexes.roots_count() == 3
    assert unnamed.id in list(m.indexes.iter_roots())
    m.indexes.verify_consistent()


def test_containment_edge_removes_and_restores_root() -> None:
    m = _model()
    parent = _named(m, "P")
    child = _named(m, "C")
    rel = m.connect("Contains", parent.id, child.id)
    assert m.indexes.roots_page(0, 10) == [parent.id]
    m.indexes.verify_consistent()
    m.disconnect(rel.id)
    assert set(m.indexes.roots_page(0, 10)) == {parent.id, child.id}
    m.indexes.verify_consistent()


def test_second_parent_does_not_double_remove() -> None:
    m = _model()
    p1, p2, child = _named(m, "P1"), _named(m, "P2"), _named(m, "C")
    r1 = m.connect("Contains", p1.id, child.id)
    m.connect("Contains", p2.id, child.id)  # second parent: child already non-root
    assert set(m.indexes.roots_page(0, 10)) == {p1.id, p2.id}
    m.disconnect(r1.id)  # still has p2 as parent -> still not a root
    assert set(m.indexes.roots_page(0, 10)) == {p1.id, p2.id}
    m.indexes.verify_consistent()


def test_non_containment_edge_is_ignored() -> None:
    m = _model()
    a, b = _named(m, "A"), _named(m, "B")
    m.connect("Links", a.id, b.id)
    assert m.indexes.roots_count() == 2
    m.indexes.verify_consistent()


def test_rename_repositions() -> None:
    m = _model()
    a, z = _named(m, "Alpha"), _named(m, "Zeta")
    assert m.indexes.roots_page(0, 10) == [a.id, z.id]
    m.set_property(a, "name", "Zulu")
    assert m.indexes.roots_page(0, 10) == [z.id, a.id]
    m.indexes.verify_consistent()


def test_delete_cascade_keeps_index_consistent() -> None:
    m = _model()
    parent = _named(m, "P")
    child = _named(m, "C")
    grandchild = _named(m, "G")
    m.connect("Contains", parent.id, child.id)
    m.connect("Contains", child.id, grandchild.id)
    m.delete_element(parent.id)  # cascades through child + grandchild
    assert m.indexes.roots_count() == 0
    m.indexes.verify_consistent()


def test_rebuild_parity() -> None:
    """Bulk-load path: populate dicts directly, rebuild, compare to hooks."""
    m = _model()
    parent = _named(m, "P")
    child = _named(m, "C")
    m.connect("Contains", parent.id, child.id)
    _named(m, "Free")
    expected = m.indexes.roots_order.as_list()
    m.indexes.rebuild()
    assert m.indexes.roots_order.as_list() == expected
    m.indexes.verify_consistent()
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/model/test_roots_order.py -v`
Expected: FAIL with `AttributeError: 'IndexSet' object has no attribute 'roots_page'`.

- [ ] **Step 5: Implement in IndexSet**

All edits in `src/data_rover/core/model/indexes.py`.

**5a — imports** (top of file, after the existing `.element`/`.relationship` imports):

```python
from collections.abc import Hashable, Iterator, Set, Sequence   # add Iterator
from ._sorted import Pair, SortedPairs
from .naming import display_name
```

**5b — fields** in `__init__`, after the `duplicate_keys` field (line ~90):

```python
#: containment roots (elements with NO containment parent) as
#: (display_name, id) pairs in ascending order — the exact order the
#: containment-roots endpoints page in. Maintained by the same mutation
#: hooks as containment_parents; rebuilt by rebuild().
self.roots_order: SortedPairs = SortedPairs()
# element id -> its CURRENT key in roots_order (needed to remove/reposition
# after a rename, since the old display name is gone from the element)
self._root_key_of: dict[str, Pair] = {}
```

**5c — accessors**, after `referencers_of` (line ~137):

```python
def roots_count(self) -> int:
    """Number of containment roots — O(1)."""
    return len(self.roots_order)

def roots_page(self, offset: int, limit: int) -> list[str]:
    """Root element ids in (display_name, id) order — O(log n + limit)."""
    return [eid for _, eid in self.roots_order.page(offset, limit)]

def iter_roots(self) -> Iterator[str]:
    """All root ids in (display_name, id) order — lazily, O(1) per step."""
    return (eid for _, eid in self.roots_order.iter_all())
```

**5d — maintenance helpers**, add a new section after `_remove_from_group`/`_rekey_if_present` internals (keep it near the other `# -- internals:` blocks):

```python
# -- internals: roots order ----------------------------------------------

def _roots_add(self, element: Element) -> None:
    key = (display_name(element), element.id)
    self._root_key_of[element.id] = key
    self.roots_order.add(key)

def _roots_remove(self, element_id: str) -> None:
    key = self._root_key_of.pop(element_id, None)
    if key is not None:
        self.roots_order.remove(key)

def _roots_reposition(self, element: Element) -> None:
    """Re-key a root after a property change (its display name may have
    moved). No-op for non-roots."""
    old = self._root_key_of.get(element.id)
    if old is None:
        return
    new = (display_name(element), element.id)
    if new == old:
        return
    self.roots_order.remove(old)
    self.roots_order.add(new)
    self._root_key_of[element.id] = new
```

**5e — hook wiring:**

In `on_element_created`, append:

```python
# a fresh element has no containment parent -> it is a root
self._roots_add(element)
```

In `on_element_deleted`, append (deletion removes relationships first, so the element is back in the roots set by the time this fires):

```python
self._roots_remove(element.id)
```

In `on_relationship_created`, inside the `if self._containment(rel.type_name):` branch, after the two `setdefault(...).append(...)` lines and before `self._rekey_if_present(...)`:

```python
if len(self.containment_parents[rel.target_id]) == 1:
    # first containment parent: the target stops being a root
    self._roots_remove(rel.target_id)
```

In `on_relationship_deleted`, inside the `if not rel_ids:` block (after the two `del` statements):

```python
target = self._model.elements.get(rel.target_id)
if target is not None:
    # last containment parent gone: the target is a root again
    self._roots_add(target)
```

In `on_properties_changed`, in the `isinstance(entity, Element)` branch, after `self._rekey(entity)`:

```python
self._roots_reposition(entity)
```

**5f — rebuild:** add to the `.clear()` block at the top:

```python
self.roots_order.clear()
self._root_key_of.clear()
```

and inside the existing element loop (`for element in self._model.elements.values():`), append:

```python
if element.id not in self.containment_parents:
    self._root_key_of[element.id] = (display_name(element), element.id)
```

then after that loop (still inside `rebuild`), bulk-construct in one O(n log n) pass instead of n incremental adds:

```python
self.roots_order = SortedPairs(self._root_key_of.values())
```

**5g — verify_consistent:** add `"_root_key_of"` and `"roots_order"` to the `mismatched` names tuple, and extend `_norm` so `SortedPairs` compares by content:

```python
def _norm(name: str, obj: object) -> object:
    # Counter.__eq__ ignores zero-count entries, so compare as plain
    # dicts to catch spurious zeroes left in the live index.
    if isinstance(obj, Counter):
        return dict(obj)
    if isinstance(obj, SortedPairs):
        return obj.as_list()
    return obj
```

**5h — module docstring:** extend the `indexes.py` module docstring's maintained-structures description with one sentence: roots order is maintained at the same boundary and `rebuild()`/direct-property-writers have the same obligations.

- [ ] **Step 6: Run tests**

Run: `pixi run -e core-dev pytest tests/model/ -v`
Expected: ALL PASS (new file and every existing model test — `verify_consistent` is called by existing tests and now covers the new structures).

- [ ] **Step 7: Lint**

Run: `pixi run lint-core`
Expected: ruff, mypy, pyright all clean. If mypy still flags the sortedcontainers import despite the ignore comment, the error code in the comment must match mypy's output (`import-untyped` vs `import-not-found`) — fix the code in `_sorted.py`, nowhere else.

- [ ] **Step 8: Commit**

```bash
git add pixi.toml pixi.lock src/data_rover/core/model/_sorted.py src/data_rover/core/model/indexes.py tests/model/test_roots_order.py
git commit -m "feat(core): maintained containment-roots order index in IndexSet

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Roots endpoints use the index; islice micro-fix

`list_containment_roots` and `list_excluded_roots` stop scanning+sorting the whole model per request; the unfiltered `/model/elements` skip-loop becomes `itertools.islice` (contract unchanged — see spec delta 1).

**Files:**
- Modify: `src/data_rover/api/routes/read.py:494-555` (both roots handlers) and `:229-241` (unfiltered paging)
- Test: `tests/api/test_read_routes.py` (one new test; existing ordering tests must pass unchanged)

**Interfaces:**
- Consumes: `IndexSet.roots_count() / roots_page(offset, limit) / iter_roots()` from Task 3.
- Produces: no new interfaces — same HTTP contracts, now O(page).

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_read_routes.py` (in the containment-roots section; it uses the existing `tree_client` fixture and `get_session` import already present in the file):

```python
def test_roots_order_follows_mutation_boundary(tree_client: TestClient) -> None:
    """The roots endpoints read the maintained order index, so a rename
    through the core mutation boundary must reorder the next page — without
    any per-request re-sort."""
    session = get_session()
    assert session.model is not None
    # rename free root "x" (display "X", sorts last) to sort first
    session.model.set_property(session.model.elements["x"], "name", "AAA")
    body = tree_client.get(f"{API}/model/containment/roots").json()
    assert [i["id"] for i in body["items"]][0] == "x"
    assert body["total"] == 3
```

- [ ] **Step 2: Run to verify current behaviour**

Run: `pixi run -e core-dev pytest tests/api/test_read_routes.py::test_roots_order_follows_mutation_boundary -v`
Expected: PASS already (the old code re-sorts per request) — this test's job is to prove the rewrite doesn't regress live-mutation ordering. Verify the OTHER roots tests pass too before touching the handlers: `pixi run -e core-dev pytest tests/api/test_read_routes.py -v` → ALL PASS.

- [ ] **Step 3: Rewrite the handlers**

In `src/data_rover/api/routes/read.py` replace the body of `list_containment_roots` (keep decorator, signature, and docstring; append to the docstring: "Served from the IndexSet's maintained roots order — O(page + log n), no per-request scan or sort."):

```python
    _, model = require_model(session)
    idx = model.indexes
    return TreeItemPage(
        items=[_tree_item(model, eid) for eid in idx.roots_page(offset, limit)],
        total=idx.roots_count(),
    )
```

Replace the body of `list_excluded_roots` (keep decorator/signature/docstring; append to the docstring: "Walks the maintained roots order filtering view-placed ids — O(roots) worst case but with no display-name computation or sort, which were the dominant cost."):

```python
    _, model = require_model(session)
    idx = model.indexes
    placed = _placed_element_ids(session.view) if session.view is not None else set()
    items: list[TreeItem] = []
    total = 0
    for eid in idx.iter_roots():
        if eid in placed:
            continue
        if total >= offset and len(items) < limit:
            items.append(_tree_item(model, eid))
        total += 1
    return TreeItemPage(items=items, total=total)
```

In `list_elements`, replace ONLY the unfiltered branch of the no-query path (keep the type-filtered loop exactly as is) — current code at `:229-241`:

```python
    items: list[ElementOut] = []
    if offset < total:
        if type is None:
            items = [
                ElementOut.from_core(element)
                for element in islice(model.elements.values(), offset, offset + limit)
            ]
        else:
            skipped = 0
            for element in model.elements.values():
                if element.type_name != type:
                    continue
                if skipped < offset:
                    skipped += 1
                    continue
                items.append(ElementOut.from_core(element))
                if len(items) >= limit:
                    break
    return ElementPage(items=items, total=total)
```

Add `from itertools import islice` to the imports.

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_read_routes.py -v`
Expected: ALL PASS — including the pre-existing ordering tests (`test_containment_roots`, excluded-roots paging, element insertion-order tests) and the new one.

- [ ] **Step 5: Lint + full API suite**

Run: `pixi run lint-backend && pixi run -e core-dev pytest tests/api/ -q`
Expected: clean; all pass.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/read.py tests/api/test_read_routes.py
git commit -m "perf(api): serve containment roots from the maintained order index

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Background validation sweep

Full-model validation moves off the load/upload/hydrate path into a chunked sweep that interleaves with edits under `write_mutex`. A `validation_sweep_sync` setting runs it inline (pinned true in the API test conftest so the existing suite's "validation seeded after load" assumption holds).

**Files:**
- Create: `src/data_rover/api/validation_sweep.py`
- Modify: `src/data_rover/api/session.py` (Session field + evict guard), `src/data_rover/api/settings.py`, `src/data_rover/api/routes/model.py` (`_install_model`), `src/data_rover/api/hydration.py` (`hydrate_session` tail), `tests/api/conftest.py` (pin sync)
- Test: `tests/api/test_validation_sweep.py`

**Interfaces:**
- Consumes: `Session` (`session.py`), `ValidationState.replace`, `Scope(ids)`, `default_pipeline()`.
- Produces:
  - `validation_sweep.SweepProgress` dataclass: fields `total: int`, `done: int`, `running: bool`, `cancel: threading.Event`
  - `validation_sweep.start_validation_sweep(session: Session, *, sync: bool | None = None) -> SweepProgress`
  - `Session.validation_sweep: SweepProgress | None` field
  - Setting `validation_sweep_sync: bool = False` (env `DATA_ROVER_VALIDATION_SWEEP_SYNC`)
  - Task 6 reads `session.validation_sweep` for the status endpoint.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_validation_sweep.py`:

```python
"""Chunked background validation sweep (spec §3).

Sync mode is what the rest of the API suite runs under (conftest pins it);
these tests exercise both modes plus the abort-on-model-replace guard.
"""

from __future__ import annotations

import time

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.validation.state import ValidationState
from data_rover.api.session import Session
from data_rover.api.validation_sweep import start_validation_sweep

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""


def _session(n: int) -> Session:
    metamodel = load_metamodel_str(MM)
    model = Model(metamodel)
    for _ in range(n):
        model.create_element("Item")  # missing required name -> 1 issue each
    session = Session(metamodel=metamodel, model=model)
    session.validation = ValidationState()
    return session


def test_sync_sweep_seeds_all_issues() -> None:
    session = _session(10)
    progress = start_validation_sweep(session, sync=True)
    assert progress.running is False
    assert (progress.done, progress.total) == (10, 10)
    assert session.validation is not None
    assert len(session.validation.all_issues()) == 10


def test_async_sweep_completes() -> None:
    session = _session(50)
    progress = start_validation_sweep(session, sync=False)
    deadline = time.monotonic() + 10.0
    while progress.running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert progress.running is False
    assert session.validation is not None
    assert len(session.validation.all_issues()) == 50


def test_sweep_aborts_when_model_replaced() -> None:
    session = _session(50)
    swept_model = session.model
    progress = start_validation_sweep(session, sync=False)
    session.set_model(None)  # clears validation; sweep must notice and stop
    deadline = time.monotonic() + 10.0
    while progress.running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert progress.running is False
    assert session.model is not swept_model
    assert session.validation is None  # the aborted sweep spliced nothing back


def test_cancel_event_stops_sweep() -> None:
    session = _session(50)
    progress = start_validation_sweep(session, sync=False)
    progress.cancel.set()
    deadline = time.monotonic() + 10.0
    while progress.running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert progress.running is False
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_validation_sweep.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'data_rover.api.validation_sweep'`.

- [ ] **Step 3: Implement the sweep module**

Create `src/data_rover/api/validation_sweep.py`:

```python
"""Chunked background full-model validation (spec §3).

The load/upload/hydrate paths install the model with a PRESENT-but-EMPTY
``ValidationState`` and start this sweep instead of validating inline. The
sweep walks the entity ids in fixed-size chunks; each chunk is validated with
a bounded ``Scope`` and spliced into the session's issue store via
``ValidationState.replace`` — the exact splice the ops dirty path uses — so
edits and the sweep interleave correctly in either order: whichever runs
second for an entity recomputes that entity's issues.

Locking: each chunk (validate + splice) runs under ``session.write_mutex``,
released between chunks, so an ops batch is never starved for longer than one
chunk. Abort conditions checked per chunk under the mutex: the session's model
was replaced (``session.model is not model``), the validation state was
cleared, or ``progress.cancel`` was set (eviction path).

Because a PRESENT ``ValidationState`` is installed up front,
``_ensure_validation_seeded`` (routes/ops.py) never re-runs a synchronous
full sweep mid-edit — issue counts simply grow as chunks land.

Reporting-granularity note: a scoped run reports one containment-cycle issue
PER swept element whose parent chain reaches a cycle, where the historical
full sweep reported a single representative issue (see the spec's design
deltas; cycles are pathological structural blockers).
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

from .session import Session
from .settings import get_settings

#: entities validated (and spliced) per write_mutex acquisition. Large enough
#: to amortize lock/pipeline overhead, small enough that an interleaved ops
#: batch waits at most a few milliseconds.
CHUNK_SIZE = 2000


@dataclass
class SweepProgress:
    """Observable progress of one sweep (read by GET /model/status)."""

    total: int = 0
    done: int = 0
    running: bool = True
    cancel: threading.Event = field(default_factory=threading.Event)


def start_validation_sweep(
    session: Session, *, sync: bool | None = None
) -> SweepProgress:
    """Start (or, in sync mode, run to completion) a full-model sweep.

    ``sync=None`` reads ``settings.validation_sweep_sync`` — false in
    production (background thread), pinned true by the API test conftest so
    existing tests keep their "validation seeded after load" assumption.
    """
    model = session.model
    assert model is not None, "start_validation_sweep requires a loaded model"
    progress = SweepProgress()
    session.validation_sweep = progress
    if sync if sync is not None else get_settings().validation_sweep_sync:
        _run(session, model, progress)
    else:
        threading.Thread(
            target=_run,
            args=(session, model, progress),
            name="validation-sweep",
            daemon=True,
        ).start()
    return progress


def _run(session: Session, model, progress: SweepProgress) -> None:
    try:
        ids = list(model.elements.keys()) + list(model.relationships.keys())
        progress.total = len(ids)
        # one pipeline per sweep thread (validators carry mutable memo caches)
        pipeline = default_pipeline()
        for start in range(0, len(ids), CHUNK_SIZE):
            chunk = ids[start : start + CHUNK_SIZE]
            with session.write_mutex:
                if session.model is not model or progress.cancel.is_set():
                    return
                state = session.validation
                if state is None:
                    return
                # entities deleted since the id snapshot are skipped by the
                # scoped pipeline and their (absent) issues dropped by replace
                issues = pipeline.validate(model, Scope(chunk))
                state.replace(chunk, issues)
            progress.done = min(start + CHUNK_SIZE, len(ids))
    finally:
        progress.running = False
```

- [ ] **Step 4: Session field + evict guard + setting**

In `src/data_rover/api/session.py`:

Add to the `TYPE_CHECKING` block:

```python
if TYPE_CHECKING:
    from .schemas import OpIn
    from .validation_sweep import SweepProgress
```

Add a field on `Session` (after `strict_mode`):

```python
#: progress of the in-flight background validation sweep (spec: interactive
#: -path hardening §3), installed by validation_sweep.start_validation_sweep;
#: stays set after completion (running=False) so /model/status can report
#: "ready". Replaced wholesale by the next sweep.
validation_sweep: "SweepProgress | None" = field(default=None, repr=False)
```

In `SessionRegistry.evict`, extend the skip condition:

```python
            if (
                session.lock_table.active_leases(time.monotonic())
                or session.hub.has_clients()
                or (
                    session.validation_sweep is not None
                    and session.validation_sweep.running
                )
            ):
```

and extend that block's comment with: "A running validation sweep also blocks eviction — evicting would snapshot fine but waste the sweep; sweeps finish in seconds and the idle sweeper retries."

In `src/data_rover/api/settings.py`, add next to the other feature settings (mirror the neighbouring comment style):

```python
    #: run the background validation sweep inline (synchronously) on the
    #: load/upload/hydrate paths. False in production; the API test conftest
    #: pins it true so tests keep deterministic "seeded after load" semantics.
    validation_sweep_sync: bool = False
```

In `tests/api/conftest.py`, add to the env block at the top (with the other setdefaults):

```python
os.environ.setdefault("DATA_ROVER_VALIDATION_SWEEP_SYNC", "true")
```

- [ ] **Step 5: Rewire `_install_model` and `hydrate_session`**

In `src/data_rover/api/routes/model.py`, `_install_model`: replace

```python
    model = build_model_from_dicts(metamodel, raw)
    state = ValidationState()
    state.set_full(default_pipeline().validate(model, Scope.all()))
    session.set_model(model, validation=state)
```

with

```python
    model = build_model_from_dicts(metamodel, raw)
    # install with a PRESENT-but-EMPTY issue store: ops batches splice into it
    # immediately (no synchronous re-seed) while the background sweep fills it
    session.set_model(model, validation=ValidationState())
```

and after the `persist_baseline` block, before `return model_summary(session)`, add:

```python
    start_validation_sweep(session)
```

Update imports: add `from ..validation_sweep import start_validation_sweep`; remove the now-unused `default_pipeline` and `Scope` imports (keep `ValidationState`). Update the `_install_model` docstring: the load is no longer "the single O(model) validation cost" — validation now streams in via the background sweep; the summary's `issue_counts` starts at zero and grows.

In `src/data_rover/api/hydration.py`, `hydrate_session`: replace

```python
    state = ValidationState()
    state.set_full(default_pipeline().validate(model, Scope.all()))
    session.validation = state
    session.strict_mode = strict_mode
    return session
```

with

```python
    session.validation = ValidationState()
    session.strict_mode = strict_mode
    start_validation_sweep(session)
    return session
```

Add `from .validation_sweep import start_validation_sweep` to the imports (no cycle: `validation_sweep` imports only `session` and `settings`); drop `default_pipeline`/`Scope` imports if now unused in the module (check `reconstruct_model_at` first — it does not validate, so they should be removable).

- [ ] **Step 6: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_validation_sweep.py -v`
Expected: ALL PASS.

Run the FULL suite: `pixi run -e core-dev pytest -q`
Expected: ALL PASS. If any test asserts a single containment-cycle issue after a load (spec delta 2 — chunked scoped sweeps report one issue per swept element on a cycle chain), update that assertion to the per-element count and note it in the commit message.

- [ ] **Step 7: Lint**

Run: `pixi run lint-backend`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/validation_sweep.py src/data_rover/api/session.py src/data_rover/api/settings.py src/data_rover/api/routes/model.py src/data_rover/api/hydration.py tests/api/conftest.py tests/api/test_validation_sweep.py
git commit -m "feat(api): move full-model validation to a chunked background sweep

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: GET /model/status + hydration progress

A non-hydrating status endpoint the frontend polls during project open: reports `cold` / `hydrating` (with build counts) / `empty` / `validating` (with sweep counts) / `ready`. Requires membership but must NOT touch `SessionRegistry.get` (that would block on/trigger hydration).

**Files:**
- Modify: `src/data_rover/api/session.py` (add `SessionRegistry.peek`), `src/data_rover/api/hydration.py` (progress map + phase updates), `src/data_rover/api/routes/_snapshot.py` (`build_model_from_dicts` `on_progress` param), `src/data_rover/api/routes/model.py` (endpoint)
- Test: `tests/api/test_model_status.py`

**Interfaces:**
- Consumes: `Session.validation_sweep` (Task 5).
- Produces:
  - `SessionRegistry.peek(project_id: str) -> Session | None`
  - `hydration.HydrationProgress` dataclass (`phase: str` in `download|parse|build|replay`, `done: int`, `total: int`) and `hydration.hydration_progress(project_id: str) -> HydrationProgress | None`
  - `build_model_from_dicts(metamodel, raw, *, strict=True, on_progress: Callable[[int, int], None] | None = None)`
  - `GET /api/v1/projects/{project_id}/model/status` returning `{"state": "cold"|"hydrating"|"empty"|"validating"|"ready", "model_rev": int|null, "validation": {"running","done","total"}|null, "hydration": {"phase","done","total"}|null}` — Task 9's frontend polls this.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_model_status.py`:

```python
"""GET /model/status: non-hydrating open/validation progress (spec §3/§4)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_registry, get_session
from data_rover.api.validation_sweep import SweepProgress

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
"""


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def test_status_unknown_project_404() -> None:
    c = _client()
    assert c.get("/api/v1/projects/nope/model/status").status_code == 404


def test_status_empty_then_ready() -> None:
    c = _client()
    # a contentless project hydrates to an empty session on first data touch;
    # status itself must NOT hydrate: before any touch the project is cold
    assert c.get(f"{API}/model/status").json()["state"] == "cold"
    assert get_registry().peek("default") is None  # peek did not hydrate
    res = c.post(f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200
    assert c.get(f"{API}/model/status").json()["state"] == "empty"
    res = c.post(
        f"{API}/model/upload",
        json={"elements": [{"id": "e1", "type_name": "Item", "properties": {}}], "relationships": []},
    )
    assert res.status_code == 200
    body = c.get(f"{API}/model/status").json()
    # conftest pins the sweep sync, so the model is ready immediately
    assert body["state"] == "ready"
    assert body["model_rev"] == get_session().model_rev


def test_status_reports_running_sweep() -> None:
    c = _client()
    res = c.post(f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200
    res = c.post(
        f"{API}/model/upload",
        json={"elements": [{"id": "e1", "type_name": "Item", "properties": {}}], "relationships": []},
    )
    assert res.status_code == 200
    session = get_session()
    session.validation_sweep = SweepProgress(total=10, done=4, running=True)
    body = c.get(f"{API}/model/status").json()
    assert body["state"] == "validating"
    assert body["validation"] == {"running": True, "done": 4, "total": 10}
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_model_status.py -v`
Expected: FAIL with 404s on `/model/status` (route does not exist yet).

- [ ] **Step 3: `SessionRegistry.peek`**

In `src/data_rover/api/session.py`, add after `get`:

```python
    def peek(self, project_id: str) -> Session | None:
        """The warm session, or None — NEVER hydrates and does not refresh
        ``last_access`` (the status poller must not keep a session alive nor
        trigger a hydration the caller isn't prepared to wait for)."""
        with self._guard:
            return self._sessions.get(project_id)
```

- [ ] **Step 4: Hydration progress map + build callback**

In `src/data_rover/api/routes/_snapshot.py`, change `build_model_from_dicts`'s signature to:

```python
def build_model_from_dicts(
    metamodel: Metamodel,
    raw: Any,
    *,
    strict: bool = True,
    on_progress: Callable[[int, int], None] | None = None,
) -> Model:
```

(add `from typing import Callable` — or extend the existing typing import). Inside, hoist the two `_entity_list` calls above the loops so the total is known, then report every 5000 entities and once at the end:

```python
    element_items = _entity_list(raw, "elements")
    relationship_items = _entity_list(raw, "relationships")
    total = len(element_items) + len(relationship_items)
    built = 0
```

In both entity loops (iterate `element_items` / `relationship_items` instead of calling `_entity_list` inline), after each entity is added:

```python
        built += 1
        if on_progress is not None and built % 5000 == 0:
            on_progress(built, total)
```

and after both loops, before the existing `model.indexes.rebuild()` / return tail:

```python
    if on_progress is not None:
        on_progress(built, total)
```

Docstring: add one line — "``on_progress(built, total)`` fires every 5000 entities and once at the end (hydration progress reporting); it must be cheap and must not touch the model."

In `src/data_rover/api/hydration.py`, add near the top:

```python
from dataclasses import dataclass


@dataclass
class HydrationProgress:
    """Live progress of one in-flight hydration, keyed by project id.

    Registered for exactly the duration of ``hydrate_session`` so the status
    endpoint can report an open that has not produced a Session yet. ``total``
    is 0 until the build phase knows its entity count (indeterminate)."""

    phase: str = "download"  # download | parse | build | replay
    done: int = 0
    total: int = 0


#: project id -> in-flight hydration progress (single mutating writer — the
#: hydrating thread under the registry's per-project init-once lock; readers
#: are GET /model/status requests, which only read primitive fields)
_hydration_progress: dict[str, HydrationProgress] = {}


def hydration_progress(project_id: str) -> HydrationProgress | None:
    return _hydration_progress.get(project_id)
```

Rename the existing `hydrate_session` body to `_hydrate_session(project_id: str, progress: HydrationProgress) -> Session` and make `hydrate_session` the registering wrapper:

```python
def hydrate_session(project_id: str) -> Session:
    """Build the live ``Session`` for a project from durable storage.

    No ``ModelRow`` -> empty ``Session`` (pre-Phase-3 behaviour). Progress is
    published in ``_hydration_progress`` for GET /model/status while this
    runs (the registry's init-once lock guarantees one hydration per id)."""
    progress = HydrationProgress()
    _hydration_progress[project_id] = progress
    try:
        return _hydrate_session(project_id, progress)
    finally:
        _hydration_progress.pop(project_id, None)
```

Inside `_hydrate_session`, set the phases:
- before `raw = json.loads(get_snapshot_store().get(snap_key))`: split into two statements with phase updates — `progress.phase = "download"` then `blob = get_snapshot_store().get(snap_key)`, then `progress.phase = "parse"` and `raw = json.loads(blob)`;
- for the build: `progress.phase = "build"` then

```python
        def _on_build(done: int, total: int) -> None:
            progress.done, progress.total = done, total

        model = build_model_from_dicts(metamodel, raw, strict=False, on_progress=_on_build)
```

- before `replay_commits_into(session, tail)`: `progress.phase = "replay"`.

- [ ] **Step 5: The endpoint**

In `src/data_rover/api/routes/model.py`, add:

```python
class ValidationStatusOut(BaseModel):
    running: bool
    done: int
    total: int


class HydrationStatusOut(BaseModel):
    phase: str
    done: int
    total: int


class ModelStatusOut(BaseModel):
    state: Literal["cold", "hydrating", "empty", "validating", "ready"]
    model_rev: int | None = None
    validation: ValidationStatusOut | None = None
    hydration: HydrationStatusOut | None = None


@router.get("/model/status")
def model_status(
    project_id: str,
    _membership: Membership = Depends(require_membership),
) -> ModelStatusOut:
    """Open/validation progress WITHOUT touching the session registry's
    hydrating ``get`` — the poller must never block on (or trigger) the very
    hydration it is reporting on. Membership is still enforced (the status
    leaks model_rev/entity progress). ``cold`` means "no warm session and no
    hydration in flight": for the poller it is indistinguishable from
    hydrating-not-yet-started, so clients keep polling through it."""
    session = get_registry().peek(project_id)
    if session is None:
        hp = hydration_progress(project_id)
        if hp is not None:
            return ModelStatusOut(
                state="hydrating",
                hydration=HydrationStatusOut(phase=hp.phase, done=hp.done, total=hp.total),
            )
        return ModelStatusOut(state="cold")
    if session.model is None:
        return ModelStatusOut(state="empty")
    sweep = session.validation_sweep
    if sweep is not None and sweep.running:
        return ModelStatusOut(
            state="validating",
            model_rev=session.model_rev,
            validation=ValidationStatusOut(running=True, done=sweep.done, total=sweep.total),
        )
    return ModelStatusOut(state="ready", model_rev=session.model_rev)
```

Imports to add in that file: `from typing import Literal` (extend the existing typing import), `from pydantic import BaseModel`, `from ..authz import require_membership`, `from ..db_models import Membership`, `from ..session import get_registry`, `from ..hydration import hydration_progress` (note: `..hydration` already imported for `persist_baseline` — extend it).

- [ ] **Step 6: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_model_status.py tests/api/test_hydration.py tests/api/test_eviction.py -v`
Expected: ALL PASS (hydration tests exercise the renamed wrapper).

- [ ] **Step 7: Lint + full suite**

Run: `pixi run lint-backend && pixi run -e core-dev pytest -q`
Expected: clean; all pass.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/session.py src/data_rover/api/hydration.py src/data_rover/api/routes/_snapshot.py src/data_rover/api/routes/model.py tests/api/test_model_status.py
git commit -m "feat(api): non-hydrating GET /model/status with hydration+sweep progress

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend progress store + ProgressOverlay

One overlay component driven by a tiny stack-shaped store: determinate radial with the percentage number centered when a total is known, indeterminate spinner otherwise (user requirement).

**Files:**
- Create: `frontend/src/lib/state/progress.svelte.ts`
- Create: `frontend/src/lib/components/ProgressOverlay.svelte`
- Modify: `frontend/src/lib/state/index.ts` (re-export), `frontend/src/routes/+layout.svelte` (mount)
- Test: `frontend/src/lib/state/__tests__/progress.test.ts`, `frontend/src/lib/components/__tests__/ProgressOverlay.test.ts`

**Interfaces:**
- Produces (from `$lib/state`): `startProgress(label: string): number`, `updateProgress(id: number, done: number, total: number): void`, `setProgressLabel(id: number, label: string): void`, `endProgress(id: number): void`, `getActiveProgress(): { id: number; label: string; done: number | null; total: number | null } | null`, `resetProgress(): void`. Tasks 8 and 9 consume these.

- [ ] **Step 1: Write the failing store test**

Create `frontend/src/lib/state/__tests__/progress.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
	endProgress,
	getActiveProgress,
	resetProgress,
	setProgressLabel,
	startProgress,
	updateProgress
} from '../progress.svelte';

describe('progress store', () => {
	beforeEach(() => resetProgress());

	it('starts indeterminate and becomes determinate on update', () => {
		const id = startProgress('Uploading…');
		expect(getActiveProgress()).toMatchObject({ label: 'Uploading…', done: null, total: null });
		updateProgress(id, 50, 200);
		expect(getActiveProgress()).toMatchObject({ done: 50, total: 200 });
	});

	it('oldest entry wins; end reveals the next', () => {
		const a = startProgress('A');
		const b = startProgress('B');
		expect(getActiveProgress()?.id).toBe(a);
		endProgress(a);
		expect(getActiveProgress()?.id).toBe(b);
		endProgress(b);
		expect(getActiveProgress()).toBeNull();
	});

	it('relabels and ignores updates to unknown ids', () => {
		const id = startProgress('A');
		setProgressLabel(id, 'B');
		updateProgress(999, 1, 2);
		expect(getActiveProgress()).toMatchObject({ label: 'B', done: null });
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/progress.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `frontend/src/lib/state/progress.svelte.ts`:

```ts
/**
 * Global long-operation progress store (spec §4).
 *
 * A stack of active operations; the OLDEST entry drives the ProgressOverlay
 * (an outer operation like "opening project" is not hidden by a nested one).
 * `done`/`total` null = indeterminate spinner; set = determinate radial with
 * a centered percentage.
 */

export interface ProgressEntry {
	id: number;
	label: string;
	done: number | null;
	total: number | null;
}

let _entries = $state<ProgressEntry[]>([]);
let _nextId = 1;

export function startProgress(label: string): number {
	const id = _nextId++;
	_entries = [..._entries, { id, label, done: null, total: null }];
	return id;
}

export function updateProgress(id: number, done: number, total: number): void {
	_entries = _entries.map((e) => (e.id === id ? { ...e, done, total } : e));
}

export function setProgressLabel(id: number, label: string): void {
	_entries = _entries.map((e) => (e.id === id ? { ...e, label } : e));
}

export function endProgress(id: number): void {
	_entries = _entries.filter((e) => e.id !== id);
}

export function getActiveProgress(): ProgressEntry | null {
	return _entries[0] ?? null;
}

/** Test isolation. */
export function resetProgress(): void {
	_entries = [];
	_nextId = 1;
}
```

Re-export everything from `frontend/src/lib/state/index.ts` (follow the file's existing export style):

```ts
export {
	startProgress,
	updateProgress,
	setProgressLabel,
	endProgress,
	getActiveProgress,
	resetProgress
} from './progress.svelte';
```

- [ ] **Step 4: Run store test**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/progress.test.ts'`
Expected: PASS.

- [ ] **Step 5: The overlay component + its test**

Create `frontend/src/lib/components/ProgressOverlay.svelte` (Tailwind zinc palette like the rest of the app; scrim styling mirrors `ui/dialog/dialog-overlay.svelte`):

```svelte
<script lang="ts">
	import { getActiveProgress } from '$lib/state/progress.svelte';

	const entry = $derived(getActiveProgress());
	const percent = $derived.by(() => {
		if (!entry || entry.total === null || entry.total <= 0) return null;
		return Math.min(100, Math.round(((entry.done ?? 0) / entry.total) * 100));
	});

	const R = 26;
	const CIRC = 2 * Math.PI * R;
</script>

{#if entry}
	<div
		class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/40 supports-backdrop-filter:backdrop-blur-xs"
		role="status"
		aria-live="polite"
		data-testid="progress-overlay"
	>
		<div class="relative h-20 w-20">
			<svg viewBox="0 0 64 64" class="h-20 w-20 -rotate-90 {percent === null ? 'animate-spin' : ''}">
				<circle cx="32" cy="32" r={R} fill="none" stroke-width="6" class="stroke-zinc-800" />
				<circle
					cx="32"
					cy="32"
					r={R}
					fill="none"
					stroke-width="6"
					stroke-linecap="round"
					class="stroke-zinc-100"
					stroke-dasharray={percent === null ? `${CIRC * 0.25} ${CIRC}` : `${(CIRC * percent) / 100} ${CIRC}`}
				/>
			</svg>
			{#if percent !== null}
				<span
					class="absolute inset-0 flex items-center justify-center text-sm font-semibold text-zinc-100"
					data-testid="progress-percent">{percent}%</span
				>
			{/if}
		</div>
		<p class="text-xs text-zinc-300">{entry.label}</p>
	</div>
{/if}
```

Create `frontend/src/lib/components/__tests__/ProgressOverlay.test.ts` (mount/flushSync pattern like `ProjectCard.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ProgressOverlay from '../ProgressOverlay.svelte';
import { endProgress, resetProgress, startProgress, updateProgress } from '$lib/state/progress.svelte';

describe('ProgressOverlay', () => {
	let component: ReturnType<typeof mount>;

	beforeEach(() => {
		resetProgress();
		component = mount(ProgressOverlay, { target: document.body });
		flushSync();
	});

	afterEach(() => {
		unmount(component);
		document.body.innerHTML = '';
	});

	it('renders nothing when idle', () => {
		expect(document.querySelector('[data-testid="progress-overlay"]')).toBeNull();
	});

	it('shows indeterminate (no percent) then determinate with centered number', () => {
		const id = startProgress('Uploading…');
		flushSync();
		expect(document.querySelector('[data-testid="progress-overlay"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="progress-percent"]')).toBeNull();
		updateProgress(id, 30, 60);
		flushSync();
		expect(document.querySelector('[data-testid="progress-percent"]')?.textContent).toBe('50%');
		endProgress(id);
		flushSync();
		expect(document.querySelector('[data-testid="progress-overlay"]')).toBeNull();
	});
});
```

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/ProgressOverlay.test.ts'`
Expected: PASS.

- [ ] **Step 6: Mount it globally**

In `frontend/src/routes/+layout.svelte`: import the component in the script block and render it once, after the existing children/slot render:

```svelte
<script lang="ts">
	import ProgressOverlay from '$lib/components/ProgressOverlay.svelte';
	// ...existing script content stays...
</script>

<!-- ...existing markup stays... -->
<ProgressOverlay />
```

(Adapt to the file's actual structure — the invariant is: rendered exactly once at the app root, outside any route guard, so both the /projects wizard and the workspace can use it.)

- [ ] **Step 7: Full frontend checks**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'` and `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/state/progress.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/components/ProgressOverlay.svelte frontend/src/routes/+layout.svelte frontend/src/lib/state/__tests__/progress.test.ts frontend/src/lib/components/__tests__/ProgressOverlay.test.ts
git commit -m "feat(frontend): global progress store + determinate radial overlay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: XHR upload with byte progress

`fetch` cannot report upload progress, so add an XHR-based `apiUpload` beside `apiFetch` in the client, thread an optional `onProgress` through `createProject` (New Project wizard — the real user-reachable upload path) and `uploadModelBody`, and drive the overlay from the wizard.

**Files:**
- Modify: `frontend/src/lib/api/client.ts` (add `apiUpload`), `frontend/src/lib/api/projects.ts` (`createProject` gains `onProgress`), `frontend/src/lib/api/model-ops.ts` (`uploadModelBody` gains `onProgress`), `frontend/src/lib/components/projects/NewProjectWizard.svelte` (drive the overlay)
- Test: `frontend/src/lib/api/__tests__/upload.test.ts`

**Interfaces:**
- Consumes: progress store from Task 7; existing client internals (`_activeBaseUrl`, `FALLBACK_BASE_URL`, the non-2xx error mapping used by `apiFetchRaw` at `client.ts:113-129`, the 401 handler).
- Produces: `apiUpload<T>(path, { body, schema?, onProgress? }, config?): Promise<T>`; `createProject(..., onProgress?)`; `uploadModelBody(body, cfg?, onProgress?)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/api/__tests__/upload.test.ts` (MSW intercepts XHR through the same interceptors as fetch; upload *progress events* don't fire under MSW, so progress is unit-tested at the API-shape level, and the success/error mapping over the wire):

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { apiUpload } from '../client';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('apiUpload', () => {
	it('POSTs the body with the CSRF header and parses via schema', async () => {
		let requestedWith: string | null = null;
		let received = '';
		server.use(
			http.post(`${BASE}/model/upload`, async ({ request }) => {
				requestedWith = request.headers.get('x-requested-with');
				received = await request.text();
				return HttpResponse.json({ ok: true });
			})
		);
		const out = await apiUpload(
			'/model/upload',
			{ body: '{"elements":[]}', schema: z.object({ ok: z.boolean() }) },
			cfg
		);
		expect(out).toEqual({ ok: true });
		expect(requestedWith).toBe('data-rover');
		expect(received).toBe('{"elements":[]}');
	});

	it('maps non-2xx to the shared typed errors', async () => {
		server.use(
			http.post(`${BASE}/model/upload`, () =>
				HttpResponse.json({ error: 'boom' }, { status: 422 })
			)
		);
		await expect(apiUpload('/model/upload', { body: 'x' }, cfg)).rejects.toMatchObject({
			status: 422
		});
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/upload.test.ts'`
Expected: FAIL — `apiUpload` is not exported.

- [ ] **Step 3: Implement `apiUpload` in client.ts**

Add to `frontend/src/lib/api/client.ts` (same module, so reuse its private base-URL constants and the exact non-2xx mapping used in `apiFetchRaw` at lines ~113-129 — same body-parse, same `messageFromBody`-equivalent, same error constructor from `./errors`, same 401 handler call; do NOT reimplement different semantics):

```ts
export interface ApiUploadInit<T> {
	body: Blob | ArrayBuffer | FormData | string;
	schema?: z.ZodType<T>;
	/** Fires on XHR upload progress; total is null when not computable. */
	onProgress?: (loaded: number, total: number | null) => void;
}

/**
 * XHR-based POST for request bodies whose UPLOAD progress matters (fetch has
 * no upload progress events). Mirrors apiFetch's semantics exactly: same
 * base-URL resolution, credentials, X-Requested-With CSRF header, Zod schema
 * parse, typed non-2xx errors, and global 401 handling.
 */
export function apiUpload<T = unknown>(
	path: string,
	init: ApiUploadInit<T>,
	config?: ClientConfig
): Promise<T> {
	const base = config?.baseUrl ?? _activeBaseUrl ?? FALLBACK_BASE_URL;
	const url = `${base}${path}`;
	return new Promise<T>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('POST', url);
		xhr.withCredentials = true;
		xhr.setRequestHeader('X-Requested-With', 'data-rover');
		xhr.upload.addEventListener('progress', (e) => {
			init.onProgress?.(e.loaded, e.lengthComputable ? e.total : null);
		});
		xhr.addEventListener('load', () => {
			const text = xhr.responseText;
			if (xhr.status < 200 || xhr.status >= 300) {
				// mirror apiFetchRaw's non-2xx branch (client.ts:113-129):
				// parse-if-JSON, build the message, fire the 401 hook, throw typed
				reject(buildApiError(xhr.status, text)); // <- extract this helper
				return;
			}
			if (!text) {
				resolve(undefined as T);
				return;
			}
			try {
				const json: unknown = JSON.parse(text);
				resolve((init.schema ? init.schema.parse(json) : json) as T);
			} catch (err) {
				reject(err);
			}
		});
		xhr.addEventListener('error', () => reject(new Error(`Upload failed: network error (${url})`)));
		xhr.send(init.body instanceof ArrayBuffer ? new Blob([init.body]) : init.body);
	});
}
```

Concretely for the `buildApiError` marker above: extract the existing non-2xx handling in `apiFetchRaw` (the lines that read the text, attempt `JSON.parse`, call the message helper, invoke the unauthorized handler on 401, and construct the error from `./errors`) into a private function `buildApiError(status: number, text: string): Error` used by BOTH `apiFetchRaw` and `apiUpload`, so the two paths cannot drift. Keep `apiFetchRaw`'s observable behaviour byte-identical.

- [ ] **Step 4: Thread onProgress through the API modules**

In `frontend/src/lib/api/projects.ts`, extend `createProject` with a trailing optional parameter `onProgress?: (loaded: number, total: number | null) => void` and switch its multipart POST from `apiFetch` to `apiUpload`, passing `body: formData`, the same Zod schema it already uses, and `onProgress`. Keep the parameter order so existing callers compile unchanged.

In `frontend/src/lib/api/model-ops.ts`, change `uploadModelBody` to:

```ts
export function uploadModelBody(
	body: Blob | ArrayBuffer | string,
	cfg?: ClientConfig,
	onProgress?: (loaded: number, total: number | null) => void
): Promise<ModelSummary> {
	return apiUpload('/model/upload', { body, schema: ModelSummarySchema, onProgress }, cfg);
}
```

(import `apiUpload` from `./client`).

- [ ] **Step 5: Drive the overlay from the New Project wizard**

In `frontend/src/lib/components/projects/NewProjectWizard.svelte`, find the `createProject(...)` call and wrap it:

```ts
import { endProgress, startProgress, updateProgress } from '$lib/state';

// inside the submit handler, replacing the bare `await createProject(...)`:
const token = startProgress('Uploading project files…');
try {
	const project = await createProject(/* existing args unchanged */, (loaded, total) => {
		if (total !== null && total > 0) updateProgress(token, loaded, total);
	});
	// ...existing success handling unchanged...
} finally {
	endProgress(token);
}
```

Adapt variable names to the component's actual code; the invariants are (a) token started before the request, (b) `endProgress` in `finally`, (c) determinate updates only when total is computable.

- [ ] **Step 6: Run tests + checks**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'` and `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: ALL PASS (including pre-existing `LoadFilesDialog`/project tests — `createProject`'s signature is backward-compatible).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api/client.ts frontend/src/lib/api/projects.ts frontend/src/lib/api/model-ops.ts frontend/src/lib/components/projects/NewProjectWizard.svelte frontend/src/lib/api/__tests__/upload.test.ts
git commit -m "feat(frontend): XHR upload path with determinate byte progress

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Open-progress polling

On project open, poll `GET /model/status` and drive the overlay: "Loading model…" (determinate during the build phase) → "Validating model…" (determinate) → gone at `ready`/`empty`; refresh the summary at the end so issue counts land.

**Files:**
- Create: `frontend/src/lib/api/model-status.ts`
- Create: `frontend/src/lib/state/open-progress.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (re-export), `frontend/src/routes/p/[projectId]/+page.svelte` (`boot()` wiring)
- Test: `frontend/src/lib/state/__tests__/open-progress.test.ts`

**Interfaces:**
- Consumes: Task 6's endpoint; Task 7's progress store; `getActiveProjectId()` from `$lib/state/active-project.svelte`; `refreshSummary` from `$lib/state/model.svelte`.
- Produces: `trackOpenProgress(pollMs?: number): Promise<void>` (from `$lib/state`).

- [ ] **Step 1: API function**

Create `frontend/src/lib/api/model-status.ts`:

```ts
import { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';

export const ModelStatusSchema = z.object({
	state: z.enum(['cold', 'hydrating', 'empty', 'validating', 'ready']),
	model_rev: z.number().nullable().optional(),
	validation: z
		.object({ running: z.boolean(), done: z.number(), total: z.number() })
		.nullable()
		.optional(),
	hydration: z
		.object({ phase: z.string(), done: z.number(), total: z.number() })
		.nullable()
		.optional()
});

export type ModelStatus = z.infer<typeof ModelStatusSchema>;

export function getModelStatus(cfg?: ClientConfig): Promise<ModelStatus> {
	return apiFetch('/model/status', { schema: ModelStatusSchema }, cfg);
}
```

(If `client.ts` doesn't export `ClientConfig` as a type import that way, match how `model-read.ts` imports it.)

- [ ] **Step 2: Write the failing state test**

Create `frontend/src/lib/state/__tests__/open-progress.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import { setActiveBaseUrl } from '$lib/api/client';
import { getActiveProgress, resetProgress } from '../progress.svelte';
import { trackOpenProgress } from '../open-progress.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('trackOpenProgress', () => {
	beforeEach(() => {
		resetProgress();
		setActiveBaseUrl(BASE);
	});

	it('shows validating progress then clears at ready and refreshes the summary', async () => {
		const statuses = [
			{ state: 'validating', model_rev: 1, validation: { running: true, done: 5, total: 10 } },
			{ state: 'ready', model_rev: 1 }
		];
		let summaryFetched = false;
		server.use(
			http.get(`${BASE}/model/status`, () => HttpResponse.json(statuses.shift())),
			http.get(`${BASE}/model/summary`, () => {
				summaryFetched = true;
				return HttpResponse.json({
					model_rev: 1,
					element_count: 0,
					relationship_count: 0,
					elements_by_type: {},
					issue_counts: {},
					undo_depth: 0
				});
			})
		);
		const done = trackOpenProgress(1);
		// after the first poll a determinate entry exists
		await new Promise((r) => setTimeout(r, 5));
		expect(getActiveProgress()).toMatchObject({ done: 5, total: 10 });
		await done;
		expect(getActiveProgress()).toBeNull();
		expect(summaryFetched).toBe(true);
	});

	it('never shows an overlay when the model is immediately ready', async () => {
		server.use(http.get(`${BASE}/model/status`, () => HttpResponse.json({ state: 'ready', model_rev: 0 })));
		await trackOpenProgress(1);
		expect(getActiveProgress()).toBeNull();
	});
});
```

Note: if `setActiveBaseUrl` is not exported under that name, use the mechanism `src/lib/state/__tests__/model-store.test.ts` uses to point state modules at MSW (`setModelApiConfig`-style) — the invariant is the poll must hit `BASE`. Adjust `trackOpenProgress` to accept an optional `cfg?: ClientConfig` second parameter if that is the established pattern, and pass it through to `getModelStatus`.

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-progress.test.ts'`
Expected: FAIL — `open-progress.svelte` not found.

- [ ] **Step 4: Implement**

Create `frontend/src/lib/state/open-progress.svelte.ts`:

```ts
/**
 * Project-open progress tracking (spec §4): polls GET /model/status until the
 * backend session is ready, driving the global progress overlay. Fired from
 * boot() in parallel with the data requests that actually trigger hydration —
 * the status endpoint itself never hydrates, so polls return immediately.
 */

import { getModelStatus } from '$lib/api/model-status';
import { getActiveProjectId } from './active-project.svelte';
import { refreshSummary } from './model.svelte';
import { endProgress, setProgressLabel, startProgress, updateProgress } from './progress.svelte';

export async function trackOpenProgress(pollMs = 400): Promise<void> {
	const pid = getActiveProjectId();
	let token: number | null = null;
	try {
		for (;;) {
			if (getActiveProjectId() !== pid) return; // navigated away
			let status;
			try {
				status = await getModelStatus();
			} catch {
				return; // status is best-effort; never block or crash boot
			}
			if (status.state === 'ready' || status.state === 'empty') break;
			if (token === null) token = startProgress('Opening project…');
			if (status.state === 'validating' && status.validation) {
				setProgressLabel(token, 'Validating model…');
				updateProgress(token, status.validation.done, status.validation.total);
			} else if (status.state === 'hydrating' && status.hydration && status.hydration.total > 0) {
				setProgressLabel(token, 'Loading model…');
				updateProgress(token, status.hydration.done, status.hydration.total);
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		// issue counts (and possibly the model itself) landed while we watched
		if (token !== null) await refreshSummary().catch(() => {});
	} finally {
		if (token !== null) endProgress(token);
	}
}
```

(If Step 2's note applied, add the `cfg?: ClientConfig` pass-through parameter.) Re-export `trackOpenProgress` from `frontend/src/lib/state/index.ts`.

- [ ] **Step 5: Wire into boot()**

In `frontend/src/routes/p/[projectId]/+page.svelte`, add `trackOpenProgress` to the `$lib/state` import list and make the FIRST line of `boot()`:

```ts
void trackOpenProgress(); // fire-and-forget: overlay while the requests below hydrate the session
```

- [ ] **Step 6: Run tests + checks**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'` and `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api/model-status.ts frontend/src/lib/state/open-progress.svelte.ts frontend/src/lib/state/index.ts "frontend/src/routes/p/[projectId]/+page.svelte" frontend/src/lib/state/__tests__/open-progress.test.ts
git commit -m "feat(frontend): open-progress overlay polling GET /model/status

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: View-flash fix

Two changes: `boot()` resolves the view BEFORE the summary (so `hasModel` can't flip first), and the tree additionally gates its first roots fetch on a `viewResolved` flag (belt and braces — any future path that sets a summary early cannot regress the flash).

**Files:**
- Modify: `frontend/src/lib/state/view.svelte.ts` (resolved flag), `frontend/src/lib/state/index.ts` (re-export), `frontend/src/routes/p/[projectId]/+page.svelte` (`boot()` reorder), `frontend/src/lib/components/Sidebar/ContainmentTree.svelte` (gate)
- Test: `frontend/src/lib/state/__tests__/view-resolved.test.ts`

**Interfaces:**
- Produces (from `$lib/state`): `isViewResolved(): boolean`, `markViewUnresolved(): void`. `refreshView()` sets resolved true when it completes (success OR failure — "answered" is what matters, even if the answer is "no view").

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/view-resolved.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../../api/__tests__/server';
import { isViewResolved, markViewUnresolved, refreshView } from '../view.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('view resolution gate', () => {
	beforeEach(() => markViewUnresolved());

	it('is unresolved until a delayed refreshView completes', async () => {
		server.use(
			http.get(`${BASE}/view`, async () => {
				await delay(20);
				return HttpResponse.json({ view: null, warnings: [] });
			})
		);
		expect(isViewResolved()).toBe(false);
		const pending = refreshView();
		expect(isViewResolved()).toBe(false); // in flight: still unresolved
		await pending;
		expect(isViewResolved()).toBe(true);
	});

	it('resolves even when the view fetch fails', async () => {
		server.use(http.get(`${BASE}/view`, () => HttpResponse.json({ error: 'x' }, { status: 500 })));
		await refreshView();
		expect(isViewResolved()).toBe(true); // "no view" is an answer
	});
});
```

Note: `refreshView` calls `viewApi.getView()` which resolves the base URL from the active-project state — if the test needs `setActiveBaseUrl(BASE)` (see how existing view/state tests point at MSW), add the same setup line used there in `beforeEach`. The `/view` response shape must match what `viewApi.getView()`'s schema expects — copy the response body from an existing view test if one exists.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/view-resolved.test.ts'`
Expected: FAIL — `isViewResolved` not exported.

- [ ] **Step 3: Implement the flag**

In `frontend/src/lib/state/view.svelte.ts`, add at module level (near the other `$state` declarations):

```ts
/**
 * Whether the active project's view question has been ANSWERED this session
 * (loaded, or confirmed absent/failed). The containment tree must not paint
 * its first rows until this is true — painting with view=null and collapsing
 * later is the "flash of all elements" bug. Reset via markViewUnresolved()
 * at the top of boot() on every project (re)entry.
 */
let _viewResolved = $state(false);

export function isViewResolved(): boolean {
	return _viewResolved;
}

export function markViewUnresolved(): void {
	_viewResolved = false;
}
```

And change `refreshView` to mark resolution in both outcomes:

```ts
export async function refreshView(): Promise<void> {
	try {
		const res = await viewApi.getView();
		setState(res.view, res.warnings);
		setViewBaseline(res.view);
	} catch {
		setState(null, []);
		_baseline = null;
	} finally {
		_viewResolved = true;
	}
}
```

Re-export `isViewResolved` and `markViewUnresolved` from `frontend/src/lib/state/index.ts`.

- [ ] **Step 4: Reorder boot() and gate the tree**

In `frontend/src/routes/p/[projectId]/+page.svelte` `boot()`: add `markViewUnresolved` and (already imported) `refreshView` to the `$lib/state` imports; make the function body order: `markViewUnresolved()` first statement (before `trackOpenProgress` from Task 9 is fine either way, but before any await), then metamodel fetch (unchanged), then **`await refreshView();` immediately after the metamodel try/catch and BEFORE `await refreshSummary()`**, deleting the old `await refreshView();` line further down. Update the boot docstring comment: the view must resolve before the summary so the tree's first paint is already view-shaped.

In `frontend/src/lib/components/Sidebar/ContainmentTree.svelte`: import `isViewResolved` from `$lib/state`; add next to the `hasModel` derived (line ~249):

```ts
// View gate: never paint (or fetch) the first roots page until the view
// question is answered — painting raw roots and collapsing to the view a
// beat later is the "flash of all elements" bug (spec §5).
const viewResolved = $derived(isViewResolved());
```

and in the roots-fetch `$effect` (line ~268) change:

```ts
const loaded = hasModel;
```

to:

```ts
const loaded = hasModel && viewResolved;
```

(`viewResolved` is read inside the effect, so it is tracked: when `refreshView` lands, the effect re-runs and fetches.)

- [ ] **Step 5: Run tests + checks**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'` and `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: ALL PASS. If existing ContainmentTree/Sidebar tests mount the tree with a summary but never resolve a view, they will now render the empty state — fix those tests by calling the real `refreshView` against an MSW `/view` handler or by mocking `isViewResolved` to `true` via the test's existing `$lib/state` mock, matching each test's style.

- [ ] **Step 6: Manual verification**

Run backend + frontend (`pixi run start-backend`, `pixi run start-frontend`), open a project that HAS a view: the tree must appear directly in its collapsed view shape with no all-elements flash. Open a project with NO view: raw roots render as before.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/state/view.svelte.ts frontend/src/lib/state/index.ts "frontend/src/routes/p/[projectId]/+page.svelte" frontend/src/lib/components/Sidebar/ContainmentTree.svelte frontend/src/lib/state/__tests__/view-resolved.test.ts
git commit -m "fix(frontend): resolve view before first tree paint (no all-elements flash)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: After-measurement, docs, full verification

**Files:**
- Modify: `CLAUDE.md` (two-line doc of the new endpoint + background sweep), `docs/superpowers/specs/2026-07-10-interactive-path-hardening-design.md` (record before/after numbers; NOT committed — gitignored)

**Interfaces:** none.

- [ ] **Step 1: Re-run the perf probe**

Run: `pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s`
Expected: roots first/deep pages and excluded-roots dramatically below the Task 1 baseline (target: single-digit ms at PERF_N=50000 for roots pages). Record the table next to the baseline in the spec's §1 section. If roots pages are NOT clearly faster, stop and investigate before proceeding — that is the core promise of this plan.

- [ ] **Step 2: Document in CLAUDE.md**

In `CLAUDE.md`, in the "Backend session & the delta protocol" section (after the reads bullet), add:

```markdown
- **Full-model validation is a background sweep** (`api/validation_sweep.py`): load/upload/hydrate install an empty issue store and stream issues in chunk-by-chunk under the write-mutex; `GET /model/status` (non-hydrating — `SessionRegistry.peek`) reports hydration/sweep progress and the frontend polls it during project open. Containment roots are served from a maintained order index (`IndexSet.roots_order`) — never re-sort roots per request.
```

- [ ] **Step 3: Full verification**

Run all of:

```bash
pixi run -e core-dev pytest -q
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
pixi run tidy
```

Expected: everything passes; `tidy` produces no diff beyond formatting already applied. If `tidy` reformats files, re-run the test suites once more.

- [ ] **Step 4: Run the e2e suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`
Expected: PASS (it boots backend + dev server itself). The tree/view flows exercise Tasks 4 and 10 end-to-end.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: background validation sweep, /model/status, roots order index

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
