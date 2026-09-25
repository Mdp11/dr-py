# Strict Mode — Design

**Date:** 2026-06-24
**Status:** Design approved → spec review → implementation planning
**Scope:** An owner-controlled, per-project validation policy that promotes the
CONFORMANCE tier to commit-blocking. Completes the unfinished "optional
strict-mode" item from Phase 8 of the multi-user collaborative architecture
roadmap (`2026-06-16-multi-user-collaborative-architecture-design.md` §9,
§12, §13.5).

---

## 1. Problem & framing

The commit path enforces a **two-tier validation gate**
(`core/validation/issue.py` `IssueCategory`, applied in `routes/commits.py`):

- **STRUCTURAL** — model-graph corruption (dangling reference, containment
  cycle, two parents). Hard-fails the commit with 422 and rolls back. A
  well-behaved client never produces one.
- **CONFORMANCE** — schema-rule violations (endpoint typing, multiplicity,
  uniqueness, facets, scalar type). **Counted and surfaced, never blocks** —
  the engine deliberately "stays inspectable" so a model can hold violations
  and be fixed incrementally. The metamodel-experimentation workflow depends
  on this: rebind must be able to land mismatched edges.

Some organizations want the opposite default: a project whose model must
**never be pushed further out of conformance by an edit**. Strict mode is the
opt-in lever that delivers that guarantee, scoped so it does not break the
inspectable default or the rebind workflow for projects that leave it off (the
default).

## 2. Requirements

- **Opt-in, per-project.** Off by default; turning it on never changes behavior
  for any other project.
- **Owner-controlled.** Only a project `owner` may toggle it (same authority
  gate as membership management). Editors edit *within* the policy.
- **Promotes the whole CONFORMANCE tier.** When on, any conformance issue in a
  commit's scope blocks that commit (422). One boolean, not per-category — but
  stored in a shape that can grow into per-category flags later without a
  schema migration.
- **Scoped enforcement.** Strict mode blocks a commit only if *its own dirty
  set* contains a conformance issue. It never triggers a whole-model
  re-validation. Consequence: it is safe to enable on an already-non-conforming
  project and instantly effective; pre-existing violations elsewhere are left
  untouched until those elements are edited.
- **Rebind is exempt.** `POST /metamodel/rebind` never consults strict mode; it
  stays a migration event that lands mismatched edges and surfaces the cleanup
  worklist.
- **Durable.** The flag survives session eviction/hydration (it lives in the
  DB, not only in RAM).

### Non-goals (explicitly deferred)

- **Per-category promotion** (e.g. "block typing but not multiplicity"). The
  JSON storage shape leaves room; not built in v1.
- **Whole-model strict re-validation** (a global "project is everywhere clean"
  guarantee). Rejected: O(model) per commit, and it would lock an owner out of
  committing the very fixes a non-conforming model needs.
- **Strict-gating rebind.** Rejected: would gut metamodel experimentation.
- **Retroactive rejection** of existing non-conformance on enable.

## 3. Decisions (and the alternatives weighed)

| Decision | Chosen | Rejected alternative & why |
|---|---|---|
| Configurability | Single boolean now, JSON-shaped storage for later per-category growth (option C) | Per-category toggles now — premature; §13.5 says the promotable set is "TBD with users" |
| What it promotes | The entire CONFORMANCE tier | A fixed subset excluding multiplicity — "strict" should mean fully conforming; multiplicity can be batched into one commit and the JSON shape lets us demote it later if needed |
| Enforcement scope | Scoped to the commit's dirty set | Whole-model re-validation — O(model) regression and impossible to enable on a non-clean model |
| Rebind interaction | Rebind exempt | Strict-gates-rebind — defeats the experimentation feature soft-typing exists to enable |
| Control authority | Owner only | Editor-settable — policy is an owner concern, mirrors membership management |
| Storage location | `validation_policy` JSON on `ModelRow` | A bare boolean column, or `Project` row — JSON honors the growth requirement; `ModelRow` is the model-content-authoritative row (carries `model_rev`/`metamodel_id`) and strict mode is about the model conforming to its metamodel |

## 4. Storage

Add a nullable JSON column to `ModelRow` (`db_models.py`):

```
validation_policy JSON   -- default {"strict": false}
```

- **Shape:** `{"strict": bool}` in v1. Per-category growth later is additive
  (e.g. `{"strict": true, "promote": ["typing", "uniqueness"]}`) — no schema
  migration, the column already holds arbitrary JSON.
- **Migration:** one Alembic revision adds the nullable column. A row with NULL
  (or a missing `strict` key) reads as `strict=false` — the migration needs no
  backfill.
- **Service helpers:** `content.py` gains a reader (`get_validation_policy` /
  `get_strict_mode`) and an updater (`set_strict_mode`) over the content table,
  consistent with the existing `content.py` accessor style.

## 5. In-memory `Session`

The commit path must read the flag with no per-commit DB hit.

- `Session` carries a `strict_mode: bool` (read from `validation_policy` during
  hydration, alongside `model_rev`/`metamodel_id`).
- The owner-gated settings route updates **both** the DB row and the live
  `Session` under the project's `write_mutex` (the same mutex commits take), so
  a policy change and a concurrent commit can't interleave inconsistently.
- A contentless/cold project hydrates with `strict_mode=false` (the default).

## 6. Enforcement (commit path)

In `routes/commits.py`, the commit handler already splits scoped issues into
`structural` and `conformance` and hard-rejects `structural` with 422 +
rollback. Strict mode adds a parallel gate immediately after, under the same
`write_mutex`:

```
# existing: structural blockers -> 422 + rollback
# new:
if session.strict_mode and conformance:
    # roll back the applied batch (same path as structural rejection)
    -> 422 {"detail": "strict-mode conformance blocker",
            "conformance_blockers": [IssueOut...]}
```

- **Order:** structural is still checked first (it is the more severe class and
  the existing safety net). Strict-conformance is a second, policy-driven gate.
- **Rollback:** reuses the exact in-place inverse-rollback the structural
  rejection already uses — no new rollback machinery.
- **Non-strict path:** unchanged byte-for-byte. When `strict_mode` is false the
  new branch is never entered; conformance issues are spliced into the issue
  store and counted exactly as today.
- **Preview** (`POST /commits/preview`) gains a `would_block: bool` in its
  response — `true` when `session.strict_mode and conformance_error_count > 0`
  — so the client renders policy without re-deriving it.

The strict gate lives **only** in the ordinary `/commits` handler. The rebind
handler does not go through it, which is the entirety of the rebind exemption
(§2). Revert (`POST /commits/revert`) commits inverse ops that restore
previously-committed (hence previously-accepted) state; it is treated as an
ordinary commit and so is subject to strict mode — restoring a prior clean
state will not trip it, and restoring across known-conforming history is safe.

## 7. API surface

- **`GET /open`** — `OpenResponse` (`schemas.py`) gains `strict_mode: bool`, so
  the client knows the policy at connect time.
- **Settings route** — a new owner-gated endpoint under the project prefix
  `/api/v1/projects/{project_id}`:
  `PATCH /settings` body `{"strict_mode": bool}` → guarded by `require_owner`
  (`authz.py`), updates DB + live `Session`, returns the effective policy. A
  read (`GET /settings`) returns the current policy for any member.
- **`POST /commits/preview`** — response gains `would_block: bool` (see §6).
- **`POST /commits`** — on strict rejection returns 422 with
  `conformance_blockers` (shape mirrors the existing `structural_blockers`).

## 8. Frontend

The realtime/checkout layer already tracks open-state and preview results
(Spec B, `state/checkout.svelte.ts`).

- On open, read `strict_mode` from `/open` into checkout state.
- Preview consumes `would_block`; under strict mode with conformance errors the
  **"Commit anyway" affordance is disabled** (the commit would 422), with
  messaging that strict mode is on and the errors must be resolved first.
- An **owner-only** toggle in a project/settings surface calls
  `PATCH /settings`. Non-owners see the policy state read-only (the toggle is
  hidden/disabled). The exact component placement is decided in the
  implementation plan.
- A peer turning strict mode on/off is **not** a live-broadcast concern for v1
  (it is an owner-rare event and the next `/open` / preview reflects it); no
  feed event is added. Documented so the absence is intentional, not an
  oversight.

## 9. Testing

**Backend (`tests/api/`, `tests/validation/` as appropriate):**
- strict + conformance issue in dirty set → 422 + rollback (model_rev
  unchanged, op_log unchanged).
- strict + clean commit → succeeds.
- strict + commit whose dirty set is clean but the model has *pre-existing*
  conformance issues elsewhere → succeeds (scoped enforcement).
- rebind under strict mode → succeeds with outstanding conformance issues
  (exemption).
- toggle: owner → 200; editor → 403; viewer → 403; unknown project → 404.
- `GET /open` reports `strict_mode`; `preview` reports `would_block`.
- hydration round-trip: enable strict → evict → re-hydrate → flag persists and
  still blocks.

**Frontend (`vitest`):**
- "Commit anyway" disabled when `would_block` is true; enabled otherwise.
- settings toggle issues `PATCH /settings`; hidden/disabled for non-owners.

**E2E (`playwright`):**
- owner enables strict → attempts a non-conforming commit → blocked → fixes →
  commits successfully.

## 10. Open questions / follow-ons

1. **Per-category promotion** — the JSON shape is ready; the *set* of
   promotable categories is still "TBD with users" (§13.5). Out of v1 scope.
2. **Live broadcast of policy changes** — deferred (§8); revisit if owners
   report confusion from stale client policy state.
3. **Strict-mode interaction with the legacy unlocked `/model/ops` path** — the
   legacy path is slated for removal now that the frontend has migrated to
   lock→commit (separate cleanup). v1 strict mode targets the `/commits` path
   only; the legacy path remains non-strict (documented, low-risk, and
   short-lived).
