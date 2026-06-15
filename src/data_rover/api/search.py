"""Server-side advanced-search engine + request/response schemas.

A faithful port of ``frontend/src/lib/search/evaluate.ts``. The advanced-search
dialog historically evaluated criteria in the browser over only the *fetched
subset* of the lazily-loaded model, so any match outside the loaded page was
silently missed (see ``POST /model/search`` in ``routes/read.py``). This module
runs the same query semantics over the WHOLE :class:`~data_rover.core.model.Model`.

It is pure and read-only. Per-entity evaluation is O(criteria): the
relationship-aware criteria (``relation_count``, ``orphan``,
``connected_to_type``, ``endpoint_type``) go through ``model.indexes`` rather
than scanning relationships, mirroring the rest of the read layer.

Coercion mirrors JavaScript so results match the client reference exactly:
``String(raw ?? '')`` for text ops (``true``/``false`` lower-cased, integral
floats without a trailing ``.0``) and ``Number(...)`` for numeric comparisons
(missing → NaN → no match; ``null`` → 0; blank string → 0).
"""

from __future__ import annotations

import math
import re
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

from .schemas import ElementOut, RelationshipOut

#: hard cap on a search page; mirrors ``routes.read.MAX_PAGE_LIMIT`` (kept
#: separate to avoid a circular import — read.py imports this module).
_MAX_LIMIT = 500

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


Criterion = Annotated[
    Union[
        EntityTypeCriterion,
        PropertyCriterion,
        NameIdCriterion,
        RelationCountCriterion,
        OrphanCriterion,
        ConnectedToTypeCriterion,
        EndpointTypeCriterion,
    ],
    Field(discriminator="type"),
]


class SearchQueryIn(BaseModel):
    target: Literal["element", "relationship"]
    criteria: list[Criterion] = Field(default_factory=list)
    limit: int = Field(_MAX_LIMIT, ge=1, le=_MAX_LIMIT)
    offset: int = Field(0, ge=0)


class SearchResultPage(BaseModel):
    """Hydrated, paged result set. Exactly one of ``elements`` /
    ``relationships`` is populated, selected by ``target``; ``total`` is the
    match count BEFORE limit/offset paging."""

    target: Literal["element", "relationship"]
    elements: list[ElementOut] = Field(default_factory=list)
    relationships: list[RelationshipOut] = Field(default_factory=list)
    total: int = 0


# ---------------------------------------------------------------------------
# JS-parity coercion helpers
# ---------------------------------------------------------------------------

_MISSING = object()


def _js_str(value: object) -> str:
    """``String(value)`` for the JSON scalar types model properties hold."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer() and math.isfinite(value):
        return str(int(value))
    return str(value)


def _nullish_str(raw: object) -> str:
    """``String(raw ?? '')`` — missing/null collapse to the empty string."""
    if raw is _MISSING or raw is None:
        return ""
    return _js_str(raw)


def _to_number(raw: object) -> float:
    """``Number(raw)`` semantics: missing → NaN, null → 0, bool → 0/1, blank
    string → 0, unparseable → NaN."""
    if raw is _MISSING:
        return math.nan
    if raw is None:
        return 0.0
    if raw is True:
        return 1.0
    if raw is False:
        return 0.0
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        s = raw.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return math.nan
    return math.nan


def _safe_regex(pattern: str, value: str) -> bool:
    """``new RegExp(pattern).test(value)`` — unanchored, false on bad pattern."""
    try:
        return re.search(pattern, value) is not None
    except re.error:
        return False


def _name_prop(props: dict[str, object]) -> str | None:
    """Port of ``util/element-name.ts`` ``nameProp``: case-insensitive non-empty
    ``name`` property, exact lowercase ``name`` winning over other casings."""
    exact = props.get("name")
    if isinstance(exact, str) and exact:
        return exact
    for key, value in props.items():
        if key != "name" and key.lower() == "name" and isinstance(value, str) and value:
            return value
    return None


# ---------------------------------------------------------------------------
# criterion matchers
# ---------------------------------------------------------------------------


def _match_entity_type(type_name: str, names: list[str]) -> bool:
    return True if not names else type_name in names


def _match_property(props: dict[str, object], c: PropertyCriterion) -> bool:
    raw = props.get(c.name, _MISSING)
    op = c.op
    if op == "exists":
        return raw is not _MISSING and raw is not None and raw != ""
    if op == "is_empty":
        return raw is _MISSING or raw is None or raw == ""
    if op == "equals":
        return _nullish_str(raw) == c.value
    if op == "not_equals":
        return _nullish_str(raw) != c.value
    if op == "contains":
        return c.value.lower() in _nullish_str(raw).lower()
    if op == "matches":
        return _safe_regex(c.value, _nullish_str(raw))
    lhs = _to_number(raw)
    rhs = _to_number(c.value)
    if math.isnan(lhs) or math.isnan(rhs):
        return False
    if op == "gt":
        return lhs > rhs
    if op == "lt":
        return lhs < rhs
    if op == "gte":
        return lhs >= rhs
    return lhs <= rhs


def _match_name_id(name: str, entity_id: str, c: NameIdCriterion) -> bool:
    subject = name if c.field == "name" else entity_id
    if c.op == "contains":
        return c.value.lower() in subject.lower()
    if c.op == "equals":
        return subject == c.value
    return _safe_regex(c.value, subject)


def _rels_for(
    model: Model, element_id: str, direction: Direction
) -> list[Relationship]:
    idx = model.indexes
    if direction == "outgoing":
        rids: set[str] = set(idx.outgoing_ids(element_id))
    elif direction == "incoming":
        rids = set(idx.incoming_ids(element_id))
    else:  # either — union dedupes self-loops present in both directions
        rids = set(idx.outgoing_ids(element_id)) | set(idx.incoming_ids(element_id))
    return [model.relationships[rid] for rid in rids]


def _match_element(model: Model, e: Element, c: Criterion) -> bool:
    if isinstance(c, EntityTypeCriterion):
        return _match_entity_type(e.type_name, c.names)
    if isinstance(c, PropertyCriterion):
        return _match_property(e.properties, c)
    if isinstance(c, NameIdCriterion):
        return _match_name_id(_name_prop(e.properties) or "", e.id, c)
    if isinstance(c, RelationCountCriterion):
        rels = _rels_for(model, e.id, c.direction)
        if c.rel_types:
            rels = [r for r in rels if r.type_name in c.rel_types]
        n = len(rels)
        if c.op == "at_least":
            return n >= c.count
        if c.op == "at_most":
            return n <= c.count
        return n == c.count
    if isinstance(c, OrphanCriterion):
        idx = model.indexes
        return not idx.outgoing_ids(e.id) and not idx.incoming_ids(e.id)
    if isinstance(c, ConnectedToTypeCriterion):
        for r in _rels_for(model, e.id, c.direction):
            other_id = r.target_id if r.source_id == e.id else r.source_id
            other = model.elements.get(other_id)
            if other is not None and other.type_name in c.names:
                return True
        return False
    # relationship-only criterion on an element query: no-op (parity).
    return True


def _match_relationship(model: Model, r: Relationship, c: Criterion) -> bool:
    if isinstance(c, EntityTypeCriterion):
        return _match_entity_type(r.type_name, c.names)
    if isinstance(c, PropertyCriterion):
        return _match_property(r.properties, c)
    if isinstance(c, NameIdCriterion):
        return _match_name_id(_name_prop(r.properties) or "", r.id, c)
    if isinstance(c, EndpointTypeCriterion):
        end_id = r.source_id if c.endpoint == "source" else r.target_id
        el = model.elements.get(end_id)
        return el is not None and el.type_name in c.names
    # element-only criterion on a relationship query: no-op (parity).
    return True


def run_query(model: Model, query: SearchQueryIn) -> list[str]:
    """Ids of entities matching ALL criteria, in model insertion order."""
    if query.target == "element":
        return [
            e.id
            for e in model.elements.values()
            if all(_match_element(model, e, c) for c in query.criteria)
        ]
    return [
        r.id
        for r in model.relationships.values()
        if all(_match_relationship(model, r, c) for c in query.criteria)
    ]
