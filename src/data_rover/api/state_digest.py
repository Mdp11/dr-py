"""State digest: an order-independent 64-bit hash over every ``(id, rev)`` pair.

Two replicas of one project hold the same committed state exactly when their
digests match: an entity a replica misses, holds twice over or holds at the
wrong ``rev`` changes the XOR. The per-entity hash has to be non-linear — an
XOR fold of a linear checksum (CRC32) cannot see two same-length ids
exchanging their ``rev``s.
"""

from __future__ import annotations

import hashlib

from data_rover.core.model.model import Model


def entity_hash(entity_id: str, rev: int) -> int:
    """First 8 bytes of SHA-256 over ``utf8(id) ‖ 0x00 ‖ ascii(decimal rev)``.

    Elements and relationships share one id namespace, so one function serves
    both. XOR a pair out and its successor in to maintain a digest in O(batch).
    """
    data = entity_id.encode("utf-8") + b"\x00" + str(rev).encode("ascii")
    return int.from_bytes(hashlib.sha256(data).digest()[:8], "big")


def format_digest(value: int) -> str:
    """The wire form: 16 lower-case hex digits."""
    return f"{value:016x}"


def model_digest(model: Model) -> str:
    """The digest of every element and relationship, by full recomputation."""
    value = 0
    for element in model.elements.values():
        value ^= entity_hash(element.id, element.rev)
    for rel in model.relationships.values():
        value ^= entity_hash(rel.id, rel.rev)
    return format_digest(value)
