from __future__ import annotations

import os
import time
import uuid
from typing import Protocol

_last_ms: int = 0
_seq: int = 0


class IdGenerator(Protocol):
    def new_id(self) -> str: ...


def _uuid7() -> uuid.UUID:
    # RFC 9562 UUIDv7: 48-bit ms timestamp + 12-bit monotonic seq + random.
    global _last_ms, _seq
    unix_ms = int(time.time() * 1000)
    if unix_ms <= _last_ms:
        unix_ms = _last_ms
        _seq += 1
    else:
        _last_ms = unix_ms
        _seq = 0
    rand = os.urandom(8)
    # Layout: [6 bytes ms][1 byte ver+seq_hi][1 byte seq_lo][8 bytes random]
    seq_hi = (_seq >> 8) & 0x0F
    seq_lo = _seq & 0xFF
    raw = bytearray(unix_ms.to_bytes(6, "big") + bytes([seq_hi, seq_lo]) + rand)
    raw[6] = (raw[6] & 0x0F) | 0x70  # version 7
    raw[8] = (raw[8] & 0x3F) | 0x80  # RFC 4122 variant
    return uuid.UUID(bytes=bytes(raw))


class Uuid7Generator:
    """Default generator: time-ordered, coordination-free UUIDv7."""

    def new_id(self) -> str:
        return str(_uuid7())


class SequentialIdGenerator:
    """Deterministic generator for tests."""

    def __init__(self, prefix: str = "id") -> None:
        self._prefix = prefix
        self._n = 0

    def new_id(self) -> str:
        self._n += 1
        return f"{self._prefix}-{self._n}"
