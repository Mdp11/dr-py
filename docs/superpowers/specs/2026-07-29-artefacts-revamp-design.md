# Artefacts Revamp — Unified Committable Content

**Date:** 2026-07-29
**Status:** Approved design, pre-implementation
**Scope:** A four-phase program that generalizes artifacts, brings artifacts / view / metamodel into the lock→edit→commit world, makes every commit diffable across content types, and adds artifact import/export between projects.

## Motivation & goals

The driver is architectural groundwork, not an acute pain: unify the content model now so that live metamodel editing, a real change-request workflow, and future artifact kinds all land on one coherent foundation.

Decisions made during brainstorming:

1. **Artifacts adopt the full lock→edit→commit flow** (not instant-save-with-lock, not per-kind choice). One editing mental model everywhere; history and diffs fall out of the journal.
2. **Change requests:** this program delivers *diffable commits* across all content types. The real CR workflow (server-side entity, draft → review → approve → merge) is a deliberate follow-up phase built on this foundation. The portable `datarover.cr/v1` document format is **not** extended — it stays as-is (elements/relationships only) during the transition and is subsumed later.
3. **Metamodel:** becomes lockable and diffable in this program. Live partial editing is a future phase; this design must not block it.
4. **View:** full treatment — folder ids, view ops through the journal, per-folder leases, view diffs.
5. **Import/export:** closure-based — exporting an artifact automatically includes its dependencies; import resolves name clashes interactively.

## Architecture: one journal, materialized heads

Chosen over full event sourcing (too heavy: rewrites hydration/snapshotting for purity we don't need) and federated per-content-type streams (no total order, no atomic cross-content commits, three versioning systems forever).

### The journal is universal

The existing `Commit` table (`(project_id, rev)`, one monotonic rev per project) becomes the history for **all** content. The `ops`/`inverse_ops` union (`schemas.OPS_ADAPTER` + `frontend/src/lib/state/ops.ts` mirror) grows two new op families beside the six element/relationship ops:

- **`artifact.create` / `artifact.update` / `artifact.delete`** — coarse-grained. `update` carries the full new payload; its inverse is an `update` carrying the prior payload. We never diff *inside* an op at write time; structural JSON diffs are computed at read time from op + inverse. Artifact deletes leave tolerant dangling refs (view refs, cross-artifact refs) — no cascade.
- **`view.*`** — fine-grained, because per-folder locking and meaningful diffs need it: `folder.create` / `folder.rename` / `folder.move` / `folder.delete`, `place_element` / `remove_element` / `move_element`, `place_artifact` / `remove_artifact` / `move_artifact`.

Metamodel rebinds are already journaled commits; they stop being a conceptual special case and render through the same diff API.

### Materialized heads stay authoritative for "now"

`ArtifactRow.payload`, `ViewRow.blob`, and `ModelRow` remain the current state. A commit updates head rows and appends the journal row in one DB transaction (the existing `POST /commits` pattern). Hydration is unchanged for the model (snapshot + replay of model ops); artifacts and the view hydrate directly from their rows, each row carrying the rev it reflects (`artifact_rev`, new `view_rev`). The journal is read for history, diffs, undo, and (later) CRs — never replayed to answer "what is the current table definition".

### Rev semantics and conflict detection

`model_rev` becomes in effect a **project rev**: any commit bumps it. To prevent spurious staleness (an artifact edit 409ing because someone committed model content), the base-rev check generalizes:

> A batch conflicts iff the set of resources it touches overlaps the set of resources touched by commits in `(base_rev, head]`.

Touched-resource sets derive from ops the same way `required_locks` does; the journal tail makes the check cheap. Leases prevent conflicts before commit; this check is the backstop for legacy unlocked paths and expired leases. Per-artifact `artifact_rev` remains a secondary precondition on artifact ops.

### Feed and caches

Commit feed events gain a `scope` (`model` / `artifact` / `view` / `metamodel`) so clients refresh only what moved. Script-cell-cache invalidation and evaluation-related rev stamping key off model-scoped commits only; artifact/view commits take the existing no-model-delta path and never clear evaluation caches.

### Undo

Unchanged in principle: undo appends a compensating commit, now uniformly across content types (artifact and view ops have exact inverses by construction).

## Locking: typed resources, one lease table

`LockTable` already keys on bare strings; the conflict matrix (EXCLUSIVE/SHARED × EDIT/CREATE_CHILD/CONNECT/DELETE) is untouched. What changes:

- **Typed resource ids.** Namespace: `el:<id>`, `art:<id>`, `folder:<id>`, `mm` (singleton per project). Wire format for lock requests moves from bare ids to `{type, id}`; internally the canonical string keeps `LockTable` unchanged. Leases are in-memory and lost on restart, so there is no migration concern.
- **`expand_targets` branches:** `art:` is always a single resource (even DELETE — dangling refs are tolerated, no subtree). `folder:` with DELETE intent expands to the folder subtree, mirroring element containment. `mm` is a singleton.
- **`required_locks` over new op families:** `artifact.update/delete` → EXCLUSIVE `art:<id>`; `artifact.create` needs no lease (fresh id, mirroring the existing temp-id rule). `folder.create` → EXCLUSIVE on the parent folder (a membership change); `folder.rename/delete` → EXCLUSIVE on that folder; moves take EXCLUSIVE on source **and** destination parents. Element/artifact placement ops → EXCLUSIVE on the containing folder(s) only, so users editing different folders never block each other. The view root is a real folder with a fixed id; root placements lock only root membership.
- **Editor lifecycle.** Opening an artifact editor acquires an EXCLUSIVE `art:` lease up front (fail fast with "locked by <email>"), heartbeats via `/locks/renew`, releases on close; commit auto-releases. Folder leases are finer: acquired when a drag/edit begins, not when the tree is open.
- **Metamodel.** Rebind requires EXCLUSIVE `mm` plus element-lease quiescence (rebind retypes the world under element editors). Artifact and folder leases no longer block rebind (affected artifacts degrade tolerantly). Element-edit commits proceed while someone holds `mm`; the `mm` lease only excludes a second rebinder.
- **Migration window.** Legacy unlocked `PUT /artifacts/{id}` and `PUT /view/snapshot` stay alive (with today's `artifact_rev` / last-write-wins guards) until the frontend flips to the commit flow, then are retired — the same stance Phase 4 took for `/model/ops`. The generalized conflict backstop covers the coexistence window.
- **Sweeper / evict guards** work unchanged; the evict-with-live-locks guard now naturally protects sessions with open artifact editors.

## Phase 1 — Artifact platform

- **Kind registry.** One `ArtifactKindSpec` per kind: `{payload_adapter, derive_metadata, header_fields, extract_deps, rewrite_refs}`. `navigation`, `table`, `code_snippet` register real specs (deps: table → navigation refs; navigation → snippet/navigation refs). `diagram`/`diagram_kind` stay unregistered (422 as today). `routes/artifacts.py` becomes fully generic; a new kind is one registration + one schema module. `extract_deps`/`rewrite_refs` are part of the spec from day one, consumed in Phase 3.
- **Artifact ops through `/commits`.** `OpIn` union (backend + `ops.ts`) gains the artifact family. Apply/inverse/rollback plug into the existing batch applier. Validation of an artifact op = payload-adapter validation + server-side derived-metadata hook; at most CONFORMANCE tier — artifact ops can never be structural blockers. `/commits/preview` works unchanged. `artifact_rev` bumps on commit exactly as on legacy PUT, keeping both paths consistent during the migration window.
- **Diff read API.** `GET /commits/{rev}/diff` renders a commit uniformly: element/relationship diffs (from ops + inverses; the computation the client's `diff.ts` does today moves server-side) and artifact diffs (structural JSON diff of before/after payload — path-level added/removed/changed, computed on demand, nothing stored). This endpoint is the seam the future CR workflow reuses: a CR diff is this function pointed at a draft instead of a commit.
- **Also lands here:** typed lock resources + `art:` leases, commit-event `scope`, the generalized conflict backstop, frontend artifact-editor lease acquisition.

## Phase 2 — View as first-class content

- **Folder identity.** `Folder` gains `id` (uuid); the root has a fixed id. Migration is lazy: hydration assigns ids to blobs lacking them and persists back — no Alembic migration. Frontend `view-ops.ts` switches from name-paths to ids, which also fixes the folder-identity caveat in view change tracking (rename no longer reads as delete+create).
- **View ops.** The `view.*` family lands in the union with apply/inverse; `ViewRow` gains `view_rev`. The frontend save flow changes from whole-document PUT to emitting ops and flushing batches through `/commits` — the same optimistic-ops/serialized-flush pattern `frontend/src/lib/state/` already implements for elements. `view-diff.ts`'s baseline diffing retires; view commits render in the diff API directly from ops.
- **Folder leases** per the locking section, acquired at drag/edit start, fail-fast UX.
- **Bug fixes folded in:** root-level `View.artifacts` round-trips through `ViewOut`/`ViewIn` (today silently dropped); `validate_view` warns on dangling artifact refs.
- **Deferred:** multiple named views per project (schema allows; no UX ask).

## Phase 3 — Import/export

- **Bundle format `datarover.artifact-bundle/v1`:** `{format, exported_at, source_project, roots: [ids], artifacts: [{id, kind, name, payload}]}`. Each payload carries its own `schema_version` — the versioning seam on import. Export takes user-selected roots, computes the dependency closure via `extract_deps`, streams the bundle; the UI previews what the closure pulled in before download.
- **Import flow:** upload → server returns a resolution plan (per artifact: no-clash, or name-clash with proposed action *reuse-existing* / *import-as-copy*) → user confirms → server assigns fresh ids, rewrites cross-refs via `rewrite_refs` (reused artifacts get refs pointed at the existing target artifact), and lands everything as **one commit** ("Imported N artifacts from <source>") — diffable and undoable like any change. Unknown/unregistered kinds in a bundle are reported and skipped, never a hard failure.
- **Clone fixed:** `clone_project` copies artifacts with id remap + ref rewrite (today it silently drops all artifacts, leaving dangling view refs). Project-creation multipart and the importer CLI accept an optional bundle.

## Phase 4 — Metamodel lease + diff

- **Lease:** rebind acquires EXCLUSIVE `mm` (semantics above). The UI shows "metamodel locked by <email>" instead of a bare 409.
- **Structural diff:** metamodel versions are immutable rows, so diffs are computed on demand, nothing stored: parse both YAMLs, compare element types / relationship types / properties / mappings / keys → added/removed/changed with per-facet detail. Exposed in two places through one renderer: `POST /metamodel/diff` gains a `structural` section beside the validation-impact preview (pre-rebind review), and rebind commits render it in the commit-diff API (post-hoc history).

## Cross-cutting

### Error handling

House stance throughout. Presentation/degraded concerns never block: dangling refs render degraded, unknown bundle kinds are skipped with a report, presentation settings normalize rather than 422. Integrity concerns fail atomically: a half-applied batch rolls back via inverses (422), an import commit is all-or-nothing, DB failure after in-memory apply = full rollback + 500 — the existing `/commits` pattern. Artifact/view content can never hard-block a model commit, and vice versa.

### Testing

- Core: op apply/inverse symmetry property tests (apply-then-inverse restores byte-identical state — the invariant undo and diffs lean on) for artifact and view op families.
- Registry: a contract test suite every kind must pass (adapter round-trip, deps extraction, ref rewrite).
- API (hermetic SQLite conftest): lock verification for artifact/folder/mm resources, generalized 409 conflict backstop, import resolution plans, commit-diff rendering per scope.
- Frontend (vitest): view ops flush, editor lease lifecycle, feed `scope` handling.
- E2E: one lock→edit→commit artifact scenario.

### Out of scope (kept open, not blocked)

- Real CR workflow (draft ops + status + review + merge) — next program, built on the commit-diff seam.
- Live metamodel partial editing (metamodel ops).
- Fine-grained ops inside artifact payloads.
- Redis-mirrored locks (multi-instance; Phase 7).
- Multiple named views per project.
- Extending the portable `datarover.cr/v1` document beyond elements/relationships.

## Sequencing

Phases 1 → 2 → 3 → 4, each its own implementation plan. Phase 1 is the foundation (registry, op families, typed locks, diff API); Phase 2 depends on its op/lock machinery; Phase 3 depends on the registry's dep extraction; Phase 4 is independent of 2–3 and can be reordered if needed.
