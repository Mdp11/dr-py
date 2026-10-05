"""Criterion models: the entity-filter vocabulary shared by navigations and
tables. The engine evaluates them; this module owns the wire schema.
Criteria combine with AND at every call site; the single OR construct is
``AnyOfCriterion`` (a flat, leaf-only group)."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


Direction = Literal["outgoing", "incoming", "either"]


# ---------------------------------------------------------------------------
# Criteria — discriminated union mirroring frontend/src/lib/search/types.ts
# ---------------------------------------------------------------------------


class EntityTypeCriterion(BaseModel):
    type: Literal["entity_type"]
    names: list[str] = Field(default_factory=list)


class PropertyCriterion(BaseModel):
    type: Literal["property"]
    name: str
    datatype: str | None = None  # carried by the UI; unused by evaluation
    op: Literal[
        "equals",
        "not_equals",
        "contains",
        "matches",
        "gt",
        "lt",
        "gte",
        "lte",
        "exists",
        "is_empty",
    ]
    value: str = ""


class NameIdCriterion(BaseModel):
    type: Literal["name_id"]
    field: Literal["name", "id"]
    op: Literal["contains", "equals", "matches"]
    value: str = ""


class RelationCountCriterion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["relation_count"]
    op: Literal["at_least", "at_most", "exactly"]
    count: int
    direction: Direction
    rel_types: list[str] = Field(default_factory=list, alias="relTypes")


class OrphanCriterion(BaseModel):
    type: Literal["orphan"]


class ConnectedToTypeCriterion(BaseModel):
    type: Literal["connected_to_type"]
    direction: Direction
    names: list[str] = Field(default_factory=list)


class EndpointTypeCriterion(BaseModel):
    type: Literal["endpoint_type"]
    endpoint: Literal["source", "target"]
    names: list[str] = Field(default_factory=list)


LeafCriterion = Annotated[
    EntityTypeCriterion
    | PropertyCriterion
    | NameIdCriterion
    | RelationCountCriterion
    | OrphanCriterion
    | ConnectedToTypeCriterion
    | EndpointTypeCriterion,
    Field(discriminator="type"),
]
"""Every non-group criterion — the only members an OR group may hold."""


class AnyOfCriterion(BaseModel):
    """OR group: matches iff ANY member matches. Members are LEAVES only —
    nesting is structurally unrepresentable (``criteria: list[LeafCriterion]``),
    so a nested group fails validation at every API boundary that parses
    criteria. An EMPTY group is a deliberate NO-OP (matches everything): it is
    a transient editing state and must not blank a half-configured table or
    navigation — the same tolerant stance as an unconfigured table
    ``NavigationSource``. This overrides literal ``any([]) is False``; the
    matchers here and the client evaluator special-case it identically."""

    type: Literal["any_of"]
    criteria: list[LeafCriterion] = Field(default_factory=list)


Criterion = Annotated[
    EntityTypeCriterion
    | PropertyCriterion
    | NameIdCriterion
    | RelationCountCriterion
    | OrphanCriterion
    | ConnectedToTypeCriterion
    | EndpointTypeCriterion
    | AnyOfCriterion,
    Field(discriminator="type"),
]
