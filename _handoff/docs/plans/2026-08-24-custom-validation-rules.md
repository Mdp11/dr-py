# Custom Validation Rules (P-12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-defined declarative validation rules (YAML), stored as a new `validation_rules` artifact kind, evaluated natively as a seventh pipeline validator with reach-aware incremental revalidation.

**Architecture:** A new core package `core/validation/rules/` (schema → compile → validator → reach) plugs into the existing `ValidationPipeline` via a new API-layer builder `api/rules.py::session_pipeline(session)`. Compiled rules are an immutable-swap cache on `Session` (built at hydration, refreshed when a commit touches a rules artifact or rebinds the metamodel). Scoped validation call sites widen their dirty set through `expand_scope` so cross-element rules stay live. Rule issues are always CONFORMANCE and flow through the existing issue store/panel; compile-time drift is surfaced via a `rules_status` field on `GET /model/issues`, never as ownerless issues.

**Tech Stack:** Python 3.14, pydantic v2, PyYAML, FastAPI, SQLAlchemy (no new deps). Frontend: Svelte 5, CodeMirror (existing packages only).

**Spec:** `docs/superpowers/specs/2026-08-24-custom-validation-rules-design.md`

## Global Constraints

- All commands run through pixi: `pixi run -e core-dev pytest ...`, `pixi run core-test`, `pixi run frontend-test`, `pixi run dr-tidy` (ruff + mypy + pyright must all pass).
- Caps (spec §2.4): `RULES_MAX_YAML_BYTES = 64 * 1024`, `MAX_RULES_PER_SET = 200`, `MAX_CONDITION_DEPTH = 8`. Schema bounds — enforced wherever the payload parses, never at evaluation time.
- Rule issues: `category` ALWAYS `IssueCategory.CONFORMANCE`; `check = "rule:<rule-name>"`; `target_ids = [element.id]`.
- Degraded-not-failed: no rules-related condition may ever raise out of a validator, 5xx a route, or block a commit.
- `default_pipeline()` stays rule-free (core stays session-agnostic); `tests/validation/test_check_names.py` must keep passing unchanged.
- Comments: concise, present-tense, only for non-obvious invariants. No spec/plan references in code.
- Do not commit anything under `docs/superpowers/` (gitignored by repo convention).
- Work on branch `feat/validation-rules` (create from `main` in Task 1 Step 1).

## Key pre-verified facts (do not re-derive)

- `ArtifactKind` is `enum.StrEnum` stored as VARCHAR(32) with **no CHECK constraint** (`db_models.py:283-331`, alembic 0008/0011/0012) → adding a member needs **no migration**.
- `Metamodel` cached lookups: `element_descendants(name) -> frozenset[str]` (empty for unknown names), `relationship_descendants(name)`, `is_element_type(name) -> bool`, `relationship_type(name) -> RelationshipType | None`, `effective_element_properties(name) -> list[PropertyDef]`, `is_containment(name)` (`core/metamodel/schema.py:376-461`).
- `Element`/`Relationship` are slotted dataclasses with `id`, `type_name`, `properties: dict[str, Any]` (+ `source_id`/`target_id` on Relationship). Many-valued properties are `list`s; missing key = unset.
- `IndexSet.outgoing_ids(eid)` / `incoming_ids(eid)` return **relationship ids** (live sets, do not mutate); far element = `model.relationships[rid].target_id` / `.source_id`. `indexes.elements_by_type: dict[str, set[str]]` is keyed by **exact** type name.
- `ValidationPipeline._stamped` fills only **unset** `issue.check` — issues constructed with `check="rule:..."` survive.
- Validators must not be shared across threads (mutable `MetamodelMemo` caches) → **never cache a pipeline or validator on the session**; cache only the immutable `CompiledRules` and build validators per run.
- `_BatchResult.dirty` is a `DirtyCollector`; `res.dirty.update(ids)` widens both the validate scope and the `state.replace(res.dirty.ids, ...)` drop set (live `KeysView`).
- Commit hook point: `routes/commits.py` between the view half (`unwind.view_res = view_res`, ~:1122) and `rebound = ...` (~:1131). Line numbers drift — locate by code, not number.
- YAML idiom: `import yaml`, `yaml.safe_load(text) or {}`, catch `yaml.YAMLError` for parse errors with `problem_mark` (0-based → 1-based).

---

### Task 1: Rule language schema (`core/validation/rules/schema.py`)

**Files:**
- Create: `src/data_rover/core/validation/rules/__init__.py` (empty)
- Create: `src/data_rover/core/validation/rules/schema.py`
- Create: `tests/validation/rules/__init__.py` (empty)
- Test: `tests/validation/rules/test_schema.py`

**Interfaces:**
- Consumes: nothing (pure pydantic + yaml).
- Produces: `RULES_SCHEMA_VERSION = 1`, `RULES_MAX_YAML_BYTES`, `MAX_RULES_PER_SET`, `MAX_CONDITION_DEPTH`; models `PropertyCond`, `RelationshipSpec`, `CountSpec`, `RelationshipCond`, `AllCond`, `AnyCond`, `NotCond`, `Rule`, `RuleSetDefinition`; type alias `Condition`; `parse_rule_set(text: str) -> RuleSetDefinition` (raises `RuleSetError(ValueError)`); `RulesArtifactPayload` + `RULES_ADAPTER: TypeAdapter[RulesArtifactPayload]`.

- [ ] **Step 1: Create branch**

```bash
git checkout main && git checkout -b feat/validation-rules
```

- [ ] **Step 2: Write the failing tests**

`tests/validation/rules/test_schema.py`:

```python
"""Rule-set schema: shape acceptance/rejection and caps."""

import pytest
from pydantic import ValidationError

from data_rover.core.validation.rules.schema import (
    MAX_CONDITION_DEPTH,
    MAX_RULES_PER_SET,
    RULES_ADAPTER,
    RULES_MAX_YAML_BYTES,
    RuleSetError,
    parse_rule_set,
)

VALID = """
schema_version: 1
rules:
  - name: critical-buildings-have-evacuation
    applies_to: Building
    severity: error
    when:
      all:
        - property: critical
          equals: true
        - any:
            - property: zone_count
              gte: 3
            - not:
                property: exempt
                equals: true
    then:
      relationship:
        type: Owns
        direction: outgoing
        to: Zone
        count: { gte: 1 }
        where:
          property: evacuation_plan
          exists: true
"""


def test_valid_document_parses():
    rs = parse_rule_set(VALID)
    assert rs.schema_version == 1
    assert rs.rules[0].name == "critical-buildings-have-evacuation"
    assert rs.rules[0].when is not None
    assert rs.rules[0].severity == "error"
    assert rs.rules[0].disabled is False


def test_minimal_rule_defaults():
    rs = parse_rule_set(
        "rules:\n"
        "  - name: r1\n"
        "    applies_to: Building\n"
        "    then:\n"
        "      property: name\n"
        "      exists: true\n"
    )
    r = rs.rules[0]
    assert r.when is None and r.severity == "error" and r.message is None


def test_unparseable_yaml_raises_rule_set_error():
    with pytest.raises(RuleSetError):
        parse_rule_set("rules: [unclosed")


def test_property_atom_requires_exactly_one_test():
    base = "rules:\n  - name: r\n    applies_to: B\n    then:\n"
    with pytest.raises(RuleSetError):
        parse_rule_set(base + "      property: p\n")  # zero tests
    with pytest.raises(RuleSetError):
        parse_rule_set(base + "      property: p\n      equals: 1\n      gte: 2\n")


def test_relationship_atom_requires_exactly_one_of_exists_count():
    base = (
        "rules:\n  - name: r\n    applies_to: B\n    then:\n"
        "      relationship:\n        type: T\n        direction: outgoing\n"
    )
    with pytest.raises(RuleSetError):
        parse_rule_set(base)  # neither
    with pytest.raises(RuleSetError):
        parse_rule_set(base + "        exists: true\n        count: { gte: 1 }\n")


def test_count_spec_needs_at_least_one_bound():
    with pytest.raises(RuleSetError):
        parse_rule_set(
            "rules:\n  - name: r\n    applies_to: B\n    then:\n"
            "      relationship:\n        type: T\n        direction: outgoing\n"
            "        count: {}\n"
        )


def test_unknown_keys_rejected():
    with pytest.raises(RuleSetError):
        parse_rule_set(
            "rules:\n  - name: r\n    applies_to: B\n    then:\n"
            "      property: p\n      exists: true\n      bogus: 1\n"
        )


def test_duplicate_rule_names_rejected():
    doc = (
        "rules:\n"
        "  - {name: r, applies_to: B, then: {property: p, exists: true}}\n"
        "  - {name: r, applies_to: C, then: {property: p, exists: true}}\n"
    )
    with pytest.raises(RuleSetError):
        parse_rule_set(doc)


def test_depth_cap_enforced():
    # nest `not:` MAX_CONDITION_DEPTH+1 levels around a property atom
    inner = "{property: p, exists: true}"
    for _ in range(MAX_CONDITION_DEPTH):
        inner = "{not: " + inner + "}"
    doc = f"rules:\n  - {{name: r, applies_to: B, then: {inner}}}\n"
    with pytest.raises(RuleSetError):
        parse_rule_set(doc)


def test_rule_count_cap():
    rules = "\n".join(
        f"  - {{name: r{i}, applies_to: B, then: {{property: p, exists: true}}}}"
        for i in range(MAX_RULES_PER_SET + 1)
    )
    with pytest.raises(RuleSetError):
        parse_rule_set("rules:\n" + rules)


def test_payload_adapter_validates_embedded_yaml():
    RULES_ADAPTER.validate_python(
        {"schema_version": 1, "yaml": "rules: []\n"}
    )
    with pytest.raises(ValidationError):
        RULES_ADAPTER.validate_python({"schema_version": 1, "yaml": "rules: [bad"})
    with pytest.raises(ValidationError):
        RULES_ADAPTER.validate_python(
            {"schema_version": 1, "yaml": "x" * (RULES_MAX_YAML_BYTES + 1)}
        )
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/validation/rules/test_schema.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.core.validation.rules`

- [ ] **Step 4: Implement `schema.py`**

```python
"""Declarative validation-rule language: pydantic AST + YAML entry point.

One condition language used twice per rule (`when` guard, `then` assertion).
Union members are disambiguated by their distinctive keys (`all`/`any`/`not`/
`property`/`relationship`) with extra="forbid", not a discriminator field —
authors never write a `kind` key.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

RULES_SCHEMA_VERSION = 1
RULES_MAX_YAML_BYTES = 64 * 1024
MAX_RULES_PER_SET = 200
MAX_CONDITION_DEPTH = 8

Scalar = str | int | float | bool

_PROPERTY_TESTS = (
    "exists", "equals", "not_equals", "in_", "gt", "gte", "lt", "lte", "contains",
)


class RuleSetError(ValueError):
    """A rule-set document that cannot be used (parse or schema failure)."""


class PropertyCond(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    property: str = Field(min_length=1)
    exists: bool | None = None
    equals: Scalar | None = None
    not_equals: Scalar | None = None
    in_: list[Scalar] | None = Field(default=None, alias="in")
    gt: float | None = None
    gte: float | None = None
    lt: float | None = None
    lte: float | None = None
    contains: Scalar | None = None

    @model_validator(mode="after")
    def _exactly_one_test(self) -> "PropertyCond":
        # model_fields_set, not is-None checks: `equals: null` must count as set
        given = [t for t in _PROPERTY_TESTS if t in self.model_fields_set]
        if len(given) != 1:
            raise ValueError(
                f"property condition {self.property!r} needs exactly one test, "
                f"got {given or 'none'}"
            )
        return self


class CountSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    eq: int | None = Field(default=None, ge=0)
    gte: int | None = Field(default=None, ge=0)
    lte: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _at_least_one(self) -> "CountSpec":
        if self.eq is None and self.gte is None and self.lte is None:
            raise ValueError("count needs at least one of eq/gte/lte")
        return self


class RelationshipSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = Field(min_length=1)
    direction: Literal["outgoing", "incoming"]
    to: str | None = None
    where: "Condition | None" = None
    exists: bool | None = None
    count: CountSpec | None = None

    @model_validator(mode="after")
    def _exactly_one_of_exists_count(self) -> "RelationshipSpec":
        if (self.exists is None) == (self.count is None):
            raise ValueError(
                f"relationship condition on {self.type!r} needs exactly one of "
                "exists/count"
            )
        return self


class RelationshipCond(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relationship: RelationshipSpec


class AllCond(BaseModel):
    model_config = ConfigDict(extra="forbid")

    all: list["Condition"] = Field(min_length=1)


class AnyCond(BaseModel):
    model_config = ConfigDict(extra="forbid")

    any: list["Condition"] = Field(min_length=1)


class NotCond(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    not_: "Condition" = Field(alias="not")


Condition = AllCond | AnyCond | NotCond | PropertyCond | RelationshipCond


def condition_depth(cond: Condition) -> int:
    match cond:
        case AllCond(all=subs) | AnyCond(any=subs):
            return 1 + max(condition_depth(c) for c in subs)
        case NotCond(not_=sub):
            return 1 + condition_depth(sub)
        case RelationshipCond(relationship=spec):
            return 1 + (condition_depth(spec.where) if spec.where else 0)
        case _:
            return 1


class Rule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    description: str = ""
    applies_to: str = Field(min_length=1)
    severity: Literal["error", "warning"] = "error"
    disabled: bool = False
    when: Condition | None = None
    then: Condition
    message: str | None = None

    @model_validator(mode="after")
    def _depth(self) -> "Rule":
        for label, cond in (("when", self.when), ("then", self.then)):
            if cond is not None and condition_depth(cond) > MAX_CONDITION_DEPTH:
                raise ValueError(
                    f"rule {self.name!r}: {label} nests deeper than "
                    f"{MAX_CONDITION_DEPTH} levels"
                )
        return self


class RuleSetDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = RULES_SCHEMA_VERSION
    rules: list[Rule] = Field(default_factory=list, max_length=MAX_RULES_PER_SET)

    @model_validator(mode="after")
    def _unique_names(self) -> "RuleSetDefinition":
        seen: set[str] = set()
        for r in self.rules:
            if r.name in seen:
                raise ValueError(f"duplicate rule name {r.name!r}")
            seen.add(r.name)
        return self


RelationshipSpec.model_rebuild()
AllCond.model_rebuild()
AnyCond.model_rebuild()
NotCond.model_rebuild()

_RULE_SET_ADAPTER: TypeAdapter[RuleSetDefinition] = TypeAdapter(RuleSetDefinition)


def parse_rule_set(text: str) -> RuleSetDefinition:
    """YAML text -> validated rule set; RuleSetError on any failure."""
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as exc:
        raise RuleSetError(f"Malformed rules YAML: {exc}") from exc
    try:
        return _RULE_SET_ADAPTER.validate_python(data)
    except Exception as exc:
        raise RuleSetError(f"Invalid rule set: {exc}") from exc


class RulesArtifactPayload(BaseModel):
    """The `validation_rules` artifact payload: verbatim YAML text.

    The text (not parsed JSON) is the stored form so author comments and
    formatting survive round trips, mirroring the metamodel blob."""

    schema_version: int = RULES_SCHEMA_VERSION
    yaml: str = Field(max_length=RULES_MAX_YAML_BYTES)

    @model_validator(mode="after")
    def _yaml_parses(self) -> "RulesArtifactPayload":
        parse_rule_set(self.yaml)  # RuleSetError is a ValueError: pydantic wraps it
        return self


RULES_ADAPTER: TypeAdapter[RulesArtifactPayload] = TypeAdapter(RulesArtifactPayload)
```

Note: `Annotated` import may be unused depending on final form — let ruff strip it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/validation/rules/test_schema.py -v`
Expected: all PASS

- [ ] **Step 6: Lint + typecheck + commit**

```bash
pixi run core-lint
git add src/data_rover/core/validation/rules tests/validation/rules
git commit -m "feat(rules): declarative rule-set schema and YAML payload adapter"
```

---

### Task 2: Compilation & drift diagnostics (`compile.py`)

**Files:**
- Create: `src/data_rover/core/validation/rules/compile.py`
- Test: `tests/validation/rules/test_compile.py`

**Interfaces:**
- Consumes: Task 1 (`parse_rule_set`, `Rule`, condition models); `Metamodel` cached lookups.
- Produces:
  - `RuleSetSource(artifact_id: str, name: str, yaml: str)` (frozen dataclass)
  - `RuleDiagnostic(artifact_id: str, set_name: str, rule: str, reason: str)` (frozen)
  - `CompiledRule(artifact_id: str, rule: Rule, applies_types: frozenset[str], check: str)` (frozen; `check == f"rule:{rule.name}"`)
  - `CompiledRules` (dataclass): `sources: tuple[RuleSetSource, ...]`, `rules: tuple[CompiledRule, ...]`, `rules_by_type: dict[str, tuple[CompiledRule, ...]]`, `skipped: tuple[RuleDiagnostic, ...]`, `eval_errors: Counter[str]`; property `total: int` (== `len(rules)`)
  - `empty_compiled() -> CompiledRules`
  - `compile_rule_sets(sources: Sequence[RuleSetSource], metamodel: Metamodel) -> CompiledRules`
  - `applies_type_names(*compiled: CompiledRules) -> set[str]` (union of every rule's `applies_types`)

- [ ] **Step 1: Write the failing tests**

`tests/validation/rules/test_compile.py`:

```python
"""Compilation: dispatch map, drift skips, unparseable-set tolerance."""

from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.validation.rules.compile import (
    RuleSetSource,
    applies_type_names,
    compile_rule_sets,
    empty_compiled,
)


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="critical", datatype="boolean"),
                ],
            ),
            ElementType(name="OfficeBuilding", extends="Building"),
            ElementType(
                name="Zone",
                properties=[PropertyDef(name="evacuation_plan", datatype="string")],
            ),
        ],
        relationships=[
            RelationshipType(
                name="Owns",
                containment=True,
                mappings=[Mapping(source="Building", target="Zone")],
            )
        ],
    )


def _src(yaml_text: str, artifact_id: str = "a1", name: str = "set-1") -> RuleSetSource:
    return RuleSetSource(artifact_id=artifact_id, name=name, yaml=yaml_text)


GOOD = """
rules:
  - name: has-zone
    applies_to: Building
    then:
      relationship: {type: Owns, direction: outgoing, to: Zone, exists: true}
"""


def test_compile_builds_subtype_closed_dispatch():
    c = compile_rule_sets([_src(GOOD)], _mm())
    assert c.total == 1 and not c.skipped
    assert set(c.rules_by_type) == {"Building", "OfficeBuilding"}
    assert c.rules[0].check == "rule:has-zone"


def test_disabled_rule_not_dispatched():
    doc = GOOD.replace("applies_to: Building", "applies_to: Building\n    disabled: true")
    c = compile_rule_sets([_src(doc)], _mm())
    assert c.total == 0 and not c.skipped and not c.rules_by_type


def test_unknown_applies_to_skips_rule_with_reason():
    doc = GOOD.replace("applies_to: Building", "applies_to: Bulding")
    c = compile_rule_sets([_src(doc)], _mm())
    assert c.total == 0
    assert c.skipped[0].rule == "has-zone"
    assert "Bulding" in c.skipped[0].reason


def test_unknown_relationship_type_and_far_type_skip():
    for bad in ("type: Owsn", "to: Zoen"):
        doc = GOOD.replace(bad.split(": ")[0] + ": " + {"type: Owsn": "Owns", "to: Zoen": "Zone"}[bad], bad)
        c = compile_rule_sets([_src(doc)], _mm())
        assert c.total == 0 and len(c.skipped) == 1


def test_unknown_property_on_context_skips():
    doc = (
        "rules:\n"
        "  - name: p\n    applies_to: Building\n"
        "    then: {property: nope, exists: true}\n"
    )
    c = compile_rule_sets([_src(doc)], _mm())
    assert c.total == 0 and "nope" in c.skipped[0].reason


def test_property_in_unfiltered_where_not_statically_checked():
    # no `to:` on the hop -> far context unknown -> property name not checkable
    doc = (
        "rules:\n"
        "  - name: w\n    applies_to: Building\n"
        "    then:\n"
        "      relationship:\n"
        "        type: Owns\n        direction: outgoing\n        exists: true\n"
        "        where: {property: whatever, exists: true}\n"
    )
    c = compile_rule_sets([_src(doc)], _mm())
    assert c.total == 1 and not c.skipped


def test_unparseable_set_skipped_whole_with_diagnostic():
    c = compile_rule_sets([_src("rules: [", name="broken"), _src(GOOD, "a2", "ok")], _mm())
    assert c.total == 1
    assert c.skipped[0].set_name == "broken" and c.skipped[0].rule == ""


def test_empty_and_applies_union():
    assert empty_compiled().total == 0
    c = compile_rule_sets([_src(GOOD)], _mm())
    assert applies_type_names(empty_compiled(), c) == {"Building", "OfficeBuilding"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/validation/rules/test_compile.py -v`
Expected: FAIL — `ModuleNotFoundError` for `compile`

- [ ] **Step 3: Implement `compile.py`**

```python
"""Rule-set compilation: parse, drift-check, and build the dispatch map.

Compilation is pure and cheap; the output is treated as immutable and cached
on the API Session (immutable-swap — never mutate a published CompiledRules,
except the GIL-atomic `eval_errors` counter the validator increments).

Drift stance: a rule referencing a schema name the metamodel doesn't have is
skipped WHOLE with a diagnostic — never evaluated half-blind, never an error.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from collections.abc import Sequence

from ...metamodel.schema import Metamodel
from .schema import (
    AllCond,
    AnyCond,
    Condition,
    NotCond,
    PropertyCond,
    RelationshipCond,
    Rule,
    RuleSetError,
    parse_rule_set,
)


@dataclass(frozen=True)
class RuleSetSource:
    artifact_id: str
    name: str
    yaml: str


@dataclass(frozen=True)
class RuleDiagnostic:
    artifact_id: str
    set_name: str
    #: "" when the whole set failed to parse
    rule: str
    reason: str


@dataclass(frozen=True)
class CompiledRule:
    artifact_id: str
    rule: Rule
    applies_types: frozenset[str]
    check: str


@dataclass
class CompiledRules:
    sources: tuple[RuleSetSource, ...] = ()
    rules: tuple[CompiledRule, ...] = ()
    rules_by_type: dict[str, tuple[CompiledRule, ...]] = field(default_factory=dict)
    skipped: tuple[RuleDiagnostic, ...] = ()
    #: per-rule unexpected-evaluation-failure counts (check name -> count);
    #: mutated by RulesValidator under the callers' locking discipline
    eval_errors: Counter[str] = field(default_factory=Counter)

    @property
    def total(self) -> int:
        return len(self.rules)


def empty_compiled() -> CompiledRules:
    return CompiledRules()


def _drift_reason(rule: Rule, mm: Metamodel) -> str | None:
    """First schema mismatch in the rule, or None when it compiles clean."""
    if not mm.is_element_type(rule.applies_to):
        return f"unknown stereotype {rule.applies_to!r}"

    def props_of(type_name: str | None) -> set[str] | None:
        if type_name is None:
            return None  # unknown context: property names not checkable
        return {p.name for p in mm.effective_element_properties(type_name)}

    def walk(cond: Condition, context: str | None) -> str | None:
        match cond:
            case AllCond(all=subs) | AnyCond(any=subs):
                for c in subs:
                    if (r := walk(c, context)) is not None:
                        return r
            case NotCond(not_=sub):
                return walk(sub, context)
            case PropertyCond():
                known = props_of(context)
                if known is not None and cond.property not in known:
                    return (
                        f"stereotype {context!r} has no property {cond.property!r}"
                    )
            case RelationshipCond(relationship=spec):
                if mm.relationship_type(spec.type) is None:
                    return f"unknown relationship type {spec.type!r}"
                if spec.to is not None and not mm.is_element_type(spec.to):
                    return f"unknown stereotype {spec.to!r}"
                if spec.where is not None:
                    return walk(spec.where, spec.to)
        return None

    for cond in (rule.when, rule.then):
        if cond is not None and (r := walk(cond, rule.applies_to)) is not None:
            return r
    return None


def compile_rule_sets(
    sources: Sequence[RuleSetSource], metamodel: Metamodel
) -> CompiledRules:
    rules: list[CompiledRule] = []
    skipped: list[RuleDiagnostic] = []
    for src in sources:
        try:
            definition = parse_rule_set(src.yaml)
        except RuleSetError as exc:
            skipped.append(
                RuleDiagnostic(src.artifact_id, src.name, "", str(exc))
            )
            continue
        for rule in definition.rules:
            if rule.disabled:
                continue
            reason = _drift_reason(rule, metamodel)
            if reason is not None:
                skipped.append(
                    RuleDiagnostic(src.artifact_id, src.name, rule.name, reason)
                )
                continue
            rules.append(
                CompiledRule(
                    artifact_id=src.artifact_id,
                    rule=rule,
                    applies_types=metamodel.element_descendants(rule.applies_to),
                    check=f"rule:{rule.name}",
                )
            )
    by_type: dict[str, list[CompiledRule]] = {}
    for cr in rules:
        for t in sorted(cr.applies_types):
            by_type.setdefault(t, []).append(cr)
    return CompiledRules(
        sources=tuple(sources),
        rules=tuple(rules),
        rules_by_type={t: tuple(rs) for t, rs in by_type.items()},
        skipped=tuple(skipped),
    )


def applies_type_names(*compiled: CompiledRules) -> set[str]:
    """Union of every compiled rule's applies-to closure (rule-edit rescope)."""
    out: set[str] = set()
    for c in compiled:
        for cr in c.rules:
            out |= cr.applies_types
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/validation/rules/ -v`
Expected: all PASS

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint
git add -A src/data_rover/core/validation/rules tests/validation/rules
git commit -m "feat(rules): compile rule sets with drift diagnostics and dispatch map"
```

---

### Task 3: Evaluation semantics + `RulesValidator`

**Files:**
- Create: `src/data_rover/core/validation/rules/validator.py`
- Modify: `src/data_rover/core/validation/pipeline.py` (add `default_validators()`)
- Test: `tests/validation/rules/test_eval.py`, `tests/validation/rules/test_validator.py`

**Interfaces:**
- Consumes: Task 2 (`CompiledRules`, `CompiledRule`); `Model`, `Metamodel`, `Issue`.
- Produces:
  - `evaluate_condition(model: Model, el: Element, cond: Condition) -> bool` (module-level, pure; uses `model.metamodel` internally)
  - `class RulesValidator(EntityValidator)` — `__init__(self, compiled: CompiledRules)`, `check_name = ""` (issues carry per-rule checks), `validate_element` only.
  - In `pipeline.py`: `def default_validators() -> list[Validator]` returning fresh instances of the six built-ins; `default_pipeline()` becomes `ValidationPipeline(default_validators())`.

- [ ] **Step 1: Write the failing semantics tests**

`tests/validation/rules/test_eval.py` — the pinned-semantics table. Build one fixture:

```python
"""Pinned condition-evaluation semantics (the spec's contract, §2.2/§2.3)."""

from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.rules.schema import parse_rule_set
from data_rover.core.validation.rules.validator import evaluate_condition


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[
                    PropertyDef(name="critical", datatype="boolean"),
                    PropertyDef(name="floors", datatype="integer"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                    PropertyDef(name="label", datatype="string"),
                ],
            ),
            ElementType(name="Zone",
                        properties=[PropertyDef(name="plan", datatype="string")]),
            ElementType(name="SafeZone", extends="Zone"),
        ],
        relationships=[
            RelationshipType(
                name="Owns", containment=True,
                mappings=[Mapping(source="Building", target="Zone")],
            ),
            RelationshipType(
                name="Monitors",
                mappings=[Mapping(source="Building", target="Zone")],
            ),
        ],
    )


def _cond(yaml_frag: str):
    """Parse one condition by wrapping it in a throwaway rule."""
    rs = parse_rule_set(
        "rules:\n  - name: t\n    applies_to: Building\n    then:\n" + yaml_frag
    )
    return rs.rules[0].then


def _building(model, **props):
    el = model.create_element("Building")
    for k, v in props.items():
        model.set_property(el, k, v)
    return el


# -- property atoms ---------------------------------------------------------

def test_missing_property_fails_everything_but_exists_false():
    model = Model(_mm())
    el = _building(model)
    assert evaluate_condition(model, el, _cond("      property: label\n      exists: false\n"))
    for frag in (
        "      property: label\n      exists: true\n",
        "      property: label\n      equals: x\n",
        "      property: label\n      not_equals: x\n",  # pinned: false on missing
        "      property: floors\n      gt: 0\n",
        "      property: label\n      contains: x\n",
    ):
        assert not evaluate_condition(model, el, _cond(frag))


def test_equality_no_coercion():
    model = Model(_mm())
    el = _building(model, floors=3)
    assert evaluate_condition(model, el, _cond("      property: floors\n      equals: 3\n"))
    assert not evaluate_condition(model, el, _cond("      property: floors\n      equals: '3'\n"))


def test_numeric_comparisons_and_type_mismatch_false():
    model = Model(_mm())
    el = _building(model, floors=5, label="tall")
    assert evaluate_condition(model, el, _cond("      property: floors\n      gte: 5\n"))
    assert not evaluate_condition(model, el, _cond("      property: floors\n      lt: 5\n"))
    # gt on a string value: false, never an error
    assert not evaluate_condition(model, el, _cond("      property: label\n      gt: 1\n"))


def test_in_and_contains():
    model = Model(_mm())
    el = _building(model, label="north-wing", tags=["a", "b"])
    assert evaluate_condition(model, el, _cond("      property: label\n      in: [north-wing, south]\n"))
    assert evaluate_condition(model, el, _cond("      property: label\n      contains: wing\n"))
    # contains on a LIST value = whole-value membership
    assert evaluate_condition(model, el, _cond("      property: tags\n      contains: a\n"))
    assert not evaluate_condition(model, el, _cond("      property: tags\n      contains: wing\n"))


def test_many_valued_any_entry_matches_scalar_tests():
    model = Model(_mm())
    el = _building(model, tags=["x", "y"])
    assert evaluate_condition(model, el, _cond("      property: tags\n      equals: y\n"))
    assert not evaluate_condition(model, el, _cond("      property: tags\n      equals: z\n"))
    empty = _building(model, tags=[])
    assert evaluate_condition(model, empty, _cond("      property: tags\n      exists: false\n"))


# -- relationship atoms -----------------------------------------------------

def test_exists_count_to_and_where():
    model = Model(_mm())
    b = _building(model)
    z1, z2 = model.create_element("Zone"), model.create_element("SafeZone")
    model.set_property(z1, "plan", "P1")
    model.connect("Owns", b.id, z1.id)
    model.connect("Owns", b.id, z2.id)
    assert evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, exists: true}\n"))
    assert evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, to: Zone, count: {eq: 2}}\n"))
    # subtype counted under `to: Zone`; `where` filters to the one with a plan
    assert evaluate_condition(model, b, _cond(
        "      relationship:\n"
        "        type: Owns\n        direction: outgoing\n        count: {eq: 1}\n"
        "        where: {property: plan, exists: true}\n"))
    # incoming direction, from the zone's side
    assert evaluate_condition(model, z1, _cond(
        "      relationship: {type: Owns, direction: incoming, exists: true}\n"))
    assert not evaluate_condition(model, b, _cond(
        "      relationship: {type: Monitors, direction: outgoing, exists: true}\n"))


def test_dangling_far_endpoint_semantics():
    model = Model(_mm())
    b = _building(model)
    z = model.create_element("Zone")
    model.connect("Owns", b.id, z.id)
    # dangle the far end without cascading the relationship away
    del model.elements[z.id]
    model.indexes.rebuild()
    # unfiltered atom still counts the relationship
    assert evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, exists: true}\n"))
    # any far-element test excludes it, never raises
    assert not evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, to: Zone, exists: true}\n"))


# -- combinators ------------------------------------------------------------

def test_all_any_not_nesting():
    model = Model(_mm())
    el = _building(model, critical=True, floors=2)
    cond = _cond(
        "      all:\n"
        "        - property: critical\n          equals: true\n"
        "        - any:\n"
        "            - property: floors\n              gte: 3\n"
        "            - not:\n"
        "                property: floors\n                equals: 99\n"
    )
    assert evaluate_condition(model, el, cond)
```

`tests/validation/rules/test_validator.py`:

```python
"""RulesValidator: issue shape, guard behavior, dispatch, error tolerance."""

from data_rover.core.validation.issue import IssueCategory, Severity
from data_rover.core.validation.rules.compile import RuleSetSource, compile_rule_sets
from data_rover.core.validation.rules.validator import RulesValidator
from data_rover.core.validation.scope import Scope

from .test_eval import _mm  # shared fixture metamodel
from data_rover.core.model.model import Model

DOC = """
rules:
  - name: zoned
    applies_to: Building
    severity: warning
    when: {property: critical, equals: true}
    then:
      relationship: {type: Owns, direction: outgoing, to: Zone, exists: true}
    message: critical buildings need a zone
"""


def _compiled(model):
    return compile_rule_sets([RuleSetSource("a1", "s", DOC)], model.metamodel)


def test_guard_gates_and_issue_shape():
    model = Model(_mm())
    quiet = model.create_element("Building")          # when fails -> no issue
    hot = model.create_element("Building")
    model.set_property(hot, "critical", True)          # when passes, then fails
    issues = RulesValidator(_compiled(model)).validate(model, Scope.all())
    assert len(issues) == 1
    issue = issues[0]
    assert issue.target_ids == [hot.id]
    assert issue.severity is Severity.WARNING
    assert issue.category is IssueCategory.CONFORMANCE
    assert issue.check == "rule:zoned"
    assert issue.message == "critical buildings need a zone"


def test_satisfied_rule_emits_nothing():
    model = Model(_mm())
    hot = model.create_element("Building")
    model.set_property(hot, "critical", True)
    z = model.create_element("Zone")
    model.connect("Owns", hot.id, z.id)
    assert RulesValidator(_compiled(model)).validate(model, Scope.all()) == []


def test_non_matching_type_skipped():
    model = Model(_mm())
    model.create_element("Zone")
    assert RulesValidator(_compiled(model)).validate(model, Scope.all()) == []


def test_default_message_generated():
    doc = DOC.replace("    message: critical buildings need a zone\n", "")
    model = Model(_mm())
    hot = model.create_element("Building")
    model.set_property(hot, "critical", True)
    compiled = compile_rule_sets([RuleSetSource("a1", "s", doc)], model.metamodel)
    [issue] = RulesValidator(compiled).validate(model, Scope.all())
    assert "zoned" in issue.message


def test_evaluation_error_degrades_and_counts(monkeypatch):
    model = Model(_mm())
    hot = model.create_element("Building")
    model.set_property(hot, "critical", True)
    compiled = _compiled(model)
    import data_rover.core.validation.rules.validator as vmod

    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(vmod, "evaluate_condition", boom)
    issues = RulesValidator(compiled).validate(model, Scope.all())
    assert issues == []                      # degraded, not raised
    assert compiled.eval_errors["rule:zoned"] == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/validation/rules/test_eval.py tests/validation/rules/test_validator.py -v`
Expected: FAIL — no `validator` module

- [ ] **Step 3: Implement `validator.py` and `default_validators()`**

`validator.py`:

```python
"""Native evaluation of compiled declarative rules as a pipeline validator."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from ..issue import Issue, IssueCategory, Severity
from ..pipeline import EntityValidator
from .compile import CompiledRule, CompiledRules
from .schema import (
    AllCond,
    AnyCond,
    Condition,
    CountSpec,
    NotCond,
    PropertyCond,
    RelationshipCond,
    RelationshipSpec,
)

if TYPE_CHECKING:
    from ...model.element import Element
    from ...model.model import Model

logger = logging.getLogger(__name__)

_SEVERITY = {"error": Severity.ERROR, "warning": Severity.WARNING}


def _eq(a: Any, b: Any) -> bool:
    """Pinned equality: plain Python == (so "3" != 3 falls out naturally),
    with a bool/int guard because bool subclasses int (True must not equal 1)."""
    if isinstance(a, bool) is not isinstance(b, bool):
        return False
    return a == b


def _test_scalar(cond: PropertyCond, value: Any) -> bool:
    """One stored scalar against the atom's single test. Type-mismatched
    comparisons are False, never an error (the engine stays inspectable)."""
    fields = cond.model_fields_set
    if "equals" in fields:
        return _eq(value, cond.equals)
    if "not_equals" in fields:
        return not _eq(value, cond.not_equals)
    if "in_" in fields:
        return any(_eq(value, v) for v in cond.in_ or [])
    if "contains" in fields:
        return (
            isinstance(value, str)
            and isinstance(cond.contains, str)
            and cond.contains in value
        )
    # numeric comparisons; bool is an int subclass we deliberately exclude
    bound = cond.gt if "gt" in fields else cond.gte if "gte" in fields \
        else cond.lt if "lt" in fields else cond.lte
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    assert bound is not None
    if "gt" in fields:
        return value > bound
    if "gte" in fields:
        return value >= bound
    if "lt" in fields:
        return value < bound
    return value <= bound


def _eval_property(el: Element, cond: PropertyCond) -> bool:
    value = el.properties.get(cond.property)
    present = value is not None and value != []
    if "exists" in cond.model_fields_set:
        return present is cond.exists
    if not present:
        return False  # missing fails every non-exists test (not_equals included)
    if isinstance(value, list):
        if "contains" in cond.model_fields_set:
            # list value: whole-value membership, the one list-operand test
            return any(_eq(v, cond.contains) for v in value)
        return any(_test_scalar(cond, v) for v in value)
    return _test_scalar(cond, value)


def _count_ok(spec: CountSpec, n: int) -> bool:
    return (
        (spec.eq is None or n == spec.eq)
        and (spec.gte is None or n >= spec.gte)
        and (spec.lte is None or n <= spec.lte)
    )


def _eval_relationship(model: Model, el: Element, spec: RelationshipSpec) -> bool:
    mm = model.metamodel
    rel_types = mm.relationship_descendants(spec.type)
    far_types = None if spec.to is None else mm.element_descendants(spec.to)
    outgoing = spec.direction == "outgoing"
    rel_ids = (
        model.indexes.outgoing_ids(el.id) if outgoing
        else model.indexes.incoming_ids(el.id)
    )
    n = 0
    for rid in rel_ids:
        rel = model.relationships[rid]
        if rel.type_name not in rel_types:
            continue
        if far_types is not None or spec.where is not None:
            far_id = rel.target_id if outgoing else rel.source_id
            far = model.elements.get(far_id)
            if far is None:
                continue  # dangling far endpoint: non-matching, never an error
            if far_types is not None and far.type_name not in far_types:
                continue
            if spec.where is not None and not evaluate_condition(
                model, far, spec.where
            ):
                continue
        n += 1
    if spec.exists is not None:
        return (n > 0) is spec.exists
    assert spec.count is not None
    return _count_ok(spec.count, n)


def evaluate_condition(model: Model, el: Element, cond: Condition) -> bool:
    match cond:
        case AllCond(all=subs):
            return all(evaluate_condition(model, el, c) for c in subs)
        case AnyCond(any=subs):
            return any(evaluate_condition(model, el, c) for c in subs)
        case NotCond(not_=sub):
            return not evaluate_condition(model, el, sub)
        case PropertyCond():
            return _eval_property(el, cond)
        case RelationshipCond(relationship=spec):
            return _eval_relationship(model, el, spec)
    raise AssertionError(f"unhandled condition {type(cond).__name__}")


def _issue_for(cr: CompiledRule, el: Element) -> Issue:
    rule = cr.rule
    message = rule.message or (
        f"Rule '{rule.name}' violated"
        + (f": {rule.description}" if rule.description else "")
    )
    return Issue(
        severity=_SEVERITY[rule.severity],
        message=message,
        target_ids=[el.id],
        category=IssueCategory.CONFORMANCE,
        check=cr.check,
    )


class RulesValidator(EntityValidator):
    """Evaluates user-defined rules; degraded-not-failed on any surprise."""

    check_name = ""  # per-issue checks are stamped at construction

    def __init__(self, compiled: CompiledRules) -> None:
        self._compiled = compiled

    def validate_element(self, model, el) -> list[Issue]:
        rules = self._compiled.rules_by_type.get(el.type_name)
        if not rules:
            return []
        issues: list[Issue] = []
        for cr in rules:
            try:
                if cr.rule.when is not None and not evaluate_condition(
                    model, el, cr.rule.when
                ):
                    continue
                if not evaluate_condition(model, el, cr.rule.then):
                    issues.append(_issue_for(cr, el))
            except Exception:
                # a user rule must never break validation: count and move on
                self._compiled.eval_errors[cr.check] += 1
                logger.warning(
                    "rule %s failed to evaluate on element %s",
                    cr.check, el.id, exc_info=True,
                )
        return issues
```

In `pipeline.py`, refactor `default_pipeline()`:

```python
def default_validators() -> list[Validator]:
    """Fresh instances of the six built-in validators, in pipeline order."""
    from .validators.containment import ContainmentValidator
    from .validators.endpoint_typing import EndpointTypingValidator
    from .validators.facets import FacetsValidator
    from .validators.multiplicity import MultiplicityValidator
    from .validators.type_conformance import TypeConformanceValidator
    from .validators.uniqueness import UniquenessValidator

    return [
        TypeConformanceValidator(),
        MultiplicityValidator(),
        FacetsValidator(),
        EndpointTypingValidator(),
        ContainmentValidator(),
        UniquenessValidator(),
    ]


def default_pipeline() -> ValidationPipeline:
    """(keep existing docstring)"""
    return ValidationPipeline(default_validators())
```

Note on `_eval_property`: `value != []` treats an explicit empty list as absent (`exists: false` matches), per spec ("exists is true iff the list is non-empty"). `None`-valued properties count as absent for the same reason.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/validation/rules/ tests/validation/test_check_names.py -v`
Expected: all PASS (roster test untouched)

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint
git add -A src/data_rover/core/validation tests/validation/rules
git commit -m "feat(rules): native rule evaluation as a pipeline validator"
```

---

### Task 4: Reverse reach + `expand_scope` (`reach.py`)

**Files:**
- Create: `src/data_rover/core/validation/rules/reach.py`
- Test: `tests/validation/rules/test_reach.py`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  - `ReverseStep(rel_types: frozenset[str], direction: Literal["outgoing","incoming"], far_types: frozenset[str] | None)` (frozen; direction is as written in the rule, owner→far)
  - `ReversePath(steps: tuple[ReverseStep, ...])` (frozen; root-first)
  - `derive_paths(rule: Rule, metamodel: Metamodel) -> list[ReversePath]` (from `when` AND `then`)
  - `expand_scope(model: Model, compiled: CompiledRules, dirty_ids: Iterable[str]) -> list[str]` — extra element ids, deduped, deterministic order.
- `CompiledRule` gains a `paths: tuple[ReversePath, ...]` field (computed in `compile_rule_sets` — modify Task 2's `compile.py` to call `derive_paths`; import placed to avoid cycles: `reach.py` imports from `schema.py` only, `compile.py` imports `derive_paths` from `reach.py`).

**Reach algorithm (implement exactly):** for each dirty id resolving to a live element `e`, for each compiled rule, for each path, for each depth `d` in `1..len(steps)`: if `steps[d-1].far_types` is `None` or `e.type_name ∈ steps[d-1].far_types`, walk a frontier back from `{e.id}`: for `i = d-1 … 0`, owners of the frontier via `steps[i]` (direction `outgoing` ⇒ owners are SOURCES of incoming rels with `type_name ∈ rel_types`; `incoming` ⇒ owners are TARGETS of outgoing rels), owners filtered by `steps[i-1].far_types` when `i > 0` and by `rule.applies_types` when `i == 0`. Add the final frontier. Over-approximation is safe; too-small is the only hazard.

- [ ] **Step 1: Write the failing tests**

`tests/validation/rules/test_reach.py`:

```python
"""Reverse-reach derivation and dirty-scope expansion.

Keystone: expansion + scoped rerun must equal a full rerun for rule issues.
"""

import random

from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.rules.compile import RuleSetSource, compile_rule_sets
from data_rover.core.validation.rules.reach import derive_paths, expand_scope
from data_rover.core.validation.rules.schema import parse_rule_set
from data_rover.core.validation.rules.validator import RulesValidator
from data_rover.core.validation.scope import Scope


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(name="City"),
            ElementType(
                name="Building",
                properties=[PropertyDef(name="critical", datatype="boolean")],
            ),
            ElementType(
                name="Zone",
                properties=[PropertyDef(name="plan", datatype="string")],
            ),
            ElementType(
                name="Sensor",
                properties=[PropertyDef(name="status", datatype="string")],
            ),
        ],
        relationships=[
            RelationshipType(name="HasBuilding", containment=True,
                             mappings=[Mapping(source="City", target="Building")]),
            RelationshipType(name="Owns", containment=True,
                             mappings=[Mapping(source="Building", target="Zone")]),
            RelationshipType(name="Watches",
                             mappings=[Mapping(source="Zone", target="Sensor")]),
        ],
    )


TWO_HOP = """
rules:
  - name: deep
    applies_to: Building
    then:
      relationship:
        type: Owns
        direction: outgoing
        to: Zone
        exists: true
        where:
          relationship:
            type: Watches
            direction: outgoing
            to: Sensor
            exists: true
            where: {property: status, equals: ok}
"""


def _compiled(mm, doc=TWO_HOP):
    return compile_rule_sets([RuleSetSource("a1", "s", doc)], mm)


def test_derive_paths_shapes():
    rs = parse_rule_set(TWO_HOP)
    paths = derive_paths(rs.rules[0], _mm())
    # one path per relationship atom: depth-1 (Owns) and depth-2 (Owns,Watches)
    assert sorted(len(p.steps) for p in paths) == [1, 2]
    deep = next(p for p in paths if len(p.steps) == 2)
    assert "Owns" in deep.steps[0].rel_types
    assert "Watches" in deep.steps[1].rel_types
    assert deep.steps[1].far_types == frozenset({"Sensor"})


def test_expand_depth1_far_property_change():
    mm = _mm()
    model = Model(mm)
    b = model.create_element("Building")
    z = model.create_element("Zone")
    model.connect("Owns", b.id, z.id)
    extra = expand_scope(model, _compiled(mm), [z.id])
    assert b.id in extra


def test_expand_depth2_sensor_change_reaches_building():
    mm = _mm()
    model = Model(mm)
    b = model.create_element("Building")
    z = model.create_element("Zone")
    s = model.create_element("Sensor")
    model.connect("Owns", b.id, z.id)
    model.connect("Watches", z.id, s.id)
    extra = expand_scope(model, _compiled(mm), [s.id])
    assert b.id in extra


def test_unrelated_element_expands_nothing():
    mm = _mm()
    model = Model(mm)
    model.create_element("Building")
    c = model.create_element("City")
    assert expand_scope(model, _compiled(mm), [c.id]) == []


def test_expansion_scoped_rerun_equals_full_rerun():
    """Random mutations: full rule issues == splice-simulated rule issues."""
    mm = _mm()
    doc = TWO_HOP
    rng = random.Random(7)
    model = Model(mm)
    compiled = _compiled(mm, doc)
    buildings = [model.create_element("Building") for _ in range(8)]
    zones = [model.create_element("Zone") for _ in range(12)]
    sensors = [model.create_element("Sensor") for _ in range(12)]
    for z in zones:
        model.connect("Owns", rng.choice(buildings).id, z.id)
    for s in sensors:
        model.connect("Watches", rng.choice(zones).id, s.id)

    def rule_issue_owners(scope):
        return {
            i.target_ids[0]
            for i in RulesValidator(compiled).validate(model, scope)
        }

    # maintained incrementally, seeded from a full run
    live = rule_issue_owners(Scope.all())

    for _ in range(40):
        s = rng.choice(sensors)
        dirty = [s.id]
        if rng.random() < 0.5:
            model.set_property(s, "status", rng.choice(["ok", "bad"]))
        else:
            model.delete_property(s, "status")
        extra = expand_scope(model, compiled, dirty)
        scoped_ids = list(dict.fromkeys([*dirty, *extra]))
        scoped_owners = rule_issue_owners(Scope(scoped_ids))
        live = (live - set(scoped_ids)) | scoped_owners
        assert live == rule_issue_owners(Scope.all())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/validation/rules/test_reach.py -v`
Expected: FAIL — no `reach` module

- [ ] **Step 3: Implement `reach.py` + wire into `compile.py`**

```python
"""Static reverse-reach: which elements can a mutation's dirty set affect
through user rules?

Each relationship atom in a rule contributes one root-first path of
(rel-type closure, direction, far-type closure) steps. Expansion walks
dirty elements backwards along every path suffix they could sit on and
adds the reached applies_to-typed elements. Over-approximation is safe
(the scoped rerun just revalidates a few extra elements); too-small is
the only correctness hazard.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal
from collections.abc import Iterable

from .schema import (
    AllCond,
    AnyCond,
    Condition,
    NotCond,
    RelationshipCond,
    Rule,
)

if TYPE_CHECKING:
    from ...metamodel.schema import Metamodel
    from ...model.model import Model
    from .compile import CompiledRules


@dataclass(frozen=True)
class ReverseStep:
    rel_types: frozenset[str]
    #: direction as written in the rule: owner -> far
    direction: Literal["outgoing", "incoming"]
    far_types: frozenset[str] | None


@dataclass(frozen=True)
class ReversePath:
    steps: tuple[ReverseStep, ...]  # root-first


def derive_paths(rule: Rule, metamodel: Metamodel) -> list[ReversePath]:
    paths: list[ReversePath] = []

    def walk(cond: Condition, prefix: tuple[ReverseStep, ...]) -> None:
        match cond:
            case AllCond(all=subs) | AnyCond(any=subs):
                for c in subs:
                    walk(c, prefix)
            case NotCond(not_=sub):
                walk(sub, prefix)
            case RelationshipCond(relationship=spec):
                step = ReverseStep(
                    rel_types=metamodel.relationship_descendants(spec.type),
                    direction=spec.direction,
                    far_types=(
                        None if spec.to is None
                        else metamodel.element_descendants(spec.to)
                    ),
                )
                paths.append(ReversePath(steps=(*prefix, step)))
                if spec.where is not None:
                    walk(spec.where, (*prefix, step))
            case _:
                pass  # property atoms reach only the element itself

    for cond in (rule.when, rule.then):
        if cond is not None:
            walk(cond, ())
    return paths


def _owners(model: Model, frontier: set[str], step: ReverseStep) -> set[str]:
    """One reverse hop: the elements whose `step` hop reaches `frontier`."""
    out: set[str] = set()
    for eid in frontier:
        rel_ids = (
            model.indexes.incoming_ids(eid)
            if step.direction == "outgoing"
            else model.indexes.outgoing_ids(eid)
        )
        for rid in rel_ids:
            rel = model.relationships[rid]
            if rel.type_name not in step.rel_types:
                continue
            out.add(rel.source_id if step.direction == "outgoing" else rel.target_id)
    return out


def expand_scope(
    model: Model, compiled: CompiledRules, dirty_ids: Iterable[str]
) -> list[str]:
    if not compiled.rules:
        return []
    extra: dict[str, None] = {}
    dirty_elements = [
        el for eid in dirty_ids if (el := model.elements.get(eid)) is not None
    ]
    for cr in compiled.rules:
        for path in cr.paths:
            steps = path.steps
            for d in range(1, len(steps) + 1):
                far = steps[d - 1].far_types
                seeds = {
                    el.id for el in dirty_elements
                    if far is None or el.type_name in far
                }
                if not seeds:
                    continue
                frontier = seeds
                for i in range(d - 1, -1, -1):
                    frontier = _owners(model, frontier, steps[i])
                    gate = steps[i - 1].far_types if i > 0 else cr.applies_types
                    if gate is not None:
                        frontier = {
                            fid for fid in frontier
                            if (fel := model.elements.get(fid)) is not None
                            and fel.type_name in gate
                        }
                    if not frontier:
                        break
                for fid in sorted(frontier):
                    extra[fid] = None
    return list(extra)
```

In `compile.py`: add `paths: tuple[ReversePath, ...] = ()` to `CompiledRule`, and in `compile_rule_sets` build `paths=tuple(derive_paths(rule, metamodel))` (import `derive_paths` from `.reach` at module top — no cycle: `reach` does not import `compile` at runtime, only under `TYPE_CHECKING`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/validation/rules/ -v`
Expected: all PASS

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint
git add -A src/data_rover/core/validation/rules tests/validation/rules
git commit -m "feat(rules): reverse-reach derivation and dirty-scope expansion"
```

---

### Task 5: Register the `validation_rules` artifact kind

**Files:**
- Modify: `src/data_rover/api/db_models.py` (~:301-306, `ArtifactKind` members)
- Modify: `src/data_rover/api/schemas.py` (~:318-325, `CreateArtifactOp.artifact_kind` Literal)
- Modify: `src/data_rover/api/artifact_kinds.py` (`_REGISTRY`)
- Test: `tests/api/test_rules_artifacts.py`; Modify: `tests/api/test_artifact_kinds.py` (registry contract additions if the file loops over kinds)

**Interfaces:**
- Consumes: Task 1 (`RULES_ADAPTER`).
- Produces: `ArtifactKind.validation_rules = "validation_rules"` (16 chars, fits VARCHAR(32), no migration); registry entry `ArtifactKindSpec(kind=ArtifactKind.validation_rules, adapter=RULES_ADAPTER)`; `"validation_rules"` added to `CreateArtifactOp.artifact_kind`'s Literal.

- [ ] **Step 1: Write the failing tests**

`tests/api/test_rules_artifacts.py` (use the existing conftest idioms — `client` fixture, `seed_default_project`, `AUTH_HEADERS`, `papi` helper for project-scoped paths; copy the header of a neighboring artifact-route test for exact usage):

```python
"""The validation_rules artifact kind: save-time validation, drift tolerance."""

GOOD_YAML = (
    "rules:\n"
    "  - name: has-name\n"
    "    applies_to: Building\n"
    "    then: {property: name, exists: true}\n"
)


def _payload(yaml_text: str) -> dict:
    return {"schema_version": 1, "yaml": yaml_text}


def test_create_and_roundtrip(client, seed_default_project, papi):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "validation_rules", "name": "house-rules",
              "payload": _payload(GOOD_YAML)},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    got = client.get(papi(f"/artifacts/{aid}"), headers=AUTH_HEADERS).json()
    assert got["payload"]["yaml"] == GOOD_YAML  # verbatim text, comments-safe


def test_unparseable_yaml_422_at_save(client, seed_default_project, papi):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "validation_rules", "name": "bad",
              "payload": _payload("rules: [")},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_schema_violation_422_at_save(client, seed_default_project, papi):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "validation_rules", "name": "bad2",
              "payload": _payload("rules:\n  - name: r\n    applies_to: B\n")},
        headers=AUTH_HEADERS,  # missing `then`
    )
    assert r.status_code == 422


def test_metamodel_drift_saves_fine(client, seed_default_project, papi):
    drifted = GOOD_YAML.replace("Building", "NoSuchStereotype")
    r = client.post(
        papi("/artifacts"),
        json={"kind": "validation_rules", "name": "drifted",
              "payload": _payload(drifted)},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200  # drift is degradation, not invalidity


def test_commit_op_create_accepts_kind(client, seed_default_project, papi):
    r = client.post(
        papi("/commits"),
        json={"base_rev": 0, "message": "add rules", "locks": [], "ops": [
            {"kind": "create_artifact", "temp_id": "tmp_1",
             "artifact_kind": "validation_rules", "name": "via-commit",
             "payload": _payload(GOOD_YAML)},
        ]},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
```

Adjust imports/fixtures to match `tests/api/conftest.py` exactly (`AUTH_HEADERS` import, `papi` signature, commit body shape — copy from an existing `POST /commits` artifact test such as the exporter ones; the seeded default project must have a metamodel containing a `Building` type or the drift test's GOOD case must use a type from the seeded metamodel — check what `seed_default_project` seeds and use one of its real type names throughout).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_rules_artifacts.py -v`
Expected: FAIL — 422 "artifact kind 'validation_rules' is not supported yet" / enum ValueError

- [ ] **Step 3: Implement**

`db_models.py` — add to `ArtifactKind`:

```python
validation_rules = "validation_rules"
```

`schemas.py` — extend `CreateArtifactOp.artifact_kind` Literal with `"validation_rules"`.

`artifact_kinds.py` — import and register:

```python
from data_rover.core.validation.rules.schema import RULES_ADAPTER
...
ArtifactKind.validation_rules: ArtifactKindSpec(
    kind=ArtifactKind.validation_rules, adapter=RULES_ADAPTER
),
```

Check `tests/api/test_artifact_kinds.py` for loops asserting the registered set; extend them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_rules_artifacts.py tests/api/test_artifact_kinds.py -v`
Expected: all PASS

- [ ] **Step 5: Lint + commit**

```bash
pixi run backend-lint
git add -A src/data_rover/api tests/api
git commit -m "feat(rules): register the validation_rules artifact kind"
```

---

### Task 6: Session cache + `api/rules.py` + sweep/seed wiring

**Files:**
- Create: `src/data_rover/api/rules.py`
- Modify: `src/data_rover/api/session.py` (add `compiled_rules` field)
- Modify: `src/data_rover/api/hydration.py` (read rule rows in the DB block; compile after metamodel build)
- Modify: `src/data_rover/api/validation_sweep.py` (:97 pipeline; per-chunk staleness check)
- Modify: `src/data_rover/api/routes/ops.py` (`_ensure_validation_seeded`, :460)
- Test: `tests/api/test_rules_session.py`

**Interfaces:**
- Consumes: Tasks 2-5.
- Produces (in `api/rules.py`):
  - `session_pipeline(session: Session) -> ValidationPipeline` — `ValidationPipeline([*default_validators(), RulesValidator(session.compiled_rules)])`
  - `load_compiled_rules(db, project_id: str, metamodel: Metamodel) -> CompiledRules` — `content.list_artifacts(db, project_id, ArtifactKind.validation_rules)` → `RuleSetSource(row.id, row.name, str(row.payload.get("yaml", "")))` → `compile_rule_sets`
  - `expand_dirty(session: Session, model: Model, dirty: DirtyCollector) -> None` — `dirty.update(expand_scope(model, session.compiled_rules, list(dirty.ids)))`
  - `rules_touched(db, artifact_ops: Sequence[ArtifactOpIn], art_res: ArtifactBatchResult | None) -> bool` — True if any create op has `artifact_kind == "validation_rules"`, any `art_res.deleted` header has `kind == "validation_rules"`, or any id in `art_res.changed_ids` resolves (via `content.get_artifact`) to a `validation_rules` row
  - `applies_population(model: Model, *compiled: CompiledRules) -> list[str]` — element ids whose `type_name ∈ applies_type_names(*compiled)`, via `model.indexes.elements_by_type` (exact-name keyed — `applies_type_names` closures are already subtype-expanded), sorted per type for determinism
- On `Session`: `compiled_rules: CompiledRules = field(default_factory=empty_compiled, repr=False)`.

- [ ] **Step 1: Write the failing tests**

`tests/api/test_rules_session.py` — cover, using conftest idioms (upload/seed a metamodel with known types, e.g. via the same seeding the other API tests use):

```python
"""Session-level rule compilation: hydration, seeding, sweep inclusion."""

# 1) test_session_pipeline_includes_rules_validator:
#    build a Session with a model + compiled rules (compile_rule_sets directly),
#    assert session_pipeline(session).validate(model, Scope.all()) contains a
#    check == "rule:<name>" issue for a violating element.
# 2) test_empty_rules_pipeline_matches_default:
#    with empty_compiled(), session_pipeline output == default_pipeline output
#    on the same model (byte-identical issue lists).
# 3) test_ensure_validation_seeded_includes_rule_issues:
#    seed default project, POST a validation_rules artifact via /commits (or
#    legacy POST /artifacts + session touch), create a violating element via
#    /model/ops, then GET /model/issues and assert a "rule:" check appears.
# 4) test_hydration_compiles_rules:
#    seed a project WITH a committed rules artifact, evict/discard the session
#    (SessionRegistry.evict or the registry test helpers used by
#    tests/api/test_hydration*.py), re-open, GET /model/issues -> rule issue
#    present without any Validate click.
# 5) test_applies_population_and_rules_touched: unit-level over helpers.
```

Write these as real tests following the closest existing patterns: `tests/api/test_hydration*.py` for evict/rehydrate, `tests/api/test_issues_route.py` for issue assertions. Rule YAML used throughout: a `property exists` rule violated by an element created without that property — use type/property names from the seeded metamodel.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_rules_session.py -v`
Expected: FAIL — no `api/rules.py`, no `compiled_rules` field

- [ ] **Step 3: Implement**

`api/rules.py`:

```python
"""Rules-aware validation plumbing: the ONE place the API layer builds
pipelines and widens dirty scopes for user-defined rules.

Thread-safety: CompiledRules is cached on the Session and swapped
atomically (never mutated in place); validators are built fresh per run
(pipeline validators carry mutable memo caches — see default_pipeline's
docstring)."""

from __future__ import annotations

from typing import TYPE_CHECKING
from collections.abc import Sequence

from data_rover.core.validation.pipeline import ValidationPipeline, default_validators
from data_rover.core.validation.rules.compile import (
    CompiledRules,
    RuleSetSource,
    applies_type_names,
    compile_rule_sets,
    empty_compiled,
)
from data_rover.core.validation.rules.reach import expand_scope
from data_rover.core.validation.rules.validator import RulesValidator

from . import content
from .db_models import ArtifactKind

if TYPE_CHECKING:
    from sqlalchemy.orm import Session as DbSession

    from data_rover.core.metamodel.schema import Metamodel
    from data_rover.core.model.model import Model
    from data_rover.core.validation.dirty import DirtyCollector

    from .artifact_ops import ArtifactBatchResult
    from .schemas import ArtifactOpIn
    from .session import Session

RULES_KIND_VALUE = ArtifactKind.validation_rules.value


def session_pipeline(session: Session) -> ValidationPipeline:
    return ValidationPipeline(
        [*default_validators(), RulesValidator(session.compiled_rules)]
    )


def rule_sources(db: DbSession, project_id: str) -> list[RuleSetSource]:
    rows = content.list_artifacts(db, project_id, ArtifactKind.validation_rules)
    return [
        RuleSetSource(row.id, row.name, str(row.payload.get("yaml", "")))
        for row in rows
    ]


def load_compiled_rules(
    db: DbSession, project_id: str, metamodel: Metamodel | None
) -> CompiledRules:
    if metamodel is None:
        return empty_compiled()
    return compile_rule_sets(rule_sources(db, project_id), metamodel)


def expand_dirty(session: Session, model: Model, dirty: DirtyCollector) -> None:
    extra = expand_scope(model, session.compiled_rules, list(dirty.ids))
    if extra:
        dirty.update(extra)


def rules_touched(
    db: DbSession,
    artifact_ops: Sequence[ArtifactOpIn],
    art_res: ArtifactBatchResult | None,
) -> bool:
    from .schemas import CreateArtifactOp  # local: schemas imports are heavy

    for op in artifact_ops:
        if isinstance(op, CreateArtifactOp) and op.artifact_kind == RULES_KIND_VALUE:
            return True
    if art_res is None:
        return False
    for header in art_res.deleted:
        if header.get("kind") == RULES_KIND_VALUE:
            return True
    for aid in art_res.changed_ids:
        row = content.get_artifact(db, aid)
        if row is not None and row.kind is ArtifactKind.validation_rules:
            return True
    return False


def applies_population(model: Model, *compiled: CompiledRules) -> list[str]:
    out: dict[str, None] = {}
    for type_name in sorted(applies_type_names(*compiled)):
        for eid in sorted(model.indexes.elements_by_type.get(type_name, ())):
            out[eid] = None
    return list(out)
```

`session.py`: add field (import `CompiledRules`, `empty_compiled` from core):

```python
#: compiled user-defined validation rules — immutable-swap cache; rebuilt at
#: hydration, on rules-artifact commits, and on metamodel rebind
compiled_rules: CompiledRules = field(default_factory=empty_compiled, repr=False)
```

`hydration.py` (`_hydrate_session`): inside the `with db_session() as s:` block (after the view read), collect `sources = rules.rule_sources(s, project_id)` (import `from . import rules` — check for import cycles; if `api/rules.py` importing `content` creates none, this is fine). After `session = Session(metamodel=metamodel, model=model)`: `session.compiled_rules = compile_rule_sets(sources, metamodel)` — BEFORE `start_validation_sweep(session)`.

`validation_sweep.py` `_run`: replace `pipeline = default_pipeline()` with:

```python
from .rules import session_pipeline  # top of module, replacing default_pipeline import
...
compiled = session.compiled_rules
pipeline = session_pipeline(session)
```

and inside the per-chunk `with session.write_mutex:` block, after the state/model guards:

```python
if session.compiled_rules is not compiled:
    # a commit swapped the rules mid-sweep: rebuild so later chunks
    # don't splice stale rule verdicts over the commit's fresh ones
    compiled = session.compiled_rules
    pipeline = session_pipeline(session)
```

`ops.py` `_ensure_validation_seeded` (:460): `state.set_full(session_pipeline(session).validate(model, Scope.all()))` (import from `..rules`; watch the relative path — routes are one package deeper: `from ..rules import session_pipeline`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_rules_session.py tests/api/test_issues_route.py tests/api/test_hydration.py -v` (adjust to real hydration-test filenames)
Expected: all PASS; then `pixi run core-test` for a full-suite sanity pass.

- [ ] **Step 5: Lint + commit**

```bash
pixi run backend-lint
git add -A src/data_rover/api tests/api
git commit -m "feat(rules): session-cached compiled rules, hydration + sweep + seed wiring"
```

---

### Task 7: Commit-path wiring (create, preview, revert)

**Files:**
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_rules_commit_flow.py`

**Interfaces:**
- Consumes: Task 6 helpers (`session_pipeline`, `expand_dirty`, `rules_touched`, `load_compiled_rules`, `applies_population`, `compile_rule_sets` via sources for rebind previews).
- Produces: live rule issues across the whole check-out/commit flow.

**Wiring (locate by code shape, not line numbers):**

1. **`create_commit`** — at the hook point between the view half (`unwind.view_res = view_res`) and `rebound = ...`:

```python
touched_rules = rules_touched(db, artifact_ops, art_res)
prior_compiled = session.compiled_rules
if rebound_pending or touched_rules:      # rebound_pending: mm_res is not None and mm_res.rebound
    unwind.prior_compiled = prior_compiled
    session.compiled_rules = load_compiled_rules(db, project_id, model.metamodel)
```

(Compute `rebound` before this block or reuse the existing `mm_res` check; keep the existing `rebound = ...` line's semantics unchanged.) Then, in the non-rebound validate branch, BEFORE `scoped = ...`:

```python
expand_dirty(session, model, res.dirty)
if touched_rules:
    res.dirty.update(
        applies_population(model, prior_compiled, session.compiled_rules)
    )
scoped = session_pipeline(session).validate(model, res.dirty.to_scope())
```

The rebound branch just swaps `default_pipeline()` → `session_pipeline(session)` (already full-scope). `state.replace(res.dirty.ids, scoped)` stays untouched — the widened `dirty` flows through the live `KeysView`.

2. **`_CommitUnwind`** — add field `prior_compiled: CompiledRules | None = None`; in its rollback path restore `session.compiled_rules = self.prior_compiled` when not None (find the class near the top of commits.py; mirror how it restores the prior metamodel).

3. **`preview_commit`** — replace `default_pipeline()`:

```python
if candidate is not None:
    compiled = compile_rule_sets(session.compiled_rules.sources, candidate)
    pipeline = ValidationPipeline([*default_validators(), RulesValidator(compiled)])
    scoped = pipeline.validate(model, Scope.all())
else:
    expand_dirty(session, model, res.dirty)
    scoped = session_pipeline(session).validate(model, res.dirty.to_scope())
```

(Preview never mutates `session.compiled_rules`. A previewed rules-artifact edit is only dry-validated, so preview reflects committed rules — document with a one-line comment.)

4. **`revert_commit`** — swap to `session_pipeline(session)` + `expand_dirty(session, model, res.dirty)` before the validate (revert is model-only: artifact ops 409 before this point, so no recompile needed).

- [ ] **Step 1: Write the failing tests**

`tests/api/test_rules_commit_flow.py` — following the existing commit-flow test idioms (lock acquisition via `POST /locks`, `POST /commits` bodies — copy setup from an existing commits test):

The keystone liveness test, in full (adapt fixture/helper names and the
seeded metamodel's type/relationship/property names to what
`tests/api/conftest.py` actually seeds — copy the commit-body shape from an
existing `POST /commits` test in `tests/api/test_commits*.py`, including how
those tests acquire locks and pass `base_rev`):

```python
RULE_YAML = (
    "rules:\n"
    "  - name: owner-has-planned-child\n"
    "    applies_to: <ParentType>\n"          # a real seeded type
    "    then:\n"
    "      relationship:\n"
    "        type: <ContainmentRel>\n"        # a real seeded rel type
    "        direction: outgoing\n"
    "        exists: true\n"
    "        where: {property: <prop>, exists: true}\n"
)


def test_commit_far_edit_refreshes_rule_issue(client, seed_default_project, papi):
    # commit 1: the rule artifact + a satisfying parent/child pair
    r = _commit(client, papi, ops=[
        _create_rules_artifact_op(RULE_YAML),
        {"kind": "create_element", "temp_id": "tmp_p", "type_name": "<ParentType>"},
        {"kind": "create_element", "temp_id": "tmp_c", "type_name": "<ChildType>",
         "properties": {"<prop>": "set"}},
        {"kind": "create_relationship", "temp_id": "tmp_r",
         "type_name": "<ContainmentRel>", "source_id": "tmp_p", "target_id": "tmp_c"},
    ])
    assert r.status_code == 200, r.text
    body = r.json()
    parent_id = body["id_map"]["tmp_p"]; child_id = body["id_map"]["tmp_c"]
    assert not [i for i in body["issues_added"] if i["check"].startswith("rule:")]

    # commit 2: unset the FAR element's property -> the rule issue appears,
    # owned by the PARENT (proves expand_dirty reached across the hop)
    r2 = _commit(client, papi, base_rev=body["model_rev"], ops=[
        {"kind": "update_element", "id": child_id,
         "properties_patch": {"<prop>": None}},
    ])
    added = [i for i in r2.json()["issues_added"] if i["check"].startswith("rule:")]
    assert added and added[0]["target_ids"] == [parent_id]

    # commit 3: restore it -> the parent's rule issue is dropped
    r3 = _commit(client, papi, base_rev=r2.json()["model_rev"], ops=[
        {"kind": "update_element", "id": child_id,
         "properties_patch": {"<prop>": "back"}},
    ])
    assert parent_id in r3.json()["issues_removed_owner_ids"]
```

(`_commit` / `_create_rules_artifact_op` are small local helpers wrapping the
commit body + lock acquisition idiom copied from the neighboring commit
tests; the exact op field names above must be checked against `schemas.py`'s
`ModelOpIn` members and corrected if they differ.)

Remaining tests, same file:

```python
# 2) test_commit_rule_artifact_edit_revalidates_population:
#    commit an update_artifact changing the rule set -> new rule issues appear
#    for pre-existing violating elements in the same CommitResponse.
# 3) test_commit_rule_artifact_delete_drops_issues:
#    delete_artifact op -> previously reported rule issues disappear
#    (issues_removed_owner_ids covers the affected owners; GET /model/issues
#    confirms).
# 4) test_rule_issue_never_blocks_commit:
#    strict_mode off AND a rule with severity error: commit that violates it
#    returns 200 (conformance never blocks); with session.strict_mode True the
#    existing strict gate DOES count it (assert whichever the current strict
#    gate semantics produce — read the strict gate in commits.py and pin it).
# 5) test_preview_reports_rule_issues_without_side_effects:
#    POST /commits/preview with a violating op batch -> issues include rule:*,
#    conformance_error_count counts it, structural_blockers empty; model_rev
#    unchanged; a second identical preview returns the same.
# 6) test_undo_after_rules_commit (placed here or Task 8): skip — Task 8.
```

Write each as a real test; the rule YAML fixtures and element types must come from the metamodel the conftest seeds.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_rules_commit_flow.py -v`
Expected: FAIL — rule issues absent from commit responses (splice not wired)

- [ ] **Step 3: Implement the wiring** (as specified above)

- [ ] **Step 4: Run tests + the whole commits suite**

Run: `pixi run -e core-dev pytest tests/api/test_rules_commit_flow.py tests/api/test_commits*.py -v`
Expected: all PASS

- [ ] **Step 5: Lint + commit**

```bash
pixi run backend-lint
git add -A src/data_rover/api tests/api
git commit -m "feat(rules): rules-aware commit, preview and revert validation"
```

---

### Task 8: Remaining validation call sites (ops/undo, CR, validate route, metamodel diff)

**Files:**
- Modify: `src/data_rover/api/routes/ops.py` (`_finalize`, undo's artifact half)
- Modify: `src/data_rover/api/routes/change_request.py` (`_apply_cr_session`)
- Modify: `src/data_rover/api/routes/validation.py` (staged + full branches)
- Modify: `src/data_rover/api/routes/metamodel_swap.py` (candidate diff)
- Test: `tests/api/test_rules_callsites.py`

**Interfaces:** consumes Task 6 helpers only; no new surface.

**Wiring:**

1. `ops.py::_finalize`: before the validate — `expand_dirty(session, model, res.dirty)`; pipeline → `session_pipeline(session)`.
2. `ops.py::undo`: after the artifact half (`art_res = apply_artifact_ops(...)`) and before `_finalize`:

```python
if rules_touched(db, art_inv, art_res):
    prior = session.compiled_rules
    session.compiled_rules = load_compiled_rules(db, project_id, model.metamodel)
    res.dirty.update(applies_population(model, prior, session.compiled_rules))
```

(match the actual local names for the inverse artifact op list; `_finalize`'s `expand_dirty` then also runs.)
3. `change_request.py::_apply_cr_session`: after `dirty = change_request_dirty_ids(base, result, cr)`:

```python
dirty = list(
    dict.fromkeys(
        [*dirty, *expand_scope(result, session.compiled_rules, dirty)]
    )
)
delta = state.replace(dirty, session_pipeline(session).validate(result, Scope(dirty)))
```

(`expand_scope` imported from core via `api.rules` re-export or directly; keep `_apply_cr_inline` on `default_pipeline()` — it validates a caller-supplied model with no session rules; add a one-line comment.)
4. `validation.py::validate_model`: staged branch — `expand_dirty` + `session_pipeline`; full branch (:193) — `session_pipeline(session)`. Inline branch (:125) stays `default_pipeline()` with a comment (candidate model, not the session's).
5. `metamodel_swap.py` (:79 diff candidate validation):

```python
compiled = compile_rule_sets(session.compiled_rules.sources, candidate)
pipeline = ValidationPipeline([*default_validators(), RulesValidator(compiled)])
candidate_issues = pipeline.validate(...)
```

so the diff's now_failing/now_passing include rule flips under the candidate schema; the current side uses `session_pipeline(session)`.

- [ ] **Step 1: Write failing tests** (`tests/api/test_rules_callsites.py`)

```python
# 1) test_legacy_ops_path_keeps_rule_issues_live:
#    POST /model/ops with an op that violates a committed rule via a FAR
#    element edit -> OpsResponse.issues_added carries the rule issue for the
#    owning element (proves expand_dirty in _finalize).
# 2) test_undo_of_rules_artifact_commit_restores_rules:
#    commit creating a rules artifact (rule now live), POST /model/undo ->
#    rule issues gone from GET /model/issues; undo again (redo-ish inverse
#    if applicable) not required.
# 3) test_validate_full_includes_rules:
#    POST /model/validate {} -> response contains rule:* issues.
# 4) test_metamodel_diff_shows_rule_flips:
#    POST /metamodel/diff with a candidate that renames the rule's applies_to
#    type -> the rule's issues appear in now_passing (or the drift causes
#    them to vanish — pin the actual semantics: compiled-against-candidate
#    skips the drifted rule, so its issues land in now_passing).
# 5) test_apply_cr_session_rule_liveness:
#    session-mode apply-cr changing a far element -> issue list refreshed
#    (GET /model/issues), owner correct.
```

- [ ] **Step 2: Run to verify failure**, **Step 3: implement**, **Step 4: run to pass** (same commands pattern as Task 7; also run `pixi run core-test` in full).

- [ ] **Step 5: Lint + commit**

```bash
pixi run backend-lint
git add -A src/data_rover/api tests/api
git commit -m "feat(rules): rules-aware validation on ops, undo, CR and diff paths"
```

---

### Task 9: `rules_status` + `POST /rules/lint`

**Files:**
- Modify: `src/data_rover/api/schemas.py` (add `RuleSkipOut`, `RulesStatusOut`, extend `IssueListOut`; add `RulesLintRequest`, `RuleWarningOut`, `RulesLintResponse`)
- Modify: `src/data_rover/api/routes/validation.py` (`list_issues` builds `rules_status`)
- Create: `src/data_rover/api/routes/rules.py` (lint route)
- Modify: `src/data_rover/api/main.py` (mount the router under the project prefix)
- Test: `tests/api/test_rules_lint.py`, extend `tests/api/test_issues_route.py`

**Interfaces:**
- Produces (wire schemas):

```python
class RuleSkipOut(BaseModel):
    artifact_id: str
    set_name: str
    rule: str          # "" when the whole set failed to parse
    reason: str

class RulesStatusOut(BaseModel):
    total: int                                  # active compiled rules
    skipped: list[RuleSkipOut] = Field(default_factory=list)
    eval_errors: dict[str, int] = Field(default_factory=dict)

# IssueListOut gains:
    rules_status: RulesStatusOut | None = None

class RulesLintRequest(BaseModel):
    yaml: str

class RuleWarningOut(BaseModel):
    rule: str
    message: str

class RulesLintResponse(BaseModel):
    ok: bool
    errors: list[LintErrorOut] = Field(default_factory=list)
    warnings: list[RuleWarningOut] = Field(default_factory=list)
```

- Route: `POST /api/v1/projects/{project_id}/rules/lint` — body `RulesLintRequest`; NOT added to `authz._READ_ONLY_POST_SUFFIXES` (viewers 403 like `/metamodel/lint`); always 200 for editors.

- [ ] **Step 1: Write failing tests**

`tests/api/test_rules_lint.py`:

```python
# 1) test_lint_ok: valid YAML vs the seeded metamodel -> {ok: true, errors: [],
#    warnings: []}.
# 2) test_lint_yaml_error_carries_line: "rules: [" -> ok false, errors[0].line
#    is an int (from problem_mark), message non-empty.
# 3) test_lint_schema_error_message_only: missing `then` -> ok false, message
#    mentions the rule; line may be None.
# 4) test_lint_drift_is_warning_not_error: unknown stereotype -> ok TRUE,
#    warnings[0].rule == the rule name, reason mentions the name.
# 5) test_lint_viewer_403: request with a viewer-role member -> 403 (mirror
#    the metamodel-lint viewer test's fixture pattern).
# Extend test_issues_route.py: after committing a drifted rules artifact,
# GET /model/issues -> rules_status.total == 0, skipped has one entry;
# with a clean artifact -> total == 1, skipped == [].
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

`routes/rules.py`:

```python
"""Rules lint: parse + schema + drift check for the editor's debounced calls.

Sibling of POST /metamodel/lint: always 200, cheap (no model iteration, no
write_mutex), deliberately NOT in the read-only-POST allowlist — only the
editing flow lints, and viewers have nothing to lint."""

from __future__ import annotations

import yaml
from fastapi import APIRouter, Depends

from data_rover.core.validation.rules.compile import RuleSetSource, compile_rule_sets
from data_rover.core.validation.rules.schema import RuleSetError, parse_rule_set

from ..deps import get_request_session
from ..schemas import (
    LintErrorOut,
    RulesLintRequest,
    RulesLintResponse,
    RuleWarningOut,
)
from ..session import Session

router = APIRouter()


@router.post("/rules/lint")
def lint_rules(
    payload: RulesLintRequest,
    session: Session = Depends(get_request_session),
) -> RulesLintResponse:
    try:
        parse_rule_set(payload.yaml)
    except RuleSetError as exc:
        cause = exc.__cause__
        mark = getattr(cause, "problem_mark", None)
        return RulesLintResponse(
            ok=False,
            errors=[
                LintErrorOut(
                    message=str(exc),
                    line=mark.line + 1 if mark is not None else None,
                    column=mark.column + 1 if mark is not None else None,
                )
            ],
        )
    warnings: list[RuleWarningOut] = []
    if session.metamodel is not None:
        compiled = compile_rule_sets(
            [RuleSetSource("draft", "draft", payload.yaml)], session.metamodel
        )
        warnings = [
            RuleWarningOut(rule=d.rule, message=d.reason) for d in compiled.skipped
        ]
    return RulesLintResponse(ok=True, warnings=warnings)
```

(`parse_rule_set` chains the original `yaml.YAMLError` as `__cause__`, which carries `problem_mark` — that is where line/column come from. The `yaml` import may end up unused; drop it if so.)

`routes/validation.py::list_issues` — under the existing mutex block, read `compiled = session.compiled_rules` and build:

```python
rules_status = RulesStatusOut(
    total=compiled.total,
    skipped=[
        RuleSkipOut(artifact_id=d.artifact_id, set_name=d.set_name,
                    rule=d.rule, reason=d.reason)
        for d in compiled.skipped
    ],
    eval_errors=dict(compiled.eval_errors),
)
```

and pass `rules_status=rules_status` into `IssueListOut`.

`main.py`: `app.include_router(rules_routes.router, prefix=proj, tags=["rules"])` beside the other project-scoped routers.

- [ ] **Step 4: Run to pass** — `pixi run -e core-dev pytest tests/api/test_rules_lint.py tests/api/test_issues_route.py -v`, then full `pixi run core-test`.

- [ ] **Step 5: Lint + commit**

```bash
pixi run backend-lint
git add -A src/data_rover/api tests/api
git commit -m "feat(rules): rules_status on issues and POST /rules/lint"
```

---

### Task 10: Frontend kind registration sweep

**Files (all under `frontend/`):**
- Modify: `src/lib/artifacts/kinds.ts` (REGISTERED_KINDS + KIND_ICONS + KIND_LABEL)
- Modify: `src/lib/state/artifacts.svelte.ts` (:120-125 `NAME_CLASH_LABEL`)
- Modify: `src/lib/components/DiffDrawer.svelte` (:146-151 `ARTIFACT_KIND_LABEL`)
- Modify: `src/lib/components/Sidebar/ArtifactsSection.svelte` (:36-72 `SECTIONS` + `collapsed`)
- Modify: `src/lib/components/Sidebar/TreeRow.svelte` (:228-244 per-kind dispatch)
- Modify: `src/lib/components/ExportArtifactsDialog.svelte` (:23-28 `SECTIONS`)
- Modify: `src/lib/state/unsaved.ts` (:62-89 kind unions/prefix map)
- Modify: `src/lib/state/workspace.svelte.ts` (`DynamicTab.kind` union + `PREFIX` + `openArtifactTab` kind union)
- Modify: `src/lib/components/Workspace.svelte` (pane switch + close dispatch)
- Test: `src/lib/artifacts/__tests__/kinds.test.ts` (auto-covers via loop), `src/lib/state/__tests__/workspace.test.ts`

**Interfaces:**
- Produces: kind id `'validation_rules'`, label `'Rules'` (`NAME_CLASH_LABEL`/DiffDrawer lowercase: `'rule set'`), icon `ShieldCheck` from `@lucide/svelte`, tab kind `'rules'` with prefix `'rules'`, section title `'Rules'` / singular `'Rule set'`.
- The Workspace pane renders `RulesTab` (created in Task 11 — for THIS task, wire the switch to a placeholder import so typecheck drives Task 11's file into existence: create a minimal `src/lib/components/Rules/RulesTab.svelte` rendering `<div data-testid="rules-tab">` with a `tabId` prop; Task 11 fills it in).

- [ ] **Step 1: Extend the failing/guarding tests first** — add `'validation_rules'` to any test that pins the kind roster (`kinds.test.ts` loops automatically; `workspace.test.ts` add a case opening a `rules` tab and asserting id prefix + dedupe-by-artifactId). Run `pixi run frontend-test` and `pixi run frontend-check`; expected: type errors across the `Record<ArtifactKind, …>` sites — that IS the checklist. Fix every site the compiler names (they match the Files list above).

- [ ] **Step 2: Implement the sweep** — mechanical edits at each listed site following the exact per-site pattern of `exporter` (search each file for `exporter` and mirror). `closeRulesDraft` in Workspace.svelte's close dispatch: stub as a no-op import from Task 11's state module — create `src/lib/state/rules-editor.svelte.ts` with the exported function signatures as no-op stubs (`ensureRulesDraft`, `closeRulesDraft`, `resetRulesEditors`) so wiring compiles; Task 11 fills them.

- [ ] **Step 3: Run to pass**

Run: `pixi run frontend-test` and `pixi run frontend-check`
Expected: PASS, no type errors

- [ ] **Step 4: Commit**

```bash
git add -A frontend/src
git commit -m "feat(rules-ui): register the validation_rules kind across the frontend"
```

---

### Task 11: Rules editor tab (state + component + lint client)

**Files (all under `frontend/`):**
- Modify: `src/lib/api/validation.ts` OR create `src/lib/api/rules.ts` — add `lintRules(yaml: string): Promise<RulesLint>` posting JSON `{yaml}` to `/rules/lint` (mirror `lintMetamodel` in `src/lib/api/metamodel.ts:65-74`, but JSON body) + zod schemas `RulesLintSchema` (`{ok, errors: [{message, line, column}], warnings: [{rule, message}]}`)
- Modify: `src/lib/components/Metamodel/MetamodelYamlEditor.svelte` — add optional `testid: string = 'metamodel-editor'` prop (host div `data-testid={testid}`); no other change
- Fill in: `src/lib/state/rules-editor.svelte.ts` (stubbed in Task 10)
- Fill in: `src/lib/components/Rules/RulesTab.svelte`
- Modify: `src/lib/state/index.ts` (re-export block, mirroring the snippet block at :415-425)
- Test: `src/lib/state/__tests__/rules-editor.test.ts`, `src/lib/components/__tests__/RulesTab.test.ts`

**Interfaces:**
- `rules-editor.svelte.ts` exports (mirror `snippet-editor.svelte.ts`'s family exactly — same draft map keyed by tabId, same lease flow):
  - `interface RulesDraft { name: string; artifactId: string | null; yaml: string; dirty: boolean; lintErrors: LintError[]; lintWarnings: {rule: string; message: string}[] }`
  - `ensureRulesDraft(tabId: string): Promise<RulesDraft>` — draft tabs (`rules:draft:` prefix / temp ids) start empty with a starter template comment; existing artifacts `acquireArtifactLease(id, 'edit')` then `artifactsApi.getArtifact(id)` and read `payload.yaml`
  - `editRulesDraft(tabId: string, yaml: string): void` — sets dirty, schedules debounced `lintRules` (500 ms, mirror `METAMODEL_LINT_DEBOUNCE_MS`)
  - `saveRulesDraft(tabId: string): void` — payload `{schema_version: 1, yaml: draft.yaml}`; `assertNoNameClash('validation_rules', ...)`; `stageArtifactCreate('validation_rules', name, payload, tabId)` for new / `stageArtifactUpdate(id, {name, payload})` for existing (copy `saveSnippetDraft`'s shape at snippet-editor:456-476, including `repointTabArtifact`)
  - `getRulesDraft`, `getRulesLockHolder`, `retryRulesLock`, `hasDirtyRulesDrafts`, `closeRulesDraft` (release lease via `releaseArtifactIfUnneeded` when non-temp), `resetRulesEditors`
  - wire `hasDirtyRulesDrafts` into `state/unsaved.ts`'s `hasUnsavedWork`
- `RulesTab.svelte`: name input + Save button (`data-testid="rules-save"`, disabled while lease-locked, label `Save{dirty ? ' *' : ''}`), lock-holder banner (copy SnippetTab's), the reused `MetamodelYamlEditor` with `testid="rules-editor"`, `errors={draft.lintErrors}`, `onChange` → `editRulesDraft`, and a warnings strip listing `lintWarnings` (`data-testid="rules-drift-warnings"`).

- [ ] **Step 1: Write the failing tests** — `rules-editor.test.ts` mirrors `snippet-editor.test.ts`'s structure (spy on `$lib/api/artifacts`, `$lib/api/checkout`, and the new lint client): draft lifecycle (ensure → edit → dirty → save stages create op with kind `validation_rules` and payload `{schema_version, yaml}`), lease-denied path records lock holder, debounced lint populates `lintErrors`/`lintWarnings` (use `vi.useFakeTimers()`), close releases the lease. `RulesTab.test.ts` mirrors a slim SnippetTab component test: renders editor + Save, Save calls the staged path, drift warnings strip renders.

- [ ] **Step 2: Run to verify failure** — `pixi run frontend-test -- rules-editor` (vitest filter), expected FAIL.

- [ ] **Step 3: Implement** the state module + component + client per the interface block; keep every function a structural copy of the snippet-editor counterpart (including the known `ensure*Draft` close-race pattern — F-12 is fixed family-wide separately; do NOT invent a local fix).

- [ ] **Step 4: Run to pass** — `pixi run frontend-test` and `pixi run frontend-check`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(rules-ui): rules artifact editor tab with debounced lint"
```

---

### Task 12: Issues panel — rule chips verification + skipped-rules banner

**Files (all under `frontend/`):**
- Modify: `src/lib/api/validation.ts` — `IssueListOutSchema` gains `rules_status: z.object({total: z.number(), skipped: z.array(z.object({artifact_id: z.string(), set_name: z.string(), rule: z.string(), reason: z.string()})), eval_errors: z.record(z.number())}).nullable().default(null)` (match the file's zod idioms)
- Modify: `src/lib/state/model.svelte.ts` — `refetchIssues` threads `rules_status` into a new `_rulesStatus` store field; getter `getRulesStatus()`; reset in `resetModelStore()`
- Modify: `src/lib/components/Workspace/IssuesPanel.svelte` — banner between header and body (mirror the `lastError` strip at :226-232): `“N rule(s) skipped — schema mismatch”` with a details tooltip/list of `set_name / rule / reason`, `data-testid="rules-skipped-banner"`, rendered only when `skipped.length > 0`; `checkLabel()` falls back to the raw `check` for `rule:*` checks (verify chips already render unknown checks — if `CHECK_LABELS` lookup falls back to the key, nothing to do; add a prettifier stripping the `rule:` prefix)
- Test: `src/lib/components/__tests__/IssuesPanel.rules.test.ts`, extend `src/lib/state/__tests__/adopt-issues.test.ts`

- [ ] **Step 1: Write failing tests** — IssuesPanel test mounts the panel with adopted issues carrying `check: "rule:zoned"` and a `rules_status` with one skip: chip renders labeled `zoned` and filters on click; banner shows `1 rule skipped`; no banner when `skipped` empty. adopt-issues test: `getModelIssues` mock returns `rules_status` and the getter exposes it; reset clears it.

- [ ] **Step 2: Run to verify failure**, **Step 3: implement**, **Step 4: run to pass** (`pixi run frontend-test`, `pixi run frontend-check`).

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(rules-ui): rule chips polish and skipped-rules banner"
```

---

### Task 13: Docs, backlog, full verification

**Files:**
- Modify: `CLAUDE.md` (a short "Custom validation rules" bullet block inside the backend architecture section: the artifact kind, `api/rules.py` seam, session cache + refresh triggers, expand-scope stance, rules_status, lint route)
- Modify: `frontend/README.md` (a short section beside the other editor families: rules editor tab, staging, lint, banner)
- Modify: `BACKLOG.md` (P-12 → `done` with date + branch; add any deliberately-deferred follow-ups from spec §11 as a note on the entry)

- [ ] **Step 1: Write the doc updates** (present-tense, concise, matching each file's existing register).

- [ ] **Step 2: Full verification**

```bash
pixi run dr-tidy       # ruff + mypy + pyright + frontend format/lint — must be clean
pixi run dr-test       # core pytest + frontend vitest — must pass
```

Fix anything that surfaces; do not skip.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md frontend/README.md BACKLOG.md
git commit -m "docs: custom validation rules (P-12) architecture notes and backlog close-out"
```

- [ ] **Step 4: Final review gate** — run the superpowers:requesting-code-review flow for the branch before merge consideration.

---

## Deliberately out of scope (spec §11 — do not implement)

`else` branches; rules on relationships; relationship-property tests; value-vs-value joins; snippet-backed rules; STRUCTURAL user rules (permanently out); e2e tests (T-7 list).
