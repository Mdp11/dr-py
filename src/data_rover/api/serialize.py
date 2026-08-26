"""Chunked JSON serialization of the session model for save/download.

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
JS does not \\u-escape non-ASCII), so save files stay interchangeable with
the frontend reader.

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
from typing import Any
from collections.abc import Iterable, Iterator

from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

#: entities sit two levels deep ({ -> "elements": [ -> entity), so their
#: json.dumps text (indent level 0) is shifted right by two indent steps
_ENTITY_PAD = " " * 4


def _entity_chunks(entities: Iterator[dict[str, Any]], key: str) -> Iterator[str]:
    """Yield ``"<key>": [...]`` (indented one level, no trailing comma)."""
    first = True
    for entity in entities:
        text = json.dumps(entity, indent=2, ensure_ascii=False, allow_nan=False)
        prefix = f'  "{key}": [\n{_ENTITY_PAD}' if first else f",\n{_ENTITY_PAD}"
        yield prefix + text.replace("\n", "\n" + _ENTITY_PAD)
        first = False
    if first:
        yield f'  "{key}": []'
    else:
        yield "\n  ]"


def _element_dicts(elements: Iterable[Element]) -> Iterator[dict[str, Any]]:
    for e in elements:
        yield {
            "id": e.id,
            "type_name": e.type_name,
            "properties": e.properties,
            "rev": e.rev,
        }


def _relationship_dicts(
    relationships: Iterable[Relationship],
) -> Iterator[dict[str, Any]]:
    for r in relationships:
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
    ensure_ascii=False)`` — asserted by the byte-shape tests.

    Concurrency/staleness semantics: the entity SETS are snapshotted
    (``list(...)`` of the model's entity dicts — entity references only,
    O(model) pointers, no copies) when iteration starts, so a concurrent ops
    batch adding or deleting entities mid-stream cannot blow up the
    iteration with ``RuntimeError: dict changed size``; the download
    reflects the model's entity population at stream start. What remains is
    benign staleness: entity objects are read live, so an entity edited
    mid-stream is emitted in its newer state if its chunk has not been
    produced yet (each entity is dumped in a single generator step, and
    property values are replaced wholesale, never mutated in place — the
    documented invariant on ``Model.set_property`` — so a chunk is always a
    coherent before-or-after state, never a torn one).

    NaN/Infinity property values raise ``ValueError`` (``allow_nan=False``):
    they have no JSON representation, so failing the save loudly beats
    writing a file the frontend's ``JSON.parse`` can never read back.
    """
    elements = list(model.elements.values())
    relationships = list(model.relationships.values())
    yield "{\n"
    yield from _entity_chunks(_element_dicts(elements), "elements")
    yield ",\n"
    yield from _entity_chunks(_relationship_dicts(relationships), "relationships")
    yield "\n}"


#: entities per ``json.dumps`` call in the compact writer. One C-encoder call
#: per batch amortizes the per-call overhead that dominates a per-entity dump
#: (measured 2x faster) while a batch of ~500 KB text bounds the peak extra
#: memory; the indented writer keeps its per-entity granularity because its
#: re-indent step is per-entity anyway.
SNAPSHOT_BATCH = 2000
_COMPACT_SEPARATORS = (",", ":")


def _dump_batch(batch: list[dict[str, Any]], first: bool) -> str:
    # Dump the batch as a list and strip its brackets: the items' text is
    # exactly what a whole-document dumps emits for them, so the join stays
    # byte-identical to json.dumps(doc, separators=(",", ":")).
    text = json.dumps(
        batch, separators=_COMPACT_SEPARATORS, ensure_ascii=False, allow_nan=False
    )
    return text[1:-1] if first else "," + text[1:-1]


def _compact_chunks(entities: Iterator[dict[str, Any]], key: str) -> Iterator[str]:
    """Yield ``"<key>":[...]`` compact, ``SNAPSHOT_BATCH`` entities per dumps."""
    yield f'"{key}":['
    batch: list[dict[str, Any]] = []
    first = True
    for entity in entities:
        batch.append(entity)
        if len(batch) >= SNAPSHOT_BATCH:
            yield _dump_batch(batch, first)
            first = False
            batch = []
    if batch:
        yield _dump_batch(batch, first)
    yield "]"


def iter_model_json_compact(model: Model) -> Iterator[str]:
    """Yield the snapshot document with no whitespace, batch by batch.

    Same document, entity order and key order as ``iter_model_json``;
    ``"".join(iter_model_json_compact(m))`` equals
    ``json.dumps(doc, separators=(",", ":"), ensure_ascii=False)``. Same
    point-in-time semantics too: the entity SETS are snapshotted when
    iteration starts, entities are read live (see ``iter_model_json``).
    This is the snapshot-store form; the save/download routes keep the
    indented writer, which is the frontend's save-file contract.
    """
    elements = list(model.elements.values())
    relationships = list(model.relationships.values())
    yield "{"
    yield from _compact_chunks(_element_dicts(elements), "elements")
    yield ","
    yield from _compact_chunks(_relationship_dicts(relationships), "relationships")
    yield "}"


def iter_buffered(chunks: Iterable[str], min_size: int = 64 * 1024) -> Iterator[str]:
    """Re-chunk ``chunks`` into pieces of at least ``min_size`` characters.

    ``iter_model_json`` yields one ~400-byte chunk per entity, which is the
    right granularity for memory but pathological for a ``StreamingResponse``:
    every chunk costs a full ASGI send cycle, and a large model has hundreds
    of thousands of them (measured: ~2 MB/s on /model/download vs. the same
    bytes written to disk in under 2 s by /model/save). This wrapper
    accumulates chunks and yields them joined once the buffer reaches
    ``min_size``, cutting the send count by ~100x while keeping peak extra
    memory at one buffer (~min_size).

    Byte identity: ``"".join(iter_buffered(c)) == "".join(c)`` — chunks are
    only concatenated, never split or altered.
    """
    buf: list[str] = []
    buffered = 0
    for chunk in chunks:
        buf.append(chunk)
        buffered += len(chunk)
        if buffered >= min_size:
            yield "".join(buf)
            buf.clear()
            buffered = 0
    if buf:
        yield "".join(buf)
