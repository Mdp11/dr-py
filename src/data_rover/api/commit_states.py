"""Per-commit touched-entity state: capture at commit time, load at diff time.

The journal's inverse ops cannot render a ``modified`` diff entry on their
own — an update's inverse ``properties_patch`` carries only the touched
keys, not the whole entity — so the full before/after state of every entity
a batch touched is captured while the live model is still in scope and
stored on the ``Commit`` row (``entity_states``). The diff reader then never
reconstructs the model for a commit that carries it.

Column shape::

    {"elements":      {id: {"before": ElementOut | null, "after": ElementOut | null}},
     "relationships": {id: {"before": RelationshipOut | null, "after": RelationshipOut | null}},
     "recreated":     {"elements": [id, ...], "relationships": [id, ...]}}

``before: null`` = did not exist before the commit; ``after: null`` = does
not exist after it. ``recreated`` names the ids the commit deleted and then
created again — new entities at the end of their dict, which a before/after
pair cannot say — and is absent from rows older than the key. Every commit
stores its states, however many entities it touched; a NULL column is a row
from before the key, whose diff is unavailable (``DiffUnavailable``).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from data_rover.core.model.model import Model

from .schemas import ElementOut, RelationshipOut

if TYPE_CHECKING:
    from .routes.ops import _BatchResult


class DiffUnavailable(Exception):
    """The journal cannot answer a history diff, and the server holds no model
    to rebuild one from. The message is the answer's detail."""


ElementPair = tuple[ElementOut | None, ElementOut | None]
RelationshipPair = tuple[RelationshipOut | None, RelationshipOut | None]


@dataclass(frozen=True, slots=True)
class EntityStates:
    """(before, after) per touched id — the diff renderer's single input
    shape, read from the journal row."""

    elements: dict[str, ElementPair]
    relationships: dict[str, RelationshipPair]
    recreated_element_ids: list[str] = field(default_factory=list)
    recreated_relationship_ids: list[str] = field(default_factory=list)


def _dump(out: ElementOut | RelationshipOut | None) -> dict[str, Any] | None:
    return out.model_dump(mode="json") if out is not None else None


def capture_entity_states(model: Model, res: _BatchResult) -> dict[str, Any]:
    """The ``entity_states`` column value for an applied batch. ``model`` is the
    POST-apply model (changed entities present, deleted ones gone); the before
    side comes from the applier's first-touch snapshots
    (``_BatchResult.before_*``)."""
    elements: dict[str, Any] = {}
    for eid in res.changed_element_ids:
        elements[eid] = {
            "before": _dump(res.before_elements[eid]),
            "after": _dump(ElementOut.from_core(model.elements[eid])),
        }
    for eid in res.deleted_element_ids:
        elements[eid] = {"before": _dump(res.before_elements[eid]), "after": None}
    relationships: dict[str, Any] = {}
    for rid in res.changed_relationship_ids:
        relationships[rid] = {
            "before": _dump(res.before_relationships[rid]),
            "after": _dump(RelationshipOut.from_core(model.relationships[rid])),
        }
    for rid in res.deleted_relationship_ids:
        relationships[rid] = {
            "before": _dump(res.before_relationships[rid]),
            "after": None,
        }
    return {
        "elements": elements,
        "relationships": relationships,
        "recreated": {
            "elements": list(res.recreated_element_ids),
            "relationships": list(res.recreated_relationship_ids),
        },
    }


def load_entity_states(raw: Mapping[str, Any]) -> EntityStates:
    """Parse a stored ``entity_states`` value back into typed pairs."""

    def el(v: Any) -> ElementOut | None:
        return ElementOut.model_validate(v) if v is not None else None

    def rel(v: Any) -> RelationshipOut | None:
        return RelationshipOut.model_validate(v) if v is not None else None

    recreated = raw.get("recreated", {})
    return EntityStates(
        elements={
            eid: (el(entry.get("before")), el(entry.get("after")))
            for eid, entry in raw.get("elements", {}).items()
        },
        relationships={
            rid: (rel(entry.get("before")), rel(entry.get("after")))
            for rid, entry in raw.get("relationships", {}).items()
        },
        recreated_element_ids=list(recreated.get("elements", [])),
        recreated_relationship_ids=list(recreated.get("relationships", [])),
    )
