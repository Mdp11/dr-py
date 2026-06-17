from __future__ import annotations

import pytest

from data_rover.api.storage import (
    MemorySnapshotStore,
    SnapshotStore,
    get_snapshot_store,
    set_snapshot_store,
    snapshot_key,
)


def test_snapshot_key_scheme() -> None:
    assert snapshot_key("p1", 7) == "projects/p1/snapshots/7.json"


def test_memory_put_get_roundtrip() -> None:
    store: SnapshotStore = MemorySnapshotStore()
    store.put("k", [b'{"a":', b"1}"])
    assert store.get("k") == b'{"a":1}'
    assert store.exists("k") is True


def test_memory_get_missing_raises() -> None:
    store = MemorySnapshotStore()
    assert store.exists("nope") is False
    with pytest.raises(KeyError):
        store.get("nope")


def test_memory_delete_is_idempotent() -> None:
    store = MemorySnapshotStore()
    store.put("k", [b"x"])
    store.delete("k")
    store.delete("k")  # no error on second delete
    assert store.exists("k") is False


def test_store_seam_set_get_reset() -> None:
    custom = MemorySnapshotStore()
    set_snapshot_store(custom)
    assert get_snapshot_store() is custom
    set_snapshot_store(None)  # reset
