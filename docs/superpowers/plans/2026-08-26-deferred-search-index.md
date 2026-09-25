# Deferred, Session-Only Search Index (K-20) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the trigram search index out of `IndexSet.rebuild()` so a cold project open at 300k elements drops from ~35 s to ~10 s, every transient/derived model (rebind preview/commit, `/metamodel/diff`, apply-cr, history reconstruction) stops paying ~22 s + 1.5 GB for an index it never uses, and the live session gets its index built in the background with the existing scan fallback serving search meanwhile.

**Architecture:** `IndexSet` gains a `search_ready` flag plus a chunked build API (`index_search_chunk` / `mark_search_ready` / `build_search_index`); `rebuild()` resets the search index by default and preserves it with `keep_search=True` (the rebind case, where the entity dicts are unchanged). A new `api/search_index_build.py` mirrors `validation_sweep.py` — a daemon thread indexing 1000 elements per `write_mutex` acquisition — kicked from hydration and the model-install routes. `search_candidates` returns `None` (→ the byte-identical scan) until the index is ready. Along the way, `rebuild()` starts clearing the per-type metamodel caches it wrongly kept across a rebind (a diagnosed correctness bug: containment/roots/uniqueness stay stale after a containment- or key-flipping rebind).

**Tech Stack:** Python 3.14 / FastAPI / dataclasses; pytest via pixi (`pixi run -e core-dev pytest`).

**Spec:** `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (the measurements, the program order, and the K-20 design section).

## Global Constraints

- Every command goes through **pixi**: single test file `pixi run -e core-dev pytest tests/path/test_x.py -v`; whole backend suite `pixi run core-test`; lint/format/typecheck `pixi run dr-tidy` (ruff + mypy + pyright must all pass).
- Work on a branch `perf/deferred-search-index` off `main` (create it via `superpowers:using-git-worktrees` at execution time). The repo integrates feature branches into `main` with a merge commit (see `git log --oneline -5`).
- Comments/docstrings: concise, present tense, only invariants and non-obvious contracts. No spec/plan references, no history narration.
- Python 3.14 idioms (`X | Y` unions, `collections.abc` imports).
- `docs/` is gitignored — the spec and this plan are never committed; every other step commits.
- The scan fallback in `routes/read.py::list_elements` is the correctness backstop: `search_candidates` returning `None` must always produce byte-identical results to the index path. Never change `_search_score`.
- The IndexSet mutation hooks (`on_element_created`, `on_element_deleted`, `on_properties_changed`) keep maintaining postings **regardless of `search_ready`** — that is the invariant the chunked build relies on. Do not gate them.
- API tests: the conftest pins `DATA_ROVER_VALIDATION_SWEEP_SYNC=true`; this plan adds the sibling `DATA_ROVER_SEARCH_INDEX_SYNC=true` so every existing API test sees a complete index synchronously after load, exactly as today.

---

### Task 1: `IndexSet` — split the search index out of `rebuild()`

**Files:**
- Modify: `src/data_rover/core/model/indexes.py` (`__init__` :79-155, `search_candidates` :201-237, `rebuild` :327-370, `verify_consistent` :374-418)
- Test: `tests/model/test_search_index.py`

**Interfaces:**
- Produces on `IndexSet`:
  - `search_ready: bool` — `True` on a fresh instance; `False` after `rebuild()` (default) until `mark_search_ready()`.
  - `rebuild(self, *, keep_search: bool = False) -> None` — `keep_search=True` leaves `search_postings`, `_trigrams_of`, `_canon_trigrams` and `search_ready` untouched.
  - `index_search_chunk(self, element_ids: Iterable[str]) -> None` — adds postings for the ids that are in `model.elements` and not yet in `_trigrams_of`; safe to call repeatedly.
  - `mark_search_ready(self) -> None` — sets `search_ready = True`.
  - `build_search_index(self) -> None` — `index_search_chunk(model.elements)` + `mark_search_ready()` (synchronous full build).
  - `search_candidates` returns `None` while `not search_ready`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/model/test_search_index.py` (the file already defines `_model`, `_named`, `_posting_ids`, and imports `Model` / `load_metamodel_str`). Also **replace** the existing `test_rebuild_recomputes_from_scratch` (lines 114-122) with the version below — `rebuild()` no longer rebuilds the search index inline.

```python
def _bulk_loaded(names: list[str]) -> Model:
    """Populate the dicts directly (the bulk-load path) and rebuild()."""
    from data_rover.core.model.element import Element

    m = _model()
    for i, name in enumerate(names):
        eid = f"bulk-{i}"
        m.elements[eid] = Element(id=eid, type_name="Item", properties={"name": name})
    m.indexes.rebuild()
    return m


def test_rebuild_recomputes_from_scratch() -> None:
    m = _model()
    _named(m, "Pump")
    _named(m, "Valve")
    snapshot = {t: set(ids) for t, ids in m.indexes.search_postings.items()}
    trig_snapshot = dict(m.indexes._trigrams_of)
    m.indexes.rebuild()
    # rebuild() drops the search index (bulk-load semantics) ...
    assert m.indexes.search_ready is False
    assert m.indexes.search_postings == {}
    assert m.indexes._trigrams_of == {}
    # ... and a synchronous full build restores it exactly
    m.indexes.build_search_index()
    assert m.indexes.search_ready is True
    assert {t: set(ids) for t, ids in m.indexes.search_postings.items()} == snapshot
    assert m.indexes._trigrams_of == trig_snapshot


def test_fresh_index_is_ready_and_hooks_keep_it_complete() -> None:
    m = _model()
    assert m.indexes.search_ready is True  # an empty model's empty index is complete
    a = _named(m, "Pump")
    assert m.indexes.search_candidates("pump") == {a.id}
    m.indexes.verify_consistent()


def test_rebuild_keep_search_preserves_the_index() -> None:
    m = _model()
    a = _named(m, "Pump")
    postings = {t: set(ids) for t, ids in m.indexes.search_postings.items()}
    m.indexes.rebuild(keep_search=True)
    assert m.indexes.search_ready is True
    assert {t: set(ids) for t, ids in m.indexes.search_postings.items()} == postings
    assert m.indexes.search_candidates("pump") == {a.id}
    m.indexes.verify_consistent()


def test_candidates_none_until_ready_then_exact() -> None:
    m = _bulk_loaded(["Pump", "Valve"])
    assert m.indexes.search_ready is False
    assert m.indexes.search_candidates("pump") is None  # scan fallback
    m.indexes.build_search_index()
    assert m.indexes.search_candidates("pump") == {"bulk-0"}
    assert m.indexes.search_candidates("valve") == {"bulk-1"}
    m.indexes.verify_consistent()


def test_chunked_build_skips_hook_maintained_and_deleted_elements() -> None:
    """The background builder's contract: ids are snapshotted up front, then
    indexed chunk by chunk while the mutation hooks keep running. An element
    edited before its chunk lands already has its entry (skipped, not
    duplicated); a deleted one is absent from the model (skipped)."""
    m = _bulk_loaded(["Pump", "Valve", "Turbine"])
    ids = list(m.elements)  # snapshot, as the builder does
    # mutations BEFORE the build reaches them
    m.set_property(m.elements["bulk-0"], "name", "Compressor")
    m.delete_element("bulk-2")
    created = _named(m, "Boiler")  # hook-indexed, never in the snapshot
    m.indexes.index_search_chunk(ids[:2])
    m.indexes.index_search_chunk(ids[2:])
    m.indexes.mark_search_ready()
    assert m.indexes.search_candidates("compressor") == {"bulk-0"}
    assert m.indexes.search_candidates("pump") == frozenset()
    assert m.indexes.search_candidates("valve") == {"bulk-1"}
    assert m.indexes.search_candidates("turbine") == frozenset()
    assert m.indexes.search_candidates("boiler") == {created.id}
    m.indexes.verify_consistent()


def test_index_search_chunk_is_idempotent() -> None:
    m = _bulk_loaded(["Pump"])
    m.indexes.index_search_chunk(["bulk-0"])
    m.indexes.index_search_chunk(["bulk-0", "bulk-0", "missing"])
    assert _posting_ids(m, "pum") == {"bulk-0"}
    assert m.indexes._trigrams_of.keys() == {"bulk-0"}


def test_verify_consistent_tolerates_a_partial_index() -> None:
    m = _bulk_loaded(["Pump", "Valve"])
    m.indexes.index_search_chunk(["bulk-0"])  # half built, not ready
    m.indexes.verify_consistent()  # search structures excluded while not ready
    m.indexes.mark_search_ready()
    with pytest.raises(AssertionError, match="search_postings"):
        m.indexes.verify_consistent()  # ready but incomplete => caught
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -v`
Expected: the new tests FAIL (`AttributeError: 'IndexSet' object has no attribute 'search_ready'` / unexpected keyword `keep_search`); `test_rebuild_recomputes_from_scratch` fails on `search_ready`.

- [ ] **Step 3: Implement the split in `IndexSet`**

In `src/data_rover/core/model/indexes.py`:

(a) In `__init__`, right after the `self.search_postings` declaration (`:123`), add:

```python
        #: whether ``search_postings`` covers EVERY element, i.e. whether the
        #: candidate generator's superset guarantee holds. True on a fresh
        #: index (an empty model's empty index is complete); False after
        #: ``rebuild()`` until the search index is (re)built through
        #: ``index_search_chunk`` + ``mark_search_ready``. The mutation hooks
        #: maintain postings regardless of this flag — that is what lets a
        #: chunked background build interleave with live edits.
        self.search_ready: bool = True
```

(b) In `search_candidates`, replace the first guard:

```python
        if not self.search_ready or len(q) < 3:
            return None
```

and add to its docstring's `None` cases: "the index is not built yet (``search_ready`` is False)".

(c) Replace `rebuild` (`:327-370`) with:

```python
    def rebuild(self, *, keep_search: bool = False) -> None:
        """Recompute every index from the model dicts (bulk-load path).

        The search index is NOT built here: it is the dominant cost of a
        bulk load, and most callers never search (rebind views, previews,
        change-request copies, history reconstructions). By default it is
        reset and ``search_ready`` drops to False, so ``search_candidates``
        falls back to the scan until ``build_search_index`` or the chunked
        builder restores it. ``keep_search=True`` leaves the search
        structures untouched — legal only when the entity dicts are
        unchanged since the index was last consistent (the metamodel-rebind
        case: the indexed text does not depend on the metamodel).

        The per-type metamodel caches are always cleared: a rebind swaps
        ``model.metamodel`` and rebuilds this same instance, so containment
        flags, key specs and reference-property lists must be re-derived.
        """
        self.out_rels.clear()
        self.in_rels.clear()
        self.out_count.clear()
        self.in_count.clear()
        self.elements_by_type.clear()
        self.containment_parents.clear()
        self._containment_rel_ids.clear()
        self.ref_targets.clear()
        self.uniq_groups.clear()
        self.uniq_key_of.clear()
        self.duplicate_keys.clear()
        self.roots_order.clear()
        self._root_key_of.clear()
        self._refs_of.clear()
        self._element_ref_props.clear()
        self._relationship_ref_props.clear()
        self._key_specs.clear()
        self._is_containment.clear()
        self._out_key_rel_types = None
        self._in_key_rel_types = None
        if not keep_search:
            self.search_postings.clear()
            self._trigrams_of.clear()
            self._canon_trigrams.clear()
            self.search_ready = False

        # relationships first so containment parents are known before grouping
        for rel in self._model.relationships.values():
            self.out_rels.setdefault(rel.source_id, set()).add(rel.id)
            self.in_rels.setdefault(rel.target_id, set()).add(rel.id)
            self.out_count[(rel.source_id, rel.type_name)] += 1
            self.in_count[(rel.target_id, rel.type_name)] += 1
            self._add_refs(rel.id, self._relationship_refs(rel))
            if self._containment(rel.type_name):
                self.containment_parents.setdefault(rel.target_id, []).append(
                    rel.source_id
                )
                self._containment_rel_ids.setdefault(rel.target_id, []).append(rel.id)
        for element in self._model.elements.values():
            self.elements_by_type.setdefault(element.type_name, set()).add(element.id)
            self._add_to_group(element)
            self._add_refs(element.id, self._element_refs(element))
            if element.id not in self.containment_parents:
                self._root_key_of[element.id] = (display_name(element), element.id)
        # bulk-construct in one O(n log n) pass instead of n incremental adds
        self.roots_order = SortedPairs(self._root_key_of.values())

    # -- search index build --------------------------------------------------

    def index_search_chunk(self, element_ids: Iterable[str]) -> None:
        """Add postings for the given elements that are not indexed yet.

        Skips ids no longer in the model and ids already present in
        ``_trigrams_of`` (an element the mutation hooks indexed after the
        caller snapshotted its id list), so a chunked build that interleaves
        with live edits converges on exactly what a full build produces.
        """
        elements = self._model.elements
        trigrams_of = self._trigrams_of
        postings = self.search_postings
        for eid in element_ids:
            if eid in trigrams_of:
                continue
            element = elements.get(eid)
            if element is None:
                continue
            trigs = self._element_trigrams(element)
            if not trigs:
                continue
            trigrams_of[eid] = tuple(sorted(trigs))
            for t in trigs:
                postings.setdefault(t, set()).add(eid)

    def mark_search_ready(self) -> None:
        """Declare the search index complete (``search_candidates`` starts
        answering). Call only once every element has been indexed."""
        self.search_ready = True

    def build_search_index(self) -> None:
        """Synchronous full build: index every element, then mark ready."""
        self.index_search_chunk(self._model.elements)
        self.mark_search_ready()
```

`Iterable` is already imported from `collections.abc`? Check line 35: it imports `Hashable, Iterator, Set, Sequence` — add `Iterable`.

(d) In `verify_consistent`, build the fresh copy and pick the compared names based on readiness:

```python
        fresh = IndexSet(self._model)
        fresh.rebuild()
        if self.search_ready:
            fresh.build_search_index()
        search_names = ("search_postings", "_trigrams_of") if self.search_ready else ()
```

and change the `for name in (...)` tuple to end with `"_refs_of", *search_names,` (remove the two literal search entries). Keep everything else.

- [ ] **Step 4: Run the search-index tests**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -v`
Expected: all PASS.

- [ ] **Step 5: Run the whole model test package**

Run: `pixi run -e core-dev pytest tests/model -q`
Expected: PASS. (`tests/model/test_indexes.py`, `test_roots_order.py`, `test_model_restore.py` build through the hooks, so `search_ready` stays True and `verify_consistent` still compares the search structures.)

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/model/indexes.py tests/model/test_search_index.py
git commit -m "perf(index): take the trigram search index out of IndexSet.rebuild()"
```

---

### Task 2: Rebind call sites keep the search index; stale-cache regression tests

**Files:**
- Modify: `src/data_rover/api/metamodel_ops.py:186`
- Modify: `src/data_rover/api/routes/commits.py:460`, `:595`, `:644`
- Test: `tests/model/test_rebind_view.py` (append), `tests/api/test_commits_metamodel_ops.py` (append)

**Interfaces:**
- Consumes: `IndexSet.rebuild(keep_search=True)`, `IndexSet.search_ready`, `IndexSet.search_candidates` from Task 1.

- [ ] **Step 1: Write the failing model-level test for the stale per-type caches**

Append to `tests/model/test_rebind_view.py` (the file defines `_MM_A` with `Contains` as containment, `_MM_B` with `containment: false`, and `_model_with_contains()` returning `(model, a_id, b_id)`):

```python
def test_rebuild_after_metamodel_swap_rederives_containment() -> None:
    """A rebind swaps ``model.metamodel`` and rebuilds the SAME IndexSet: the
    per-type caches (containment flags, key specs, reference props) must be
    re-derived, or the containment tree, roots order and uniqueness groups
    keep reflecting the outgoing schema."""
    m, a, b = _model_with_contains()
    assert m.indexes.parents_of(b) == [a]
    m.metamodel = load_metamodel_str(_MM_B)
    m.indexes.rebuild(keep_search=True)
    assert m.indexes.parents_of(b) == ()
    assert set(m.indexes.iter_roots()) == {a, b}
    m.indexes.verify_consistent()
```

- [ ] **Step 2: Run it**

Run: `pixi run -e core-dev pytest tests/model/test_rebind_view.py -v`
Expected: PASS already (Task 1's `rebuild` clears the caches). If it FAILS on `parents_of(b) == ()`, Task 1's cache-clearing lines are missing — fix there before continuing.

- [ ] **Step 3: Write the failing API test — a rebind preview must not drop the live index**

Append to `tests/api/test_commits_metamodel_ops.py` (helpers `client`, `_rev`, `_create_node`, `MM_V4` exist there; `get_session` is imported):

```python
def test_rebind_preview_and_commit_keep_the_search_index(client: TestClient) -> None:
    """The search index is metamodel-independent, so the rebind paths rebuild
    with ``keep_search=True``: after a preview (swap + restore = two
    rebuilds) and after a real rebind commit the live index is still ready
    and still answers — no scan fallback, no background rebuild."""
    from data_rover.api.session import get_session

    eid = _create_node(client, "turbine hall")
    session = get_session()
    assert session.model is not None
    idx = session.model.indexes
    assert idx.search_ready is True
    assert idx.search_candidates("turbine") == {eid}

    r = client.post(
        papi("/commits/preview"),
        json={"base_rev": _rev(client), "ops": [{"kind": "metamodel.rebind", "blob": MM_V4}]},
    )
    assert r.status_code == 200, r.text
    assert idx.search_ready is True
    assert idx.search_candidates("turbine") == {eid}

    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V4}],
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert session.model is not None and session.model.indexes is idx
    assert idx.search_ready is True
    assert idx.search_candidates("turbine") == {eid}
    r = client.get(papi("/model/elements"), params={"q": "turbine"})
    assert [e["id"] for e in r.json()["items"]] == [eid]
```

(`"lock_tokens": [token]` is the shape the file's other rebind-commit tests use — see `:225`, `:243`.)

- [ ] **Step 4: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commits_metamodel_ops.py -k keep_the_search_index -v`
Expected: FAIL on `assert idx.search_ready is True` after the preview (the plain `rebuild()` reset it).

- [ ] **Step 5: Pass `keep_search=True` at the four live-model rebind sites**

- `src/data_rover/api/metamodel_ops.py:186`: `model.indexes.rebuild(keep_search=True)  # mm-derived only; the search text is not`
- `src/data_rover/api/routes/commits.py:460` (unwind), `:595` (preview swap), `:644` (preview restore): same call.

Do **not** touch `core/model/model.py::build_rebind_view`, `core/model/change_request.py:272`, `routes/_snapshot.py`, or `migration/legacy.py` — those are fresh `IndexSet`s on transient models and must stay search-less.

- [ ] **Step 6: Run the rebind test files**

Run: `pixi run -e core-dev pytest tests/api/test_commits_metamodel_ops.py tests/api/test_metamodel_rebind.py tests/api/test_metamodel_diff.py tests/model/test_rebind_view.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/metamodel_ops.py src/data_rover/api/routes/commits.py tests/model/test_rebind_view.py tests/api/test_commits_metamodel_ops.py
git commit -m "fix(index): rebind rebuilds re-derive per-type caches and keep the search index"
```

---

### Task 3: Background builder `api/search_index_build.py` + setting + `Session` field

**Files:**
- Create: `src/data_rover/api/search_index_build.py`
- Modify: `src/data_rover/api/settings.py:126-130` (next to `validation_sweep_sync`)
- Modify: `src/data_rover/api/session.py:125` (field) and `:389`, `:425` (evict/discard cancel)
- Modify: `tests/api/conftest.py:18` (pin the sync env var)
- Test: `tests/api/test_search_index_build.py` (new)

**Interfaces:**
- Produces:
  - `SearchIndexProgress` dataclass: `total: int = 0`, `done: int = 0`, `running: bool = True`, `cancel: threading.Event`, `error: bool = False`.
  - `start_search_index_build(session: Session, *, sync: bool | None = None) -> SearchIndexProgress` — no-op-complete when `session.model.indexes.search_ready` is already True; `sync=None` reads `settings.search_index_sync`.
  - `CHUNK_SIZE = 1000`.
  - `Session.search_index_build: SearchIndexProgress | None`.
  - `Settings.search_index_sync: bool = False` (`DATA_ROVER_SEARCH_INDEX_SYNC`).

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_search_index_build.py`:

```python
"""Chunked background build of the trigram search index (the search-side
sibling of validation_sweep). Sync mode is what the API suite runs under
(conftest pins it); these tests exercise both modes, chunk interleaving with
live edits, and the abort-on-model-replace guard."""

from __future__ import annotations

import time

import pytest

from data_rover.api import search_index_build
from data_rover.api.search_index_build import start_search_index_build
from data_rover.api.session import Session
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
"""


def _bulk_session(n: int) -> Session:
    metamodel = load_metamodel_str(MM)
    model = Model(metamodel)
    for i in range(n):
        model.elements[f"e{i}"] = Element(
            id=f"e{i}", type_name="Item", properties={"name": f"pump {i}"}
        )
    model.indexes.rebuild()  # bulk-load path: search index reset, not ready
    return Session(metamodel=metamodel, model=model)


def test_sync_build_completes_and_answers() -> None:
    session = _bulk_session(10)
    assert session.model is not None
    assert session.model.indexes.search_candidates("pump") is None
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert (progress.done, progress.total) == (10, 10)
    assert session.model.indexes.search_ready is True
    assert session.model.indexes.search_candidates("pump") == {f"e{i}" for i in range(10)}
    session.model.indexes.verify_consistent()


def test_async_build_completes() -> None:
    session = _bulk_session(50)
    progress = start_search_index_build(session, sync=False)
    deadline = time.monotonic() + 10.0
    while progress.running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert progress.running is False
    assert session.model is not None
    assert session.model.indexes.search_ready is True
    session.model.indexes.verify_consistent()


def test_multi_chunk_build_skips_edited_and_deleted(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force several chunks and mutate between them through the hooks: the
    builder must skip what the hooks already indexed and what no longer
    exists, converging on a verify_consistent-clean index."""
    monkeypatch.setattr(search_index_build, "CHUNK_SIZE", 3)
    session = _bulk_session(8)
    model = session.model
    assert model is not None
    calls = 0
    orig = model.indexes.index_search_chunk

    def spy(ids):
        nonlocal calls
        calls += 1
        if calls == 1:
            # mutations landing AFTER the id snapshot, BEFORE later chunks
            model.set_property(model.elements["e7"], "name", "valve 7")
            model.delete_element("e6")
            model.set_property(model.create_element("Item"), "name", "boiler")
        orig(ids)

    monkeypatch.setattr(model.indexes, "index_search_chunk", spy)
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert calls == 3  # 3 + 3 + 2
    assert model.indexes.search_candidates("valve") == {"e7"}
    assert model.indexes.search_candidates("boiler") is not None
    assert "e6" not in (model.indexes.search_candidates("pump") or set())
    model.indexes.verify_consistent()


def test_build_aborts_when_model_is_replaced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(search_index_build, "CHUNK_SIZE", 2)
    session = _bulk_session(6)
    old = session.model
    assert old is not None
    calls = 0
    orig = old.indexes.index_search_chunk

    def spy(ids):
        nonlocal calls
        calls += 1
        orig(ids)
        if calls == 1:
            assert session.metamodel is not None
            session.set_model(Model(session.metamodel))

    monkeypatch.setattr(old.indexes, "index_search_chunk", spy)
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert calls == 1  # aborted at the next chunk's identity check
    assert old.indexes.search_ready is False  # never marked ready
    assert progress.done < progress.total


def test_already_ready_index_is_a_noop() -> None:
    metamodel = load_metamodel_str(MM)
    session = Session(metamodel=metamodel, model=Model(metamodel))
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert session.model is not None and session.model.indexes.search_ready is True


def test_session_field_and_cancel() -> None:
    session = _bulk_session(3)
    progress = start_search_index_build(session, sync=True)
    assert session.search_index_build is progress
    progress.cancel.set()  # cancel is a plain Event the evict path sets
    assert progress.cancel.is_set()
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_search_index_build.py -v`
Expected: FAIL with `ModuleNotFoundError: data_rover.api.search_index_build`.

- [ ] **Step 3: Add the setting**

In `src/data_rover/api/settings.py`, directly after `validation_sweep_sync: bool = False` (`:130`):

```python
    #: Run the background trigram search-index build synchronously on the
    #: load/upload/hydrate paths. False in production (a daemon thread
    #: indexes in chunks while search falls back to the scan); the API test
    #: conftest pins it true so every test sees a complete index after load.
    search_index_sync: bool = False
```

- [ ] **Step 4: Add the `Session` field and evict cancel**

In `src/data_rover/api/session.py`:
- Add to the `TYPE_CHECKING` import block: `from .search_index_build import SearchIndexProgress`.
- After the `validation_sweep` field (`:125`):

```python
    #: progress of the in-flight background search-index build
    #: (search_index_build.start_search_index_build); stays set after
    #: completion. Never blocks eviction — the snapshot does not depend on
    #: it — so ``evict``/``discard`` cancel it instead.
    search_index_build: SearchIndexProgress | None = field(default=None, repr=False)
```

- In `evict` (after `session.script_sweeps.cancel_all()` at `:389`) and `discard` (`:425`), add:

```python
            if session.search_index_build is not None:
                session.search_index_build.cancel.set()
```

- [ ] **Step 5: Create the builder module**

Create `src/data_rover/api/search_index_build.py`:

```python
"""Chunked background build of the trigram search index.

The bulk-load path (``build_model_from_dicts`` -> ``IndexSet.rebuild``)
leaves ``search_ready`` False: building the index inline is the dominant
cost of a cold open, and ``search_candidates`` already falls back to a
byte-identical scan while it is absent. This module builds it AFTER the
session is serving, the way ``validation_sweep`` fills the issue store:
snapshot the element ids, then index ``CHUNK_SIZE`` of them per
``session.write_mutex`` acquisition so an ops batch never waits for more
than one chunk.

Correctness with concurrent edits: the IndexSet mutation hooks maintain
postings regardless of readiness, and ``index_search_chunk`` skips ids the
hooks already indexed or the model no longer holds, so the interleaving
converges on exactly what a synchronous full build produces. Readiness is
declared under the mutex only after the last chunk, and only if the session
still holds the model the build started on.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

from data_rover.core.model.model import Model

from .session import Session
from .settings import get_settings

logger = logging.getLogger(__name__)

#: elements indexed per write_mutex acquisition (~70 ms at production
#: string sizes; a waiting ops batch is delayed by at most one chunk)
CHUNK_SIZE = 1000


@dataclass
class SearchIndexProgress:
    total: int = 0
    done: int = 0
    running: bool = True
    cancel: threading.Event = field(default_factory=threading.Event)
    #: set if the build died on an unexpected exception (logged)
    error: bool = False


def start_search_index_build(
    session: Session, *, sync: bool | None = None
) -> SearchIndexProgress:
    """Start (or, in sync mode, run to completion) the search-index build.

    A no-op that reports complete when the index is already ready (an empty
    model, or a rebind that rebuilt with ``keep_search=True``). ``sync=None``
    reads ``settings.search_index_sync``.
    """
    model = session.model
    assert model is not None, "start_search_index_build requires a loaded model"
    progress = SearchIndexProgress()
    session.search_index_build = progress
    if model.indexes.search_ready:
        progress.running = False
        return progress
    if sync if sync is not None else get_settings().search_index_sync:
        _run(session, model, progress)
    else:
        threading.Thread(
            target=_run,
            args=(session, model, progress),
            name="search-index-build",
            daemon=True,
        ).start()
    return progress


def _run(session: Session, model: Model, progress: SearchIndexProgress) -> None:
    try:
        # list(dict) is one C-level operation, atomic under the GIL
        ids = list(model.elements.keys())
        progress.total = len(ids)
        for start in range(0, len(ids), CHUNK_SIZE):
            chunk = ids[start : start + CHUNK_SIZE]
            with session.write_mutex:
                if session.model is not model or progress.cancel.is_set():
                    return
                model.indexes.index_search_chunk(chunk)
            progress.done = min(start + CHUNK_SIZE, len(ids))
        with session.write_mutex:
            if session.model is model and not progress.cancel.is_set():
                model.indexes.mark_search_ready()
    except Exception:
        logger.exception("search index build failed; search stays on the scan path")
        progress.error = True
    finally:
        progress.running = False
```

- [ ] **Step 6: Pin sync mode in the API conftest**

In `tests/api/conftest.py`, after line 18 (`DATA_ROVER_VALIDATION_SWEEP_SYNC`):

```python
os.environ.setdefault("DATA_ROVER_SEARCH_INDEX_SYNC", "true")
```

- [ ] **Step 7: Run the builder tests**

Run: `pixi run -e core-dev pytest tests/api/test_search_index_build.py -v`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/search_index_build.py src/data_rover/api/settings.py src/data_rover/api/session.py tests/api/conftest.py tests/api/test_search_index_build.py
git commit -m "feat(api): chunked background build of the trigram search index"
```

---

### Task 4: Kick the build from hydration and the model-install routes

**Files:**
- Modify: `src/data_rover/api/hydration.py:259-268` (`_hydrate_session` tail)
- Modify: `src/data_rover/api/routes/model.py:104-121` (`upload_model`), `:139-155` (`snapshot_model`), `:172-204` (`_install_model`)
- Test: `tests/api/test_hydration.py` (append), `tests/api/test_search_parity.py` (one assertion), `tests/api/test_read_routes.py` (append)

**Interfaces:**
- Consumes: `start_search_index_build(session)` from Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_hydration.py` (fixtures `_env`, `_seed_baseline` exist; `hydration` and `db`/`content` are imported):

```python
def test_hydrate_builds_the_search_index() -> None:
    """Hydration rebuilds from a snapshot (search index reset) and must kick
    the builder; under the conftest's sync pin the index is complete by the
    time the session is returned."""
    from data_rover.core.model.element import Element

    sess = _seed_baseline()
    assert sess.model is not None
    sess.model.elements["x1"] = Element(
        id="x1", type_name=_first_concrete_element_type(sess), properties={"name": "turbine"}
    )
    sess.model.indexes.rebuild()
    hydration.persist_baseline("p1", sess, author_id=None)
    h = hydration.hydrate_session("p1")
    assert h.model is not None
    assert h.search_index_build is not None and h.search_index_build.running is False
    assert h.model.indexes.search_ready is True
    assert h.model.indexes.search_candidates("turbine") == {"x1"}
```

(`_first_concrete_element_type` is defined further down in that file — confirm the name with `grep -n "_first_concrete" tests/api/test_hydration.py` and reuse it.)

In `tests/api/test_search_parity.py::test_index_search_matches_reference_scan`, right after `model = get_session().model` / `assert model is not None` (`:125-126`), add:

```python
    # the deprecated POST /model installer kicks the (sync-pinned) build too:
    # without a ready index this parity test would be vacuous (scan vs scan)
    assert model.indexes.search_ready is True
```

Append to `tests/api/test_read_routes.py` (its `client` fixture installs the metamodel only; `_load_model(client, elements, relationships)` loads a model and `_item(eid, name)` builds an `Item` dict — both defined near `:66-80`):

```python
def test_search_scan_fallback_while_index_not_ready(client: TestClient) -> None:
    """With the index unbuilt (as during a real cold open) the q-branch scans
    and returns exactly what the index path returns once the build lands."""
    from data_rover.api.search_index_build import start_search_index_build
    from data_rover.api.session import get_session

    _load_model(client, [_item("a", "Pump alpha"), _item("b", "Pump beta"), _item("c", "Valve")], [])
    session = get_session()
    assert session.model is not None
    idx = session.model.indexes
    assert idx.search_ready is True  # the sync-pinned build already ran
    idx.rebuild()  # bulk-load semantics: drops the index, not ready
    assert idx.search_ready is False
    scanned = client.get(papi("/model/elements"), params={"q": "pum"}).json()
    start_search_index_build(session, sync=True)
    assert idx.search_ready is True
    indexed = client.get(papi("/model/elements"), params={"q": "pum"}).json()
    assert scanned == indexed
    assert [e["id"] for e in indexed["items"]] == ["a", "b"]
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_hydration.py -k search_index tests/api/test_search_parity.py tests/api/test_read_routes.py -k fallback -v`
Expected: the hydration and parity assertions FAIL on `search_ready` (nothing kicks the build yet); the read-route test may already pass (it starts the build itself) — that is fine.

- [ ] **Step 3: Kick the build at the four install sites**

`src/data_rover/api/hydration.py`: add `from .search_index_build import start_search_index_build` next to the `validation_sweep` import, and after `start_validation_sweep(session)` (`:267`):

```python
    start_search_index_build(session)
```

`src/data_rover/api/routes/model.py`: import `start_search_index_build` from `..search_index_build`; in `_install_model` after `start_validation_sweep(session)` (`:203`), and in `upload_model` (`:120`) and `snapshot_model` (`:154`) right after `session.set_model(model)`:

```python
    start_search_index_build(session)
```

Extend `_install_model`'s docstring with one sentence: "The trigram search index is built the same way — in the background, search scanning until it lands."

- [ ] **Step 4: Run the four test files**

Run: `pixi run -e core-dev pytest tests/api/test_hydration.py tests/api/test_search_parity.py tests/api/test_read_routes.py tests/api/test_perf_probe.py -q`
Expected: PASS.

- [ ] **Step 5: Run the whole backend suite**

Run: `pixi run core-test`
Expected: PASS. If a test that installs a model through a path not listed above asserts on `search_candidates`/`search_postings`, it now sees an unbuilt index — add the kick at that install site rather than in the test.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/hydration.py src/data_rover/api/routes/model.py tests/api/test_hydration.py tests/api/test_search_parity.py tests/api/test_read_routes.py
git commit -m "perf(api): build the search index in the background after load and hydration"
```

---

### Task 5: Bench, docs and backlog

**Files:**
- Modify: `scripts/bench.py:56-96` (`bench_load`)
- Modify: `CLAUDE.md:82` (the "Reads are paged/on-demand" bullet)
- Modify: `src/data_rover/core/model/indexes.py:1-29` (module docstring, trigram paragraph)
- Modify: `BACKLOG.md` (K-6 at `:805`; new items after K-19 at `:996`; header "Last updated" line `:29`)

- [ ] **Step 1: Bench reports the search build separately**

In `scripts/bench.py::bench_load`, after the `(1c)` timing block:

```python
    t0 = time.perf_counter()
    model.indexes.build_search_index()
    t_search = time.perf_counter() - t0
```

and in the report lines:

```python
    _report("(1c) NEW direct build_model_from_dicts (no search index)", t_build_direct)
    _report("(1d) trigram search index build (background in the app)", t_search)
    _report("(1)  load + build total (json.load + direct build)",
            t_parse + t_build_direct)
```

Run: `pixi run -e core-dev python scripts/bench.py --model benchmarks/large.model.json --metamodel examples/smart-city.metamodel.yaml --skip-validation`
Expected: `(1c)` well under half of the pre-change 16.9 s (measured 2026-08-26 on this machine at 170k elements); `(1d)` carries the remainder. Record both numbers for the commit message.

- [ ] **Step 2: Docs**

`CLAUDE.md:82` — replace the sentence starting "Fuzzy element search (`GET /model/elements?q=`) draws candidates from the trigram index" with:

> Fuzzy element search (`GET /model/elements?q=`) draws candidates from the trigram index (`IndexSet.search_postings` / `search_candidates`, maintained at the mutation boundary like `roots_order`). The index is **not** built by `IndexSet.rebuild()` — it is the dominant cost of a bulk load and most `rebuild()` callers (rebind views/previews, apply-cr copies, history reconstructions) never search — so a bulk-loaded model starts with `search_ready=False` and `search_candidates` returns `None`, which is the scan fallback; `api/search_index_build.py` fills the live session's index in chunks under `write_mutex` after load/hydrate (`DATA_ROVER_SEARCH_INDEX_SYNC=true` in tests), and the rebind paths rebuild with `keep_search=True` because the indexed text is metamodel-independent. Queries under 3 chars — or so common the index cannot beat a scan — fall back to the scan too, and results are byte-identical to a full scan either way.

`src/data_rover/core/model/indexes.py` module docstring: in the trigram paragraph (`:19-24`) add: "It is deliberately NOT built by ``rebuild()`` (see that method) — ``search_ready`` says whether it covers every element, and ``index_search_chunk``/``build_search_index`` (re)build it."

- [ ] **Step 3: BACKLOG entries**

In `BACKLOG.md`:

(a) Replace the K-6 heading `### K-6 · History diff is slow on a big model · \`open\` · owner-reported · *2026-08-12*` with the same heading plus, as the first paragraph of its body, the measurement:

> Measured 2026-08-26 on a 320k-element fixture (212 MiB snapshot): each `reconstruct_model_at` is a full snapshot download + `json.loads` (3 s) + `build_model_from_dicts` (~8 s after K-20, ~30 s before) — **two per diff click**, plus ~2 × 1 GB transient RSS. Next in the large-model performance program after K-20 (see K-21 → K-25 for the rest of the program and its order).

(b) After the K-19 item (before `## 7. Cleanups & dead code`), add:

```markdown
### K-20 · The trigram search index was built inline by `IndexSet.rebuild()` · `done` (2026-08-26, perf/deferred-search-index) · perf · *2026-08-26*
Measured on a 320k-element / 239k-relationship fixture (212 MiB snapshot — production
size): `build_model_from_dicts` 30.0 s of which the trigram index 22.5 s, index RSS +1.78 GB
of which the trigram postings ~1.5 GB (29.5M posting entries; production uuid7 ids add ~28
per element). The index was also rebuilt — and discarded — by every `rebuild()` caller that
never searches: rebind preview (twice, under `write_mutex`), rebind commit (+unwind),
`/metamodel/diff`, apply-cr per CR, history reconstruction. Fixed: `rebuild()` no longer
builds it (`search_ready=False`, scan fallback), `api/search_index_build.py` builds the live
session's index in the background, rebind paths keep it via `rebuild(keep_search=True)`.
Same branch fixed a latent bug: `rebuild()` never cleared its per-type metamodel caches, so
a containment- or key-flipping rebind left the containment tree, roots order and uniqueness
groups stale until eviction. NOT done (deliberate): shrinking the posting sets — memory stays
~1.5 GB for the live session; revisit only if RSS binds after K-21.

### K-21 · Snapshots are stored indented and uncompressed · `open` · perf · *2026-08-26*
`write_snapshot` streams the indented save-file format to the store: 212 MiB at production
size, downloaded on every hydration and uploaded on every eviction and every 200th commit
(`_maybe_periodic_snapshot`, synchronously inside the commit under `write_mutex`: 3.8 s
serialize + upload). Measured gzip-6 → 10 MiB (+1.3 s); compact JSON alone 138 MiB and
`json.loads` 2.0 s vs 2.9 s indented. Store `.json.gz` compact, branch the read path on the
key/encoding. Then re-measure whether the periodic snapshot still needs to leave the commit's
critical section. Third in the large-model performance program (after K-6).

### K-22 · Uniqueness validator builds a whole-model position map per scoped run · `open` · perf · *2026-08-26*
`validators/uniqueness.py:56` builds `{eid: i for i, eid in enumerate(model.elements)}` —
96 ms at 320k — on every scoped run that touches a duplicate group, under `write_mutex`: up
to 350 × per background sweep (+34 s) and once per commit touching a duplicate. Maintain an
insertion-position index in `IndexSet` (or hoist the map onto the validator for a sweep's
lifetime). Fourth in the program.

### K-23 · `Model.set_property`/`delete_property` copy the property list and build a name set per write · `open` · perf · *2026-08-26*
`core/model/model.py:82-85`, `:105-108` and `routes/ops.py::_check_patch_keys` do
`list(effective_*_properties)` + `{p.name for p in defs}` per property write; the replay tail
at hydration (≤200 commits) and every commit pay it per op property, and
`on_properties_changed` re-derives the element's whole trigram set per write. Add a cached
`frozenset` name accessor on `Metamodel`. Fifth in the program.

### K-24 · Untyped navigation scope sorts every element id · `open` · perf · *2026-08-26*
`core/navigation/evaluate.py:244-245`: `set(model.elements.keys())` + criteria filter +
`sorted()` of ~300k ids for a table/navigation with no `types`, on the first table request
after every commit (`TableOrderCache` is rev-keyed). Sixth in the program.

### K-25 · `GET /model/relationships` is unpaged · `open` · perf · *2026-08-26*
`routes/relationships.py:19` materializes all ~400k relationships into pydantic models with
no `limit`/`offset`; `source_id`/`target_id` filters are already served by
`IndexSet.outgoing_ids`/`incoming_ids`. No app caller (`frontend/src/lib/api/relationships.ts`
is test-only). Page it or delete it. Last in the program.
```

(c) Update the header line `Last updated: 2026-08-26 · repo head at time of writing: ...` to name this branch's head after the final commit, and mention "K-20 done; K-21 → K-25 added as the large-model performance program".

- [ ] **Step 4: Commit**

```bash
git add scripts/bench.py CLAUDE.md src/data_rover/core/model/indexes.py BACKLOG.md
git commit -m "docs: deferred search index — bench split, CLAUDE.md, backlog program (K-20, K-21..K-25)"
```

---

### Task 6: Full verification, measurement, and integration

**Files:** none new.

- [ ] **Step 1: Lint/format/typecheck**

Run: `pixi run dr-tidy`
Expected: ruff, mypy and pyright all pass. Fix anything reported (typical: `Iterable` import in `indexes.py`, the `TYPE_CHECKING` import in `session.py`) and amend into the relevant commit or add a `chore:` commit.

- [ ] **Step 2: Whole backend suite**

Run: `pixi run core-test`
Expected: PASS, zero skips introduced.

- [ ] **Step 3: Measure the win on the 320k fixture**

Regenerate the production-scale fixture (it lives in the session scratchpad, not the repo) and time the real hydration path:

```bash
pixi run -e core-dev python examples/generate_large_model.py --scale 320 --out /tmp/prod.model.json
pixi run -e core-dev python - <<'EOF'
import json, sys, time
sys.path.insert(0, "src")
from data_rover.core.metamodel.loader import load_metamodel_file
from data_rover.api.routes._snapshot import build_model_from_dicts
mm = load_metamodel_file("examples/smart-city.metamodel.yaml")
raw = json.loads(open("/tmp/prod.model.json", "rb").read())
t0 = time.perf_counter(); model = build_model_from_dicts(mm, raw, strict=False)
print(f"build (no search index): {time.perf_counter()-t0:.1f}s  ready={model.indexes.search_ready}")
t0 = time.perf_counter(); model.indexes.build_search_index()
print(f"search index build: {time.perf_counter()-t0:.1f}s")
EOF
```

Expected: build ≈ 7–8 s (was 30.0 s), search index ≈ 22 s, sum ≈ the old total (no work moved into the hooks). Put the two numbers in the merge commit message.

- [ ] **Step 4: Integrate**

Use `superpowers:finishing-a-development-branch`: merge `perf/deferred-search-index` into `main` with a merge commit (repo convention), push if the owner's standing instruction allows (BACKLOG: "pushing to origin is no longer deferred"), and remove the worktree.

---

### Task 7: Hand off to the next plan (K-6 — journal-only history diff)

**Files:** none in the repo (the handoff lives in `~/.claude/handoffs/`).

- [ ] **Step 1: Reconstruct state**

Run: `git status --short && git branch --show-current && git log --oneline -5 && pixi run core-test -q | tail -3`

- [ ] **Step 2: Invoke the handoff skill**

Invoke `handoff` (the `Skill` tool, name `handoff`). Fill its sections with these facts (pointers, not payload):

- **Mission:** the large-model performance program from `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program"); K-20 is merged; the next session writes and executes the plan for **K-6** (journal-only `GET /commits/{rev}/diff`), then hands off to K-21, and so on down the program list — every plan's last task is this same handoff step.
- **Orient First:** the spec above; `BACKLOG.md` items K-6 and K-21 → K-25 (the program with measurements); `src/data_rover/api/commit_diff.py:436-507` (`diff_commit`, the two `reconstruct_model_at` calls); `src/data_rover/api/hydration.py:133-186` (`reconstruct_model_at`); `src/data_rover/api/routes/commits.py` `_persist_commit` (where the touched entities' before-state can be captured at commit time — the live model is right there) and the `Commit` row in `src/data_rover/api/db_models.py` + `alembic/` (a new nullable column needs a migration; `NULL` = fall back to reconstruction for old rows); `tests/api/test_change_request_diff.py` and the commit-diff tests (`grep -rn "commits/.*diff" tests/api`).
- **Standing Constraints:** `rebuild()` never builds the search index and rebind sites pass `keep_search=True` (K-20 — do not "fix" a missing index on a transient model by building one); the `modified` half of the diff renders full `ElementOut` before/after, and the journal's inverse `properties_patch` only carries touched keys — that is why before-state must be persisted at commit time rather than derived; `docs/` is gitignored; pixi for everything; merge-commit integration.
- **Plan:** 1. `superpowers:writing-plans` for K-6 with the design: persist per-commit `touched` before/after entity state (`Commit.entity_states` JSON or a sibling table, populated in `_persist_commit` from the applied batch's touched ids, capped like K-8/K-17 discuss), render `diff_commit`'s model half journal-only when present, reconstruction fallback when `NULL`, Alembic migration, tests for both paths; last task = this handoff to K-21. 2. Execute it with `superpowers:subagent-driven-development`.
- **Open Questions:** whether `GET /commits/{rev}/model` (whole model at a rev, used by the client-side compare) stays reconstruction-based (it is inherently O(model)) — recommend yes, out of K-6's scope.

- [ ] **Step 3: Deliver**

Reply exactly as the handoff skill prescribes: the file path, the one-line paste command, and the full handoff in one fenced block.
