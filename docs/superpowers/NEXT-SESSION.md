# Next-session handoff — 2026-06-20

## Where things stand

On `main`, clean tree. This past session shipped three merges:

1. **Phase 6A — metamodel-driven connection-rules UX** (`db0b44c`). The "New
   relationship" picker now filters relationship types by the metamodel's
   `mappings` (source-inheritance aware, multi-mapping), has an always-available
   "Show all types" escape hatch, and grays out a type whose source is already at
   its `target_multiplicity` upper bound. Pure-frontend.
   - Logic: `frontend/src/lib/metamodel/connection-rules.ts` (+ `.test.ts`)
   - View: `frontend/src/lib/components/Inspector/NewRelationshipPicker.svelte`
   - e2e: `frontend/e2e/relationship-picker.spec.ts`
   - Spec: `docs/superpowers/specs/2026-06-19-phase-6a-connection-rules-ux-design.md`
   - Plan: `docs/superpowers/plans/2026-06-19-phase-6a-connection-rules-ux.md`

2. **e2e DB-reset fix** (`635a612`). `frontend/playwright.config.ts` now `rm -f`s
   the throwaway SQLite DB on each fresh backend start. Root cause: ephemeral
   in-memory snapshot store vs. persistent SQLite file got out of sync, so a fresh
   backend hydrating a stale snapshot row 500'd. **Gotcha for any e2e run:** if you
   run playwright manually and a backend ISN'T already up, the DB is reset; if one
   IS up (`reuseExistingServer`), it is reused. When debugging, `rm -f
   /tmp/data-rover-e2e.db` before a run from a clean state.

3. **dnd e2e failures fixed at the root** (`9a223b3`). The 2 failures the
   DB-reset unmasked were a **real app bug**: the sidebar tree type-filter latched
   on the first metamodel and never re-seeded, so loading a different metamodel hid
   all its elements (`computeVisibility` marks a loaded element `hidden` when its
   type isn't in the allowlist).
   - Fix: `frontend/src/lib/state/filters.svelte.ts` — seed keyed to the
     metamodel's concrete-type SET signature (re-seeds on metamodel change,
     no-op on same-metamodel re-render). Unit test: `filters.test.ts`.
   - e2e repair: `frontend/e2e/dnd.spec.ts` expands the collapsed "Not in view"
     excluded pool before dragging unplaced elements.

**Verified final state:** full e2e **18/18**, unit suite **406/406**,
`svelte-check` 0 errors.

## What's next: Phase 6B — metamodel swap (NOT STARTED)

Phase 6 was split into A (done) and B (this). 6B = the metamodel-swap half:

- **Read-only sandbox conformance diff** — run a *second* validation pipeline
  bound to a candidate metamodel over the *same live in-memory model* (no copy,
  no lock, not journaled); return `now_failing[]` / `now_passing[]` + unchanged
  counts.
- **Non-destructive journaled rebind** — change the model's `metamodel_id` as a
  normal commit (in history, revertible); may land with outstanding conformance
  issues (engine "stays inspectable"). **Supersedes** the current destructive
  `session.set_metamodel()` / `POST /metamodel` (which clears the model + wipes
  history — see the TODO comment in `src/data_rover/api/routes/metamodel.py`).

Authoritative design context (read these first):
- `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md`
  — §5 "Metamodel swap", §12 phase table (row 6), open questions §13.
- The destructive path to replace: `src/data_rover/api/routes/metamodel.py`
  (`upload_metamodel`), and `session.set_metamodel`.
- Content/journal plumbing it must reuse: `src/data_rover/api/content.py`,
  `hydration.py`, `db_models.py` (`MetamodelRow`, `Commit`), Phase-3/4 docs in
  `docs/superpowers/plans/2026-06-17-*.md`.

Process: this is creative feature work → start with the **brainstorming** skill
(it gates on a written, approved design before any code), then **writing-plans**,
then **subagent-driven-development**. Backend-heavy, so plan for the strongest
test coverage on the validation/rebind path.

## Conventions reminder
- Everything runs through `pixi`. Frontend tests: `cd frontend && pixi run -e
  frontend npm test` / `npm run test:e2e` / `npm run check`. Core: `pixi run
  test-core`. `docs/superpowers/{specs,plans}` are gitignored (local only).
- Branch off `main` for the work; merge with `--no-ff`.
