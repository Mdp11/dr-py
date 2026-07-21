"""Per-session cache of embedded snippet call results (spec 2026-07-20 §3.1).

Sound because of the WASM runner's determinism guarantee: same code + same
model ⇒ same output, so a result keyed by (code hash, entry, element ids) is
valid for as long as the model doesn't change. "The model didn't change" is
tracked by a REV STAMP rather than rev-in-key: `Session.touch_model`/
`set_model` call `clear_and_stamp(new_rev)`, and `put`/`get` at any other rev
are no-ops/misses — the same sampled-rev poisoning guard the table order
cache uses (a request that computed against a superseded model must never
write into the fresh cache; evaluation runs outside any lock, so a lost race
merely recomputes).

Self-stamping: a `put` at a rev NEWER than the stamp clears and re-stamps.
This covers paths that advance `model_rev` without running the invalidation
hooks (e.g. hydration assigning the DB-authoritative rev) — without it the
cache would silently reject every write until the next commit.

Error results: only DETERMINISTIC kinds (`runtime`, `syntax`) are cached —
they reproduce identically, so recomputing them is pure waste. Environmental
kinds (`timeout`, `unavailable`, `memory`, `cancelled`, and the synthetic
`pending`) must stay retryable and are silently not stored; `put` enforces
this itself so no caller can poison the cache with a transient failure.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

from .runner import CallResult

#: (sha256(code).hexdigest(), entry, element_ids) — code is hashed so keys
#: stay small; ScriptEvalContext computes the hash once per distinct code.
CellKey = tuple[str, str, tuple[str, ...]]

_CACHEABLE_ERROR_KINDS = frozenset({"runtime", "syntax"})


class ScriptCellCache:
    def __init__(self, cap: int = 50_000) -> None:
        self._cap = cap
        self._lock = threading.Lock()
        self._stamp = 0
        self._d: OrderedDict[CellKey, CallResult] = OrderedDict()

    def get(self, key: CellKey, rev: int) -> CallResult | None:
        with self._lock:
            if rev != self._stamp:
                return None
            hit = self._d.get(key)
            if hit is not None:
                self._d.move_to_end(key)
            return hit

    def put(self, key: CellKey, result: CallResult, rev: int) -> None:
        if result.error is not None and result.error.kind not in _CACHEABLE_ERROR_KINDS:
            return
        with self._lock:
            if rev < self._stamp:
                return  # stale writer: poisoning guard
            if rev > self._stamp:
                self._d.clear()
                self._stamp = rev
            self._d[key] = result
            self._d.move_to_end(key)
            while len(self._d) > self._cap:
                self._d.popitem(last=False)

    def clear_and_stamp(self, rev: int) -> None:
        with self._lock:
            self._d.clear()
            self._stamp = rev

    @property
    def stamp(self) -> int:
        with self._lock:
            return self._stamp

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._d)
