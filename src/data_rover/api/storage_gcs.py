"""GCS-backed snapshot store (the real impl for dev + prod).

Dev points the standard ``google-cloud-storage`` client at a fake-gcs-server
emulator (``endpoint=`` / ``STORAGE_EMULATOR_HOST``) with anonymous creds; prod
uses default creds against real GCS. The code path is identical — only the
endpoint and credentials differ — which is the whole point of using a GCS
emulator locally rather than a bespoke filesystem store.
"""

from __future__ import annotations

import io
from typing import Any
from collections.abc import Iterable


class GcsSnapshotStore:
    def __init__(
        self,
        bucket: str,
        *,
        client: Any | None = None,
        endpoint: str | None = None,
        create_bucket: bool = False,
    ) -> None:
        _client: Any = _make_client(endpoint) if client is None else client
        self._client = _client
        self._bucket_name = bucket
        if create_bucket:
            # emulator convenience; ignore "already exists"
            from google.cloud.exceptions import Conflict

            try:
                _client.create_bucket(bucket)
            except Conflict:
                pass
        self._bucket = _client.bucket(bucket)

    def put(self, key: str, chunks: Iterable[bytes]) -> None:
        # buffer the chunks then upload: the google client's resumable upload
        # wants a seekable file-like; one transient bytes buffer at ~80 MB is
        # the same memory profile as today's upload route (an accepted cost).
        self._bucket.blob(key).upload_from_file(io.BytesIO(b"".join(chunks)))

    def get(self, key: str) -> bytes:
        from google.cloud.exceptions import NotFound

        try:
            return self._bucket.blob(key).download_as_bytes()
        except NotFound as exc:
            raise KeyError(key) from exc

    def exists(self, key: str) -> bool:
        return bool(self._bucket.blob(key).exists())

    def delete(self, key: str) -> None:
        from google.cloud.exceptions import NotFound

        try:
            self._bucket.blob(key).delete()
        except NotFound:
            pass  # idempotent


def _make_client(endpoint: str | None) -> Any:
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import storage  # type: ignore[attr-defined]

    if endpoint:
        # emulator: anonymous creds + endpoint override
        return storage.Client(
            project="data-rover",
            credentials=AnonymousCredentials(),
            client_options={"api_endpoint": endpoint},
        )
    return storage.Client()
