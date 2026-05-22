from __future__ import annotations

import os
import threading
import time
import uuid
from typing import Protocol


class IdGenerator(Protocol):
    def new_id(self) -> str: ...


def _uuid7(unix_ms: int, seq: int) -> uuid.UUID:
    raw = bytearray(16)
    raw[0:6] = unix_ms.to_bytes(6, "big")
    raw[6] = (seq >> 8) & 0x0F   # high 4 bits of the 12-bit sequence
    raw[7] = seq & 0xFF          # low 8 bits
    raw[8:16] = os.urandom(8)
    raw[6] = (raw[6] & 0x0F) | 0x70  # version 7
    raw[8] = (raw[8] & 0x3F) | 0x80  # RFC 4122 variant
    return uuid.UUID(bytes=bytes(raw))


class Uuid7Generator:
    """Default generator: time-ordered, coordination-free UUIDv7.

    A per-instance monotonic counter (guarded by a lock) keeps ids strictly
    increasing within and across the same millisecond. State is instance-scoped,
    not global, so the generator is safe to use from concurrent threads.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last_ms = 0
        self._seq = 0

    def new_id(self) -> str:
        with self._lock:
            ms = int(time.time() * 1000)
            if ms > self._last_ms:
                self._last_ms = ms
                self._seq = 0
            else:
                self._seq += 1
                if self._seq > 0xFFF:  # 12-bit counter exhausted this ms
                    self._last_ms += 1  # advance the virtual clock
                    self._seq = 0
                ms = self._last_ms
            return str(_uuid7(ms, self._seq))


class SequentialIdGenerator:
    """Deterministic generator for tests."""

    def __init__(self, prefix: str = "id") -> None:
        self._prefix = prefix
        self._n = 0

    def new_id(self) -> str:
        self._n += 1
        return f"{self._prefix}-{self._n}"
