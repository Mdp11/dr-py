"""Redis ``LeaseMirror`` — isolates the ``redis`` import the way
``storage_gcs.py`` isolates ``google-cloud-storage``.

Degrade-graceful by construction (spec posture: optional mirror): short
socket timeouts so a down Redis costs at most ~1s once, then a cooldown so it
costs nothing for the next ~30s; up→down and down→up transitions each log
exactly once, never per call. Errors are swallowed HERE as well as in the
``mirror_session_leases`` catch-all — two layers on purpose, so neither a
route nor hydration can ever fail because of the mirror.

Data model: one key per project (``dr:leases:{project_id}``) holding a JSON
envelope ``{"v": 1, "leases": [...]}`` written wholesale, with a key TTL of
(latest lease expiry - now) + 60s slack so an orphaned mirror self-cleans; an
empty set is a DEL. Leases are TTL-bounded (<= lock_ttl_seconds), so Redis
persistence is deliberately not required — a Redis restart is
indistinguishable from ordinary lease expiry."""

from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import asdict
from typing import cast

from .lock_mirror import ENVELOPE_VERSION, KEY_TTL_SLACK_S, MirroredLease, lease_key

logger = logging.getLogger(__name__)


class RedisLeaseMirror:
    def __init__(
        self,
        url: str,
        *,
        cooldown_s: float = 30.0,
        socket_timeout_s: float = 1.0,
    ) -> None:
        import redis

        self._errors: tuple[type[Exception], ...] = (redis.RedisError, OSError)
        self._client = redis.Redis.from_url(
            url,
            socket_timeout=socket_timeout_s,
            socket_connect_timeout=socket_timeout_s,
            decode_responses=True,
        )
        self._cooldown_s = cooldown_s
        self._down_until = 0.0  # monotonic; 0 == not in cooldown
        self._down = False

    # ---- degradation bookkeeping -----------------------------------------

    def _in_cooldown(self) -> bool:
        return time.monotonic() < self._down_until

    def _mark_down(self, exc: Exception) -> None:
        self._down_until = time.monotonic() + self._cooldown_s
        if not self._down:
            self._down = True
            logger.warning("lease mirror: Redis unavailable, degrading: %s", exc)

    def _mark_up(self) -> None:
        if self._down:
            self._down = False
            logger.info("lease mirror: Redis recovered")

    # ---- LeaseMirror ------------------------------------------------------

    def write(self, project_id: str, leases: list[MirroredLease]) -> None:
        if self._in_cooldown():
            return
        key = lease_key(project_id)
        try:
            if not leases:
                self._client.delete(key)
            else:
                ttl = (
                    max(le.expires_at_epoch for le in leases)
                    - time.time()
                    + KEY_TTL_SLACK_S
                )
                if ttl <= 0:
                    self._client.delete(key)
                else:
                    payload = json.dumps(
                        {
                            "v": ENVELOPE_VERSION,
                            "leases": [asdict(le) for le in leases],
                        }
                    )
                    self._client.set(key, payload, ex=math.ceil(ttl))
            self._mark_up()
        except self._errors as exc:
            self._mark_down(exc)

    def load(self, project_id: str) -> list[MirroredLease]:
        if self._in_cooldown():
            return []
        try:
            # redis-py's stub return type is shared between sync and async
            # clients (``ResponseT`` includes ``Awaitable``); this instance is
            # always sync (decode_responses=True), so the real runtime type
            # is `str | None`.
            raw = cast("str | None", self._client.get(lease_key(project_id)))
            self._mark_up()
        except self._errors as exc:
            self._mark_down(exc)
            return []
        if raw is None:
            return []
        try:
            doc = json.loads(raw)
            if doc.get("v") != ENVELOPE_VERSION:
                logger.warning(
                    "lease mirror: unknown envelope version %r for project %s",
                    doc.get("v"),
                    project_id,
                )
                return []
            return [MirroredLease(**entry) for entry in doc["leases"]]
        except (ValueError, TypeError, KeyError) as exc:
            logger.warning(
                "lease mirror: undecodable payload for project %s: %s",
                project_id,
                exc,
            )
            return []
