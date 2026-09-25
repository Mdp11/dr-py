# Redis lock mirroring (Phase 7, scoped) — design

Date: 2026-08-11
Status: approved (user-reviewed section by section)

## Context

`LockTable` leases (`src/data_rover/api/locking.py`) live only in the per-project
in-memory `Session`. A backend restart loses every lease while clients still hold
tokens and staged edits: their heartbeats (`POST /locks/renew`) come back
`ok: false`, and a commit of already-staged work 409s "required lock not held"
until they re-acquire — losing the pessimistic guarantee the lease existed for.
The master architecture spec (2026-06-16, §8) always intended leases to be
"mirrored to Redis for visibility/recovery".

**Scope decision (user):** this phase is *lock mirroring only*. The
single-instance assumption stays; the rest of the master spec's Phase 7
(ownership leases, affinity routing, graceful handoff — "option 1") is a
**future phase** that this design must not obstruct, and the seam introduced
here is where that work will plug in.

## Goal

Resource leases survive a backend restart and are observable from outside the
process (redis-cli), with zero change to lock semantics, zero frontend change,
and zero new hard runtime dependency.

Success criteria:
- A client holding a token before a backend restart can keep renewing the same
  token afterwards; its staged work commits without re-acquiring.
- The conflict matrix honors restored leases exactly as it honored the originals.
- With `DATA_ROVER_REDIS_URL` unset, or Redis down, everything behaves exactly
  as today (in-process only), with warnings — never errors — from the mirror.

## Non-goals (deferred)

- Redis-authoritative locking, ownership leases, affinity routing, handoff,
  cross-instance feed fan-out — the future "full HA" phase.
- The overlap-staleness completeness debt noted at `routes/commits.py:306`.
- Any frontend work.
- Redis persistence tuning: every lease is TTL-bounded (≤ `lock_ttl_seconds`,
  default 300s), so a Redis restart is indistinguishable from ordinary lease
  expiry. The compose service is volume-less on purpose.

## Approach (decided)

**Write-through mirror + hydrate-time restore.** `LockTable` remains the sole
authority for every conflict decision and is itself untouched and
mirror-unaware. After each successful lease mutation, the caller mirrors the
project's *entire* live lease set wholesale; on session hydration the fresh
`LockTable` is seeded from the mirror. Whole-set rewrite is idempotent and
self-healing (the repo's whole-blob stance, cf. view persistence); lease sets
are human-scale and mutations human-frequency, so per-lease Redis structures
would buy nothing.

Rejected: Redis-authoritative table (network hop + Lua in every decision;
contradicts the single-instance scope); durable lease journal (a log is the
wrong shape for ephemeral TTL state).

## Architecture

### The `LeaseMirror` seam — `src/data_rover/api/lock_mirror.py`

Follows the `SnapshotStore` precedent (`storage.py` / `storage_gcs.py`):

```python
@dataclass(frozen=True)
class MirroredLease:
    resource_id: str
    mode: str            # LockMode.value
    holder: str
    token: str
    intent: str          # LockIntent.value
    expires_at_epoch: float   # wall clock (time.time()), NOT monotonic
    holder_email: str

class LeaseMirror(Protocol):
    def write(self, project_id: str, leases: list[MirroredLease]) -> None: ...
    def load(self, project_id: str) -> list[MirroredLease]: ...
```

Two methods only — the mirror receives snapshots of truth and answers them
back; it has no acquire/release/renew vocabulary and never participates in a
decision. `write` with an empty list deletes the key.

Implementations:
- `RedisLeaseMirror` — `lock_mirror_redis.py`, isolating the `redis` import the
  way `storage_gcs.py` isolates `google-cloud-storage`.
- `MemoryLeaseMirror` — hermetic tests (dict keyed by project id).
- `NullLeaseMirror` — no-op; the default when `redis_url` is empty.

`build_mirror_from_settings(settings) -> LeaseMirror` chooses at boot
(cf. `build_store_from_settings`).

### Redis data model

- One key per project: `dr:leases:{project_id}`.
- Value: JSON envelope `{"v": 1, "leases": [MirroredLease...]}`. Unknown
  version at load ⇒ treat as empty (log a warning).
- Written with `SET` plus a key TTL of `(max expires_at_epoch − now) + 60s`
  slack, so an orphaned mirror self-cleans; empty set ⇒ `DEL`.

### Clock mapping (the subtle piece)

`Lease.expires_at` is `time.monotonic()` — meaningless across processes.
Conversion happens only at the mirror boundary, in the helper:

- **write:** `remaining = expires_at − time.monotonic()`;
  `expires_at_epoch = time.time() + remaining`.
- **restore:** `remaining = expires_at_epoch − time.time()`; skip if
  `remaining <= 0`; else `expires_at = time.monotonic() + remaining`.

Restored leases keep their original `token`, `holder`, `mode`, `intent`, and
`holder_email` — token continuity across restart is the point of the phase.

## Integration points

A small helper in `lock_mirror.py`:

```python
def mirror_leases(mirror: LeaseMirror, project_id: str, table: LockTable) -> None:
    # snapshot table.active_leases(time.monotonic()), convert clocks,
    # mirror.write(...) — inside a catch-all (see Degradation).
```

Called after each of the five truth mutations:
1. `routes/locks.py` `POST /locks` — successful acquire (steal included: the
   post-acquire snapshot naturally reflects evicted peer leases).
2. `routes/locks.py` `POST /locks/release`.
3. `routes/locks.py` `POST /locks/renew` — also the self-heal path: client
   heartbeats at ttl/2 refresh a stale mirror after a Redis outage.
4. `routes/commits.py` `create_commit` success-path token release (step g) —
   covers every commit caller, `artifact_bundle` included.
5. The lifespan lock-sweeper (`main.py`) — only when `sweep_expired` actually
   removed something.

`_live`'s incidental pruning does not mirror; expired entries are skipped at
restore and the key TTL self-cleans, so a write there would be redundant.

### Restore

`main.py` currently wires `_registry.set_loader(hydrate_session)`. It will
compose the loader instead: run `hydrate_session(project_id)`, then seed
`session.lock_table` from `mirror.load(project_id)` (clock-converted, expired
entries skipped). Sessions built without the loader (bare `Session()` in
tests, `get_session()` default-project setups) are untouched.

Unchanged by design:
- Eviction still skips while leases are live (`SessionRegistry.evict` guard);
  eviction never clears the mirror (the leases stay live and restorable).
- Feed behavior: a restart drops every WS; reconnecting clients receive the
  restored lock state through the existing snapshot event. No new events.
- `LockTable` semantics, wire contracts, and the frontend: untouched.

## Degradation (approved posture: optional mirror, degrade gracefully)

- `RedisLeaseMirror` uses short socket/connect timeouts (~1s) and a cooldown:
  after a failure, log one warning and skip attempts for ~30s, then retry.
  Down→up and up→down transitions log once each; no per-call spam.
- `mirror_leases` and the restore path additionally wrap the mirror in a
  catch-all `except Exception`: no lock route, commit, sweep, or hydration can
  ever fail because of the mirror.
- `load` failure ⇒ log + empty list — identical to today's cold start.
- Consequence accepted: a mirror can lag truth during an outage; the renew
  heartbeat re-converges it within ttl/2 for any lease still held.

## Settings, dependency, services

- `Settings.redis_url: str = ""` (`DATA_ROVER_REDIS_URL`), e.g.
  `redis://localhost:6379/0`. Empty ⇒ `NullLeaseMirror`. This is the only new
  setting.
- `redis-py` joins `[feature.api.dependencies]` in `pixi.toml`.
- `docker-compose.yml` gains a `redis:7` service (port 6379, healthcheck,
  **no volume** — see Non-goals). Compose header comment updated: Redis is the
  coordination plane, contents owned by the app.
- Docs: QUICKSTART service list; `CLAUDE.md` locking bullet gains the mirror
  sentence.
- Separate one-line docs commit (adjacent correction, discovered this
  session): `CLAUDE.md`'s claim that `/model/ops` + `/model/undo` "remain the
  legacy unlocked path until the frontend migrates" is stale — the frontend is
  fully on the check-out/commit flow (`checkout.svelte.ts`, staged buffers,
  `POST /commits`; the legacy wrappers `applyOps`/`undoOps` have zero non-test
  callers). Correct the claim; do not remove the routes in this phase.

## Testing

Hermetic (no Redis service; `MemoryLeaseMirror` / stubs):
- Round-trip: leases → `mirror_leases` → `load` → seed → equality modulo the
  monotonic↔epoch conversion (tolerances, no fake clock needed).
- Restore-on-hydrate through a composed loader: acquire on session A, build a
  fresh registry + loader, verify on session B that (a) `POST /locks/renew`
  with the original token answers `ok: true`, (b) `GET /locks` lists the
  leases, (c) the conflict matrix blocks a peer exactly as before the
  "restart".
- Expired-at-restore entries are skipped.
- Degradation: a mirror whose `write`/`load` raises never fails `POST /locks`
  or hydration; warning logged.
- Envelope versioning: unknown `v` loads as empty.
- Default suite: `redis_url` empty ⇒ `NullLeaseMirror` ⇒ zero behavior change
  anywhere else.

Integration (one test, `integration`-marked, needs `pixi run services-start`'s
Redis — the `fake-gcs` / wasm pattern):
- `RedisLeaseMirror` write → load round-trip against real Redis; key TTL set;
  empty write deletes the key.

## Future (explicitly noted for the option-1 migration)

When the full HA phase lands: the `LeaseMirror` seam is where ownership
awareness enters (the mirror key becomes part of the project-ownership
namespace); `RedisLeaseMirror` already owns the Redis client lifecycle that
ownership leases and handoff pub/sub will share; and the loader-composed
restore is the template for adopting a project's coordination state on
ownership transfer. Nothing in this phase hard-codes "one instance" beyond
what Phase 4 already assumed.
