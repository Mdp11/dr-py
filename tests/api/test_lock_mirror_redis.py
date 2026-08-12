"""RedisLeaseMirror against a real Redis (integration-marked; needs the
compose service: `pixi run services-start`). Deselected by default via
pytest.ini's `-m "not integration"`, run explicitly with `-m integration`.
Mirrors the fake-gcs pattern in test_storage_gcs.py."""

from __future__ import annotations

import time
import uuid

import pytest

from data_rover.api.lock_mirror import MirroredLease, lease_key
from data_rover.api.lock_mirror_redis import RedisLeaseMirror

pytestmark = pytest.mark.integration

_URL = "redis://localhost:6379/0"


@pytest.fixture
def raw_redis():
    redis = pytest.importorskip("redis")
    client = redis.Redis.from_url(_URL, socket_connect_timeout=1)
    try:
        client.ping()
    except Exception:
        pytest.skip("redis not reachable on localhost:6379")
    return client


def test_write_load_roundtrip_ttl_and_delete(raw_redis) -> None:
    mirror = RedisLeaseMirror(_URL)
    pid = f"it-{uuid.uuid4().hex[:8]}"
    lease = MirroredLease(
        resource_id="e1", mode="exclusive", holder="u1", token="tok1",
        intent="edit", expires_at_epoch=time.time() + 120.0,
        holder_email="u1@example.com",
    )
    try:
        mirror.write(pid, [lease])
        assert mirror.load(pid) == [lease]
        # key TTL: bounded by remaining lease lifetime + slack (60s)
        ttl = raw_redis.ttl(lease_key(pid))
        assert 0 < ttl <= 120 + 61
        mirror.write(pid, [])  # empty set deletes the key
        assert raw_redis.get(lease_key(pid)) is None
        assert mirror.load(pid) == []
    finally:
        raw_redis.delete(lease_key(pid))


def test_key_prefix_namespaces_deployments(raw_redis) -> None:
    pid = f"it-{uuid.uuid4().hex[:8]}"
    a = RedisLeaseMirror(_URL, key_prefix="site-a:")
    b = RedisLeaseMirror(_URL, key_prefix="site-b:")
    lease = MirroredLease(
        resource_id="e1", mode="exclusive", holder="u1", token="tok1",
        intent="edit", expires_at_epoch=time.time() + 120.0,
    )
    try:
        a.write(pid, [lease])
        assert a.load(pid) == [lease]
        assert b.load(pid) == []  # site-b never sees site-a's leases
        assert raw_redis.get(lease_key(pid, prefix="site-a:")) is not None
        assert raw_redis.get(lease_key(pid)) is None  # unprefixed untouched
    finally:
        raw_redis.delete(lease_key(pid, prefix="site-a:"))


def test_load_tolerates_unknown_envelope_version(raw_redis) -> None:
    mirror = RedisLeaseMirror(_URL)
    pid = f"it-{uuid.uuid4().hex[:8]}"
    try:
        raw_redis.set(lease_key(pid), '{"v": 999, "leases": []}')
        assert mirror.load(pid) == []
    finally:
        raw_redis.delete(lease_key(pid))


def test_load_tolerates_valid_json_non_object_payload(raw_redis) -> None:
    # A bare JSON array (e.g. hand-written via redis-cli) decodes fine but
    # has no .get() — this must be caught as an undecodable payload (the
    # AttributeError case), not escape to the restore_leases catch-all.
    mirror = RedisLeaseMirror(_URL)
    pid = f"it-{uuid.uuid4().hex[:8]}"
    try:
        raw_redis.set(lease_key(pid), "[1, 2, 3]")
        assert mirror.load(pid) == []
    finally:
        raw_redis.delete(lease_key(pid))
