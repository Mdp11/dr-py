"""Chunked JSON serialization of the session model (Phase C3 save/download).

The save-file contract is what the frontend writes today:
``JSON.stringify({elements, relationships}, null, 2)`` of the snapshot-shaped
model (see ``frontend/src/lib/util/fileSave.ts`` /
``frontend/src/lib/state/cr.ts::saveWithOptionalCr``) — top-level keys
``elements`` then ``relationships``, entity keys in declaration order
(``id, type_name, properties, rev`` / ``id, type_name, source_id, target_id,
properties, rev``), 2-space indentation, no trailing newline.
``json.dumps(obj, indent=2, ensure_ascii=False)`` produces byte-identical
output to ``JSON.stringify(obj, null, 2)`` for this data (same item/key
separators, same empty-container collapsing; ``ensure_ascii=False`` because
JS does not \\u-escape non-ASCII), so existing save files keep loading and
saved files keep opening in the old frontend reader.

Why a generator instead of one ``json.dumps`` of the whole model: the
serialized form of a large model is ~80 MB+, and the model already lives in
memory — materializing the full text would hold a SECOND full copy as a
Python string. ``iter_model_json`` yields one entity at a time (each entity
is dumped individually and re-indented), so peak extra memory is one
entity's text. ``json.dump`` directly to a file handle would also avoid the
big string, but it cannot feed a ``StreamingResponse``; one generator serves
both /model/save and /model/download and guarantees their bytes are
identical.
"""

from __future__ import annotations

import json
from typing import Any, Iterator

from data_rover.core.model.model import Model

#: entities sit two levels deep ({ -> "elements": [ -> entity), so their
#: json.dumps text (indent level 0) is shifted right by two indent steps
_ENTITY_PAD = " " * 4


def _entity_chunks(entities: Iterator[dict[str, Any]], key: str) -> Iterator[str]:
    """Yield ``"<key>": [...]`` (indented one level, no trailing comma)."""
    first = True
    for entity in entities:
        text = json.dumps(entity, indent=2, ensure_ascii=False)
        prefix = f'  "{key}": [\n{_ENTITY_PAD}' if first else f",\n{_ENTITY_PAD}"
        yield prefix + text.replace("\n", "\n" + _ENTITY_PAD)
        first = False
    if first:
        yield f'  "{key}": []'
    else:
        yield "\n  ]"


def _element_dicts(model: Model) -> Iterator[dict[str, Any]]:
    for e in model.elements.values():
        yield {
            "id": e.id,
            "type_name": e.type_name,
            "properties": e.properties,
            "rev": e.rev,
        }


def _relationship_dicts(model: Model) -> Iterator[dict[str, Any]]:
    for r in model.relationships.values():
        yield {
            "id": r.id,
            "type_name": r.type_name,
            "source_id": r.source_id,
            "target_id": r.target_id,
            "properties": r.properties,
            "rev": r.rev,
        }


def iter_model_json(model: Model) -> Iterator[str]:
    """Yield the model's save-file JSON text in entity-sized chunks.

    ``"".join(iter_model_json(m))`` equals
    ``json.dumps({"elements": [...], "relationships": [...]}, indent=2,
    ensure_ascii=False)`` — asserted by the byte-shape tests. The generator
    reads the live model lazily; callers must not mutate the model while
    consuming it (single-user session, sync handlers — not a concern today).
    """
    yield "{\n"
    yield from _entity_chunks(_element_dicts(model), "elements")
    yield ",\n"
    yield from _entity_chunks(_relationship_dicts(model), "relationships")
    yield "\n}"
