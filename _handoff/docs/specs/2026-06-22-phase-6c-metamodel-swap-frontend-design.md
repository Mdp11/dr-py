# Phase 6C — Metamodel-Swap Frontend (diff review + rebind) — Design

**Date:** 2026-06-22
**Status:** Design approved → spec review → implementation planning
**Scope:** Frontend (SvelteKit) + two small folded-in backend follow-ups.
**Parent design:** `docs/superpowers/specs/2026-06-22-phase-6b-metamodel-swap-design.md`
(the backend half — `/metamodel/diff`, `/metamodel/rebind`, initial-bind guard, `rebind_event`).

---

## 1. Problem & goal

Phase 6B shipped the backend metamodel-swap (sandbox conformance diff + non-destructive
journaled rebind) and explicitly deferred the UI to a follow-up. Phase 6C delivers that UI:

- Let any **member** upload a *candidate* metamodel and view the read-only sandbox
  conformance diff (`POST /metamodel/diff`): `now_failing` / `now_passing` / `unchanged`.
- Let an **owner** adopt the candidate via a non-destructive rebind
  (`POST /metamodel/rebind`), with a confirmation that surfaces the preconditions and the
  fact that a rebind may land with outstanding conformance issues (the engine stays
  inspectable).
- Handle the peer-side `rebind_event` so other connected clients learn the model was
  retyped and can reload.

Two backend follow-ups (flagged during brainstorming) are folded in (§4).

**Non-goals:** editable sandbox branch, assisted migration transforms, rebind *revert*
UI (the backend keeps `from/to_metamodel_id` for Phase 8), and any change to the
check-out/commit editing loop.

---

## 2. Decisions (from brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Dedicated `SwapMetamodelDrawer` launched from the TopBar.** | Isolates the multi-step pick→diff→confirm flow; mirrors the existing `DiffDrawer` idiom; keeps the transient sandbox diff out of the main workspace. |
| 2 | **Diff available to all members; rebind owner-only.** | Matches backend auth exactly (`/metamodel/diff` any-role, `/metamodel/rebind` owner-only). Non-owners get the read-only exploration the backend permits; the Rebind action is hidden for them. |
| 3 | **Block rebind unless the project is quiet; allow diff regardless.** | The backend 409s a rebind while any lease is live. The "quiet" check generalises beyond *my* staged edits to **any** active lease (a peer's lock blocks rebind too) — surfaced as a clear notice instead of a raw 409 dead-end. |
| 4 | **Counts headline + capped issue lists (first 200/section).** | A type-removing candidate over an ~80 MB model can yield one `now_failing` per affected element; the backend returns them uncapped. Counts are always accurate; capped rendering bounds DOM + payload. |
| 5 | **Peer rebind → manual reload banner (not silent auto-refresh).** | A whole-model retype shouldn't change a peer's view without consent. The banner lets the user choose when the new metamodel lands. |
| 6 | **Success refresh re-fetches the metamodel via `GET /metamodel`.** | Stay aligned with the server's stored blob rather than trusting the locally-picked candidate text. |

---

## 3. Architecture — units & boundaries

### 3.1 API client + schemas (`lib/api/metamodel.ts`, `lib/api/types.ts`)

Two new functions, mirroring `uploadMetamodel`'s raw-body convention (string → sent as-is
with `application/x-yaml`; no JS-side parse):

```ts
diffMetamodel(body: string, cfg?): Promise<MetamodelDiff>      // POST /metamodel/diff
rebindMetamodel(body: string, opts: { baseRev: number; message: string }, cfg?): Promise<Rebind>
                                                              // POST /metamodel/rebind?base_rev=&message=
```

New zod schemas in `types.ts`, reusing the existing `IssueOutSchema`:

```ts
MetamodelDiffSchema = {
  now_failing: Issue[]; now_passing: Issue[];
  unchanged_count: number; current_error_count: number; candidate_error_count: number;
}
RebindSchema = {
  model_rev: number; metamodel_id: string;
  validation_error_count: number; issue_counts: Record<string, number>; issues: Issue[];
}
```

### 3.2 The drawer (`lib/components/SwapMetamodelDrawer.svelte`)

A bindable-`open` drawer with an internal state machine:

`pick → diffing → review → (rebinding) → done | error`

- **pick** — file input (`.metamodel.yaml` / `.json`); read as text into local state.
- **diffing** — `diffMetamodel(blob)`; transient spinner; on 422 → error step with the
  parser message.
- **review** — render the diff (§3.3) and, for owners on a quiet project, the rebind
  affordance (§3.4).
- **rebinding/done/error** — outcome handling (§3.4).

Owner gating reads `getRole()` from the checkout store (`role === 'owner'`).

### 3.3 Diff rendering (review step)

- **Counts headline (always accurate):** `now_failing` (red), `now_passing` (green),
  `unchanged_count` (zinc), plus a `current_error_count → candidate_error_count` delta.
- **Two capped sections** below — first **200** issues each with an "and N more" footer —
  reusing the `issueRow` visual idiom from `IssuesPanel` (severity icon + message +
  target-id chips). Inside the modal the chips are **non-interactive** (no
  click-to-select; the targets may not be in the cached subset and selecting from a
  transient diff is the wrong affordance). Not extracting a shared `IssueRow` component
  for now — the two contexts differ (interactive vs. static); revisit if a third consumer
  appears.
- Identical-metamodel case: both lists empty, `unchanged_count == current_error_count`.

### 3.4 Rebind confirmation & outcome (review step)

- **Quiet-project precondition.** Rebind is blocked (notice, not raw 409) when
  `getStagedDepth() > 0` **or** `getLockState().size > 0`. Notice: *"Commit or discard
  your staged edits first — rebind needs a quiet project."* Diff is unaffected.
- **Non-owner.** Rebind hidden; a line states the diff is read-only for the current role.
- **Confirm.** Optional commit-message input + caveat that the rebind may land with
  conformance issues and is journaled/revertible. Click →
  `rebindMetamodel(blob, { baseRev: getModelRev(), message })`.
- **Success refresh sequence:**
  1. `GET /metamodel` → `setMetamodel(mm)` (server's stored blob).
  2. `setMetamodelFilename(<candidate file name>)`.
  3. `setIssues(resp.issues)` — Issues panel reflects the rebound baseline without a re-run.
  4. `refreshSummary()` — installs the new `model_rev` + counts (via `adoptSummary`).
  5. Close the drawer; success toast `rev N · X conformance issues`.
- **Error branches:** 409 stale `base_rev` → "the model changed since you ran the diff;
  re-run it" (return to pick/diff); 409 active locks → quiet-project notice; 422 → invalid
  candidate; 500 → "rebind failed; no changes applied."

### 3.5 Peer feed handling (`lib/api/feed.ts`, `lib/state/realtime.svelte.ts`)

- Extend the `FeedEvent` union:
  `{ type: 'rebind'; rev: number; from_metamodel_id: string | null; to_metamodel_id: string; validation_error_count: number }`.
- `handleFeedEvent` `case 'rebind'`: set `_pendingRebind = { rev, count }` (new reactive
  field) with `getPendingRebind()` / `clearPendingRebind()` accessors.
- **Reload banner** (in `routes/+page.svelte`): visible while `_pendingRebind` is set —
  *"The metamodel was changed to rev N — reload to continue."* On click:
  `GET /metamodel` + `refreshSummary()` + `runValidation()` + `clearPendingRebind()`.
  (At rebind time the project is quiet, so a peer has no staged edits to lose.)

### 3.6 TopBar entry (`lib/components/TopBar.svelte`)

A "Swap Metamodel" button (ghost, near Load Model) that opens the drawer. Visible to all
members; disabled when no metamodel/model is loaded (`getMetamodel() === null`).

---

## 4. Backend follow-ups (folded in)

1. **Spec footnote (doc only).** The 6B spec §5 bullet "Hydration is unchanged ... correct
   across a rebind" is now imprecise — hydration tolerates unknown types under
   `strict=False`. Add a footnote to that bullet pointing at the tolerant-hydration
   behaviour; the no-op-replay/forced-snapshot reasoning is otherwise unchanged.
2. **Downgrade post-commit snapshot 500 → warning.** In `routes/metamodel_swap.py`
   (rebind) and `routes/commits.py`, a `write_snapshot` failure that occurs *after*
   `db.commit()` has already landed should be logged as a warning rather than raising a
   bare 500: the durable commit is safe and hydration reconstructs the snapshot on the
   next cache-miss, so there is no data loss — a 500 misleads the client into thinking the
   commit/rebind failed. Pre-commit failures keep their existing 500 + rollback path.

---

## 5. Concurrency & correctness invariants

- **Diff never mutates anything** client- or server-side; it is a read-only sandbox call.
  Re-running it is always safe.
- **`base_rev` is captured at rebind-click** from `getModelRev()`. If a peer commits
  between diff and rebind, the backend 409s on stale `base_rev`; the UI tells the user to
  re-run the diff (the diff itself is also stale against the new rev).
- **Quiet-project gating is advisory, not authoritative.** The backend remains the source
  of truth (re-checks leases under the mutex); the client gate just avoids an obvious
  dead-end. A lock acquired by a peer *after* the client's check still produces a 409,
  handled as the active-locks branch.
- **Success refresh trusts the server**, not the picked file: the metamodel is re-fetched,
  and validation issues come from `RebindResponse.issues` (the server's re-validated
  baseline), not a client re-run.
- **Peer reload is user-initiated**, so a peer's cached subset is never silently retyped
  mid-session.

---

## 6. Error responses consumed (summary)

| Call | Code | UI handling |
|------|------|-------------|
| `POST /metamodel/diff` | 422 | error step, parser message |
| `POST /metamodel/diff` | 403 | (entry hidden for non-members; defensive toast) |
| `POST /metamodel/rebind` | 403 | rebind hidden for non-owners (defensive toast) |
| `POST /metamodel/rebind` | 409 stale `base_rev` | "model changed; re-run diff" |
| `POST /metamodel/rebind` | 409 active locks | quiet-project notice |
| `POST /metamodel/rebind` | 422 | invalid candidate |
| `POST /metamodel/rebind` | 500 | "rebind failed; no changes applied" |

---

## 7. Testing

- **API client** (vitest + MSW): diff + rebind request shape (raw body, content-type,
  `base_rev`/`message` query params), schema parse, and error→branch mapping.
- **realtime** (vitest): a `rebind` feed event sets `_pendingRebind`; the banner reload
  path clears it; unknown event types remain ignored.
- **drawer** (vitest + happy-dom): role gating (rebind hidden for viewer/editor),
  quiet-project gating (staged edits / live lease block rebind, diff still runs),
  counts headline, capped-list "and N more", the success refresh sequence, and each error
  branch.
- **backend** (pytest, in-memory SQLite): post-`db.commit()` `write_snapshot` failure →
  rebind and commit still return success (200) and the rev advanced; pre-commit failure
  keeps the 500 + rollback contract.
- **e2e smoke** (Playwright, optional/light): open drawer → pick candidate → see diff
  counts.

---

## 8. File-change inventory (for the plan)

**Frontend:**
- `frontend/src/lib/api/metamodel.ts` — `diffMetamodel`, `rebindMetamodel`.
- `frontend/src/lib/api/types.ts` — `MetamodelDiffSchema`, `RebindSchema`.
- `frontend/src/lib/api/feed.ts` — `rebind` in the `FeedEvent` union.
- `frontend/src/lib/state/realtime.svelte.ts` — `rebind` case + `_pendingRebind`
  field/accessors.
- `frontend/src/lib/components/SwapMetamodelDrawer.svelte` — new drawer.
- `frontend/src/lib/components/TopBar.svelte` — "Swap Metamodel" entry.
- `frontend/src/routes/+page.svelte` — reload banner.
- `frontend/src/lib/**/__tests__/` — coverage above.

**Backend:**
- `src/data_rover/api/routes/metamodel_swap.py` — post-commit snapshot failure → warning.
- `src/data_rover/api/routes/commits.py` — same downgrade.
- `tests/api/` — post-commit snapshot-failure tests.
- `docs/superpowers/specs/2026-06-22-phase-6b-metamodel-swap-design.md` — §5 footnote.
