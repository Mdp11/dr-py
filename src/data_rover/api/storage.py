"""Blob store for full-model snapshots (Phase 3 durable persistence).

The model is ~80 MB, so writes stream (``put`` takes an iterable of byte
chunks straight from ``serialize.iter_model_json``) and reads buffer the whole
blob (``get`` returns bytes; hydration then ``json.loads`` +
``build_model_from_dicts`` — identical to today's ``POST /model/upload``).

One Protocol, two impls: ``GcsSnapshotStore`` (the real one — dev points it at
a fake-gcs-server emulator, prod at GCS) and ``MemorySnapshotStore`` (hermetic
tests). The active store is a process-global behind a getter/setter seam,
mirroring ``identity.get_identity_provider`` / ``set_identity_provider``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol
from collections.abc import Iterable

if TYPE_CHECKING:
    from .settings import Settings

#: blob key for one project's snapshot at a given rev
_SNAPSHOT_KEY = "projects/{project_id}/snapshots/{rev}.json"


def snapshot_key(project_id: str, rev: int) -> str:
    return _SNAPSHOT_KEY.format(project_id=project_id, rev=rev)


class SnapshotStore(Protocol):
    def put(self, key: str, chunks: Iterable[bytes]) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...


class MemorySnapshotStore:
    """In-process store backed by a dict. Tests + non-GCS internal callers."""

    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}

    def put(self, key: str, chunks: Iterable[bytes]) -> None:
        self._blobs[key] = b"".join(chunks)

    def get(self, key: str) -> bytes:
        return self._blobs[key]  # KeyError on miss — see test

    def exists(self, key: str) -> bool:
        return key in self._blobs

    def delete(self, key: str) -> None:
        self._blobs.pop(key, None)  # idempotent

    def clear(self) -> None:
        self._blobs.clear()


_store: SnapshotStore | None = None


def get_snapshot_store() -> SnapshotStore:
    """Process-global store, built from settings on first use."""
    global _store
    if _store is None:
        from .settings import get_settings

        _store = build_store_from_settings(get_settings())
    return _store


def set_snapshot_store(store: SnapshotStore | None) -> None:
    """Swap the store (``None`` resets to a settings-built default on next get).

    Tests MUST reset (``set_snapshot_store(None)``) on teardown — the store is a
    process-global singleton; the API conftest does this automatically.
    """
    global _store
    _store = store


def build_store_from_settings(settings: Settings) -> SnapshotStore:
    if settings.snapshot_store == "memory":
        return MemorySnapshotStore()
    if settings.snapshot_store == "gcs":
        from .storage_gcs import GcsSnapshotStore

        return GcsSnapshotStore(
            settings.gcs_bucket,
            endpoint=settings.storage_emulator_host or None,
        )
    raise ValueError(f"unknown snapshot_store {settings.snapshot_store!r}")
