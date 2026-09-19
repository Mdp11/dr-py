"""Snapshot blob formats: gzip members of the model, as one document or as lines.

The ONE place that knows what bytes the ``SnapshotStore`` holds. Writers
stream ``encode_snapshot_v2`` into ``store.put``; readers hand whatever
``store.get`` returned to ``decode_snapshot``. The decoder branches on the
bytes (the gzip magic, then the header line) — never on the key — so a row
written before compression (indented JSON under a ``.json`` key) keeps
loading, and a test that puts plain JSON under a ``.json.gz`` key loads too.

Two formats share the gzip framing. v2 (``datarover.snapshot/v2``) is what
every writer emits: line-delimited — a header line, then one line per entity
in insertion order — so a reader can parse while bytes arrive. v1, the compact
``{"elements", "relationships"}`` document, is still read; no server path
writes it.
"""

from __future__ import annotations

import gzip
import json
import zlib
from collections.abc import Iterable, Iterator
from typing import Any

from data_rover.core.model.model import Model

from .serialize import (
    iter_buffered,
    iter_entity_lines,
    iter_model_json_compact,
    parse_model_json,
)
from .state_digest import model_digest

#: deflate level. 3 is the knee on the compact document: level 6 doubles the
#: encode time for ~15 % fewer bytes, level 1 saves ~10 % time for ~15 % more.
SNAPSHOT_GZIP_LEVEL = 3
#: the ``format`` value of a v2 header line
SNAPSHOT_V2_FORMAT = "datarover.snapshot/v2"
#: RFC 1952 member header
_GZIP_MAGIC = b"\x1f\x8b"
#: how every v2 blob starts once inflated: the header is written compact with
#: ``format`` as its first key, so the prefix identifies the format without
#: parsing a line that, in a v1 blob, is the whole document
_V2_PREFIX = b'{"format":"' + SNAPSHOT_V2_FORMAT.encode("ascii") + b'"'
#: compact text buffered per ``compress()`` call — one deflate input per
#: ~1 MiB of JSON keeps the call count in the hundreds on a 300 MB model
_COMPRESS_CHUNK_CHARS = 1 << 20
#: 16 + MAX_WBITS = write a gzip member (header + CRC trailer), not raw zlib
_GZIP_WBITS = 16 + zlib.MAX_WBITS


def _gzip_member(chunks: Iterable[str]) -> Iterator[bytes]:
    comp = zlib.compressobj(SNAPSHOT_GZIP_LEVEL, zlib.DEFLATED, _GZIP_WBITS)
    for text in iter_buffered(chunks, _COMPRESS_CHUNK_CHARS):
        out = comp.compress(text.encode("utf-8"))
        if out:
            yield out
    yield comp.flush()


def encode_snapshot(model: Model) -> Iterator[bytes]:
    """Stream the model as one gzip member of its compact JSON document.

    Peak extra memory is one text chunk plus the deflate window; the model
    itself is never materialized as a string.
    """
    return _gzip_member(iter_model_json_compact(model))


def _v2_lines(
    model: Model, project_id: str, rev: int, metamodel_id: str, state_digest: str
) -> Iterator[str]:
    header = {
        "format": SNAPSHOT_V2_FORMAT,
        "project_id": project_id,
        "rev": rev,
        "metamodel_id": metamodel_id,
        "elements": len(model.elements),
        "relationships": len(model.relationships),
        "state_digest": state_digest,
    }
    yield (
        json.dumps(header, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        + "\n"
    )
    for line in iter_entity_lines(model):
        yield line + "\n"


def encode_snapshot_v2(
    model: Model,
    *,
    project_id: str,
    rev: int,
    metamodel_id: str,
    state_digest: str | None = None,
) -> Iterator[bytes]:
    """Stream the model as one gzip member of LF-terminated JSON lines: the
    header, then every element, then every relationship, in insertion order.

    ``state_digest`` is written as given; ``None`` recomputes it from the
    model. The header's counts are taken when iteration starts; the caller
    holds the model still (the write mutex) for the whole stream, as the
    header is only true of the entities that follow it.
    """
    if state_digest is None:
        state_digest = model_digest(model)
    return _gzip_member(_v2_lines(model, project_id, rev, metamodel_id, state_digest))


def is_gzip(blob: bytes) -> bool:
    return blob[:2] == _GZIP_MAGIC


def _decode_v2(blob: bytes) -> dict[str, Any]:
    header_line, _, body = blob.partition(b"\n")
    header = json.loads(header_line)
    elements, relationships = header.get("elements"), header.get("relationships")
    for count in (elements, relationships):
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError("snapshot v2 header carries no valid entity counts")
    lines = body.split(b"\n")
    if lines[-1] == b"":
        lines.pop()
    if len(lines) != elements + relationships:
        raise ValueError(
            f"snapshot v2 holds {len(lines)} entity lines, its header promises "
            f"{elements} + {relationships}"
        )
    # One parse of the joined lines: a json.loads per line costs several
    # times more on a large model.
    entities = parse_model_json(b"[" + b",".join(lines) + b"]")
    return {
        "elements": entities[:elements],
        "relationships": entities[elements:],
    }


def decode_snapshot(blob: bytes) -> Any:
    """Parse a stored snapshot blob — compressed or plain, v1 or v2 — into the
    ``{"elements", "relationships"}`` document ``build_model_from_dicts`` reads.

    A v2 blob whose line count disagrees with its header (a truncated or
    corrupted object) raises ``ValueError``.
    """
    if is_gzip(blob):
        blob = gzip.decompress(blob)
    if blob.startswith(_V2_PREFIX):
        return _decode_v2(blob)
    return parse_model_json(blob)
