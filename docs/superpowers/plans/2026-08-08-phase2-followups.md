# Plan: Artefacts Phase 2 — post-merge follow-ups

Three independently shippable follow-ups left behind by the merged Phase 2 frontend
rewire. Each gets its own branch off `main` and is merged locally after its task
review is clean (project precedent from Phases 1–2). Do not push.

## Global Constraints

- **Leases are the concurrency control, not OCC.** No `view_rev`/`artifact_rev`
  precondition is ever sent on an op. Do not add one — `UpdateArtifactOp.artifact_rev`
  being optional-and-omitted is what makes the lease load-bearing (CLAUDE.md "Lease rule").
- **The staged view buffer is an ORDERED JOURNAL, not a coalescing map.** View ops are
  order-dependent, so there is deliberately NO per-entry revert; discard is
  all-or-nothing. Do not add per-entry revert.
- **`applyViewOp` (`frontend/src/lib/state/view-ops.ts`) is a MIRROR of the backend
  applier (`src/data_rover/api/view_ops.py::apply_view_ops`).** Any change to one needs
  the same change in the other. Do not "simplify" either side independently.
- **Element placements never target the view root** (`VIEW_ROOT_ID = "root"`); "move to
  root" is `remove_element`. Artifact refs DO have a real root list.
- **Never send an empty commit** — the backend's empty-batch early return skips lock
  release and orphans leases until TTL.
- **Frontend commands must go through the pixi tasks** (they set `cwd=frontend`); a bare
  `pixi run -e frontend npm test` fails with "Missing script". Always run
  `pixi run -e frontend npm run lint` alongside `pixi run frontend-test` /
  `pixi run frontend-check` — lint is part of done.
- **Preserve the dense invariant comments** in every file you touch; they are
  load-bearing. Extend them in the same voice when behavior changes make them stale.
- Tests live in `tests/<area>/` (backend) and alongside sources or in `__tests__/`
  (frontend) — follow the existing convention of the directory you are in.

## Task 1: Excluded-pool injection for staged removals

**Branch:** `fix/excluded-pool-staged-removals` (off `main`).

**Bug (diagnosed):** an element dragged OUT of a folder leaves the in-view tree
(correct — the staged `_view` no longer places it) but never enters the "Not in view"
pool, because the pool's id list comes from `GET /model/containment/roots/excluded`,
which only reflects COMMITTED placements. Until commit or discard the element is in
NEITHER region, which reads as data loss.

**Fix:** in `registerExcludedRoots`
(`frontend/src/lib/components/Sidebar/view-tree.ts:263-269`), mirror the existing
hide-filter with an inject-filter: additionally register element ids that the committed
pool response omits BECAUSE the committed view places them, but which the staged view
no longer places.

Requirements:

1. `view-tree.ts` is a pure builder today (that is why it is unit-testable). Keep it
   pure: the caller (`ContainmentTree.svelte`) has the view/journal context — decide
   whether the injection set is computed there and passed in, or derived inside
   `registerExcludedRoots` from an extra argument. Either way, no store imports into
   `view-tree.ts`.
2. The injection must match the committed-pool endpoint's semantics for what belongs in
   the pool. Read the backend implementation of `GET /model/containment/roots/excluded`
   first (find it under `src/data_rover/api/routes/`) and mirror its membership rule
   (e.g. containment ROOTS only — a staged-removed non-root element must not mint a
   bogus pool root).
3. Cover every staged path that unplaces an element: `remove_element` ops, and
   placements that disappear because their containing folder is staged-deleted
   (`delete_folder`). An id that staging re-placed somewhere else afterwards must NOT
   be injected (it is placed again — the existing `placedElementIds` check should
   already express this; verify with a test).
4. Injected ids must behave like other pool rows: unloaded ids get skeleton
   registration (`kind`/`children` seeding) exactly like the existing loop, and the
   pool's windowed renderer / `ensureElements` flow must pick them up.
5. Unit tests: add cases to the existing `view-tree` test files
   (`frontend/src/lib/components/Sidebar/view-tree-*.test.ts` convention) covering:
   staged remove → injected; staged remove then re-place elsewhere → not injected;
   folder staged-deleted → its placed elements injected; non-root staged-removed
   element → not injected as a pool root (per the endpoint semantics from req. 2);
   no staging → output identical to today (pure filter behavior unchanged).
6. e2e: `frontend/e2e/view.spec.ts:287` and `frontend/e2e/dnd.spec.ts:175` carry
   `TODO(excluded-pool-gap)` markers on assertions that PIN the buggy behavior. INVERT
   those assertions (the element must now appear in the pool) and update their TODO
   comments to record that the gap is closed. Do NOT delete the assertions; do NOT
   "fix the test" instead of the code.

**Verify:** `pixi run frontend-test`, `pixi run frontend-check`,
`pixi run -e frontend npm run lint`, and `pixi run frontend-test-e2e` (~15 min; boots
its own backend + dev server; expect all green — 41/41 was the last full-suite count).

## Task 2: Durable "staged view edits were discarded" banner

**Branch:** `fix/discard-notice-banner` (off `main`).

**Bug (diagnosed):** `dropConflictedJournal`
(`frontend/src/lib/state/view.svelte.ts:171-178`) reports the destructive
"your unsaved folder changes were discarded" event through `setLockNotice`, a
TRANSIENT channel: `edit-gate.ts`'s `noticed()` clears it on the very next successful
lease acquisition of any kind, so the user may never see it. The function's own
docstring documents this compromise and names the intended fix: "a dismissable banner
alongside the conflict/rebind ones in the project page".

**Fix:**

1. Replace the `setLockNotice` call with a dismissible banner surfaced in the project
   page (`frontend/src/routes/p/[projectId]/+page.svelte`), which already renders
   error / peer-rebind / feed-termination banner rows — model the new one on those.
   Check what already exists before inventing a new mechanism:
   `frontend/src/lib/state/access-notice.svelte.ts`,
   `frontend/src/lib/state/lock-notice.svelte.ts`, and the project-page banners are
   the candidates to model on or reuse.
2. The banner must persist until the user dismisses it — in particular it must SURVIVE
   a subsequent successful lease acquisition (the exact path that kills the current
   notice). Write a test for that survival property.
3. Rewrite the now-stale paragraph of `dropConflictedJournal`'s docstring (the one
   documenting the transient-channel compromise) to describe the new banner channel,
   in the same voice.
4. Mind the known `view → realtime → artifacts → view` import cycle (documented at
   length in `view.svelte.ts`): if wiring the banner store into `view.svelte.ts` risks
   widening the cycle, prefer a small cycle-free leaf module for the banner state
   (same shape as the other notice stores).
5. Unit tests for the banner store + the `dropConflictedJournal` integration
   (message set on conflict; dismiss clears; lease success does NOT clear).

**Verify:** `pixi run frontend-test`, `pixi run frontend-check`,
`pixi run -e frontend npm run lint`. (No e2e assertions touch this path; the full e2e
suite runs in Task 1 and again before finishing if any doubt remains.)

## Task 3: Retire legacy view routes

**Branch:** `chore/retire-legacy-view-routes` (off `main`).

**Context:** `PUT /view/snapshot` (`src/data_rover/api/routes/view.py:28`) and
`DELETE /view` (`routes/view.py:115`) were the frontend-migration-window escape hatch;
the client now commits every `view.*` op through `POST /commits` and calls neither
(grep-verified during the rewire). The parent spec
(`docs/superpowers/specs/2026-07-29-artefacts-revamp-design.md`) treats the migration
window as over. `GET /view` stays.

**Steps:**

1. Re-confirm no frontend caller reappeared:
   `grep -rn "putViewSnapshot\|clearView(\|view/snapshot" frontend/src` must come back
   empty (modulo comments); also delete any dead client-API function/schema mirrors for
   these routes if any remain.
2. Delete the two route handlers. Keep `GET /view` intact.
3. Prune now-unused imports/schemas: check whether `ViewSnapshotResponse`, `ViewIn`,
   the `FOLDER_PREFIX` import, `ensure_folder_ids` import etc. in `routes/view.py` /
   `schemas.py` still have users; remove only what is genuinely unreferenced
   (`ViewIn` may still be used by the importer or elsewhere — verify, don't assume).
4. `tests/api/test_view_routes.py`: delete tests that exercise the two routes
   themselves. PORT any coverage that is really about `ensure_folder_ids` healing or
   `view_rev` bumping rather than the routes — the healing still runs on the hydration
   and import paths; make sure those paths keep (or gain) equivalent assertions before
   deleting the route-based versions.
5. Docs: update `CLAUDE.md`'s Phase-2 view-ops bullet — the trailing sentence saying
   the two routes are "live server-side only pending a follow-up retirement cleanup"
   must now say they are gone; also fix the earlier "healed lazily … at
   hydration/PUT/import" phrase (drop PUT). Update any in-code comments that name the
   PUT path as an id-entry point (e.g. `core/view/ids.py`, `routes/view.py` neighbors).
6. Note: the known issue "`DELETE /view` clears `session.view` but leaves `ViewRow`"
   is mooted by this deletion — no replacement behavior is needed.

**Verify:** `pixi run core-test`, `pixi run backend-lint`. Frontend untouched (unless
step 1 found dead client code — then also `pixi run frontend-test`,
`pixi run frontend-check`, `pixi run -e frontend npm run lint`).

## Merge protocol (controller, after each task's review is clean)

`git checkout main && git merge --no-ff <branch> && git branch -d <branch>` — matching
the project's merge-commit precedent. Task N+1 branches off the updated `main`.
After all three: final whole-branch review over `27dadf7..HEAD`. Do not push.
