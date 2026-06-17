from __future__ import annotations

import os
import socket

import pytest

from data_rover.api.storage_gcs import GcsSnapshotStore


class _FakeBlob:
    def __init__(self, store: dict[str, bytes], name: str) -> None:
        self._store, self._name = store, name

    def upload_from_file(self, fileobj) -> None:  # noqa: ANN001
        self._store[self._name] = fileobj.read()

    def download_as_bytes(self) -> bytes:
        if self._name not in self._store:
            from google.cloud.exceptions import NotFound

            raise NotFound(self._name)
        return self._store[self._name]

    def exists(self) -> bool:
        return self._name in self._store

    def delete(self) -> None:
        from google.cloud.exceptions import NotFound

        if self._name not in self._store:
            raise NotFound(self._name)
        del self._store[self._name]


class _FakeBucket:
    def __init__(self, store: dict[str, bytes]) -> None:
        self._store = store

    def blob(self, name: str) -> _FakeBlob:
        return _FakeBlob(self._store, name)


class _FakeClient:
    def __init__(self) -> None:
        self._store: dict[str, bytes] = {}

    def bucket(self, name: str) -> _FakeBucket:  # noqa: ARG002
        return _FakeBucket(self._store)


def test_gcs_put_get_roundtrip_with_fake_client() -> None:
    store = GcsSnapshotStore("b", client=_FakeClient())
    store.put("k", [b"{", b"}"])
    assert store.get("k") == b"{}"
    assert store.exists("k") is True


def test_gcs_get_missing_raises_keyerror() -> None:
    store = GcsSnapshotStore("b", client=_FakeClient())
    assert store.exists("k") is False
    with pytest.raises(KeyError):
        store.get("k")


def test_gcs_delete_is_idempotent() -> None:
    store = GcsSnapshotStore("b", client=_FakeClient())
    store.put("k", [b"x"])
    store.delete("k")
    store.delete("k")  # NotFound swallowed
    assert store.exists("k") is False


def _emulator_up(host: str) -> bool:
    h, _, p = host.partition(":")
    try:
        with socket.create_connection((h, int(p or 4443)), timeout=0.25):
            return True
    except OSError:
        return False


@pytest.mark.integration
def test_gcs_real_roundtrip_against_emulator() -> None:
    host = os.environ.get("STORAGE_EMULATOR_HOST", "localhost:4443")
    if not _emulator_up(host):
        pytest.skip(f"fake-gcs-server not reachable at {host}")
    os.environ["STORAGE_EMULATOR_HOST"] = host
    store = GcsSnapshotStore(
        "data-rover-test", endpoint=f"http://{host}", create_bucket=True
    )
    store.put("projects/p/snapshots/0.json", [b'{"elements":[],"relationships":[]}'])
    assert store.get("projects/p/snapshots/0.json").startswith(b'{"elements"')
    store.delete("projects/p/snapshots/0.json")
