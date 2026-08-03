from __future__ import annotations

import pytest

from data_rover.api.settings import Settings
from data_rover.api.storage import (
    MemorySnapshotStore,
    SnapshotStore,
    build_store_from_settings,
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


def _spy_gcs(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Record GcsSnapshotStore ctor kwargs without touching google-cloud-storage.

    ``build_store_from_settings`` imports the class inside the function body, so
    patching the attribute on the module is enough — and ``storage_gcs`` keeps
    every google import function-local, so importing it costs nothing.
    """
    calls: list[dict[str, object]] = []

    class _Spy:
        def __init__(self, bucket: str, **kwargs: object) -> None:
            calls.append({"bucket": bucket, **kwargs})

    monkeypatch.setattr("data_rover.api.storage_gcs.GcsSnapshotStore", _Spy)
    return calls


def test_gcs_store_creates_the_bucket_against_an_emulator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The emulator starts with an empty volume and nothing else provisions it."""
    calls = _spy_gcs(monkeypatch)
    build_store_from_settings(
        Settings(
            _env_file=None,  # pyright: ignore[reportCallIssue]
            snapshot_store="gcs",
            storage_emulator_host="http://localhost:4443",
        )
    )
    assert calls == [
        {
            "bucket": "data-rover-snapshots",
            "endpoint": "http://localhost:4443",
            "create_bucket": True,
        }
    ]


def test_gcs_store_never_creates_a_bucket_against_real_gcs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prod must not need ``storage.buckets.create``: no emulator host, no call.

    The gate is the endpoint override, so this is structural rather than a
    convention someone has to remember.
    """
    calls = _spy_gcs(monkeypatch)
    build_store_from_settings(
        Settings(
            _env_file=None,  # pyright: ignore[reportCallIssue]
            snapshot_store="gcs",
            storage_emulator_host="",
        )
    )
    assert calls == [
        {"bucket": "data-rover-snapshots", "endpoint": None, "create_bucket": False}
    ]
