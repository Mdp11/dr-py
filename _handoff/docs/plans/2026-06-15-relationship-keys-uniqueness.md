# Relationship Keys in Uniqueness Validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a metamodel author list relationships in an element type's `key` (e.g. `key: [name, out:Parent, in:School]`) so uniqueness identity also depends on the multiset of elements an element is connected to.

**Architecture:** Element `key` stays `list[str]`; a string-prefix DSL (`out:` / `in:`) marks relationship entries, parsed into a `KeySpec` cached on the immutable `Metamodel`. The `IndexSet` uniqueness signature gains a per-relationship endpoint multiset, maintained incrementally by rekeying an edge's endpoints on connect/disconnect. `check_metamodel` validates relationship key entries. Item 1 (owner already in the key) is unchanged.

**Tech Stack:** Python 3.14 (checked at 3.10 floor — use `typing_extensions` for `Self`/`assert_never`), pydantic, pixi, pytest.

**Spec:** `docs/superpowers/specs/2026-06-15-relationship-keys-uniqueness-design.md`

**Conventions:**
- All commands run through pixi. Tests: `pixi run -e core-dev pytest <path>`.
- Lint/typecheck (ruff + mypy + pyright, all three must pass): `pixi run lint-core`.
- `pythonpath=src` is set, so imports are `from data_rover.core...`.
- Commit after each task.

---

### Task 1: Parse the key DSL into a `KeySpec` on the metamodel

**Files:**
- Modify: `src/data_rover/core/metamodel/schema.py`
- Test: `tests/metamodel/test_resolution.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/metamodel/test_resolution.py`:

```python
def _keyed_mm():
    return Metamodel(
        elements=[
            ElementType(
                name="Person",
                properties=[PropertyDef(name="name", datatype="string")],
                key=["name", "out:Parent", "in:School"],
            ),
            ElementType(
                name="Plain",
                properties=[PropertyDef(name="name", datatype="string")],
                key=["name"],
            ),
            ElementType(name="NoKey"),
        ],
        relationships=[
            RelationshipType(name="Parent", source="Person", target="Person"),
            RelationshipType(name="School", source="Person", target="Person"),
        ],
    )


def test_key_spec_splits_properties_and_relationships():
    from data_rover.core.metamodel.schema import KeyRel

    spec = _keyed_mm().effective_element_key_spec("Person")
    assert spec is not None
    assert spec.properties == ("name",)
    assert spec.relationships == (
        KeyRel(rel_type="Parent", direction="out"),
        KeyRel(rel_type="School", direction="in"),
    )


def test_key_spec_property_only():
    spec = _keyed_mm().effective_element_key_spec("Plain")
    assert spec is not None
    assert spec.properties == ("name",)
    assert spec.relationships == ()


def test_key_spec_none_when_no_key():
    assert _keyed_mm().effective_element_key_spec("NoKey") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/metamodel/test_resolution.py -k key_spec -v`
Expected: FAIL — `ImportError: cannot import name 'KeyRel'` / `AttributeError: ... effective_element_key_spec`.

- [ ] **Step 3: Add the dataclasses and parse helpers to `schema.py`**

Near the top of `src/data_rover/core/metamodel/schema.py`, after the existing imports add `Sequence` to the `collections.abc` import and `Literal` is already imported from `typing`. Then add, right after the `Mapping` class (around line 35):

```python
@dataclass(frozen=True)
class KeyRel:
    """A relationship referenced by an element type's ``key``.

    ``direction == "out"`` keys on the element's OUTGOING edges of
    ``rel_type`` (the connected target ids); ``"in"`` keys on its INCOMING
    edges (the connected source ids). Spelled ``out:<RelType>`` / ``in:<RelType>``
    in the metamodel ``key`` list.
    """

    rel_type: str
    direction: Literal["out", "in"]


@dataclass(frozen=True)
class KeySpec:
    """An element type's effective key, split into property and relationship parts."""

    properties: tuple[str, ...]
    relationships: tuple[KeyRel, ...]


def parse_key_entry(entry: str) -> str | KeyRel:
    """Classify one raw ``key`` entry.

    ``out:R`` / ``in:R`` are relationship keys; any other string is a property
    name. Property names therefore must not begin with ``out:`` or ``in:`` —
    that prefix is the DSL boundary.
    """
    if entry.startswith("out:"):
        return KeyRel(rel_type=entry[len("out:") :], direction="out")
    if entry.startswith("in:"):
        return KeyRel(rel_type=entry[len("in:") :], direction="in")
    return entry


def parse_key(entries: Sequence[str]) -> KeySpec:
    properties: list[str] = []
    relationships: list[KeyRel] = []
    for entry in entries:
        parsed = parse_key_entry(entry)
        if isinstance(parsed, KeyRel):
            relationships.append(parsed)
        else:
            properties.append(parsed)
    return KeySpec(properties=tuple(properties), relationships=tuple(relationships))
```

- [ ] **Step 4: Add a parsed-spec cache and accessor**

In `_Caches` (around line 104), add a field alongside `effective_element_keys`:

```python
    effective_element_key_specs: dict[str, KeySpec | None]
```

In `_build_caches`, the `effective_element_keys` loop already computes each type's raw `key` tuple. Right after that loop (after line 210, before `return _Caches(`), add:

```python
    effective_element_key_specs: dict[str, KeySpec | None] = {
        name: (None if raw is None else parse_key(raw))
        for name, raw in effective_element_keys.items()
    }
```

Add it to the `_Caches(...)` constructor call:

```python
        effective_element_key_specs=effective_element_key_specs,
```

Add the accessor method on `Metamodel`, right after `effective_element_key` (around line 311):

```python
    def effective_element_key_spec(self, name: str) -> KeySpec | None:
        """Parsed effective key (properties + relationships) for ``name``.

        Mirrors :meth:`effective_element_key`'s child-override-wins resolution,
        but split into a :class:`KeySpec`. ``None`` when no key is declared.
        """
        return self._caches().effective_element_key_specs.get(name)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/metamodel/test_resolution.py -k key_spec -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/metamodel/schema.py tests/metamodel/test_resolution.py
git commit -m "feat(metamodel): parse out:/in: relationship key DSL into KeySpec"
```

---

### Task 2: Validate relationship key entries in `check_metamodel`

**Files:**
- Modify: `src/data_rover/core/metamodel/check.py:76-88`
- Test: `tests/metamodel/test_schema.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/metamodel/test_schema.py`:

```python
from data_rover.core.metamodel.check import check_metamodel


def _rel_key_mm(person_key):
    return Metamodel(
        elements=[
            ElementType(
                name="Person",
                properties=[PropertyDef(name="name", datatype="string")],
                key=person_key,
            ),
        ],
        relationships=[
            RelationshipType(name="Parent", source="Person", target="Person"),
        ],
    )


def test_relationship_key_valid_has_no_errors():
    assert check_metamodel(_rel_key_mm(["name", "out:Parent", "in:Parent"])) == []


def test_relationship_key_unknown_relationship_errors():
    errors = check_metamodel(_rel_key_mm(["out:Ghost"]))
    assert any("unknown relationship 'Ghost'" in e for e in errors)


def test_relationship_key_wrong_end_errors():
    # Parent maps Person(source) -> Widget(target); a key 'in:Parent' on Person
    # is invalid because Person is not on the target end.
    mm = Metamodel(
        elements=[
            ElementType(name="Person", key=["in:Parent"]),
            ElementType(name="Widget"),
        ],
        relationships=[
            RelationshipType(name="Parent", source="Person", target="Widget"),
        ],
    )
    errors = check_metamodel(mm)
    assert any("not on the target end of 'Parent'" in e for e in errors)


def test_relationship_key_inherited_on_supertype_ok():
    # Key declared on abstract Base, relationship endpoint is concrete Sub.
    mm = Metamodel(
        elements=[
            ElementType(name="Base", abstract=True, key=["out:Link"]),
            ElementType(name="Sub", extends="Base"),
        ],
        relationships=[RelationshipType(name="Link", source="Sub", target="Sub")],
    )
    assert check_metamodel(mm) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/metamodel/test_schema.py -k relationship_key -v`
Expected: FAIL — current loop treats `out:Parent` as an unknown *property*, so messages/assertions don't match (and `wrong_end` is not detected).

- [ ] **Step 3: Implement relationship-aware key validation**

In `src/data_rover/core/metamodel/check.py`, add to the imports at the top:

```python
from .schema import KeyRel, Metamodel, PropertyDef, parse_key_entry
```

(Keep whatever is already imported; add `KeyRel` and `parse_key_entry`. `Metamodel`/`PropertyDef` may already be imported — do not duplicate.)

Add this helper above `check_metamodel`:

```python
def _on_end(mm: Metamodel, type_name: str, endpoint_types: set[str]) -> bool:
    """True if ``type_name`` is subtype-or-supertype-compatible with any endpoint.

    Tolerates a key declared on an abstract supertype whose relationship
    endpoint is a concrete subtype (and vice-versa).
    """
    return any(
        mm.is_element_subtype(type_name, e) or mm.is_element_subtype(e, type_name)
        for e in endpoint_types
    )
```

Replace the key-validation block (currently lines 76-88, the `for et in mm.elements: if et.key is not None:` loop) with:

```python
    for et in mm.elements:
        if et.key is None:
            continue
        if len(et.key) == 0:
            errors.append(
                f"Element {et.name!r}: key must be non-empty (omit to mean 'no key')"
            )
            continue
        effective = {p.name for p in mm.effective_element_properties(et.name)}
        for k in et.key:
            parsed = parse_key_entry(k)
            if isinstance(parsed, KeyRel):
                rt = mm.relationship_type(parsed.rel_type)
                if rt is None:
                    errors.append(
                        f"Element {et.name!r}: key references unknown relationship "
                        f"{parsed.rel_type!r}"
                    )
                    continue
                if parsed.direction == "out":
                    endpoints = {m.source for m in rt.mappings}
                    side = "source"
                else:
                    endpoints = {m.target for m in rt.mappings}
                    side = "target"
                if not _on_end(mm, et.name, endpoints):
                    errors.append(
                        f"Element {et.name!r}: key relationship {k!r} is invalid — "
                        f"{et.name!r} is not on the {side} end of {parsed.rel_type!r}"
                    )
            elif parsed not in effective:
                errors.append(
                    f"Element {et.name!r}: key references unknown property {parsed!r}"
                )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/metamodel/test_schema.py -k relationship_key -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full metamodel test module (no regressions in existing key checks)**

Run: `pixi run -e core-dev pytest tests/metamodel/ -v`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/metamodel/check.py tests/metamodel/test_schema.py
git commit -m "feat(metamodel): validate out:/in: relationship key entries"
```

---

### Task 3: Build the relationship multiset into the uniqueness signature and maintain it incrementally

**Files:**
- Modify: `src/data_rover/core/model/indexes.py`
- Test: `tests/model/test_indexes.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/model/test_indexes.py`:

```python
def _rel_key_mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Person",
                key=["name", "out:Knows"],
                properties=[PropertyDef(name="name", datatype="string")],
            ),
        ],
        relationships=[
            RelationshipType(name="Knows", source="Person", target="Person"),
        ],
    )


def _person(model: Model, name: str) -> Element:
    el = model.create_element("Person")
    model.set_property(el, "name", name)
    return el


def test_rel_key_same_name_no_edges_is_duplicate():
    model = Model(_rel_key_mm())
    _person(model, "Foo")
    _person(model, "Foo")
    assert len(model.indexes.duplicate_keys) == 1
    model.indexes.verify_consistent()


def test_rel_key_differing_endpoints_not_duplicate():
    model = Model(_rel_key_mm())
    a = _person(model, "Foo")
    b = _person(model, "Foo")
    c = _person(model, "C")
    model.connect("Knows", a.id, c.id)  # a -> c, b has no edge
    assert model.indexes.duplicate_keys == set()
    model.indexes.verify_consistent()

    model.connect("Knows", b.id, c.id)  # now both -> c
    assert len(model.indexes.duplicate_keys) == 1
    model.indexes.verify_consistent()


def test_rel_key_multiset_count_matters():
    model = Model(_rel_key_mm())
    a = _person(model, "Foo")
    b = _person(model, "Foo")
    c = _person(model, "C")
    model.connect("Knows", a.id, c.id)
    model.connect("Knows", a.id, c.id)  # a -> c twice
    model.connect("Knows", b.id, c.id)  # b -> c once
    assert model.indexes.duplicate_keys == set()  # [c, c] != [c]
    model.indexes.verify_consistent()

    model.connect("Knows", b.id, c.id)  # b -> c twice -> matches
    assert len(model.indexes.duplicate_keys) == 1
    model.indexes.verify_consistent()


def test_rel_key_disconnect_restores_duplicate():
    model = Model(_rel_key_mm())
    a = _person(model, "Foo")
    b = _person(model, "Foo")
    c = _person(model, "C")
    rel = model.connect("Knows", a.id, c.id)
    assert model.indexes.duplicate_keys == set()
    model.disconnect(rel.id)
    assert len(model.indexes.duplicate_keys) == 1  # back to {a, b} both edgeless
    model.indexes.verify_consistent()


def test_in_direction_key_groups_by_incoming():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Person",
                key=["name", "in:Knows"],
                properties=[PropertyDef(name="name", datatype="string")],
            ),
        ],
        relationships=[RelationshipType(name="Knows", source="Person", target="Person")],
    )
    model = Model(mm)
    a = _person(model, "Foo")
    b = _person(model, "Foo")
    src = _person(model, "S")
    model.connect("Knows", src.id, a.id)  # a has incoming, b does not
    assert model.indexes.duplicate_keys == set()
    model.connect("Knows", src.id, b.id)
    assert len(model.indexes.duplicate_keys) == 1
    model.indexes.verify_consistent()
```

If `Model.connect` does not return the created relationship (check its signature), capture the id via `model.indexes` instead; adjust `test_rel_key_disconnect_restores_duplicate` to look up the single outgoing rel id: `rel_id = next(iter(model.indexes.outgoing_ids(a.id)))` and `model.disconnect(rel_id)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/model/test_indexes.py -k "rel_key or in_direction" -v`
Expected: FAIL — `out:Knows` is currently treated as a property name, so `name` matches make both Persons duplicates regardless of edges (the differing-endpoints assertions fail).

- [ ] **Step 3: Replace the key cache with a KeySpec cache and build the relationship multiset**

In `src/data_rover/core/model/indexes.py`:

Update the import (around line 30) to pull in the new types:

```python
from ..metamodel.schema import KeyRel, KeySpec
```

(Add this import near the existing `from .element import Element` block; `KeyRel`/`KeySpec` live in `data_rover.core.metamodel.schema`.)

Update the `UniqKey` alias comment (around line 36-38) to:

```python
# (type_name, containment owner id or None, signature). The signature is the
# frozen all-properties value when the type declares no key; for a keyed type it
# is a 2-tuple (property-value tuple, per-relationship endpoint-multiset tuple),
# each relationship multiset rendered as tuple(sorted(endpoint_ids)).
UniqKey = tuple[str, "str | None", Hashable]
```

In `IndexSet.__init__`, replace the `self._key_props` cache (line 96) with a KeySpec cache, and add the lazily-built key-relationship-type sets:

```python
        self._key_specs: dict[str, KeySpec | None] = {}
        # relationship-type names that appear with each direction in ANY element
        # type's effective key; built once (metamodel is immutable). None until
        # first built. Used to skip rekeying on edges that affect no key.
        self._out_key_rel_types: set[str] | None = None
        self._in_key_rel_types: set[str] | None = None
```

Replace `_effective_key` (lines 286-293) with `_effective_key_spec`:

```python
    def _effective_key_spec(self, type_name: str) -> KeySpec | None:
        try:
            return self._key_specs[type_name]
        except KeyError:
            spec = self._model.metamodel.effective_element_key_spec(type_name)
            self._key_specs[type_name] = spec
            return spec
```

Replace `_uniq_key` (lines 276-284) with:

```python
    def _uniq_key(self, element: Element) -> UniqKey:
        parents = self.containment_parents.get(element.id)
        owner = parents[0] if parents else None
        spec = self._effective_key_spec(element.type_name)
        if spec is None:
            signature: Hashable = _frozen(element.properties)
        else:
            prop_values = tuple(
                _frozen(element.properties.get(k)) for k in spec.properties
            )
            rel_values = tuple(
                self._rel_endpoints(element.id, kr) for kr in spec.relationships
            )
            signature = (prop_values, rel_values)
        return (element.type_name, owner, signature)

    def _rel_endpoints(self, element_id: str, kr: KeyRel) -> tuple[str, ...]:
        """Endpoint-id multiset for one relationship key, as a sorted tuple.

        Exact relationship-type match (subtypes of ``kr.rel_type`` do not
        count). ``out`` -> target ids of outgoing edges; ``in`` -> source ids of
        incoming edges.
        """
        rels = self._model.relationships
        if kr.direction == "out":
            rel_ids = self.out_rels.get(element_id) or ()
            endpoints = [
                rels[r].target_id for r in rel_ids if rels[r].type_name == kr.rel_type
            ]
        else:
            rel_ids = self.in_rels.get(element_id) or ()
            endpoints = [
                rels[r].source_id for r in rel_ids if rels[r].type_name == kr.rel_type
            ]
        return tuple(sorted(endpoints))
```

- [ ] **Step 4: Add the incremental rekey on key-typed edges**

Add this helper near the other uniqueness internals (after `_rekey_if_present`, around line 339):

```python
    def _ensure_key_rel_types(self) -> None:
        if self._out_key_rel_types is not None:
            return
        out: set[str] = set()
        inn: set[str] = set()
        mm = self._model.metamodel
        for et in mm.elements:
            spec = mm.effective_element_key_spec(et.name)
            if spec is None:
                continue
            for kr in spec.relationships:
                (out if kr.direction == "out" else inn).add(kr.rel_type)
        self._out_key_rel_types = out
        self._in_key_rel_types = inn

    def _rekey_key_rel_endpoints(self, rel: Relationship) -> None:
        """Rekey an edge's endpoints when its type participates in a key.

        Endpoint ids are stable, so only the edge's own source/target need
        rekeying — no cascade. Call AFTER adjacency is updated so the signature
        reflects the post-mutation graph.
        """
        self._ensure_key_rel_types()
        assert self._out_key_rel_types is not None  # set by _ensure_key_rel_types
        assert self._in_key_rel_types is not None
        if rel.type_name in self._out_key_rel_types:
            self._rekey_if_present(rel.source_id)
        if rel.type_name in self._in_key_rel_types:
            self._rekey_if_present(rel.target_id)
```

In `on_relationship_created` (ends at line 158), add as the last statement of the method (after the containment block):

```python
        self._rekey_key_rel_endpoints(rel)
```

In `on_relationship_deleted` (ends at line 188), add as the last statement of the method (after the containment block):

```python
        self._rekey_key_rel_endpoints(rel)
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/model/test_indexes.py -k "rel_key or in_direction" -v`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the whole indexes + model suite (no regression; verify_consistent still holds)**

Run: `pixi run -e core-dev pytest tests/model/ -v`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/core/model/indexes.py tests/model/test_indexes.py
git commit -m "feat(model): relationship endpoint multiset in uniqueness signature"
```

---

### Task 4: Render relationship keys in the duplicate message and add validator-level tests

**Files:**
- Modify: `src/data_rover/core/validation/validators/uniqueness.py:59-72`
- Test: `tests/validation/test_uniqueness.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/validation/test_uniqueness.py`:

```python
def _knows_mm(direction: str = "out"):
    person = ElementType(
        name="Person",
        properties=[PropertyDef(name="name", datatype="string", multiplicity="1")],
        key=["name", f"{direction}:Knows"],
    )
    return Metamodel(
        elements=[person],
        relationships=[
            RelationshipType(name="Knows", source="Person", target="Person")
        ],
    )


def _person(model: Model, name: str):
    el = model.create_element("Person")
    model.set_property(el, "name", name)
    return el


def test_rel_key_duplicate_reported_with_descriptor():
    model = Model(_knows_mm())
    a = _person(model, "Foo")
    b = _person(model, "Foo")
    c = _person(model, "C")
    model.connect("Knows", a.id, c.id)
    model.connect("Knows", b.id, c.id)

    issues = UniquenessValidator().validate(model, Scope.all())
    assert len(issues) == 1
    assert "name='Foo'" in issues[0].message
    assert "out:Knows" in issues[0].message


def test_rel_key_differing_edges_not_duplicate():
    model = Model(_knows_mm())
    a = _person(model, "Foo")
    _person(model, "Foo")
    c = _person(model, "C")
    model.connect("Knows", a.id, c.id)  # only a -> c

    assert UniquenessValidator().validate(model, Scope.all()) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/validation/test_uniqueness.py -k rel_key -v`
Expected: FAIL — `_issue` calls `effective_element_key` and `zip`s a flat value tuple, raising on the new `(prop_values, rel_values)` signature shape (or producing a wrong descriptor).

- [ ] **Step 3: Update `_issue` to render the KeySpec**

In `src/data_rover/core/validation/validators/uniqueness.py`, replace `_issue` (lines 59-72) with:

```python
    def _issue(self, model, group_key: UniqKey, dup: str, primary: str) -> Issue:
        type_name = group_key[0]
        spec = model.metamodel.effective_element_key_spec(type_name)
        if spec is None:
            descriptor = "no key — all properties match"
        else:
            signature = group_key[2]
            assert isinstance(signature, tuple)  # keyed: (prop_values, rel_values)
            prop_values, rel_values = signature
            parts = [f"{k}={v!r}" for k, v in zip(spec.properties, prop_values)]
            for kr, endpoints in zip(spec.relationships, rel_values):
                parts.append(
                    f"{kr.direction}:{kr.rel_type}→[{', '.join(endpoints)}]"
                )
            descriptor = ", ".join(parts)
        return Issue(
            Severity.ERROR,
            f"Duplicate {type_name} element {dup}: matches {primary} ({descriptor})",
            [dup, primary],
        )
```

Update the class docstring (lines 10-22) to mention relationship keys: change the sentence "either match on the type's effective `key` properties" to "either match on the type's effective `key` (properties and, for `out:`/`in:` key entries, the multiset of connected element ids)".

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/validation/test_uniqueness.py -k rel_key -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole uniqueness + validation suite (property-only and no-key paths unchanged)**

Run: `pixi run -e core-dev pytest tests/validation/ -v`
Expected: PASS (all, including the pre-existing `test_duplicate_keyed_elements_*` and `test_no_key_*` tests).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/validation/validators/uniqueness.py tests/validation/test_uniqueness.py
git commit -m "feat(validation): render relationship keys in duplicate descriptor"
```

---

### Task 5: Full-suite verification, lint, and typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run the entire core test suite**

Run: `pixi run test-core`
Expected: PASS (all tests, no regressions).

- [ ] **Step 2: Lint, format, and typecheck the core package**

Run: `pixi run lint-core`
Expected: ruff, mypy, AND pyright all pass with no errors.

If pyright flags a Python-version issue, recall the 3.10 floor: import `Self`/`assert_never` from `typing_extensions`, not `typing`. The code in this plan uses only `Literal` (already imported) and standard `dataclass`/`tuple` generics, so no new compatibility shims should be needed.

- [ ] **Step 3: Commit any formatting changes**

```bash
git add -A
git commit -m "chore: format and lint relationship-key uniqueness work" || echo "nothing to commit"
```

---

## Self-Review notes

- **Spec §1 (DSL/parsing):** Task 1.
- **Spec §2 (metamodel validation):** Task 2.
- **Spec §3 (signature):** Task 3 Steps 3.
- **Spec §4 (incremental maintenance):** Task 3 Step 4.
- **Spec §5 (validator message):** Task 4.
- **Spec §6 (tests):** distributed across Tasks 1–4; whole-suite gate in Task 5.
- **Item 1 / out-of-scope:** no task — intentionally unchanged, asserted by the pre-existing `test_duplicate_keyed_elements_different_owners_ok` continuing to pass in Task 4 Step 5 and Task 5 Step 1.
- **Type consistency:** `KeySpec(properties, relationships)`, `KeyRel(rel_type, direction)`, `parse_key_entry`, `parse_key`, `effective_element_key_spec`, `_effective_key_spec`, `_rel_endpoints`, `_ensure_key_rel_types`, `_rekey_key_rel_endpoints` — names used consistently across Tasks 1, 3, 4.
- **API verified:** `Model.connect(rel_type, source_id, target_id) -> Relationship` and `Model.disconnect(rel_id) -> None` (`src/data_rover/core/model/model.py:116,160`). The Task 3 Step 1 fallback note is therefore unnecessary — `model.connect(...)` returns the relationship directly.
```
