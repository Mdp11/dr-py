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
Cached deterministic errors carry whatever `reads` their call reported
(usually `None` — errored calls ship no read-set — so they are evicted by
every commit; conservative and cheap).

Selective eviction (`evict_touched`, spec 2026-07-21 Phase B): each entry now
carries the read-set (`frozenset[ReadKey] | None`) its call reported
alongside the `CallResult`, so a commit that only touched a known subset of
the model can drop just the cells that read what changed instead of the
whole cache. See `evict_touched`'s docstring for the exact contract.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

from .runner import CallResult, ReadKey

#: (sha256(code).hexdigest(), entry, element_ids) — code is hashed so keys
#: stay small; ScriptEvalContext computes the hash once per distinct code.
CellKey = tuple[str, str, tuple[str, ...]]

_CACHEABLE_ERROR_KINDS = frozenset({"runtime", "syntax"})

#: `put` degrades an oversized incoming read-set to `None` above this many
#: keys. Storing read-sets (Phase B) changed the cache's memory profile by
#: orders of magnitude: each entry can now carry up to `_MAX_READS` (2000,
#: see `runner.py`) `ReadKey` tuples, each id up to 512 chars, times
#: `snippet_cell_cache_max` (default 50 000) cells. Nothing bounds the
#: aggregate, and a realistic pathological cell -- a multi-hop snippet
#: charging dozens of keys per cell over a big table -- is already hundreds
#: of MB of pure bookkeeping. `None` already means "evict on every commit"
#: (the conservative, always-correct direction), so collapsing an oversized
#: set to `None` here costs only extra recompute for that one cell; it can
#: NEVER cause a stale value, only extra work. Deliberately far below
#: `_MAX_READS`: this bounds steady-state cache memory, not a single call's
#: worst case.
_MAX_STORED_READS = 128


class ScriptCellCache:
    def __init__(self, cap: int = 50_000) -> None:
        self._cap = cap
        self._lock = threading.Lock()
        self._stamp = 0
        self._d: OrderedDict[CellKey, tuple[CallResult, frozenset[ReadKey] | None]] = (
            OrderedDict()
        )

    def get(self, key: CellKey, rev: int) -> CallResult | None:
        with self._lock:
            if rev != self._stamp:
                return None
            hit = self._d.get(key)
            if hit is None:
                return None
            self._d.move_to_end(key)
            return hit[0]

    def put(
        self,
        key: CellKey,
        result: CallResult,
        rev: int,
        *,
        reads: frozenset[ReadKey] | None = None,
    ) -> None:
        if result.error is not None and result.error.kind not in _CACHEABLE_ERROR_KINDS:
            return
        if reads is not None and len(reads) > _MAX_STORED_READS:
            # Degrade to "depends on everything" rather than storing a huge
            # read-set: correctness-neutral (None is already the always-evict
            # direction), just forfeits the recompute savings for this one
            # pathological cell. See _MAX_STORED_READS's docstring.
            reads = None
        with self._lock:
            if rev < self._stamp:
                return  # stale writer: poisoning guard
            if rev > self._stamp:
                self._d.clear()
                self._stamp = rev
            self._d[key] = (result, reads)
            self._d.move_to_end(key)
            while len(self._d) > self._cap:
                self._d.popitem(last=False)

    def evict_touched(self, touched: frozenset[ReadKey], rev: int) -> None:
        """Selective post-commit invalidation (spec 2026-07-21 Phase B).

        Called with the JUST-BUMPED `model_rev` while its commit's touched
        read-keys are in hand. Drops every entry whose read-set intersects
        `touched` — or whose read-set is `None`, meaning "depends on
        everything" (pre-read-set result, overflow, errored call) — and
        re-stamps the survivors to `rev` IN PLACE: they were computed against
        state this commit provably did not touch, so they carry forward
        rather than recompute. A survivor therefore hits at the new rev and
        misses at the old one (the stamp has moved out from under it).

        `rev != stamp + 1` degrades to clear-all: some path moved the rev
        without coming through here (a legacy `touch_model`/`set_model` full
        clear, a rev jump during hydration, or a stale stamp surviving a lazy
        period), so the intermediate history between the old stamp and `rev`
        is unknown and keeping anything would be a guess. Over-invalidation
        is always the safe direction — this mirrors `put`'s self-stamping
        rule but is stricter (that one accepts any newer rev; this one
        insists on exactly +1 because keeping survivors requires knowing
        precisely what changed).
        """
        with self._lock:
            if rev != self._stamp + 1:
                self._d.clear()
                self._stamp = rev
                return
            self._stamp = rev
            doomed = [
                k
                for k, (_res, reads) in self._d.items()
                if reads is None or not touched.isdisjoint(reads)
            ]
            for k in doomed:
                del self._d[k]

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
