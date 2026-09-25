# Artefacts Phase 2 — Frontend Rewire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Sample code is ILLUSTRATIVE.** Every snippet below was written against the code as of `main@bbf53e6` and is believed accurate, but the executor must follow the *intent* over literal transcription: re-read the target region before editing, keep surrounding invariant comments, and adapt names/lines if the file has drifted. (The Phase 1 plans' snippets contained real defects; treat these the same way.)

**Goal:** Move the frontend's view editing (folder create/rename/move/delete, element/artifact placement) off the whole-document `PUT /view/snapshot` and onto the Phase-4 lock→edit→commit flow: `folder:` leases are acquired fail-fast at the gesture, every mutation stages a `view.*` op into an ordered journal, and `POST /commits` lands model + artifact + view changes atomically.

**Architecture:** Mirror the backend's three-way op split client-side: `ops.ts` gains the ten-op `ViewOp` family (`Op = ModelOp | ArtifactOp | ViewOp`). A new `lib/state/view-edits.svelte.ts` holds an **ordered journal** of `{op, label}` entries (order-dependent ops — create → place-into → move — so a journal like the model store's queued ops, NOT a coalescing per-id map like the artifact buffer). `view.svelte.ts` mutators become stage-emitters: acquire folder leases via `edit-gate` → apply the op to the local `_view` through a pure `applyViewOp` mirror of the backend applier → append to the journal. `view-tree.ts` re-keys folder nodes by the new stable `Folder.id`. `checkout.svelte.ts` concatenates three buffers into preview/commit; folder tokens are always sent at commit (the element rule). Post-commit reconciliation is a one-shot `GET /view` refetch (server truth concretizes `tmp_` folder ids), never a client-side id remap. `view-diff.ts`'s baseline diffing retires; the DiffDrawer's View section renders journal labels.

**Tech Stack:** SvelteKit + Svelte 5 runes + TypeScript + Zod + Vitest (happy-dom + MSW) + Playwright. Everything through `pixi`.

Spec: `docs/superpowers/specs/2026-08-07-artefacts-phase-2-frontend-design.md`. Parent spec: `2026-07-29-artefacts-revamp-design.md` §Phase 2.

## Decisions (made while planning; do not re-litigate without the user)

1. **Stage everything.** Every view gesture stages a `view.*` op and updates `_view` optimistically; nothing reaches the server until the DiffDrawer commit. Sidebar is dirty-until-commit; staged view edits are lost on reload (same as staged model ops).
2. **Lease timing: drop-time + dialog-open.** DnD acquires ONE all-or-nothing lease set covering exactly the folders the op needs at DROP time (grant ⇒ stage; 409 ⇒ lock notice, nothing staged, nothing applied). Dialog edits (rename / new folder / delete confirm) acquire BEFORE the prompt/confirm opens; denial means the prompt never shows. A granted-then-cancelled dialog releases its lease if nothing staged needs it. Granted leases are held until commit/discard.
3. **Clear view = staged delete-all batch.** ViewSelector's Clear stages `delete_folder` for every top-level folder + `remove_artifact` for every root artifact ref (one all-or-nothing subtree lease acquire, `delete` intent). `DELETE /view` loses its last frontend caller (`clearView` wrapper deleted).
4. **The two Phase 1 denied-tab gaps are fixed here** (Task 10): a lock-denied artifact editor tab becomes read-only (not just unsaveable) and offers "Save as copy" via the existing save-as forks (snippets gain one).
5. **Buffer shape: ordered journal + optimistic local view.** Consequence: **no per-gesture selective revert** — the View section's discard is all-or-nothing (plucking op 2 of 5 from an order-dependent journal is unsound).
6. **Post-commit reconciliation is a refetch, not a remap.** After any commit whose scope includes `"view"` (ours via the `onViewCommitted` listener; a peer's via the realtime commit tap), `view.svelte.ts` refetches `GET /view` once. An own-commit may refetch twice (direct notify + feed echo) — accepted, the view blob is small.
7. **Artifact delete scrubs placements in-batch.** Staging an artifact DELETE also acquires EDIT leases on every folder holding it (two-step acquire with rollback — see Task 9) and stages the matching `remove_artifact` ops. A peer's folder lock therefore blocks deleting an artifact placed there — correct: the delete edits that folder's contents. If the user later discards just the artifact delete (per-row), the scrub ops stay in the view journal — visible as labelled rows, discardable with the view section; accepted wrinkle.
8. **No per-op OCC precondition** — `view_rev` is never sent; the lease is the concurrency control (mirrors Phase 1 Decision 3).
9. **Never send an empty commit** (Phase 1 Decision 6) — unchanged guard in `commitStaged`.
10. **Folder tokens are always sent at commit** — the element rule ("commit ends the editing session"); only artifact tokens with open editors survive. The existing partition (`artifactOnly && unneeded → keep`) already produces this — folder tokens are not artifact-only — so this is a comment + test, not a code change.
11. **Client index math mirrors the backend exactly.** `move_element` pops from the source THEN clamps + inserts (`api/view_ops.py:378-408`), so intra-folder reorder (`from == to`) is legal and the op's `index` is relative to the list WITHOUT the moved element. Multi-select emits one op per id, applied locally one-at-a-time via `applyViewOp` between emissions, so each op's `index` is derived from the state the server will actually see (convergence by construction).
12. **`place_element` is only for UNPLACED elements** — the backend 422s if the element is already placed anywhere (`view_ops.py:329-335`); the mutator picks `place_element` vs `move_element` from `_view`. Element ops never target the root (`VIEW_ROOT_ID`): exclude = `remove_element`. Artifact ops DO accept `VIEW_ROOT_ID` as `folder_id` (root list is real).
13. **Intents:** `verify_held` (`locking.py:210-231`) matches (resource, holder, token, mode) and IGNORES intent, so the client uses `edit` intent everywhere except folder deletes (`delete` intent + client-walked subtree targets, matching the backend's conflict semantics: a DELETE-intent exclusive conflicts with ANY peer lease) and folder creates (`create_child` on the parent).
14. **Stage-time labels.** Journal entries carry a display `label` built at stage time (after local apply, a renamed/deleted folder's old name is unrecoverable). Element names in labels use the best available display name at stage time (uncached ⇒ the id) — accepted; the DiffDrawer renders labels verbatim.
15. **HistoryDrawer stays on client-side model reconstruction** (Phase 1 Decision 8): view commits appear with message/op-count; consuming `GET /commits/{rev}/diff` is a separate follow-up slice.

## Global Constraints

- **No global `python`/`node`** — always `pixi run`. Frontend commands must run *inside `frontend/`*: `pixi run -e frontend bash -c 'cd frontend && npm test'` (vitest; `npm test -- <path>` for one file), `… npm run check` (svelte-check), `… npm run lint`. A bare `pixi run -e frontend npm test` fails ("Missing script").
- **Backend untouched.** This slice is frontend-only. If a backend change seems needed, stop and surface it — that's a scope change.
- **The wire contract is fixed** (section below) — rename nothing, add nothing.
- **Barrels:** every new public store/API function MUST be added to `lib/state/index.ts` / `lib/api/index.ts`.
- **Elements keep BARE lock resource ids**; artifacts are `art:`-prefixed, folders `folder:`-prefixed client-side (canonical forms the server hands back).
- **Zod schema order matters** — `types.ts` schemas are `const`s; a forward reference throws at module init (TDZ).
- **Preserve the dense invariant docstrings/comments** in files you touch; extend them in the same voice.
- **Tests colocate in `__tests__/` dirs** next to the source. MSW suites use `lib/api/__tests__/server.ts` + per-test `server.use(...)`; store suites use `vi.spyOn`/module mocks.
- **Frequent commits:** one git commit per task (final step of each task). Branch: create `feat/artefacts-phase-2-frontend` off `main` before Task 1.
- **Legacy backend routes stay alive** (`PUT /view/snapshot`, `DELETE /view`) — the frontend stops CALLING them; retiring them server-side is a later backend cleanup.

## Backend wire contract (reference — verified against `main@bbf53e6`)

- **Ops** (`api/schemas.py:331-403`): `create_folder {temp_id, parent_id, name, index?}`; `rename_folder {id, name}`; `move_folder {id, to_parent_id, index?}`; `delete_folder {id}`; `place_element {element_id, folder_id, index?}`; `remove_element {element_id, folder_id}`; `move_element {element_id, from_folder_id, to_folder_id, index?}`; `place_artifact {artifact_id, artifact_kind, folder_id, index?}` (`artifact_kind` is a plain string — tolerant dangler); `remove_artifact {artifact_id, folder_id}`; `move_artifact {artifact_id, from_folder_id, to_folder_id, index?}`. `index: int | None`, None = append (server clamps and canonicalizes). Temp-id prefix `tmp_` shared with elements/artifacts; folder temp ids flow into the commit's shared `id_map` (`api/view_ops.py:239-243`).
- **Root:** `VIEW_ROOT_ID = "root"`. `place_element` at root 422s ("use remove_element"); artifact ops accept root as `folder_id`.
- **Apply semantics** (`api/view_ops.py`): `place_element` 422s if the element is placed ANYWHERE (`_element_home`); `move_element` 422s if not in `from_folder_id`, pops, clamps `index` to the post-pop list, inserts — `from == to` reorder is legal; `place_artifact` 422s if that container already holds the id; `create_folder` requires the `tmp_` prefix on `temp_id`, 422 on sibling name clash (rename/move too).
- **Locks** (`locking.py:465-497`): create_folder → EXCLUSIVE CREATE_CHILD on parent; rename → EXCLUSIVE EDIT on the folder; move_folder → EXCLUSIVE EDIT on the source's CURRENT container + the destination parent; delete_folder → EXCLUSIVE DELETE over the whole subtree; place/remove element|artifact → EXCLUSIVE EDIT on the containing folder; move element|artifact → EXCLUSIVE EDIT on both endpoints. Targets are sent with the BARE folder id + `type: "folder"`; granted `LeaseOut.resource_id` comes back canonicalized `folder:<id>` (root ⇒ `folder:root`). `verify_held` ignores intent (Decision 13).
- **Commit:** view ops ride the same `POST /commits` batch; commit feed events carry `scope: ("model"|"artifact"|"view")[]`. `/commits/preview` dry-validates view ops (no lock check). `/model/ops` and `POST /model/validate` reject the family; `/commits/revert` 409s across it.
- **409 shapes:** unchanged from Phase 1 — locks acquire → `{detail: {conflicts: [{resource_id, held_by, held_by_email, held_mode}]}}`; commit → `{detail: "stale base_rev"|…}` / `{detail: "required lock not held", missing: [...]}`.
- **`GET /view`** returns folders WITH `id` (healed server-side on every read path). `PUT /view/snapshot` and `DELETE /view` stay alive server-side but lose their frontend callers.

---

## Task 1: `ops.ts` — `ViewOp` family, `folder:` namespace, `Folder.id`, `LockTargetIn` folder arm

**Files:**
- Modify: `frontend/src/lib/state/ops.ts` (117 lines today)
- Modify: `frontend/src/lib/api/types.ts` (`Folder` interface + `FolderSchema` ~:129-143, `LockTargetInSchema` ~:218-225)
- Modify: `frontend/src/lib/state/index.ts` (barrel)
- Test: `frontend/src/lib/state/__tests__/ops.test.ts` (exists)

**Interfaces:**
- Produces: `type ViewOp` (10 kinds, shapes below); `Op = ModelOp | ArtifactOp | ViewOp`; `FOLDER_RESOURCE_PREFIX = 'folder:'`; `folderResource(id: string): string`; `isFolderResource(rid: string): boolean`; `VIEW_ROOT_ID = 'root'`; `Folder.id: string`; `LockTargetIn.type` accepts `'folder'`. Every later task consumes these exact names.

- [ ] **Step 1: Write the failing tests** (append to `ops.test.ts`):

```ts
import { folderResource, isFolderResource, FOLDER_RESOURCE_PREFIX, VIEW_ROOT_ID } from '../ops';
import type { ViewOp, Op } from '../ops';

describe('folder lock namespace', () => {
	it('prefixes folder ids with folder:', () => {
		expect(folderResource('f1')).toBe('folder:f1');
		expect(folderResource(VIEW_ROOT_ID)).toBe('folder:root');
		expect(FOLDER_RESOURCE_PREFIX).toBe('folder:');
	});
	it('classifies resource ids', () => {
		expect(isFolderResource('folder:f1')).toBe(true);
		expect(isFolderResource('art:f1')).toBe(false);
		expect(isFolderResource('f1')).toBe(false);
	});
	it('view ops are assignable to Op', () => {
		const op: ViewOp = { kind: 'rename_folder', id: 'f1', name: 'B' };
		const asOp: Op = op; // compile-time check
		expect(asOp.kind).toBe('rename_folder');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/ops.test.ts'`
Expected: FAIL — `folderResource` not exported.

- [ ] **Step 3: Implement in `ops.ts`** — after the `ArtifactOp` block:

```ts
/**
 * View-content ops (artefacts revamp Phase 2) — mirror of the backend's
 * ViewOpIn (api/schemas.py). Applied by POST /commits to the session view
 * blob (api/view_ops.py), never to the model; /model/ops rejects them.
 * No `view_rev` precondition exists on any of these BY DECISION: the
 * folder: lease is the concurrency control, exactly as `update_artifact`
 * never sends `artifact_rev` (CLAUDE.md "Lease rule").
 * `index` omitted = append (the server clamps + canonicalizes it).
 */
export type ViewOp =
	| { kind: 'create_folder'; temp_id: string; parent_id: string; name: string; index?: number }
	| { kind: 'rename_folder'; id: string; name: string }
	| { kind: 'move_folder'; id: string; to_parent_id: string; index?: number }
	| { kind: 'delete_folder'; id: string }
	| { kind: 'place_element'; element_id: string; folder_id: string; index?: number }
	| { kind: 'remove_element'; element_id: string; folder_id: string }
	| {
			kind: 'move_element';
			element_id: string;
			from_folder_id: string;
			to_folder_id: string;
			index?: number;
	  }
	| {
			kind: 'place_artifact';
			artifact_id: string;
			artifact_kind: string;
			folder_id: string;
			index?: number;
	  }
	| { kind: 'remove_artifact'; artifact_id: string; folder_id: string }
	| {
			kind: 'move_artifact';
			artifact_id: string;
			from_folder_id: string;
			to_folder_id: string;
			index?: number;
	  };
```

Replace `export type Op = ModelOp | ArtifactOp;` with `export type Op = ModelOp | ArtifactOp | ViewOp;`. Then, next to the `art:` helpers:

```ts
/** Client mirror of api/locking.py's FOLDER_PREFIX (same idiom as `art:`):
 * folder lock targets are REQUESTED with the bare folder id + type:"folder",
 * granted leases come back canonicalized under this namespace, and the
 * checkout registry keys on the canonical form. */
export const FOLDER_RESOURCE_PREFIX = 'folder:';

export function folderResource(folderId: string): string {
	return FOLDER_RESOURCE_PREFIX + folderId;
}

export function isFolderResource(resourceId: string): boolean {
	return resourceId.startsWith(FOLDER_RESOURCE_PREFIX);
}

/** The view root's fixed folder id (backend core/view/ids.VIEW_ROOT_ID).
 * Element ops may NEVER name it (an unplaced element already renders at the
 * root — "move to root" is remove_element); artifact ops MAY (the root has a
 * real artifacts list). `folder:root` is a genuine lease target. */
export const VIEW_ROOT_ID = 'root';
```

- [ ] **Step 4: `types.ts` — `Folder.id` + `LockTargetIn` folder arm**

In the `Folder` interface and `FolderSchema` add `id`:

```ts
export interface Folder {
	/** Stable uuid4-hex id, healed server-side on every read (Phase 2). Locally
	 * staged folders carry a `tmp_` id until their commit's id_map lands. */
	id: string;
	name: string;
	folders: Folder[];
	elements: string[];
	artifacts: ArtifactRef[];
}
```

and in the zod object: `id: z.string(),` (REQUIRED — the server heals ids on every read path; a missing id is a real error we want loud). In `LockTargetInSchema`, extend the enum: `type: z.enum(['element', 'artifact', 'metamodel', 'folder']).optional()` and extend its comment (`"folder" -> "folder:<id>"`).

- [ ] **Step 5: Fix compile fallout**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Every test/helper that builds a `Folder` literal now needs an `id` (view-ops tests, view-tree tests, MSW fixtures, `cloneFolder` in `view-ops.ts` — add `id: f.id` to the clone). Mechanical; do NOT change behavior. (`view-ops.ts`'s big rewrite is Task 2 — here only make it compile by carrying `id` through `cloneFolder`/`cloneView` and any literal.)

- [ ] **Step 6: Run tests + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/ops.test.ts && npm run check'`
Expected: PASS / 0 errors.

- [ ] **Step 7: Barrel + commit**

Add `folderResource`, `isFolderResource`, `FOLDER_RESOURCE_PREFIX`, `VIEW_ROOT_ID`, `type ViewOp` to `lib/state/index.ts` (mirror how the `art:` trio is exported).

```bash
git add frontend/src/lib/state/ops.ts frontend/src/lib/api/types.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/ops.test.ts
git commit -m "feat(frontend): ViewOp op family, folder: lock namespace, Folder.id"
```
(plus whatever fixture files Step 5 touched.)

---

## Task 2: `view-ops.ts` — id-addressed helpers + `applyViewOp` (the client-side applier mirror)

**Files:**
- Modify: `frontend/src/lib/state/view-ops.ts` (249 lines today — this is a REWRITE of the addressing layer; keep `cloneFolder`/`cloneView`)
- Test: `frontend/src/lib/state/__tests__/view-ops.test.ts` (exists — rewrite to id addressing)

**Interfaces:**
- Consumes: `ViewOp`, `VIEW_ROOT_ID` from Task 1.
- Produces (all pure, no runes): `findFolderById(view, id): Folder | null`; `findFolderContainer(view, id): { siblings: Folder[]; parentId: string } | null`; `folderSubtreeIds(view, id): string[]` (id first, then descendants); `isFolderIdAncestor(view, ancestorId, folderId): boolean` (true for self); `elementHomeFolderId(view, elementId): string | null`; `artifactPlacementFolderIds(view, artifactId): string[]` (includes `VIEW_ROOT_ID` when the root list holds it); `applyViewOp(view, op): View` (clone-and-apply, throws `Error` with the same reasons the backend 422s). The old path-based helpers (`findFolderByPath`, `isFolderPathAncestor`, `placeElementsInView(At)`, `moveFolderInView`, `placeArtifactInFolder`, `moveArtifactInView`) are KEPT here — mark each `@deprecated Phase 2: id addressing; deleted when the last caller migrates (Task 7)` — so `svelte-check` stays green after every task; Task 7 deletes them once `view.svelte.ts` and the tree have migrated. `removeArtifactFromView` + `viewHasArtifactPlacement` survive permanently (Task 9 uses the placement query; the scrub applier goes through `applyViewOp`). Tasks 5/6/7 consume these exact names.

**IMPORTANT — mirror fidelity:** `applyViewOp` must reproduce `api/view_ops.py`'s apply semantics (read it first: `apply_view_ops`, ~:198-470) so that local optimistic state equals what the server computes replaying the same journal. Specifically: `move_element` pops from source THEN clamps `index` to the post-pop destination and inserts (from==to legal); `place_element` throws if the element has a home anywhere or targets root; `place_artifact` throws if the container already holds the id; `create_folder` throws on sibling name clash (so do rename/move); `delete_folder` drops the subtree wholesale; `move_folder` throws on cycle (destination inside the moved folder's subtree) and on name clash.

- [ ] **Step 1: Write the failing tests** (rewrite `view-ops.test.ts`; representative cases — keep/port existing coverage for clone + artifact scrub):

```ts
import type { View } from '$lib/api/types';
import { VIEW_ROOT_ID } from '../ops';
import {
	applyViewOp,
	artifactPlacementFolderIds,
	elementHomeFolderId,
	findFolderById,
	findFolderContainer,
	folderSubtreeIds,
	isFolderIdAncestor
} from '../view-ops';

const view = (): View => ({
	name: 'v',
	folders: [
		{
			id: 'fa',
			name: 'A',
			elements: ['e1', 'e2'],
			artifacts: [{ id: 'art1', kind: 'table' }],
			folders: [{ id: 'fb', name: 'B', elements: ['e3'], artifacts: [], folders: [] }]
		},
		{ id: 'fc', name: 'C', elements: [], artifacts: [], folders: [] }
	],
	artifacts: [{ id: 'art2', kind: 'navigation' }]
});

describe('id addressing', () => {
	it('finds folders and containers by id', () => {
		expect(findFolderById(view(), 'fb')?.name).toBe('B');
		expect(findFolderContainer(view(), 'fb')?.parentId).toBe('fa');
		expect(findFolderContainer(view(), 'fa')?.parentId).toBe(VIEW_ROOT_ID);
		expect(findFolderById(view(), 'nope')).toBeNull();
	});
	it('walks subtrees and ancestry', () => {
		expect(folderSubtreeIds(view(), 'fa')).toEqual(['fa', 'fb']);
		expect(isFolderIdAncestor(view(), 'fa', 'fb')).toBe(true);
		expect(isFolderIdAncestor(view(), 'fa', 'fa')).toBe(true);
		expect(isFolderIdAncestor(view(), 'fb', 'fa')).toBe(false);
	});
	it('locates element homes and artifact placements', () => {
		expect(elementHomeFolderId(view(), 'e3')).toBe('fb');
		expect(elementHomeFolderId(view(), 'unplaced')).toBeNull();
		expect(artifactPlacementFolderIds(view(), 'art1')).toEqual(['fa']);
		expect(artifactPlacementFolderIds(view(), 'art2')).toEqual([VIEW_ROOT_ID]);
	});
});

describe('applyViewOp', () => {
	it('creates a folder under root and under a parent', () => {
		let v = applyViewOp(view(), {
			kind: 'create_folder', temp_id: 'tmp_x', parent_id: VIEW_ROOT_ID, name: 'N'
		});
		expect(v.folders.map((f) => f.id)).toContain('tmp_x');
		v = applyViewOp(v, { kind: 'create_folder', temp_id: 'tmp_y', parent_id: 'tmp_x', name: 'M' });
		expect(findFolderById(v, 'tmp_y')).not.toBeNull();
	});
	it('rejects sibling name clashes like the backend', () => {
		expect(() =>
			applyViewOp(view(), { kind: 'create_folder', temp_id: 'tmp_x', parent_id: VIEW_ROOT_ID, name: 'A' })
		).toThrow(/already exists/);
	});
	it('place_element refuses placed elements and the root', () => {
		expect(() =>
			applyViewOp(view(), { kind: 'place_element', element_id: 'e1', folder_id: 'fc' })
		).toThrow(/already placed/);
		expect(() =>
			applyViewOp(view(), { kind: 'place_element', element_id: 'ex', folder_id: VIEW_ROOT_ID })
		).toThrow(/root/);
	});
	it('move_element reorders within a folder with post-pop index math', () => {
		// e1 at 0, e2 at 1: moving e1 below e2 means index 1 AFTER the pop.
		const v = applyViewOp(view(), {
			kind: 'move_element', element_id: 'e1', from_folder_id: 'fa', to_folder_id: 'fa', index: 1
		});
		expect(findFolderById(v, 'fa')?.elements).toEqual(['e2', 'e1']);
	});
	it('delete_folder drops the whole subtree', () => {
		const v = applyViewOp(view(), { kind: 'delete_folder', id: 'fa' });
		expect(findFolderById(v, 'fb')).toBeNull();
		expect(v.folders.map((f) => f.id)).toEqual(['fc']);
	});
	it('move_folder rejects cycles', () => {
		expect(() =>
			applyViewOp(view(), { kind: 'move_folder', id: 'fa', to_parent_id: 'fb' })
		).toThrow(/descendant/);
	});
	it('artifact ops treat root as a real container', () => {
		const v = applyViewOp(view(), {
			kind: 'move_artifact', artifact_id: 'art2', from_folder_id: VIEW_ROOT_ID, to_folder_id: 'fc'
		});
		expect(v.artifacts.some((a) => a.id === 'art2')).toBe(false);
		expect(findFolderById(v, 'fc')?.artifacts.map((a) => a.id)).toEqual(['art2']);
	});
	it('does not mutate its input', () => {
		const before = view();
		const snapshot = JSON.stringify(before);
		applyViewOp(before, { kind: 'rename_folder', id: 'fa', name: 'Z' });
		expect(JSON.stringify(before)).toBe(snapshot);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/view-ops.test.ts'`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement**

Sketch (follow the backend applier's branch order; keep the module docstring's "pure helpers, unit tested directly" framing and extend it with the mirror-fidelity contract):

```ts
export function findFolderById(view: View, id: string): Folder | null {
	const walk = (folders: Folder[]): Folder | null => {
		for (const f of folders) {
			if (f.id === id) return f;
			const hit = walk(f.folders);
			if (hit !== null) return hit;
		}
		return null;
	};
	return walk(view.folders);
}

/** The sibling list holding `id` plus its parent's id (VIEW_ROOT_ID for a
 * top-level folder). Null when `id` is unknown or IS the root sentinel —
 * the root is not a folder and has no container. */
export function findFolderContainer(
	view: View,
	id: string
): { siblings: Folder[]; parentId: string } | null {
	const walk = (siblings: Folder[], parentId: string): { siblings: Folder[]; parentId: string } | null => {
		for (const f of siblings) {
			if (f.id === id) return { siblings, parentId };
			const hit = walk(f.folders, f.id);
			if (hit !== null) return hit;
		}
		return null;
	};
	return walk(view.folders, VIEW_ROOT_ID);
}

export function folderSubtreeIds(view: View, id: string): string[] {
	const root = findFolderById(view, id);
	if (root === null) return [];
	const out: string[] = [];
	const walk = (f: Folder): void => {
		out.push(f.id);
		for (const c of f.folders) walk(c);
	};
	walk(root);
	return out;
}

export function isFolderIdAncestor(view: View, ancestorId: string, folderId: string): boolean {
	return folderSubtreeIds(view, ancestorId).includes(folderId);
}

export function elementHomeFolderId(view: View, elementId: string): string | null {
	const walk = (folders: Folder[]): string | null => {
		for (const f of folders) {
			if (f.elements.includes(elementId)) return f.id;
			const hit = walk(f.folders);
			if (hit !== null) return hit;
		}
		return null;
	};
	return walk(view.folders);
}

export function artifactPlacementFolderIds(view: View, artifactId: string): string[] {
	const out: string[] = [];
	if (view.artifacts.some((a) => a.id === artifactId)) out.push(VIEW_ROOT_ID);
	const walk = (folders: Folder[]): void => {
		for (const f of folders) {
			if (f.artifacts.some((a) => a.id === artifactId)) out.push(f.id);
			walk(f.folders);
		}
	};
	walk(view.folders);
	return out;
}
```

`applyViewOp(view, op)`: `const next = cloneView(view);` then switch on `op.kind`. Container resolution helper (artifact/create branches accept root):

```ts
/** The {folders, elements?, artifacts} lists addressed by a folder id, with
 * VIEW_ROOT_ID resolving to the view's own root lists — the client twin of
 * api/view_ops.py's _container. Throws (mirroring the backend's 422) when the
 * id names no live folder. */
function containerOf(next: View, folderId: string): { folders: Folder[]; artifacts: ArtifactRef[] } {
	if (folderId === VIEW_ROOT_ID) return { folders: next.folders, artifacts: next.artifacts };
	const f = findFolderById(next, folderId);
	if (f === null) throw new Error(`Folder not found: ${folderId}`);
	return f;
}
```

Branches (element lists only exist on real folders — `place_element`/`move_element` resolve via `findFolderById` and throw on root):

- `create_folder`: container = `containerOf(next, op.parent_id).folders`; throw `already exists` on sibling name clash; splice `{id: op.temp_id, name: op.name, folders: [], elements: [], artifacts: []}` at clamped `op.index ?? end`.
- `rename_folder`: find container via `findFolderContainer`; throw on missing / sibling clash; set `name`.
- `move_folder`: throw `Cannot move a folder into itself or a descendant` when `isFolderIdAncestor(next, op.id, op.to_parent_id)`; pop from source container; throw on destination name clash; insert into `containerOf(next, op.to_parent_id).folders` at clamped index.
- `delete_folder`: pop from its container (subtree goes with it).
- `place_element`: throw on root target; throw when `elementHomeFolderId(next, op.element_id) !== null`; insert at clamped index.
- `remove_element`: filter out of the named folder (throw if folder missing; tolerate absent element — backend 422s, but the mutators never emit that; keep the throw to match: `element not placed in folder`).
- `move_element`: pop from `from` (throw if absent), clamp against post-pop `to.elements`, insert.
- `place_artifact`: container may be root; throw when it already holds the id; insert `{id, kind: op.artifact_kind}` at clamped index.
- `remove_artifact`: filter from the container's `artifacts`.
- `move_artifact`: remove from `from` container, insert into `to` container unless already there.

Keep the deprecated path-based helpers compiling (they still carry `Folder.id` through clones after Task 1); port `removeArtifactFromView`/`viewHasArtifactPlacement` unchanged (they are already id-agnostic scans).

- [ ] **Step 4: Run tests + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/view-ops.test.ts && npm run check'`
Expected: PASS / 0 errors (old helpers still exist, so nothing else breaks).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/view-ops.ts frontend/src/lib/state/__tests__/view-ops.test.ts
git commit -m "feat(frontend): id-addressed view helpers + applyViewOp applier mirror"
```

---

## Task 3: `view-edits.svelte.ts` — the staged-view-ops journal

**Files:**
- Create: `frontend/src/lib/state/view-edits.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (barrel)
- Test: `frontend/src/lib/state/__tests__/view-edits.test.ts` (new)

**Interfaces:**
- Consumes: `ViewOp` from Task 1.
- Produces: `interface StagedViewEntry { op: ViewOp; label: string }`; `stageViewOp(op: ViewOp, label: string): void`; `getStagedViewOps(): ViewOp[]`; `getStagedViewEntries(): StagedViewEntry[]`; `getStagedViewDepth(): number`; `clearStagedView(): void` (commit-success path, silent); `discardStagedView(): void` (user-discard path — same wipe; the refetch + lease release live in the caller, Task 5's `discardViewChanges`); `resetViewEdits(): void` (test/project-switch reset); `onViewCommitted(cb: () => void): () => void`; `notifyViewCommitted(): void`. Tasks 4/5/8 consume these exact names.

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearStagedView,
	discardStagedView,
	getStagedViewDepth,
	getStagedViewEntries,
	getStagedViewOps,
	notifyViewCommitted,
	onViewCommitted,
	resetViewEdits,
	stageViewOp
} from '../view-edits.svelte';

beforeEach(() => resetViewEdits());

describe('staged view journal', () => {
	it('preserves insertion order — view ops are order-dependent', () => {
		stageViewOp({ kind: 'create_folder', temp_id: 'tmp_a', parent_id: 'root', name: 'N' }, 'Created folder "N"');
		stageViewOp({ kind: 'place_element', element_id: 'e1', folder_id: 'tmp_a' }, 'Placed e1 in "N"');
		stageViewOp({ kind: 'rename_folder', id: 'tmp_a', name: 'M' }, 'Renamed folder "N" → "M"');
		expect(getStagedViewOps().map((o) => o.kind)).toEqual([
			'create_folder', 'place_element', 'rename_folder'
		]);
		expect(getStagedViewDepth()).toBe(3);
		expect(getStagedViewEntries()[2].label).toBe('Renamed folder "N" → "M"');
	});
	it('clear and discard both wipe; neither fires the commit listeners', () => {
		const committed = vi.fn();
		const unsub = onViewCommitted(committed);
		stageViewOp({ kind: 'delete_folder', id: 'f1' }, 'Deleted folder');
		clearStagedView();
		expect(getStagedViewDepth()).toBe(0);
		stageViewOp({ kind: 'delete_folder', id: 'f2' }, 'Deleted folder');
		discardStagedView();
		expect(getStagedViewDepth()).toBe(0);
		expect(committed).not.toHaveBeenCalled();
		unsub();
	});
	it('notifyViewCommitted fans out to listeners and unsubscribes cleanly', () => {
		const a = vi.fn();
		const b = vi.fn();
		const unsubA = onViewCommitted(a);
		onViewCommitted(b);
		notifyViewCommitted();
		unsubA();
		notifyViewCommitted();
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/view-edits.test.ts'`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Module docstring must state the two load-bearing contrasts with its siblings: (1) ORDERED JOURNAL, not a coalescing per-id map — view ops are order-dependent (create → place-into → move), unlike `artifact-edits.svelte.ts`'s ONE-ENTRY-PER-ID invariant, and therefore NO per-entry revert exists (an all-or-nothing discard is the only unwind; plucking op 2 of 5 out of an order-dependent journal is unsound); (2) `label` is captured AT STAGE TIME because after the optimistic local apply a renamed/deleted folder's prior name is unrecoverable from `_view`.

```ts
import type { ViewOp } from './ops';

export interface StagedViewEntry {
	op: ViewOp;
	label: string;
}

let _journal = $state<StagedViewEntry[]>([]);

export function stageViewOp(op: ViewOp, label: string): void {
	_journal = [..._journal, { op, label }];
}

export function getStagedViewOps(): ViewOp[] {
	return _journal.map((e) => e.op);
}

export function getStagedViewEntries(): StagedViewEntry[] {
	return [..._journal];
}

export function getStagedViewDepth(): number {
	return _journal.length;
}

/** Commit-success path: wipe SILENTLY — the edits were saved, not undone
 * (mirrors clearStagedArtifacts; notifyViewCommitted is the authoritative
 * "it landed" signal, fired separately by checkout). */
export function clearStagedView(): void {
	_journal = [];
}

/** User-discard path. The journal has no per-entry listeners to notify
 * (no editor holds a view op open); the caller (view.svelte.ts's
 * discardViewChanges) refetches GET /view and releases folder leases. */
export function discardStagedView(): void {
	_journal = [];
}

export function resetViewEdits(): void {
	_journal = [];
}

const _commitListeners: (() => void)[] = [];

/** Fired by checkout.svelte.ts after a successful POST /commits whose batch
 * carried view ops — view.svelte.ts subscribes to refetch GET /view (server
 * truth; concretizes tmp_ folder ids). Lives HERE, not in view.svelte.ts,
 * so checkout never imports the view store (no cycle: view.svelte.ts →
 * edit-gate → checkout → view-edits). */
export function onViewCommitted(cb: () => void): () => void {
	_commitListeners.push(cb);
	return () => {
		const i = _commitListeners.indexOf(cb);
		if (i !== -1) _commitListeners.splice(i, 1);
	};
}

export function notifyViewCommitted(): void {
	for (const cb of [..._commitListeners]) cb();
}
```

- [ ] **Step 4: Run tests, add to barrel**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/view-edits.test.ts && npm run check'`
Expected: PASS / 0 errors. Export everything from `lib/state/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/view-edits.svelte.ts frontend/src/lib/state/__tests__/view-edits.test.ts frontend/src/lib/state/index.ts
git commit -m "feat(frontend): staged view-op journal store"
```

---

## Task 4: `checkout.svelte.ts` + `realtime.svelte.ts` — three-buffer commit, folder lock arm

**Files:**
- Modify: `frontend/src/lib/state/checkout.svelte.ts` (635 lines — read its docstrings first; every ordering comment is load-bearing)
- Modify: `frontend/src/lib/state/realtime.svelte.ts` (`hasModelLocks`, ~:77-105)
- Test: `frontend/src/lib/state/__tests__/checkout.test.ts` (exists — extend), `frontend/src/lib/state/__tests__/realtime.test.ts` (exists — extend)

**Interfaces:**
- Consumes: `getStagedViewOps`, `clearStagedView`, `discardStagedView`, `notifyViewCommitted` (Task 3); `folderResource`, `isFolderResource` (Task 1).
- Produces: `previewStaged`/`commitStaged` carry `[...model, ...artifact, ...view]`; `canonicalResource` maps `type:'folder'`; `lockedResourcesNeededBy` covers view ops; `releaseFolderLeaseIfUnneeded(folderId: string): Promise<void>` (Task 5's dialog-cancel + discard path); `discardAll` also wipes the view journal. `hasModelLocks()` ignores `folder:` leases.

- [ ] **Step 1: Write the failing tests** (extend `checkout.test.ts`; follow the file's existing mocking idiom — it stubs `$lib/api/checkout` and the sibling stores with `vi.mock`):

```ts
// New cases, names indicative:
it('commitStaged sends model+artifact+view ops in that order', async () => {
	// stage one of each via the mocked stores' getters, spy on commitChanges,
	// assert ops array = [modelOp, artifactOp, viewOp] and that
	// clearStagedView + notifyViewCommitted were called after success.
});
it('folder tokens are always sent at commit (element rule), artifact keep-open rule unchanged', async () => {
	// registry: token A covers folder:f1 (not needed by batch), token B covers
	// art:x (not needed, open editor). commitStaged must SEND A and keep B.
});
it('lockedResourcesNeededBy covers the view family', () => {
	// exercised through discardArtifact/releaseArtifactIfUnneeded like the
	// existing suite does, or export it under __testing if the suite already
	// does so — keep the file's existing pattern.
});
it('releaseFolderLeaseIfUnneeded releases only when no staged view op needs any resource the token covers', async () => {
	// held folder:f1; staged view op naming f1 -> kept. Journal cleared -> released.
});
it('discardAll wipes the view journal too', async () => {
	// discardStagedView (from view-edits mock) called once.
});
```

And in `realtime.test.ts`:

```ts
it('hasModelLocks ignores folder: leases like art:', () => {
	// seed _lockState with only 'folder:f1' -> false; add bare 'e1' -> true.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/checkout.test.ts src/lib/state/__tests__/realtime.test.ts'`
Expected: FAIL.

- [ ] **Step 3: Implement in `checkout.svelte.ts`**

1. Imports: add `getStagedViewOps, clearStagedView, discardStagedView, notifyViewCommitted` from `./view-edits.svelte`; add `folderResource, isFolderResource` to the `./ops` import.
2. `canonicalResource` gains: `if (t.type === 'folder') return folderResource(t.resource_id);`
3. `previewStaged` and `commitStaged` op concatenation becomes `[...getStagedOps(), ...getStagedArtifactOps(), ...getStagedViewOps()]` (view LAST — folder ops may reference artifact temp ids via `place_artifact`, and the backend seeds the view applier's id_map from the earlier halves).
4. `lockedResourcesNeededBy` — extend the switch (extend its docstring: view ops name their containing folders; `move_folder`'s SOURCE container is not named by the op — its lease rides the same gesture token as the destination, and token-granularity keep/release covers it):

```ts
case 'create_folder':
	needed.add(folderResource(op.parent_id));
	break;
case 'rename_folder':
case 'delete_folder':
	needed.add(folderResource(op.id));
	break;
case 'move_folder':
	needed.add(folderResource(op.to_parent_id));
	break;
case 'place_element':
case 'remove_element':
	needed.add(folderResource(op.folder_id));
	break;
case 'move_element':
	needed.add(folderResource(op.from_folder_id));
	needed.add(folderResource(op.to_folder_id));
	break;
case 'place_artifact':
case 'remove_artifact':
	needed.add(folderResource(op.folder_id));
	break;
case 'move_artifact':
	needed.add(folderResource(op.from_folder_id));
	needed.add(folderResource(op.to_folder_id));
	break;
```

5. `commitStaged`: the empty-guard now checks all three buffers (it does implicitly via `ops.length`). Token partition needs NO code change (a folder token is not `artifactOnly`, so it is sent — Decision 10) — but ADD a sentence to the partition comment saying folder tokens ride the element rule deliberately. In the post-success reconciliation block: `clearStagedView()` immediately after `clearStagedArtifacts()` (step-1 ordering comment: all three buffers before token drop), and fire `notifyViewCommitted()` after `notifyArtifactCommit(...)` — but ONLY when the batch actually carried view ops (`ops.some((o) => o.kind.startsWith('create_folder') ? … )` — simplest: compute `const hadViewOps = getStagedViewOps().length > 0` BEFORE clearing; a needless refetch is harmless but the guard keeps model-only commits refetch-free).
6. New export, sibling of `releaseArtifactIfUnneeded` (mirror its docstring stance — no open-tab rule for folders, dialogs are transient):

```ts
/**
 * Release my folder:<id> lease on dialog cancel / discard — UNLESS a staged
 * view op still needs a resource that token covers (a granted-then-cancelled
 * rename must hand its lease back; a granted-then-STAGED one must keep it or
 * the commit 409s "required lock not held"). Token-granularity like its
 * artifact sibling: a gesture token covering {source container, destination}
 * is kept while ANY of its resources is still needed.
 */
export async function releaseFolderLeaseIfUnneeded(folderId: string): Promise<void> {
	const rid = folderResource(folderId);
	const token = _registry.get(rid)?.token;
	if (token === undefined) return;
	const stillNeeded = lockedResourcesNeededBy([
		...getStagedOps(),
		...getStagedArtifactOps(),
		...getStagedViewOps()
	]);
	const tokenResources = [..._registry].filter(([, l]) => l.token === token).map(([r]) => r);
	if (tokenResources.some((r) => stillNeeded.has(r))) return;
	_dropToken(token);
	await releaseLock(token, _clientConfig).catch(() => {});
	if (_registry.size === 0) _stopHeartbeat();
}
```

7. `discardAll`: call `discardStagedView()` alongside `discardAllStagedArtifacts()`. Folder tokens are NOT in `openArtifactResources()`, so the existing keep-set logic already releases them. Extend the docstring ("view journal is wiped too; folder leases are never keep-open — dialogs are transient").
8. `releaseArtifactIfUnneeded` and `discardArtifact`: their `stillNeeded` computations must ALSO include `getStagedViewOps()` (a staged `place_artifact` view op does not need the `art:` lease, but keeping the three-buffer union here is the honest "everything staged" set and future-proofs the folder half of a mixed token). Mechanical: change `[...getStagedOps(), ...getStagedArtifactOps()]` to the three-buffer union in both.

Then `realtime.svelte.ts` — `hasModelLocks`: import `isFolderResource` and change the loop body to `if (!isArtifactResource(rid) && !isFolderResource(rid)) return true;`, extending the docstring (a folder lease is view-scope: every drag gesture takes one; counting it would let one user's sidebar drag disable model revert for everyone).

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/checkout.test.ts src/lib/state/__tests__/realtime.test.ts && npm run check'`
Expected: PASS / 0 errors.

- [ ] **Step 5: Full suite + commit**

Run: `pixi run frontend-test` — expected all green (nothing calls the new paths yet).

```bash
git add frontend/src/lib/state/checkout.svelte.ts frontend/src/lib/state/realtime.svelte.ts frontend/src/lib/state/__tests__/checkout.test.ts frontend/src/lib/state/__tests__/realtime.test.ts frontend/src/lib/state/index.ts
git commit -m "feat(frontend): three-buffer commit + folder: lock arm in checkout/realtime"
```

---

## Task 5: `edit-gate.ts` folder gates + `view.svelte.ts` stage-mutator rewrite

**Files:**
- Modify: `frontend/src/lib/state/edit-gate.ts` (87 lines)
- Modify: `frontend/src/lib/state/view.svelte.ts` (274 lines — full mutator rewrite)
- Modify: `frontend/src/lib/api/view.ts` (delete `putViewSnapshot`; keep `getView`; delete `clearView`)
- Modify: `frontend/src/lib/state/artifacts.svelte.ts` (only if `npm run check` flags the `scrubArtifactFromView` import — it should NOT yet; the scrub still exists until Task 9)
- Modify: `frontend/src/lib/state/index.ts`, `frontend/src/lib/api/index.ts` (barrels)
- Test: `frontend/src/lib/state/__tests__/view.test.ts` (exists — rewrite), `frontend/src/lib/state/__tests__/edit-gate.test.ts` (exists — extend)

**Interfaces:**
- Consumes: Tasks 1-4 surfaces; `elementDisplayName` from `$lib/util/element-name`; `getCachedElements` from `./model.svelte`; `onCommitEvent` from `./realtime.svelte` (module-scope tap — the `table-editor.svelte.ts:1689` precedent; function declarations hoist, so the partial-module window is safe).
- Produces (edit-gate): `folderTargets(ids: string[]): LockTargetIn[]`; `folderEditLock(folderIds: string[]): Promise<boolean>`; `folderCreateLock(parentId: string): Promise<boolean>`; `folderDeleteLock(subtreeIds: string[]): Promise<boolean>` — all notice-based (`noticed(...)`), like the element gates.
- Produces (view store — the STAGE mutators; `Promise<boolean>` = "was it staged", false ⇒ lease denied and the gate already showed the notice):
  - `stageCreateFolder(parentId: string, name: string): Promise<boolean>`
  - `stageRenameFolder(id: string, name: string): Promise<boolean>`
  - `stageDeleteFolder(id: string): Promise<boolean>`
  - `stageMoveFolder(id: string, toParentId: string): Promise<boolean>`
  - `stagePlaceElementsAt(folderId: string | null, ids: string[], index: number): Promise<boolean>` (null ⇒ exclude: `remove_element` per placed id)
  - `stageRemoveElement(elementId: string): Promise<boolean>`
  - `stagePlaceArtifact(folderId: string, ref: ArtifactRef): Promise<boolean>` (`VIEW_ROOT_ID` legal)
  - `stageMoveArtifact(fromFolderId: string, toFolderId: string, ref: ArtifactRef): Promise<boolean>`
  - `stageRemoveArtifactRef(folderId: string, artifactId: string): Promise<boolean>`
  - `stageClearView(): Promise<boolean>` — Decision 3's delete-all batch
  - `discardViewChanges(): Promise<void>` — journal wipe + folder-lease release + `refreshView()`
  - TRANSITIONAL path shims keeping today's exports compiling until Task 7 rewires the tree: `createFolder(parentPath, name)`, `renameFolder(path, newName)`, `deleteFolder(path)`, `placeElement(path, id)`, `placeElements(path, ids)`, `placeElementsAt(path, ids, index)`, `removeElement(id)`, `moveFolder(sourcePath, destParentPath)`, `placeArtifact(folderPath, ref)`, `moveArtifact(fromPath, toPath, ref)`, `removeArtifactFromFolder(folderPath, artifactId)`, `dropView()` — each resolves its path(s) to folder ids against `_view` (walk by names) and delegates to the `stage*` twin. Mark all `@deprecated — deleted in Task 7`.
  - KEPT for now (retired in Task 8 with the DiffDrawer/TopBar switch): `_baseline`, `setViewBaseline`, `getViewChanges`, `getViewChangesCount`. `pushView` is DELETED here; `scrubArtifactFromView` becomes a staged-scrub (Task 9) — until then keep it but change its body to a no-op returning immediately with a `// Phase 2: superseded by staged scrub (Task 9)` comment so nothing PUTs.

**Semantics the mutators must implement** (each: client-side precondition guards FIRST — name clash, cycle, no-op — so we never acquire a lease for a doomed gesture; THEN the gate; THEN emit+apply+stage):

- `stageCreateFolder`: guard sibling clash (`containerOf` equivalent via `findFolderById`/root); `folderCreateLock(parentId)`; `const tempId = createTempId();` op `{kind:'create_folder', temp_id: tempId, parent_id: parentId, name}`; label `` `Created folder "${name}"` ``.
- `stageRenameFolder`: guard missing/self-rename/sibling clash; `folderEditLock([id])`; label `` `Renamed folder "${oldName}" → "${name}"` ``.
- `stageDeleteFolder`: `folderDeleteLock(folderSubtreeIds(_view, id))`; label `` `Deleted folder "${name}"` ``.
- `stageMoveFolder`: guard cycle (`isFolderIdAncestor`), same-parent no-op (return true, stage nothing), destination name clash; lease `[containerId(id), toParentId]` via `folderEditLock` (dedup; `containerId` = `findFolderContainer(_view, id)!.parentId`); op `{kind:'move_folder', id, to_parent_id: toParentId}`; label uses both folder names.
- `stagePlaceElementsAt`: resolve per-id home via `elementHomeFolderId`. Targets = destination (when non-null) + every distinct home of ids that are moving/being removed. ONE `folderEditLock` call. Then per id IN SELECTION ORDER, against the CURRENT `_view` (apply between emissions — Decision 11):
  - null destination: placed ⇒ `{kind:'remove_element', element_id: id, folder_id: home}`; unplaced ⇒ skip.
  - unplaced ⇒ `{kind:'place_element', element_id: id, folder_id: folderId, index: at}`;
  - placed (same or other folder) ⇒ `{kind:'move_element', element_id: id, from_folder_id: home, to_folder_id: folderId, index: at}` where for a same-folder move with `oldIndex < requestedIndex` the emitted index is `requestedIndex - 1` (post-pop math, Decision 11); successive ids insert at `at + 1`, `at + 2`, …
  - Labels: `` `Placed ${elLabel(id)} in "${folderName}"` `` / `` `Moved ${elLabel(id)} to "${folderName}"` `` / `` `Removed ${elLabel(id)} from "${folderName}"` `` with `elLabel(id) = getCachedElements().get(id) ? elementDisplayName(el) : id`.
- `stageRemoveElement(elementId)`: sugar for `stagePlaceElementsAt(null, [elementId], 0)`.
- `stagePlaceArtifact`: no-op-true if container already holds it; `folderEditLock([folderId])`; op carries `artifact_kind: ref.kind`; label `` `Placed artifact "${ref.id}" …` `` — use the artifact header name when available (`getArtifactHeaders()` import is fine: artifacts.svelte.ts does not import view.svelte.ts after Task 9; UNTIL Task 9 it does — so use a lazy `import('./artifacts.svelte')`? NO — keep it simple and cycle-free: label with the ref id now; Task 9 upgrades labels to header names when it breaks the artifacts→view import).
- `stageMoveArtifact`: same-container no-op-true; lease both containers; label as above.
- `stageRemoveArtifactRef`: lease the container; `remove_artifact`.
- `stageClearView`: targets = every folder id in `_view` (all subtrees) + `VIEW_ROOT_ID`; ONE `folderDeleteLock(allIds)`; then per top-level folder `{kind:'delete_folder', id}` (label per folder) and per root ref `{kind:'remove_artifact', artifact_id, folder_id: VIEW_ROOT_ID}`; empty view ⇒ no-op-true (never stage an empty batch's worth of nothing).
- `discardViewChanges`: capture `const rids = [...folder-resources currently held]` BEFORE `discardStagedView()`; then for each folder id, `releaseFolderLeaseIfUnneeded(id)`; then `refreshView()` (restores `_view` to server truth, since optimistic applies are baked in).
- Refetch wiring at module scope:

```ts
// Post-commit reconciliation (spec Decision 6): a commit that carried view
// ops refetches server truth ONCE (concretizes tmp_ folder ids — no client
// id_map remap). Two subscriptions, both cheap:
//  - our own commit: view-edits' listener registry (fired by commitStaged);
//  - a peer's commit: the realtime tap, scope-gated.
// An own-commit may fire both (feed echo) — two GET /view of a small blob.
onViewCommitted(() => void refreshView());
onCommitEvent(({ scope }) => {
	if (scope.includes('view')) void refreshView();
});
```

`refreshView` keeps setting the baseline (dies in Task 8). `clearViewState` additionally calls `resetViewEdits()`.

- [ ] **Step 1: Write the failing tests** (rewrite `view.test.ts` around the stage mutators; mock `./edit-gate` gates to resolve `true`/`false` and `$lib/api/view` `getView`; representative cases):

```ts
it('stageCreateFolder stages op + applies optimistically on lease grant', async () => {
	// seed _view via refreshView with mocked getView; folderCreateLock -> true
	// expect journal [create_folder tmp_*], getView() tree shows the folder.
});
it('stageRenameFolder refuses without staging when the lease is denied', async () => {
	// folderEditLock -> false; journal empty; _view unchanged.
});
it('same-folder reorder emits post-pop index (Decision 11)', async () => {
	// folder f1 elements [e1,e2]; stagePlaceElementsAt('f1',['e1'],2)
	// -> move_element {from:'f1',to:'f1',index:1}; local order [e2,e1].
});
it('multi-select cross-folder move emits sequential move_element ops with stepped indices', async () => {});
it('unplaced ids emit place_element; excluded ids emit remove_element per home', async () => {});
it('stageClearView stages delete_folder per top folder + remove_artifact per root ref', async () => {});
it('a view-scoped peer commit refetches GET /view', async () => {
	// fire the captured onCommitEvent tap with {scope:['model','view']}; getView called.
});
it('discardViewChanges wipes the journal, releases folder leases, refetches', async () => {});
```

Extend `edit-gate.test.ts`: the three folder gates send `type:'folder'` targets with the right modes/intents (`create_child` / `edit` / `delete`) and route refusals through `setLockNotice`.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/view.test.ts src/lib/state/__tests__/edit-gate.test.ts'`
Expected: FAIL.

- [ ] **Step 3: Implement `edit-gate.ts` additions**

```ts
export function folderTargets(folderIds: string[]): LockTargetIn[] {
	// dedup — a move whose source container IS the destination parent sends one target
	return [...new Set(folderIds)].map((id) => ({
		resource_id: id,
		mode: 'exclusive' as const,
		type: 'folder' as const
	}));
}

/** Folder gates (Phase 2): notice-based like the element gates — the sidebar
 * has no inline place to render a holder. Intent nuance (Decision 13):
 * verify_held ignores intent, so `edit` fits every gesture except delete
 * (DELETE-intent conflicts with ANY peer lease — the backend's semantics for
 * a destructive claim over the subtree the CALLER walks and passes here) and
 * create (`create_child` on the parent, mirroring required_locks). */
export async function folderEditLock(folderIds: string[]): Promise<boolean> {
	return acquireLocks(folderTargets(folderIds), 'edit');
}

export async function folderCreateLock(parentId: string): Promise<boolean> {
	return acquireLocks(folderTargets([parentId]), 'create_child');
}

export async function folderDeleteLock(subtreeIds: string[]): Promise<boolean> {
	return acquireLocks(folderTargets(subtreeIds), 'delete');
}
```

- [ ] **Step 4: Implement the `view.svelte.ts` rewrite** per the semantics block above. Shape of one mutator as the template (keep this exact guard→gate→emit-apply-stage order in all of them):

```ts
export async function stageRenameFolder(id: string, name: string): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	const folder = findFolderById(_view, id);
	if (folder === null) throw new Error(`Folder not found: ${id}`);
	if (folder.name === name) return true; // no-op, stage nothing
	const container = findFolderContainer(_view, id);
	if (container?.siblings.some((f) => f.id !== id && f.name === name)) {
		throw new Error(`Folder "${name}" already exists at this level`);
	}
	if (!(await folderEditLock([id]))) return false; // gate showed the notice
	const label = `Renamed folder "${folder.name}" → "${name}"`;
	const op: ViewOp = { kind: 'rename_folder', id, name };
	_view = applyViewOp(_view, op); // optimistic; applyViewOp re-checks and throws on drift
	stageViewOp(op, label);
	return true;
}
```

Delete `pushView`; delete `putViewSnapshot` + `clearView` from `lib/api/view.ts`. Grep-clean: `grep -rn "putViewSnapshot\|clearView(" frontend/src` must return no hits (`clearView(` with the paren so `clearViewState`/`stageClearView` don't false-positive; `dropView`'s shim now delegates to `stageClearView`). Update both barrels.

- [ ] **Step 5: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/view.test.ts src/lib/state/__tests__/edit-gate.test.ts && npm run check'`
Expected: PASS / 0 errors (path shims keep the tree compiling).

- [ ] **Step 6: Full suite + commit**

Run: `pixi run frontend-test`. Pre-existing view/tree suites exercising the OLD mutators still pass through the shims (they now stage instead of PUT — suites that asserted a PUT happened need updating to assert staging; fix them here, do not delete coverage).

```bash
git add -A frontend/src/lib frontend/src/lib/api/view.ts
git commit -m "feat(frontend): view mutators stage view.* ops behind folder leases"
```

---

## Task 6: Tree re-keying — `view-tree.ts` by folder id, DnD + dialogs onto the stage mutators

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/view-tree.ts` (497 lines)
- Modify: `frontend/src/lib/components/Sidebar/ContainmentTree.svelte` (drop handler ~:1100-1141, `onNewRootFolder` ~:1218, `onMoveToFolder`, folder-options walk, `dragSourceFolderPath` bookkeeping)
- Modify: `frontend/src/lib/components/Sidebar/TreeRow.svelte` (folder context-menu flows ~:150-181)
- Modify: any other `data-drop-path` / `decodeFolderPayload` consumer `grep` finds (Search-drag adapter)
- Test: `frontend/src/lib/components/Sidebar/__tests__/view-tree-build.test.ts`, `view-tree-dnd.test.ts`, `view-tree-window.test.ts` (all exist — rewrite key/path assertions to ids)

**Interfaces:**
- Consumes: `stage*` mutators + `discardViewChanges` (Task 5); `folderCreateLock`/`folderEditLock`/`folderDeleteLock` (Task 5); `releaseFolderLeaseIfUnneeded` (Task 4); `folderSubtreeIds`, `isFolderIdAncestor` (Task 2); `VIEW_ROOT_ID` (Task 1).
- Produces: `folderKey(id: string): string`; `folderIdFromKey(key: string): string`; `UnifiedTree.folderPathNames: Map<string, string[]>` (key → display path, for the Move-to-folder picker labels ONLY — never for addressing); DnD folder payload = `[folderId]`; element drop resolution `{ folderId: string | null; index: number }` (null = exclude). `folderPathFromKey`, path-encoded payloads, and every path-based signature are deleted.

**Key changes in `view-tree.ts`:**

1. `folderKey(id)` = `FOLDER_KEY_PREFIX + id`; `folderIdFromKey(key)` strips the prefix (throws on non-folder key, as `folderPathFromKey` did). The NUL-fencing rationale comment stays (an id can never start with NUL either).
2. `ingestFolder` keys nodes by `folder.id`, keeps the duplicate-sibling-NAME skip (server enforces uniqueness; the guard is against malformed blobs) and the `placementOwner` first-wins rule unchanged. It also records `folderPathNames` (parent names + own name) for picker labels.
3. `encodeFolderPayload`/`decodeFolderPayload` now carry `[folderId]` (keep the JSON-array wire shape so `decodeStringArray` is reused).
4. `canDropFolder` becomes view-consulting:

```ts
/** A folder drop is legal unless the destination parent sits inside the
 * dragged folder's own subtree (cycle). Root (null destParent) is always a
 * legal parent. Takes the live view because ancestry is an id walk now, not
 * a path-prefix check. */
export function canDropFolder(args: {
	view: View;
	sourceId: string;
	destParentId: string | null;
}): DropCheck {
	const { view, sourceId, destParentId } = args;
	if (destParentId !== null && isFolderIdAncestor(view, sourceId, destParentId)) {
		return { ok: false, reason: 'Cannot move a folder into itself or a descendant' };
	}
	return { ok: true };
}
```

5. `resolveElementDrop` returns `{ folderId: string | null; index: number }`; the `folderPath` args become `folderId` (`data-drop-path` attributes in the components become `data-drop-folder-id`; the section/pool sentinel logic is otherwise unchanged).

**Key changes in the components:**

- Drop handler (`onWindowPointerUp`) — capture stays BEFORE `endGesture()` (the known ordering trap: `endGesture` clears `draggingPayload`/`dragSourceFolderId`, so everything the awaited mutators need must be captured first; keep that comment):

```ts
const sourceFolderId = dragSourceFolderId; // was dragSourceFolderPath
suppressClick = true;
endGesture();
if (!valid || payload === null || target === null) return;
try {
	if (payload.kind === 'element') {
		const res = resolveElementDrop({ targetKind: target.kind, folderId: target.folderId, ... });
		await stagePlaceElementsAt(res.folderId, payload.ids, res.index);
	} else if (payload.kind === 'folder') {
		await stageMoveFolder(payload.id, target.folderId ?? VIEW_ROOT_ID);
	} else {
		const ref = { id: payload.id, kind: payload.artifactKind };
		const dest = target.folderId ?? VIEW_ROOT_ID;
		if (sourceFolderId !== null) await stageMoveArtifact(sourceFolderId, dest, ref);
		else await stagePlaceArtifact(dest, ref);
	}
} catch (err) {
	console.error('Drop failed', err);
}
```

(The mutators run the drop-time lease acquire internally — a denial resolves `false` after showing the lock notice; no throw.)

- `TreeRow` folder flows — lease at DIALOG OPEN, release on cancel (Decision 2). Rename as the template; new-subfolder (`folderCreateLock(folderId)`) and delete (`folderDeleteLock(folderSubtreeIds(view, folderId))` then `confirm(...)`) follow the same shape:

```ts
async function onRenameFolder(): Promise<void> {
	if (!(await folderEditLock([folderId]))) return; // fail-fast BEFORE the prompt
	const next = window.prompt('Rename folder', folderName);
	if (next === null || next.trim() === '' || next.trim() === folderName) {
		// granted-then-cancelled: hand the lease back unless something staged needs it
		void releaseFolderLeaseIfUnneeded(folderId);
		return;
	}
	try {
		await stageRenameFolder(folderId, next.trim());
	} catch (err) {
		alert(err instanceof Error ? err.message : 'Failed to rename folder');
	}
}
```

- `ContainmentTree.onNewRootFolder`: `folderCreateLock(VIEW_ROOT_ID)` → prompt → cancel-release `VIEW_ROOT_ID` → `stageCreateFolder(VIEW_ROOT_ID, name)`. `onMoveToFolder(elementId, folderId | null)`: null → `stageRemoveElement`, else `stagePlaceElementsAt(folderId, [elementId], Number.MAX_SAFE_INTEGER)`. Folder-options walk uses `folderIdFromKey` + `folderPathNames` labels.

- [ ] **Step 1: Rewrite the three view-tree test files** to id keys (fixtures already carry `Folder.id` since Task 1). Representative new assertions: `folderKey('fa')` stability under rename (the key must NOT change when the name does — THE Phase 2 point); `canDropFolder` cycle check via ids; `resolveElementDrop` returning `folderId`.
- [ ] **Step 2: Run to verify failure** — `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Sidebar/__tests__/'` → FAIL.
- [ ] **Step 3: Implement** `view-tree.ts` + component changes above. `grep -rn "folderPathFromKey\|data-drop-path\|dragSourceFolderPath" frontend/src` must come back empty.
- [ ] **Step 4: Run** the Sidebar suites + `npm run check` → PASS / 0 errors.
- [ ] **Step 5: Full suite** `pixi run frontend-test` → green. **Manual smoke** (optional but recommended): `pixi run backend-start` + `pixi run frontend-start`, drag an element between folders, watch the journal count rise in the TopBar instead of a PUT firing.
- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Sidebar frontend/src/lib/state
git commit -m "feat(frontend): tree re-keys folders by id; DnD + dialogs stage view ops behind leases"
```

---

## Task 7: Cleanup sweep — delete the path shims and deprecated helpers

**Files:**
- Modify: `frontend/src/lib/state/view.svelte.ts` (delete every `@deprecated` path shim: `createFolder`, `renameFolder`, `deleteFolder`, `placeElement`, `placeElements`, `placeElementsAt`, `removeElement`, `moveFolder`, `placeArtifact`, `moveArtifact`, `removeArtifactFromFolder`, `dropView`)
- Modify: `frontend/src/lib/state/view-ops.ts` (delete `findFolderByPath`, `isFolderPathAncestor`, `placeElementsInView`, `placeElementsInViewAt`, `moveFolderInView`, `placeArtifactInFolder`, `moveArtifactInView`)
- Modify: `frontend/src/lib/state/index.ts` (drop the deleted exports)
- Test: existing suites only (deletions)

**Interfaces:** consumes nothing new; produces the final public surface — after this task the ONLY view mutation API is the `stage*` family.

- [ ] **Step 1: Delete** the shims and deprecated helpers. `ViewSelector.svelte` still imports `dropView` — switch it to `stageClearView` here (behavior identical; the copy rework is Task 8).
- [ ] **Step 2: Grep-clean**

Run: `grep -rn "findFolderByPath\|isFolderPathAncestor\|placeElementsInView\|moveFolderInView\|placeArtifactInFolder\|moveArtifactInView\|dropView\|pushView\|putViewSnapshot" frontend/src`
Expected: no hits (test files included — port any lingering test to the id API instead of deleting coverage).

- [ ] **Step 3: Run** `pixi run frontend-test` + `npm run check` → green / 0 errors.
- [ ] **Step 4: Commit**

```bash
git add -A frontend/src
git commit -m "refactor(frontend): delete path-addressed view API; stage* is the only mutation surface"
```

---

## Task 8: DiffDrawer View section, TopBar counter, ViewSelector copy — retire `view-diff.ts`

**Files:**
- Modify: `frontend/src/lib/components/DiffDrawer.svelte` (View tab: ~:53-69 name prefetch, ~:196-230 change list + segments, the View tab's discard wiring; keep the save-view-file flow minus its `setViewBaseline` call)
- Modify: `frontend/src/lib/components/TopBar.svelte` (~:57 `viewChanges`)
- Modify: `frontend/src/lib/components/Sidebar/ViewSelector.svelte` (copy + confirm text)
- Delete: `frontend/src/lib/state/view-diff.ts`, `frontend/src/lib/state/view-change-format.ts`
- Modify: `frontend/src/lib/state/view.svelte.ts` (delete `_baseline`, `setViewBaseline`, `getViewChanges`, `getViewChangesCount`), `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/components/__tests__/DiffDrawer*.test.ts` (extend), TopBar test if present; delete `view-diff` test file

**Interfaces:**
- Consumes: `getStagedViewEntries`, `getStagedViewDepth` (Task 3); `discardViewChanges` (Task 5).
- Produces: the DiffDrawer's `total` includes `getStagedViewDepth()`; the View section renders `entry.label` rows in journal order with ONE "Discard view changes" button (`discardViewChanges()` — all-or-nothing, Decision 5: no per-row discard, unlike the element/artifact sections; put that contrast in a comment where the artifact rows render their per-row buttons).

- [ ] **Step 1: Write the failing tests** — DiffDrawer suite: staged view entries render as rows with their labels, in order; the commit gate's total counts them; the discard button calls `discardViewChanges` once; a commit with only view entries enables Commit. TopBar: counter = journal depth.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** DiffDrawer: replace `viewChangeList`/`changeKey`/`viewChangeSegments`/`SEGMENT_CLASS` and the name-prefetch `$effect` with a plain `const viewEntries = $derived(getStagedViewEntries());` list render (labels are pre-baked strings — Decision 14). TopBar: `const viewChanges = $derived(getStagedViewDepth());`. ViewSelector: button label stays "Clear", confirm copy becomes `Stage removal of every folder in "${view.name}"? The change lands on your next commit.`; the warning-count chip stays. Delete the two retired modules + baseline machinery; fix barrels.
- [ ] **Step 4: Grep-clean** `grep -rn "getViewChanges\|view-diff\|view-change-format\|setViewBaseline" frontend/src` → no hits.
- [ ] **Step 5: Run** `pixi run frontend-test` + `npm run check` → green / 0 errors.
- [ ] **Step 6: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): DiffDrawer/TopBar consume the view journal; baseline diffing retires"
```

---

## Task 9: Artifact-delete scrubs placements in-batch + peer folder lock badges

**Files:**
- Modify: `frontend/src/lib/state/artifacts.svelte.ts` (`removeArtifact` ~:183-203, the `onArtifactCommit` scrub call ~:245)
- Modify: `frontend/src/lib/state/view.svelte.ts` (delete the no-op `scrubArtifactFromView`; `stageRemoveArtifactRef` gains the optional `displayName` label arg)
- Modify: `frontend/src/lib/components/Sidebar/TreeRow.svelte` (folder rows gain the peer-lock badge)
- Test: `frontend/src/lib/state/__tests__/artifacts.test.ts` (exists — extend), TreeRow badge test in the Sidebar suite

**Interfaces:**
- Consumes: `artifactPlacementFolderIds` (Task 2); `folderEditLock` (Task 5); `stageRemoveArtifactRef(folderId, artifactId, displayName?)` (Task 5, extended here); `releaseArtifactIfUnneeded` (existing); `getLockFor` from `realtime.svelte`, `folderResource` (Task 1), `getCurrentUserId` from `$lib/api/client`.
- Produces: `removeArtifact` stages `delete_artifact` + one `remove_artifact` view op per placement, or refuses whole (Decision 7); folder rows show "locked by peer" badges.

- [ ] **Step 1: Write the failing tests**

```ts
it('removeArtifact stages the delete plus a remove_artifact per placement', async () => {
	// view holds art1 in folder fa and at root; artifactDeleteLock -> true,
	// folderEditLock -> true. Expect staged delete_artifact + journal
	// [remove_artifact{fa}, remove_artifact{root}].
});
it('removeArtifact rolls back the art: lease when a placement folder is denied', async () => {
	// folderEditLock -> false: releaseArtifactIfUnneeded called, nothing staged.
});
it('removeArtifact with no placements stages only the delete (no folder lease call)', async () => {});
it('a peer folder lease renders a lock badge on the folder row', () => {});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `removeArtifact`** (keep the COMMITTED-header comment; extend the docstring: Decision 7 — the delete's commit carries its own scrub; a peer's folder lock blocks the delete because the delete edits that folder's contents; the two-step acquire exists because ONE call would need one intent, and `delete` intent on folder targets would subtree-expand server-side — `expand_targets` — far beyond what the scrub touches):

```ts
export async function removeArtifact(id: string): Promise<void> {
	if (isTempId(id)) {
		revertStagedArtifact(id);
		return;
	}
	if (!(await artifactDeleteLock(id))) return;
	const header = getCommittedArtifactHeaders().find((a) => a.id === id);
	if (!header) {
		await releaseArtifactIfUnneeded(id);
		return;
	}
	// Decision 7: the delete's batch also removes every view placement, so the
	// commit leaves no dangling refs. Folder EDIT leases, acquired as a SECOND
	// step (a single call would put `delete` intent on the folders and
	// subtree-expand server-side); denial rolls the art: lease back.
	const view = getView();
	const placements = view ? artifactPlacementFolderIds(view, id) : [];
	if (placements.length > 0) {
		if (!(await folderEditLock(placements))) {
			await releaseArtifactIfUnneeded(id);
			return;
		}
		for (const folderId of placements) {
			await stageRemoveArtifactRef(folderId, id, header.name);
		}
	}
	stageArtifactDelete(id, header);
}
```

Delete the `onArtifactCommit` scrub line (`for (const id of deletedIds) void scrubArtifactFromView(id)…`) and `scrubArtifactFromView` itself (+ barrel). The per-row artifact discard leaving scrub ops in the journal is the ACCEPTED wrinkle (Decision 7) — the rows are visible and labelled (`Removed placement of "<name>"`); add that sentence where `discardArtifact` is documented in `checkout.svelte.ts`.

- [ ] **Step 4: Folder badges in `TreeRow.svelte`** — mirror the element rows' existing badge idiom, keyed on the canonical resource:

```ts
const folderLease = $derived(
	kind === 'folder' ? getLockFor(folderResource(folderId)) : undefined
);
const folderLockedByPeer = $derived(
	folderLease !== undefined && folderLease.holder_id !== getCurrentUserId()
);
```

Render the same lock icon + `title="Locked by {folderLease.holder_email ?? folderLease.holder_id}"` the element badge uses. (Read the element badge markup in this file first and reuse its component/classes verbatim.)

- [ ] **Step 5: Run** the touched suites, then `pixi run frontend-test` + `npm run check` → green / 0 errors.
- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/state frontend/src/lib/components/Sidebar
git commit -m "feat(frontend): artifact delete scrubs view placements in-batch; peer folder lock badges"
```

---

## Task 10: Denied-tab fixes — read-only editors + "Save as copy"

**Files:**
- Modify: `frontend/src/lib/state/snippet-editor.svelte.ts` (new `forkSnippetDraftAsCopy`)
- Modify: the three editor surfaces that render the lock-denied banner — find them with `grep -rn "getNavLockHolder\|getTableLockHolder\|getSnippetLockHolder" frontend/src/lib/components` — expected: `Navigation/NavigationBuilder.svelte` (+ `chrome.ts`), `Table/TableView.svelte`, `Snippet/SnippetTab.svelte`
- Test: editor store suites (`snippet-editor.test.ts` for the fork) + component suites for the read-only gate

**Interfaces:**
- Consumes: `getNavLockHolder(tabId)` (`navigation-editor.svelte.ts:415`), `getTableLockHolder(tabId)` (`table-editor.svelte.ts:883`), `getSnippetLockHolder(tabId)` (`snippet-editor.svelte.ts:261`); `saveAsDraft(tabId, name)` (nav, `navigation-editor.svelte.ts:844`), `saveAsTableDraft(tabId, name)` (`table-editor.svelte.ts:1538`).
- Produces: `forkSnippetDraftAsCopy(tabId: string, name: string): Promise<void>`; every denied editor is inert (typing/clicking mutates nothing) and its banner gains a "Save as copy" button.

**The gap being closed** (handoff "carried forward"): `_lockDenied` currently disables only the NAME input and Save — the BODY is still typeable, so a user can edit away and only discover at commit that nothing can land. Fix = the whole editing surface becomes read-only while `get*LockHolder(tabId) !== null`; "Save as copy" is the escape hatch (a fork is a staged CREATE under a temp id — no lease needed).

- [ ] **Step 1: Write the failing tests**

```ts
// snippet-editor.test.ts
it('forkSnippetDraftAsCopy stages a create with the current code under a new tab', async () => {
	// seed a denied tab's draft; fork; expect stageArtifactCreate called with
	// ('code_snippet', name, {schema_version:1, language:'python', code}, newTabId)
	// and the original draft left untouched (still denied, still dirty).
});
// component suites (one per editor, happy-dom):
it('a lock-denied tab renders its editing surface inert', () => {
	// set*LockDenied(tabId, 'peer@x'); mount; the content container has inert.
});
it('the banner offers Save as copy and routes to the fork', () => {});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `forkSnippetDraftAsCopy`** — model it on `saveAsDraft`'s stage-first-then-move-tab ordering (`navigation-editor.svelte.ts:844`; the new tab key is `snip:<tempId>`, so it cannot exist until the temp id does — see `repointStagedArtifactSourceTab`'s docstring). Sketch (verify tab-plumbing helper names in `workspace.svelte.ts` before writing):

```ts
/** Fork a (typically lock-denied) tab's draft into a staged CREATE under a
 * fresh temp id and open it in a new tab. The source tab keeps its draft,
 * its denial state, and its artifact binding — "Save as copy" must never
 * mutate what the peer holds. No lease: a temp id names no server row. */
export async function forkSnippetDraftAsCopy(tabId: string, name: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = { schema_version: 1, language: 'python', code: draft.code };
	assertNoNameClash('code_snippet', name, null);
	const tempId = stageArtifactCreate('code_snippet', name, payload, null);
	const newTabId = `snip:${tempId}`;
	_drafts.set(newTabId, { ...draft, name, artifactId: tempId, dirty: false });
	repointStagedArtifactSourceTab(tempId, newTabId);
	openSnippetTabForTemp(newTabId); // whatever workspace helper SnippetTab's open path uses — read it
}
```

- [ ] **Step 4: Read-only gating.** In each editor surface, derive `const deniedBy = $derived(get<X>LockHolder(tabId));` and put `inert={deniedBy !== null}` on the EDITING container only (builder canvas / column manager + grid editing chrome / CodeMirror host) — previews, consoles, and scrollable result panes stay interactive. For CodeMirror (`Snippet/CodeEditor.svelte`), also pass/reconfigure its read-only flag if the component exposes one (check its props) — `inert` on the host blocks focus either way. Banner (all three): next to the existing Retry, add `Save as copy` → `window.prompt('Save copy as', currentName + ' (copy)')` → the matching fork (`saveAsDraft` / `saveAsTableDraft` / `forkSnippetDraftAsCopy`).
- [ ] **Step 5: Run** the three suites, then `pixi run frontend-test` + `npm run check` → green / 0 errors.
- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/state frontend/src/lib/components
git commit -m "fix(frontend): lock-denied editors are read-only and offer Save as copy"
```

---

## Task 11: E2E, docs, final verification

**Files:**
- Modify: `frontend/e2e/*` specs that drive view DnD / folder CRUD (run first, then fix fallout — flows that asserted immediate persistence must now open the DiffDrawer and commit)
- Modify: `frontend/README.md` (view-editing architecture section + staged-buffers/checkout bullets)
- Modify: `CLAUDE.md` (the Phase 2 view-ops bullet: note the frontend now commits view ops and no longer calls `PUT /view/snapshot` / `DELETE /view` — the migration window is over pending the backend retirement cleanup)

- [ ] **Step 1: Full unit sweep** — `pixi run frontend-test` AND `pixi run frontend-check` AND `pixi run -e frontend bash -c 'cd frontend && npm run lint'` → green.
- [ ] **Step 2: Backend sanity** — `pixi run core-test` → green (nothing backend changed; catches accidental drift). Known flake: `test_string_properties_indexed_non_strings_ignored` fails ~0.8% of runs on an id-trigram coincidence — re-run once before investigating.
- [ ] **Step 3: Playwright** — `pixi run frontend-test-e2e` (boots backend + dev server itself). Update specs: a drag now stages (assert the TopBar count / DiffDrawer row) and persists only after commit; add one e2e that drags an element into a folder, commits with a message, reloads, and sees the placement.
- [ ] **Step 4: Docs.** `frontend/README.md`: replace the view-save description (whole-doc PUT) with the journal/lease/commit flow — cover: the three staged buffers and their shapes (map vs map vs ORDERED JOURNAL + why), drop-time/dialog-open lease timing, `folder:` resources in the checkout registry, post-commit `GET /view` refetch, all-or-nothing view discard, the artifact-delete scrub, and the denied-tab read-only + Save-as-copy behavior. `CLAUDE.md`: one-sentence addition to the Phase 2 bullet as above.
- [ ] **Step 5: Commit**

```bash
git add frontend/e2e frontend/README.md CLAUDE.md
git commit -m "test(frontend)+docs: e2e on the commit flow; view-rewire architecture notes"
```

---

## Completion

Use `superpowers:finishing-a-development-branch`: full sweep (`pixi run dr-test`, `pixi run frontend-check`, e2e), then merge `feat/artefacts-phase-2-frontend` to `main` locally and delete the branch (Phase 1/2 precedent; no push unless the user says so). Surface in the summary: the backend follow-up now unblocked — retiring `PUT /view/snapshot` + `DELETE /view` server-side.



