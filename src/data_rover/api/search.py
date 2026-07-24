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

The criterion models and matchers themselves live in
:mod:`data_rover.core.search.criteria` (moved there so the core-layer
navigation engine can reuse them); this module re-exports them so the public
surface and the ``/model/search`` wire format stay unchanged.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from data_rover.core.model.model import Model
from data_rover.core.search.criteria import (
    AnyOfCriterion,
    ConnectedToTypeCriterion,
    Criterion,
    Direction,
    EndpointTypeCriterion,
    EntityTypeCriterion,
    LeafCriterion,
    NameIdCriterion,
    OrphanCriterion,
    PropertyCriterion,
    RelationCountCriterion,
    match_element,
    match_relationship,
)

from .schemas import ElementOut, RelationshipOut

#: hard cap on a search page; mirrors ``routes.read.MAX_PAGE_LIMIT`` (kept
#: separate to avoid a circular import — read.py imports this module).
_MAX_LIMIT = 500


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


def run_query(model: Model, query: SearchQueryIn) -> list[str]:
    """Ids of entities matching ALL criteria, in model insertion order."""
    if query.target == "element":
        return [
            e.id
            for e in model.elements.values()
            if all(match_element(model, e, c) for c in query.criteria)
        ]
    return [
        r.id
        for r in model.relationships.values()
        if all(match_relationship(model, r, c) for c in query.criteria)
    ]


__all__ = [
    "AnyOfCriterion",
    "ConnectedToTypeCriterion",
    "Criterion",
    "Direction",
    "EndpointTypeCriterion",
    "EntityTypeCriterion",
    "LeafCriterion",
    "NameIdCriterion",
    "OrphanCriterion",
    "PropertyCriterion",
    "RelationCountCriterion",
    "SearchQueryIn",
    "SearchResultPage",
    "run_query",
]
