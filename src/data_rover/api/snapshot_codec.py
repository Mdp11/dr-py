"""Snapshot blob format: a gzip member of the compact model document.

The ONE place that knows what bytes the ``SnapshotStore`` holds. Writers
stream ``encode_snapshot`` into ``store.put``; readers hand whatever
``store.get`` returned to ``decode_snapshot``. The decoder branches on the
bytes (the gzip magic) — never on the key — so a row written before
compression (indented JSON under a ``.json`` key) keeps loading, and a
test that puts plain JSON under a ``.json.gz`` key loads too.
"""

from __future__ import annotations

import gzip
import json
import zlib
from collections.abc import Iterator
from typing import Any

from data_rover.core.model.model import Model

from .serialize import iter_buffered, iter_model_json_compact

#: deflate level. 3 is the knee on the compact document: level 6 doubles the
#: encode time for ~15 % fewer bytes, level 1 saves ~10 % time for ~15 % more.
SNAPSHOT_GZIP_LEVEL = 3
#: RFC 1952 member header
_GZIP_MAGIC = b"\x1f\x8b"
#: compact text buffered per ``compress()`` call — one deflate input per
#: ~1 MiB of JSON keeps the call count in the hundreds on a 300 MB model
_COMPRESS_CHUNK_CHARS = 1 << 20
#: 16 + MAX_WBITS = write a gzip member (header + CRC trailer), not raw zlib
_GZIP_WBITS = 16 + zlib.MAX_WBITS


def encode_snapshot(model: Model) -> Iterator[bytes]:
    """Stream the model as one gzip member of its compact JSON document.

    Peak extra memory is one text chunk plus the deflate window; the model
    itself is never materialized as a string.
    """
    comp = zlib.compressobj(SNAPSHOT_GZIP_LEVEL, zlib.DEFLATED, _GZIP_WBITS)
    for text in iter_buffered(iter_model_json_compact(model), _COMPRESS_CHUNK_CHARS):
        out = comp.compress(text.encode("utf-8"))
        if out:
            yield out
    yield comp.flush()


def is_gzip(blob: bytes) -> bool:
    return blob[:2] == _GZIP_MAGIC


def decode_snapshot(blob: bytes) -> Any:
    """Parse a stored snapshot blob, compressed or plain, into the document."""
    if is_gzip(blob):
        blob = gzip.decompress(blob)
    return json.loads(blob)
