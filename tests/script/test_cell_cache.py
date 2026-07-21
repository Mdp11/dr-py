"""ScriptCellCache: rev stamping, LRU, error-kind filtering (spec §3.1)."""

from data_rover.core.script.cell_cache import ScriptCellCache
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
