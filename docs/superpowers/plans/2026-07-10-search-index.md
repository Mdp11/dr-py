# Fuzzy-Search Trigram Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the O(n)-per-keystroke fuzzy element search scan with a trigram candidate index maintained incrementally in `IndexSet`, with byte-identical results.

**Architecture:** `IndexSet` (the single choke-point for secondary indexes, `src/data_rover/core/model/indexes.py`) gains `search_postings` (trigram → element-id set) and `_trigrams_of` (element id → its trigram set), maintained by the existing mutation hooks (no new call sites in `Model`). A new accessor `search_candidates(q)` intersects posting sets to return a guaranteed **superset** of true hits; `GET /model/elements?q=` iterates candidates instead of the whole model, and the existing `_search_score` check remains the sole arbiter of matching and order. Queries shorter than 3 chars fall back to the scan.

**Tech Stack:** Python 3.14 runtime / 3.10 check floor, FastAPI, pytest via pixi (`core-dev` env). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-search-index-design.md` (gitignored, local).

## Global Constraints

- Everything runs through pixi: `pixi run -e core-dev pytest ...`; lint via `pixi run lint-core` / `pixi run lint-backend`; full sweep `pixi run tidy` (ruff + mypy + pyright must all pass).
- pyright floor is Python **3.10** — no stdlib features newer than 3.10 (`typing_extensions` for `Self`/`assert_never`).
- No new `type: ignore` outside `src/data_rover/core/model/_sorted.py`.
- Index maintenance hooks must be **O(entity text)** per mutation — no whole-model work, no display-name style hidden costs.
- The `/model/elements` **insertion-order contract for non-search listing is untouched** (docstring + `test_elements_insertion_order_and_paging` assert it).
- Results with `q` must be **byte-identical** to the pre-index scan: items, order, `total`.
- All new structures must be SPARSE (empty sets/entries deleted), recomputed by `rebuild()`, and asserted by `verify_consistent()` — exactly like `roots_order`.
- Preserve the dense invariant-explaining docstring style of `indexes.py`.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `docs/superpowers/` is gitignored — never `git add` the spec/plan; commit only code/tests/CLAUDE.md.
- Work on branch `feat/search-index` off current `main` (2f0802c).

---

### Task 1: Branch + perf-probe search rows + baseline numbers

The probe rows must land and run **before** any index code exists so the spec gets honest pre-index numbers.

**Files:**
- Modify: `tests/api/test_perf_probe.py`
- Modify (local-only, no commit): `docs/superpowers/specs/2026-07-10-search-index-design.md` (Results section)

**Interfaces:**
- Produces: three timed probe rows (`fuzzy search, selective/degenerate/short`) that Task 6 re-runs for the "after" table.

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull && git checkout -b feat/search-index
```

- [ ] **Step 2: Add three search timing rows to the probe**

In `tests/api/test_perf_probe.py`, append to the end of `test_perf_probe` (after the `summary` row):

```python
    sel = f"{n // 2:07d}"  # zero-padded name fragment of exactly one element
    _timed_get(client, f"fuzzy search, selective (q={sel})", f"{API}/model/elements", {"q": sel, "limit": 50})
    _timed_get(client, "fuzzy search, degenerate (q=element)", f"{API}/model/elements", {"q": "element", "limit": 50})
    _timed_get(client, "fuzzy search, short fallback (q=el)", f"{API}/model/elements", {"q": "el", "limit": 50})
```

(`sel` matches only the name `Element {n//2:07d}` — names are zero-padded to 7 digits, ids `e{i}` are not, so exactly one element hits. `element` hits every element — the degenerate case. `el` is below the future index's 3-char floor — the fallback case.)

- [ ] **Step 3: Run the probe at 50k and record**

Run: `pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s`
Expected: PASS; three new rows printed with times (selective and degenerate both O(n)-scan today, expect same order of magnitude).

- [ ] **Step 4: Run the probe at 500k and record**

Run: `PERF_N=500000 pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s`
Expected: PASS (upload ~30 s, search rows likely hundreds of ms each).

- [ ] **Step 5: Record the baseline in the spec**

Append to the `## Results` section of `docs/superpowers/specs/2026-07-10-search-index-design.md`:

```markdown
### Baseline (pre-index, main @ 2f0802c)

| probe row                       | 50k (ms) | 500k (ms) |
|---------------------------------|----------|-----------|
| fuzzy search, selective         | <fill>   | <fill>    |
| fuzzy search, degenerate        | <fill>   | <fill>    |
| fuzzy search, short fallback    | <fill>   | <fill>    |
```

Fill `<fill>` with the printed numbers. Do NOT commit the spec (gitignored).

- [ ] **Step 6: Lint and commit the probe change only**

```bash
pixi run lint-backend
git add tests/api/test_perf_probe.py
git commit -m "test(perf): add fuzzy-search timing rows to the perf probe

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Trigram postings in IndexSet (structures + hooks + rebuild + verify)

One coherent unit: structures, extraction, the three hook extensions, `rebuild()`, and `verify_consistent()` registration must land together — registering the structures in `verify_consistent()` without the hooks would fail every existing mutation test.

**Files:**
- Modify: `src/data_rover/core/model/indexes.py`
- Test: `tests/model/test_search_index.py` (create)

**Interfaces:**
- Consumes: existing `IndexSet` hook entry points (`on_element_created`, `on_element_deleted`, `on_properties_changed`, `rebuild`, `verify_consistent`) — all already called from `Model`; no `Model` changes.
- Produces: `IndexSet.search_postings: dict[str, set[str]]` and `IndexSet._trigrams_of: dict[str, frozenset[str]]`, consistent after any mutation sequence. Task 3 builds `search_candidates` on top of `search_postings`.

- [ ] **Step 1: Write the failing tests**

Create `tests/model/test_search_index.py`:

```python
"""Trigram search-index maintenance: postings must track every mutation path
and always equal what a fresh rebuild() computes (verify_consistent).

Trigram keys asserted below ("pum", "coo", ...) contain non-hex letters, so
they can never collide with trigrams of UUIDv7 element ids (hex + dashes).
"""

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
      - {name: note, datatype: string}
      - {name: size, datatype: integer}
relationships:
  - name: Contains
    containment: true
    source: Item
    target: Item
"""


def _model() -> Model:
    return Model(load_metamodel_str(MM))


def _named(model: Model, name: str):
    el = model.create_element("Item")
    model.set_property(el, "name", name)
    return el


def _posting_ids(m: Model, trigram: str) -> set[str]:
    return m.indexes.search_postings.get(trigram, set())


def test_create_indexes_name_id_and_type() -> None:
    m = _model()
    el = _named(m, "Pump Alpha")
    assert el.id in _posting_ids(m, "pum")
    assert el.id in _posting_ids(m, "alp")
    assert el.id in _posting_ids(m, "ite")  # type name "item"
    assert el.id in _posting_ids(m, el.id[:3].lower())  # own id text
    m.indexes.verify_consistent()


def test_string_properties_indexed_non_strings_ignored() -> None:
    m = _model()
    el = _named(m, "Pump")
    m.set_property(el, "note", "cooling circuit")
    m.set_property(el, "size", 12345)
    assert el.id in _posting_ids(m, "coo")
    assert el.id not in _posting_ids(m, "123")  # int contributes nothing
    m.indexes.verify_consistent()


def test_rename_moves_postings_and_stays_sparse() -> None:
    m = _model()
    el = _named(m, "Pump")
    m.set_property(el, "name", "Valve")
    assert el.id in _posting_ids(m, "val")
    assert "pum" not in m.indexes.search_postings  # emptied set deleted
    m.indexes.verify_consistent()


def test_short_fields_contribute_nothing() -> None:
    m = _model()
    el = m.create_element("Item")
    before = m.indexes._trigrams_of[el.id]  # id + type trigrams only
    m.set_property(el, "name", "ab")  # < 3 chars: no trigrams
    assert m.indexes._trigrams_of[el.id] == before
    m.indexes.verify_consistent()


def test_delete_removes_all_postings() -> None:
    m = _model()
    el = _named(m, "Pump")
    keep = _named(m, "Pipe")
    m.delete_element(el.id)
    assert el.id not in m.indexes._trigrams_of
    assert all(el.id not in ids for ids in m.indexes.search_postings.values())
    assert all(ids for ids in m.indexes.search_postings.values())  # sparse
    assert keep.id in _posting_ids(m, "pip")
    m.indexes.verify_consistent()


def test_delete_restore_reindexes() -> None:
    m = _model()
    el = _named(m, "Pump")
    eid = el.id
    m.delete_element(eid)
    restored = m.restore_element(eid, "Item")
    m.set_property(restored, "name", "Pump")
    assert eid in _posting_ids(m, "pum")
    m.indexes.verify_consistent()


def test_direct_property_write_via_hook() -> None:
    """Direct writers of entity.properties must call on_properties_changed —
    the documented IndexSet obligation now also feeds search."""
    m = _model()
    el = _named(m, "Pump")
    el.properties["note"] = "turbine"
    m.indexes.on_properties_changed(el)
    assert el.id in _posting_ids(m, "tur")
    m.indexes.verify_consistent()


def test_rebuild_recomputes_from_scratch() -> None:
    m = _model()
    _named(m, "Pump")
    _named(m, "Valve")
    snapshot = {t: set(ids) for t, ids in m.indexes.search_postings.items()}
    trig_snapshot = dict(m.indexes._trigrams_of)
    m.indexes.rebuild()
    assert {t: set(ids) for t, ids in m.indexes.search_postings.items()} == snapshot
    assert m.indexes._trigrams_of == trig_snapshot


def test_mixed_mutation_sequence_stays_consistent() -> None:
    m = _model()
    a = _named(m, "Pump Station")
    b = _named(m, "Valve House")
    rel = m.connect("Contains", a.id, b.id)
    m.set_property(b, "note", "east grid")
    m.disconnect(rel.id)
    m.set_property(a, "name", "Compressor")
    m.delete_element(b.id)
    m.indexes.verify_consistent()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -q`
Expected: FAIL — `AttributeError: 'IndexSet' object has no attribute 'search_postings'`.

- [ ] **Step 3: Implement in `src/data_rover/core/model/indexes.py`**

3a. In `__init__`, after the `_root_key_of` block (around line 104), add:

```python
        #: lowercased trigram -> ids of elements whose searchable text
        #: contains it. The searchable text is exactly the fields the fuzzy
        #: element search scores (routes/read.py _search_score): the id, the
        #: type name, and every top-level string property value. Candidate
        #: index only: a query's true hits are always a SUBSET of the
        #: intersection of its trigrams' postings (see search_candidates).
        self.search_postings: dict[str, set[str]] = {}
        # element id -> its current merged trigram set (reverse map; needed
        # to diff on property change and to drop postings on delete — by hook
        # time the old text is gone — mirroring _refs_of). No entry when the
        # set would be empty (sparse).
        self._trigrams_of: dict[str, frozenset[str]] = {}
```

3b. Extend the three element hooks:

In `on_element_created`, after `self._roots_add(element)`:

```python
        self._update_trigrams(element.id, self._element_trigrams(element))
```

In `on_element_deleted`, after `self._roots_remove(element.id)`:

```python
        self._update_trigrams(element.id, frozenset())
```

In `on_properties_changed`, in the `Element` branch after `self._roots_reposition(entity)`:

```python
            self._update_trigrams(entity.id, self._element_trigrams(entity))
```

3c. In `rebuild()`: add to the clearing block:

```python
        self.search_postings.clear()
        self._trigrams_of.clear()
```

and in the element loop (alongside the `_root_key_of` population), an add-only fast path mirroring `_add_refs`:

```python
            trigs = self._element_trigrams(element)
            if trigs:
                self._trigrams_of[element.id] = trigs
                for t in trigs:
                    self.search_postings.setdefault(t, set()).add(element.id)
```

3d. In `verify_consistent()`, add to the compared-names tuple (after `"_refs_of"`):

```python
                "search_postings",
                "_trigrams_of",
```

3e. New internals section (before `# -- internals: counters`):

```python
    # -- internals: search trigrams -------------------------------------------

    @staticmethod
    def _element_trigrams(element: Element) -> frozenset[str]:
        """Merged lowercased trigram set of the element's searchable text —
        exactly the fields the fuzzy search scores: id, type name, and every
        top-level string property value. Fields shorter than 3 chars
        contribute nothing (they cannot contain a >=3-char query), and
        merging across fields is sound because candidates are score-verified
        by the caller (cross-field false positives are filtered there)."""
        trigs: set[str] = set()
        texts = [element.id, element.type_name]
        texts.extend(v for v in element.properties.values() if isinstance(v, str))
        for text in texts:
            s = text.lower()
            for i in range(len(s) - 2):
                trigs.add(s[i : i + 3])
        return frozenset(trigs)

    def _update_trigrams(self, element_id: str, new: frozenset[str]) -> None:
        """Diff-apply an element's trigram set (mirrors _update_refs).
        Posting sets hold references to the id strings the model dicts own —
        no string duplication; empty posting sets are deleted (sparse)."""
        old = self._trigrams_of.get(element_id) or frozenset()
        if new == old:
            return
        for t in old - new:
            ids = self.search_postings.get(t)
            if ids is not None:
                ids.discard(element_id)
                if not ids:
                    del self.search_postings[t]
        for t in new - old:
            self.search_postings.setdefault(t, set()).add(element_id)
        if new:
            self._trigrams_of[element_id] = new
        else:
            self._trigrams_of.pop(element_id, None)
```

3f. Extend the **module docstring**'s maintenance paragraph (the one describing `roots_order` obligations) with one sentence:

```
The trigram search index (``search_postings`` / ``_trigrams_of``) is
maintained at that same boundary with the same obligations; it feeds
``search_candidates`` (the fuzzy-search candidate generator) and, like the
reference index, is diffed on ``on_properties_changed``.
```

- [ ] **Step 4: Run the new tests**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -q`
Expected: PASS (all 9).

- [ ] **Step 5: Run the whole model + validation test areas (verify_consistent now covers the new structures everywhere)**

Run: `pixi run -e core-dev pytest tests/model tests/validation -q`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
pixi run lint-core
git add src/data_rover/core/model/indexes.py tests/model/test_search_index.py
git commit -m "feat(core): trigram search postings maintained at the mutation boundary

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `IndexSet.search_candidates` accessor

**Files:**
- Modify: `src/data_rover/core/model/indexes.py`
- Test: `tests/model/test_search_index.py` (extend)

**Interfaces:**
- Consumes: `search_postings` from Task 2.
- Produces: `search_candidates(q: str) -> Set[str] | None` (`Set` from `collections.abc`, already imported in indexes.py). `None` ⇔ `len(q) < 3` (caller must fall back to a scan); otherwise a superset of true fuzzy hits, possibly a live internal set (read-only convention). Task 4 calls this from the route.

- [ ] **Step 1: Write the failing tests**

Append to `tests/model/test_search_index.py`:

```python
def test_candidates_superset_with_cross_field_false_positive() -> None:
    m = _model()
    hit = _named(m, "Hydraulic Pump")
    fp = _named(m, "pumX")  # 'pum' in name ...
    m.set_property(fp, "note", "Yump")  # ... 'ump' in another field
    miss = _named(m, "Valve")
    cands = m.indexes.search_candidates("pump")
    assert cands is not None
    assert hit.id in cands  # a true hit always survives (superset guarantee)
    assert fp.id in cands  # cross-field FP allowed; the score check filters
    assert miss.id not in cands


def test_candidates_short_query_none_unknown_trigram_empty() -> None:
    m = _model()
    _named(m, "Pump")
    assert m.indexes.search_candidates("pu") is None
    assert m.indexes.search_candidates("") is None
    assert m.indexes.search_candidates("zzz") == frozenset()
    # one absent trigram kills the whole intersection
    assert m.indexes.search_candidates("pumzzz") == frozenset()


def test_candidates_single_trigram_query() -> None:
    m = _model()
    a = _named(m, "Pump")
    b = _named(m, "Pumice")
    assert m.indexes.search_candidates("pum") == {a.id, b.id}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -q`
Expected: 3 FAIL — `AttributeError: ... no attribute 'search_candidates'`; earlier tests still PASS.

- [ ] **Step 3: Implement the accessor**

In `indexes.py`, in the accessors section after `iter_roots` (keep the live-view convention comment block above it in mind):

```python
    def search_candidates(self, q: str) -> Set[str] | None:
        """Ids of elements that MAY fuzzy-match ``q`` — a guaranteed superset
        of the true hits — or ``None`` when the index cannot answer
        (``len(q) < 3``; the caller falls back to a scan). ``q`` must already
        be trimmed and lowercased. May return a live internal set — do NOT
        mutate.

        Superset argument: any string containing ``q`` contains every trigram
        of ``q``, so a matching element sits in ALL those posting sets and
        survives the intersection. Intersection starts from the smallest set,
        so cost is O(smallest posting); a degenerate all-common query
        approaches the scan it replaces, never exceeds it asymptotically.
        """
        if len(q) < 3:
            return None
        postings: list[set[str]] = []
        for i in range(len(q) - 2):
            ids = self.search_postings.get(q[i : i + 3])
            if not ids:
                # a true hit would contain ALL trigrams; one absent => none
                return frozenset()
            postings.append(ids)
        postings.sort(key=len)
        result: Set[str] = postings[0]
        for ids in postings[1:]:
            result = result & ids
            if not result:
                break
        return result
```

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -q`
Expected: PASS (all 12).

- [ ] **Step 5: Lint and commit**

```bash
pixi run lint-core
git add src/data_rover/core/model/indexes.py tests/model/test_search_index.py
git commit -m "feat(core): IndexSet.search_candidates trigram intersection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire `GET /model/elements?q=` to the candidate index

**Files:**
- Modify: `src/data_rover/api/routes/read.py` (the `query:` branch of `list_elements`, currently ~lines 202-218)
- Test: `tests/api/test_read_routes.py` (extend)

**Interfaces:**
- Consumes: `model.indexes.search_candidates(query)` from Task 3 (`None` → scan fallback).
- Produces: the wired route Task 5's parity battery exercises. No schema or contract change: `ElementPage` shape, ranking, `total`, paging all identical.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/test_read_routes.py` (after `test_elements_search_is_deterministic`; the file already has `client`, `_load_model`, `_item`, `API`, and imports `pytest` / `TestClient`):

```python
def test_search_uses_index_candidates(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The q-branch must consume IndexSet.search_candidates: an empty
    candidate set yields zero hits even though a scan would match."""
    from data_rover.core.model.indexes import IndexSet

    _load_model(client, [_item("e1", "Pump")], [])
    monkeypatch.setattr(IndexSet, "search_candidates", lambda self, q: frozenset())
    res = client.get(f"{API}/model/elements", params={"q": "pump"})
    assert res.status_code == 200
    assert res.json()["total"] == 0


def test_search_short_query_falls_back_to_scan(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """len(q) < 3 => the accessor answers None and the scan still runs."""
    from data_rover.core.model.indexes import IndexSet

    _load_model(client, [_item("e1", "Pump"), _item("e2", "Pi")], [])
    calls: list[str] = []
    orig = IndexSet.search_candidates

    def spy(self: IndexSet, q: str):
        calls.append(q)
        return orig(self, q)

    monkeypatch.setattr(IndexSet, "search_candidates", spy)
    res = client.get(f"{API}/model/elements", params={"q": "pu"})
    assert res.status_code == 200
    assert res.json()["total"] == 1  # 'Pump' matched by the fallback scan
    assert calls == ["pu"]  # the route consulted the index exactly once


def test_search_with_type_filter_over_candidates(client: TestClient) -> None:
    """type= filtering still applies on top of index candidates."""
    _load_model(
        client,
        [
            _item("e1", "Pump"),
            {"id": "e2", "type_name": "Tag", "properties": {"name": "Pump Tag"}},
        ],
        [],
    )
    res = client.get(f"{API}/model/elements", params={"q": "pump", "type": "Tag"})
    body = res.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == "e2"
```

- [ ] **Step 2: Run tests to verify current behavior fails them**

Run: `pixi run -e core-dev pytest tests/api/test_read_routes.py -q -k "index_candidates or falls_back or filter_over_candidates"`
Expected: `test_search_uses_index_candidates` FAILS (total == 1 — route ignores the patched accessor because it doesn't call it yet); the other two PASS trivially pre-wiring (they assert unchanged behavior; the `calls == ["pu"]` assertion FAILS as `[]`). Two of three failing is the red state.

- [ ] **Step 3: Wire the route**

In `src/data_rover/api/routes/read.py`:

3a. Add to the imports block (stdlib group):

```python
from collections.abc import Iterable
```

3b. Replace the top of the `if query:` branch in `list_elements`:

```python
    if query:
        hits: list[tuple[float, str]] = []
        #: per-request memo: does ``query`` match this type name? (saves one
        #: lowercase + substring scan per element on large models)
        type_matches: dict[str, bool] = {}
        # trigram candidate generation: a SUPERSET of the true hits, or None
        # when the index can't answer (len < 3) and the full scan runs. The
        # score check below stays the sole arbiter of matching and order, so
        # results are byte-identical either way.
        candidate_ids = model.indexes.search_candidates(query)
        elements: Iterable[Element] = (
            model.elements.values()
            if candidate_ids is None
            else (model.elements[eid] for eid in candidate_ids)
        )
        for element in elements:
```

(the loop body — type filter, memo, `_search_score`, `hits.append` — is unchanged; only the iteration source moved.)

3c. Extend the `list_elements` docstring's search sentence:

```
    With ``q`` of 3+ chars the scan is replaced by trigram candidates from
    ``IndexSet.search_candidates`` (byte-identical results); shorter queries
    fall back to the full scan.
```

- [ ] **Step 4: Run the new tests and the whole read-route module**

Run: `pixi run -e core-dev pytest tests/api/test_read_routes.py -q`
Expected: PASS — including the pre-existing search tests (`test_search_ranks_exact_name_above_substring`, `test_elements_search_scoring_tiers`, `test_elements_search_is_deterministic`), which now exercise the index path.

- [ ] **Step 5: Lint and commit**

```bash
pixi run lint-backend
git add src/data_rover/api/routes/read.py tests/api/test_read_routes.py
git commit -m "feat(api): fuzzy element search consumes trigram candidates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Randomized parity battery

The load-bearing correctness test: index-backed results must equal a verbatim copy of the pre-index scan, item-for-item, for a battery of query shapes over seeded-random models.

**Files:**
- Test: `tests/api/test_search_parity.py` (create)

**Interfaces:**
- Consumes: the wired route (Task 4) and `_search_score` imported from `data_rover.api.routes.read` (the reference reimplements the OLD scan loop verbatim around it).

- [ ] **Step 1: Write the parity test file**

Create `tests/api/test_search_parity.py`:

```python
"""Byte-identical parity between the index-backed fuzzy search and a
reference O(n) scan (spec 2026-07-10-search-index-design: the trigram index
is ONLY a candidate generator; ``_search_score`` stays the sole arbiter of
matching and order). The reference below is the pre-index ``list_elements``
query loop, verbatim."""

from __future__ import annotations

import random

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes.read import _search_score
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Pump
    properties:
      - {name: name, datatype: string}
      - {name: note, datatype: string}
      - {name: size, datatype: integer}
  - name: Pipe
    properties:
      - {name: name, datatype: string}
      - {name: note, datatype: string}
relationships:
  - name: Links
    containment: false
    source: Pump
    target: Pipe
"""

#: small vocabulary => heavy substring/trigram collisions on purpose
WORDS = ["pump", "pipe", "alpha", "beta", "valve", "grid", "hydro", "ab", "x"]

QUERIES = [
    "pump", "PUMP", "  pump  ",  # case/trim normalization
    "pipe", "hydro", "valve",  # plain substrings
    "pump pipe",  # phrase: only whole-field substrings match
    "alpha-1",  # id fragment
    "pum",  # single-trigram query (len == 3)
    "pu", "x",  # short: scan fallback
    "zzz",  # zero hits
    "grid alpha zzz",  # known trigrams + absent trigram
]


def _text(rng: random.Random) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(rng.randint(0, 4)))


def _client_with_random_model(seed: int, n: int = 200) -> TestClient:
    rng = random.Random(seed)
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    elements = []
    for i in range(n):
        type_name = rng.choice(["Pump", "Pipe"])
        props: dict = {}
        if rng.random() < 0.8:
            props["name"] = _text(rng)
        if rng.random() < 0.5:
            props["note"] = _text(rng)
        if type_name == "Pump" and rng.random() < 0.3:
            props["size"] = rng.randint(0, 99999)
        elements.append(
            {
                "id": f"{rng.choice(WORDS)}-{i}",  # searchable id fragments
                "type_name": type_name,
                "properties": props,
            }
        )
    res = c.post(f"{API}/model", json={"elements": elements, "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _reference(query: str, type_: str | None) -> tuple[list[str], int]:
    """The pre-index scan loop from routes/read.py, verbatim."""
    model = get_session().model
    assert model is not None
    hits: list[tuple[float, str]] = []
    type_matches: dict[str, bool] = {}
    for element in model.elements.values():
        if type_ is not None and element.type_name != type_:
            continue
        tn = element.type_name
        matches = type_matches.get(tn)
        if matches is None:
            matches = query in tn.lower()
            type_matches[tn] = matches
        score = _search_score(element, query, matches)
        if score > 0:
            hits.append((-score, element.id))
    hits.sort()
    return [eid for _, eid in hits], len(hits)


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_index_search_matches_reference_scan(seed: int) -> None:
    client = _client_with_random_model(seed)
    model = get_session().model
    assert model is not None
    # add a real element name to the battery so the exact-match tier is hit
    real_name = next(
        (
            e.properties["name"]
            for e in model.elements.values()
            if isinstance(e.properties.get("name"), str)
            and len(e.properties["name"]) >= 3
        ),
        None,
    )
    queries = QUERIES + ([real_name] if real_name is not None else [])
    for q in queries:
        norm = q.strip().lower()
        for type_ in (None, "Pump"):
            params: dict = {"q": q, "limit": 500}
            if type_ is not None:
                params["type"] = type_
            res = client.get(f"{API}/model/elements", params=params)
            assert res.status_code == 200, res.text
            body = res.json()
            want_ids, want_total = _reference(norm, type_)
            got_ids = [e["id"] for e in body["items"]]
            assert got_ids == want_ids[:500], f"q={q!r} type={type_!r} seed={seed}"
            assert body["total"] == want_total, f"q={q!r} type={type_!r} seed={seed}"
```

- [ ] **Step 2: Run the parity battery**

Run: `pixi run -e core-dev pytest tests/api/test_search_parity.py -q`
Expected: PASS (3 tests, ~28 query×filter comparisons each). If any comparison fails, that is a real parity bug in Tasks 2-4 — debug there, do not weaken the assertion.

- [ ] **Step 3: Sanity-check the battery catches breakage (temporary mutation)**

Temporarily change `search_candidates`'s single-trigram path to return a wrong result (e.g. `return frozenset()` when `len(q) == 3`), rerun, confirm the battery FAILS, then **revert the mutation** and rerun to green. This proves the test is load-bearing, not vacuous.

- [ ] **Step 4: Lint and commit**

```bash
pixi run lint-backend
git add tests/api/test_search_parity.py
git commit -m "test(api): randomized parity battery for index-backed search

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Measurement, docs, and results

**Files:**
- Modify: `tests/api/test_perf_probe.py` (index-stat print)
- Modify: `CLAUDE.md` (read-path note)
- Modify (local-only, no commit): `docs/superpowers/specs/2026-07-10-search-index-design.md` (Results)
- Modify (local-only, no commit): `.superpowers/sdd/progress.md` (ledger entry — follow the format of the existing entries)

**Interfaces:**
- Consumes: probe rows from Task 1, index structures from Task 2.

- [ ] **Step 1: Add the index-stat print to the probe**

In `tests/api/test_perf_probe.py`: add `import sys` to the imports and `from data_rover.api.session import get_session` to the project imports; then after the upload-timing `print` in `test_perf_probe`:

```python
    model = get_session().model
    assert model is not None
    idx = model.indexes
    postings = idx.search_postings
    entries = sum(len(v) for v in postings.values())
    # measurement harness only: reaches into _trigrams_of for the size figure
    approx_mb = (
        sys.getsizeof(postings)
        + sum(sys.getsizeof(k) + sys.getsizeof(v) for k, v in postings.items())
        + sys.getsizeof(idx._trigrams_of)
        + sum(sys.getsizeof(k) + sys.getsizeof(v) for k, v in idx._trigrams_of.items())
    ) / 1e6
    print(
        f"trigram index: {len(postings)} trigrams, {entries} posting entries, "
        f"~{approx_mb:.0f} MB (excl. shared id strings)"
    )
```

- [ ] **Step 2: Run the probe at 50k and 500k**

Run: `pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s`
Run: `PERF_N=500000 pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s`
Expected: PASS. Selective query now ~single-digit ms; degenerate ≈ baseline (documented non-goal); short ≈ baseline (fallback). Compare upload+install against Task 1's runs — the delta is the index build cost; record it.

- [ ] **Step 3: Fill the spec Results section**

In `docs/superpowers/specs/2026-07-10-search-index-design.md`, under the baseline table from Task 1, add:

```markdown
### After (feat/search-index @ <commit>)

| probe row                       | 50k (ms) | 500k (ms) |
|---------------------------------|----------|-----------|
| fuzzy search, selective         | <fill>   | <fill>    |
| fuzzy search, degenerate        | <fill>   | <fill>    |
| fuzzy search, short fallback    | <fill>   | <fill>    |

Index: <t> trigrams, <e> posting entries, ~<m> MB at 500k.
Upload+install: <before> s -> <after> s at 500k (index build cost).
```

Also update the spec header `Status:` line to `implemented (2026-07-10)`.

- [ ] **Step 4: CLAUDE.md read-path note**

In `CLAUDE.md`, extend the bullet that begins `- Reads are **paged/on-demand**` — append to that bullet:

```
Fuzzy element search (`GET /model/elements?q=`) draws candidates from the
trigram index (`IndexSet.search_postings` / `search_candidates`, maintained
at the mutation boundary like `roots_order`); queries under 3 chars fall
back to the scan, and results are byte-identical to a full scan either way.
```

- [ ] **Step 5: Full verification**

Run: `pixi run -e core-dev pytest -q`
Expected: PASS (perf tests deselected).
Run: `pixi run tidy`
Expected: clean (ruff + mypy + pyright).

- [ ] **Step 6: Ledger entry**

Append a dated entry to `.superpowers/sdd/progress.md` following the existing entries' format: slice name, branch, tasks landed, before/after headline numbers, deferrals (none expected).

- [ ] **Step 7: Commit**

```bash
git add tests/api/test_perf_probe.py CLAUDE.md
git commit -m "docs+perf: record search-index results; CLAUDE.md read-path note

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Completion

After Task 6: request a whole-branch code review (superpowers:requesting-code-review), address findings, then superpowers:finishing-a-development-branch to integrate `feat/search-index`.
