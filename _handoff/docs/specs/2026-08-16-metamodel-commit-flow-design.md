# Metamodel edits through the commit flow (+ committed diagram layout)

**Date:** 2026-08-16
**Status:** Approved design, pre-implementation
**Supersedes (in part):** 2026-06-22-phase-6b-metamodel-swap-design.md (Decision 4: rebind as
empty-ops commit; Decision 6: quiet-project precondition), 2026-08-10-metamodel-lease-structural-diff-design.md
(honor-don't-require `mm` lease), 2026-08-13-metamodel-diagram-editor-design.md §5 (live layout PUT,
draft-rename key inversion).

## Problem

Two complaints, one root cause: the metamodel is the only editable surface outside the
check-out/commit flow.

1. **Metamodel edits commit through their own page** (`POST /metamodel/rebind`, owner-only,
   quiet-project). They cannot be staged alongside model/artifact/view edits, reviewed in the same
   diff UI, or undone the same way. Worse, a schema migration is inherently two-sided: removing a
   property from an element type (or adding a mandatory one) requires fixing every affected element
   *in the same rev*, or the model passes through an inconsistent state that peers can observe and
   history records.
2. **Diagram node positions are free-live** (`PUT /metamodel/layout`, last-write-wins, debounced
   auto-save, no lease). Peers stomp each other and there is no review/undo.

## Decision summary

- New `metamodel.*` op family in the `OpIn` union, flowing through `POST /commits` only:
  - `metamodel.rebind { blob }` — full candidate YAML; **at most one per batch, hoisted first**;
    all other ops in the batch validate against the **new** schema (migration semantics).
    Inverse: `metamodel.rebind { blob: <prior YAML> }` (full-state, self-contained).
  - `metamodel.move_node { node, pos: {x,y} | null }` — per-node layout write against
    `metamodel_layouts`; `null` removes the key. Inverse carries the prior position (or null).
- Positions land **only** through commits ("commit required", user decision): a pure rearrange is a
  normal cheap commit — rev bump, journal row, **no** metamodel swap, **no** full revalidation.
- `mm` lease flips from honor-only to **hard-verified** at commit for `metamodel.*` ops.
- `POST /metamodel/rebind` and `PUT /metamodel/layout` **retire with no legacy window** (frontend is
  the sole caller and migrates in the same change).
- Rebind-carrying batches stay **exempt from strict-mode conformance hard-reject** ("engine stays
  inspectable"); structural blockers still hard-reject as usual.
- Rebind batches require **owner**; layout ops require editor+ (both matching today's gates).
- Undo works across metamodel commits (compensating forward commit); revert stays 409 across any
  range containing `metamodel.*` ops.

## 1. Op family & wire shapes

`schemas.py` gains a `MetamodelOpIn` union member set with `kind` discriminators
`"metamodel.rebind"` and `"metamodel.move_node"`, plus a `METAMODEL_OP_KINDS` frozen set for
raw-journal-dict checks (pattern: `VIEW_OP_KINDS`).

- **`metamodel.rebind`**: `blob: str` — the author's YAML source, persisted verbatim as a new
  immutable `MetamodelRow` at `prior_version + 1` (existing Correction-A behaviour: the raw string
  is what's stored, never a pydantic round-trip). Batch constraints, enforced at commit:
  - at most one rebind op per batch (422 otherwise);
  - the server hoists it to apply first regardless of client order;
  - there is deliberately **no "old-schema slot"**: model ops that need the outgoing schema belong
    in a prior commit.
- **`metamodel.move_node`**: `node: str` (layout keys `el:<Name>` / `rel:<Name>` / `enum:<Name>`),
  `pos: {x: float, y: float} | None`. A rename migrates a position as two ops
  (`old → null`, `new → {x,y}`). The client coalesces repeated drags of the same node into one
  staged op.

A new **`api/metamodel_ops.py`** (mirroring `view_ops.py`) owns split/apply/inverse/validate for
the family. The in-memory swap mechanics (candidate parse, `session.metamodel` +
`model.metamodel` assignment, `model.indexes.rebuild()`, cache invalidation) are **extracted from
`routes/metamodel_swap.py` into a shared helper** used by the commit applier; the standalone route
is deleted rather than kept as a second caller.

`artifact_ops.split_ops` gains an **explicit** fourth return member. This is load-bearing: its
current `else` branch hands unknown ops to the model applier, so the new family must be matched
explicitly before that fallthrough.

## 2. Commit pipeline (`POST /commits`)

Apply order under `write_mutex`:
verify locks → quiet-peers guard (rebind batches only) → **rebind (metamodel swap in memory)** →
model ops → artifact ops → view ops → **layout ops** (staged writes to `metamodel_layouts` on the
request's DB transaction — `content.put_metamodel_layout` gains a no-self-commit variant) →
validation → persist → snapshot → release → broadcast.

- **Validation.** A rebind-carrying batch replaces the dirty-scope splice
  (`state.replace(res.dirty.ids, scoped)`) with the full `Scope.all()` sweep + `state.set_full`
  — the same O(model) cost today's rebind route pays. Structural blockers hard-reject with 422 +
  full unwind, unchanged (a schema change cannot mint structural issues, so this only bites the
  model-op half of a migration batch). **Strict mode:** rebind-carrying batches are exempt from
  the conformance hard-reject; conformance counts are reported on the commit as usual.
  Layout-only batches skip validation entirely (presentation data).
- **Unwind.** `_CommitUnwind` gains a metamodel stage — restore `session.metamodel`,
  `model.metamodel`, `model.indexes.rebuild()`, null `session.validation` (force re-seed),
  `invalidate_derived_caches()` — sequenced to run **after** the model-op rollback (reversing
  apply order: the swap happened first, so it unwinds last) and before the rev decrement. Layout
  writes need
  no in-memory unwind (`db.rollback()` covers the staged row; the in-memory session holds no
  layout state).
- **Persistence.** Exactly one `Commit` row per batch (completeness invariant: one batch == one
  rev == one row). Rebind batches additionally set the existing `from_metamodel_id` /
  `to_metamodel_id` columns, so `first_rebind_after`, history rendering, and the staleness guard's
  unconditional-conflict branch keep working without schema changes. **No Alembic migration.**
- **Snapshot.** A rebind-carrying commit forces `write_snapshot` at the new rev (preserving the
  "replay tail never spans a rebind boundary" invariant); layout-only commits use the normal
  periodic policy.
- **Staleness / conflict backstop.** The tail check `from_metamodel_id is not None or
  to_metamodel_id is not None or not ops` still marks rebind commits as unconditional conflicts
  (correct: a peer below a schema swap must reload; a rebind batch now has non-empty `ops` but the
  FK half of the predicate still fires). Layout ops participate in the overlap rule via per-node
  markers `mmnode:<key>` added to `_affected_ids` (raw-dict arm keyed off `METAMODEL_OP_KINDS`)
  and `_batch_touched_ids` (which ends in `assert_never`, so the new arm is compiler-forced).
- **Feed.** A rebind-carrying commit emits the existing `rebind_event` (peers get the reload
  banner — there is no applyable delta after a schema swap). A layout-only commit emits a normal
  `commit_event` with `"metamodel-layout"` added to the `scope` vocabulary so an open diagram
  refetches positions. `commit_diff.diff_commit`'s recomputed scope list gains the same arm.
- **`POST /commits/preview`** learns to dry-run rebind batches: apply-swap → apply ops → validate
  full → unwind, all under the mutex, returning the same counts/blockers shape. Layout ops are
  dry-validated (key shape) without touching the DB, like artifact ops in preview today.
- The **empty-batch early return** is unchanged; `metamodel.*` ops count as non-empty.

## 3. Locking, roles, concurrency

- **`required_locks` gains a `metamodel.*` arm: every op in the family derives an EXCLUSIVE lease
  on the singleton `mm` resource.** This flips `mm` from honor-only to hard-verified at the commit
  boundary — a deliberate reversal of the BACKLOG "honor-don't-require" decision, contained to the
  commit path: the honor-only contract existed for the standalone rebind route, which retires.
  `POST /metamodel` (initial bind, empty model only) keeps its honor-only `_peer_mm_conflict`
  check unchanged.
- **Quiet-peers guard.** A rebind-carrying batch 409s if any **peer** holds a model-scope lease
  (`is_model_resource`), preserving today's protection of peers' staged work. The **caller's own**
  leases never block — the migration batch is expected to hold locks on the elements it fixes.
  Layout-only batches skip the guard.
- **Roles.** A batch containing `metamodel.rebind` requires the caller's role to be **owner**
  (403 otherwise). `metamodel.move_node` needs editor+ (the route's normal write gate). An editor
  can therefore stage and commit node moves but not YAML changes — same split as today, now
  expressed per-op.
- `locking.py`: `expand_targets` continues to ignore `mm` (no subtree); `is_model_resource`
  already excludes it.

## 4. Undo, revert, diff, hydration

- **Undo** (`POST /model/undo`) works across metamodel commits for the first time. Inverse batch
  for `[rebind, model…, layout…]` is `[reversed layout inverses…, reversed model inverses…,
  rebind-back]`: model restores replay first (restore mode reinstates exact state and does not
  conformance-check against the still-current new schema), then the rebind-back swaps the old
  schema in and triggers the full sweep + forced snapshot. Journal stays append-only via the
  compensating forward commit, exactly like artifacts. This also retires the pre-existing latent
  hazard of undo replaying pre-rebind inverses under a new schema unguarded — the rebind-back is
  now part of the same undo unit.
- **Revert** (`POST /commits/revert`) answers 409 for any range containing `metamodel.*` ops
  (checked on raw journal dicts via `METAMODEL_OP_KINDS`, alongside the existing FK-column check),
  consistent with the view/artifact treatment. Undo covers the immediate-regret case.
- **Diff** (`GET /commits/{rev}/diff`). Rebind rendering keeps working off the FK columns
  (`_metamodel_structural` recomputes `diff_metamodels` from the two immutable blobs) — and now
  the same commit's model ops render beside it: "property X removed" + "40 elements: X unset" is
  one page. Layout ops render as a journal-only summary ("N nodes moved"), never per-coordinate
  noise.
- **Hydration** (`replay_commits_into`) skips the whole family: the metamodel comes from
  `ModelRow.metamodel_id`, positions from `metamodel_layouts` — both materialized heads, same
  pattern as artifact/view ops. `reconstruct_model_at` continues to resolve historical schemas via
  `first_rebind_after` unchanged.

## 5. Route changes

| Route | Fate |
|---|---|
| `POST /metamodel/rebind` | **Deleted.** No legacy window; the frontend is the only caller and migrates in the same change. |
| `PUT /metamodel/layout` | **Deleted.** |
| `GET /metamodel/layout` | Stays (still non-hydrating, member-read). |
| `POST /metamodel/diff` | Stays unchanged (now also feeds the staging preview). |
| `POST /metamodel/lint` | Stays unchanged. |
| `POST /metamodel` (initial bind) / `GET /metamodel` / `GET /metamodel/raw` / `DELETE /metamodel` | Stay unchanged. |

## 6. Frontend

- **Staging.** The metamodel editor's dirty buffer registers as a staged entry
  (`getStagedMetamodelEntry()` beside the three existing journals); the diagram's moved nodes
  stage as coalesced `metamodel.move_node` ops. The DiffDrawer gains a metamodel section (YAML +
  structural diff via `POST /metamodel/diff`, plus "N nodes moved"); its `total` gains the term.
  `hasUnsavedWork()` gains the metamodel term (reversing the deliberate BACKLOG omission — the
  buffer is now staged work like any other).
- **Commit.** `commitStaged` appends the rebind op (owner only) and layout ops to its single
  batch; `lockedResourcesNeededBy` gains the `mm` arm so the token is sent and surrendered through
  the commit like other tokens. On success the metamodel buffer/positions clear with the other
  buffers, then the existing rebound handling (refetch metamodel, drop pre-rebind undo history)
  runs.
- **Preconditions.** `isProjectQuiet()` disappears as a rebind precondition (replaced by the
  server's quiet-peers guard + lease verification + staleness). Preview stays mutually exclusive
  with an in-flight commit as today.
- **Lease.** Acquired on first divergent keystroke **or first node drag** (same `mm` lease, same
  surface-agnostic module); released via commit surrender or discard/close as today.
- **Diagram simplification.** Live debounced PUT, `flushSave`, and the entire draft-rename
  key-inversion machinery (`_pendingRenames`, `serverPositions`/`localPositions`,
  `liveRenames`, the localStorage rename persistence) are **deleted**: positions only ever land
  atomically with the rename that caused them, so staged positions speak draft keys and commit in
  final key space. Position drafts persist to localStorage beside the YAML draft.
  `onMetamodelRebound` reduces to clearing local staging + undo history.
- The `yaml-edit.ts` byte-identity pin and `STRINGIFY_OPTS` are untouched.

## 7. Testing

- **API:** the atomic migration scenario end-to-end (remove a property + strip it from elements in
  one commit; add a mandatory property + populate it); mid-batch failure unwinding to a
  byte-identical old schema (metamodel identity, indexes, validation re-seed); one-rebind-per-batch
  422; hoisting (client sends rebind mid-batch, ops still validate against new schema); `mm` lease
  verification 409; quiet-peers 409 (peer model lease) and non-409 (own leases, peer `art:`/
  `folder:` leases); staleness (rebind in tail → unconditional 409; layout overlap via `mmnode:`);
  owner-role 403; strict-mode exemption; undo round-trip across a rebind commit; layout op
  apply/inverse/null-remove; layout-only commit is cheap (no `set_full`, no forced snapshot);
  hydration replay skips the family; diff rendering (structural + ops on one page; layout
  summary); revert 409; preview dry-run leaves no trace.
- **Frontend (vitest):** staged metamodel entry lifecycle, DiffDrawer section, commit batch
  composition + token surrender, diagram staging/coalescing, discard, localStorage drafts.
- Existing byte-identity round-trip pin for `yaml-edit.ts` stays green untouched.

## Out of scope

- Finer-grained metamodel ops (add-type/rename-property as first-class ops) — the rebind op
  carries the whole YAML; the structural diff renders the change. Kept open, not blocked.
- Revert across `metamodel.*` ranges.
- Any change to `POST /model/ops` (legacy path continues to reject unknown families by
  construction once `split_ops` routes them; it must explicitly reject `metamodel.*` like it does
  artifact/view ops).
- Journaling the layout *history* beyond the op journal (no layout snapshots/versions table).

## Amendments (implementation planning, 2026-08-16)

Two deviations agreed during implementation planning (see the plan's Global
Constraints for full rationale):

1. **Undo across rebind-carrying commits answers 409** (push-back, history
   preserved) instead of replaying the inverse batch. Restore-mode model
   inverses are schema-checked at the core mutation boundary
   (`_check_patch_keys` + `Model.set_property`): a migration batch's inverse
   patches reference old-schema properties (invalid before the swap-back)
   while an additive batch's reference new-schema ones (invalid after it), so
   no single replay order is correct without teaching the core a
   schema-independent restore mode — deferred. Layout-only (`move_node`)
   undo IS supported. The journal still carries the full-state rebind-back
   inverse, so a future phase can lift the 409 without a data migration.
2. **The conflict backstop uses the single `mm` resource** for the whole
   metamodel family instead of per-node `mmnode:` markers: every metamodel
   writer serializes on the exclusive `mm` lease, so finer-grained markers
   can never change an outcome — the simpler, strictly-more-conservative
   marker wins.
