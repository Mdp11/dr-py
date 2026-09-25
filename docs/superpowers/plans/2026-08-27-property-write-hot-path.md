# Property-Write Hot Path (K-23) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a property write (`Model.set_property`/`delete_property` — every op property of every commit and of the hydration replay tail) cost O(changed value) instead of O(element): today ~76 µs on an indexed element and ~130 µs on a never-indexed one at scale 320, ~85–95 % of which is re-deriving the whole element's trigram set for one changed value.

**Architecture:** Three independent legs, none touching the bulk-load path. (1) `Metamodel._Caches` gains cached `frozenset` property-name sets; `set_property`, `delete_property` and `routes/ops.py::_check_patch_keys` test membership on them instead of copying the effective-property list and building a set per write. (2) `IndexSet.on_property_changed(entity, prop, old_value)` — a single-property hook the two `Model` methods call with the prior value — diffs the trigram index from the changed value's text alone (additions = new trigrams not present; a removal candidate survives when any other searchable field still contains it, checked by C-level substring tests), patching the sorted `_trigrams_of` tuple with `bisect`; every non-plain case falls back to the existing whole-element re-derivation, and `verify_consistent` (which compares the search structures with a fresh build) pins exactness. (3) `_trigrams_of` gets an entry for EVERY indexed element (an empty tuple when its text has no trigram), so absence means exactly "bulk-loaded and not yet reached by the chunked search build" — and while `search_ready` is False the property hooks leave such an element to the build, which indexes its current text when it gets there. A measurement task at scale 320 confirms the numbers against the spec's spike table.

**Tech Stack:** Python 3.14 (core + one API helper; no DB, setting, migration or frontend change); pytest via pixi (`pixi run -e core-dev pytest`).

**Spec:** `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program" item 5, § "K-23 design" — its spike table is the "Today" column Task 4 compares against). The BACKLOG entry `K-23` (`BACKLOG.md:1060`) carries the owner's proposal.

## Global Constraints

- Every command goes through **pixi**: single test file `pixi run -e core-dev pytest tests/path/test_x.py -v`; whole backend suite `pixi run core-test`; frontend unit tests `pixi run frontend-test`; lint/format/typecheck `pixi run dr-tidy` (ruff + mypy + pyright + prettier/eslint — all must pass; pyright covers `tests/` too, so no `# type: ignore` shortcuts). Check-only forms `pixi run dr-tidy true` / `pixi run core-tidy true` modify nothing — use those while an implementer is mid-edit. The `[feature.api.activation]` hook prints `[ensure_guest]` lines before every command — ignore them. **Ruff does NOT enforce import ordering** in this repo (`ruff.toml` selects `UP` on top of the E4/E7/E9/F defaults; no isort rules) — do not "fix" import order and do not claim ruff wants it.
- Work on a branch `perf/property-write-hot-path` off `main` (create it via `superpowers:using-git-worktrees` at execution time; `EnterWorktree` names the branch `worktree-<name>` — `git branch -m perf/property-write-hot-path` right after entering). In a fresh worktree run `pixi run frontend-install` before `dr-tidy` (it dies at `frontend-format` otherwise). The repo integrates feature branches into `main` with a merge commit, then pushes (`BACKLOG.md:1225`: pushing `main` is standing policy). **`main` can move under you** (a concurrent session commits to it directly): re-check `git log origin/main` immediately before merging and pushing. Leave `.claude/worktrees/feat-metamodel-diagram-editor` alone — it belongs to another session.
- **Worktree harness guard:** inside a worktree the harness refuses compound Bash (loops, `&&`-chains, heredocs, `$(...)` groups, parenthesised groups, even `${PIPESTATUS[0]}`). Use plain single commands, the Write/Edit tools, or put the logic in a script under the session scratchpad and run `bash <script>` / `pixi run -e core-dev python <script>`. To merge, `ExitWorktree keep` first, then merge from the main checkout and `git worktree remove` the path.
- Comments/docstrings: concise, present tense, only invariants and non-obvious contracts. No spec/plan references, no history narration ("was", "used to", "K-23").
- Python 3.14 idioms (`X | Y` unions, `collections.abc` imports).
- `docs/` is gitignored — the spec and this plan are never committed; every other step commits.
- **The K-23 hazard (the spec's):** whatever replaces the per-write work must be O(changed value) per write and must not make the metamodel mutable — `Metamodel` is frozen after load, `_Caches` is its only lazily-built state and is reset by `model_copy`. Per-entity validator hooks stay O(entity); an O(model) cost must never move to the mutation boundary.
- **Behaviour is unchanged where it is observable:** the search index (`search_postings`, `_trigrams_of`) after any mutation sequence equals what a fresh `rebuild()` + `build_search_index()` produces — `verify_consistent` says so and every new test ends in it. Unknown-property errors keep their `KeyError` type and message. The uniqueness/reference/roots indexes are untouched.
- **K-20 (narrowed by Task 3, not broken):** never build a search index on a transient model; `keep_search=True` only at the four rebind sites; a bulk-loaded model starts with `search_ready=False` and search falls back to the scan. Task 3 changes ONE sentence of the K-20 contract — "the hooks maintain postings regardless of readiness" becomes "the hooks maintain postings for every element that has a `_trigrams_of` entry; an element without one is the chunked build's until it reaches it" — and rewrites the docstrings that state it. **K-22:** `IndexSet.element_order` is maintained by the two element hooks only; no property hook touches it. **K-21 / K-6:** untouched.
- **`IndexSet` accessor convention:** every structure is a LIVE INTERNAL VIEW — consumers read, never mutate.
- Model choices that worked for SDD on K-6/K-21/K-22: **haiku** for transcription tasks carrying the literal code (Tasks 1 and 5), **sonnet** for Tasks 2–4 and 6 and for per-task reviews, the most capable model for the final whole-branch review only. Run the verification suites in the background while a review is pending — never alongside a timing measurement.

**Cross-task test preconditions** (the pre-flight conflict scan; re-check it before executing):

| Task | Its tests assume | Installed by |
|---|---|---|
| 1 | `Metamodel.effective_*_property_names` exist; `set_property`/`delete_property` raise `KeyError` on unknown names as today | Task 1 itself |
| 2 | `_trigrams_of` still SPARSE (no entry when the set is empty — `test_delete_removes_all_postings` and `_trigrams_of.pop` in the diff tail rely on it); `on_property_changed` called by both `Model` methods; fresh `Model` has `search_ready=True` | Task 2 itself; nothing from Task 1 |
| 3 | Task 2's `_update_trigrams_for` in place (it inserts one line into it and changes its tail); `_bulk_loaded` helper from `tests/model/test_search_index.py`; `restore_element` accepts any unused id | Task 2 |
| 4 | Tasks 1–3 merged into the tree; the scale-320 fixture | Tasks 1–3 |

---

### Task 1: Cached property-name sets on `Metamodel`, used at the mutation boundary and by `_check_patch_keys`

**Files:**
- Modify: `src/data_rover/core/metamodel/schema.py` (`_Caches` `:148-174`; `_build_caches` return `:309-333`; the `effective_element_properties`/`effective_relationship_properties` methods `:399-421`)
- Modify: `src/data_rover/core/model/model.py` (`set_property` `:70-89`, `delete_property` `:91-114`)
- Modify: `src/data_rover/api/routes/ops.py` (`_check_patch_keys` `:224-236`)
- Test: `tests/metamodel/test_schema.py` (append), `tests/model/test_model_set.py` (append)

**Interfaces:**
- Produces: `Metamodel.effective_element_property_names(name: str) -> frozenset[str]` and `Metamodel.effective_relationship_property_names(name: str) -> frozenset[str]` — the names of the corresponding `effective_*_properties(name)` list as ONE shared frozenset per type per cache build (identity-stable across calls; an empty frozenset for an unknown type). `_Caches.effective_element_prop_names` / `effective_relationship_prop_names: dict[str, frozenset[str]]`. Nothing later in this plan consumes them beyond `model.py` and `ops.py`, which this task rewires.

- [ ] **Step 1: Write the failing tests**

Append to `tests/metamodel/test_schema.py` (the file already imports `ElementType`, `Mapping`, `Metamodel`, `PropertyDef`, `RelationshipType`):

```python
def test_effective_property_names_follow_inheritance_and_are_cached():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Named",
                abstract=True,
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(
                name="Block",
                extends="Named",
                properties=[PropertyDef(name="mass", datatype="float")],
            ),
        ],
        relationships=[
            RelationshipType(
                name="Link",
                source="Block",
                target="Block",
                properties=[PropertyDef(name="label", datatype="string")],
            ),
        ],
    )
    names = mm.effective_element_property_names("Block")
    assert names == frozenset({"name", "mass"})
    assert names == {p.name for p in mm.effective_element_properties("Block")}
    # one shared object per type per cache build: no copy per call
    assert mm.effective_element_property_names("Block") is names
    assert mm.effective_element_property_names("Named") == frozenset({"name"})
    assert mm.effective_relationship_property_names("Link") == frozenset({"label"})
    assert mm.effective_element_property_names("Missing") == frozenset()
    assert mm.effective_relationship_property_names("Missing") == frozenset()


def test_effective_property_names_rebuild_on_model_copy():
    base = Metamodel(
        elements=[
            ElementType(
                name="Block", properties=[PropertyDef(name="name", datatype="string")]
            )
        ]
    )
    assert base.effective_element_property_names("Block") == frozenset({"name"})
    grown = base.model_copy(
        update={
            "elements": [
                ElementType(
                    name="Block",
                    properties=[
                        PropertyDef(name="name", datatype="string"),
                        PropertyDef(name="mass", datatype="float"),
                    ],
                )
            ]
        }
    )
    assert grown.effective_element_property_names("Block") == frozenset({"name", "mass"})
    assert base.effective_element_property_names("Block") == frozenset({"name"})
```

Append to `tests/model/test_model_set.py` (the file already imports `pytest`, `ElementType`, `Metamodel`, `PropertyDef`, `RelationshipType`, `Model`):

```python
def test_set_and_delete_inherited_property_accepted():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Named",
                abstract=True,
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(name="Block", extends="Named"),
        ]
    )
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "name", "Engine")
    assert el.properties == {"name": "Engine"}
    model.delete_property(el, "name")
    assert el.properties == {}
    with pytest.raises(KeyError, match="ghost"):
        model.set_property(el, "ghost", 1)
    with pytest.raises(KeyError, match="ghost"):
        model.delete_property(el, "ghost")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/metamodel/test_schema.py tests/model/test_model_set.py -v`
Expected: the two `test_effective_property_names_*` tests FAIL with `AttributeError: 'Metamodel' object has no attribute 'effective_element_property_names'`; `test_set_and_delete_inherited_property_accepted` PASSES already (it pins today's behaviour so the rewiring cannot regress it). Everything else passes.

- [ ] **Step 3: Implement the cache and rewire the three callers**

In `src/data_rover/core/metamodel/schema.py`, add two fields to `_Caches` right after `effective_relationship_props`:

```python
    effective_element_props: dict[str, list[PropertyDef]]
    effective_relationship_props: dict[str, list[PropertyDef]]
    #: the same lists' names as one shared frozenset per type — the per-write
    #: membership check at the mutation boundary
    effective_element_prop_names: dict[str, frozenset[str]]
    effective_relationship_prop_names: dict[str, frozenset[str]]
```

In `_build_caches`, hoist the two effective-property dicts out of the `_Caches(...)` call and derive the name sets from them. Replace

```python
        effective_element_props={
            n: _effective_props(c, types_by_name) for n, c in element_ancestors.items()
        },
        effective_relationship_props={
            n: _effective_props(c, rel_types_by_name)
            for n, c in relationship_ancestors.items()
        },
```

with

```python
        effective_element_props=effective_element_props,
        effective_relationship_props=effective_relationship_props,
        effective_element_prop_names={
            n: frozenset(p.name for p in ps) for n, ps in effective_element_props.items()
        },
        effective_relationship_prop_names={
            n: frozenset(p.name for p in ps)
            for n, ps in effective_relationship_props.items()
        },
```

and, immediately before the `return _Caches(` line, add:

```python
    effective_element_props = {
        n: _effective_props(c, types_by_name) for n, c in element_ancestors.items()
    }
    effective_relationship_props = {
        n: _effective_props(c, rel_types_by_name)
        for n, c in relationship_ancestors.items()
    }
```

Add a module-level constant next to `PRIMITIVES`/`FLOAT_INFINITIES` at the top of the file:

```python
_NO_NAMES: frozenset[str] = frozenset()
```

Add the two accessors to `Metamodel`, right after `effective_element_properties`:

```python
    def effective_element_property_names(self, name: str) -> frozenset[str]:
        """Names of :meth:`effective_element_properties` as one shared, cached
        frozenset (empty for an unknown type) — the per-write membership check
        at the mutation boundary, which must not copy the list per call."""
        return self._caches().effective_element_prop_names.get(name, _NO_NAMES)
```

and right after `effective_relationship_properties`:

```python
    def effective_relationship_property_names(self, name: str) -> frozenset[str]:
        return self._caches().effective_relationship_prop_names.get(name, _NO_NAMES)
```

In `src/data_rover/core/model/model.py`, in BOTH `set_property` and `delete_property`, replace

```python
        if isinstance(target, Element):
            defs = self.metamodel.effective_element_properties(target.type_name)
        else:
            defs = self.metamodel.effective_relationship_properties(target.type_name)
        if prop not in {p.name for p in defs}:
            raise KeyError(f"{target.type_name!r} has no property {prop!r}")
```

with

```python
        if isinstance(target, Element):
            names = self.metamodel.effective_element_property_names(target.type_name)
        else:
            names = self.metamodel.effective_relationship_property_names(
                target.type_name
            )
        if prop not in names:
            raise KeyError(f"{target.type_name!r} has no property {prop!r}")
```

In `src/data_rover/api/routes/ops.py`, rewrite the body of `_check_patch_keys`:

```python
def _check_patch_keys(
    model: Model, type_name: str, *, element: bool, patch: dict[str, Any]
) -> None:
    """Reject unknown patch keys upfront so a patch can never fail half-applied
    (set/delete_property on an attached entity only fails on unknown keys)."""
    if element:
        valid = model.metamodel.effective_element_property_names(type_name)
    else:
        valid = model.metamodel.effective_relationship_property_names(type_name)
    for key in patch:
        if key not in valid:
            raise KeyError(f"{type_name!r} has no property {key!r}")
```

- [ ] **Step 4: Run the tests to verify they pass, then the neighbouring files**

Run: `pixi run -e core-dev pytest tests/metamodel/test_schema.py tests/model/test_model_set.py tests/model/test_model_restore.py tests/api/test_ops_route.py -v`
Expected: all PASS (the ops-route file has the unknown-key 422 cases — `test_422_examples`, `test_failed_batch_rolls_back_mid_op_create` — which now go through the frozenset).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/metamodel/schema.py src/data_rover/core/model/model.py src/data_rover/api/routes/ops.py tests/metamodel/test_schema.py tests/model/test_model_set.py
git commit -m "perf(metamodel): cached property-name frozensets for the per-write unknown-key check"
```

---

### Task 2: `IndexSet.on_property_changed` — diff the trigram index from the changed value alone

**Files:**
- Modify: `src/data_rover/core/model/indexes.py` (imports `:41-46`; module docstring `:10-16`; `on_properties_changed` `:348-357`; the "internals: search trigrams" section `:741-784` — a new module-level helper and a new method beside `_update_trigrams`)
- Modify: `src/data_rover/core/model/model.py` (`set_property` tail `:86-89`, `delete_property` tail `:110-114`)
- Test: `tests/model/test_search_index.py` (append; add `import random` to its imports)

**Interfaces:**
- Consumes: nothing from Task 1 (this task does not touch the name check).
- Produces: `IndexSet.on_property_changed(entity: Element | Relationship, prop: str, old_value: Any) -> None` — the hook `Model.set_property`/`delete_property` call AFTER the property dict is updated, passing the prior value (`None` when the key was absent). Same post-state as `on_properties_changed(entity)`. Private: module-level `_text_trigrams(text: str) -> set[str]`; `IndexSet._update_trigrams_for(element: Element, prop: str, old_value: Any) -> None`. Task 3 edits `_update_trigrams_for` (adds one early return, changes its tail). `_trigrams_of` stays SPARSE in this task.

- [ ] **Step 1: Write the failing tests**

In `tests/model/test_search_index.py`, add `import random` above `import pytest`, then append:

```python
# ---------------------------------------------------------------------------
# per-property diff (set_property / delete_property hook)
# ---------------------------------------------------------------------------


def test_diff_keeps_trigrams_another_field_still_holds() -> None:
    m = _model()
    el = _named(m, "cooling pump")
    m.set_property(el, "note", "cooling circuit")
    m.set_property(el, "note", "heat circuit")
    assert el.id in _posting_ids(m, "coo")  # left the note, still in the name
    assert el.id not in _posting_ids(m, "g c")  # only ever in the old note
    assert el.id in _posting_ids(m, "hea")
    m.indexes.verify_consistent()


def test_diff_falls_back_for_list_values_and_list_names() -> None:
    m = _model()
    el = _named(m, "Pump")
    el.properties["name"] = ["Valve", "Gauge"]  # multiplicity-many name (legacy models)
    m.indexes.on_properties_changed(el)
    assert el.id in _posting_ids(m, "val")
    m.set_property(el, "note", "turbine")  # a list-valued name: whole-element path
    assert el.id in _posting_ids(m, "tur")
    assert el.id in _posting_ids(m, "val")
    m.set_property(el, "name", "Boiler")  # list -> str: fallback again, list text gone
    assert el.id in _posting_ids(m, "boi")
    assert "val" not in m.indexes.search_postings
    m.set_property(el, "note", ["turbine", "hall"])  # str -> list value: fallback
    assert "tur" not in m.indexes.search_postings
    m.indexes.verify_consistent()


def test_diff_delete_property_and_same_value_rewrite() -> None:
    m = _model()
    el = _named(m, "Pump")
    m.set_property(el, "note", "cooling")
    before = m.indexes._trigrams_of[el.id]
    m.set_property(el, "note", "cooling")  # same text again: nothing moves
    assert m.indexes._trigrams_of[el.id] == before
    m.delete_property(el, "note")
    assert "coo" not in m.indexes.search_postings
    assert el.id in _posting_ids(m, "pum")
    m.indexes.verify_consistent()


def test_diff_matches_full_derivation_over_random_edits() -> None:
    """The per-value diff must land on exactly what a whole-element
    re-derivation produces, after every single write."""
    rng = random.Random(23)
    words = ["pump", "valve", "cooling", "heat", "pumps", "ab", "", "turbine hall", "coo"]
    m = _model()
    els = [_named(m, rng.choice(words)) for _ in range(6)]
    for _ in range(300):
        el = rng.choice(els)
        prop = rng.choice(["name", "note"])
        if rng.random() < 0.2:
            m.delete_property(el, prop)
        else:
            m.set_property(el, prop, rng.choice(words))
        have = frozenset(m.indexes._trigrams_of.get(el.id) or ())
        assert have == m.indexes._element_trigrams(el)
    m.indexes.verify_consistent()


def test_on_property_changed_is_the_model_hook() -> None:
    m = _model()
    el = _named(m, "Pump")
    old = el.properties["name"]
    el.properties["name"] = "Valve"
    m.indexes.on_property_changed(el, "name", old)
    assert el.id in _posting_ids(m, "val")
    assert "pum" not in m.indexes.search_postings
    m.indexes.verify_consistent()
```

- [ ] **Step 2: Run the tests — four PASS today (they pin the post-state the diff must reproduce), one FAILS**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -v`
Expected: `test_on_property_changed_is_the_model_hook` FAILS with `AttributeError: 'IndexSet' object has no attribute 'on_property_changed'`. The other four new tests PASS against today's whole-element path — that is the point: after Step 3 the same four must still pass with the diff doing the work, and `test_diff_matches_full_derivation_over_random_edits` compares the two paths after every single write.

- [ ] **Step 3: Implement the hook and the diff**

In `src/data_rover/core/model/indexes.py`, add to the imports (after `from collections import Counter`):

```python
from bisect import bisect_left, insort
```

In the module docstring, replace the sentence

```
maintained incrementally at the mutation boundary (``create_element``,
``connect``, ``disconnect``, ``set_property``, ``delete_element``). Bulk
loaders that populate the model dicts directly must call :meth:`IndexSet.
rebuild` afterwards; code that writes ``entity.properties`` directly must call
:meth:`IndexSet.on_properties_changed`.
```

with

```
maintained incrementally at the mutation boundary (``create_element``,
``connect``, ``disconnect``, ``set_property``, ``delete_element``). Bulk
loaders that populate the model dicts directly must call :meth:`IndexSet.
rebuild` afterwards; code that writes ``entity.properties`` directly must call
:meth:`IndexSet.on_properties_changed` (``set_property``/``delete_property``
themselves go through :meth:`IndexSet.on_property_changed`, the
single-property form that diffs the search index from the changed value).
```

Replace `on_properties_changed` with the pair:

```python
    def on_properties_changed(self, entity: Element | Relationship) -> None:
        """Re-derive property-driven indexes (references, uniqueness, roots,
        search) for one entity from scratch. The explicit hook for code that
        writes ``entity.properties`` directly instead of using
        ``set_property``; see :meth:`on_property_changed` for the diffing
        form the mutation boundary uses."""
        if isinstance(entity, Element):
            self._update_refs(entity.id, self._element_refs(entity))
            self._rekey(entity)
            self._roots_reposition(entity)
            self._update_trigrams(entity.id, self._element_trigrams(entity))
        else:
            self._update_refs(entity.id, self._relationship_refs(entity))

    def on_property_changed(
        self, entity: Element | Relationship, prop: str, old_value: Any
    ) -> None:
        """Same post-state as :meth:`on_properties_changed`, after ONE
        property changed from ``old_value`` (``None`` = absent) to its current
        value — the ``set_property``/``delete_property`` hook. The search
        index is diffed from the changed value's text where that is exact
        (``_update_trigrams_for``) instead of re-deriving the element."""
        if isinstance(entity, Element):
            self._update_refs(entity.id, self._element_refs(entity))
            self._rekey(entity)
            self._roots_reposition(entity)
            self._update_trigrams_for(entity, prop, old_value)
        else:
            self._update_refs(entity.id, self._relationship_refs(entity))
```

In the "internals: search trigrams" section, add a module-level helper ABOVE `class IndexSet` (next to `_frozen`):

```python
def _text_trigrams(text: str) -> set[str]:
    """Lowercased trigrams of one field's text (fewer than 3 chars: none)."""
    s = text.lower()
    return {s[i : i + 3] for i in range(len(s) - 2)}
```

and add this method right after `_update_trigrams`:

```python
    def _update_trigrams_for(
        self, element: Element, prop: str, old_value: Any
    ) -> None:
        """Trigram diff for one changed property.

        Exact only when both values are plain strings (or absent) and no
        name-keyed property holds a list (``name_of`` then reads inside the
        list — text a per-value diff never sees); anything else, and an
        element without an entry, falls back to the whole-element
        re-derivation. Additions are the new value's trigrams not already
        present; a removal candidate (in the old value, not the new) is kept
        when any OTHER searchable field still contains it — one substring
        test per candidate instead of re-deriving every field. The sorted
        tuple is patched in place (bisect) rather than re-sorted.
        """
        eid = element.id
        cur = self._trigrams_of.get(eid)
        if cur is None:
            self._update_trigrams(eid, self._element_trigrams(element))
            return
        new_value = element.properties.get(prop)
        if (
            not (old_value is None or isinstance(old_value, str))
            or not (new_value is None or isinstance(new_value, str))
            or any(
                isinstance(v, list)
                for k, v in element.properties.items()
                if k.lower() == "name"
            )
        ):
            self._update_trigrams(eid, self._element_trigrams(element))
            return
        old_t = _text_trigrams(old_value) if old_value else set()
        new_t = _text_trigrams(new_value) if new_value else set()
        if old_t == new_t:
            return
        removed = old_t - new_t
        if removed:
            others = [eid.lower(), element.type_name.lower()]
            others.extend(
                v.lower()
                for k, v in element.properties.items()
                if k != prop and isinstance(v, str)
            )
            removed = {t for t in removed if not any(t in s for s in others)}
        added = new_t.difference(cur)
        if not removed and not added:
            return
        postings = self.search_postings
        canon = self._canon_trigrams
        trigs = list(cur)
        for t in removed:
            ids = postings.get(t)
            if ids is not None:
                ids.discard(eid)
                if not ids:
                    del postings[t]
            i = bisect_left(trigs, t)
            if i < len(trigs) and trigs[i] == t:
                del trigs[i]
        for t in added:
            t = canon.setdefault(t, t)
            postings.setdefault(t, set()).add(eid)
            insort(trigs, t)
        if trigs:
            self._trigrams_of[eid] = tuple(trigs)
        else:
            self._trigrams_of.pop(eid, None)
```

In `src/data_rover/core/model/model.py`, replace the tail of `set_property`

```python
        target.properties[prop] = value
        target.rev += 1
        self.indexes.on_properties_changed(target)
```

with

```python
        old = target.properties.get(prop)
        target.properties[prop] = value
        target.rev += 1
        self.indexes.on_property_changed(target, prop, old)
```

and the tail of `delete_property`

```python
        if prop not in target.properties:
            return
        del target.properties[prop]
        target.rev += 1
        self.indexes.on_properties_changed(target)
```

with

```python
        if prop not in target.properties:
            return
        old = target.properties.pop(prop)
        target.rev += 1
        self.indexes.on_property_changed(target, prop, old)
```

- [ ] **Step 4: Run the tests to verify they pass, then the whole model/api test trees**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -v`
Expected: all PASS, including the five new tests.

Run: `pixi run -e core-dev pytest tests/model tests/validation tests/api/test_search_index_build.py tests/api/test_search_parity.py tests/api/test_read_routes.py tests/api/test_ops_route.py -q`
Expected: PASS. `test_search_parity.py` compares indexed search with the scan on a generated model after edits — the strongest end-to-end check of the diff.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/model/indexes.py src/data_rover/core/model/model.py tests/model/test_search_index.py
git commit -m "perf(indexes): on_property_changed diffs the search index from the changed value"
```

---

### Task 3: A cold element belongs to the chunked build — `_trigrams_of` entries mark ownership

**Files:**
- Modify: `src/data_rover/core/model/indexes.py` (module docstring `:25-33`; the `search_ready` and `_trigrams_of` comments in `__init__` `:142-164`; `on_element_deleted` `:283-294`; `on_properties_changed` (Task 2's version); `index_search_chunk` `:430-455`; `_update_trigrams` `:766-784`; `_update_trigrams_for` (Task 2's))
- Modify: `src/data_rover/api/search_index_build.py` (module docstring `:12-17`)
- Modify: `tests/model/test_search_index.py` (the docstring of `test_chunked_build_skips_hook_maintained_and_deleted_elements` `:173-177`; append three tests)

**Interfaces:**
- Consumes: Task 2's `_update_trigrams_for` and `on_properties_changed`.
- Produces: the invariant **`eid in IndexSet._trigrams_of` ⇔ the element's trigrams are indexed** (an empty tuple `()` when its text has no trigram); absence ⇔ bulk-loaded and not yet reached by the build. Private `IndexSet._builder_owned(element_id: str) -> bool`. Task 4 measures the effect (first touch of a cold element).

- [ ] **Step 1: Write the failing tests**

Append to `tests/model/test_search_index.py`:

```python
# ---------------------------------------------------------------------------
# ownership: a cold (bulk-loaded, not yet built) element is the builder's
# ---------------------------------------------------------------------------


def test_bulk_loaded_element_edit_is_left_to_the_builder() -> None:
    """Under a not-ready index the hooks maintain only what they own: an
    element the bulk load left unindexed is the chunked build's, which
    indexes its CURRENT text when it reaches it — never derived twice."""
    m = _bulk_loaded(["Pump", "Valve"])
    m.set_property(m.elements["bulk-0"], "name", "Compressor")
    assert "bulk-0" not in m.indexes._trigrams_of  # deferred
    assert m.indexes.search_postings == {}
    m.indexes.build_search_index()
    assert m.indexes.search_candidates("compressor") == {"bulk-0"}
    assert m.indexes.search_candidates("pump") == frozenset()
    m.indexes.verify_consistent()


def test_hook_created_element_is_indexed_while_not_ready() -> None:
    m = _bulk_loaded(["Pump"])
    created = _named(m, "Boiler")  # hook-owned from creation on
    assert created.id in m.indexes._trigrams_of
    m.set_property(created, "note", "turbine")  # diffed, not deferred
    assert created.id in _posting_ids(m, "tur")
    m.indexes.build_search_index()
    assert m.indexes.search_candidates("turbine") == {created.id}
    m.indexes.verify_consistent()


def test_indexed_element_keeps_an_entry_when_its_text_has_no_trigram() -> None:
    """An entry marks 'indexed' and must exist even when empty — otherwise a
    text-less element looks builder-owned and is skipped forever after it
    gains text."""
    m = Model(load_metamodel_str(MM.replace("Item", "It")))
    el = m.restore_element("e1", "It")  # id and type name both under 3 chars
    assert m.indexes._trigrams_of[el.id] == ()
    m.indexes.rebuild()  # bulk-load semantics: builder-owned again
    assert el.id not in m.indexes._trigrams_of
    m.set_property(el, "name", "Pump")  # deferred ...
    assert "pum" not in m.indexes.search_postings
    m.indexes.build_search_index()  # ... and picked up by the build
    assert m.indexes.search_candidates("pump") == {"e1"}
    m.set_property(el, "name", "ab")  # empty again: the entry stays
    assert m.indexes._trigrams_of[el.id] == ()
    m.indexes.verify_consistent()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -v -k "builder or not_ready or no_trigram"`
Expected: `test_bulk_loaded_element_edit_is_left_to_the_builder` FAILS at `assert "bulk-0" not in m.indexes._trigrams_of` (the hook indexes it today); `test_indexed_element_keeps_an_entry_when_its_text_has_no_trigram` FAILS at `_trigrams_of[el.id] == ()` with `KeyError` (sparse today); `test_hook_created_element_is_indexed_while_not_ready` PASSES (pins that the change does not over-defer).

- [ ] **Step 3: Implement ownership**

In `src/data_rover/core/model/indexes.py`:

(a) Module docstring — replace

```
The trigram search index (``search_postings`` / ``_trigrams_of``) is
maintained at that same boundary with the same obligations; it feeds
``search_candidates`` (the fuzzy-search candidate generator) and, like the
reference index, is diffed on ``on_properties_changed``. It is deliberately
NOT built by ``rebuild()`` (see that method) — ``search_ready`` says whether
it covers every element, and ``index_search_chunk``/``build_search_index``
(re)build it.
```

with

```
The trigram search index (``search_postings`` / ``_trigrams_of``) is
maintained at that same boundary with the same obligations; it feeds
``search_candidates`` (the fuzzy-search candidate generator) and, like the
reference index, is diffed on property change. It is deliberately NOT built
by ``rebuild()`` (see that method) — ``search_ready`` says whether it covers
every element, and ``index_search_chunk``/``build_search_index`` (re)build
it. Ownership is per element: ``_trigrams_of`` holds an entry for every
element whose trigrams are indexed, so an element WITHOUT one is the chunked
build's until it reaches it, and the property hooks leave it alone while
``search_ready`` is False.
```

(b) In `__init__`, replace the `search_ready` comment's last two sentences

```
        #: ``index_search_chunk`` + ``mark_search_ready``. The mutation hooks
        #: maintain postings regardless of this flag — that is what lets a
        #: chunked background build interleave with live edits.
```

with

```
        #: ``index_search_chunk`` + ``mark_search_ready``. The mutation hooks
        #: maintain postings for every element that has a ``_trigrams_of``
        #: entry and defer the rest to the build while this is False — that
        #: is what lets a chunked background build interleave with live edits
        #: without indexing anything twice.
```

and the `_trigrams_of` comment's sentence `No entry when the set would be empty (sparse).` with

```
        # An entry for EVERY indexed element — an empty tuple when its text
        # has no trigram — so absence means exactly "bulk-loaded and not yet
        # reached by the build" (see ``_builder_owned``).
```

(c) `on_element_deleted`: the entry must go even though the empty-set update is a no-op on an empty entry — replace

```python
        self._update_trigrams(element.id, frozenset())
        self.element_order.pop(element.id, None)
```

with

```python
        self._update_trigrams(element.id, frozenset())
        self._trigrams_of.pop(element.id, None)
        self.element_order.pop(element.id, None)
```

(d) Add the predicate right before `_element_trigrams` in the "internals: search trigrams" section:

```python
    def _builder_owned(self, element_id: str) -> bool:
        """True while the chunked search build still owns this element: the
        bulk load left it unindexed and the index is not ready yet. The hooks
        leave its trigrams alone — ``index_search_chunk`` indexes its CURRENT
        text when it reaches it — so nothing is derived twice."""
        return not self.search_ready and element_id not in self._trigrams_of
```

(e) `on_properties_changed` (the whole-element hook): replace its trigram line

```python
            self._update_trigrams(entity.id, self._element_trigrams(entity))
```

with

```python
            if not self._builder_owned(entity.id):
                self._update_trigrams(entity.id, self._element_trigrams(entity))
```

(f) `_update_trigrams_for`: replace its opening

```python
        eid = element.id
        cur = self._trigrams_of.get(eid)
        if cur is None:
            self._update_trigrams(eid, self._element_trigrams(element))
            return
```

with

```python
        eid = element.id
        cur = self._trigrams_of.get(eid)
        if cur is None:
            if not self.search_ready:
                return  # the chunked build owns it (see _builder_owned)
            self._update_trigrams(eid, self._element_trigrams(element))
            return
```

and its tail

```python
        if trigs:
            self._trigrams_of[eid] = tuple(trigs)
        else:
            self._trigrams_of.pop(eid, None)
```

with

```python
        self._trigrams_of[eid] = tuple(trigs)
```

(g) `_update_trigrams`: the early return on an unchanged set must still leave the marker behind (a fresh element whose id and type name are both under 3 chars arrives here with `new == old == ∅` and no entry), and the tail always writes. Replace

```python
        old = frozenset(self._trigrams_of.get(element_id) or ())
        if new == old:
            return
```

with

```python
        old = frozenset(self._trigrams_of.get(element_id) or ())
        if new == old:
            if element_id not in self._trigrams_of:
                self._trigrams_of[element_id] = ()  # no text, still indexed
            return
```

and its tail

```python
        if new:
            self._trigrams_of[element_id] = tuple(sorted(new))
        else:
            self._trigrams_of.pop(element_id, None)
```

with

```python
        self._trigrams_of[element_id] = tuple(sorted(new))
```

and extend its docstring's last sentence from `empty posting sets are deleted (sparse).` to `empty posting sets are deleted (sparse); the element's entry is always written, an empty tuple included — it marks the element as indexed (deletion pops it explicitly).`

(h) `index_search_chunk`: replace

```python
            trigs = self._element_trigrams(element)
            if not trigs:
                continue
            trigrams_of[eid] = tuple(sorted(trigs))
```

with

```python
            trigs = self._element_trigrams(element)
            trigrams_of[eid] = tuple(sorted(trigs))  # () marks it indexed too
```

and in its docstring replace `(an element the mutation hooks indexed after the caller snapshotted its id list)` with `(an element the mutation hooks own: created after the caller snapshotted its id list, or already reached)`.

In `src/data_rover/api/search_index_build.py`, replace the docstring paragraph

```
Correctness with concurrent edits: the IndexSet mutation hooks maintain
postings regardless of readiness, and ``index_search_chunk`` skips ids the
hooks already indexed or the model no longer holds, so the interleaving
converges on exactly what a synchronous full build produces. Readiness is
declared under the mutex only after the last chunk, and only if the session
still holds the model the build started on.
```

with

```
Correctness with concurrent edits: ownership is per element. The IndexSet
mutation hooks maintain postings for every element that has a
``_trigrams_of`` entry (created through the hooks, or already reached by a
chunk) and leave the rest — bulk-loaded, not yet reached — to this build,
which indexes each one's CURRENT text when its chunk lands and skips ids
that already have an entry or that the model no longer holds; so the
interleaving converges on exactly what a synchronous full build produces
without deriving any element twice. Readiness is declared under the mutex
only after the last chunk, and only if the session still holds the model
the build started on.
```

In `tests/model/test_search_index.py`, replace the docstring of `test_chunked_build_skips_hook_maintained_and_deleted_elements` with:

```python
    """The background builder's contract: ids are snapshotted up front, then
    indexed chunk by chunk while the mutation hooks keep running. An element
    edited before its chunk lands is left to that chunk (indexed once, with
    its current text); a hook-created one already has its entry (skipped, not
    duplicated); a deleted one is absent from the model (skipped)."""
```

- [ ] **Step 4: Run the tests to verify they pass, then everything that touches the search index**

Run: `pixi run -e core-dev pytest tests/model/test_search_index.py -v`
Expected: all PASS (the existing `test_short_fields_contribute_nothing`, `test_index_search_chunk_is_idempotent`, `test_rebuild_recomputes_from_scratch`, `test_delete_removes_all_postings` are the ones the entry rule could have disturbed — they must stay green unchanged).

Run: `pixi run -e core-dev pytest tests/model tests/api/test_search_index_build.py tests/api/test_search_parity.py tests/api/test_read_routes.py tests/api/test_hydration.py tests/api/test_commits_metamodel_ops.py tests/api/test_perf_probe.py -q`
Expected: PASS. `test_multi_chunk_build_skips_edited_and_deleted` (API) edits `e7` between chunks — it is now indexed by its chunk with the edited text; the assertions are on the final state and hold.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/model/indexes.py src/data_rover/api/search_index_build.py tests/model/test_search_index.py
git commit -m "perf(indexes): cold elements stay the search build's — _trigrams_of entries mark ownership"
```

---

### Task 4: Measure at scale 320

**Files:** none in the repo (the script and its output live in the session scratchpad). Output: numbers for Task 5's BACKLOG entry and Task 6's merge commit.

**Interfaces:**
- Consumes: Tasks 1–3 through the real core and applier (`build_model_from_dicts`, `Model.set_property/restore_element/delete_element`, `routes.ops._apply_batch`, `_check_patch_keys`, `IndexSet.build_search_index/verify_consistent`).
- Produces: `$SCRATCH/k23-numbers.md` with: first touch of a cold element (µs); warm `set_property` (µs); restore-style replay (µs per write); 200-batch tail cold / warm (ms); `_check_patch_keys` (µs); the correctness line. Compared against the spec's § "K-23 design" table ("Today" column: 129.8 / 75.8 / 54.5 µs; 736 / 409 ms; 2.49 µs).

- [ ] **Step 1: Locate or generate the production-scale fixture (~1 min; skip if it exists)**

The K-22 session's fixture may still be at `/tmp/claude-1000/-home-mdp-workspace-data-rover-py/4cabd46f-abde-4fbc-becd-17dee88a1256/scratchpad/prod.model.json`; if it is gone:

```bash
export SCRATCH=<the session scratchpad directory from the system prompt>
pixi run -e core-dev python examples/generate_large_model.py --scale 320 --out "$SCRATCH/prod.model.json"
```

- [ ] **Step 2: Time the four paths and check the index against a full build**

Write `$SCRATCH/measure_k23.py` (single file; run with a plain `pixi run -e core-dev python "$SCRATCH/measure_k23.py" <fixture path>` from the repo root; ~4 minutes, most of it the two full index builds at the end):

```python
"""K-23 measurement at scale 320: cold/warm property writes, replay tail, patch-key check."""

from __future__ import annotations

import sys
import time

sys.path.insert(0, "src")

import json  # noqa: E402

from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.routes.ops import _apply_batch, _check_patch_keys  # noqa: E402
from data_rover.api.schemas import ModelOpIn, UpdateElementOp  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_str  # noqa: E402

FIXTURE = sys.argv[1]
mm = load_metamodel_str(open("examples/smart-city.metamodel.yaml").read())
t0 = time.perf_counter()
model = build_model_from_dicts(mm, json.loads(open(FIXTURE).read()))
idx = model.indexes
print(f"load+build {time.perf_counter() - t0:.1f}s  {len(model.elements)} el / {len(model.relationships)} rel  search_ready={idx.search_ready}")

ids = list(model.elements)
step = max(1, len(ids) // 20000)
targets = [model.elements[ids[i]] for i in range(0, len(ids), step)]
targets = [e for e in targets if isinstance(e.properties.get("description"), str)]
half = len(targets) // 2

# 1. cold: never-indexed elements (search_ready False, no _trigrams_of entry)
t0 = time.perf_counter()
for el in targets[:half]:
    model.set_property(el, "description", f"{el.properties['description'][:40]} cold")
cold = (time.perf_counter() - t0) * 1e6 / half
assert all(el.id not in idx._trigrams_of for el in targets[:half]), "cold writes must defer to the build"
print(f"cold set_property (deferred): {cold:.1f} us/op")

# 2. warm: the same shape on indexed elements
idx.index_search_chunk([el.id for el in targets])
t0 = time.perf_counter()
for el in targets:
    model.set_property(el, "description", f"{el.properties['description'][:40]} warm")
warm = (time.perf_counter() - t0) * 1e6 / len(targets)
print(f"warm set_property (diffed): {warm:.1f} us/op")

# 3. restore-style replay: delete 4k elements, restore each with all its properties
r_ids = ids[len(ids) // 3 : len(ids) // 3 + 4000]
saved = {eid: (model.elements[eid].type_name, dict(model.elements[eid].properties)) for eid in r_ids}
for eid in r_ids:
    model.delete_element(eid)
n_props = 0
t0 = time.perf_counter()
for eid in r_ids:
    tn, props = saved[eid]
    el = model.restore_element(eid, tn)
    for k, v in props.items():
        model.set_property(el, k, v)
        n_props += 1
restore = (time.perf_counter() - t0) * 1e6 / n_props
print(f"restore replay: {restore:.1f} us per set_property ({n_props} writes)")

# 4. the 200-batch tail through the applier, cold then warm
ids = list(model.elements)
t_targets = [model.elements[ids[i]] for i in range(7, len(ids), max(1, len(ids) // 2000))][:2000]
batches: list[list[ModelOpIn]] = []
k = 0
for b in range(200):
    ops: list[ModelOpIn] = []
    for _ in range(10):
        el = t_targets[k % len(t_targets)]
        k += 1
        keys = [key for key, val in el.properties.items() if isinstance(val, str)][:3]
        ops.append(UpdateElementOp(kind="update_element", id=el.id, properties_patch={key: f"{el.properties[key][:40]} t{b}" for key in keys}))
    batches.append(ops)
t0 = time.perf_counter()
for ops in batches:
    _apply_batch(model, ops, restore=True)
tail_cold = (time.perf_counter() - t0) * 1000
idx.index_search_chunk([el.id for el in t_targets])
t0 = time.perf_counter()
for ops in batches:
    _apply_batch(model, ops, restore=True)
tail_warm = (time.perf_counter() - t0) * 1000
print(f"200-batch tail (10 update_element x 3 keys): cold {tail_cold:.0f} ms, warm {tail_warm:.0f} ms")

# 5. the API-layer key check
patch = {"name": "x", "description": "y", "status": "z"}
t0 = time.perf_counter()
for _ in range(20000):
    _check_patch_keys(model, "Person", element=True, patch=patch)
check = (time.perf_counter() - t0) * 1e6 / 20000
print(f"_check_patch_keys: {check:.2f} us/call")

# 6. correctness: full build, then diffed edits, then compare with a fresh build
t0 = time.perf_counter()
idx.rebuild()
idx.build_search_index()
print(f"rebuild + build_search_index {time.perf_counter() - t0:.1f}s")
sample = targets[:3000]
for i, el in enumerate(sample):
    nm = el.properties.get("name")
    model.set_property(el, "description", f"changed {i} zzq")
    if i % 3 == 0:
        model.set_property(el, "name", f"N{i} {nm}")
    if i % 4 == 0 and isinstance(nm, str):
        model.set_property(el, "description", nm)
    if i % 5 == 0:
        model.delete_property(el, "description")
    if i % 6 == 0:
        model.set_property(el, "name", "")
    if i % 7 == 0 and "tags" in el.properties:
        model.set_property(el, "tags", ["zzq", "listy"])
    if i % 8 == 0:
        model.set_property(el, "description", "ab")
bad = sum(1 for el in sample if frozenset(idx._trigrams_of.get(el.id) or ()) != idx._element_trigrams(el))
print(f"{bad} of {len(sample)} edited elements differ from a full derivation")
t0 = time.perf_counter()
idx.verify_consistent()
print(f"verify_consistent OK at {len(model.elements)} elements ({time.perf_counter() - t0:.1f}s)")
```

Run: `pixi run -e core-dev python "$SCRATCH/measure_k23.py" "$FIXTURE"`
Expected (from the spec's prototype column): cold ≈ **9 µs** (was 130), warm ≈ **39 µs** (was 76), restore replay ≈ **30 µs** (was 55), tail cold ≈ **150 ms** / warm ≈ **180 ms** (was 736 / 409), `_check_patch_keys` ≈ **0.3 µs** (was 2.5), `0 of 3000 ... differ`, `verify_consistent OK`. If cold is **> 20 µs** the deferral is not engaging (Task 3's `_builder_owned`/`cur is None` branch); if warm is **> 55 µs** the diff is falling back to the whole-element path (Task 2's guard); if `bad > 0` or `verify_consistent` raises, STOP — the diff is not exact; re-read Task 2 Step 3 against `_element_trigrams` before anything else.

- [ ] **Step 3: Record the numbers**

Write `$SCRATCH/k23-numbers.md` with the six figures next to the spec table's "Today" column, plus the correctness lines. Task 5 copies them into the BACKLOG, Task 6 into the merge commit. No commit in this task.

---

### Task 5: Docs and backlog

**Files:**
- Modify: `CLAUDE.md:55` (the `model/model.py` bullet) and `CLAUDE.md:82` (the paged-reads / fuzzy-search bullet)
- Modify: `BACKLOG.md:1060-1065` (`### K-23`) and the header paragraph at `BACKLOG.md:61-62`

**Interfaces:** none — prose only. Fill every `<…>` placeholder from `$SCRATCH/k23-numbers.md` (Task 4).

- [ ] **Step 1: CLAUDE.md**

In the `model/model.py` bullet (line 55), after the sentence ending `... never by comparing numbers to a fresh rebuild.`, insert:

```markdown
`set_property`/`delete_property` check the property name against `Metamodel.effective_*_property_names` (cached frozensets on `_Caches`, shared with `routes/ops.py::_check_patch_keys` — never a per-write list copy) and fire `IndexSet.on_property_changed(entity, prop, old_value)`, the single-property hook that diffs the search index from the changed value's text alone; `on_properties_changed(entity)` stays the whole-entity re-derivation for code that writes `entity.properties` directly.
```

In the paged-reads bullet (line 82), replace the clause `maintained at the mutation boundary like \`roots_order\`)` with:

```markdown
maintained at the mutation boundary like `roots_order`; ownership is per element — `_trigrams_of` holds an entry for every indexed element, an empty tuple included, so an element WITHOUT one is bulk-loaded and not yet reached by the chunked build, and the property hooks leave it to that build while `search_ready` is False instead of indexing it on first touch)
```

- [ ] **Step 2: BACKLOG.md**

Replace the `### K-23` heading and paragraph with:

```markdown
### K-23 · `Model.set_property`/`delete_property` copy the property list and build a name set per write · `done` (2026-08-27, perf/property-write-hot-path) · perf · *2026-08-26*
The spike said the list copy was 2.5 µs of a 76 µs write: ~85 % was `on_properties_changed`
re-deriving the element's WHOLE trigram set for one changed value (and 95 % of a 130 µs
first touch of a never-indexed element — the replay tail's case). Three legs:
`Metamodel.effective_*_property_names` (cached frozensets, shared with `_check_patch_keys`);
`IndexSet.on_property_changed(entity, prop, old_value)`, which diffs the search index from
the changed value's text (removal candidates verified by substring against the other fields,
the sorted tuple patched with `bisect`; whole-element fallback for list values) —
`verify_consistent` pins it byte-identical to a full build; and per-element ownership of
the search index (`_trigrams_of` entry ⇔ indexed, `()` included), so a bulk-loaded element
the chunked build has not reached is left to that build instead of being indexed on first
touch. Measured at scale 320: cold `set_property` **129.8 → <cold> µs**, warm
**75.8 → <warm> µs**, restore-style replay 54.5 → <restore> µs per write, a 200-batch
tail of 10 × 3-key `update_element` **736 → <tail_cold> ms** cold / 409 → <tail_warm> ms
warm, `_check_patch_keys` 2.49 → <check> µs; 0 of 3000 edited elements differ from a full
derivation and `verify_consistent` passes at 320k.
```

Then, in the header paragraph, append after `... closes K-22 (the maintained \`IndexSet.element_order\`; see its entry for the numbers).`:

```markdown
The 2026-08-27 pass on `perf/property-write-hot-path` closes K-23 (the per-property search-index
diff and cold-element ownership; see its entry for the numbers).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md BACKLOG.md
git commit -m "docs: property-write hot path — CLAUDE.md model/search notes, backlog (K-23 done)"
```

---

### Task 6: Full verification and integration

**Files:** none new.

- [ ] **Step 1: Lint/format/typecheck**

Run: `pixi run dr-tidy`
Expected: ruff, mypy, pyright, prettier and eslint all pass. Likely fixes: ruff reformatting the long `words = [...]` literal or an `assert` line in the new tests; pyright wanting `old_value: Any` on the new hook signatures (`Any` is already imported in `indexes.py`). Amend into the relevant commit or add a `chore:` commit.

- [ ] **Step 2: Whole suites**

Run: `pixi run core-test`
Expected: PASS, count = the `main` baseline recorded at branch creation (2268 passed / 31 deselected as of the K-22 merge) + 11 new tests (Task 1: 3, Task 2: 5, Task 3: 3), zero new skips.

Run: `pixi run frontend-test`
Expected: PASS (no frontend files changed; this proves it).

- [ ] **Step 3: Re-run the Task 4 measurement on the final tree**

Run: `pixi run -e core-dev python "$SCRATCH/measure_k23.py" "$FIXTURE"`
Expected: numbers within noise of Task 4's; the two correctness lines unchanged.

- [ ] **Step 4: Integrate**

Use `superpowers:finishing-a-development-branch`: `ExitWorktree keep`, re-check `git log --oneline origin/main -3` (a concurrent session may have moved `main`), merge `perf/property-write-hot-path` into `main` with a merge commit whose body carries the Task 4 numbers, run `pixi run core-test` on the merged result, push `main`, remove the worktree and delete the branch. The finishing skill's menu is answered by the standing policy (merge commit + push) when the user is absent. Leave `.claude/worktrees/feat-metamodel-diagram-editor` alone — it belongs to someone else.

---

### Task 7: Hand off to the next plan (K-24 — untyped navigation scope sort)

**Files:** none in the repo (the handoff lives in `~/.claude/handoffs/`).

- [ ] **Step 1: Reconstruct state**

Run: `git status --short`, `git branch --show-current`, `git log --oneline -5`, `pixi run core-test -q | tail -3` (as separate plain commands if the harness refuses the chain).

- [ ] **Step 2: Invoke the handoff skill**

Invoke `handoff` (the `Skill` tool, name `handoff`). Fill its sections with these facts (pointers, not payload):

- **Mission:** the large-model performance program from `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program"); K-20, K-6, K-21, K-22 and K-23 are merged; the next session writes and executes the plan for **K-24** (`core/navigation/evaluate.py:244-245`: `set(model.elements.keys())` + criteria filter + `sorted()` of ~300k ids for a table/navigation with no `types`, on the first table request after every commit — `TableOrderCache` is rev-keyed), then hands off to K-25 — every plan's last task is this same handoff step. "Done" = a § "K-24 design" section in the spec, a plan written, executed on a worktree branch, measured at scale 320, merged into `main` with a merge commit, pushed, handoff delivered.
- **Orient First:** the spec above (§ "Program" item 6; § "K-23 design" as the freshest design-section shape — K-24 has none yet, writing one is part of the job); `BACKLOG.md` K-24 → K-25; `src/data_rover/core/navigation/evaluate.py:244` (the untyped `set(model.elements.keys())` branch) and `src/data_rover/core/table/evaluate.py::resolve_source_elements` (its caller); `src/data_rover/api/routes/tables.py` (`TableOrderCache`); `src/data_rover/core/model/indexes.py` (`elements_by_type`, `element_order` — an insertion-order index already exists; whether the untyped scope's sort can be served from it is the first question); `src/data_rover/core/table/nav_memo.py`; `tests/navigation/`, `tests/table/`; this plan (`docs/superpowers/plans/2026-08-27-property-write-hot-path.md`) as the SHAPE to match; `CLAUDE.md`.
- **Standing Constraints:** K-23 (new): `_trigrams_of` entry ⇔ indexed (an empty tuple included; deletion pops it explicitly) — never make it sparse again, never index a builder-owned element from a hook while `search_ready` is False, and `on_property_changed`'s diff is exact ONLY for plain-string values with no list-valued `name` key — every other case must fall back to the whole-element path; K-22 (`element_order` maintained by the two element hooks only; order-only semantics); K-21 (bytes-sniffing snapshot reader; `iter_model_json` stays the save contract); K-20 (no search index on transient models; `keep_search=True` only at the four rebind sites); K-6 (`entity_states` NULL = reconstruct); `Metamodel` immutable with lazily-built `_Caches`; per-entity validator hooks O(entity); `docs/` gitignored; pixi for everything; merge-commit integration + push; `pixi run frontend-install` before `dr-tidy` in a fresh worktree; worktree harness guard; ruff does NOT enforce import order; `main` can move — re-check before merge/push. SDD model choices: haiku for transcription tasks carrying literal code, sonnet for logic/measurement tasks and per-task reviews, the most capable model for the final review.
- **Known Issues, Not Yet Fixed:** K-24 → K-25 as listed in the BACKLOG; the ~11 µs per-write floor and the applier's ~15 µs per op (record only); `_rekey`'s `_frozen(properties)` for keyless types (largest of the remaining per-write costs, ~8 µs — record only); `ENTITY_STATES_MAX` is an entity-count cap (`api/commit_states.py:36`); snapshot blob GC (`content.py`); four tests call `schedule_periodic_snapshot` without `write_mutex`; `snapshot_job` can record a row ahead of `models.model_rev` after a legacy `touch_model()`; `scripts/bench.py:208` pyright note; the sweep's remaining ~33 ms per element chunk.
- **Deferred — Do Not Do:** a bulk `restore_element(..., properties=...)`; diffing refs/rekey/roots per property; the `zip(s, s[1:], s[2:])` trigram idiom (measured no faster); per-field trigram storage; bypassing the hooks entirely under `search_ready=False` (ownership is per element, not global); everything K-22/K-21/K-20/K-6 already deferred (folding the sequence number into `uniq_groups`, a sequence field on `Element`, the per-sweep position-map hoist, zstd, an `encoding` column, posting-set shrinking, `entity_states` backfill, journal-based `GET /commits/{rev}/model`).
- **Plan:** 1. Read the spec's § "Program" item 6 and `BACKLOG.md` K-24, then `evaluate.py:244-245` and its callers, `TableOrderCache`, and `IndexSet.element_order` — spike at scale 320 how much of the first-request cost is the `set(keys)`, the criteria filter and the `sorted()` respectively, and whether `element_order` (or `elements_by_type` for the typed case) can serve the order without a sort. 2. Append § "K-24 design" (Problem with the spike table / Design / Non-goals) to the spec. 3. Write `docs/superpowers/plans/<date>-untyped-navigation-scope.md` with `superpowers:writing-plans` in this plan's shape. 4. Execute with `superpowers:subagent-driven-development` on `perf/untyped-navigation-scope`; do the pre-flight conflict scan as a table (as this plan's header does). 5. Verify + measure + merge commit + push, then hand off to K-25.
- **Open Questions:** none blocking. Record: what the untyped scope's sort key is (id? `element_order`? display name?) — if it is insertion order, K-22's index answers it in O(n) without a sort; if it is by id, the question is whether the consumer needs a sort at all.

- [ ] **Step 3: Deliver**

Reply exactly as the handoff skill prescribes: the file path, the one-line paste command, and the full handoff in one fenced block.
