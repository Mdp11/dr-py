"""ScriptCellCache: rev stamping, LRU, error-kind filtering (spec §3.1)."""

from data_rover.core.script.cell_cache import _MAX_STORED_READS, ScriptCellCache
from data_rover.core.script.runner import CallResult, ScriptError

KEY = ("a" * 64, "value", ("e1",))


def _ok(v: object = 1) -> CallResult:
    return CallResult(value={"kind": "scalar", "value": v}, error=None, duration_ms=1)


def _err(kind: str) -> CallResult:
    return CallResult(value=None, error=ScriptError(kind=kind, message="x"), duration_ms=1)  # type: ignore[arg-type]


def test_put_get_roundtrip_at_stamped_rev() -> None:
    c = ScriptCellCache()
    c.clear_and_stamp(3)
    c.put(KEY, _ok(), 3)
    assert c.get(KEY, 3) is not None
    assert c.get(KEY, 4) is None  # rev mismatch misses
    assert c.get(KEY, 2) is None


def test_put_at_older_rev_rejected() -> None:
    c = ScriptCellCache()
    c.clear_and_stamp(5)
    c.put(KEY, _ok(), 4)  # stale writer (poisoning guard)
    assert c.get(KEY, 5) is None and c.size == 0


def test_put_at_newer_rev_self_stamps_and_clears() -> None:
    # Covers hydration paths that assign model_rev without touch_model: the
    # first write at a newer rev owns the cache.
    c = ScriptCellCache()
    c.clear_and_stamp(1)
    c.put(KEY, _ok(1), 1)
    c.put(("b" * 64, "value", ("e2",)), _ok(2), 7)
    assert c.stamp == 7
    assert c.get(KEY, 7) is None  # old-rev entry gone
    assert c.get(("b" * 64, "value", ("e2",)), 7) is not None


def test_error_kind_filtering() -> None:
    c = ScriptCellCache()
    c.clear_and_stamp(1)
    for kind in ("runtime", "syntax"):
        c.put((kind * 16, "value", ()), _err(kind), 1)
    for kind in ("timeout", "unavailable", "memory", "cancelled", "pending"):
        c.put((kind, "value", ()), _err(kind), 1)
    assert c.size == 2  # only deterministic kinds cached


def test_lru_eviction() -> None:
    c = ScriptCellCache(cap=2)
    c.clear_and_stamp(1)
    c.put(("k1", "value", ()), _ok(), 1)
    c.put(("k2", "value", ()), _ok(), 1)
    assert c.get(("k1", "value", ()), 1) is not None  # touch k1 -> k2 is LRU
    c.put(("k3", "value", ()), _ok(), 1)
    assert c.get(("k2", "value", ()), 1) is None
    assert c.get(("k1", "value", ()), 1) is not None
    assert c.get(("k3", "value", ()), 1) is not None


def test_evict_touched_drops_intersecting_and_keeps_rest() -> None:
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    c.put(("sa", "value", ("t1",)), _ok(1), 5, reads=frozenset({("el", "t1")}))
    c.put(("sb", "value", ("t2",)), _ok(2), 5, reads=frozenset({("el", "t2")}))
    c.evict_touched(frozenset({("el", "t1")}), 6)
    assert c.stamp == 6
    assert c.get(("sa", "value", ("t1",)), 6) is None
    hit = c.get(("sb", "value", ("t2",)), 6)
    assert hit is not None and hit.value == {"kind": "scalar", "value": 2}


def test_evict_touched_none_reads_always_evicted() -> None:
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    c.put(("sa", "value", ("t1",)), _ok(1), 5, reads=None)
    c.evict_touched(frozenset(), 6)
    assert c.get(("sa", "value", ("t1",)), 6) is None


def test_evict_touched_non_adjacent_rev_clears_all() -> None:
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    c.put(("sa", "value", ("t1",)), _ok(1), 5, reads=frozenset({("el", "zz")}))
    c.evict_touched(frozenset(), 9)  # unknown history between 5 and 9
    assert c.stamp == 9
    assert c.size == 0


def test_survivor_hits_at_new_rev_only() -> None:
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    c.put(("sb", "value", ("t2",)), _ok(2), 5, reads=frozenset({("el", "t2")}))
    c.evict_touched(frozenset({("el", "other")}), 6)
    assert c.get(("sb", "value", ("t2",)), 5) is None  # old rev misses
    assert c.get(("sb", "value", ("t2",)), 6) is not None


def test_put_degrades_oversized_read_set_to_none() -> None:
    """A `put` whose read-set exceeds `_MAX_STORED_READS` must be stored as
    `reads=None` -- the conservative "evict on every commit" direction -- so
    the entry is later dropped by an `evict_touched` call whose touched set
    is disjoint from what the cell actually read."""
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    huge = frozenset(("el", f"t{i}") for i in range(_MAX_STORED_READS + 1))
    c.put(("sa", "value", ("t1",)), _ok(1), 5, reads=huge)
    c.evict_touched(frozenset({("el", "disjoint-from-everything")}), 6)
    assert c.get(("sa", "value", ("t1",)), 6) is None


def test_put_keeps_normal_sized_read_set_unchanged() -> None:
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    reads = frozenset(("el", f"t{i}") for i in range(_MAX_STORED_READS))
    c.put(("sa", "value", ("t1",)), _ok(1), 5, reads=reads)
    c.evict_touched(frozenset({("el", "not-in-reads")}), 6)
    hit = c.get(("sa", "value", ("t1",)), 6)
    assert hit is not None and hit.value == {"kind": "scalar", "value": 1}


def test_put_stale_rev_rejected_after_evict_touched_moves_stamp() -> None:
    """A sweep worker computing against the pre-commit rev must not be able
    to insert a cell that survives at the post-commit rev.

    `evict_touched` (like `clear_and_stamp`) moves `_stamp` forward. A `put`
    that raced in from a worker still computing against the OLD rev must be
    rejected by the same `rev < self._stamp` stale-writer guard `put` already
    enforces against `clear_and_stamp` moves — otherwise a commit landing
    mid-sweep could resurrect a cell computed against discarded model state.
    """
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    c.evict_touched(frozenset(), 6)
    c.put(KEY, _ok(), 5)
    assert c.get(KEY, 6) is None
    assert c.size == 0
