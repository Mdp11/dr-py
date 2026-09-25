# Validate reflects staged edits, with issue-origin tagging

**Date:** 2026-06-25
**Status:** Design approved, pending implementation plan

## Problem

When a user edits the model in the frontend and the edit violates a validation
rule, clicking **Validate** does **not** surface the error. Clicking **Commit**
does. To see the error in the Validation panel the user must commit first.

### Root cause (confirmed)

The frontend was migrated to a staged-commit model (Spec B) but the **Validate**
button was never updated to match. The regression:

1. `emit()` (`frontend/src/lib/state/model.svelte.ts`) applies an op to local
   caches and pushes it onto the staged buffer `_queue`. Per the Spec B
   docstring: *"The frontend no longer auto-flushes to POST /model/ops."* The
   edit lives **only in the browser** until an explicit commit.
2. **Validate** → `runValidation()` → `validateAll()` → `validateModel(undefined)`
   sends `POST /model/validate` with **no body**. The backend
   (`routes/validation.py`) validates `model = current` — the **last-committed**
   session model, which does not contain the staged edit. No error is found.
3. **Commit** → `commitStaged()` sends `getStagedOps()` to `POST /commits`, which
   *applies* the ops before validating (`routes/commits.py`). Validation then
   sees the edit and splices the issue into the issue store — which is why the
   error only appears after committing.

The fingerprint: `validate-action.ts`'s docstring still claims `validateAll()`
*"flushes pending ops first"* (true pre-Spec-B), directly contradicting the
current code in `model.svelte.ts`. The migration left Validate behind.

## Requirements

- **Validate must reflect staged (uncommitted) edits**, not just committed state.
- The Validation panel must let users **distinguish three buckets**, diffed
  against the committed server model:
  - **on-server** — pre-existing on the committed model (present before and
    after the staged edits).
  - **uncommitted** — introduced only by the staged edits (absent on committed,
    present in working state). This is the bucket the bug report is about.
  - **resolved** — present on committed, fixed by the staged edits.
- Panel presentation: a **filter toggle bar** `[All | New | On server | Fixed]`
  plus **per-row origin badges**, retaining the existing Errors/Warnings
  grouping.

## Approach (chosen: incremental dirty-scope re-validation)

Reuse the committed-model issue baseline the session already maintains
(`session.validation`, a `ValidationState`). Apply the staged ops, validate only
the **dirty scope** (the entities the ops touch, expanded by the existing
`DirtyCollector` to referencers / uniqueness groups / endpoints), then roll
back. This mirrors the mechanism `_finalize` (`routes/ops.py`) already uses and
that the commit path already trusts — one full pass at most (only if the
baseline is not yet seeded) plus one cheap `O(dirty)` pass, instead of two full
`O(model)` passes on the ~80 MB model.

Rejected alternatives:

- **Two full validations + diff** — simplest, but two `O(model)` passes per
  Validate; the exact cost the `perf/large-model-overhaul` work avoids.
- **Reuse `/commits/preview` as-is** — only shows dirty-scope issues, no
  full-model picture, no on-server/resolved buckets. Fails the requirements.

## Detailed design

### 1. Backend — extend `POST /model/validate`

`ValidateRequest` (`api/schemas.py`) gains two optional fields:

- `ops: list[OpIn] | None`
- `base_rev: int | None`

Behavior splits on whether `ops` is present.

**No `ops` (unchanged path):** validate committed `current` over `Scope.all()`,
seed `session.validation`, return issues all tagged `origin="on_server"`.
Identical to today's behavior (`routes/validation.py`).

**With `ops` (new staged path):**

1. If `base_rev != session.model_rev` → **409** `{"detail": "stale base_rev",
   "model_rev": session.model_rev}`. Mirrors `/commits/preview`.
2. `state = _ensure_validation_seeded(session, model)`; `committed =
   state.all_issues()` → the **`committed`** issue set (the on-server baseline).
   The session's maintained issue store is **reused, not recomputed** — no full
   `Scope.all()` pass per Validate, and no `session.validation` reassignment
   outside the write mutex (avoids a torn read / racy reassignment under
   concurrent writers). `session.validation` and durable `issue_counts` continue
   to reflect the committed model.
3. Under `session.write_mutex`:
   - `res = _apply_batch(model, ops, restore=False)` — **422** on a
     mutation-boundary error (unknown type/endpoint/property), same as preview.
   - `scoped = default_pipeline().validate(model, res.dirty.to_scope())`
   - `_rollback(model, res.inverse_units)` — in a `finally`, always restore.
   The live model and `session.model_rev` are unchanged after the call.
4. Compute the **working** issue set *functionally* (must NOT mutate `state`,
   since the model is rolled back): `committed` issues whose owner ∉
   `res.dirty.ids`, unioned with `scoped`. (This is what `state.replace` would
   produce, computed without side effects.)
5. **Diff** committed vs working by a content key
   `(severity, message, tuple(target_ids), category)`, multiset-matched
   (`collections.Counter`) so duplicate identical issues tag correctly:
   - working ∩ committed → `on_server`
   - working − committed → `uncommitted`
   - committed − working → `resolved` (included in the response, tagged)

`IssueOut` gains `origin: Literal["on_server", "uncommitted", "resolved"]`,
defaulting to `"on_server"` so the no-ops path and any existing caller/test are
unaffected. The response stays a flat `list[IssueOut]`.

Concurrency: the apply→validate→rollback runs under `session.write_mutex`, like
`/commits/preview`. The validation pipeline is constructed per request
(`default_pipeline()`), per the per-thread memo-cache rule.

### 2. Frontend — wire staged ops + origin

- `api/types.ts`: add `Issue.origin?` (the three-value union); `IssueListSchema`
  accepts `origin` as optional, defaulting to `"on_server"`.
- `api/validation.ts` `validateModel`: accept `ops` + `baseRev`; when staged ops
  exist, send `{ ops, base_rev }`.
- `state/model.svelte.ts` `validateAll`: read `getStagedOps()` + `getModelRev()`
  and pass them; on a 409, surface a conflict via the existing conflict/reload
  path (the store already models `_error.kind === 'conflict'`).
- `state/validate-action.ts`: fix the stale "flushes pending ops first"
  docstring; handle the conflict error.
- `state/validation.svelte.ts`: unchanged (issues now carry `origin`).

### 3. Frontend — IssuesPanel (`components/Workspace/IssuesPanel.svelte`)

- Filter bar `[All | New | On server | Fixed]` as local component state.
- Per-row origin badge; retain the Errors/Warnings grouping.
- `resolved` rows render muted/strikethrough and are **excluded** from the
  error/warning header counts (they are not active problems).
- Header error/warning counts are computed from non-resolved issues.

## Edge cases

- **Issues on newly-created (temp-id) elements:** their owner is a temp id never
  present in the committed run → tagged `uncommitted`. Correct.
- **Duplicate identical issues:** multiset (Counter) matching avoids
  mis-tagging.
- **`target_ids` ordering in the key:** use `tuple(target_ids)` as-is — the
  pipeline emits owner-first deterministically, so the same rule on the same
  entity yields the same tuple across runs. A changed secondary target is a
  genuinely different issue.
- **No staged ops:** path is byte-for-byte today's behavior; everything
  `on_server`.
- **`session.validation` integrity:** the staged run rolls the model back and
  never calls `state.replace`, so the persistent baseline keeps reflecting the
  committed model.

## Testing

**Backend (`tests/api`):**

- Staged edit that introduces a violation → issue tagged `uncommitted`.
- Pre-existing committed violation → tagged `on_server`.
- Staged edit that fixes a pre-existing violation → tagged `resolved`.
- No-ops path returns the same result as before (all `on_server`).
- Stale `base_rev` → 409.
- After the call: `session.model_rev` and model content unchanged;
  `session.validation` still reflects the committed model.

**Frontend (vitest + MSW):**

- `validateAll` sends `{ ops, base_rev }` when staged ops exist, and no body
  when none.
- IssuesPanel renders origin badges, the filter bar filters correctly, and
  `resolved` rows are struck through and excluded from header counts.

## Files touched

Backend:
- `src/data_rover/api/schemas.py` — `ValidateRequest.ops/base_rev`,
  `IssueOut.origin`.
- `src/data_rover/api/routes/validation.py` — staged path + diff/tagging.
- (reuse) `routes/ops.py` `_apply_batch` / `_rollback` /
  `_ensure_validation_seeded`; `core/validation/state.py`.

Frontend:
- `frontend/src/lib/api/types.ts`
- `frontend/src/lib/api/validation.ts`
- `frontend/src/lib/state/model.svelte.ts`
- `frontend/src/lib/state/validate-action.ts`
- `frontend/src/lib/components/Workspace/IssuesPanel.svelte`
