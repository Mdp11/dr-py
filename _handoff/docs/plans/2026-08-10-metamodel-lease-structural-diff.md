# Metamodel Lease + Structural Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The EXCLUSIVE `mm` lease actually gates metamodel writers (with "locked by <email>" UX), and a typed structural metamodel diff is computed by one core differ and rendered on two surfaces (`POST /metamodel/diff` and `GET /commits/{rev}/diff`).

**Architecture:** A pure differ in `data_rover.core.metamodel.diff` (pydantic result models mirroring the metamodel document) is consumed by the diff route and the commit-diff renderer. Lease enforcement is honor-don't-require: rebind/upload/clear 409 with the holder's email when a *peer* holds `mm`; the drawer (owners only) acquires the lease before running a diff, via a reusable `metamodel-lease` state module and a standalone `MetamodelStructuralDiff` component (both survive the drawer's planned Phase 5 removal).

**Tech Stack:** Python 3.14 / pydantic / FastAPI; SvelteKit (Svelte 5 runes) / zod / vitest.

**Spec:** `docs/superpowers/specs/2026-08-10-metamodel-lease-structural-diff-design.md` (approved). Read it before starting any task.

## Global Constraints

- Everything runs through **pixi** — there is no global `python`/`node`. Python tests: `pixi run -e core-dev pytest <path> -v`. Frontend tests: `pixi run -e frontend bash -c 'cd frontend && npm test -- <path>'`.
- Work on branch **`feat/metamodel-lease-structural-diff`** (create from `main` at the start; the executor's worktree skill handles isolation).
- Conventional commits, **no attribution/co-author trailers**.
- **Never push to origin. Never commit anything under `docs/superpowers/`** (gitignored).
- Python is 4-space indented; **frontend files are TAB-indented** (prettier enforces this — run `pixi run -e frontend bash -c 'cd frontend && npx prettier --write <files>'` before committing frontend changes).
- All three Python checkers must pass: `pixi run core-lint` and `pixi run backend-lint` (ruff + mypy + pyright). Frontend gate: `pixi run -e frontend bash -c 'cd frontend && npm run lint && npm run check'`.
- **The Phase 1–3 backend contract is frozen** — only ADD fields/checks; never rename or repurpose existing wire fields.
- API tests are hermetic (in-memory SQLite via `tests/api/conftest.py`); every project-scoped request needs `headers=AUTH_HEADERS` and URLs built with `papi(...)`.
- Preserve the dense docstring style — new invariants get docstrings explaining *why*.

---

### Task 1: Core structural differ

**Files:**
- Create: `src/data_rover/core/metamodel/diff.py`
- Test: `tests/metamodel/test_diff.py`

**Interfaces:**
- Consumes: `Metamodel`, `ElementType`, `RelationshipType`, `PropertyDef`, `Mapping` from `data_rover.core.metamodel.schema`; `load_metamodel_str` from `data_rover.core.metamodel.loader` (tests only).
- Produces: `diff_metamodels(old: Metamodel, new: Metamodel) -> MetamodelStructuralDiff` plus the pydantic models `MetamodelStructuralDiff`, `EnumsDiff`, `EnumEntry`, `EnumChange`, `ElementTypesDiff`, `ElementTypeChange`, `RelationshipTypesDiff`, `RelationshipTypeChange`, `PropertiesDiff`, `PropertyChange`, `MappingsDiff`, `FieldChange`. Wire keys for `FieldChange` are `field` / `from` / `to` (`from` via pydantic alias). `MetamodelStructuralDiff.is_empty` is a python `@property`, NOT serialized.

- [ ] **Step 1: Write the failing tests**

```python
# tests/metamodel/test_diff.py
"""Structural metamodel diff (artefacts revamp Phase 4).

Identity is the NAME everywhere; a rename is remove+add. The diff mirrors the
raw document (no inheritance flattening). `source`/`target` on relationship
types are deliberately NOT diffed as attributes — they are normalized mirrors
of `mappings[0]`, and the mappings diff is authoritative for endpoints.
"""

from data_rover.core.metamodel.diff import diff_metamodels
from data_rover.core.metamodel.loader import load_metamodel_str

_BASE = """
enums:
  Status: [ok, down]
elements:
  - name: Asset
    abstract: true
    properties:
      - name: label
        datatype: string
  - name: Building
    extends: Asset
    properties:
      - name: height
        datatype: float
        max: 10
relationships:
  - name: Owns
    containment: true
    source: Asset
    target: Asset
"""


def _mm(yaml_str: str):
    return load_metamodel_str(yaml_str)


def test_identical_metamodels_diff_empty() -> None:
    d = diff_metamodels(_mm(_BASE), _mm(_BASE))
    assert d.is_empty
    assert d.element_types.added == []
    assert d.element_types.changed == []
    assert d.relationship_types.changed == []
    assert d.enums.changed == []


def test_added_and_removed_element_types_carry_full_definitions() -> None:
    cand = _BASE.replace(
        "  - name: Building",
        "  - name: Tower",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    assert [t.name for t in d.element_types.added] == ["Tower"]
    assert [t.name for t in d.element_types.removed] == ["Building"]
    # full definitions, not just names — the removed side keeps its properties
    assert d.element_types.removed[0].properties[0].name == "height"
    # rename == remove+add: nothing lands in `changed`
    assert d.element_types.changed == []
    assert not d.is_empty


def test_property_facet_change_is_field_level() -> None:
    cand = _BASE.replace("max: 10", "max: 20")
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.element_types.changed
    assert chg.name == "Building"
    assert chg.attributes == []
    (prop,) = chg.properties.changed
    assert prop.name == "height"
    (fc,) = prop.fields
    assert (fc.field, fc.from_, fc.to) == ("max", 10, 20)


def test_field_change_serializes_from_alias() -> None:
    cand = _BASE.replace("max: 10", "max: 20")
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    dumped = d.element_types.changed[0].properties.changed[0].fields[0].model_dump(
        by_alias=True
    )
    assert dumped == {"field": "max", "from": 10, "to": 20}


def test_element_attribute_changes() -> None:
    cand = _BASE.replace("    abstract: true\n", "").replace(
        "    extends: Asset", "    extends: null"
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    by_name = {c.name: c for c in d.element_types.changed}
    assert {f.field for f in by_name["Asset"].attributes} == {"abstract"}
    assert {f.field for f in by_name["Building"].attributes} == {"extends"}


def test_property_added_and_removed() -> None:
    cand = _BASE.replace(
        "      - name: label\n        datatype: string",
        "      - name: title\n        datatype: string",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.element_types.changed
    assert chg.name == "Asset"
    assert [p.name for p in chg.properties.added] == ["title"]
    assert [p.name for p in chg.properties.removed] == ["label"]


def test_relationship_mapping_and_multiplicity_changes() -> None:
    cand = _BASE.replace(
        "    source: Asset\n    target: Asset",
        "    source_multiplicity: '1..1'\n"
        "    mappings:\n"
        "      - {source: Asset, target: Asset}\n"
        "      - {source: Building, target: Building}",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.relationship_types.changed
    assert chg.name == "Owns"
    assert {f.field for f in chg.attributes} == {"source_multiplicity"}
    assert [(m.source, m.target) for m in chg.mappings.added] == [
        ("Building", "Building")
    ]
    assert chg.mappings.removed == []


def test_source_target_shorthand_not_diffed_as_attributes() -> None:
    # mappings[0] changes => source/target mirrors change too, but only the
    # mappings diff reports it (shorthand fields are derived, not authored).
    cand = _BASE.replace(
        "    source: Asset\n    target: Asset",
        "    mappings:\n      - {source: Building, target: Building}",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.relationship_types.changed
    assert chg.attributes == []
    assert [(m.source, m.target) for m in chg.mappings.added] == [
        ("Building", "Building")
    ]
    assert [(m.source, m.target) for m in chg.mappings.removed] == [("Asset", "Asset")]


def test_enum_literal_add_remove_and_reorder() -> None:
    cand = _BASE.replace("Status: [ok, down]", "Status: [down, ok, archived]")
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.enums.changed
    assert (chg.name, chg.added, chg.removed) == ("Status", ["archived"], [])
    # pure reorder alone is NOT a change
    reorder = _BASE.replace("Status: [ok, down]", "Status: [down, ok]")
    assert diff_metamodels(_mm(_BASE), _mm(reorder)).is_empty


def test_enum_added_and_removed_carry_literals() -> None:
    cand = _BASE.replace("  Status: [ok, down]", "  Grade: [a, b]")
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    assert [(e.name, e.literals) for e in d.enums.added] == [("Grade", ["a", "b"])]
    assert [(e.name, e.literals) for e in d.enums.removed] == [("Status", ["ok", "down"])]


def test_key_change_is_an_attribute() -> None:
    cand = _BASE.replace(
        "  - name: Building\n    extends: Asset",
        "  - name: Building\n    extends: Asset\n    key: [height]",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.element_types.changed
    (fc,) = chg.attributes
    assert (fc.field, fc.from_, fc.to) == ("key", None, ["height"])


def test_output_is_sorted_by_name() -> None:
    cand = _BASE.replace(
        "relationships:",
        "  - name: Zeta\n  - name: Alpha\nrelationships:",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    assert [t.name for t in d.element_types.added] == ["Alpha", "Zeta"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/metamodel/test_diff.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'data_rover.core.metamodel.diff'`

- [ ] **Step 3: Implement the differ**

```python
# src/data_rover/core/metamodel/diff.py
"""Structural metamodel diff (artefacts revamp, Phase 4).

One pure differ, two API surfaces: ``POST /metamodel/diff`` (pre-rebind
review) and the commit-diff renderer (post-hoc history of rebind commits).
Lives in core because it compares two core ``Metamodel`` objects and core has
no api imports.

Rules (spec 2026-08-10):
- Identity is the NAME everywhere (types, properties, enums); a rename is
  remove+add. No rename detection.
- The diff mirrors the RAW document — ``extends`` chains are not flattened
  and inherited properties do not appear on subtypes. Inherited-property
  IMPACT is the validation-impact section's job, not this differ's.
- Relationship ``source``/``target`` are NOT diffed as attributes: a model
  validator keeps them mirroring ``mappings[0]``, so diffing them would
  duplicate every mappings change. The mappings diff is authoritative.
- Enum-literal and type/property ORDER changes are not changes (the model is
  order-insensitive); output lists are name-sorted for determinism.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .schema import ElementType, Mapping, Metamodel, PropertyDef, RelationshipType

#: Scalar attributes compared on a changed element type.
_EL_ATTRS = ("abstract", "extends", "key")
#: Scalar attributes compared on a changed relationship type (no source/target
#: — see module docstring).
_REL_ATTRS = (
    "abstract",
    "extends",
    "containment",
    "source_multiplicity",
    "target_multiplicity",
)
#: Facets compared on a changed property.
_PROP_FACETS = ("datatype", "multiplicity", "min", "max", "pattern", "max_length")


class FieldChange(BaseModel):
    """One scalar field's before/after. Wire keys are ``field``/``from``/``to``
    (``from`` is a python keyword, hence the alias)."""

    model_config = ConfigDict(populate_by_name=True)

    field: str
    from_: Any = Field(default=None, alias="from")
    to: Any = None


class EnumEntry(BaseModel):
    name: str
    literals: list[str] = Field(default_factory=list)


class EnumChange(BaseModel):
    name: str
    added: list[str] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)


class EnumsDiff(BaseModel):
    added: list[EnumEntry] = Field(default_factory=list)
    removed: list[EnumEntry] = Field(default_factory=list)
    changed: list[EnumChange] = Field(default_factory=list)


class PropertyChange(BaseModel):
    name: str
    fields: list[FieldChange] = Field(default_factory=list)


class PropertiesDiff(BaseModel):
    added: list[PropertyDef] = Field(default_factory=list)
    removed: list[PropertyDef] = Field(default_factory=list)
    changed: list[PropertyChange] = Field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not (self.added or self.removed or self.changed)


class MappingsDiff(BaseModel):
    added: list[Mapping] = Field(default_factory=list)
    removed: list[Mapping] = Field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not (self.added or self.removed)


class ElementTypeChange(BaseModel):
    name: str
    attributes: list[FieldChange] = Field(default_factory=list)
    properties: PropertiesDiff = Field(default_factory=PropertiesDiff)


class ElementTypesDiff(BaseModel):
    added: list[ElementType] = Field(default_factory=list)
    removed: list[ElementType] = Field(default_factory=list)
    changed: list[ElementTypeChange] = Field(default_factory=list)


class RelationshipTypeChange(BaseModel):
    name: str
    attributes: list[FieldChange] = Field(default_factory=list)
    properties: PropertiesDiff = Field(default_factory=PropertiesDiff)
    mappings: MappingsDiff = Field(default_factory=MappingsDiff)


class RelationshipTypesDiff(BaseModel):
    added: list[RelationshipType] = Field(default_factory=list)
    removed: list[RelationshipType] = Field(default_factory=list)
    changed: list[RelationshipTypeChange] = Field(default_factory=list)


class MetamodelStructuralDiff(BaseModel):
    enums: EnumsDiff = Field(default_factory=EnumsDiff)
    element_types: ElementTypesDiff = Field(default_factory=ElementTypesDiff)
    relationship_types: RelationshipTypesDiff = Field(
        default_factory=RelationshipTypesDiff
    )

    @property
    def is_empty(self) -> bool:
        """Convenience for "no structural changes" rendering; deliberately a
        python property (clients derive emptiness from the arrays)."""
        return not (
            self.enums.added
            or self.enums.removed
            or self.enums.changed
            or self.element_types.added
            or self.element_types.removed
            or self.element_types.changed
            or self.relationship_types.added
            or self.relationship_types.removed
            or self.relationship_types.changed
        )


def _field_changes(
    old: BaseModel, new: BaseModel, fields: tuple[str, ...]
) -> list[FieldChange]:
    out: list[FieldChange] = []
    for f in fields:
        a, b = getattr(old, f), getattr(new, f)
        if a != b:
            out.append(FieldChange(field=f, from_=a, to=b))
    return out


def _props_diff(old: list[PropertyDef], new: list[PropertyDef]) -> PropertiesDiff:
    old_by = {p.name: p for p in old}
    new_by = {p.name: p for p in new}
    changed: list[PropertyChange] = []
    for n in sorted(old_by.keys() & new_by.keys()):
        fields = _field_changes(old_by[n], new_by[n], _PROP_FACETS)
        if fields:
            changed.append(PropertyChange(name=n, fields=fields))
    return PropertiesDiff(
        added=[new_by[n] for n in sorted(new_by.keys() - old_by.keys())],
        removed=[old_by[n] for n in sorted(old_by.keys() - new_by.keys())],
        changed=changed,
    )


def _mappings_diff(old: list[Mapping], new: list[Mapping]) -> MappingsDiff:
    old_set = {(m.source, m.target) for m in old}
    new_set = {(m.source, m.target) for m in new}
    return MappingsDiff(
        added=[Mapping(source=s, target=t) for s, t in sorted(new_set - old_set)],
        removed=[Mapping(source=s, target=t) for s, t in sorted(old_set - new_set)],
    )


def _enums_diff(old: dict[str, list[str]], new: dict[str, list[str]]) -> EnumsDiff:
    changed: list[EnumChange] = []
    for n in sorted(old.keys() & new.keys()):
        a, b = set(old[n]), set(new[n])
        added, removed = sorted(b - a), sorted(a - b)
        if added or removed:
            changed.append(EnumChange(name=n, added=added, removed=removed))
    return EnumsDiff(
        added=[EnumEntry(name=n, literals=new[n]) for n in sorted(new.keys() - old.keys())],
        removed=[
            EnumEntry(name=n, literals=old[n]) for n in sorted(old.keys() - new.keys())
        ],
        changed=changed,
    )


def _element_types_diff(
    old: list[ElementType], new: list[ElementType]
) -> ElementTypesDiff:
    old_by = {t.name: t for t in old}
    new_by = {t.name: t for t in new}
    changed: list[ElementTypeChange] = []
    for n in sorted(old_by.keys() & new_by.keys()):
        attrs = _field_changes(old_by[n], new_by[n], _EL_ATTRS)
        props = _props_diff(old_by[n].properties, new_by[n].properties)
        if attrs or not props.is_empty:
            changed.append(ElementTypeChange(name=n, attributes=attrs, properties=props))
    return ElementTypesDiff(
        added=[new_by[n] for n in sorted(new_by.keys() - old_by.keys())],
        removed=[old_by[n] for n in sorted(old_by.keys() - new_by.keys())],
        changed=changed,
    )


def _relationship_types_diff(
    old: list[RelationshipType], new: list[RelationshipType]
) -> RelationshipTypesDiff:
    old_by = {t.name: t for t in old}
    new_by = {t.name: t for t in new}
    changed: list[RelationshipTypeChange] = []
    for n in sorted(old_by.keys() & new_by.keys()):
        attrs = _field_changes(old_by[n], new_by[n], _REL_ATTRS)
        props = _props_diff(old_by[n].properties, new_by[n].properties)
        mappings = _mappings_diff(old_by[n].mappings, new_by[n].mappings)
        if attrs or not props.is_empty or not mappings.is_empty:
            changed.append(
                RelationshipTypeChange(
                    name=n, attributes=attrs, properties=props, mappings=mappings
                )
            )
    return RelationshipTypesDiff(
        added=[new_by[n] for n in sorted(new_by.keys() - old_by.keys())],
        removed=[old_by[n] for n in sorted(old_by.keys() - new_by.keys())],
        changed=changed,
    )


def diff_metamodels(old: Metamodel, new: Metamodel) -> MetamodelStructuralDiff:
    """Compare two metamodel documents structurally. Pure: neither input is
    touched, and the inputs' immutability (schema.py) makes the result stable
    for a given pair."""
    return MetamodelStructuralDiff(
        enums=_enums_diff(old.enums, new.enums),
        element_types=_element_types_diff(old.elements, new.elements),
        relationship_types=_relationship_types_diff(old.relationships, new.relationships),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/metamodel/test_diff.py -v`
Expected: all PASS

- [ ] **Step 5: Lint and commit**

Run: `pixi run core-lint` — must be clean.

```bash
git add src/data_rover/core/metamodel/diff.py tests/metamodel/test_diff.py
git commit -m "feat(core): structural metamodel differ"
```

---

### Task 2: `POST /metamodel/diff` gains the `structural` section

**Files:**
- Modify: `src/data_rover/api/schemas.py` (`MetamodelDiffResponse`, ~line 136)
- Modify: `src/data_rover/api/routes/metamodel_swap.py` (`diff_metamodel`, ~line 71)
- Test: `tests/api/test_metamodel_diff.py` (append)

**Interfaces:**
- Consumes: `diff_metamodels`, `MetamodelStructuralDiff` from `data_rover.core.metamodel.diff` (Task 1).
- Produces: `MetamodelDiffResponse.structural: MetamodelStructuralDiff` on the wire (core model serialized directly, like `GET /metamodel` returns `Metamodel`; `FieldChange` serializes `from` via alias because FastAPI's `jsonable_encoder` uses `by_alias=True`).

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_metamodel_diff.py`. Its `client` fixture seeds `_MM` (element `Node`, relationship `Link` Node→Node) and one Node element; the fixture's TestClient already carries `AUTH_HEADERS`:

```python
# Candidate for the STRUCTURAL diff: Node renamed to Widget (remove+add).
_MM_STRUCT_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Link
    source: Widget
    target: Widget
"""
# Candidate that only tightens Link's source multiplicity (one FieldChange).
_MM_STRUCT_MULT = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
    source_multiplicity: "1..1"
"""


def test_diff_returns_structural_section(client: TestClient) -> None:
    r = client.post(papi("/metamodel/diff"), content=_MM_STRUCT_RENAMED,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    structural = r.json()["structural"]
    assert [t["name"] for t in structural["element_types"]["added"]] == ["Widget"]
    assert [t["name"] for t in structural["element_types"]["removed"]] == ["Node"]
    # Link's endpoints changed => mappings diff only, no attribute noise
    (chg,) = structural["relationship_types"]["changed"]
    assert chg["name"] == "Link"
    assert chg["attributes"] == []
    assert [(m["source"], m["target"]) for m in chg["mappings"]["added"]] == [
        ("Widget", "Widget")
    ]
    # unchanged sections are present-and-empty, not missing
    assert structural["enums"] == {"added": [], "removed": [], "changed": []}


def test_diff_structural_field_change_uses_from_alias(client: TestClient) -> None:
    r = client.post(papi("/metamodel/diff"), content=_MM_STRUCT_MULT,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    (chg,) = r.json()["structural"]["relationship_types"]["changed"]
    (fc,) = chg["attributes"]
    assert fc == {"field": "source_multiplicity", "from": "0..*", "to": "1..1"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_diff.py -v`
Expected: new tests FAIL with `KeyError: 'structural'`; existing tests still pass.

- [ ] **Step 3: Implement**

In `schemas.py`, add the import and field:

```python
from data_rover.core.metamodel.diff import MetamodelStructuralDiff

class MetamodelDiffResponse(BaseModel):
    """Read-only sandbox conformance diff (Phase 6B) + structural document
    diff (Phase 4). now_failing = issues the candidate metamodel introduces;
    now_passing = issues it resolves; structural = what changed in the
    document itself (one differ, also rendered by the commit-diff API)."""

    now_failing: list[IssueOut]
    now_passing: list[IssueOut]
    unchanged_count: int
    current_error_count: int
    candidate_error_count: int
    structural: MetamodelStructuralDiff = Field(
        default_factory=MetamodelStructuralDiff
    )
```

In `routes/metamodel_swap.py`'s `diff_metamodel`: bind the metamodel from `require_model` (currently discarded as `_`) and compute the structural diff OUTSIDE the write-mutex (both objects are immutable; the mutex section stays validation-only):

```python
from data_rover.core.metamodel.diff import diff_metamodels
...
    current_mm, model = require_model(session)
    candidate = _load_candidate(await _read_metamodel_blob(request))
    structural = diff_metamodels(current_mm, candidate)
    with session.write_mutex:
        ...  # unchanged
    return MetamodelDiffResponse(
        ...,  # existing fields unchanged
        structural=structural,
    )
```

(Check `require_model`'s actual return order in `deps.py` before assuming — the existing line is `_, model = require_model(session)`; the first element is the metamodel.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_diff.py -v`
Expected: all PASS

- [ ] **Step 5: Lint and commit**

Run: `pixi run backend-lint`

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/metamodel_swap.py tests/api/test_metamodel_diff.py
git commit -m "feat(api): structural section on POST /metamodel/diff"
```

---

### Task 3: Metamodel writers honor the `mm` lease

**Files:**
- Modify: `src/data_rover/api/routes/metamodel.py` (add peer-lease helper + honor in upload/clear)
- Modify: `src/data_rover/api/routes/metamodel_swap.py` (honor in rebind)
- Test: `tests/api/test_metamodel_rebind.py` (append)

**Interfaces:**
- Consumes: `LockTable.peer_leases(resource_ids, holder, *, now)` and `METAMODEL_RESOURCE` from `..locking`; `get_current_user` from `..identity`.
- Produces: `_peer_mm_conflict(session, user_id) -> JSONResponse | None` in `routes/metamodel.py` (imported by `metamodel_swap.py`). The 409 body is `{"detail": "metamodel locked", "holder_email": "<email>"}` — the frontend (Task 7) matches on the exact `detail` string.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_metamodel_rebind.py` (it already imports `db`, `add_member`, `Role`, `DEFAULT_PROJECT_ID`, and has `_MM`/`_MM_RENAMED` and the `client` fixture):

```python
def _add_editor(user_id: str, email: str) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        from data_rover.api.db_models import User
        s.add(User(id=user_id, email=email))
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
        s.commit()
    finally:
        gen.close()


_PEER = {"x-user-id": "peer", "x-user-email": "peer@example.com"}


def _acquire_mm(c: TestClient, headers: dict[str, str]) -> None:
    r = c.post(
        papi("/locks"), headers=headers,
        json={
            "targets": [
                {"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text


def test_rebind_409_when_peer_holds_mm_lease(client: TestClient) -> None:
    _add_editor("peer", "peer@example.com")
    _acquire_mm(client, _PEER)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={_rev(client)}",
        content=_MM_RENAMED,
        headers={"content-type": "application/x-yaml", **AUTH_HEADERS},
    )
    assert r.status_code == 409
    body = r.json()
    assert body["detail"] == "metamodel locked"
    assert body["holder_email"] == "peer@example.com"


def test_rebind_proceeds_when_caller_holds_mm_lease(client: TestClient) -> None:
    _acquire_mm(client, AUTH_HEADERS)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={_rev(client)}",
        content=_MM_RENAMED,
        headers={"content-type": "application/x-yaml", **AUTH_HEADERS},
    )
    assert r.status_code == 200, r.text


def test_upload_409_when_peer_holds_mm_lease(client: TestClient) -> None:
    _add_editor("peer", "peer@example.com")
    _acquire_mm(client, _PEER)
    r = client.post(
        papi("/metamodel"),
        content=_MM,
        headers={"content-type": "application/x-yaml", **AUTH_HEADERS},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "metamodel locked"


def test_clear_409_when_peer_holds_mm_lease(client: TestClient) -> None:
    _add_editor("peer", "peer@example.com")
    _acquire_mm(client, _PEER)
    r = client.delete(papi("/metamodel"), headers=AUTH_HEADERS)
    assert r.status_code == 409
    assert r.json()["detail"] == "metamodel locked"
```

Note: if the existing `client` fixture's requests don't pass `AUTH_HEADERS` on `POST /metamodel/rebind` (some do it via bare posts), match the file's existing call style — the tests above are the shape, adapt header plumbing to what the file already does.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_rebind.py -v`
Expected: the four new tests FAIL (rebind/upload/clear currently ignore the `mm` lease — rebind returns 200, upload 409s with "model not empty" or 200, clear 204). Existing tests still pass.

- [ ] **Step 3: Implement**

In `routes/metamodel.py`:

```python
import time

from fastapi.responses import JSONResponse

from ..db_models import User
from ..identity import get_current_user
from ..locking import METAMODEL_RESOURCE


def _peer_mm_conflict(session: Session, user_id: str) -> JSONResponse | None:
    """409 payload when a PEER holds the ``mm`` lease, else None.

    Honor-don't-require (spec 2026-08-10): the caller's own lease never
    blocks, and no lease at all is fine — the lease is a guarantee only if
    every metamodel writer honors it, exactly like the artifact writers
    honor ``art:`` leases. Callers: upload/clear here, rebind in
    metamodel_swap.py.
    """
    peers = session.lock_table.peer_leases(
        [METAMODEL_RESOURCE], user_id, now=time.monotonic()
    )
    if peers:
        return JSONResponse(
            status_code=409,
            content={
                "detail": "metamodel locked",
                "holder_email": peers[0].holder_email,
            },
        )
    return None
```

Wire it into `upload_metamodel` — the lease check comes FIRST, before the model-not-empty check, so a locked metamodel refuses all writers uniformly — and into `clear_metamodel`. Both routes gain a `user: User = Depends(get_current_user)` parameter and `response_model=None` on the decorator (their return types become unions with `JSONResponse`):

```python
@router.post("/metamodel", response_model=None)
async def upload_metamodel(..., user: User = Depends(get_current_user)) -> Metamodel | JSONResponse:
    conflict = _peer_mm_conflict(session, user.id)
    if conflict is not None:
        return conflict
    if session.model is not None and session.model.elements:
        ...  # existing 409 unchanged


@router.delete("/metamodel", status_code=204, response_model=None)
def clear_metamodel(..., user: User = Depends(get_current_user)) -> Response | JSONResponse:
    conflict = _peer_mm_conflict(session, user.id)
    if conflict is not None:
        return conflict
    ...
```

In `routes/metamodel_swap.py`'s `rebind_metamodel`, inside the `with session.write_mutex:` block, BEFORE the existing `model_leases` check:

```python
from .metamodel import _peer_mm_conflict
...
    with session.write_mutex:
        conflict = _peer_mm_conflict(session, user.id)
        if conflict is not None:
            return conflict
        model_leases = [...]  # existing check unchanged
```

Also extend the rebind docstring: the quiescence check covers MODEL leases; the `mm` peer check is the Phase 4 honor rule (own lease fine, peer lease 409-with-email; the server does NOT release the caller's lease on success — the request carries no token, the client surface releases its own).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_rebind.py tests/api/test_metamodel_diff.py -v`
Expected: all PASS (including the pre-existing quiescence and 403 tests).

- [ ] **Step 5: Lint and commit**

Run: `pixi run backend-lint`

```bash
git add src/data_rover/api/routes/metamodel.py src/data_rover/api/routes/metamodel_swap.py tests/api/test_metamodel_rebind.py
git commit -m "feat(api): metamodel writers honor the mm lease with holder detail"
```

---

### Task 4: Commit-diff renders the structural diff for rebind commits

**Files:**
- Modify: `src/data_rover/api/schemas.py` (`CommitDiffOut`, ~line 885)
- Modify: `src/data_rover/api/commit_diff.py` (`diff_commit`, ~line 368)
- Test: `tests/api/test_commit_diff.py` (append)

**Interfaces:**
- Consumes: `diff_metamodels`, `MetamodelStructuralDiff` (Task 1); `content.get_metamodel_row(db, metamodel_id) -> MetamodelRow | None`; `load_metamodel_str` / `MetamodelError` from `data_rover.core.metamodel.loader`.
- Produces: `CommitDiffOut.metamodel: MetamodelStructuralDiff | None` — non-None only for rebind commits with both blobs loadable.

- [ ] **Step 1: Write the failing tests**

Read `tests/api/test_commit_diff.py`'s `client` fixture first (its seeded metamodel `_MM` is a single `Node` element with a `label` property — no relationships) and reuse it. Add these imports at the top: `from data_rover.api import content, db` and `from data_rover.api.session import DEFAULT_PROJECT_ID`. Then append:

```python
# Rebind candidate: Node renamed to Widget, label property gone with it.
_MM_REBOUND = """
elements:
  - name: Widget
"""


def _model_rev(client: TestClient) -> int:
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_rebind_commit_diff_carries_structural_metamodel_diff(client) -> None:
    before = _model_rev(client)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={before}&message=swap",
        content=_MM_REBOUND,
        headers={"content-type": "application/x-yaml", **AUTH_HEADERS},
    )
    assert r.status_code == 200, r.text
    rev = r.json()["model_rev"]
    d = client.get(papi(f"/commits/{rev}/diff"), headers=AUTH_HEADERS)
    assert d.status_code == 200, d.text
    body = d.json()
    assert body["is_rebind"] is True
    mm = body["metamodel"]
    assert [t["name"] for t in mm["element_types"]["added"]] == ["Widget"]
    assert [t["name"] for t in mm["element_types"]["removed"]] == ["Node"]
    # removed side carries the full definition, including its property
    assert mm["element_types"]["removed"][0]["properties"][0]["name"] == "label"


def test_non_rebind_commit_diff_has_null_metamodel(client) -> None:
    # any ordinary ops commit will do — land one element create
    ops_r = client.post(
        papi("/model/ops"),
        json={
            "base_rev": _model_rev(client),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_x", "type_name": "Node"}
            ],
        },
        headers=AUTH_HEADERS,
    )
    assert ops_r.status_code == 200, ops_r.text
    rev = ops_r.json()["model_rev"]
    d = client.get(papi(f"/commits/{rev}/diff"), headers=AUTH_HEADERS)
    assert d.status_code == 200, d.text
    assert d.json()["is_rebind"] is False
    assert d.json()["metamodel"] is None


def test_rebind_commit_diff_degrades_to_null_on_missing_blob(client) -> None:
    # a synthetic rebind commit whose metamodel ids point nowhere: degraded
    # to null, never a 500
    gen = db.get_db()
    s = next(gen)
    try:
        content.append_commit(
            s, DEFAULT_PROJECT_ID, rev=999, commit_id="deadbeef", author_id=None,
            ops=[], inverse_ops=[], id_map={},
            from_metamodel_id="missing-a", to_metamodel_id="missing-b",
        )
        s.commit()
    finally:
        gen.close()
    d = client.get(papi("/commits/999/diff"), headers=AUTH_HEADERS)
    assert d.status_code == 200, d.text
    assert d.json()["is_rebind"] is True
    assert d.json()["metamodel"] is None
```

(Check `content.append_commit`'s exact signature before writing — `routes/metamodel_swap.py:183` shows the kwargs it accepts; drop any the function doesn't take. If this file's `client` fixture does not exist under that name or seeds differently, adapt the seed calls but keep the assertions identical. If `POST /model/ops` requires a different op shape here, copy the op literal from `tests/api/test_metamodel_diff.py`'s fixture, which lands exactly this create.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_diff.py -v`
Expected: new tests FAIL with `KeyError: 'metamodel'` / assertion errors; existing tests pass.

- [ ] **Step 3: Implement**

`schemas.py` — add to `CommitDiffOut` (below `is_rebind`), plus the docstring line "``metamodel`` is the structural document diff, recomputed from the two immutable MetamodelRow blobs — only for rebind commits, and None when either blob is missing/unparseable (degraded, never failed)":

```python
    metamodel: MetamodelStructuralDiff | None = None
```

`commit_diff.py` — add imports (`yaml`; `from data_rover.core.metamodel.diff import MetamodelStructuralDiff, diff_metamodels`; `from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str`; `from . import content` if not already imported) and a helper:

```python
def _metamodel_structural(db: DbSession, commit: Commit) -> MetamodelStructuralDiff | None:
    """The rebind commit's document diff, recomputed from the two immutable
    MetamodelRow blobs (spec: recompute, never store). Total: any missing id,
    missing row, or unparseable blob degrades to None — a broken historical
    blob must not 500 the whole commit diff."""
    if commit.from_metamodel_id is None or commit.to_metamodel_id is None:
        return None
    before = content.get_metamodel_row(db, commit.from_metamodel_id)
    after = content.get_metamodel_row(db, commit.to_metamodel_id)
    if before is None or after is None:
        return None
    try:
        return diff_metamodels(
            load_metamodel_str(before.blob), load_metamodel_str(after.blob)
        )
    except (MetamodelError, yaml.YAMLError):
        return None
```

In `diff_commit`, after `is_rebind` is computed, thread it into the return:

```python
    return CommitDiffOut(
        ...,
        is_rebind=is_rebind,
        metamodel=_metamodel_structural(db, commit) if is_rebind else None,
        ...,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_commit_diff.py tests/api/test_metamodel_rebind.py -v`
Expected: all PASS

- [ ] **Step 5: Lint and commit**

Run: `pixi run backend-lint`

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/commit_diff.py tests/api/test_commit_diff.py
git commit -m "feat(api): render structural metamodel diff on rebind commit diffs"
```

---

### Task 5: Frontend types + standalone `MetamodelStructuralDiff` component

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (zod schemas; `MetamodelDiffSchema` gains `structural`)
- Create: `frontend/src/lib/components/MetamodelStructuralDiff.svelte`
- Test: `frontend/src/lib/components/__tests__/MetamodelStructuralDiff.test.ts`

**Interfaces:**
- Consumes: existing `PropertyDefSchema`, `ElementTypeSchema`, `RelationshipTypeSchema`, `MappingSchema` in `types.ts`.
- Produces: `MetamodelStructuralDiffSchema` + `type MetamodelStructuralDiff`; `MetamodelDiff` (the `diffMetamodel` return type) gains `.structural`; a component with prop `{ diff: MetamodelStructuralDiff }`.

- [ ] **Step 1: Add the zod schemas** (in `types.ts`, near `MetamodelSchema`; frontend files are TAB-indented):

```ts
// --- structural metamodel diff (Phase 4) -----------------------------------
export const FieldChangeSchema = z.object({
	field: z.string(),
	from: z.unknown(),
	to: z.unknown()
});
export type FieldChange = z.infer<typeof FieldChangeSchema>;

const EnumEntrySchema = z.object({ name: z.string(), literals: z.array(z.string()).default([]) });
const EnumChangeSchema = z.object({
	name: z.string(),
	added: z.array(z.string()).default([]),
	removed: z.array(z.string()).default([])
});
const EnumsDiffSchema = z.object({
	added: z.array(EnumEntrySchema).default([]),
	removed: z.array(EnumEntrySchema).default([]),
	changed: z.array(EnumChangeSchema).default([])
});

const PropertyChangeSchema = z.object({
	name: z.string(),
	fields: z.array(FieldChangeSchema).default([])
});
const PropertiesDiffSchema = z.object({
	added: z.array(PropertyDefSchema).default([]),
	removed: z.array(PropertyDefSchema).default([]),
	changed: z.array(PropertyChangeSchema).default([])
});

const ElementTypeChangeSchema = z.object({
	name: z.string(),
	attributes: z.array(FieldChangeSchema).default([]),
	properties: PropertiesDiffSchema
});
const ElementTypesDiffSchema = z.object({
	added: z.array(ElementTypeSchema).default([]),
	removed: z.array(ElementTypeSchema).default([]),
	changed: z.array(ElementTypeChangeSchema).default([])
});

// An added/removed ABSTRACT relationship type can have null source/target
// (the shorthand mirrors mappings[0], which may not exist), so the diff
// entries relax RelationshipTypeSchema's non-null endpoints.
const RelationshipTypeDiffEntrySchema = RelationshipTypeSchema.extend({
	source: z.string().nullable().default(null),
	target: z.string().nullable().default(null)
});
const MappingsDiffSchema = z.object({
	added: z.array(MappingSchema).default([]),
	removed: z.array(MappingSchema).default([])
});
const RelationshipTypeChangeSchema = z.object({
	name: z.string(),
	attributes: z.array(FieldChangeSchema).default([]),
	properties: PropertiesDiffSchema,
	mappings: MappingsDiffSchema
});
const RelationshipTypesDiffSchema = z.object({
	added: z.array(RelationshipTypeDiffEntrySchema).default([]),
	removed: z.array(RelationshipTypeDiffEntrySchema).default([]),
	changed: z.array(RelationshipTypeChangeSchema).default([])
});

export const MetamodelStructuralDiffSchema = z.object({
	enums: EnumsDiffSchema,
	element_types: ElementTypesDiffSchema,
	relationship_types: RelationshipTypesDiffSchema
});
export type MetamodelStructuralDiff = z.infer<typeof MetamodelStructuralDiffSchema>;
```

And extend `MetamodelDiffSchema`:

```ts
export const MetamodelDiffSchema = z.object({
	now_failing: z.array(IssueOutSchema).default([]),
	now_passing: z.array(IssueOutSchema).default([]),
	unchanged_count: z.number().int(),
	current_error_count: z.number().int(),
	candidate_error_count: z.number().int(),
	structural: MetamodelStructuralDiffSchema
});
```

- [ ] **Step 2: Write the failing component test**

Mirror the setup style of `frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts` (read it first for the render/testing-library idioms). Behaviors to cover:

```ts
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import MetamodelStructuralDiff from '../MetamodelStructuralDiff.svelte';
import type { MetamodelStructuralDiff as Diff } from '$lib/api/types';

const EMPTY: Diff = {
	enums: { added: [], removed: [], changed: [] },
	element_types: { added: [], removed: [], changed: [] },
	relationship_types: { added: [], removed: [], changed: [] }
};

describe('MetamodelStructuralDiff', () => {
	it('renders the empty state when nothing changed', () => {
		render(MetamodelStructuralDiff, { props: { diff: EMPTY } });
		expect(screen.getByText(/no structural changes/i)).toBeTruthy();
	});

	it('renders added/removed type names and per-facet changes', () => {
		const diff: Diff = {
			...EMPTY,
			element_types: {
				added: [{ name: 'Sensor', abstract: false, extends: null, properties: [], key: null }],
				removed: [],
				changed: [
					{
						name: 'Building',
						attributes: [{ field: 'extends', from: null, to: 'Asset' }],
						properties: {
							added: [],
							removed: [],
							changed: [
								{ name: 'height', fields: [{ field: 'max', from: 10, to: 20 }] }
							]
						}
					}
				]
			}
		};
		render(MetamodelStructuralDiff, { props: { diff } });
		expect(screen.getByText('Sensor')).toBeTruthy();
		expect(screen.getByText('Building')).toBeTruthy();
		expect(screen.getByText(/max/)).toBeTruthy();
		expect(screen.getByText(/10\s*→\s*20/)).toBeTruthy();
	});

	it('renders enum literal changes and relationship mapping changes', () => {
		const diff: Diff = {
			...EMPTY,
			enums: { added: [], removed: [], changed: [{ name: 'Status', added: ['archived'], removed: [] }] },
			relationship_types: {
				added: [],
				removed: [],
				changed: [
					{
						name: 'Owns',
						attributes: [],
						properties: { added: [], removed: [], changed: [] },
						mappings: { added: [{ source: 'City', target: 'Park' }], removed: [] }
					}
				]
			}
		};
		render(MetamodelStructuralDiff, { props: { diff } });
		expect(screen.getByText('Status')).toBeTruthy();
		expect(screen.getByText(/archived/)).toBeTruthy();
		expect(screen.getByText(/City\s*→\s*Park/)).toBeTruthy();
	});
});
```

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/MetamodelStructuralDiff.test.ts'`
Expected: FAIL (component does not exist)

- [ ] **Step 3: Implement the component** (minimal styling per spec — it outlives the drawer and gets restyled in the Phase 5 editor):

```svelte
<script lang="ts">
	import type { MetamodelStructuralDiff } from '$lib/api/types';

	type Props = { diff: MetamodelStructuralDiff };
	let { diff }: Props = $props();

	const empty = $derived(
		diff.enums.added.length +
			diff.enums.removed.length +
			diff.enums.changed.length +
			diff.element_types.added.length +
			diff.element_types.removed.length +
			diff.element_types.changed.length +
			diff.relationship_types.added.length +
			diff.relationship_types.removed.length +
			diff.relationship_types.changed.length ===
			0
	);

	function fmt(v: unknown): string {
		if (v === null || v === undefined) return '—';
		return typeof v === 'string' ? v : JSON.stringify(v);
	}
</script>

{#if empty}
	<p class="text-xs text-muted-foreground">No structural changes.</p>
{:else}
	<div class="flex flex-col gap-2 text-xs">
		{@render typeSection('Element types', diff.element_types.added, diff.element_types.removed)}
		{#each diff.element_types.changed as chg (chg.name)}
			{@render changedType(chg.name, chg.attributes, chg.properties, null)}
		{/each}
		{@render typeSection(
			'Relationship types',
			diff.relationship_types.added,
			diff.relationship_types.removed
		)}
		{#each diff.relationship_types.changed as chg (chg.name)}
			{@render changedType(chg.name, chg.attributes, chg.properties, chg.mappings)}
		{/each}
		{#if diff.enums.added.length || diff.enums.removed.length || diff.enums.changed.length}
			<section class="flex flex-col gap-1">
				<h4 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					Enums
				</h4>
				{#each diff.enums.added as e (e.name)}
					<p><span class="text-success">+ added</span> <span class="font-mono">{e.name}</span></p>
				{/each}
				{#each diff.enums.removed as e (e.name)}
					<p>
						<span class="text-destructive">− removed</span> <span class="font-mono">{e.name}</span>
					</p>
				{/each}
				{#each diff.enums.changed as e (e.name)}
					<p>
						<span class="font-mono">{e.name}</span>
						{#if e.added.length}<span class="text-success">+{e.added.join(', +')}</span>{/if}
						{#if e.removed.length}<span class="text-destructive">−{e.removed.join(', −')}</span>{/if}
					</p>
				{/each}
			</section>
		{/if}
	</div>
{/if}

{#snippet typeSection(
	title: string,
	added: { name: string }[],
	removed: { name: string }[]
)}
	{#if added.length || removed.length}
		<section class="flex flex-col gap-1">
			<h4 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</h4>
			{#each added as t (t.name)}
				<p><span class="text-success">+ added</span> <span class="font-mono">{t.name}</span></p>
			{/each}
			{#each removed as t (t.name)}
				<p>
					<span class="text-destructive">− removed</span> <span class="font-mono">{t.name}</span>
				</p>
			{/each}
		</section>
	{/if}
{/snippet}

{#snippet changedType(
	name: string,
	attributes: { field: string; from?: unknown; to?: unknown }[],
	properties: {
		added: { name: string }[];
		removed: { name: string }[];
		changed: { name: string; fields: { field: string; from?: unknown; to?: unknown }[] }[];
	},
	mappings: {
		added: { source: string; target: string }[];
		removed: { source: string; target: string }[];
	} | null
)}
	<section class="flex flex-col gap-0.5 rounded border border-border bg-muted/40 px-2 py-1.5">
		<p class="font-mono font-semibold">{name}</p>
		{#each attributes as a (a.field)}
			<p class="pl-2">{a.field}: {fmt(a.from)} → {fmt(a.to)}</p>
		{/each}
		{#each properties.added as p (p.name)}
			<p class="pl-2"><span class="text-success">+ property</span> {p.name}</p>
		{/each}
		{#each properties.removed as p (p.name)}
			<p class="pl-2"><span class="text-destructive">− property</span> {p.name}</p>
		{/each}
		{#each properties.changed as p (p.name)}
			{#each p.fields as f (f.field)}
				<p class="pl-2">{p.name}.{f.field}: {fmt(f.from)} → {fmt(f.to)}</p>
			{/each}
		{/each}
		{#if mappings}
			{#each mappings.added as m (m.source + m.target)}
				<p class="pl-2"><span class="text-success">+ mapping</span> {m.source} → {m.target}</p>
			{/each}
			{#each mappings.removed as m (m.source + m.target)}
				<p class="pl-2">
					<span class="text-destructive">− mapping</span> {m.source} → {m.target}
				</p>
			{/each}
		{/if}
	</section>
{/snippet}
```

- [ ] **Step 4: Run the tests + existing suite for regressions**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/MetamodelStructuralDiff.test.ts src/lib/components/__tests__/SwapMetamodelDrawer.test.ts'`
Expected: new tests PASS. The SwapMetamodelDrawer tests may now FAIL if their MSW/mocked `/metamodel/diff` responses lack `structural` (the zod schema requires it) — fix those mocks by adding an empty `structural` object; that is expected fallout, not a regression.

- [ ] **Step 5: Format, lint, commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npx prettier --write src/lib/api/types.ts src/lib/components/MetamodelStructuralDiff.svelte src/lib/components/__tests__/MetamodelStructuralDiff.test.ts && npm run lint && npm run check'`

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/components/MetamodelStructuralDiff.svelte frontend/src/lib/components/__tests__/MetamodelStructuralDiff.test.ts frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts
git commit -m "feat(ui): structural metamodel diff types and standalone renderer"
```

---

### Task 6: Quiet-predicate fix + `mm` lease lifecycle module

**Files:**
- Modify: `frontend/src/lib/state/realtime.svelte.ts` (`hasModelLocks`, ~line 98)
- Modify: `frontend/src/lib/state/checkout.svelte.ts` (add `releaseMetamodelLease`)
- Create: `frontend/src/lib/state/metamodel-lease.svelte.ts`
- Test: `frontend/src/lib/state/__tests__/quiet.test.ts` (update the `'mm'` case), Create: `frontend/src/lib/state/__tests__/checkout.metamodel.test.ts`

**Interfaces:**
- Consumes: `ensureCheckout(targets, intent)`, `lockHolderLabel(res)`, `_registry`-backed helpers from `checkout.svelte.ts`.
- Produces: `releaseMetamodelLease(): Promise<void>` (checkout store); `acquireMetamodelLease(): Promise<boolean>`, `dropMetamodelLease(): Promise<void>`, `getMetamodelLockHolder(): string | null` (lease module). Task 7's drawer consumes exactly these three.

- [ ] **Step 1: Update the quiet test + write the failing lease tests**

In `quiet.test.ts` (~line 64) the `snapshotWithLocks('mm')` case currently asserts the project is NOT quiet. Flip it: an `mm` lease must NOT break quiet. Rationale for the comment: the backend's quiescence check (`is_model_resource` in `locking.py`) excludes `"mm"`; counting it client-side would make the swap drawer's own lease disable its own Rebind button.

New `checkout.metamodel.test.ts` — mirror the mocking style of `checkout.ensure.test.ts` (read it first; it mocks `$lib/api/checkout`). Behaviors:

```ts
// 1. acquireMetamodelLease() sends ONE /locks call with
//    [{resource_id: 'mm', mode: 'exclusive', type: 'metamodel'}], intent 'edit',
//    and returns true on grant (lease recorded => isCheckedOutByMe('mm')).
// 2. On a 409 ConflictError with conflicts [{resource_id: 'mm', held_by: 'u2',
//    held_by_email: 'peer@x.io', held_mode: 'exclusive'}], it returns false and
//    getMetamodelLockHolder() === 'peer@x.io'.
// 3. dropMetamodelLease() calls releaseLock with the granted token, clears the
//    registry entry ('mm' no longer checked out), and resets the holder to null.
// 4. Generation guard: dropMetamodelLease() called while an acquire is still
//    in flight => when the grant lands it is released, not recorded (mock a
//    delayed acquireLocks; assert releaseLock called with its token and
//    isCheckedOutByMe('mm') stays false).
// 5. releaseMetamodelLease() is a no-op when no mm lease is held (releaseLock
//    not called).
// Remember setProjectInfo({role: 'owner', lockTtlSeconds: 300}) in setup and
// resetCheckout() between tests.
```

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/checkout.metamodel.test.ts src/lib/state/__tests__/quiet.test.ts'`
Expected: FAIL (module missing; quiet still counts `mm`)

- [ ] **Step 2: Implement**

`realtime.svelte.ts` — exclude `mm`, mirroring the backend:

```ts
export function hasModelLocks(): boolean {
	for (const rid of _lockState.keys()) {
		// 'mm' mirrors the backend's is_model_resource: the metamodel lease is
		// not a model-scope lease. Rebind's quiescence check ignores it server-
		// side (peer-mm gets its own 409-with-email), and counting it here would
		// make the swap drawer's own lease disable its own Rebind button.
		if (rid !== 'mm' && !isArtifactResource(rid) && !isFolderResource(rid)) return true;
	}
	return false;
}
```

`checkout.svelte.ts` — next to `releaseFolderLeaseIfUnneeded`:

```ts
/**
 * Release my `mm` lease (metamodel surface close). Best-effort like its
 * artifact/folder siblings. Unlike them it needs no staged-ops check: the mm
 * lease is always acquired standalone by the metamodel surface (its own
 * /locks call, its own token) and `lockedResourcesNeededBy` never emits
 * `mm` — no staged op can require it.
 */
export async function releaseMetamodelLease(): Promise<void> {
	const token = _registry.get('mm')?.token;
	if (token === undefined) return;
	_dropToken(token);
	await releaseLock(token, _clientConfig).catch(() => {});
	if (_registry.size === 0) _stopHeartbeat();
}
```

`metamodel-lease.svelte.ts`:

```ts
import {
	ensureCheckout,
	lockHolderLabel,
	releaseMetamodelLease
} from './checkout.svelte';

/**
 * The `mm` lease lifecycle, keyed to whichever surface is editing the
 * metamodel — the SwapMetamodelDrawer today, the Phase 5 metamodel editor
 * tomorrow. Lives outside the drawer so it survives the drawer's removal.
 *
 * Generation-guarded (house async-dialog rule): a surface that closes while
 * an acquire is in flight bumps the generation, and the late grant is
 * released instead of recorded as held-by-nobody.
 */

let _generation = 0;
let _holder = $state<string | null>(null);

/** Email of the peer the last acquire attempt was refused over; null after a
 * successful acquire, a drop, or before any attempt. */
export function getMetamodelLockHolder(): string | null {
	return _holder;
}

/** Acquire the EXCLUSIVE `mm` lease. True on grant. On a peer conflict,
 * false with the holder's label readable via getMetamodelLockHolder(). */
export async function acquireMetamodelLease(): Promise<boolean> {
	const gen = ++_generation;
	_holder = null;
	const res = await ensureCheckout(
		[{ resource_id: 'mm', mode: 'exclusive', type: 'metamodel' }],
		'edit'
	);
	if (gen !== _generation) {
		// Surface closed mid-acquire: hand a late grant straight back.
		if (res.ok) void releaseMetamodelLease();
		return false;
	}
	if (res.ok) return true;
	if (res.reason === 'conflict') _holder = lockHolderLabel(res);
	return false;
}

/** Release the lease and reset holder state (surface close/cancel/success). */
export async function dropMetamodelLease(): Promise<void> {
	_generation++;
	_holder = null;
	await releaseMetamodelLease();
}
```

(Check `LockTargetIn`'s TS type in `api/types.ts` for the exact target literal — `type: 'metamodel'` exists there already.)

- [ ] **Step 3: Run the tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/checkout.metamodel.test.ts src/lib/state/__tests__/quiet.test.ts'`
Expected: PASS

- [ ] **Step 4: Full frontend suite for regressions**

Run: `pixi run frontend-test`
Expected: all pass (watch for other tests asserting `mm` breaks quiet).

- [ ] **Step 5: Format, lint, commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npx prettier --write src/lib/state/realtime.svelte.ts src/lib/state/checkout.svelte.ts src/lib/state/metamodel-lease.svelte.ts src/lib/state/__tests__/checkout.metamodel.test.ts src/lib/state/__tests__/quiet.test.ts && npm run lint && npm run check'`

```bash
git add frontend/src/lib/state/realtime.svelte.ts frontend/src/lib/state/checkout.svelte.ts frontend/src/lib/state/metamodel-lease.svelte.ts frontend/src/lib/state/__tests__/checkout.metamodel.test.ts frontend/src/lib/state/__tests__/quiet.test.ts
git commit -m "feat(ui): mm lease lifecycle module; quiet predicate excludes mm"
```

---

### Task 7: SwapMetamodelDrawer integration

**Files:**
- Modify: `frontend/src/lib/components/SwapMetamodelDrawer.svelte`
- Test: `frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts` (extend)

**Interfaces:**
- Consumes: `acquireMetamodelLease` / `dropMetamodelLease` / `getMetamodelLockHolder` (Task 6); `MetamodelStructuralDiff` component (Task 5); `diff.structural` on the `MetamodelDiff` type (Task 5); the 409 body `{detail: "metamodel locked", holder_email}` (Task 3).
- Produces: final drawer behavior; no new exports.

- [ ] **Step 1: Extend the drawer tests** (read the existing file's mocking setup first; add `vi.mock` for `$lib/state/metamodel-lease.svelte`):

```ts
// New cases:
// 1. Owner picks a file => acquireMetamodelLease() called BEFORE diffMetamodel;
//    on grant, diff runs and review step renders (including the structural
//    section — assert some structural content or the "No structural changes."
//    empty state from the mocked diff response).
// 2. Owner picks a file, acquire returns false with holder 'peer@x.io' =>
//    drawer stays on pick step, shows /metamodel locked by peer@x\.io/i,
//    diffMetamodel NOT called.
// 3. Non-owner (editor role mock) picks a file => acquireMetamodelLease NOT
//    called, diff still runs (read-only review must not lock the owner out).
// 4. Closing the drawer calls dropMetamodelLease().
// 5. Rebind 409 with body {detail: 'metamodel locked', holder_email: 'p@x.io'}
//    => error copy /metamodel locked by p@x\.io/i.
//    409 with {detail: 'active locks; rebind requires a quiet project'} =>
//    the not-quiet copy. 409 with {detail: 'stale base_rev'} => the re-run-
//    the-diff copy.
```

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/SwapMetamodelDrawer.test.ts'`
Expected: new cases FAIL

- [ ] **Step 2: Implement the drawer changes**

Script additions:

```ts
import MetamodelStructuralDiff from './MetamodelStructuralDiff.svelte';
import {
	acquireMetamodelLease,
	dropMetamodelLease,
	getMetamodelLockHolder
} from '$lib/state/metamodel-lease.svelte';

let lockedBy = $state<string | null>(null);
```

`onPick` — acquire FIRST (owners only — an editor's read-only review must not lock the owner out), then diff:

```ts
async function onPick(ev: Event): Promise<void> {
	const input = ev.currentTarget as HTMLInputElement;
	const f = input.files?.[0];
	if (!f) return;
	step = 'diffing';
	errorMsg = null;
	lockedBy = null;
	try {
		const text = await f.text();
		blob = text;
		candidateName = f.name;
		if (isOwner) {
			const granted = await acquireMetamodelLease();
			if (!granted) {
				const holder = getMetamodelLockHolder();
				if (holder) {
					// A peer is mid-review: stop before spending the diff.
					lockedBy = holder;
					step = 'pick';
					return;
				}
				// Non-conflict refusal (e.g. transient): fall through — the
				// rebind itself still honors the lease server-side.
			}
		}
		diff = await diffMetamodel(text);
		step = 'review';
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		errorMsg = `Couldn't read the candidate or run the diff: ${msg}`;
		step = 'error';
	}
}
```

`reset()` gains `lockedBy = null;`. The Dialog root releases on close:

```svelte
<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		if (!o) {
			reset();
			void dropMetamodelLease();
		}
	}}
>
```

(Successful rebind already sets `open = false`, so the same path releases after success — server-side release does not exist by design.)

Pick-step locked notice (after the file input label):

```svelte
{#if lockedBy}
	<p class="rounded border border-warning/40 bg-warning/15 px-2 py-1.5 text-xs text-warning">
		Metamodel locked by {lockedBy}. Try again when they finish.
	</p>
{/if}
```

Review step — host the structural section above the validation-impact sections:

```svelte
{#if step === 'review' && diff}
	<section class="flex flex-col gap-1">
		<h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
			Structural changes
		</h3>
		<MetamodelStructuralDiff diff={diff.structural} />
	</section>
	<!-- existing counts row + Now failing / Now passing sections unchanged -->
```

Rebind 409 handling — replace the `detail.includes('lock')` string-match with structured branches:

```ts
if (e instanceof ApiError && e.status === 409) {
	const body = (typeof e.body === 'object' && e.body ? e.body : {}) as {
		detail?: unknown;
		holder_email?: unknown;
	};
	const detail = typeof body.detail === 'string' ? body.detail : '';
	if (detail === 'metamodel locked') {
		const who =
			typeof body.holder_email === 'string' && body.holder_email
				? body.holder_email
				: 'another user';
		rebindError = `Metamodel locked by ${who}. Try again when they finish.`;
	} else if (detail.startsWith('active locks')) {
		rebindError =
			'The project is not quiet (a lock is active). Try again once edits are committed.';
	} else {
		rebindError = 'The model changed since you ran the diff — re-run the diff and try again.';
	}
}
```

- [ ] **Step 3: Run the drawer tests, then the full suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/SwapMetamodelDrawer.test.ts'` then `pixi run frontend-test`
Expected: all PASS

- [ ] **Step 4: Format, lint, commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npx prettier --write src/lib/components/SwapMetamodelDrawer.svelte src/lib/components/__tests__/SwapMetamodelDrawer.test.ts && npm run lint && npm run check'`

```bash
git add frontend/src/lib/components/SwapMetamodelDrawer.svelte frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts
git commit -m "feat(ui): swap drawer holds the mm lease and renders the structural diff"
```

---

### Task 8: Full gates

**Files:** none (verification only; fix-forward anything that fails).

- [ ] **Step 1: Full Python suite**

Run: `pixi run core-test`
Expected: everything passes (~1691+ pre-existing tests plus this plan's additions; the known ~0.8% flake is `tests/model/test_search_index.py::test_string_properties_indexed_non_strings_ignored` — rerun once if it alone fails).

- [ ] **Step 2: Full frontend suite**

Run: `pixi run frontend-test`
Expected: everything passes (1825+ pre-existing plus additions).

- [ ] **Step 3: All linters**

Run: `pixi run core-lint && pixi run backend-lint`
Run: `pixi run -e frontend bash -c 'cd frontend && npm run lint && npm run check'`
Expected: all clean.

- [ ] **Step 4: Commit any fixes**

Only if steps 1–3 required changes; conventional commits as above.

---

## Out of scope (do not build)

- Live metamodel editing (Phase 5) — this plan only keeps its seams clean.
- Rename detection in the differ; rebind revert (Phase 8); HistoryDrawer consumption of `GET /commits/{rev}/diff`; Redis-mirrored locks (Phase 7).
- No e2e tests (consistent with the rest of the program).
- No pushes to origin; merge handling (`--no-ff` into local `main`) happens after review, per house process — not part of this plan's tasks.
