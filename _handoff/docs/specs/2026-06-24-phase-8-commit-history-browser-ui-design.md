# Phase 8 — Commit-History Browser UI (with per-commit & two-commit diff) — Design

**Date:** 2026-06-24
**Status:** Approved (brainstorming)
**Parent spec:** `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md` (§12 Phase 8: History & revert)
**Predecessor (backend):** `docs/superpowers/specs/2026-06-22-phase-8-revert-to-commit-backend-design.md`

## 1. Problem & framing

Phase 8's backend slice shipped `GET /commits` (durable paged history) and
`POST /commits/revert` (revert-to-commit). There is **no UI** for either, and no
way to inspect what a commit changed. This spec adds the **frontend
commit-history browser** plus the diffing it needs:

- browse durable commit history (paged, newest-first);
- see **what a single commit changed** (per-commit diff);
- see **the net change between any two commits** (two-commit diff);
- **revert to** any commit (full-tail revert — "commit == revision").

Revert semantics are fixed by the backend and unchanged here: reverting *to*
`target_rev` undoes every commit newer than the target (newest-first inverse
ops) as **one new forward commit**. History stays append-only; the revert is
itself a commit at the head, so a revert can be reverted. Partial/subset revert
(undo a middle commit only) is explicitly **out of scope**.

## 2. Requirements

In scope:
1. History drawer listing commits with rev, message, author, timestamp,
   op-count, and rebind / issue-count badges; paged via `has_more` + cursor.
2. Per-commit diff: select a commit → show its changes (`diff(rev-1, rev)`).
3. Two-commit diff: select any two commits → show the net change.
4. Revert-to-commit from a row, with confirmation, optional message, role
   gating, a clean-buffer precondition, and full error mapping.
5. Live refresh when new commits/rebinds arrive over the realtime feed.

Out of scope (YAGNI / later slices):
- Partial/subset revert.
- Revert *across* a metamodel-swap (stays blocked at the backend with 409).
- Optional project-level strict-mode.
- Large-model-scale diffing (this design accepts O(model) reconstruction; see
  §6 Tradeoffs).

## 3. Chosen approach

**Historical-model reconstruction + reuse the existing compare/diff stack.**

The frontend already has a complete structural-diff pipeline used by the
`/compare` page: `computeDiff(modelA, modelB)` (in `lib/state/diff.ts`) →
`CompareDiff.svelte` → `CompareEntityCard.svelte` / `DiffRow.svelte`. A diff is
therefore just two whole models fed to `computeDiff`. We add **one** backend
capability — materialize the model **at a historical rev** — and every diff in
this feature reduces to a `computeDiff` over two reconstructed models:

- per-commit diff of rev N = `computeDiff(model@(N-1), model@N)`;
- two-commit diff of A, B  = `computeDiff(model@A, model@B)`.

Rejected alternatives:
- **Journal/ops-based diffs** (expose stored ops, aggregate over a range): small
  payloads and big-model friendly, but ops are low-level, "before" values for
  modified properties require inverse-ops reconstruction, it cannot reuse
  `computeDiff`, and range-aggregation has create-then-delete edge cases.
- **Hybrid** (per-commit from stored delta, two-commit from reconstruction):
  best fidelity per case but two mechanisms to build and maintain.

We choose reconstruction for maximum UI reuse and true before/after fidelity,
accepting the O(model) cost the existing compare page already accepts.

## 4. Backend

### 4.1 New endpoint — reconstruct model at a rev

`GET /api/v1/projects/{project_id}/commits/{rev}/model` → `ModelOut`.

Returns the full model as it existed at `rev`. Read-only → **viewers allowed**
(authz GET, like `GET /commits`).

Implementation: a new pure helper that mirrors `hydration.hydrate_session` but
**bounded** to `rev` and operating on a **throwaway** `Model` (never touches the
registry session, `session.model_rev`, or any snapshot writes):

```
reconstruct_model_at(db, project_id, rev) -> core.Model:
    snap   = content.latest_snapshot(db, project_id, max_rev=rev)   # exists
    mm     = metamodel effective at rev                             # see §4.3
    base   = build_model_from_dicts(mm, snapshot blob, strict=False)  # see §4.3
    tail   = commits with snap.rev < c.rev <= rev  (ascending)      # new query
    replay_commits_into(throwaway_session, tail)  # restore-mode applier
    return throwaway_session.model
```

Building blocks already exist: `content.latest_snapshot(max_rev=...)`,
`routes._snapshot.build_model_from_dicts`, `hydration.replay_commits_into`. The
only new content query is "commits in `(snap.rev, rev]` ascending"
(`content.commits_between` or a `max_rev` arg on `commits_after`).

The route serializes the throwaway model with `ModelOut.from_core`.

### 4.2 Guards

- `rev < 0` or `rev > models.model_rev` → **422** `{detail: "rev out of range", model_rev}`.
- Contentless project / `rev == 0` baseline → empty (or baseline) `ModelOut`.
- Must survive eviction: it reads durable content directly, independent of the
  in-memory session, so an evicted/cold project reconstructs the same.

### 4.3 Metamodel at a historical rev

The reconstructed model should be built against the metamodel active at `rev`.
`ModelRow.metamodel_id` is the *current* binding; rebind commits journal
`from_metamodel_id`/`to_metamodel_id`. The helper resolves the metamodel
effective at `rev` by finding the **earliest** rebind commit with `c.rev > rev`:
if one exists, use its `from_metamodel_id` (the pre-swap metamodel, i.e. the one
active at `rev`); otherwise use the current `ModelRow.metamodel_id`. (Versioned
metamodel blobs live in `MetamodelRow`.)

**Mid-tail-rebind robustness.** The nearest snapshot `≤ rev` may be separated
from `rev` by a rebind (the snapshot's era and `rev`'s era use different
metamodels), and snapshots are written opportunistically (on eviction), so there
is no guarantee of a snapshot positioned right after a rebind. To stay robust
without a recursive snapshot search, the base model is built with
**`strict=False`**, which `build_model_from_dicts` already supports precisely so
"a snapshot whose metamodel has since had types removed can still be loaded."
Type mismatches across a rebind therefore do not abort reconstruction, and
`computeDiff` is purely structural (ids / type names / property values), so the
diff result is well-defined regardless. Cross-rebind diffs remain flagged in the
UI (§5.3).

### 4.4 Existing endpoints (unchanged)

`GET /commits` (paged history) and `POST /commits/revert` are used as-is.

## 5. Frontend

### 5.1 API client + types

- `lib/api/types.ts`: zod `CommitSummarySchema` (`rev, commit_id, author_id,
  ts, message, validation_error_count, op_count, is_rebind`) and
  `CommitHistoryResponseSchema` (`commits[], has_more`). Revert reuses
  `CommitResponseSchema`.
- `lib/api/history.ts` (new module; siblings `checkout.ts`):
  - `getCommitHistory({limit?, beforeRev?})` → `CommitHistoryResponse`
  - `getModelAtRev(rev)` → `ModelOut`
  - `revertToCommit({targetRev, baseRev, message?})` → `CommitResponse`
    (throws `ConflictError` on 409, `ValidationError` on 422)

### 5.2 State

- `lib/state/ui.svelte.ts`: `getHistoryDrawerOpen` / `setHistoryDrawerOpen`.
- A small history store (in the drawer or `lib/state/history.svelte.ts`):
  the loaded page(s), cursor/`has_more`, current mode, selected revs, and a
  **`Map<rev, ModelOut>` reconstruction cache** so flipping between comparisons
  does not refetch a rev already materialized.

### 5.3 `HistoryDrawer.svelte`

Mirrors `DiffDrawer` / `SwapMetamodelDrawer`: a `Dialog` mounted in
`+page.svelte`, opened from a new **"History"** button in `TopBar`. Three modes:

- **list** (default): newest-first rows — rev, message, author, relative
  timestamp, op-count; `is_rebind` and `validation_error_count>0` badges.
  "Load more" appends the next page via `has_more` + `before_rev`. Per row:
  click → commit-diff; a "Compare" toggle to pick a second row (select A, then
  B) → compare; a "Revert to here" action (§5.5).
- **commit-diff**: `computeDiff(model@(rev-1), model@rev)` → `<CompareDiff>`.
  rev 0 / baseline diffs against the empty model.
- **compare**: `computeDiff(model@A, model@B)` → `<CompareDiff>`.

A **back** control returns to list. When a diff span crosses a rebind commit, a
banner notes the revisions use different metamodels (the diff still renders).

### 5.4 Live refresh

The drawer refetches the first history page on realtime `commit` / `rebind`
events (reusing the realtime event hooks) so the list stays current while open.

### 5.5 Revert flow + guards

- **Role gating:** owner/editor only; viewers see history/diffs but no revert
  control (backend would 403).
- **Clean-buffer precondition** (mirrors `SwapMetamodelDrawer`'s `quiet`): if
  there are staged edits or held locks, revert is blocked with "commit or
  discard your changes first."
- **Confirmation dialog:** "Revert to rev N — discards revs N+1…HEAD as state
  (history is preserved)." with an optional message (default `Revert to rev N`).
- **On confirm:** `revertToCommit({targetRev:N, baseRev: model_rev})`; on
  success apply the returned `CommitResponse` delta via `applyDelta` and return
  to list. (The feed also broadcasts a `commit` event; `applyDelta` is an
  idempotent upsert/delete so a double-apply is harmless.)
- **Error mapping:**
  - 409 stale `base_rev` → "history moved — reloading" + refetch.
  - 409 rebind → "can't revert across a metamodel swap (rev X)".
  - 409 peer-lock → "locked by a peer: <resources>".
  - 422 structural blocker → blocker message.

## 6. Tradeoffs & risks

- **O(model) reconstruction.** Each diff fetches one or two full models; a
  two-commit diff materializes two models server-side and ships both. This is
  the same limitation the `/compare` page already documents ("small-model
  consumers"). Acceptable for current scale; a journal/ops-based diff is a
  future optimization if large-model diffing becomes a requirement. The
  client-side `Map<rev, ModelOut>` cache mitigates repeat fetches within a
  session.
- **Cross-rebind diffs** mix metamodels; we flag rather than block (§5.3).
- **Reconstruction correctness** depends on snapshot+replay parity with
  `hydrate_session`; covered by backend tests at baseline/mid/head and
  post-eviction.

## 7. Testing

- **Backend (pytest, `tests/api/`):** `GET /commits/{rev}/model` —
  reconstruct correctness at baseline / a mid rev / head; out-of-range 422;
  viewer allowed; correctness after eviction; correct historical metamodel
  across a rebind.
- **Frontend (vitest + MSW):** the three `history.ts` client fns; `HistoryDrawer`
  — list paging, commit-diff, compare-mode selection, revert success and each
  error path; clean-buffer gate; role gating. `computeDiff` / `CompareDiff` are
  already covered.
- **E2E (Playwright, one smoke):** open History → see commits → diff a commit →
  revert → model updates.

## 8. Build sequence (for the plan)

1. Backend: `commits_between` query + `reconstruct_model_at` helper + historical
   metamodel resolution + `GET /commits/{rev}/model` route + tests.
2. Frontend API: `history.ts` client + zod types + tests.
3. Frontend state: `ui` open-state + history store/cache.
4. `HistoryDrawer` list mode + TopBar button + paging + live refresh + tests.
5. Diff modes (commit-diff, compare) reusing `computeDiff`/`CompareDiff` + tests.
6. Revert flow (gating, confirm, error mapping) + tests.
7. E2E smoke; `frontend/README.md` update.
