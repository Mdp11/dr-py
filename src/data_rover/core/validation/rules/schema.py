"""Declarative validation-rule language: pydantic AST + YAML entry point.

One condition language used twice per rule (`when` guard, `then` assertion).
Union members are disambiguated by their distinctive keys (`all`/`any`/`not`/
`property`/`relationship`) with extra="forbid", not a discriminator field —
authors never write a `kind` key.
"""

from __future__ import annotations

from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

RULES_SCHEMA_VERSION = 1
RULES_MAX_YAML_BYTES = 64 * 1024
MAX_RULES_PER_SET = 200
MAX_CONDITION_DEPTH = 8

Scalar = str | int | float | bool

_PROPERTY_TESTS = (
    "exists",
    "equals",
    "not_equals",
    "in_",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
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
    def _exactly_one_test(self) -> PropertyCond:
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
    def _at_least_one(self) -> CountSpec:
        if self.eq is None and self.gte is None and self.lte is None:
            raise ValueError("count needs at least one of eq/gte/lte")
        return self


class RelationshipSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = Field(min_length=1)
    direction: Literal["outgoing", "incoming"]
    to: str | None = None
    where: Condition | None = None
    exists: bool | None = None
    count: CountSpec | None = None

    @model_validator(mode="after")
    def _exactly_one_of_exists_count(self) -> RelationshipSpec:
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

    all: list[Condition] = Field(min_length=1)


class AnyCond(BaseModel):
    model_config = ConfigDict(extra="forbid")

    any: list[Condition] = Field(min_length=1)


class NotCond(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    not_: Condition = Field(alias="not")


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
    def _depth(self) -> Rule:
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
    def _unique_names(self) -> RuleSetDefinition:
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
    except (yaml.YAMLError, RecursionError) as exc:
        # RecursionError: pyyaml's own parser recurses per nesting level and blows
        # the interpreter stack well before RULES_MAX_YAML_BYTES or
        # MAX_CONDITION_DEPTH ever come into play (both only guard pydantic, which
        # runs after this parse succeeds).
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
    def _yaml_parses(self) -> RulesArtifactPayload:
        parse_rule_set(self.yaml)  # RuleSetError is a ValueError: pydantic wraps it
        return self


RULES_ADAPTER: TypeAdapter[RulesArtifactPayload] = TypeAdapter(RulesArtifactPayload)
