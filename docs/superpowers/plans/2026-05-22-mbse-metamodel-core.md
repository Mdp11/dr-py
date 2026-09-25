# MBSE Metamodel Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reflective, data-driven core that loads a user-authored metamodel (YAML), lets code create/edit conforming models of generic objects, and validates them through a pluggable pipeline — designed so a future database and concurrent web app are extensions, not rewrites.

**Architecture:** Three layers — a fixed meta-metamodel (pydantic), a mutable metamodel (YAML loaded at runtime), and mutable models (generic `Element`/`Relationship` objects). All model changes flow through one mutation boundary on `Model`. Validation is a pipeline of independent validators. Persistence sits behind a `Repository` port (in-memory + file adapters now).

**Tech Stack:** Python 3.11+, pydantic v2, PyYAML, pytest.

---

## File Structure

```
src/data_rover/
  metamodel/
    __init__.py
    multiplicity.py     # Multiplicity value object + parsing
    schema.py           # pydantic meta-metamodel: PropertyDef, ElementType, RelationshipType, Metamodel (+ resolution methods)
    check.py            # static metamodel validation (references, cycles, datatypes)
    loader.py           # YAML -> Metamodel
  model/
    __init__.py
    ids.py              # IdGenerator port + Uuid7Generator + SequentialIdGenerator
    element.py          # Element dataclass
    relationship.py     # Relationship dataclass
    model.py            # Model: container + mutation boundary + queries
  validation/
    __init__.py
    issue.py            # Severity, Issue
    scope.py            # Scope (set of ids or ALL)
    pipeline.py         # Validator protocol + ValidationPipeline
    validators/
      __init__.py
      type_conformance.py
      multiplicity.py
      facets.py
      endpoint_typing.py
      containment.py
  repository/
    __init__.py
    repository.py       # Repository port + ConflictError
    in_memory.py        # InMemoryRepository
    file_store.py       # FileRepository (YAML/JSON)
tests/
  ... mirrors src ...
  test_integration.py
examples/
  example.metamodel.yaml
pyproject.toml
```

**Conventions used throughout (read before starting):**
- A **datatype** is either a primitive (`string`, `integer`, `float`, `boolean`, `date`) or the name of a declared enum.
- **Multiplicity notation** is a string used everywhere: `"1"` (exactly one), `"0..1"` (optional single), `"0..*"` (optional many), `"1..*"` (required, ≥1). `*` means unbounded.
- Mutation never validates *values* (a model may be temporarily invalid); validation is the pipeline's job. Mutation *does* raise on structural impossibilities (unknown type, unknown property name, missing element id).
- `type_name` on instances refers to a type defined in the metamodel.

---

## Task 1: Project scaffold

**Files:**
- Create: `pyproject.toml`
- Create: `src/data_rover/__init__.py`
- Create: `tests/__init__.py`
- Create: `tests/test_smoke.py`

- [ ] **Step 1: Write the failing test**

`tests/test_smoke.py`:
```python
import data_rover


def test_package_imports():
    assert hasattr(data_rover, "__version__")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_smoke.py -v`
Expected: FAIL (ModuleNotFoundError or missing `__version__`).

- [ ] **Step 3: Write minimal implementation**

`pyproject.toml`:
```toml
[project]
name = "data-rover"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["pydantic>=2.6", "pyyaml>=6.0"]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

`src/data_rover/__init__.py`:
```python
__version__ = "0.1.0"
```

`tests/__init__.py`: (empty file)

- [ ] **Step 4: Install and run**

Run: `pip install -e ".[dev]" && pytest tests/test_smoke.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml src/data_rover/__init__.py tests/__init__.py tests/test_smoke.py
git commit -m "chore: project scaffold with pytest"
```

---

## Task 2: Multiplicity value object

**Files:**
- Create: `src/data_rover/metamodel/__init__.py` (empty)
- Create: `src/data_rover/metamodel/multiplicity.py`
- Test: `tests/metamodel/test_multiplicity.py`

- [ ] **Step 1: Write the failing test**

`tests/metamodel/test_multiplicity.py` (also create empty `tests/metamodel/__init__.py`):
```python
import pytest

from data_rover.metamodel.multiplicity import Multiplicity


def test_parse_exact():
    m = Multiplicity.parse("1")
    assert (m.lower, m.upper) == (1, 1)
    assert m.required is True
    assert m.is_single is True


def test_parse_optional_single():
    m = Multiplicity.parse("0..1")
    assert (m.lower, m.upper) == (0, 1)
    assert m.required is False
    assert m.is_single is True


def test_parse_optional_many():
    m = Multiplicity.parse("0..*")
    assert (m.lower, m.upper) == (0, None)
    assert m.is_single is False


def test_parse_required_many():
    m = Multiplicity.parse("1..*")
    assert (m.lower, m.upper) == (1, None)
    assert m.required is True


def test_count_in_range():
    m = Multiplicity.parse("1..*")
    assert m.count_ok(0) is False
    assert m.count_ok(1) is True
    assert m.count_ok(5) is True


def test_invalid_raises():
    with pytest.raises(ValueError):
        Multiplicity.parse("abc")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/metamodel/test_multiplicity.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/metamodel/multiplicity.py`:
```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Multiplicity:
    lower: int
    upper: int | None  # None == unbounded ("*")

    @property
    def is_single(self) -> bool:
        return self.upper == 1

    @property
    def required(self) -> bool:
        return self.lower >= 1

    def count_ok(self, count: int) -> bool:
        if count < self.lower:
            return False
        if self.upper is not None and count > self.upper:
            return False
        return True

    @staticmethod
    def parse(spec: str) -> "Multiplicity":
        spec = spec.strip()
        try:
            if ".." in spec:
                lo, hi = spec.split("..", 1)
                lower = int(lo)
                upper = None if hi.strip() == "*" else int(hi)
            elif spec == "*":
                lower, upper = 0, None
            else:
                lower = upper = int(spec)
        except ValueError as exc:
            raise ValueError(f"Invalid multiplicity: {spec!r}") from exc
        return Multiplicity(lower, upper)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/metamodel/test_multiplicity.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/metamodel tests/metamodel
git commit -m "feat: Multiplicity value object with string parsing"
```

---

## Task 3: Meta-metamodel pydantic schema

**Files:**
- Create: `src/data_rover/metamodel/schema.py`
- Test: `tests/metamodel/test_schema.py`

- [ ] **Step 1: Write the failing test**

`tests/metamodel/test_schema.py`:
```python
from data_rover.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)


def test_property_defaults():
    p = PropertyDef(name="name", datatype="string")
    assert p.multiplicity == "0..1"
    assert p.min is None and p.max is None


def test_build_metamodel():
    mm = Metamodel(
        enums={"Status": ["Draft", "Approved"]},
        elements=[
            ElementType(name="NamedElement", abstract=True,
                        properties=[PropertyDef(name="name", datatype="string",
                                                multiplicity="1")]),
            ElementType(name="Block", extends="NamedElement"),
        ],
        relationships=[
            RelationshipType(name="HasPart", containment=True,
                             source="Block", target="Block"),
        ],
    )
    assert mm.element_type("Block").extends == "NamedElement"
    assert mm.element_type("Missing") is None
    assert mm.relationship_type("HasPart").containment is True


def test_relationship_defaults():
    r = RelationshipType(name="R", source="A", target="B")
    assert r.containment is False
    assert r.source_multiplicity == "0..*"
    assert r.target_multiplicity == "0..*"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/metamodel/test_schema.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/metamodel/schema.py`:
```python
from __future__ import annotations

from pydantic import BaseModel, Field

PRIMITIVES = frozenset({"string", "integer", "float", "boolean", "date"})


class PropertyDef(BaseModel):
    name: str
    datatype: str
    multiplicity: str = "0..1"
    # facets (all optional)
    min: float | None = None
    max: float | None = None
    pattern: str | None = None
    max_length: int | None = None


class ElementType(BaseModel):
    name: str
    abstract: bool = False
    extends: str | None = None
    properties: list[PropertyDef] = Field(default_factory=list)


class RelationshipType(BaseModel):
    name: str
    abstract: bool = False
    extends: str | None = None
    containment: bool = False
    source: str
    target: str
    source_multiplicity: str = "0..*"
    target_multiplicity: str = "0..*"
    properties: list[PropertyDef] = Field(default_factory=list)


class Metamodel(BaseModel):
    enums: dict[str, list[str]] = Field(default_factory=dict)
    elements: list[ElementType] = Field(default_factory=list)
    relationships: list[RelationshipType] = Field(default_factory=list)

    def element_type(self, name: str) -> ElementType | None:
        return next((e for e in self.elements if e.name == name), None)

    def relationship_type(self, name: str) -> RelationshipType | None:
        return next((r for r in self.relationships if r.name == name), None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/metamodel/test_schema.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/metamodel/schema.py tests/metamodel/test_schema.py
git commit -m "feat: meta-metamodel pydantic schema"
```

---

## Task 4: Metamodel resolution (inheritance, subtyping, effective properties)

**Files:**
- Modify: `src/data_rover/metamodel/schema.py` (add methods to `Metamodel`)
- Test: `tests/metamodel/test_resolution.py`

- [ ] **Step 1: Write the failing test**

`tests/metamodel/test_resolution.py`:
```python
from data_rover.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)


def _mm():
    return Metamodel(
        elements=[
            ElementType(name="NamedElement", abstract=True,
                        properties=[PropertyDef(name="name", datatype="string", multiplicity="1")]),
            ElementType(name="Block", extends="NamedElement",
                        properties=[PropertyDef(name="mass", datatype="float")]),
            ElementType(name="CpuBlock", extends="Block"),
        ],
        relationships=[
            RelationshipType(name="Link", source="NamedElement", target="NamedElement"),
            RelationshipType(name="HasPart", extends="Link", containment=True,
                             source="Block", target="Block"),
        ],
    )


def test_element_ancestors_self_and_chain():
    mm = _mm()
    assert mm.element_ancestors("CpuBlock") == ["CpuBlock", "Block", "NamedElement"]


def test_is_element_subtype():
    mm = _mm()
    assert mm.is_element_subtype("CpuBlock", "NamedElement") is True
    assert mm.is_element_subtype("Block", "Block") is True
    assert mm.is_element_subtype("NamedElement", "Block") is False


def test_effective_element_properties_merge_chain():
    mm = _mm()
    names = [p.name for p in mm.effective_element_properties("Block")]
    assert names == ["name", "mass"]


def test_effective_relationship_containment_inherited():
    mm = _mm()
    assert mm.is_containment("HasPart") is True
    assert mm.is_containment("Link") is False


def test_is_relationship_subtype():
    mm = _mm()
    assert mm.is_relationship_subtype("HasPart", "Link") is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/metamodel/test_resolution.py -v`
Expected: FAIL (no `element_ancestors`).

- [ ] **Step 3: Write minimal implementation**

Append these methods inside the `Metamodel` class in `src/data_rover/metamodel/schema.py`:
```python
    def element_ancestors(self, name: str) -> list[str]:
        chain: list[str] = []
        current: str | None = name
        seen: set[str] = set()
        while current and current not in seen:
            et = self.element_type(current)
            if et is None:
                break
            chain.append(current)
            seen.add(current)
            current = et.extends
        return chain

    def relationship_ancestors(self, name: str) -> list[str]:
        chain: list[str] = []
        current: str | None = name
        seen: set[str] = set()
        while current and current not in seen:
            rt = self.relationship_type(current)
            if rt is None:
                break
            chain.append(current)
            seen.add(current)
            current = rt.extends
        return chain

    def is_element_subtype(self, sub: str, sup: str) -> bool:
        return sup in self.element_ancestors(sub)

    def is_relationship_subtype(self, sub: str, sup: str) -> bool:
        return sup in self.relationship_ancestors(sub)

    def effective_element_properties(self, name: str) -> list[PropertyDef]:
        props: list[PropertyDef] = []
        seen: set[str] = set()
        # walk root -> leaf so overrides by closer types win; here child appends after parent
        for type_name in reversed(self.element_ancestors(name)):
            et = self.element_type(type_name)
            if et is None:
                continue
            for p in et.properties:
                if p.name not in seen:
                    props.append(p)
                    seen.add(p.name)
        return props

    def effective_relationship_properties(self, name: str) -> list[PropertyDef]:
        props: list[PropertyDef] = []
        seen: set[str] = set()
        for type_name in reversed(self.relationship_ancestors(name)):
            rt = self.relationship_type(type_name)
            if rt is None:
                continue
            for p in rt.properties:
                if p.name not in seen:
                    props.append(p)
                    seen.add(p.name)
        return props

    def is_containment(self, rel_type_name: str) -> bool:
        return any(
            self.relationship_type(t).containment
            for t in self.relationship_ancestors(rel_type_name)
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/metamodel/test_resolution.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/metamodel/schema.py tests/metamodel/test_resolution.py
git commit -m "feat: metamodel inheritance resolution and subtyping"
```

---

## Task 5: Static metamodel checks

**Files:**
- Create: `src/data_rover/metamodel/check.py`
- Test: `tests/metamodel/test_check.py`

- [ ] **Step 1: Write the failing test**

`tests/metamodel/test_check.py`:
```python
from data_rover.metamodel.check import check_metamodel
from data_rover.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)


def test_valid_metamodel_has_no_errors():
    mm = Metamodel(
        enums={"Status": ["Draft"]},
        elements=[ElementType(name="Block",
                              properties=[PropertyDef(name="s", datatype="Status")])],
        relationships=[RelationshipType(name="R", source="Block", target="Block")],
    )
    assert check_metamodel(mm) == []


def test_unknown_extends_reported():
    mm = Metamodel(elements=[ElementType(name="Block", extends="Ghost")])
    errors = check_metamodel(mm)
    assert any("Ghost" in e for e in errors)


def test_inheritance_cycle_reported():
    mm = Metamodel(elements=[
        ElementType(name="A", extends="B"),
        ElementType(name="B", extends="A"),
    ])
    errors = check_metamodel(mm)
    assert any("cycle" in e.lower() for e in errors)


def test_unknown_datatype_reported():
    mm = Metamodel(elements=[ElementType(name="A",
                  properties=[PropertyDef(name="p", datatype="Weird")])])
    errors = check_metamodel(mm)
    assert any("Weird" in e for e in errors)


def test_relationship_endpoint_must_be_element_type():
    mm = Metamodel(
        elements=[ElementType(name="A")],
        relationships=[RelationshipType(name="R", source="A", target="Nope")],
    )
    errors = check_metamodel(mm)
    assert any("Nope" in e for e in errors)


def test_bad_multiplicity_reported():
    mm = Metamodel(elements=[ElementType(name="A",
                  properties=[PropertyDef(name="p", datatype="string", multiplicity="xx")])])
    errors = check_metamodel(mm)
    assert any("multiplicity" in e.lower() for e in errors)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/metamodel/test_check.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/metamodel/check.py`:
```python
from __future__ import annotations

from .multiplicity import Multiplicity
from .schema import PRIMITIVES, Metamodel, PropertyDef


def _valid_datatype(mm: Metamodel, datatype: str) -> bool:
    return datatype in PRIMITIVES or datatype in mm.enums


def _check_properties(mm: Metamodel, owner: str, props: list[PropertyDef],
                      errors: list[str]) -> None:
    for p in props:
        if not _valid_datatype(mm, p.datatype):
            errors.append(f"{owner}.{p.name}: unknown datatype {p.datatype!r}")
        try:
            Multiplicity.parse(p.multiplicity)
        except ValueError:
            errors.append(
                f"{owner}.{p.name}: invalid multiplicity {p.multiplicity!r}")


def _has_cycle(get_extends, name: str) -> bool:
    seen: set[str] = set()
    current: str | None = name
    while current is not None:
        if current in seen:
            return True
        seen.add(current)
        current = get_extends(current)
    return False


def check_metamodel(mm: Metamodel) -> list[str]:
    """Return a list of human-readable error strings; empty means valid."""
    errors: list[str] = []
    element_names = {e.name for e in mm.elements}

    for et in mm.elements:
        if et.extends is not None and et.extends not in element_names:
            errors.append(f"Element {et.name!r} extends unknown type {et.extends!r}")
        _check_properties(mm, et.name, et.properties, errors)

    for et in mm.elements:
        if _has_cycle(lambda n: (mm.element_type(n).extends
                                 if mm.element_type(n) else None), et.name):
            errors.append(f"Inheritance cycle involving element {et.name!r}")
            break

    rel_names = {r.name for r in mm.relationships}
    for rt in mm.relationships:
        if rt.extends is not None and rt.extends not in rel_names:
            errors.append(
                f"Relationship {rt.name!r} extends unknown type {rt.extends!r}")
        if rt.source not in element_names:
            errors.append(f"Relationship {rt.name!r} source {rt.source!r} "
                          "is not an element type")
        if rt.target not in element_names:
            errors.append(f"Relationship {rt.name!r} target {rt.target!r} "
                          "is not an element type")
        for spec in (rt.source_multiplicity, rt.target_multiplicity):
            try:
                Multiplicity.parse(spec)
            except ValueError:
                errors.append(
                    f"Relationship {rt.name!r}: invalid multiplicity {spec!r}")
        _check_properties(mm, rt.name, rt.properties, errors)

    return errors
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/metamodel/test_check.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/metamodel/check.py tests/metamodel/test_check.py
git commit -m "feat: static metamodel validation (references, cycles, datatypes)"
```

---

## Task 6: Metamodel YAML loader

**Files:**
- Create: `src/data_rover/metamodel/loader.py`
- Test: `tests/metamodel/test_loader.py`

- [ ] **Step 1: Write the failing test**

`tests/metamodel/test_loader.py`:
```python
import pytest

from data_rover.metamodel.loader import MetamodelError, load_metamodel_str


VALID = """
enums:
  Status: [Draft, Approved]
elements:
  - name: NamedElement
    abstract: true
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
  - name: Block
    extends: NamedElement
relationships:
  - name: HasPart
    containment: true
    source: Block
    target: Block
"""


def test_load_valid_metamodel():
    mm = load_metamodel_str(VALID)
    assert mm.element_type("Block").extends == "NamedElement"
    assert mm.is_containment("HasPart") is True


def test_load_invalid_raises_with_errors():
    bad = "elements:\n  - name: Block\n    extends: Ghost\n"
    with pytest.raises(MetamodelError) as exc:
        load_metamodel_str(bad)
    assert "Ghost" in str(exc.value)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/metamodel/test_loader.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/metamodel/loader.py`:
```python
from __future__ import annotations

from pathlib import Path

import yaml

from .check import check_metamodel
from .schema import Metamodel


class MetamodelError(Exception):
    """Raised when a metamodel document is malformed or invalid."""


def load_metamodel_str(text: str) -> Metamodel:
    data = yaml.safe_load(text) or {}
    try:
        mm = Metamodel.model_validate(data)
    except Exception as exc:  # pydantic ValidationError
        raise MetamodelError(f"Malformed metamodel: {exc}") from exc
    errors = check_metamodel(mm)
    if errors:
        raise MetamodelError("Invalid metamodel:\n- " + "\n- ".join(errors))
    return mm


def load_metamodel_file(path: str | Path) -> Metamodel:
    return load_metamodel_str(Path(path).read_text(encoding="utf-8"))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/metamodel/test_loader.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/metamodel/loader.py tests/metamodel/test_loader.py
git commit -m "feat: YAML metamodel loader with validation"
```

---

## Task 7: Id generators

**Files:**
- Create: `src/data_rover/model/__init__.py` (empty)
- Create: `src/data_rover/model/ids.py`
- Test: `tests/model/test_ids.py` (also create empty `tests/model/__init__.py`)

- [ ] **Step 1: Write the failing test**

`tests/model/test_ids.py`:
```python
import uuid

from data_rover.model.ids import SequentialIdGenerator, Uuid7Generator


def test_uuid7_is_valid_uuid_version_7():
    gen = Uuid7Generator()
    value = gen.new_id()
    parsed = uuid.UUID(value)
    assert parsed.version == 7


def test_uuid7_ids_are_unique_and_time_ordered():
    gen = Uuid7Generator()
    ids = [gen.new_id() for _ in range(50)]
    assert len(set(ids)) == 50
    assert ids == sorted(ids)  # v7 sorts by creation time


def test_sequential_generator_is_deterministic():
    gen = SequentialIdGenerator(prefix="e")
    assert gen.new_id() == "e-1"
    assert gen.new_id() == "e-2"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/model/test_ids.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/model/ids.py`:
```python
from __future__ import annotations

import os
import time
import uuid
from typing import Protocol


class IdGenerator(Protocol):
    def new_id(self) -> str: ...


def _uuid7() -> uuid.UUID:
    # RFC 9562 UUIDv7: 48-bit ms timestamp + version/variant + random.
    unix_ms = int(time.time() * 1000)
    rand = os.urandom(10)
    raw = bytearray(unix_ms.to_bytes(6, "big") + rand)
    raw[6] = (raw[6] & 0x0F) | 0x70  # version 7
    raw[8] = (raw[8] & 0x3F) | 0x80  # RFC 4122 variant
    return uuid.UUID(bytes=bytes(raw))


class Uuid7Generator:
    """Default generator: time-ordered, coordination-free UUIDv7."""

    def new_id(self) -> str:
        return str(_uuid7())


class SequentialIdGenerator:
    """Deterministic generator for tests."""

    def __init__(self, prefix: str = "id") -> None:
        self._prefix = prefix
        self._n = 0

    def new_id(self) -> str:
        self._n += 1
        return f"{self._prefix}-{self._n}"
```

Note on time-ordering: if two ids are generated within the same millisecond the `sorted` assertion could theoretically tie; the random suffix keeps them unequal and the loop of 50 spans enough wall-clock that ordering holds. If this proves flaky on a very fast machine, add a monotonic counter — not needed for the first cut.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/model/test_ids.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/model/__init__.py src/data_rover/model/ids.py tests/model
git commit -m "feat: id generators (UUIDv7 default, sequential for tests)"
```

---

## Task 8: Element and Relationship dataclasses

**Files:**
- Create: `src/data_rover/model/element.py`
- Create: `src/data_rover/model/relationship.py`
- Test: `tests/model/test_entities.py`

- [ ] **Step 1: Write the failing test**

`tests/model/test_entities.py`:
```python
from data_rover.model.element import Element
from data_rover.model.relationship import Relationship


def test_element_identity_is_by_id_not_value():
    a = Element(id="1", type_name="Block", properties={"name": "x"})
    b = Element(id="2", type_name="Block", properties={"name": "x"})
    assert a != b
    assert a == Element(id="1", type_name="Block", properties={"name": "x"})


def test_element_defaults():
    a = Element(id="1", type_name="Block")
    assert a.properties == {}
    assert a.rev == 0


def test_relationship_holds_endpoints():
    r = Relationship(id="r1", type_name="HasPart", source_id="1", target_id="2")
    assert r.source_id == "1"
    assert r.target_id == "2"
    assert r.rev == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/model/test_entities.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/model/element.py`:
```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Element:
    id: str
    type_name: str
    properties: dict[str, Any] = field(default_factory=dict)
    rev: int = 0
```

`src/data_rover/model/relationship.py`:
```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Relationship:
    id: str
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any] = field(default_factory=dict)
    rev: int = 0
```

Note: dataclass `__eq__` compares all fields including `id`, so two elements with different ids are unequal even when their other fields match — this realises the spec's "identity by entity, not by value." Code that asks "same element?" should compare `a.id == b.id`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/model/test_entities.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/model/element.py src/data_rover/model/relationship.py tests/model/test_entities.py
git commit -m "feat: Element and Relationship dataclasses with id-based identity"
```

---

## Task 9: Model container — create_element and lookups

**Files:**
- Create: `src/data_rover/model/model.py`
- Test: `tests/model/test_model_create.py`

- [ ] **Step 1: Write the failing test**

`tests/model/test_model_create.py`:
```python
import pytest

from data_rover.metamodel.schema import ElementType, Metamodel
from data_rover.model.ids import SequentialIdGenerator
from data_rover.model.model import Model


def _mm():
    return Metamodel(elements=[
        ElementType(name="Abstract", abstract=True),
        ElementType(name="Block"),
    ])


def test_create_element_assigns_id_and_stores():
    model = Model(_mm(), id_generator=SequentialIdGenerator("e"))
    el = model.create_element("Block")
    assert el.id == "e-1"
    assert el.type_name == "Block"
    assert model.get_element("e-1") is el


def test_create_unknown_type_raises():
    model = Model(_mm())
    with pytest.raises(KeyError):
        model.create_element("Ghost")


def test_create_abstract_type_raises():
    model = Model(_mm())
    with pytest.raises(ValueError):
        model.create_element("Abstract")


def test_get_missing_element_raises():
    model = Model(_mm())
    with pytest.raises(KeyError):
        model.get_element("nope")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/model/test_model_create.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/model/model.py`:
```python
from __future__ import annotations

from ..metamodel.schema import Metamodel
from .element import Element
from .ids import IdGenerator, Uuid7Generator
from .relationship import Relationship


class Model:
    """A collection of elements and relationships conforming to one metamodel.

    All mutation flows through this object's methods (the mutation boundary).
    """

    def __init__(self, metamodel: Metamodel,
                 id_generator: IdGenerator | None = None) -> None:
        self.metamodel = metamodel
        self._ids: IdGenerator = id_generator or Uuid7Generator()
        self.elements: dict[str, Element] = {}
        self.relationships: dict[str, Relationship] = {}

    # --- mutation boundary: elements ---
    def create_element(self, type_name: str) -> Element:
        et = self.metamodel.element_type(type_name)
        if et is None:
            raise KeyError(f"Unknown element type {type_name!r}")
        if et.abstract:
            raise ValueError(f"Cannot instantiate abstract type {type_name!r}")
        element = Element(id=self._ids.new_id(), type_name=type_name)
        self.elements[element.id] = element
        return element

    # --- queries ---
    def get_element(self, element_id: str) -> Element:
        if element_id not in self.elements:
            raise KeyError(f"No element with id {element_id!r}")
        return self.elements[element_id]

    def get_relationship(self, rel_id: str) -> Relationship:
        if rel_id not in self.relationships:
            raise KeyError(f"No relationship with id {rel_id!r}")
        return self.relationships[rel_id]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/model/test_model_create.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/model/model.py tests/model/test_model_create.py
git commit -m "feat: Model container with create_element and lookups"
```

---

## Task 10: Model — set property

**Files:**
- Modify: `src/data_rover/model/model.py` (add `set`)
- Test: `tests/model/test_model_set.py`

- [ ] **Step 1: Write the failing test**

`tests/model/test_model_set.py`:

```python
import pytest

from data_rover.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.model.model import Model


def _mm():
    return Metamodel(elements=[
        ElementType(name="Block", properties=[
            PropertyDef(name="name", datatype="string"),
        ]),
    ])


def test_set_known_property_stores_and_bumps_rev():
    model = Model(_mm())
    el = model.create_element("Block")
    before = el.rev
    model.set_property(el, "name", "Engine")
    assert el.properties["name"] == "Engine"
    assert el.rev == before + 1


def test_set_unknown_property_raises():
    model = Model(_mm())
    el = model.create_element("Block")
    with pytest.raises(KeyError):
        model.set_property(el, "ghost", 1)


def test_set_does_not_validate_value_type():
    # mutation is permissive; the validation pipeline catches type errors later
    model = Model(_mm())
    el = model.create_element("Block")
    model.set_property(el, "name", 123)  # wrong type, but allowed
    assert el.properties["name"] == 123
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/model/test_model_set.py -v`
Expected: FAIL (no `set`).

- [ ] **Step 3: Write minimal implementation**

Add to `Model` in `src/data_rover/model/model.py` (and add the import at top):
```python
from .element import Element
from .relationship import Relationship
```
(the imports already exist; ensure both are present). Add method:
```python
    def set(self, target: Element | Relationship, prop: str, value) -> None:
        if isinstance(target, Element):
            defs = self.metamodel.effective_element_properties(target.type_name)
        else:
            defs = self.metamodel.effective_relationship_properties(target.type_name)
        if prop not in {p.name for p in defs}:
            raise KeyError(
                f"{target.type_name!r} has no property {prop!r}")
        target.properties[prop] = value
        target.rev += 1
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/model/test_model_set.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/model/model.py tests/model/test_model_set.py
git commit -m "feat: Model.set with property-name guard and rev bump"
```

---

## Task 11: Model — connect and disconnect

**Files:**
- Modify: `src/data_rover/model/model.py` (add `connect`, `disconnect`, relationship queries)
- Test: `tests/model/test_model_connect.py`

- [ ] **Step 1: Write the failing test**

`tests/model/test_model_connect.py`:
```python
import pytest

from data_rover.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.model.ids import SequentialIdGenerator
from data_rover.model.model import Model


def _model():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[RelationshipType(name="HasPart", containment=True,
                                        source="Block", target="Block")],
    )
    return Model(mm, id_generator=SequentialIdGenerator("x"))


def test_connect_creates_relationship():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("HasPart", a.id, b.id)
    assert rel.source_id == a.id and rel.target_id == b.id
    assert model.get_relationship(rel.id) is rel


def test_connect_unknown_type_raises():
    model = _model()
    a = model.create_element("Block")
    with pytest.raises(KeyError):
        model.connect("Ghost", a.id, a.id)


def test_connect_missing_endpoint_raises():
    model = _model()
    a = model.create_element("Block")
    with pytest.raises(KeyError):
        model.connect("HasPart", a.id, "missing")


def test_disconnect_removes_relationship():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("HasPart", a.id, b.id)
    model.disconnect(rel.id)
    assert rel.id not in model.relationships


def test_relationships_from_filters_by_source():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("HasPart", a.id, b.id)
    assert model.relationships_from(a.id) == [rel]
    assert model.relationships_from(b.id) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/model/test_model_connect.py -v`
Expected: FAIL (no `connect`).

- [ ] **Step 3: Write minimal implementation**

Add methods to `Model`:
```python
    def connect(self, rel_type: str, source_id: str, target_id: str) -> Relationship:
        if self.metamodel.relationship_type(rel_type) is None:
            raise KeyError(f"Unknown relationship type {rel_type!r}")
        if source_id not in self.elements:
            raise KeyError(f"No source element {source_id!r}")
        if target_id not in self.elements:
            raise KeyError(f"No target element {target_id!r}")
        rel = Relationship(id=self._ids.new_id(), type_name=rel_type,
                           source_id=source_id, target_id=target_id)
        self.relationships[rel.id] = rel
        return rel

    def disconnect(self, rel_id: str) -> None:
        if rel_id not in self.relationships:
            raise KeyError(f"No relationship with id {rel_id!r}")
        del self.relationships[rel_id]

    def relationships_from(self, element_id: str) -> list[Relationship]:
        return [r for r in self.relationships.values()
                if r.source_id == element_id]

    def relationships_to(self, element_id: str) -> list[Relationship]:
        return [r for r in self.relationships.values()
                if r.target_id == element_id]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/model/test_model_connect.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/model/model.py tests/model/test_model_connect.py
git commit -m "feat: Model.connect/disconnect and relationship queries"
```

---

## Task 12: Model — delete_element with containment cascade

**Files:**
- Modify: `src/data_rover/model/model.py` (add `delete_element`, `container_of`)
- Test: `tests/model/test_model_delete.py`

- [ ] **Step 1: Write the failing test**

`tests/model/test_model_delete.py`:
```python
from data_rover.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.model.model import Model


def _model():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[
            RelationshipType(name="HasPart", containment=True,
                             source="Block", target="Block"),
            RelationshipType(name="Refers", containment=False,
                             source="Block", target="Block"),
        ],
    )
    return Model(mm)


def test_delete_cascades_contained_children():
    model = _model()
    parent = model.create_element("Block")
    child = model.create_element("Block")
    grandchild = model.create_element("Block")
    model.connect("HasPart", parent.id, child.id)
    model.connect("HasPart", child.id, grandchild.id)
    model.delete_element(parent.id)
    assert model.elements == {}
    assert model.relationships == {}


def test_delete_removes_incident_reference_relationships_only():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    model.connect("Refers", a.id, b.id)  # non-containment
    model.delete_element(a.id)
    assert a.id not in model.elements
    assert b.id in model.elements  # referenced element survives
    assert model.relationships == {}  # the dangling reference is removed


def test_container_of_returns_containing_element():
    model = _model()
    parent = model.create_element("Block")
    child = model.create_element("Block")
    model.connect("HasPart", parent.id, child.id)
    assert model.container_of(child.id) == parent.id
    assert model.container_of(parent.id) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/model/test_model_delete.py -v`
Expected: FAIL (no `delete_element`).

- [ ] **Step 3: Write minimal implementation**

Add methods to `Model`:
```python
    def _containment_children(self, element_id: str) -> list[Relationship]:
        return [r for r in self.relationships.values()
                if r.source_id == element_id
                and self.metamodel.is_containment(r.type_name)]

    def container_of(self, element_id: str) -> str | None:
        for r in self.relationships.values():
            if (r.target_id == element_id
                    and self.metamodel.is_containment(r.type_name)):
                return r.source_id
        return None

    def delete_element(self, element_id: str) -> None:
        if element_id not in self.elements:
            raise KeyError(f"No element with id {element_id!r}")
        # cascade: delete contained children first (recursively)
        for rel in self._containment_children(element_id):
            child_id = rel.target_id
            if rel.id in self.relationships:
                self.disconnect(rel.id)
            if child_id in self.elements:
                self.delete_element(child_id)
        # remove any remaining relationships touching this element
        incident = [r.id for r in self.relationships.values()
                    if r.source_id == element_id or r.target_id == element_id]
        for rel_id in incident:
            self.disconnect(rel_id)
        del self.elements[element_id]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/model/test_model_delete.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/model/model.py tests/model/test_model_delete.py
git commit -m "feat: delete_element with containment cascade and container_of"
```

---

## Task 13: Validation primitives — Issue, Severity, Scope

**Files:**
- Create: `src/data_rover/validation/__init__.py` (empty)
- Create: `src/data_rover/validation/issue.py`
- Create: `src/data_rover/validation/scope.py`
- Test: `tests/validation/test_primitives.py` (also create empty `tests/validation/__init__.py`)

- [ ] **Step 1: Write the failing test**

`tests/validation/test_primitives.py`:
```python
from data_rover.validation.issue import Issue, Severity
from data_rover.validation.scope import Scope


def test_issue_holds_fields():
    issue = Issue(severity=Severity.ERROR, message="bad", target_ids=["e1"])
    assert issue.severity is Severity.ERROR
    assert issue.target_ids == ["e1"]


def test_scope_all_includes_everything():
    s = Scope.all()
    assert s.is_all is True
    assert s.includes("anything") is True


def test_scope_subset_includes_only_listed():
    s = Scope({"a", "b"})
    assert s.includes("a") is True
    assert s.includes("z") is False
    assert s.is_all is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/validation/test_primitives.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/validation/issue.py`:
```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Severity(Enum):
    ERROR = "error"
    WARNING = "warning"


@dataclass
class Issue:
    severity: Severity
    message: str
    target_ids: list[str] = field(default_factory=list)
```

`src/data_rover/validation/scope.py`:
```python
from __future__ import annotations

from typing import Iterable


class Scope:
    """The set of entity ids a validation run should consider.

    `Scope.all()` means "the whole model" (first-cut default). A bounded scope
    enables incremental validation later without changing validator code.
    """

    def __init__(self, ids: Iterable[str] | None = None) -> None:
        self._ids: set[str] | None = None if ids is None else set(ids)

    @classmethod
    def all(cls) -> "Scope":
        return cls(None)

    @property
    def is_all(self) -> bool:
        return self._ids is None

    def includes(self, entity_id: str) -> bool:
        return self._ids is None or entity_id in self._ids
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/validation/test_primitives.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/validation/__init__.py src/data_rover/validation/issue.py src/data_rover/validation/scope.py tests/validation
git commit -m "feat: validation primitives (Issue, Severity, Scope)"
```

---

## Task 14: Validation pipeline

**Files:**
- Create: `src/data_rover/validation/pipeline.py`
- Test: `tests/validation/test_pipeline.py`

- [ ] **Step 1: Write the failing test**

`tests/validation/test_pipeline.py`:
```python
from data_rover.validation.issue import Issue, Severity
from data_rover.validation.pipeline import ValidationPipeline
from data_rover.validation.scope import Scope


class _StubValidator:
    def __init__(self, issues):
        self._issues = issues
        self.last_scope = None

    def validate(self, model, scope):
        self.last_scope = scope
        return self._issues


def test_pipeline_aggregates_issues_from_all_validators():
    v1 = _StubValidator([Issue(Severity.ERROR, "a")])
    v2 = _StubValidator([Issue(Severity.WARNING, "b")])
    pipeline = ValidationPipeline([v1, v2])
    issues = pipeline.validate(model=None)
    assert [i.message for i in issues] == ["a", "b"]


def test_pipeline_defaults_to_scope_all():
    v = _StubValidator([])
    ValidationPipeline([v]).validate(model=None)
    assert v.last_scope.is_all is True


def test_pipeline_passes_through_explicit_scope():
    v = _StubValidator([])
    scope = Scope({"e1"})
    ValidationPipeline([v]).validate(model=None, scope=scope)
    assert v.last_scope is scope
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/validation/test_pipeline.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/validation/pipeline.py`:
```python
from __future__ import annotations

from typing import Protocol

from .issue import Issue
from .scope import Scope


class Validator(Protocol):
    def validate(self, model, scope: Scope) -> list[Issue]: ...


class ValidationPipeline:
    def __init__(self, validators: list[Validator]) -> None:
        self._validators = list(validators)

    def validate(self, model, scope: Scope | None = None) -> list[Issue]:
        scope = scope or Scope.all()
        issues: list[Issue] = []
        for validator in self._validators:
            issues.extend(validator.validate(model, scope))
        return issues
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/validation/test_pipeline.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/validation/pipeline.py tests/validation/test_pipeline.py
git commit -m "feat: ValidationPipeline with scope-aware Validator protocol"
```

---

## Task 15: Type-conformance validator

**Files:**
- Create: `src/data_rover/validation/validators/__init__.py` (empty)
- Create: `src/data_rover/validation/validators/type_conformance.py`
- Test: `tests/validation/test_type_conformance.py`

- [ ] **Step 1: Write the failing test**

`tests/validation/test_type_conformance.py`:

```python
from data_rover.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.type_conformance import (
    TypeConformanceValidator,
)


def _model():
    mm = Metamodel(
        enums={"Status": ["Draft", "Approved"]},
        elements=[ElementType(name="Block", properties=[
            PropertyDef(name="name", datatype="string"),
            PropertyDef(name="mass", datatype="float"),
            PropertyDef(name="status", datatype="Status"),
        ])],
    )
    return Model(mm)


def test_conforming_values_produce_no_issues():
    model = _model()
    el = model.create_element("Block")
    model.set_property(el, "name", "Engine")
    model.set_property(el, "mass", 3.5)
    model.set_property(el, "status", "Draft")
    assert TypeConformanceValidator().validate(model, Scope.all()) == []


def test_wrong_primitive_type_is_error():
    model = _model()
    el = model.create_element("Block")
    model.set_property(el, "name", 123)
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert len(issues) == 1
    assert el.id in issues[0].target_ids


def test_value_outside_enum_is_error():
    model = _model()
    el = model.create_element("Block")
    model.set_property(el, "status", "Rejected")
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert any("Status" in i.message for i in issues)


def test_bool_is_not_accepted_as_integer_or_float():
    mm = Metamodel(elements=[ElementType(name="B", properties=[
        PropertyDef(name="n", datatype="integer")])])
    model = Model(mm)
    el = model.create_element("B")
    model.set_property(el, "n", True)
    assert len(TypeConformanceValidator().validate(model, Scope.all())) == 1


def test_out_of_scope_elements_skipped():
    model = _model()
    el = model.create_element("Block")
    model.set_property(el, "name", 123)  # invalid
    assert TypeConformanceValidator().validate(model, Scope(set())) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/validation/test_type_conformance.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/validation/validators/type_conformance.py`:
```python
from __future__ import annotations

import datetime

from ...metamodel.schema import Metamodel
from ..issue import Issue, Severity
from ..scope import Scope


def value_conforms(value, datatype: str, metamodel: Metamodel) -> bool:
    if datatype in metamodel.enums:
        return value in metamodel.enums[datatype]
    if datatype == "string":
        return isinstance(value, str)
    if datatype == "boolean":
        return isinstance(value, bool)
    if datatype == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if datatype == "float":
        return (isinstance(value, (int, float)) and not isinstance(value, bool))
    if datatype == "date":
        return isinstance(value, datetime.date)
    return False


class TypeConformanceValidator:
    def validate(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        for el in model.elements.values():
            if not scope.includes(el.id):
                continue
            defs = {p.name: p for p in mm.effective_element_properties(el.type_name)}
            for name, value in el.properties.items():
                pdef = defs.get(name)
                if pdef is None or value is None:
                    continue
                values = value if isinstance(value, list) else [value]
                for item in values:
                    if not value_conforms(item, pdef.datatype, mm):
                        issues.append(Issue(
                            Severity.ERROR,
                            f"{el.type_name}.{name}: value {item!r} is not a "
                            f"valid {pdef.datatype}",
                            [el.id],
                        ))
        return issues
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/validation/test_type_conformance.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/validation/validators tests/validation/test_type_conformance.py
git commit -m "feat: type-conformance validator (primitives + enums)"
```

---

## Task 16: Property-facets validator

**Files:**
- Create: `src/data_rover/validation/validators/facets.py`
- Test: `tests/validation/test_facets.py`

- [ ] **Step 1: Write the failing test**

`tests/validation/test_facets.py`:

```python
from data_rover.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.facets import FacetsValidator


def _model():
    mm = Metamodel(elements=[ElementType(name="Req", properties=[
        PropertyDef(name="priority", datatype="integer", min=1, max=5),
        PropertyDef(name="code", datatype="string", pattern="^R[0-9]+$",
                    max_length=4),
    ])])
    return Model(mm)


def test_in_range_and_matching_ok():
    model = _model()
    el = model.create_element("Req")
    model.set_property(el, "priority", 3)
    model.set_property(el, "code", "R12")
    assert FacetsValidator().validate(model, Scope.all()) == []


def test_numeric_out_of_range_is_error():
    model = _model()
    el = model.create_element("Req")
    model.set_property(el, "priority", 9)
    issues = FacetsValidator().validate(model, Scope.all())
    assert any("priority" in i.message for i in issues)


def test_pattern_mismatch_is_error():
    model = _model()
    el = model.create_element("Req")
    model.set_property(el, "code", "X99")
    issues = FacetsValidator().validate(model, Scope.all())
    assert any("pattern" in i.message.lower() for i in issues)


def test_max_length_exceeded_is_error():
    model = _model()
    el = model.create_element("Req")
    model.set_property(el, "code", "R12345")
    issues = FacetsValidator().validate(model, Scope.all())
    assert any("length" in i.message.lower() for i in issues)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/validation/test_facets.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/validation/validators/facets.py`:
```python
from __future__ import annotations

import re

from ..issue import Issue, Severity
from ..scope import Scope


class FacetsValidator:
    def validate(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        for el in model.elements.values():
            if not scope.includes(el.id):
                continue
            defs = {p.name: p for p in mm.effective_element_properties(el.type_name)}
            for name, value in el.properties.items():
                pdef = defs.get(name)
                if pdef is None or value is None:
                    continue
                values = value if isinstance(value, list) else [value]
                for item in values:
                    issues.extend(self._check(el.id, name, pdef, item))
        return issues

    def _check(self, eid, name, pdef, item) -> list[Issue]:
        out: list[Issue] = []
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            if pdef.min is not None and item < pdef.min:
                out.append(Issue(Severity.ERROR,
                                 f"{name}: {item} below min {pdef.min}", [eid]))
            if pdef.max is not None and item > pdef.max:
                out.append(Issue(Severity.ERROR,
                                 f"{name}: {item} above max {pdef.max}", [eid]))
        if isinstance(item, str):
            if pdef.pattern is not None and not re.fullmatch(pdef.pattern, item):
                out.append(Issue(Severity.ERROR,
                                 f"{name}: {item!r} does not match pattern "
                                 f"{pdef.pattern!r}", [eid]))
            if pdef.max_length is not None and len(item) > pdef.max_length:
                out.append(Issue(Severity.ERROR,
                                 f"{name}: length {len(item)} exceeds "
                                 f"max_length {pdef.max_length}", [eid]))
        return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/validation/test_facets.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/validation/validators/facets.py tests/validation/test_facets.py
git commit -m "feat: property-facets validator (numeric range, pattern, length)"
```

---

## Task 17: Multiplicity validator

**Files:**
- Create: `src/data_rover/validation/validators/multiplicity.py`
- Test: `tests/validation/test_multiplicity_validator.py`

- [ ] **Step 1: Write the failing test**

`tests/validation/test_multiplicity_validator.py`:

```python
from data_rover.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.multiplicity import MultiplicityValidator


def test_required_property_missing_is_error():
    mm = Metamodel(elements=[ElementType(name="Block", properties=[
        PropertyDef(name="name", datatype="string", multiplicity="1")])])
    model = Model(mm)
    model.create_element("Block")  # no name set
    issues = MultiplicityValidator().validate(model, Scope.all())
    assert any("name" in i.message for i in issues)


def test_required_property_present_ok():
    mm = Metamodel(elements=[ElementType(name="Block", properties=[
        PropertyDef(name="name", datatype="string", multiplicity="1")])])
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "name", "x")
    assert MultiplicityValidator().validate(model, Scope.all()) == []


def test_many_property_count_bounds():
    mm = Metamodel(elements=[ElementType(name="Block", properties=[
        PropertyDef(name="tags", datatype="string", multiplicity="1..*")])])
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "tags", [])  # below lower bound of 1
    issues = MultiplicityValidator().validate(model, Scope.all())
    assert any("tags" in i.message for i in issues)


def test_relationship_target_multiplicity_lower_bound():
    # every Block must have >=1 outgoing Owns (target_multiplicity 1..*)
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[RelationshipType(name="Owns", source="Block",
                                        target="Block", target_multiplicity="1..*")],
    )
    model = Model(mm)
    model.create_element("Block")  # no outgoing Owns
    issues = MultiplicityValidator().validate(model, Scope.all())
    assert any("Owns" in i.message for i in issues)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/validation/test_multiplicity_validator.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/validation/validators/multiplicity.py`:
```python
from __future__ import annotations

from ...metamodel.multiplicity import Multiplicity
from ..issue import Issue, Severity
from ..scope import Scope


def _count(value) -> int:
    if value is None:
        return 0
    if isinstance(value, list):
        return len(value)
    return 1


class MultiplicityValidator:
    def validate(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        # property multiplicity
        for el in model.elements.values():
            if not scope.includes(el.id):
                continue
            for pdef in mm.effective_element_properties(el.type_name):
                mult = Multiplicity.parse(pdef.multiplicity)
                count = _count(el.properties.get(pdef.name))
                if not mult.count_ok(count):
                    issues.append(Issue(
                        Severity.ERROR,
                        f"{el.type_name}.{pdef.name}: {count} value(s) violates "
                        f"multiplicity {pdef.multiplicity!r}", [el.id]))
        # relationship-end multiplicity (target end: targets per source)
        for rt in mm.relationships:
            if rt.abstract:
                continue
            target_mult = Multiplicity.parse(rt.target_multiplicity)
            source_mult = Multiplicity.parse(rt.source_multiplicity)
            for el in model.elements.values():
                if not scope.includes(el.id):
                    continue
                if mm.is_element_subtype(el.type_name, rt.source):
                    out = len([r for r in model.relationships.values()
                               if r.type_name == rt.name and r.source_id == el.id])
                    if not target_mult.count_ok(out):
                        issues.append(Issue(
                            Severity.ERROR,
                            f"{rt.name}: element {el.id} has {out} target(s), "
                            f"violates target multiplicity "
                            f"{rt.target_multiplicity!r}", [el.id]))
                if mm.is_element_subtype(el.type_name, rt.target):
                    inc = len([r for r in model.relationships.values()
                               if r.type_name == rt.name and r.target_id == el.id])
                    if not source_mult.count_ok(inc):
                        issues.append(Issue(
                            Severity.ERROR,
                            f"{rt.name}: element {el.id} has {inc} source(s), "
                            f"violates source multiplicity "
                            f"{rt.source_multiplicity!r}", [el.id]))
        return issues
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/validation/test_multiplicity_validator.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/validation/validators/multiplicity.py tests/validation/test_multiplicity_validator.py
git commit -m "feat: multiplicity validator (property counts + relationship ends)"
```

---

## Task 18: Endpoint-typing validator

**Files:**
- Create: `src/data_rover/validation/validators/endpoint_typing.py`
- Test: `tests/validation/test_endpoint_typing.py`

- [ ] **Step 1: Write the failing test**

`tests/validation/test_endpoint_typing.py`:
```python
from data_rover.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.endpoint_typing import (
    EndpointTypingValidator,
)


def _model():
    mm = Metamodel(
        elements=[
            ElementType(name="Component"),
            ElementType(name="Requirement"),
            ElementType(name="SubComponent", extends="Component"),
        ],
        relationships=[RelationshipType(name="Satisfies", source="Component",
                                        target="Requirement")],
    )
    return Model(mm)


def test_correct_endpoints_ok():
    model = _model()
    c = model.create_element("Component")
    r = model.create_element("Requirement")
    model.connect("Satisfies", c.id, r.id)
    assert EndpointTypingValidator().validate(model, Scope.all()) == []


def test_subtype_source_accepted():
    model = _model()
    sub = model.create_element("SubComponent")
    r = model.create_element("Requirement")
    model.connect("Satisfies", sub.id, r.id)
    assert EndpointTypingValidator().validate(model, Scope.all()) == []


def test_wrong_target_type_is_error():
    model = _model()
    c = model.create_element("Component")
    bad = model.create_element("Component")  # should be Requirement
    rel = model.connect("Satisfies", c.id, bad.id)
    issues = EndpointTypingValidator().validate(model, Scope.all())
    assert len(issues) == 1
    assert rel.id in issues[0].target_ids
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/validation/test_endpoint_typing.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/validation/validators/endpoint_typing.py`:
```python
from __future__ import annotations

from ..issue import Issue, Severity
from ..scope import Scope


class EndpointTypingValidator:
    def validate(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        for rel in model.relationships.values():
            if not scope.includes(rel.id):
                continue
            rt = mm.relationship_type(rel.type_name)
            if rt is None:
                continue
            src = model.elements.get(rel.source_id)
            tgt = model.elements.get(rel.target_id)
            if src is not None and not mm.is_element_subtype(src.type_name, rt.source):
                issues.append(Issue(
                    Severity.ERROR,
                    f"{rt.name}: source {src.type_name} is not a {rt.source}",
                    [rel.id]))
            if tgt is not None and not mm.is_element_subtype(tgt.type_name, rt.target):
                issues.append(Issue(
                    Severity.ERROR,
                    f"{rt.name}: target {tgt.type_name} is not a {rt.target}",
                    [rel.id]))
        return issues
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/validation/test_endpoint_typing.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/validation/validators/endpoint_typing.py tests/validation/test_endpoint_typing.py
git commit -m "feat: endpoint-typing validator (respects inheritance)"
```

---

## Task 19: Containment validator

**Files:**
- Create: `src/data_rover/validation/validators/containment.py`
- Test: `tests/validation/test_containment.py`

- [ ] **Step 1: Write the failing test**

`tests/validation/test_containment.py`:
```python
from data_rover.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.containment import ContainmentValidator


def _model():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[RelationshipType(name="HasPart", containment=True,
                                        source="Block", target="Block")],
    )
    return Model(mm)


def test_tree_is_valid():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    model.connect("HasPart", a.id, b.id)
    assert ContainmentValidator().validate(model, Scope.all()) == []


def test_two_parents_is_error():
    model = _model()
    p1 = model.create_element("Block")
    p2 = model.create_element("Block")
    child = model.create_element("Block")
    model.connect("HasPart", p1.id, child.id)
    model.connect("HasPart", p2.id, child.id)
    issues = ContainmentValidator().validate(model, Scope.all())
    assert any("parent" in i.message.lower() for i in issues)


def test_cycle_is_error():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    model.connect("HasPart", a.id, b.id)
    model.connect("HasPart", b.id, a.id)
    issues = ContainmentValidator().validate(model, Scope.all())
    assert any("cycle" in i.message.lower() for i in issues)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/validation/test_containment.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/validation/validators/containment.py`:
```python
from __future__ import annotations

from ..issue import Issue, Severity
from ..scope import Scope


class ContainmentValidator:
    def validate(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        containment_rels = [r for r in model.relationships.values()
                            if mm.is_containment(r.type_name)]

        # single-parent: each target contained at most once
        parents: dict[str, list[str]] = {}
        for r in containment_rels:
            parents.setdefault(r.target_id, []).append(r.source_id)
        for target_id, srcs in parents.items():
            if len(srcs) > 1:
                issues.append(Issue(
                    Severity.ERROR,
                    f"Element {target_id} has {len(srcs)} containment parents "
                    "(must have at most one)", [target_id]))

        # acyclic: detect a cycle in child -> parent edges
        parent_of = {t: s[0] for t, s in parents.items()}
        for start in parent_of:
            seen: set[str] = set()
            node: str | None = start
            while node is not None and node not in seen:
                seen.add(node)
                node = parent_of.get(node)
            if node is not None:  # revisited a node => cycle
                issues.append(Issue(
                    Severity.ERROR,
                    f"Containment cycle detected involving element {start}",
                    [start]))
                break

        return issues
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/validation/test_containment.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/validation/validators/containment.py tests/validation/test_containment.py
git commit -m "feat: containment validator (single-parent, acyclic)"
```

---

## Task 20: Default pipeline factory

**Files:**
- Modify: `src/data_rover/validation/pipeline.py` (add `default_pipeline`)
- Test: `tests/validation/test_default_pipeline.py`

- [ ] **Step 1: Write the failing test**

`tests/validation/test_default_pipeline.py`:
```python
from data_rover.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.model.model import Model
from data_rover.validation.pipeline import default_pipeline


def test_default_pipeline_runs_all_first_cut_validators():
    mm = Metamodel(elements=[ElementType(name="Block", properties=[
        PropertyDef(name="name", datatype="string", multiplicity="1")])])
    model = Model(mm)
    model.create_element("Block")  # missing required name -> multiplicity error
    issues = default_pipeline().validate(model)
    assert any("name" in i.message for i in issues)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/validation/test_default_pipeline.py -v`
Expected: FAIL (no `default_pipeline`).

- [ ] **Step 3: Write minimal implementation**

Append to `src/data_rover/validation/pipeline.py`:
```python
def default_pipeline() -> "ValidationPipeline":
    # imported here to avoid a circular import at module load time
    from .validators.containment import ContainmentValidator
    from .validators.endpoint_typing import EndpointTypingValidator
    from .validators.facets import FacetsValidator
    from .validators.multiplicity import MultiplicityValidator
    from .validators.type_conformance import TypeConformanceValidator

    return ValidationPipeline([
        TypeConformanceValidator(),
        FacetsValidator(),
        MultiplicityValidator(),
        EndpointTypingValidator(),
        ContainmentValidator(),
    ])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/validation/test_default_pipeline.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/validation/pipeline.py tests/validation/test_default_pipeline.py
git commit -m "feat: default_pipeline factory wiring the first-cut validators"
```

---

## Task 21: Repository port + in-memory adapter

**Files:**
- Create: `src/data_rover/repository/__init__.py` (empty)
- Create: `src/data_rover/repository/repository.py`
- Create: `src/data_rover/repository/in_memory.py`
- Test: `tests/repository/test_in_memory.py` (also create empty `tests/repository/__init__.py`)

- [ ] **Step 1: Write the failing test**

`tests/repository/test_in_memory.py`:
```python
import pytest

from data_rover.metamodel.schema import ElementType, Metamodel
from data_rover.model.model import Model
from data_rover.repository.in_memory import InMemoryRepository
from data_rover.repository.repository import ConflictError


def _mm():
    return Metamodel(elements=[ElementType(name="Block")])


def test_save_and_load_metamodel_roundtrip():
    repo = InMemoryRepository()
    repo.save_metamodel("mm1", _mm())
    loaded = repo.load_metamodel("mm1")
    assert loaded.element_type("Block") is not None


def test_save_and_load_model_roundtrip():
    repo = InMemoryRepository()
    mm = _mm()
    model = Model(mm)
    el = model.create_element("Block")
    repo.save_model("m1", model)
    reloaded = repo.load_model("m1", mm)
    assert el.id in reloaded.elements


def test_optimistic_conflict_on_stale_expected_rev():
    repo = InMemoryRepository()
    mm = _mm()
    model = Model(mm)
    rev = repo.save_model("m1", model)          # rev 1
    repo.save_model("m1", model, expected_rev=rev)  # ok -> rev 2
    with pytest.raises(ConflictError):
        repo.save_model("m1", model, expected_rev=rev)  # stale
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/repository/test_in_memory.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/repository/repository.py`:
```python
from __future__ import annotations

from typing import Protocol

from ..metamodel.schema import Metamodel
from ..model.model import Model


class ConflictError(Exception):
    """Raised when an optimistic-concurrency expected revision does not match."""


class Repository(Protocol):
    def save_metamodel(self, name: str, metamodel: Metamodel) -> None: ...
    def load_metamodel(self, name: str) -> Metamodel: ...
    def save_model(self, name: str, model: Model,
                   expected_rev: int | None = None) -> int: ...
    def load_model(self, name: str, metamodel: Metamodel) -> Model: ...
```

`src/data_rover/repository/in_memory.py`:
```python
from __future__ import annotations

import copy

from ..metamodel.schema import Metamodel
from ..model.element import Element
from ..model.model import Model
from ..model.relationship import Relationship
from .repository import ConflictError


class InMemoryRepository:
    def __init__(self) -> None:
        self._metamodels: dict[str, Metamodel] = {}
        self._models: dict[str, tuple[int, list[Element], list[Relationship]]] = {}

    def save_metamodel(self, name: str, metamodel: Metamodel) -> None:
        self._metamodels[name] = metamodel.model_copy(deep=True)

    def load_metamodel(self, name: str) -> Metamodel:
        if name not in self._metamodels:
            raise KeyError(f"No metamodel named {name!r}")
        return self._metamodels[name].model_copy(deep=True)

    def save_model(self, name: str, model: Model,
                   expected_rev: int | None = None) -> int:
        current_rev = self._models[name][0] if name in self._models else 0
        if expected_rev is not None and expected_rev != current_rev:
            raise ConflictError(
                f"Stale write to {name!r}: expected rev {expected_rev}, "
                f"current {current_rev}")
        new_rev = current_rev + 1
        self._models[name] = (
            new_rev,
            copy.deepcopy(list(model.elements.values())),
            copy.deepcopy(list(model.relationships.values())),
        )
        return new_rev

    def load_model(self, name: str, metamodel: Metamodel) -> Model:
        if name not in self._models:
            raise KeyError(f"No model named {name!r}")
        _, elements, relationships = self._models[name]
        model = Model(metamodel)
        for el in copy.deepcopy(elements):
            model.elements[el.id] = el
        for rel in copy.deepcopy(relationships):
            model.relationships[rel.id] = rel
        return model
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/repository/test_in_memory.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/repository/__init__.py src/data_rover/repository/repository.py src/data_rover/repository/in_memory.py tests/repository
git commit -m "feat: Repository port + in-memory adapter with optimistic-rev guard"
```

---

## Task 22: File repository (YAML/JSON)

**Files:**
- Create: `src/data_rover/repository/file_store.py`
- Test: `tests/repository/test_file_store.py`

- [ ] **Step 1: Write the failing test**

`tests/repository/test_file_store.py`:
```python
from data_rover.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.model.model import Model
from data_rover.repository.file_store import FileRepository


def _mm():
    return Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[RelationshipType(name="HasPart", containment=True,
                                        source="Block", target="Block")],
    )


def test_metamodel_roundtrip_through_disk(tmp_path):
    repo = FileRepository(tmp_path)
    repo.save_metamodel("mm", _mm())
    loaded = repo.load_metamodel("mm")
    assert loaded.is_containment("HasPart") is True


def test_model_roundtrip_through_disk(tmp_path):
    repo = FileRepository(tmp_path)
    mm = _mm()
    model = Model(mm)
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("HasPart", a.id, b.id)
    repo.save_model("m", model)
    reloaded = repo.load_model("m", mm)
    assert set(reloaded.elements) == {a.id, b.id}
    assert rel.id in reloaded.relationships
    assert reloaded.relationships[rel.id].source_id == a.id
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/repository/test_file_store.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/data_rover/repository/file_store.py`:
```python
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

import yaml

from ..metamodel.schema import Metamodel
from ..model.element import Element
from ..model.model import Model
from ..model.relationship import Relationship


class FileRepository:
    """Persists metamodels and models as YAML files in a directory."""

    def __init__(self, directory: str | Path) -> None:
        self._dir = Path(directory)
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str, kind: str) -> Path:
        return self._dir / f"{name}.{kind}.yaml"

    def save_metamodel(self, name: str, metamodel: Metamodel) -> None:
        text = yaml.safe_dump(metamodel.model_dump(), sort_keys=False)
        self._path(name, "metamodel").write_text(text, encoding="utf-8")

    def load_metamodel(self, name: str) -> Metamodel:
        path = self._path(name, "metamodel")
        if not path.exists():
            raise KeyError(f"No metamodel file for {name!r}")
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return Metamodel.model_validate(data)

    def save_model(self, name: str, model: Model,
                   expected_rev: int | None = None) -> int:
        data = {
            "elements": [asdict(e) for e in model.elements.values()],
            "relationships": [asdict(r) for r in model.relationships.values()],
        }
        self._path(name, "model").write_text(
            yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        return 1

    def load_model(self, name: str, metamodel: Metamodel) -> Model:
        path = self._path(name, "model")
        if not path.exists():
            raise KeyError(f"No model file for {name!r}")
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        model = Model(metamodel)
        for e in data.get("elements", []):
            element = Element(**e)
            model.elements[element.id] = element
        for r in data.get("relationships", []):
            rel = Relationship(**r)
            model.relationships[rel.id] = rel
        return model
```

Note: `FileRepository.save_model` returns a constant rev for now — the file adapter does not yet implement optimistic concurrency (it satisfies the `Repository` signature). The `expected_rev` parameter exists so the seam is uniform; wiring real revision tracking into the file adapter is deferred with the rest of the concurrency machinery.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/repository/test_file_store.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/repository/file_store.py tests/repository/test_file_store.py
git commit -m "feat: file repository (YAML) for metamodels and models"
```

---

## Task 23: End-to-end integration

**Files:**
- Create: `examples/example.metamodel.yaml`
- Test: `tests/test_integration.py`

- [ ] **Step 1: Write the failing test**

`examples/example.metamodel.yaml`:
```yaml
enums:
  Status: [Draft, Reviewed, Approved]
elements:
  - name: NamedElement
    abstract: true
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
  - name: Requirement
    extends: NamedElement
    properties:
      - {name: status, datatype: Status, multiplicity: "1"}
      - {name: priority, datatype: integer, min: 1, max: 5}
  - name: Block
    extends: NamedElement
    properties:
      - {name: mass, datatype: float, min: 0}
relationships:
  - name: BlockHasPart
    containment: true
    source: Block
    target: Block
  - name: Satisfies
    containment: false
    source: Block
    target: Requirement
    target_multiplicity: "0..*"
```

`tests/test_integration.py`:

```python
from pathlib import Path

from data_rover.metamodel.loader import load_metamodel_file
from data_rover.model.ids import SequentialIdGenerator
from data_rover.model.model import Model
from data_rover.validation.pipeline import default_pipeline

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "example.metamodel.yaml"


def test_full_flow_valid_model_has_no_errors():
    mm = load_metamodel_file(EXAMPLE)
    model = Model(mm, id_generator=SequentialIdGenerator())

    block = model.create_element("Block")
    model.set_property(block, "name", "Engine")
    model.set_property(block, "mass", 120.0)

    req = model.create_element("Requirement")
    model.set_property(req, "name", "MaxMass")
    model.set_property(req, "status", "Approved")
    model.set_property(req, "priority", 2)

    model.connect("Satisfies", block.id, req.id)

    issues = default_pipeline().validate(model)
    assert issues == [], [i.message for i in issues]


def test_full_flow_catches_multiple_violations():
    mm = load_metamodel_file(EXAMPLE)
    model = Model(mm, id_generator=SequentialIdGenerator())

    block = model.create_element("Block")
    # missing required name; mass wrong type; bad enum + out-of-range on req
    model.set_property(block, "mass", "heavy")

    req = model.create_element("Requirement")
    model.set_property(req, "name", "R")
    model.set_property(req, "status", "Rejected")  # not in enum
    model.set_property(req, "priority", 99)  # above max

    # endpoint-typing violation: Satisfies target must be Requirement
    model.connect("Satisfies", block.id, block.id)

    messages = [i.message for i in default_pipeline().validate(model)]
    assert any("name" in m for m in messages)  # multiplicity
    assert any("heavy" in m for m in messages)  # type conformance
    assert any("Status" in m for m in messages)  # enum
    assert any("priority" in m for m in messages)  # facet
    assert any("Satisfies" in m for m in messages)  # endpoint typing


def test_cascade_delete_through_full_stack():
    mm = load_metamodel_file(EXAMPLE)
    model = Model(mm, id_generator=SequentialIdGenerator())
    parent = model.create_element("Block")
    child = model.create_element("Block")
    model.connect("BlockHasPart", parent.id, child.id)
    model.delete_element(parent.id)
    assert model.elements == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_integration.py -v`
Expected: FAIL (missing example file / behavior).

- [ ] **Step 3: Write minimal implementation**

No new production code — this task wires together existing modules. If a test reveals a gap, fix the relevant module and note it.

- [ ] **Step 4: Run the full suite**

Run: `pytest -v`
Expected: PASS (all tests across all tasks).

- [ ] **Step 5: Commit**

```bash
git add examples/example.metamodel.yaml tests/test_integration.py
git commit -m "test: end-to-end integration over example metamodel"
```

---

## Done criteria

- `pytest -v` passes for the whole suite.
- An example metamodel loads, a conforming model validates clean, and a deliberately broken model surfaces one issue per validator category.
- The core has no global mutable state, ids are core-assigned UUIDv7, all mutation goes through `Model`, validators accept a `Scope`, and persistence sits behind the `Repository` port — the five concurrency seams from the spec.
