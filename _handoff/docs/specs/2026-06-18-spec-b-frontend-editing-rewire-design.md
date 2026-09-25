# Spec B — Frontend Editing Rewire (lock → edit-locally → preview → commit → unlock) — Design

**Date:** 2026-06-18
**Status:** Design approved (pending spec review) → implementation planning
**Scope:** **Spec B** of the Phase 4-frontend + Phase 5-realtime pairing. Rewires the
SvelteKit frontend from the legacy optimistic **continuous-flush `/model/ops`** path
to the Phase 4 **check-out/commit** flow: a resource is locked on first edit, edits
stage **locally** (no backend traffic), a mandatory **preview** surfaces the
conformance-error count, and **commit** finalizes + releases the locks. Consumes the
lock/presence/commit state the **Spec A** realtime feed already exposes.

Master architecture: `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md`
(§7 editing model, §8 locking, §9 validation tiers, §10 metamodel-driven UX, Phase 4/5 rows).
Spec A (feed): `docs/superpowers/specs/2026-06-17-phase-5-realtime-feed-design.md`.

---

## 1. Problem & framing

The Phase 4 backend (check-out/commit + locking) and the Phase 5 realtime feed are
built and merged. The frontend, however, **still edits via the legacy unlocked
`/model/ops` continuous-flush path** (`state/model.svelte.ts`): every keystroke is
applied optimistically and flushed to the server in debounced batches, with rev-based
409 conflict recovery. The lock/preview/commit endpoints have **no client consumer**;
the Spec A feed exposes lock/presence/commit state that nothing yet renders.

This spec switches the frontend to the collaborative editing loop the rest of the
stack was built for. It is deliberately the **frontend counterpart** of the Phase 4
backend: no new backend behavior except one tiny additive field (§3.6).

### Decisions taken in brainstorming

- **Scope: core loop first, defer polish.** This cycle ships acquire → stage-locally →
  preview → commit (message + error count) → release, plus **minimal lock-badge
  rendering** so contention is visible. Deferred to a follow-up (Spec B2): rich
  conformance-review panel, **steal**/force-release + displaced-holder recovery,
  partial/subset commit UI, commit-history/revert (Phase 8), metamodel-driven picker
  (Phase 6), IndexedDB persistence of uncommitted edits.
- **Lock acquisition: auto-acquire on first edit.** The first interaction with an
  editable surface transparently acquires the required lock(s); a denied lock blocks
  the edit with a "locked by X" note. The check-out is implicit, web-native.
- **Per-element tokens → per-element discard.** Each check-out gesture is its own
  `POST /locks` call → its own token. The client keeps a `resourceId → token`
  registry; "unlock just this element" releases that one token (a **per-element
  abandon**: revert its local edits *and* release its lock), leaving others held.
- **Commit = auto-unlock; explicit abandon; expiry safety net.** A successful commit
  releases the caller's locks (the happy-path unlock). Abandon = `POST /locks/release`
  (discard local edits + free lock). TTL expiry (heartbeat-renewed leases) is the
  safety net for a vanished client.
- **Repurpose the DiffDrawer as the commit-review surface.** The existing "Save (n)"
  badge + DiffDrawer become the staged-edits review + commit panel. "Save to file"
  remains a separate, explicit **export** convenience.
- **Undo: client-side, uncommitted only.** `Cmd+Z` reverts staged local edits over the
  per-op journal (no server call). A committed change is immutable this cycle; reverting
  one is Phase 8 (commit-history/revert). The frontend stops using `POST /model/undo`.
- **Architecture: evolve `model.svelte.ts` in place + a new `checkout` module.** Keep
  its optimistic-apply + journal + `applyDelta` + remap; remove the auto-flush so its
  queue becomes the staged-edits buffer. A new `state/checkout.svelte.ts` owns locks,
  heartbeat, and the commit lifecycle.

---

## 2. Reuse — what the existing store already gives us

`state/model.svelte.ts` was built for the continuous-flush path but already contains
**exactly** the machinery the staged-commit flow needs:

- **Optimistic local apply + per-op revert journal** — `applyOptimistic(op)` mutates
  the caches and returns `RevertEntry[]`; `QueuedOp.revert` stores it; `revertOptimistic`
  replays it newest-first. This is precisely **staging + discard/undo**.
- **Delta application** — `applyDelta(d: OpsResponse)` upserts changed entities, drops
  deleted ids, remaps temp ids, and splices the issue-store delta. `CommitResponse`
  **extends `OpsResponse`**, so a commit response feeds `applyDelta` unchanged (Spec A
  already routes remote commit deltas through it).
- **Temp-id remap** — `remapCaches(idMap)` rewrites caches, selection, *and queued ops*
  on first ack. Unchanged.

The **only** behavior we remove is **auto-draining the queue to `/model/ops`**
(`scheduleFlush`/`flushLoop`/`startFlush`/`flushNow`) and the **server-op-log undo**
(`undo()` via `POST /model/undo`). Everything else is retained verbatim. The queue stops
being a "flush queue" and *becomes* the **staged-edits buffer**, held until commit.

---

## 3. Components

### Frontend

#### 3.1 `state/model.svelte.ts` (CHANGED — surgical)

- `emit(op)`: keep the synchronous optimistic apply + journal; **drop the
  `scheduleFlush(...)` calls**. The op is applied and pushed to the staged buffer; it is
  **not** sent. Property-update coalescing into an already-staged op of the same entity
  is kept (it keeps the buffer compact and the eventual commit batch minimal).
- **Remove** `scheduleFlush`/`flushLoop`/`startFlush`/`flushNow`/`handleFlushError`'s
  409/422-flush semantics, the `_inFlight`/`_flushTimer`/`_flushPromise` machinery, and
  `undo()` (server op-log). `hasPendingOps()` → conceptually "has staged edits"
  (`_queue.length > 0`), feeding the "Commit (n)" badge.
- **Keep** `applyDelta`, `remapCaches`, the journal, all cache-or-fetch reads
  (`ensureElement(s)`, `seedElements`, …), `refreshSummary`/`adoptSummary`,
  `resetModelStore`, `validateAll`.
- New read helpers for the checkout store: `getStagedOps(): Op[]`,
  `getStagedOpsFor(id): Op[]`, `revertStagedFor(id)` (per-element discard over the
  journal), `revertAllStaged()`, `popLastStaged()` (client-side undo). These are thin
  wrappers over the existing `_queue` + `revertOptimistic` (no new revert logic).

#### 3.2 `state/checkout.svelte.ts` (NEW — the editing-session store)

Owns the genuinely-new state and lifecycle:

- **Lock registry** — `SvelteMap<resourceId, { token, mode, intent, ackErrors? }>`,
  authoritative for *my* held tokens (tokens are private to the acquirer — never
  broadcast, so they cannot come from the feed).
- **`ensureCheckout(target: {id}, intent): Promise<{ok:true} | {ok:false, conflicts}>`**
  — the auto-acquire gate. Computes the locks the gesture needs that are **not already
  held** (mirroring `locking.required_locks`; see §4), calls `POST /locks {targets,
  intent}`, records the returned token + leases. On 409 returns the conflict (UI shows
  "locked by X"). DELETE intent sends only the root target — the backend `expand_targets`
  expands the containment subtree server-side and returns all leases; the client records
  them all under the one token.
- **Heartbeat** — a single renew loop, started when the first lock is acquired and
  stopped when the registry empties, firing every `ttl/2` (`ttl` from `OpenResponse`,
  §3.6) and calling `POST /locks/renew` per held token.
- **Commit lifecycle** — `preview()`, `commit(message, ackErrors)`, `discardElement(id)`,
  `discardAll()` (§5).
- **Own-lock-expiry handling** — subscribes to the realtime feed's lock events; a
  `lock{expired}` with `holder_id == me` for a registry resource marks those staged edits
  **stale** and raises a banner (re-check-out or discard).

#### 3.3 `api/checkout.ts` (NEW — REST wrappers)

Thin typed wrappers (style of `api/model-ops.ts`): `open()`, `acquireLocks(targets,
intent)`, `releaseLock(token)`, `renewLock(token)`, `preview(baseRev, ops)`,
`commit({baseRev, ops, message, lockTokens, ackErrors})`. Zod schemas in `api/types.ts`
mirroring `LockRequest`/`LockResponse`/`LeaseOut`/`PreviewRequest`/`PreviewResponse`/
`CommitRequest`/`CommitResponse`/`OpenResponse`.

#### 3.4 `state/realtime.svelte.ts` (Spec A — unchanged contract)

Still the **peer view**: `lockState` (Map `resource_id → {mode, holder_id}`, no tokens)
drives lock badges; `presence`; remote commit deltas via `applyDelta`. Spec B *renders*
the lock state it already reduced. The checkout store reads its lock events for the
own-expiry path (§3.2).

#### 3.5 UI components (existing, repurposed — minimal new surface)

- **Inspector** — auto-acquire integration point. First interaction with a property
  field / relationship picker / `+child` / delete calls `ensureCheckout`; pending →
  brief spinner; success → edits stage; 409 → field stays read-only with a **"Locked by
  {user}"** note. Header shows **"Checked out by you"** vs **"Locked by X"**.
- **DiffDrawer → commit-review panel** — staged **client-side** diff (journal
  before-state vs. current cache; the server has never seen these edits, so this replaces
  the `/model/changes` data source here) + commit-message field + preview error count +
  `[Commit]` / `[Commit anyway]` / `[Review]` / `[Discard all]`, plus a **per-row
  Discard** for per-element abandon.
- **Sidebar tree rows** — minimal **lock badge** from `realtime.lockState`: a lock glyph
  + holder tooltip when held by someone else; a subtle "checked-out-by-you" marker
  otherwise.
- **StatusBar** — **"Commit (n)"** replaces "Save (n)"; keeps Spec A's live/presence
  indicators.
- **TopBar** — "Save to file" stays as an explicit **export** (`/model/download`),
  no longer the primary persistence action.

#### 3.6 Backend touch (the only one)

Add `lock_ttl_seconds: int` to `OpenResponse` (sourced from `settings.lock_ttl_seconds`)
so the client heartbeat self-tunes to `ttl/2` rather than hardcoding. Additive, no
behavior change to existing endpoints. (Necessary because lease `expires_at` is a
server `time.monotonic()` value, meaningless to the client clock.)

---

## 4. Lock-scope derivation (client mirror)

The client decides what to lock for a gesture by mirroring the per-op rules in
`api/locking.py::required_locks`, acquiring only what is **not already held**:

| Gesture | Lock request |
|---|---|
| edit element property | EXCLUSIVE on element, intent `edit` |
| edit relationship property | EXCLUSIVE on its **source** element, intent `edit` |
| create free-floating element | none (temp id; not yet shared) |
| create child under parent P | EXCLUSIVE on P, intent `create_child` |
| connect A→B | EXCLUSIVE on A (source) + SHARED pin on B (target), intent `connect` |
| delete element E | EXCLUSIVE on E **+ subtree**, intent `delete` — send root only; backend expands |
| delete relationship A→B | EXCLUSIVE on A (source), intent `delete` |

Subtree expansion for delete is **not** replicated client-side (it needs the full
containment graph); the client sends the root with `intent: "delete"` and the backend
`expand_targets` returns the full lease set. The client never needs a perfect prediction:
at commit the backend recomputes `required_locks(model, ops)` and `verify_held` checks
the caller holds each under one of the supplied tokens — so passing **all** held tokens
at commit is sufficient and correct.

---

## 5. Editing flows

### Stage (edit)

```
gesture → checkout.ensureCheckout(target, intent)
            POST /locks {targets,intent} → token+leases   (registry += token)
            on 409 → "locked by X"; gesture read-only; nothing staged
        → model.emit(op)   optimistic apply + journal, STAGED (no flush)
```

### Commit

```
Cmd/Ctrl+S or Commit → open DiffDrawer (commit-review)
  preview()  POST /commits/preview {base_rev: liveRev, ops: stagedOps}
             → conformance_error_count, structural_blockers[], issues[]
  drawer states:
    clean                        → [Commit]
    conformance_error_count > 0  → "N validation issues  [Commit anyway] [Review]"
    structural_blockers present  → commit DISABLED, blocker shown (rare)
  commit()  POST /commits {base_rev: liveRev, ops, message,
                           lock_tokens: allMyTokens, ack_errors}
            → CommitResponse → model.applyDelta(response)
            → clear staged buffer + clear lock registry (server released them)
            → stop heartbeat if registry now empty
```

- **`base_rev` is the live `getModelRev()`** — kept current by the Spec A feed as peers
  commit. Local edits + held locks make committing at the advanced rev safe; a 409 then
  signals only a genuine race (§6).
- Core loop commits **all** staged edits; you curate by **discarding** unwanted ones
  first. Partial/subset commit UI is deferred.

### Discard (per-element abandon — the requested capability)

```
checkout.discardElement(id):
  1. model.revertStagedFor(id)         # revert + drop that element's ops (journal)
  2. POST /locks/release {token}       # release that element's token
  3. registry -= token
  (other locked+edited elements untouched)
discardAll(): model.revertAllStaged() + release every token + clear registry
```

### Undo (client-side, uncommitted only)

`Cmd/Ctrl+Z` → `model.popLastStaged()` reverts the last staged op over the journal — no
server call. **Lock is kept held** even when an element's last staged edit is undone
(you stay checked out until explicit discard/commit; avoids re-acquire churn). The
frontend no longer calls `POST /model/undo`; `_undoDepth`/server-op-log undo leave the
frontend.

### Own-lock expiry (safety net)

Feed `lock{expired}` with `holder_id == me` for a registry resource → mark those staged
edits **stale**, banner: *"Your lock on X expired — re-check-out to keep editing, or
discard."* Re-check-out = `ensureCheckout` again (succeeds if untaken); discard = the
per-element abandon above. No silent data loss.

---

## 6. Error handling

| Event | Handling |
|---|---|
| Lock acquire **409** (conflict) | Inspector shows "Locked by X"; gesture stays read-only; nothing staged. |
| Commit **409** (stale base_rev) | Rare race (feed normally keeps rev live). Refresh rev/summary; **keep** staged edits + locks; prompt "Model moved — retry commit". |
| Commit **422** (structural blocker) | Surface the blocker in the drawer; keep edits + locks; user discards/fixes. Shouldn't occur normally (pins/frontend prevent). |
| Preview **conformance** errors | Counted, never blocks: "Commit anyway / Review". |
| Own lock **expired** (feed) | Banner: re-check-out or discard (§5). |
| Lock **renew** failure | Treat as expiry of that token (banner path). |

The legacy continuous-flush 409/422 recovery (drop-queue conflict state, in-flight-batch
rollback) is removed with the flush path; its rollback *primitive* (`revertOptimistic`)
is retained and reused by discard/undo.

---

## 7. Role gating (viewer)

`OpenResponse.role`. `viewer` → editing gestures disabled, Inspector read-only, no
checkout; a "view-only" indicator is shown. `editor`/`owner` edit normally. The backend
already 403s a viewer write — this is the client-side guardrail (defense in depth).

---

## 8. Testing

Mirrors Spec A's frontend test setup (vitest + happy-dom + MSW + mock WebSocket).

- **`checkout.svelte.ts`** — auto-acquire on first edit; 409 keeps the gesture
  read-only; heartbeat renew loop fires on schedule and stops when the registry empties;
  per-element discard reverts the journal + releases **only** that token (others stay);
  commit clears the buffer + registry; own-lock-expiry banner path; renew-failure path.
- **Staged buffer (`model.svelte.ts`)** — `emit` stages without any flush; client-side
  undo reverts the last op and **keeps** the lock; staged diff equals journal
  before/after; `getStagedOps`/`revertStagedFor`/`revertAllStaged` correctness.
- **Commit flow** — preview→commit happy path applies the `CommitResponse` delta;
  conformance-error gate ("commit anyway" sends `ack_errors`); structural-blocker
  disables commit; commit-409 retry keeps edits + locks.
- **Lock badges** — `realtime.lockState` renders the peer badge; own check-out marker.
- **Playwright smoke (extend)** — check out → edit → commit → change lands; with a second
  browser context (if feasible) a lock badge appears on the peer.
- **Backend** — one test for the additive `OpenResponse.lock_ttl_seconds` field.

---

## 9. Out of scope (→ Spec B2 / later phases)

- **Steal / force-release** + displaced-holder conflict recovery — Spec B2.
- **Rich conformance-review panel** beyond the issue list — Spec B2.
- **Partial/subset commit UI** (backend already supports it via selective
  `ops`+`lock_tokens`) — Spec B2.
- **Commit-history browser & revert-to-commit**, optional strict-mode — Phase 8.
- **Metamodel-driven relationship-picker filtering + multiplicity gray-out + escape
  hatch**, sandbox-validate, rebind — Phase 6.
- **IndexedDB persistence** of uncommitted local edits across a browser crash — deferred
  (master §13.6, YAGNI for v1).
- **Broadcasting / consuming the legacy `/model/ops` path** — that path is retired on the
  frontend; the backend endpoint remains for other callers/tests.
