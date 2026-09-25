# Phase 5 — Realtime Feed (WebSocket) — Design

**Date:** 2026-06-17
**Status:** Design approved (pending spec review) → implementation planning
**Scope:** **Spec A** of the Phase 4-frontend + Phase 5-realtime pairing. Delivers a
one-way server→client realtime feed (commit deltas, lock state, presence) over
WebSocket, plus a *thin* client transport store that consumes it. The Phase 4
frontend editing rewire (lock→edit-locally→preview→commit→unlock UI) is **Spec B**,
a separate later cycle that builds on the state this feed exposes.

Master architecture: `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md`
(§4 topology "WS hub", §6 `connected_clients`, §7 step f "BROADCAST", Phase 5 row).

---

## 1. Problem & framing

The Phase 4 backend (check-out/commit + locking) is built and merged. Its plan
explicitly reserved the broadcast hook points:

> "the `acquire`/`release`/commit sites are where the future broadcast hook lands;
> left as a no-op now."

No WebSocket/SSE infrastructure exists anywhere yet (backend or frontend). The
frontend still mutates via the **legacy `/model/ops`** continuous-flush path; the
lock→commit endpoints have no client consumer.

This spec lights up those reserved hook points with a real WebSocket feed and a
thin client transport. It is deliberately **decoupled from the frontend editing
rewire**: the editing UI lands in Spec B and consumes the lock/presence/commit
state this feed exposes.

### Decisions taken in brainstorming

- **Two specs, feed first.** This is Spec A; the frontend editing rewire is Spec B.
- **Transport: WebSocket** (as named in the master design §4/Phase 5), not SSE.
- **Event sources: commit + lock sites only.** Broadcasts originate at `POST /commits`
  and the lock acquire/release/expire sites — *not* the legacy `/model/ops` path.
  Consequence: until Spec B switches the UI to commits, no real-UI action produces
  feed events; the feed is exercised end-to-end by integration tests and the thin
  client store. This is accepted — "feed first" means the feed exists for Spec B
  to build on.
- **WS auth: query-param identity through the existing seam.** Browsers cannot set
  custom headers on a WebSocket handshake, so dev passes identity as a query param
  routed through the same `IdentityProvider`; prod relies on the gateway injecting/
  validating identity on the upgrade.
- **Presence: minimal** — the set of currently-connected users per project (lock
  holders already come from lock state). No live cursors / selection sharing in v1.
- **`commit` event carries the delta, not raw ops** — richer and directly
  consumable by a client holding only a cached subset.
- **Lock-badge rendering is deferred to Spec B**; this spec exposes lock state on
  the client but ships only a minimal connection/presence indicator.

---

## 2. The core challenge — sync mutation path ↔ async WebSocket

The mutation path (`POST /commits`, lock routes, the lifespan lock sweeper) runs
**synchronously** on the threadpool and serializes per-project via the session
`write_mutex`. FastAPI WebSockets are **async** (asyncio). Bridging a sync
producer to async per-connection sockets — without ever blocking the commit
thread — is the central design problem.

### Chosen approach — per-connection queue + sender coroutine (Approach 1)

Each connected client owns a **bounded `asyncio.Queue`** and a **sender coroutine**
that drains the queue to `ws.send_json`. Sync code broadcasts by enqueuing onto
every client's queue via `loop.call_soon_threadsafe(queue.put_nowait, event)`:

- **Non-blocking** — `put_nowait` never waits, so `broadcast()` is safe to call
  while holding `write_mutex`.
- **Backpressure** — the queue is bounded; if it overflows (a client that cannot
  keep up), that client is dropped and closed. It reconnects and re-syncs from the
  reconnect snapshot + a REST reload (§5). A slow client never stalls the producer
  or other clients.
- **Event-loop handle** — captured once at lifespan startup
  (`asyncio.get_running_loop()`) and stored module-level in `feed.py`; the sync
  `broadcast()` uses it for `call_soon_threadsafe`.

### Rejected alternatives

- **Approach 2 — `run_coroutine_threadsafe(ws.send(...))` and wait.** A slow client
  would block the **commit thread** (the broadcast happens on the mutation path).
  Unacceptable.
- **Approach 3 — Redis pub/sub now.** That is Phase 7 (cross-instance fan-out during
  ownership handoff). Single-instance Phase 5 fan-out is in-process; Redis here is
  over-engineering.

---

## 3. Components

### Backend

1. **`api/feed.py` — `FeedHub` (one per `Session`) + event types + loop handle.**
   - `ClientConn`: `{user_id, queue: asyncio.Queue(maxsize=FEED_QUEUE_MAX), ws}`.
   - `FeedHub`: holds the live `ClientConn` set; `register(conn)` / `unregister(conn)`;
     `broadcast(event: dict)` (sync, thread-safe — fans out via `call_soon_threadsafe`,
     dropping any conn whose queue is full); `connected_user_ids() -> set[str]`.
   - Module-level `set_loop(loop)` / `get_loop()` for the captured event loop.
   - `Session` gains a `hub: FeedHub` field (default factory), matching the master
     design's `connected_clients` on `ProjectSession`.

2. **`api/routes/feed.py` — `@router.websocket("/feed")`** mounted under
   `/api/v1/projects/{project_id}` (same prefix as the other data routers).
   Lifecycle: authenticate (§ identity seam) → membership check (close with a
   policy-violation code on 404 unknown / 403 non-member) → `accept()` → register in
   `session.hub` → broadcast `presence{join}` → send the **initial snapshot**
   (`model_rev`, current lock state, connected user ids) → run the sender loop
   (drain queue → `ws.send_json`) until the client disconnects → on disconnect:
   unregister + broadcast `presence{leave}`. Touches `session.last_access` on connect.

3. **Broadcast hooks** at the reserved Phase 4 sites:
   - `routes/commits.py::create_commit` — after the rev bump + journal persist
     (payload built from the same delta as `CommitResponse`), broadcast a `commit`
     event; the lock release in step (g) broadcasts a `lock{released}` event.
   - `routes/locks.py` — `acquire` → `lock{acquired}`; `release` → `lock{released}`;
     `renew` → no event: a TTL extension changes no peer-visible lock state (holder
     and mode are unchanged), so it is not broadcast.
   - **lifespan lock sweeper** — when `LockTable.sweep_expired` removes leases,
     broadcast `lock{expired}` per affected session.

4. **Identity seam extension** — `IdentityProvider.identify(conn)` retyped from
   `Request` to Starlette's `HTTPConnection` (the shared base class of `Request` and
   `WebSocket`; both expose `.headers` and `.query_params`). `DevHeaderIdentityProvider`
   additionally reads `?user_id=` / `?user_email=` query params (the WS-handshake
   equivalent of the dev headers). A WS membership guard mirrors `authz.require_membership`
   (same 404/403 logic, expressed as WS close codes rather than HTTP responses). HTTP
   request handling is unchanged (a `Request` *is* an `HTTPConnection`).

5. **Eviction guard** — `SessionRegistry.evict` refuses to evict a session whose
   `hub` has connected clients, exactly mirroring the existing live-leases guard
   (under `write_mutex`). Prevents dropping a session out from under live feed
   subscribers.

### Frontend (thin transport only)

6. **`lib/api/feed.ts`** — opens the WebSocket to
   `/api/v1/projects/{id}/feed?user_id=...` (dev identity), with auto-reconnect +
   exponential backoff. Pure transport: connect, parse events, surface
   connect/disconnect.

7. **`lib/state/realtime.svelte.ts`** — the feed store. Exposes:
   - `connected` — connection status (for the StatusBar dot).
   - `presence` — set of connected user ids.
   - `lockState` — map `resource_id → {mode, holder_id}` (reduced from `lock` events
     + the initial snapshot). Exposed now; **rendered in Spec B.**
   - applies `commit` delta events into the existing cached-subset model store
     (reusing `state/apply.ts` / `remap.ts`); if the client's cached `model_rev` is
     behind the snapshot's, it triggers the existing REST reload.
   - **No editing-path changes** — the legacy `/model/ops` flush stays exactly as is.

8. **Minimal visible surface** — `StatusBar` gains a connection dot + presence count.
   That is the only UI change in Spec A.

### Config / lifespan

9. Event loop captured at lifespan startup and handed to `feed.set_loop`.
   `DATA_ROVER_FEED_QUEUE_MAX` (bounded per-connection queue; sensible default, e.g.
   256). Reuses the existing lifespan; the lock sweeper gains the expiry broadcast.

---

## 4. Event payloads

```
commit   { type:"commit", rev, commit_id, author_id, message,
           validation_error_count,
           changed_elements:[ElementOut], changed_relationships:[RelationshipOut],
           deleted_element_ids:[...], deleted_relationship_ids:[...] }
         # delta form (mirrors CommitResponse minus caller-specific id_map/issues);
         # a client with only a cached subset applies what it knows, ignores the rest.

lock     { type:"lock", action:"acquired"|"released"|"expired",
           leases:[{ resource_id, mode, holder_id }] }

presence { type:"presence", action:"join"|"leave",
           user_id, connected:[user_id, ...] }
```

Initial snapshot on connect:

```
snapshot { type:"snapshot", model_rev,
           locks:[{ resource_id, mode, holder_id }],
           connected:[user_id, ...] }
```

---

## 5. Data flow, ordering, recovery, errors

- **Flow:** commit (under `write_mutex`, hence rev-ordered) → build delta payload →
  `hub.broadcast(event)` → `loop.call_soon_threadsafe(queue.put_nowait, event)` per
  client → per-connection FIFO queue → sender coroutine → `ws.send_json` → client
  `realtime` store → updates `lockState` / `presence` / cached model subset.
- **Ordering:** commits serialize on `write_mutex`, so enqueue order == rev order;
  per-connection FIFO preserves it to the client. Lock/presence events interleave
  but are independently meaningful.
- **Recovery:** the reconnect snapshot carries the authoritative `model_rev`; a
  client whose cached rev is behind knows it is stale and triggers the existing REST
  reload. Missed events while disconnected need no replay — the snapshot + reload
  resynchronize.
- **Backpressure / errors:** queue full → drop + close that connection; it
  reconnects and re-syncs. Auth failure → close with a policy-violation code before
  `accept()` (or immediately after, per Starlette semantics). Eviction is blocked
  while clients are connected (§3.5).

---

## 6. Testing

- **Backend integration** (`TestClient.websocket_connect`, in-memory SQLite per the
  existing `tests/api/conftest.py`):
  - two clients; one commits via `POST /commits` → the other receives the `commit`
    delta event;
  - lock `acquire`/`release` → `lock` events with correct leases; sweeper expiry →
    `lock{expired}`;
  - presence `join`/`leave` on connect/disconnect; snapshot contents on connect;
  - auth rejection (no/invalid identity, non-member) closes the socket;
  - rev ordering across rapid successive commits;
  - slow/overflowing client is dropped without stalling the producer or peers;
  - eviction is refused while a client is connected.
- **Frontend** (vitest + mock WebSocket): reconnect/backoff; `lockState` and
  `presence` reducers over event sequences; `commit`-delta application into the
  cached subset; stale-rev → reload trigger.

---

## 7. Out of scope (→ Spec B and later phases)

- The lock→edit-locally→preview→commit→unlock **editing UI**, commit-message dialog,
  conformance-error review panel, and **lock-badge rendering** — Spec B.
- Broadcasting on the legacy `/model/ops` path — intentionally excluded (commit +
  lock sites only).
- Live cursors / selection sharing — beyond minimal presence.
- Redis pub/sub / cross-instance fan-out / ownership handoff — Phase 7.
- Metamodel-driven relationship-picker UX, sandbox validate, rebind — Phase 6.
