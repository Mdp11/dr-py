# Snippet API Stereotype Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the snippet-visible `dr` facade: everything "type" becomes "stereotype", `dr.types()`/`dr.type()` are removed, `dr.elements(stereotypes=...)` takes a list, `Element.name` is fixed via core naming, `in_()`/`out()` become `incoming()`/`outgoing()` with stereotype filters and an `expected=` cardinality assertion, and hops return a real `Relationship` class.

**Architecture:** Facade-surface-only rename (spec: `docs/superpowers/specs/2026-07-22-snippet-api-stereotype-rename-design.md`). The guest↔host wire protocol keys (`"type"`, `"type_name"`), read-set tags, memo-key shapes, and `api/invalidation.py` are all unchanged. Hop filtering happens guest-side over the memoized unfiltered hop response; inheritance expansion comes from one new internal bridge op (`descendants`) backed by a new cached `Metamodel.relationship_descendants`. Hard break: no aliases for the old names.

**Tech Stack:** Python 3.14 via pixi (`pixi run -e core-dev pytest`), facade is a plain-Python source string (`FACADE_SOURCE`) exec'd in the guest, SvelteKit + vitest frontend.

## Global Constraints

- Everything runs through pixi: `pixi run -e core-dev pytest tests/...`, `pixi run core-lint`, frontend via `pixi run -e frontend bash -c 'cd frontend && npm test'`. There is no global `python`/`node`.
- `FACADE_SOURCE` must stay plain, stdlib-only, Python 3.10-compatible source with **no imports** — it's exec'd inside the WASM guest. Never `import data_rover` inside the string.
- `bridge.py` imports only `data_rover.core.*` + stdlib (never `data_rover.api.*`).
- The memo copy-on-return invariant is load-bearing: every projection handed to snippet code must go through `_copy_projection`, never alias `_memo` entries.
- Read-set tag names (`"scan"`, `"el"`, `"out"`, `"in"`, `"children"`, `"parent"`) and memo-key shapes must NOT change. New far-element reads must be recorded via `_note_read("el", id)` (they are — `_fetch_element` does it).
- Wire protocol keys stay `"type"` / `"type_name"` / `"source_id"` / `"target_id"`.
- Preserve the dense why-docstring style in touched core files.
- Commit style: `feat(script): ...` / `fix(script): ...` / `test(script): ...` matching recent history.
- The docs tripwire (`core/script/docs.py`) hard-fails on an undocumented public facade member: every new public facade method/property MUST have a docstring, with an `Example:` block where the existing members have one.

---

### Task 1: `Metamodel.relationship_descendants`

**Files:**
- Modify: `src/data_rover/core/metamodel/schema.py` (`_Caches` dataclass ~line 149, `_build_caches` ~line 278, accessor next to `element_descendants` ~line 428)
- Test: `tests/metamodel/test_navigation_caches.py`

**Interfaces:**
- Consumes: existing `_Caches` / `_build_caches` machinery.
- Produces: `Metamodel.relationship_descendants(name: str) -> frozenset[str]` — `name` plus every transitive relationship subtype; `frozenset()` for unknown names. Task 3's bridge `descendants` op calls this.

- [ ] **Step 1: Write the failing tests**

Append to `tests/metamodel/test_navigation_caches.py`:

```python
def _rel_mm() -> Metamodel:
    return Metamodel(
        elements=[ElementType(name="Thing")],
        relationships=[
            RelationshipType(name="Rel", abstract=True, source="Thing", target="Thing"),
            RelationshipType(name="Owns", extends="Rel", source="Thing", target="Thing"),
            RelationshipType(name="Rents", extends="Owns", source="Thing", target="Thing"),
            RelationshipType(name="Feeds", source="Thing", target="Thing"),
        ],
    )


def test_relationship_descendants_include_self_and_transitive_subtypes() -> None:
    mm = _rel_mm()
    assert mm.relationship_descendants("Rel") == frozenset({"Rel", "Owns", "Rents"})
    assert mm.relationship_descendants("Owns") == frozenset({"Owns", "Rents"})
    assert mm.relationship_descendants("Rents") == frozenset({"Rents"})
    assert mm.relationship_descendants("Feeds") == frozenset({"Feeds"})


def test_relationship_descendants_unknown_type_is_empty() -> None:
    assert _rel_mm().relationship_descendants("Nope") == frozenset()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/metamodel/test_navigation_caches.py -v -k relationship_descendants`
Expected: FAIL with `AttributeError: 'Metamodel' object has no attribute 'relationship_descendants'`

- [ ] **Step 3: Implement**

In `src/data_rover/core/metamodel/schema.py`:

(a) `_Caches` — add a field right after `element_descendants`:

```python
    element_descendants: dict[str, frozenset[str]]
    relationship_descendants: dict[str, frozenset[str]]
```

(b) `_build_caches` — the relationship ancestor sets are currently built inline in the `_Caches(...)` constructor call; hoist them so the downward closure can reuse them. Just above the `return _Caches(` statement add:

```python
    relationship_ancestor_sets = {
        n: frozenset(c) for n, c in relationship_ancestors.items()
    }
    # downward closure for relationship types, mirroring `descendants` above
    rel_descendants: dict[str, set[str]] = {n: set() for n in rel_types_by_name}
    for name, ancestors in relationship_ancestor_sets.items():
        for ancestor in ancestors:
            rel_descendants[ancestor].add(name)
```

then in the constructor call replace the inline
`relationship_ancestor_sets={n: frozenset(c) for n, c in relationship_ancestors.items()},`
with `relationship_ancestor_sets=relationship_ancestor_sets,` and add after
`element_descendants=...,`:

```python
        relationship_descendants={
            n: frozenset(s) for n, s in rel_descendants.items()
        },
```

(c) Accessor on `Metamodel`, directly below `element_descendants`:

```python
    def relationship_descendants(self, name: str) -> frozenset[str]:
        """`name` plus every transitive relationship subtype (empty for
        unknown names).

        The downward complement of `relationship_ancestors`, mirroring
        `element_descendants`; used by the snippet bridge's `descendants` op
        to expand hop stereotype filters over inheritance.
        """
        return self._caches().relationship_descendants.get(name, frozenset())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/metamodel/ -v`
Expected: all PASS (new tests plus no regressions in the metamodel suite)

- [ ] **Step 5: Lint and commit**

```bash
pixi run core-lint
git add src/data_rover/core/metamodel/schema.py tests/metamodel/test_navigation_caches.py
git commit -m "feat(metamodel): cached relationship_descendants downward closure"
```

---

### Task 2: Bridge `Element.name` fix (`name_of` resolution)

**Files:**
- Modify: `src/data_rover/core/script/bridge.py` (`_project_element`, ~line 101)
- Test: `tests/script/test_bridge.py`

**Interfaces:**
- Consumes: `data_rover.core.model.naming.name_of(element) -> str | None` (exists).
- Produces: element projections whose `"name"` uses case-insensitive `name`/`Name`/`NAME` resolution (list-valued names contribute their first non-empty entry), `None` when absent. The facade's `Element.name` needs no change — it already reads `self._data["name"]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_bridge.py` (reuse its existing imports of `Metamodel`/`ElementType`/`PropertyDef`/`Model`/`BridgeDispatcher`; add any missing ones matching `tests/script/conftest.py`'s import style):

```python
def _cased_name_model() -> Model:
    mm = Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[PropertyDef(name="Name", datatype="string")],
            ),
        ],
        relationships=[],
    )
    model = Model(mm)
    model.restore_element("cased", "Building")
    model.set_property("cased", "Name", "Cased Name")
    model.restore_element("unnamed", "Building")
    return model


def test_projection_name_resolves_cased_name_property() -> None:
    d = BridgeDispatcher(_cased_name_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "element", "element_id": "cased"})
    assert resp.get("error") is None
    assert resp["element"]["name"] == "Cased Name"


def test_projection_name_is_none_when_unnamed() -> None:
    d = BridgeDispatcher(_cased_name_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "element", "element_id": "unnamed"})
    assert resp.get("error") is None
    assert resp["element"]["name"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_bridge.py -v -k projection_name`
Expected: `test_projection_name_resolves_cased_name_property` FAILS (`assert None == "Cased Name"`); the unnamed test passes already.

- [ ] **Step 3: Implement**

In `bridge.py`, add to the existing relative imports:

```python
from ..model.naming import name_of
```

and change `_project_element`:

```python
def _project_element(element: Element) -> dict[str, Any]:
    """Element -> plain dict: `{"id", "type", "name", "properties"}`.

    `name` is a display convenience resolved via `core.model.naming.name_of`
    — the same case-insensitive `name`/`Name`/`NAME` resolution the tree/
    search/table code uses (list-valued names contribute their first
    non-empty entry), `None` when no usable name property exists. The full
    property bag is still there under `"properties"` for a snippet that
    needs more than the display name.
    """
    return {
        "id": element.id,
        "type": element.type_name,
        "name": name_of(element),
        "properties": dict(element.properties),
    }
```

`_project_relationship` keeps its bare `properties.get("name")` (the `Relationship` facade class does not expose `.name`; spec decision).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/script/ -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
pixi run core-lint
git add src/data_rover/core/script/bridge.py tests/script/test_bridge.py
git commit -m "fix(script): Element.name uses core name_of resolution (Name/NAME casings, list values)"
```

---

### Task 3: Bridge: multi-stereotype `elements_page`, new `descendants` op, drop `types`/`type_info`

**Files:**
- Modify: `src/data_rover/core/script/bridge.py` (`_op_elements_page` ~line 255, `_op_types`/`_op_type_info` ~line 370, `_read_ops` registry ~line 202, module docstring read-op list ~line 12)
- Test: `tests/script/test_bridge.py`

**Interfaces:**
- Consumes: `Metamodel.element_descendants`, `Metamodel.relationship_descendants` (Task 1), `Metamodel.element_type`, `Metamodel.relationship_type`.
- Produces (wire protocol, consumed by Tasks 4–5 facade code):
  - `{"op": "elements_page", "type": None | str | list[str], "offset": int, "limit": int}` → unchanged response shape; a list unions the descendant-expanded stereotypes; `[]` yields an empty page.
  - `{"op": "descendants", "kind": "element" | "relationship", "name": str}` → `{"descendants": list[str]}` (sorted); unknown name raises `KeyError` (→ guest `NotFoundError`); bad kind raises `ValueError`.
  - `types` / `type_info` ops removed — dispatching them now returns the standard `unknown op` error response.

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_bridge.py` (uses `tiny_model` from `tests/script/conftest.py` — one `Building` element type, `Owns` relationship, elements `b1`/`b2`/`b3`):

```python
def test_elements_page_accepts_type_list() -> None:
    d = BridgeDispatcher(tiny_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "elements_page", "type": ["Building"], "offset": 0})
    assert resp.get("error") is None
    assert {e["id"] for e in resp["elements"]} == {"b1", "b2", "b3"}


def test_elements_page_empty_type_list_yields_no_elements() -> None:
    d = BridgeDispatcher(tiny_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "elements_page", "type": [], "offset": 0})
    assert resp.get("error") is None
    assert resp["elements"] == []
    assert resp["next_offset"] is None


def test_descendants_op_element_kind() -> None:
    d = BridgeDispatcher(tiny_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "descendants", "kind": "element", "name": "Building"})
    assert resp.get("error") is None
    assert resp["descendants"] == ["Building"]


def test_descendants_op_relationship_kind() -> None:
    d = BridgeDispatcher(tiny_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "descendants", "kind": "relationship", "name": "Owns"})
    assert resp.get("error") is None
    assert resp["descendants"] == ["Owns"]


def test_descendants_op_unknown_name_is_keyerror() -> None:
    d = BridgeDispatcher(tiny_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "descendants", "kind": "element", "name": "Nope"})
    assert resp["error"].startswith("KeyError")


def test_descendants_op_bad_kind_is_error() -> None:
    d = BridgeDispatcher(tiny_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "descendants", "kind": "bogus", "name": "Building"})
    assert resp["error"].startswith("ValueError")


def test_types_and_type_info_ops_are_gone() -> None:
    d = BridgeDispatcher(tiny_model(), record_ops=False)
    assert "unknown op" in d.dispatch({"id": 1, "op": "types"})["error"]
    assert "unknown op" in d.dispatch({"id": 2, "op": "type_info", "type": "Building"})["error"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_bridge.py -v -k "type_list or descendants or types_and"`
Expected: FAIL (list `type` unhashable in `element_descendants` or empty result; `unknown op 'descendants'`; `types` still answers).

- [ ] **Step 3: Implement**

In `bridge.py`:

(a) `_op_elements_page` — replace the `type_name`/`allowed_types` head:

```python
    def _op_elements_page(self, req: dict[str, Any]) -> dict[str, Any]:
        # `type` is None (no filter), a single stereotype name, or a list of
        # names (facade sends a list since the stereotypes= rework); each
        # name expands to its descendant closure, lists union them. An empty
        # list is a real filter matching nothing — distinct from None.
        type_names = req.get("type")
        offset = max(0, int(req.get("offset") or 0))
        raw_limit = req.get("limit")
        limit = self.page_limit if raw_limit is None else int(raw_limit)
        limit = max(0, min(limit, self.page_limit))

        if type_names is None:
            allowed_types: set[str] | None = None
        else:
            if isinstance(type_names, str):
                type_names = [type_names]
            allowed_types = set()
            for name in type_names:
                allowed_types.update(self.metamodel.element_descendants(name))
        candidates = (
            self.model.elements.values()
            if allowed_types is None
            else (
                e for e in self.model.elements.values() if e.type_name in allowed_types
            )
        )
```

(rest of the method unchanged).

(b) Replace `_op_types` and `_op_type_info` with:

```python
    def _op_descendants(self, req: dict[str, Any]) -> dict[str, Any]:
        """Descendant closure for a stereotype — internal support for the
        facade's inheritance-aware filters (`dr.elements(stereotypes=...)`
        expands host-side in `_op_elements_page`; hop filters expand
        guest-side from this op). `kind` disambiguates the two type
        namespaces. Unknown names raise KeyError (guest `NotFoundError`) so
        a typo'd filter surfaces instead of silently matching nothing."""
        kind = req.get("kind")
        name = req["name"]
        if kind == "element":
            if self.metamodel.element_type(name) is None:
                raise KeyError(f"Unknown element stereotype {name!r}")
            return {"descendants": sorted(self.metamodel.element_descendants(name))}
        if kind == "relationship":
            if self.metamodel.relationship_type(name) is None:
                raise KeyError(f"Unknown relationship stereotype {name!r}")
            return {
                "descendants": sorted(self.metamodel.relationship_descendants(name))
            }
        raise ValueError(f"descendants: unknown kind {kind!r}")
```

(c) `_read_ops` registry: remove the `"types"` and `"type_info"` entries, add `"descendants": self._op_descendants`.

(d) Module docstring: update the read-op enumeration (line ~12) from
`(`element`, `elements_page`, `outgoing`, `incoming`, `parent`, `children`, `types`, `type_info`)` to
`(`element`, `elements_page`, `outgoing`, `incoming`, `parent`, `children`, `descendants`)`.

- [ ] **Step 4: Run tests — expect collateral facade failures, fix ONLY bridge tests here**

Run: `pixi run -e core-dev pytest tests/script/test_bridge.py -v`
Expected: PASS. (The facade still calls `types`/`type_info` — full-suite green returns in Task 4; do not run the whole suite as a gate here.)

- [ ] **Step 5: Commit**

```bash
pixi run core-lint
git add src/data_rover/core/script/bridge.py tests/script/test_bridge.py
git commit -m "feat(script): bridge multi-stereotype elements_page + descendants op; drop types/type_info"
```

---

### Task 4: Facade rename — `stereotype` surface, `dr.elements(stereotypes=...)`, remove `dr.types()`/`dr.type()`

**Files:**
- Modify: `src/data_rover/core/script/facade_src.py` (FACADE_SOURCE string)
- Modify: `src/data_rover/core/script/docs.py` (`_RETURNS` map only)
- Modify: `src/data_rover/api/invalidation.py` (docstring mention of `dr.elements()` — comment-only)
- Test: `tests/script/test_trusted_runner.py`, `tests/script/test_docs.py`, `tests/script/test_read_sets.py`, plus a grep-driven sweep (Step 6) over `tests/` for the renamed spellings.

**Interfaces:**
- Consumes: Task 3's `elements_page` list support (wire key stays `"type"`).
- Produces (snippet-visible API, used by every later task):
  - `Element.stereotype` property (replaces `Element.type`; `_data["type"]` underneath; repr becomes `Element(id=..., stereotype=...)`).
  - `dr.elements(stereotypes=None)` — `None | str | list[str]`; records `("scan", s)` per requested name (or `("scan", None)` when unfiltered).
  - `dr.create(stereotype, properties=None)`, `dr.connect(stereotype, source_id, target_id, properties=None)` — parameter renamed; recorded op keeps wire key `"type_name"`.
  - `dr.types` / `dr.type` gone (`AttributeError` from snippet code).

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_trusted_runner.py`:

```python
def test_element_stereotype_property_and_repr():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="el = dr.element('b1')\nresult = (el.stereotype, repr(el))"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "('Building', \"Element(id='b1', stereotype='Building')\")"


def test_element_type_attribute_is_gone():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="result = dr.element('b1').type"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"


def test_elements_accepts_stereotypes_list():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="result = sorted(e.id for e in dr.elements(stereotypes=['Building']))"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "['b1', 'b2', 'b3']"


def test_elements_accepts_single_stereotype_string():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="result = len(list(dr.elements(stereotypes='Building')))"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "3"


def test_dr_types_and_dr_type_are_gone():
    r = TrustedRunner()
    res = r.run(tiny_model(), RunRequest(code="result = dr.types()"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    res = r.run(tiny_model(), RunRequest(code="result = dr.type('Building')"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
```

Append to `tests/script/test_read_sets.py` (follow its existing `_call` helper conventions — read the file's helper first and match it):

```python
def test_multi_stereotype_scan_records_one_tag_per_name():
    res = _call(
        "def value(els):\n"
        "    return len(list(dr.elements(stereotypes=['Building'])))\n",
        ["b1"],
    )
    assert ["scan", "Building"] in res.reads
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_trusted_runner.py tests/script/test_read_sets.py -v -k "stereotype or stereotypes or types_and"`
Expected: FAIL (`stereotype` attribute missing, `stereotypes=` unexpected keyword).

- [ ] **Step 3: Rewrite the facade pieces**

In `FACADE_SOURCE` (`facade_src.py`):

(a) `Element.type` property → `stereotype` (data key unchanged):

```python
    @property
    def stereotype(self):
        """The element's stereotype (type) name."""
        return self._data["type"]
```

and `__repr__`:

```python
    def __repr__(self):
        return "Element(id=" + repr(self.id) + ", stereotype=" + repr(self.stereotype) + ")"
```

(b) Replace `_iter_elements` (the read-set note comment above it stays):

```python
def _iter_elements(stereotypes=None):
    """Iterate all elements, optionally filtered by stereotype name(s).

    `stereotypes` is a single name or a list of names; matches include
    subtypes of each named stereotype. Pages transparently.

    Example:
        for el in dr.elements(stereotypes="Building"):
            print(el.name)
    """
    if stereotypes is None:
        names = None
        _note_read("scan", None)
    else:
        names = [stereotypes] if isinstance(stereotypes, str) else list(stereotypes)
        for s in names:
            _note_read("scan", s)
    offset = 0
    while True:
        resp = _read("elements_page", type=names, offset=offset, limit=500)
        for item in resp["elements"]:
            yield Element(item)
        next_offset = resp.get("next_offset")
        if next_offset is None:
            return
        offset = next_offset
```

(c) Delete `_list_types` and `_type_info` entirely; in `_Dr` remove the `types = staticmethod(_list_types)` and `type = staticmethod(_type_info)` lines.

(d) Rename the first parameter of `_create` and `_connect` to `stereotype` (docstrings updated; the recorded op dict keeps `"type_name": stereotype`):

```python
def _create(stereotype, properties=None):
    """Record a dry-run element create. Returns a temp id usable in dr.connect
    and dr.element within this run.

    Example:
        tid = dr.create("Building", {"name": "HQ"})
    """
    temp_id = _next_temp_id()
    resp = _write({
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": stereotype,
        "properties": dict(properties) if properties else {},
    })
    return resp.get("temp_id", temp_id)
```

(`_connect` analogous: `def _connect(stereotype, source_id, target_id, properties=None)`, wire `"type_name": stereotype`.)

(e) Sweep the rest of FACADE_SOURCE's docstrings/comments for the old spellings: `out()`'s docstring says `rel["type"]` — leave the hop methods alone in this task (Task 5 rewrites them); update `_fetch_element`/`Element` docstrings if they mention "type".

(f) `docs.py` `_RETURNS`: delete the `"dr.types"` and `"dr.type"` entries; rename key `"Element.type"` → `"Element.stereotype"`; change `"Element.name"` value to `"str | None"`.

(g) `api/invalidation.py` module docstring: `dr.elements()` mention stays valid; update any `type=`-spelled example if present (comment-only change).

- [ ] **Step 4: Grep-driven sweep of existing tests (old spellings in snippet-code strings)**

Run each grep; update every hit. These are snippet-code strings inside tests — the substitutions are exactly:

| Old | New |
| --- | --- |
| `el.type` / `e.type` / `.type` on a facade Element in snippet strings | `.stereotype` |
| `dr.elements(type='X')` / `dr.elements(type="X")` | `dr.elements(stereotypes='X')` |
| `dr.types()` / `dr.type('X')` in snippet strings | delete the test or rewrite against the new API (most such tests become the removal tests from Step 1) |
| `Element.type` in docs-name assertions | `Element.stereotype` |

```bash
grep -rn "el\.type\b\|e\.type\b\|\.type," tests/ --include="*.py" | grep -v type_name | grep -v __pycache__
grep -rn "elements(type=" tests/ src/ --include="*.py" | grep -v __pycache__
grep -rn "dr\.types()\|dr\.type(" tests/ --include="*.py" | grep -v __pycache__
grep -rn '"Element.type"\|Element\.type\b' tests/ --include="*.py" | grep -v __pycache__
```

Known files with hits (verify with the greps — do not trust this list blindly): `tests/script/test_trusted_runner.py`, `tests/script/test_read_sets.py`, `tests/script/test_trip_counts.py`, `tests/script/test_docs.py`, `tests/api/test_snippets_routes.py`, `tests/api/test_script_embedding_routes.py`, `tests/api/test_script_cell_cache_api.py`, `tests/api/test_script_sweep_perf.py`, `tests/api/test_script_sweep_wasm.py`, `tests/api/test_snippets_wasm.py`, `tests/api/test_incremental_invalidation.py`, `tests/api/test_tables_routes.py`, `tests/api/test_table_export.py`, `tests/api/test_tables_script_status.py`, `tests/table/test_script_column.py`, `tests/navigation/test_script_step.py`, `tests/script/test_session.py`, `tests/script/test_embed_cache.py`, `tests/script/test_cell_cache.py`.

`tests/script/test_docs.py` also asserts the public-name list: remove `dr.types`/`dr.type`, rename `Element.type` → `Element.stereotype` there.

- [ ] **Step 5: Run the full Python suite**

Run: `pixi run core-test`
Expected: all PASS. (WASM `integration`-marked tests auto-skip without the guest binary; if the binary is fetched, they must pass too.)

- [ ] **Step 6: Commit**

```bash
pixi run core-lint
git add -A src/data_rover tests
git commit -m "feat(script)!: stereotype facade surface; dr.elements(stereotypes=...); drop dr.types/dr.type"
```

---

### Task 5: `Relationship` class + `incoming()`/`outgoing()` with filters and `expected=`

**Files:**
- Modify: `src/data_rover/core/script/facade_src.py`
- Modify: `src/data_rover/core/script/docs.py` (`_RETURNS` only; class walk is Task 6)
- Test: `tests/script/test_trusted_runner.py` (new behavior), `tests/script/test_trip_counts.py` (zero-trip + memo), `tests/script/test_read_sets.py` (far-element reads), plus grep sweep for `.out()` / `.in_()` / rel-dict access.

**Interfaces:**
- Consumes: Task 3's `descendants` op; existing `_memo`/`_copy_projection`/`_fetch_element`/`_note_read`.
- Produces (snippet-visible):
  - `class Relationship`: `.id`, `.stereotype` (properties), `rel[key]`, `.get(key, default=None)`, `.props()`, `.source() -> Element`, `.destination() -> Element`, `repr` `Relationship(id=..., stereotype=...)`.
  - `Element.outgoing(stereotype=None, other_stereotype=None, expected=None)` / `Element.incoming(...)` → `list[Relationship]`, or a single `Relationship` when `expected == 1`. `Element.out`/`Element.in_` gone.
  - `CardinalityError(BridgeError)`, exposed as `dr.CardinalityError`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_trusted_runner.py`:

```python
def test_outgoing_returns_relationship_objects():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b1').outgoing()[0]\n"
                    "result = (rel.stereotype, rel.source().id, rel.destination().id)"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "('Owns', 'b1', 'b2')"


def test_relationship_get_props_and_getitem():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b1').outgoing()[0]\n"
                    "result = (rel.get('missing', 'dflt'), rel.props())"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "('dflt', {})"


def test_old_hop_names_are_gone():
    r = TrustedRunner()
    for code in ("dr.element('b1').out()", "dr.element('b1').in_()"):
        res = r.run(tiny_model(), RunRequest(code="result = " + code),
                    RunLimits(), record_ops=False, rev=0)
        assert res.error is not None and res.error.kind == "runtime"


def test_hop_filter_by_relationship_stereotype():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "el = dr.element('b1')\n"
                    "result = (len(el.outgoing(stereotype='Owns')),\n"
                    "          len(el.outgoing(stereotype=['Owns'])))"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    # tiny_model() has exactly one Owns rel out of b1; str and list filter
    # forms must agree.
    assert res.result_repr == "(1, 1)"


def test_hop_filter_unknown_stereotype_raises_notfound():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="result = dr.element('b1').outgoing(stereotype='Nope')"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    assert "NotFoundError" in res.error.message


def test_hop_filter_by_other_stereotype():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "el = dr.element('b1')\n"
                    "result = (len(el.outgoing(other_stereotype='Building')),\n"
                    "          len(el.incoming(other_stereotype='Building')))"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "(1, 0)"


def test_expected_returns_single_relationship():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b1').outgoing(expected=1)\n"
                    "result = rel.destination().id"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "'b2'"


def test_expected_mismatch_is_informative_cardinality_error():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="dr.element('b3').outgoing(expected=1)"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    assert "CardinalityError" in res.error.message
    assert "'b3'" in res.error.message
    assert "outgoing" in res.error.message
    assert "expected 1" in res.error.message


def test_expected_mismatch_message_names_active_filters():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="dr.element('b3').outgoing(stereotype='Owns', expected=2)"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None
    assert "stereotype='Owns'" in res.error.message
    assert "expected 2" in res.error.message


def test_expected_invalid_values_raise_valueerror():
    r = TrustedRunner()
    for bad in ("0", "-1", "True", "'1'"):
        res = r.run(tiny_model(),
                    RunRequest(code="dr.element('b1').outgoing(expected=%s)" % bad),
                    RunLimits(), record_ops=False, rev=0)
        assert res.error is not None and res.error.kind == "runtime", bad
        assert "ValueError" in res.error.message, bad


def test_expected_check_applies_to_filtered_count():
    # b1 has 1 outgoing rel; filtered to a stereotype that matches it,
    # expected=1 passes even though an unfiltered expected=2 would fail.
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b1').outgoing(stereotype='Owns', expected=1)\n"
                    "result = rel.id is not None"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "True"


def test_relationship_mutation_cannot_poison_memo():
    # Mirrors the Element memo-aliasing tests: mutating what a hop returned
    # must not change what a later identical hop returns.
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "el = dr.element('b1')\n"
                    "first = el.outgoing()[0]\n"
                    "first.props()['injected'] = True\n"
                    "second = el.outgoing()[0]\n"
                    "result = second.get('injected') is None"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "True"
```

Append to `tests/script/test_trip_counts.py` (uses the `bridge_call_log` fixture from `tests/script/conftest.py`):

```python
def test_relationship_source_destination_are_zero_trip(bridge_call_log):
    # Trip collapse inlines far endpoints with the hop response, so
    # rel.destination() must be a memo hit — no extra "element" dispatch.
    sess = _open(
        "def value(els):\n"
        "    rels = els[0].outgoing()\n"
        "    return rels[0].destination().name\n"
    )
    _first_call(sess, ["b1"])
    assert bridge_call_log.count("element") == 0
    assert bridge_call_log.count("outgoing") == 1
```

(Match `_open`/`_first_call` to that file's existing helpers — read them before writing; the shape above mirrors its existing trip-count tests.)

Append to `tests/script/test_read_sets.py`:

```python
def test_other_stereotype_filter_records_far_element_reads():
    res = _call(
        "def value(els):\n"
        "    return len(els[0].outgoing(other_stereotype='Building'))\n",
        ["b1"],
    )
    assert ["out", "b1"] in res.reads
    assert ["el", "b2"] in res.reads  # far endpoint consulted by the filter
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_trusted_runner.py -v -k "outgoing or relationship or expected or hop"`
Expected: FAIL with runtime errors (`'Element' object has no attribute 'outgoing'`).

- [ ] **Step 3: Implement in FACADE_SOURCE**

(a) New exception after `NotFoundError`:

```python
class CardinalityError(BridgeError):
    """A hop's `expected=` relationship-count assertion failed."""
```

and in `_Dr`: `CardinalityError = CardinalityError` (next to the other exception aliases).

(b) Internal helpers (place after `_copy_projection`; NOT public API, underscored — the docs walker skips them):

```python
def _descendant_set(kind, name):
    # Stereotype descendant closure fetched from the host, memoized for the
    # session. Deliberately NO _note_read: the metamodel is immutable per
    # session (a swap goes through session replacement / clear-all), so a
    # cached cell can never observe a stale descendant set.
    key = ("descendants", kind, name)
    hit = _memo.get(key)
    if hit is None:
        hit = _read("descendants", kind=kind, name=name)["descendants"]
        _memo_put(key, hit)
    return hit


def _stereotype_filter(kind, names):
    # None -> no filtering. A str or list of names -> the union of each
    # name's descendant closure (inheritance-aware match set).
    if names is None:
        return None
    if isinstance(names, str):
        names = [names]
    allowed = set()
    for n in names:
        allowed.update(_descendant_set(kind, n))
    return allowed
```

(c) Replace `Element.out`/`Element.in_` with `outgoing`/`incoming` + one shared driver (`_hop` is underscored → skipped by the docs walker):

```python
    def outgoing(self, stereotype=None, other_stereotype=None, expected=None):
        """List outgoing Relationships, newest filter semantics:

        `stereotype` (str or list) keeps only relationships of the named
        stereotype(s) or their subtypes; `other_stereotype` (str or list)
        keeps only relationships whose TARGET element matches. `expected`
        (int >= 1) asserts the filtered count — a mismatch raises
        dr.CardinalityError — and with expected=1 the single Relationship is
        returned directly instead of a list.

        Example:
            for rel in el.outgoing(stereotype="Owns"):
                print(rel.destination().name)
        """
        return self._hop("outgoing", stereotype, other_stereotype, expected)

    def incoming(self, stereotype=None, other_stereotype=None, expected=None):
        """List incoming Relationships. Same filters as `outgoing`;
        `other_stereotype` matches the SOURCE element.

        Example:
            owner = el.incoming(stereotype="Owns", expected=1).source()
        """
        return self._hop("incoming", stereotype, other_stereotype, expected)

    def _hop(self, direction, stereotype, other_stereotype, expected):
        if expected is not None:
            # bool is an int subclass -- reject it explicitly, True would
            # otherwise pass as expected=1.
            if (
                isinstance(expected, bool)
                or not isinstance(expected, int)
                or expected < 1
            ):
                raise ValueError(
                    "expected must be a positive int, got " + repr(expected)
                )
        _note_read("out" if direction == "outgoing" else "in", self.id)
        key = (direction, self.id)
        hit = _memo.get(key)
        if hit is None:
            resp = _read(direction, element_id=self.id)
            # Hop responses ship the far endpoints' element projections
            # inline (trip-collapse) -- prime the element memo with them
            # BEFORE storing the relationships. `or []` keeps this tolerant
            # of a host that predates the additive "elements" key.
            for proj in resp.get("elements") or []:
                _memo_put(("element", proj["id"]), proj)
            hit = resp["relationships"]
            _memo_put(key, hit)
        rel_allowed = _stereotype_filter("relationship", stereotype)
        other_allowed = _stereotype_filter("element", other_stereotype)
        rels = []
        for r in hit:
            if rel_allowed is not None and r["type"] not in rel_allowed:
                continue
            if other_allowed is not None:
                far_id = r["target_id"] if direction == "outgoing" else r["source_id"]
                try:
                    far = _fetch_element(far_id)
                except NotFoundError:
                    # Dangling far endpoint (the engine stays inspectable):
                    # treated as non-matching, never raising. An unfiltered
                    # hop still returns such relationships.
                    continue
                if far.stereotype not in other_allowed:
                    continue
            # Copy each relationship dict (via _copy_projection, so
            # list-valued properties are copied too) -- the memo entry is
            # shared canonical state (see the invariant comment above
            # `_memo`); a snippet mutating a Relationship's data must not
            # change what a later hop returns.
            rels.append(Relationship(_copy_projection(r)))
        if expected is not None and len(rels) != expected:
            parts = []
            if stereotype is not None:
                parts.append("stereotype=" + repr(stereotype))
            if other_stereotype is not None:
                parts.append("other_stereotype=" + repr(other_stereotype))
            detail = " (" + ", ".join(parts) + ")" if parts else ""
            raise CardinalityError(
                "element " + repr(self.id) + " has " + str(len(rels)) + " "
                + direction + " relationships" + detail
                + ", expected " + str(expected)
            )
        if expected == 1:
            return rels[0]
        return rels
```

(d) New `Relationship` class after `Element` (before `_fetch_element`, which it calls at run time — module-level resolution makes order flexible, but keep it adjacent to `Element` for readability):

```python
class Relationship:
    """A read snapshot of a model relationship, returned by
    `Element.outgoing`/`Element.incoming`."""

    __slots__ = ("_data",)

    def __init__(self, data):
        self._data = data

    @property
    def id(self):
        """The relationship's id."""
        return self._data["id"]

    @property
    def stereotype(self):
        """The relationship's stereotype (type) name."""
        return self._data["type"]

    def __getitem__(self, key):
        return self._data["properties"][key]

    def get(self, key, default=None):
        """Return property `key`, or `default` if absent. `rel[key]` raises instead.

        Example:
            weight = rel.get("weight", 0)
        """
        return self._data["properties"].get(key, default)

    def props(self):
        """Return a dict copy of all properties.

        Example:
            print(rel.props())
        """
        return dict(self._data["properties"])

    def source(self):
        """Return the source Element of this relationship.

        Example:
            owner = rel.source()
        """
        return _fetch_element(self._data["source_id"])

    def destination(self):
        """Return the destination (target) Element of this relationship.

        Example:
            owned = rel.destination()
        """
        return _fetch_element(self._data["target_id"])

    def __repr__(self):
        return (
            "Relationship(id=" + repr(self.id)
            + ", stereotype=" + repr(self.stereotype) + ")"
        )
```

(e) `docs.py` `_RETURNS`: replace `"Element.out"`/`"Element.in_"` entries with:

```python
    "Element.outgoing": "list[Relationship] (Relationship when expected=1)",
    "Element.incoming": "list[Relationship] (Relationship when expected=1)",
```

(Relationship.* entries land in Task 6.)

- [ ] **Step 4: Grep-driven sweep of old hop spellings and rel-dict access in tests**

```bash
grep -rn "\.out()\|\.in_()" tests/ src/ --include="*.py" | grep -v __pycache__
grep -rn "rel\[\|rels\[0\]\[\|\['target_id'\]\|\['source_id'\]\|\[\"target_id\"\]\|\[\"source_id\"\]" tests/ --include="*.py" | grep -v __pycache__
```

Substitutions in snippet-code strings:

| Old | New |
| --- | --- |
| `el.out()` / `el.in_()` | `el.outgoing()` / `el.incoming()` |
| `rel['type']` | `rel.stereotype` |
| `rel['target_id']` (then `dr.element(...)`) | `rel.destination()` (drop the manual `dr.element` fetch) or `rel['target_id']` → `rel.destination().id` when only the id is needed |
| `rel['source_id']` | `rel.source()` / `rel.source().id` |
| `rel['id']` | `rel.id` |

CAREFUL in `tests/script/test_trip_counts.py`: tests asserting per-neighbor fetch counts (e.g. `dr.element(rel['target_id']).name` loops) exist precisely to count `element` dispatches. Rewrite them with `rel.destination().name` — the dispatch counts must stay identical (destination() calls `_fetch_element`, same memo path). If a count changes, that's a real regression to investigate, not a test to adjust.

`tests/script/test_docs.py` name list: replace `Element.out`/`Element.in_` with `Element.outgoing`/`Element.incoming`.

- [ ] **Step 5: Run the full Python suite**

Run: `pixi run core-test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
pixi run core-lint
git add -A src/data_rover tests
git commit -m "feat(script)!: Relationship class; incoming/outgoing with stereotype filters and expected="
```

---

### Task 6: docs.py — `Relationship` walk + complete `_RETURNS`

**Files:**
- Modify: `src/data_rover/core/script/docs.py`
- Test: `tests/script/test_docs.py`

**Interfaces:**
- Consumes: Task 5's `Relationship` class inside FACADE_SOURCE.
- Produces: `get_facade_docs()` emits `Relationship.*` entries (kind `property`/`method`) exactly like `Element.*`; the undocumented-member tripwire now also covers `Relationship`. The frontend docs feed (`GET /snippets/docs`) picks this up with no route change.

- [ ] **Step 1: Write the failing test**

In `tests/script/test_docs.py`, extend the expected-names assertion (it already lists every public member) with:

```python
        "Element.outgoing", "Element.incoming",
        "Relationship.id", "Relationship.stereotype", "Relationship.get",
        "Relationship.props", "Relationship.source", "Relationship.destination",
        "dr.CardinalityError",
```

and add:

```python
def test_relationship_members_documented():
    docs = {e.name: e for e in get_facade_docs()}
    assert docs["Relationship.source"].kind == "method"
    assert docs["Relationship.stereotype"].kind == "property"
    assert "Relationship" in docs["Element.outgoing"].signature
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/script/test_docs.py -v`
Expected: FAIL (`Relationship.*` names missing).

- [ ] **Step 3: Implement**

In `docs.py`:

(a) `_RETURNS` — final state:

```python
_RETURNS: dict[str, str] = {
    "dr.element": "Element",
    "dr.elements": "iterator of Element",
    "dr.create": "str (temp id)",
    "dr.connect": "str (temp id)",
    "Element.id": "str",
    "Element.stereotype": "str",
    "Element.name": "str | None",
    "Element.get": "value or default",
    "Element.props": "dict",
    "Element.outgoing": "list[Relationship] (Relationship when expected=1)",
    "Element.incoming": "list[Relationship] (Relationship when expected=1)",
    "Element.parent": "Element | None",
    "Element.children": "list[Element]",
    "Relationship.id": "str",
    "Relationship.stereotype": "str",
    "Relationship.get": "value or default",
    "Relationship.props": "dict",
    "Relationship.source": "Element",
    "Relationship.destination": "Element",
}
```

(b) Generalize the Element walk — replace the `for stmt in classes["Element"].body:` loop with a loop over both classes:

```python
    # Element/Relationship members: public methods and properties; dunders
    # and underscored helpers skipped (`__getitem__` is documented under
    # `get`; `_hop` is an internal driver).
    for cls_name in ("Element", "Relationship"):
        for stmt in classes[cls_name].body:
            if not isinstance(stmt, ast.FunctionDef) or stmt.name.startswith("_"):
                continue
            public = f"{cls_name}.{stmt.name}"
            is_property = any(
                isinstance(d, ast.Name) and d.id == "property"
                for d in stmt.decorator_list
            )
            if is_property:
                ret = _RETURNS.get(public)
                sig = f"{public} -> {ret}" if ret else public
                entries.append(_entry(public, "property", sig, ast.get_docstring(stmt)))
            else:
                entries.append(
                    _entry(
                        public,
                        "method",
                        _signature(public, stmt, drop_self=True),
                        ast.get_docstring(stmt),
                    )
                )
```

(`dr.CardinalityError` is picked up automatically by the existing `_Dr` exception-alias walk once Task 5 added it to `_Dr` — no docs.py change needed for it, but it must appear in the test's name list.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/script/test_docs.py tests/api/test_snippets_routes.py -v`
Expected: PASS (the snippets-docs route test consumes the same feed).

- [ ] **Step 5: Commit**

```bash
pixi run core-lint
git add src/data_rover/core/script/docs.py tests/script/test_docs.py
git commit -m "feat(script): document Relationship class in the facade docs feed"
```

---

### Task 7: `core/script/README.md` facade reference rewrite

**Files:**
- Modify: `src/data_rover/core/script/README.md`

**Interfaces:** documentation only; ground truth is Tasks 4–6's code.

- [ ] **Step 1: Find every stale reference**

```bash
grep -n "dr\.types\|dr\.type(\|el\.out\|el\.in_\|\.type\b\|elements(type=\|type_info" src/data_rover/core/script/README.md
```

- [ ] **Step 2: Rewrite the affected sections**

Content requirements (the README's prose style is dense — match it):

- Exceptions list: add `dr.CardinalityError(dr.BridgeError)` — raised when a hop's `expected=` count assertion fails.
- `dr` API table: `dr.elements(stereotypes=None) -> Iterator[Element]` (str or list, descendant-expanded host-side via `Metamodel.element_descendants`, unioned); delete the `dr.types` / `dr.type` rows; `dr.create(stereotype, ...)` / `dr.connect(stereotype, ...)` wording.
- `Element` table: `.id` / `.stereotype` / `.name` row — name resolved via `core.model.naming.name_of` (case-insensitive, list-valued names, `None` when absent). Replace the `el.out()`/`el.in_()` rows with:

| Member | Behavior |
| --- | --- |
| `el.outgoing(stereotype=None, other_stereotype=None, expected=None)` | Outgoing `Relationship` objects, sorted by relationship id host-side. `stereotype`/`other_stereotype` accept a str or list, matching the named stereotype(s) or any subtype (guest-side filter over the memoized unfiltered hop; descendant sets come from the internal `descendants` bridge op). `other_stereotype` checks the far (target) element — a dangling far endpoint is treated as non-matching, never raising. `expected` (int ≥ 1; bools rejected) asserts the **filtered** count, raising `dr.CardinalityError` naming the element id, direction, active filters, and expected vs. actual; with `expected=1` the single `Relationship` is returned directly. One bridge round trip regardless of filters (plus far-endpoint fetches on the high-degree-hub path where trip-collapse inlining is skipped). |
| `el.incoming(...)` | Same, far element = source. |

- New `Relationship` section mirroring the `Element` one: snapshot wrapper (`__slots__ = ("_data",)`) over a copied `{"id","type","name","properties","source_id","target_id"}` projection; `.id`/`.stereotype`; `rel[key]`/`.get()`/`.props()`; `.source()`/`.destination()` are `_fetch_element` calls — memo-primed by trip collapse, so typically zero round trips, and recorded in the read-set as `("el", id)`.
- Read-op list mentions (`types`, `type_info` → `descendants`) — including the "Error kinds" table row and the wire-protocol section (~line 224).
- Read-set docs: multi-stereotype scans record one `("scan", s)` per requested name; `descendants` is deliberately unrecorded (immutable metamodel per session).
- Update every inline example using old spellings (e.g. line ~359 `dr.elements(type="Building")` → `stereotypes=`; line ~422 `el.out()[0]["properties"]...` → the Relationship equivalent).

- [ ] **Step 3: Verify no stragglers, commit**

```bash
grep -n "dr\.types\|dr\.type(\|el\.out(\|el\.in_\|elements(type=\|type_info" src/data_rover/core/script/README.md
# expected: no hits
git add src/data_rover/core/script/README.md
git commit -m "docs(script): README facade reference for the stereotype API"
```

---

### Task 8: Frontend — completions, hover, placeholder

**Files:**
- Modify: `frontend/src/lib/editor/completion-source.ts`
- Modify: `frontend/src/lib/components/Snippet/CodeEditor.svelte` (placeholderDom, ~line 100)
- Test: `frontend/src/lib/editor/__tests__/completion-source.test.ts`

**Interfaces:**
- Consumes: the docs feed now serves `Element.stereotype`, `Element.outgoing/incoming`, `Relationship.*` entries and no `dr.types`/`dr.type` (Tasks 4–6).
- Produces: stereotype-string completion inside `dr.create("` and `dr.elements(stereotypes=` (single string or list form); member completion and hover docs for both `Element.` and `Relationship.` receivers.

- [ ] **Step 1: Update/extend the tests**

In `completion-source.test.ts`: update the `DOCS` fixture entries (`dr.elements` signature → `'dr.elements(stereotypes=None)'`; rename the `Element.type` fixture if present to `Element.stereotype`; add a `Relationship.source` fixture entry with kind `'method'`). Replace/extend the type-string cases:

```ts
it('completes stereotype names in dr.elements(stereotypes=...)', () => {
	expect(computeCompletions('dr.elements(stereotypes="', DOCS, VOCAB)).not.toBeNull();
	expect(computeCompletions("dr.elements(stereotypes='Bui", DOCS, VOCAB)).not.toBeNull();
});

it('completes stereotype names inside the list form', () => {
	expect(computeCompletions('dr.elements(stereotypes=["', DOCS, VOCAB)).not.toBeNull();
	expect(computeCompletions('dr.elements(stereotypes=["A", "', DOCS, VOCAB)).not.toBeNull();
});

it('still completes the dr.create first argument', () => {
	expect(computeCompletions('dr.create("', DOCS, VOCAB)).not.toBeNull();
});

it('no longer special-cases dr.type', () => {
	expect(computeCompletions('dr.type("', DOCS, VOCAB)).toBeNull();
});

it('member completion merges Element and Relationship options', () => {
	const spec = computeCompletions('rel.sou', DOCS, VOCAB);
	expect(spec?.options.map((o) => o.label)).toContain('source');
});

it('hover resolves Relationship members', () => {
	expect(resolveDocAt('x = rel.source()', 10, DOCS)?.name).toBe('Relationship.source');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/editor/__tests__/completion-source.test.ts'`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

In `completion-source.ts`:

(a) Replace `TYPE_STRING_RE` with two regexes:

```ts
// First string argument of dr.create( — stereotype name after the quote.
const CREATE_STRING_RE = /dr\.create\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)?$/;
// dr.elements( with an optional stereotypes= keyword, single string or list
// form (`stereotypes=["A", "` keeps completing later entries). Bounded scan
// of the current line, like everything here.
const ELEMENTS_STRING_RE =
	/dr\.elements\(\s*(?:stereotypes\s*=\s*)?(?:\[\s*(?:["'][^"']*["']\s*,\s*)*)?(["'])([A-Za-z_][A-Za-z0-9_]*)?$/;
```

and in `computeCompletions` replace the `TYPE_STRING_RE` block:

```ts
	const typeMatch = CREATE_STRING_RE.exec(before) ?? ELEMENTS_STRING_RE.exec(before);
	if (typeMatch) {
		if (!vocab || vocab.typeNames.length === 0) return null;
		const partial = typeMatch[2] ?? '';
		const options = vocab.typeNames
			.filter((t) => t.startsWith(partial))
			.map((t) => ({ label: t, type: 'type' }));
		return options.length ? { from: before.length - partial.length, options } : null;
	}
```

(b) Widen `facadeOptions`' prefix type to `'dr.' | 'Element.' | 'Relationship.'` and add a merged member helper:

```ts
// Member-access heuristic: the receiver's class is unknown, so offer the
// union of Element and Relationship members, Element first, deduped by
// label (get/props/id/stereotype exist on both with identical docs shape).
function memberOptions(docs: SnippetDocsOut, partial: string, boost: number): CompletionOption[] {
	const element = facadeOptions(docs, 'Element.', partial, boost);
	const seen = new Set(element.map((o) => o.label));
	const rel = facadeOptions(docs, 'Relationship.', partial, boost).filter(
		(o) => !seen.has(o.label)
	);
	return [...element, ...rel];
}
```

and use `memberOptions(docs, partial, -1)` in the `OTHER_MEMBER_RE` branch.

(c) `resolveDocAt`: after the `Element.` lookup, fall back:

```ts
	if (start > 0 && line[start - 1] === '.') {
		return (
			docs.facade.find((e) => e.name === `Element.${word}`) ??
			docs.facade.find((e) => e.name === `Relationship.${word}`) ??
			null
		);
	}
```

(d) `CodeEditor.svelte` placeholder text:

```ts
		el.textContent =
			'Explore the model through the dr facade, e.g.:\n' +
			'for el in dr.elements():\n' +
			'    print(el.stereotype, el.name)';
```

(e) Straggler check across the frontend:

```bash
grep -rn "el\.type\|in_(\|dr\.type\b\|dr\.types\|elements(type=" frontend/src frontend/README.md | grep -v node_modules
```

Fix any hits (e.g. README examples, snippet-stage or docs-panel fixtures).

- [ ] **Step 4: Run the frontend suites**

```bash
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src frontend/README.md
git commit -m "feat(frontend): snippet editor completions for the stereotype facade API"
```

---

### Task 9: Final verification sweep

**Files:** none new — verification only.

- [ ] **Step 1: Full straggler grep**

```bash
grep -rn "dr\.types\|dr\.type(\|\.in_(\|el\.out(\|elements(type=\|type_info" \
  src/ tests/ frontend/src/ --include="*.py" --include="*.ts" --include="*.svelte" --include="*.md" \
  | grep -v __pycache__ | grep -v node_modules
```

Expected: no hits (investigate and fix any).

- [ ] **Step 2: Full test + lint gates**

```bash
pixi run core-test
pixi run dr-tidy
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
```

Expected: all green (dr-tidy runs ruff+mypy+pyright across the repo).

- [ ] **Step 3: WASM integration spot-check (only if the guest binary is fetched)**

```bash
ls spikes/code_exec/vendor/python.wasm 2>/dev/null && \
  pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -v
```

Expected: PASS if the binary exists; skip silently otherwise (the facade travels as source — no guest rebuild is ever needed).

- [ ] **Step 4: Commit any sweep fixes**

```bash
git add -A
git commit -m "chore(script): stereotype-rename straggler sweep"  # only if Step 1/2 changed anything
```
