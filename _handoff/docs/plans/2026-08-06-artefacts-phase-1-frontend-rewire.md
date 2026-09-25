# Artefacts Phase 1 — Frontend Rewire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Sample code is ILLUSTRATIVE.** Every snippet below was written against the code as of `main@5316210` and is believed accurate, but the executor must follow the *intent* over literal transcription: re-read the target region before editing, keep surrounding invariant comments, and adapt names/lines if the file has drifted. (The Phase 1 backend plan's snippets contained real defects in 6 of 9 tasks; treat these the same way.)

**Goal:** Move the frontend's artifact editing (navigations, tables, code snippets) off the legacy unlocked `POST/PUT/DELETE /artifacts` routes and onto the Phase-4 lock→edit→commit flow: an `art:<id>` lease is acquired when an artifact editor opens, "Save" stages an artifact op into the commit batch, and `POST /commits` lands model + artifact changes atomically.

**Architecture:** Mirror the backend's op-union split client-side: `ops.ts` gains the three artifact ops and splits `Op` into `ModelOp | ArtifactOp` (so the model store can never queue an artifact op, just as `routes/ops.py::_apply_one` can never receive one). A new `lib/state/artifact-edits.svelte.ts` is the staged-artifact-ops store (the artifact sibling of `model.svelte.ts`'s staged buffer): entries are keyed by artifact id and coalesce (update-over-create folds into the create — the backend 422s on `[create tmp_x, update tmp_x]`). `checkout.svelte.ts` concatenates both buffers into preview/commit, partitions lock tokens so an open editor's lease survives a commit that didn't touch it, and fans the commit's artifact delta out through a small listener registry that the header store and the three editors subscribe to (avoiding import cycles). Editors acquire the lease on open (fail-fast "Locked by …", read-only), release on close when nothing staged still needs it, and re-acquire after a commit that released theirs.

**Tech Stack:** SvelteKit + Svelte 5 runes + TypeScript + Zod + Vitest (happy-dom + MSW) + Playwright. Everything through `pixi`.

## Decisions (made while planning; do not re-litigate without the user)

1. **Save = stage, commit = DiffDrawer.** An editor's Save button stages a `create_artifact`/`update_artifact` op; sidebar rename stages a name-only update; sidebar delete stages `delete_artifact`. Nothing reaches the server until `POST /commits`. This is the spec's "artifacts adopt the full lock→edit→commit flow" (spec 2026-07-29 §Motivation decision 1) — one editing mental model, atomic cross-content commits, history for free.
2. **Legacy path: frontend fully abandons the write routes; backend keeps them.** `createArtifact`/`updateArtifact`/`deleteArtifact` wrappers are deleted from `lib/api/artifacts.ts` (grep-clean so no regression can sneak back). GET list/get stay. The backend's `POST/PUT/DELETE /artifacts` routes stay alive untouched (they honor `art:` leases since `e1f8135`, so both paths remain consistent); retiring them is a later backend cleanup, not this slice.
3. **`UpdateArtifactOp.artifact_rev` is never sent.** OCC on the op path is deferred (handoff Known Issues); the lease is the concurrency control. The per-editor `artifactRev`/`_conflicts` PUT-409 machinery is removed with the PUT path.
4. **Temp-id tabs are not re-keyed at stage time.** A staged create keeps living in its `nav:draft:N`-style tab; the stage entry records the temp id + source tab. On commit, `id_map` drives `bindTabToArtifact` + draft re-key (the same move `saveDraft`'s create branch does today, just deferred to commit).
5. **A model-only commit must not evict my open artifact editors' leases.** `commitStaged` sends only the tokens the batch needs (plus all non-artifact tokens, preserving today's "commit ends the model editing session" semantics); artifact-only tokens not needed by the batch are withheld and survive. Leases that *were* released (their artifact was in the batch) are re-acquired best-effort for still-open tabs after the commit.
6. **Never send an empty commit.** The backend's empty-batch early return (`routes/commits.py:520`) skips lock release, so an empty `POST /commits` carrying `lock_tokens` orphans leases until TTL. `commitStaged` refuses to send one; the DiffDrawer's `total === 0` gate keeps it unreachable from the UI.
7. **Proactive peer-conflict marking on open drafts is a non-goal.** With leases, a peer cannot commit over an artifact I hold; the commit-time 409 backstop covers the lease-expired window. The feed's `artifact` events keep doing a blind header refetch.
8. **HistoryDrawer stays on client-side model reconstruction.** Consuming `GET /commits/{rev}/diff` is a separate follow-up slice; artifact-only commits appear in the list with their message/op-count and an empty model diff, which is tolerable for this slice.

## Global Constraints

- **No global `python`/`node`** — always `pixi run`. Frontend commands must run *inside `frontend/`*: `pixi run -e frontend bash -c 'cd frontend && npm test'` (vitest; `npm test -- <path>` for one file), `… npm run check` (svelte-check), `… npm run lint`. A bare `pixi run -e frontend npm test` fails ("Missing script").
- **Backend untouched.** This slice is frontend-only. If a backend change seems needed, stop and surface it — that's a scope change.
- **Frontend state is re-exported through barrels** `lib/state/index.ts` / `lib/api/index.ts`; every new public store/API function MUST be added to the matching barrel.
- **Elements keep BARE lock resource ids; only artifacts get the `art:` prefix client-side.** Lock badges (`lock-badge.ts`) and the checkout registry key elements by bare id — do not touch that.
- **Backend session is the source of truth; the client never holds the whole model.** Preserve the dense invariant docstrings/comments in the files you touch — they are load-bearing; extend them in the same style.
- **Zod schema order matters** — `types.ts` schemas are `const`s; referencing a schema defined later in the file throws at module init (TDZ). Move blocks when a new reference points downward.
- **Tests colocate in `__tests__/` dirs** next to the source. MSW suites use `lib/api/__tests__/server.ts` + per-test `server.use(...)`; store suites use `vi.spyOn`/module mocks.
- **Frequent commits:** one git commit per task (final step of each task). Branch: create `feat/artefacts-phase-1-frontend` off `main` before Task 1.

## Backend wire contract (reference — verified against `main@5316210`)

- Ops (schemas.py:269-311): `create_artifact {temp_id, artifact_kind, name, payload}`; `update_artifact {id, name?, payload?, artifact_rev?}` (payload = FULL replacement; omitted = name-only); `delete_artifact {id}`. Temp-id prefix `tmp_` shared with elements.
- Locks (schemas.py:552-565): `LockTargetIn` has optional `type: "element"|"artifact"|"metamodel"` (default element). Artifact targets are sent with the BARE artifact id + `type: "artifact"`; granted `LeaseOut.resource_id` comes back canonicalized as `art:<id>`. `required_locks` (locking.py:393-397): update/delete → EXCLUSIVE `art:<id>`; create (temp id) → no lock.
- Commit (schemas.py:642-651): `CommitResponse` adds `changed_artifacts: ArtifactHeaderOut[]` (headers only) + `deleted_artifact_ids: string[]`; `id_map` includes artifact temp ids.
- 409 shapes: locks acquire → `{detail: {conflicts: [{resource_id, held_by, held_by_email, held_mode}]}}` (unchanged); commit → `{detail: "stale base_rev"|"conflicting concurrent commits", model_rev}` or `{detail: "required lock not held", missing: [...]}`; legacy PUT/DELETE peer-lease → `{detail: {message: "artifact is checked out by someone else", conflicts: [...]}}` (we stop calling these).
- Preview: artifact ops are dry-validated — HTTP **422** on invalid payload / unknown id / name clash (no lock check). `diagram`/`diagram_kind` 422 on write (unregistered kinds).
- Feed: commit events carry `scope: ("model"|"artifact")[]`; commit-path artifact changes ALSO emit the same per-row `artifact` events (`created|updated|deleted`, header-only) the legacy routes emit — existing client handling keeps working.

---

## Task 1: `ops.ts` — artifact op family, `ModelOp` split, lock-namespace helpers

**Files:**
- Modify: `frontend/src/lib/state/ops.ts` (75 lines today)
- Modify: `frontend/src/lib/state/model.svelte.ts`, `frontend/src/lib/state/diff.ts`, `frontend/src/lib/state/staged-rows.ts`, `frontend/src/lib/state/snippet-stage.ts` — retype model-only `Op` uses to `ModelOp` (mechanical; svelte-check finds every site)
- Modify: `frontend/src/lib/state/index.ts` (barrel)
- Test: `frontend/src/lib/state/__tests__/ops.test.ts` (exists, 34 lines)

**Interfaces:**
- Produces: `type ArtifactOp` (3 kinds, shapes below); `type ModelOp = ElementOp | RelationshipOp`; `type Op = ModelOp | ArtifactOp`; `ARTIFACT_RESOURCE_PREFIX = 'art:'`; `artifactResource(id: string): string`; `isArtifactResource(rid: string): boolean`. Every later task consumes these exact names.

- [ ] **Step 1: Write the failing tests** (append to `ops.test.ts`):

```ts
import { artifactResource, isArtifactResource, ARTIFACT_RESOURCE_PREFIX } from '../ops';
import type { ArtifactOp, ModelOp, Op } from '../ops';

describe('artifact lock namespace', () => {
	it('prefixes artifact ids with art:', () => {
		expect(artifactResource('abc')).toBe('art:abc');
		expect(ARTIFACT_RESOURCE_PREFIX).toBe('art:');
	});
	it('classifies resource ids', () => {
		expect(isArtifactResource('art:abc')).toBe(true);
		expect(isArtifactResource('abc')).toBe(false); // bare element id
	});
	it('artifact ops are assignable to Op but not ModelOp', () => {
		const op: ArtifactOp = { kind: 'delete_artifact', id: 'a1' };
		const asOp: Op = op; // compile-time check
		expect(asOp.kind).toBe('delete_artifact');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/ops.test.ts'`
Expected: FAIL — `artifactResource` not exported.

- [ ] **Step 3: Implement in `ops.ts`**

```ts
/**
 * Artifact-content ops (artefacts revamp Phase 1) — mirror of the backend's
 * ArtifactOpIn (api/schemas.py). Applied to ArtifactRow DB rows by
 * POST /commits, never to the in-memory model; /model/ops rejects them.
 * `update_artifact.payload` is a FULL replacement (omitted = name-only
 * change). The backend's optional `artifact_rev` OCC precondition is
 * deliberately never sent: the art: lease is the concurrency control
 * (CLAUDE.md "Lease rule"); OCC-on-ops is a deferred follow-up.
 */
export type ArtifactOp =
	| {
			kind: 'create_artifact';
			temp_id: string;
			artifact_kind: 'navigation' | 'table' | 'code_snippet';
			name: string;
			payload: Record<string, unknown>;
	  }
	| {
			kind: 'update_artifact';
			id: string;
			name?: string;
			payload?: Record<string, unknown>;
	  }
	| { kind: 'delete_artifact'; id: string };

/** Model-content ops — the ONLY ops the model store's staged buffer may
 * hold (mirrors the backend's ModelOpIn / assert_never split). */
export type ModelOp = ElementOp | RelationshipOp;

export type Op = ModelOp | ArtifactOp;
```

(Replace the existing `export type Op = ElementOp | RelationshipOp;` line.) Then the lock-namespace helpers, next to `TEMP_ID_PREFIX`:

```ts
/** Client mirror of api/locking.py's ARTIFACT_PREFIX: artifact lock targets
 * are REQUESTED with the bare id + type:"artifact", but granted leases come
 * back canonicalized under this namespace, and the checkout registry keys on
 * the canonical form. Elements stay bare (existing badges depend on it). */
export const ARTIFACT_RESOURCE_PREFIX = 'art:';

export function artifactResource(artifactId: string): string {
	return ARTIFACT_RESOURCE_PREFIX + artifactId;
}

export function isArtifactResource(resourceId: string): boolean {
	return resourceId.startsWith(ARTIFACT_RESOURCE_PREFIX);
}
```

- [ ] **Step 4: Retype model-only consumers to `ModelOp`**

Run `pixi run -e frontend bash -c 'cd frontend && npm run check'` and fix every site that genuinely holds model-only ops: `model.svelte.ts` (`emit`, `QueuedOp`, `getStagedOps` return type, revert journal), `diff.ts`, `staged-rows.ts`, `snippet-stage.ts`. `checkout.svelte.ts` keeps `Op` where it already imports it (it will carry mixed batches from Task 4). `api/checkout.ts`'s `readonly Op[]` stays `Op` (the wire accepts the full union). Do NOT change behavior — types only.

- [ ] **Step 5: Barrel + run tests**

Export the new names from `lib/state/index.ts` (follow how `TEMP_ID_PREFIX`/`createTempId` are exported today).
Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/ops.test.ts && npm run check'`
Expected: PASS, no check errors.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): artifact op family + ModelOp split + art: lock namespace in ops.ts"
```

---

## Task 2: Wire schemas — lock-target `type`, commit artifact delta, feed commit `scope`

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (`LockTargetInSchema` ~:203; `CommitResponseSchema` ~:284; `ArtifactHeaderSchema` ~:358 — must MOVE above `CommitResponseSchema`, see TDZ constraint)
- Modify: `frontend/src/lib/api/feed.ts` (commit variant of `FeedEvent`, ~:19-30)
- Test: `frontend/src/lib/api/__tests__/types.checkout.test.ts`, `frontend/src/lib/api/__tests__/feed.test.ts`

**Interfaces:**
- Produces: `LockTargetIn.type?: 'element' | 'artifact' | 'metamodel'` (optional — existing bare-element call sites compile unchanged); `CommitResponse.changed_artifacts: ArtifactHeader[]` and `.deleted_artifact_ids: string[]` (both default `[]`); feed commit events expose `scope: string[]`.

- [ ] **Step 1: Failing tests.** In `types.checkout.test.ts`:

```ts
it('parses a commit response carrying the artifact delta', () => {
	const res = CommitResponseSchema.parse({
		model_rev: 3,
		commit_id: 'c1',
		changed_artifacts: [
			{ id: 'a1', kind: 'table', name: 'T', artifact_rev: 2, updated_at: '2026-08-06T00:00:00Z', updated_by: null, entry_points: null }
		],
		deleted_artifact_ids: ['a2']
	});
	expect(res.changed_artifacts[0].artifact_rev).toBe(2);
	expect(res.deleted_artifact_ids).toEqual(['a2']);
});

it('defaults the artifact delta to empty on a model-only commit', () => {
	const res = CommitResponseSchema.parse({ model_rev: 3, commit_id: 'c1' });
	expect(res.changed_artifacts).toEqual([]);
	expect(res.deleted_artifact_ids).toEqual([]);
});

it('accepts an artifact-typed lock target', () => {
	const t = LockTargetInSchema.parse({ resource_id: 'a1', mode: 'exclusive', type: 'artifact' });
	expect(t.type).toBe('artifact');
	// absent type stays absent (backend defaults to element)
	expect(LockTargetInSchema.parse({ resource_id: 'e1', mode: 'shared' }).type).toBeUndefined();
});
```

(Adjust the minimal `CommitResponseSchema.parse` fixtures to include whatever `OpsResponseSchema` fields are non-defaulted — check the existing test in this file for the working minimal shape and reuse it.)

- [ ] **Step 2: Run to verify failure** — `npm test -- src/lib/api/__tests__/types.checkout.test.ts`, expect unknown-key/undefined failures.

- [ ] **Step 3: Implement in `types.ts`.**

```ts
export const LockTargetInSchema = z.object({
	resource_id: z.string(),
	mode: z.enum(['exclusive', 'shared']),
	// what the id names; the backend canonicalizes ("artifact" -> "art:<id>",
	// "metamodel" -> "mm"). Optional: absent means "element", so every
	// pre-existing element call site is untouched.
	type: z.enum(['element', 'artifact', 'metamodel']).optional()
});
```

Move the `ArtifactHeaderSchema` block (and nothing else) from ~:358 to just above the Spec-B section (or anywhere above `CommitResponseSchema`) — module-init TDZ otherwise. Then:

```ts
export const CommitResponseSchema = OpsResponseSchema.extend({
	commit_id: z.string(),
	message: z.string().default(''),
	validation_error_count: z.number().int().default(0),
	// artifact half of the commit delta (headers only — an open editor
	// refetches nothing: the staged payload it just committed IS the payload).
	// Defaults keep every pre-artifact fixture parsing.
	changed_artifacts: z.array(ArtifactHeaderSchema).default([]),
	deleted_artifact_ids: z.array(z.string()).default([])
});
```

- [ ] **Step 4: `feed.ts` commit variant.** Add `scope: string[]` to the commit member of the `FeedEvent` union with a comment: `/** which content families the commit touched ("model"/"artifact"); reducer treats absent as ["model"] defensively */`. Make it `scope?: string[]` (optional) — the transport does no zod validation and old fixtures/tests construct commit events without it.

- [ ] **Step 5: Feed test.** In `feed.test.ts`, extend an existing commit-event delivery test (or add one) asserting an event with `scope: ['artifact']` round-trips through `connectFeed`'s message handler to the `onEvent` callback unchanged.

- [ ] **Step 6: Run + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/api && npm run check'`
```bash
git add -A frontend/src
git commit -m "feat(frontend): wire schemas for artifact lock targets, commit artifact delta, feed scope"
```

---

## Task 3: `artifact-edits.svelte.ts` — the staged-artifact-ops store

**Files:**
- Create: `frontend/src/lib/state/artifact-edits.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (barrel)
- Test: `frontend/src/lib/state/__tests__/artifact-edits.test.ts`

**Interfaces (produced — later tasks consume these exact signatures):**
- `stageArtifactCreate(kind: 'navigation'|'table'|'code_snippet', name: string, payload: Record<string, unknown>, sourceTabId: string | null): string` → returns the temp id
- `stageArtifactUpdate(id: string, patch: { name?: string; payload?: Record<string, unknown> }): void`
- `stageArtifactDelete(id: string, header: ArtifactHeader): void`
- `revertStagedArtifact(id: string): void` (fires discard listeners)
- `clearStagedArtifacts(): void` (commit-success path: does NOT fire discard listeners)
- `discardAllStagedArtifacts(): void` (user-discard path: fires discard listeners per entry)
- `getStagedArtifactOps(): ArtifactOp[]`, `getStagedArtifactEntries(): StagedArtifactEntry[]`, `getStagedArtifactDepth(): number`, `hasStagedArtifactOp(id: string): boolean`
- `overlayArtifactHeaders(items: ArtifactHeader[]): ArtifactHeader[]`, `stagedArtifactState(id: string): 'new' | 'edited' | 'deleted' | null`, `stagedCreateSourceTab(tempId: string): string | null`
- Listener registry: `onArtifactCommit(cb: (info: ArtifactCommitInfo) => void): () => void`, `notifyArtifactCommit(info: ArtifactCommitInfo): void`, `onArtifactStageDiscarded(cb: (id: string) => void): () => void`, `onArtifactStagedDelete(cb: (id: string) => void): () => void` — with `type ArtifactCommitInfo = { idMap: Record<string, string>; changed: ArtifactHeader[]; deletedIds: string[] }`
- `resetArtifactEdits(): void` (clears staged state, NOT listeners — module-scope subscriptions are permanent)

- [ ] **Step 1: Write the failing tests.** Cover at minimum:

```ts
import {
	stageArtifactCreate, stageArtifactUpdate, stageArtifactDelete,
	revertStagedArtifact, clearStagedArtifacts, discardAllStagedArtifacts,
	getStagedArtifactOps, getStagedArtifactDepth, hasStagedArtifactOp,
	overlayArtifactHeaders, stagedArtifactState,
	onArtifactStageDiscarded, resetArtifactEdits
} from '../artifact-edits.svelte';
import { isTempId } from '../ops';
import type { ArtifactHeader } from '$lib/api/types';

const header = (id: string, name = 'N'): ArtifactHeader => ({
	id, kind: 'table', name, artifact_rev: 1,
	updated_at: '2026-08-06T00:00:00Z', updated_by: null, entry_points: null
});

beforeEach(() => resetArtifactEdits());

it('stages a create as one op with a temp id', () => {
	const tempId = stageArtifactCreate('table', 'T', { v: 1 }, 'tbl:draft:1');
	expect(isTempId(tempId)).toBe(true);
	expect(getStagedArtifactOps()).toEqual([
		{ kind: 'create_artifact', temp_id: tempId, artifact_kind: 'table', name: 'T', payload: { v: 1 } }
	]);
});

it('coalesces update-over-create into the create (backend 422s the pair)', () => {
	const tempId = stageArtifactCreate('table', 'T', { v: 1 }, null);
	stageArtifactUpdate(tempId, { name: 'T2', payload: { v: 2 } });
	expect(getStagedArtifactOps()).toEqual([
		{ kind: 'create_artifact', temp_id: tempId, artifact_kind: 'table', name: 'T2', payload: { v: 2 } }
	]);
});

it('coalesces update-over-update, keeping earlier fields the later omits', () => {
	stageArtifactUpdate('a1', { payload: { v: 2 } });
	stageArtifactUpdate('a1', { name: 'renamed' });
	expect(getStagedArtifactOps()).toEqual([
		{ kind: 'update_artifact', id: 'a1', name: 'renamed', payload: { v: 2 } }
	]);
});

it('delete-over-create drops both (never existed server-side)', () => {
	const tempId = stageArtifactCreate('table', 'T', {}, null);
	stageArtifactDelete(tempId, header(tempId));
	expect(getStagedArtifactDepth()).toBe(0);
});

it('delete-over-update collapses to delete', () => {
	stageArtifactUpdate('a1', { name: 'x' });
	stageArtifactDelete('a1', header('a1'));
	expect(getStagedArtifactOps()).toEqual([{ kind: 'delete_artifact', id: 'a1' }]);
});

it('overlay: renames applied, deletes hidden, creates appended', () => {
	const tempId = stageArtifactCreate('table', 'New', {}, null);
	stageArtifactUpdate('a1', { name: 'Renamed' });
	stageArtifactDelete('a2', header('a2'));
	const out = overlayArtifactHeaders([header('a1', 'Old'), header('a2')]);
	expect(out.map((h) => [h.id, h.name])).toEqual([['a1', 'Renamed'], [tempId, 'New']]);
	expect(stagedArtifactState('a1')).toBe('edited');
	expect(stagedArtifactState(tempId)).toBe('new');
	expect(stagedArtifactState('a2')).toBe('deleted');
});

it('revert fires the discard listener; clear (commit path) does not', () => {
	const seen: string[] = [];
	onArtifactStageDiscarded((id) => seen.push(id));
	stageArtifactUpdate('a1', { name: 'x' });
	revertStagedArtifact('a1');
	expect(seen).toEqual(['a1']);
	stageArtifactUpdate('a2', { name: 'y' });
	clearStagedArtifacts();
	expect(seen).toEqual(['a1']); // unchanged
	expect(getStagedArtifactDepth()).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure** (module not found).

- [ ] **Step 3: Implement.** Skeleton (write full JSDoc in the repo's invariant-explaining style — say WHY coalescing exists and why `clearStagedArtifacts` is silent):

```ts
import { SvelteMap } from 'svelte/reactivity';
import { createTempId } from './ops';
import type { ArtifactOp } from './ops';
import type { ArtifactHeader } from '$lib/api/types';

export type StagedArtifactEntry =
	| { kind: 'create'; tempId: string; artifactKind: 'navigation' | 'table' | 'code_snippet';
	    name: string; payload: Record<string, unknown>; sourceTabId: string | null }
	| { kind: 'update'; id: string; name?: string; payload?: Record<string, unknown>; header: ArtifactHeader | null }
	| { kind: 'delete'; id: string; header: ArtifactHeader };

/** artifact id (temp or real) -> its ONE staged entry. One entry per artifact
 * max: the backend applier resolves update/delete ids literally (not through
 * id_map), so a create followed by a separate update of the same temp id 422s
 * — coalescing here is correctness, not tidiness. */
const _staged = new SvelteMap<string, StagedArtifactEntry>();
```

`stageArtifactUpdate` looks up `header` via a lazy import-free path: accept the display header as an optional third argument? — NO: keep the signature two-arg; store `header: null` and let the DiffDrawer resolve display names via `artifactHeaderById`. Implement the coalescing rules exactly as the tests specify; `stageArtifactUpdate` on a staged-delete entry is a programming error — `console.warn` and ignore (the UI hides deleted artifacts). `getStagedArtifactOps` maps entries in insertion order; omit `name`/`payload` keys from `update_artifact` when undefined (the wire treats absent as "unchanged"/"name-only"). Listener registries are plain arrays of callbacks; `onX` returns an unsubscribe.

`overlayArtifactHeaders` builds synthetic headers for creates:

```ts
{ id: e.tempId, kind: e.artifactKind, name: e.name, artifact_rev: 0,
  updated_at: new Date().toISOString(), updated_by: null, entry_points: null }
```

(`entry_points: null` is deliberate: it is server-derived, so a staged snippet is invisible to the ref dropdowns' `entryAvailable` filter until committed — same as an unsaved draft today.)

- [ ] **Step 4: Run tests to green**, add barrel exports, run `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): staged-artifact-ops store with coalescing and commit/discard listeners"
```

---

## Task 4: Lock plumbing — artifact edit-gate helpers + checkout integration

**Files:**
- Modify: `frontend/src/lib/state/edit-gate.ts` (39 lines today)
- Modify: `frontend/src/lib/state/checkout.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/edit-gate.test.ts`, `frontend/src/lib/state/__tests__/checkout.commit.test.ts`, new `frontend/src/lib/state/__tests__/checkout.artifact.test.ts`

**Interfaces:**
- Consumes: Task 1's `artifactResource`/`isArtifactResource`/`Op`; Task 3's `getStagedArtifactOps`/`clearStagedArtifacts`/`notifyArtifactCommit`.
- Produces (edit-gate): `acquireArtifactLease(artifactId: string, intent?: 'edit' | 'delete'): Promise<CheckoutResult>` (returns the full result so editors can show the holder), `artifactDeleteLock(artifactId: string): Promise<boolean>` (notice-based, for the sidebar), `lockHolderLabel(res: Extract<CheckoutResult, {ok: false}>): string`.
- Produces (checkout): `releaseArtifactIfUnneeded(artifactId: string): Promise<void>`; `reacquireOpenArtifactLeases(onDenied: (tabId: string, holder: string) => void): Promise<void>`; `commitStaged`/`previewStaged` now cover the artifact buffer; `discardAll` keeps open-editor artifact leases.

- [ ] **Step 1: Failing tests.**

`edit-gate.test.ts` additions (follow the file's existing mocking of `ensureCheckout`):

```ts
it('acquireArtifactLease sends the bare id with type artifact', async () => {
	// assert ensureCheckout was called with
	// [{ resource_id: 'a1', mode: 'exclusive', type: 'artifact' }], 'edit'
});
it('artifactDeleteLock uses delete intent and sets the lock notice on conflict', async () => { ... });
```

`checkout.artifact.test.ts` (model the setup on `checkout.commit.test.ts` — it stubs `$lib/api/checkout` functions and seeds the registry via `_recordLeases`):

```ts
it('previewStaged and commitStaged append staged artifact ops after model ops', async () => { ... });

it('commitStaged refuses an empty batch without calling the API', async () => {
	await expect(commitStaged('msg', false)).rejects.toThrow(/nothing staged/i);
	expect(commitChangesMock).not.toHaveBeenCalled();
});

it('withholds an artifact-only token the batch does not need', async () => {
	// registry: element lease (token tE, resource 'e1') + artifact lease
	// (token tA, resource 'art:a9'); staged: one update_element for e1.
	// commitChanges must receive lockTokens [tE] only; after commit the
	// registry still holds art:a9 under tA and the heartbeat keeps running.
});

it('sends and clears an artifact token whose artifact is in the batch', async () => {
	// staged: update_artifact for a9 -> lockTokens include tA; registry
	// drops art:a9 after success.
});

it('applies the artifact delta: clears the artifact stage and notifies listeners with id_map + headers', async () => { ... });

it('releaseArtifactIfUnneeded releases only when no staged op needs the lease', async () => { ... });
```

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: edit-gate implementation.**

```ts
export function lockHolderLabel(res: Extract<CheckoutResult, { ok: false }>): string {
	const c = res.conflicts?.[0];
	if (!c) return 'someone else';
	return c.held_by_email || c.held_by;
}

/** Artifact check-out: EXCLUSIVE on the bare id under type:"artifact" (the
 * backend canonicalizes to art:<id>; the registry stores the canonical form).
 * Returns the full CheckoutResult so editor UIs can render the holder inline
 * instead of the transient global lock notice. */
export function acquireArtifactLease(
	artifactId: string,
	intent: 'edit' | 'delete' = 'edit'
): Promise<CheckoutResult> {
	return ensureCheckout(
		[{ resource_id: artifactId, mode: 'exclusive', type: 'artifact' }],
		intent
	);
}

/** Sidebar delete gate: notice-based like editLock/deleteLock. DELETE-intent
 * exclusive conflicts with ANY peer lease (including shared pins). */
export async function artifactDeleteLock(artifactId: string): Promise<boolean> {
	const res = await acquireArtifactLease(artifactId, 'delete');
	if (res.ok) { setLockNotice(null); return true; }
	setLockNotice(explain(res));
	return false;
}
```

- [ ] **Step 4: checkout implementation.** The pieces, in file order:

(a) **Canonicalize in `alreadyHeld`** — without this, re-opening an artifact editor re-acquires a second lease every time (the registry keys `art:<id>` but the target carries the bare id):

```ts
function canonicalResource(t: LockTargetIn): string {
	if (t.type === 'artifact') return artifactResource(t.resource_id);
	if (t.type === 'metamodel') return 'mm';
	return t.resource_id;
}

function alreadyHeld(t: LockTargetIn): boolean {
	const held = _registry.get(canonicalResource(t));
	...
}
```

(b) **`lockedResourcesNeededBy` over the full union** (it already takes `Op[]`):

```ts
case 'create_artifact':
	needed.add(artifactResource(op.temp_id));
	break;
case 'update_artifact':
case 'delete_artifact':
	needed.add(artifactResource(op.id));
	break;
```

(c) **`previewStaged`:**

```ts
export function previewStaged(): Promise<PreviewResponse> {
	return previewCommit(
		getModelRev(),
		[...getStagedOps(), ...getStagedArtifactOps()],
		_clientConfig
	);
}
```

(d) **`commitStaged`** — replace the body; keep the existing clear-before-applyDelta comment and extend it:

```ts
export async function commitStaged(message: string, ackErrors: boolean): Promise<CommitResponse> {
	const ops: Op[] = [...getStagedOps(), ...getStagedArtifactOps()];
	if (ops.length === 0) {
		// Never send an empty commit: the backend's empty-batch early return
		// (routes/commits.py) skips its lock-release step, so lock_tokens sent
		// with one are orphaned until TTL. The DiffDrawer's total===0 gate makes
		// this unreachable from the UI; this guard keeps it unreachable, period.
		throw new Error('nothing staged to commit');
	}
	// Token partition: an artifact-editor lease whose artifact is NOT in this
	// batch belongs to a still-open editor and must survive the commit (the
	// server releases every token it is sent). Everything else — all element
	// tokens (commit ends the model editing session, as before) and artifact
	// tokens the batch needs (the server verifies + releases them) — is sent.
	const needed = lockedResourcesNeededBy(ops);
	const sent: string[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const kept = new Set<string>();
	for (const token of getHeldTokens()) {
		const resources = [..._registry].filter(([, l]) => l.token === token).map(([rid]) => rid);
		const artifactOnly = resources.every((rid) => isArtifactResource(rid));
		const unneeded = resources.every((rid) => !needed.has(rid));
		if (artifactOnly && unneeded) kept.add(token);
		else sent.push(token);
	}
	const res = await commitChanges(
		{ baseRev: getModelRev(), ops, message, lockTokens: sent, ackErrors },
		_clientConfig
	);
	// Clear both staged buffers first so applyDelta's hasQueuedOpFor guard does
	// not skip the committed elements — the server's canonical rev is the truth.
	clearStaged();
	clearStagedArtifacts();
	applyDelta(res);
	// Artifact half of the delta: header store + editors subscribe (listener
	// registry — a direct import here would cycle through the editor modules).
	notifyArtifactCommit({
		idMap: res.id_map,
		changed: res.changed_artifacts,
		deletedIds: res.deleted_artifact_ids
	});
	for (const [rid, lease] of [..._registry]) {
		if (!kept.has(lease.token)) _registry.delete(rid);
	}
	if (_registry.size === 0) _stopHeartbeat();
	return res;
}
```

(e) **`releaseArtifactIfUnneeded`** (editor close / save-as rebind):

```ts
/** Release my art:<id> lease unless a staged op (either buffer) still needs a
 * resource its token covers — a saved-but-uncommitted edit must keep its lease
 * or the commit would 409 "required lock not held". Mirrors _discardWith's
 * release rule without reverting anything. */
export async function releaseArtifactIfUnneeded(artifactId: string): Promise<void> {
	const rid = artifactResource(artifactId);
	const token = _registry.get(rid)?.token;
	if (token === undefined) return;
	const stillNeeded = lockedResourcesNeededBy([...getStagedOps(), ...getStagedArtifactOps()]);
	const tokenResources = [..._registry].filter(([, l]) => l.token === token).map(([r]) => r);
	if (tokenResources.some((r) => stillNeeded.has(r))) return;
	_dropToken(token);
	await releaseLock(token, _clientConfig).catch(() => {});
	if (_registry.size === 0) _stopHeartbeat();
}
```

(f) **`reacquireOpenArtifactLeases`** — after a commit released the lease of an artifact whose editor tab is still open, re-check it out best-effort:

```ts
import { getDynamicTabs } from './workspace.svelte'; // workspace imports nothing from checkout — no cycle
import { isTempId } from './ops';

export async function reacquireOpenArtifactLeases(
	onDenied: (tabId: string, holder: string) => void
): Promise<void> {
	if (!canEdit()) return;
	for (const tab of getDynamicTabs()) {
		if (tab.artifactId === null || isTempId(tab.artifactId)) continue;
		if (_registry.has(artifactResource(tab.artifactId))) continue;
		const res = await ensureCheckout(
			[{ resource_id: tab.artifactId, mode: 'exclusive', type: 'artifact' }],
			'edit'
		);
		if (!res.ok && res.reason === 'conflict') onDenied(tab.id, lockHolderLabel(res));
	}
}
```

Wait — `lockHolderLabel` lives in edit-gate, which imports checkout: importing it here would cycle. Inline the label derivation (`res.conflicts?.[0]?.held_by_email || res.conflicts?.[0]?.held_by || 'someone else'`) or move `lockHolderLabel` into checkout.svelte.ts and re-export from edit-gate. Prefer the move (one definition).

(g) **`discardAll`** — also discard staged artifact ops and keep open-editor leases:

```ts
export async function discardAll(): Promise<void> {
	revertAllStaged();
	discardAllStagedArtifacts(); // fires per-entry discard listeners (drafts re-dirty)
	// Keep the lease of every artifact still open in an editor tab: "discard"
	// abandons EDITS, not check-outs the user sees as open editors. Everything
	// else is released.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const keepResources = new Set(
		getDynamicTabs()
			.filter((t) => t.artifactId !== null && !isTempId(t.artifactId))
			.map((t) => artifactResource(t.artifactId as string))
	);
	const keepTokens = new Set(
		[..._registry].filter(([rid]) => keepResources.has(rid)).map(([, l]) => l.token)
	);
	// a kept token must cover ONLY kept resources; otherwise send it
	for (const token of [...keepTokens]) {
		const resources = [..._registry].filter(([, l]) => l.token === token).map(([r]) => r);
		if (!resources.every((r) => keepResources.has(r))) keepTokens.delete(token);
	}
	const tokens = getHeldTokens().filter((t) => !keepTokens.has(t));
	for (const [rid, lease] of [..._registry]) {
		if (!keepTokens.has(lease.token)) _registry.delete(rid);
	}
	_stale.clear();
	if (_registry.size === 0) _stopHeartbeat();
	await Promise.all(tokens.map((t) => releaseLock(t, _clientConfig).catch(() => {})));
}
```

(h) `resetCheckout` — unchanged (clears everything; project close drops leases server-side by TTL).

- [ ] **Step 5: Run the checkout + edit-gate suites to green**, then the full vitest run (`npm test`) — the retype from Task 1 plus these changes must not break `checkout.ensure`/`heartbeat`/`expiry` suites. Barrel exports. `npm run check`.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): artifact leases in checkout - canonical registry keys, mixed-batch commit, token partition"
```

---

## Task 5: Sidebar library on the commit flow

**Files:**
- Modify: `frontend/src/lib/state/artifacts.svelte.ts`
- Modify: `frontend/src/lib/components/Sidebar/ArtifactsSection.svelte`
- Test: `frontend/src/lib/state/__tests__/artifacts.test.ts`, `frontend/src/lib/components/__tests__/artifacts-section.test.ts`

**Interfaces:**
- Consumes: Task 3's overlay/stage/listener functions, Task 4's `artifactDeleteLock`, edit-gate's `editLock`-style notice flow.
- Produces: `getArtifactHeaders()` now returns the STAGED overlay; `renameArtifact(id, name): Promise<void>` stages (acquiring the lease first); `removeArtifact(id): Promise<void>` stages a delete (lease first) or reverts a staged create; `stagedArtifactState` re-exported for badges. `createNavigationArtifact`/`createTableArtifact`/`createCodeSnippetArtifact` are DELETED (their only callers, the editors, switch to staging in Tasks 6-8 — coordinate: this task removes the exports, the editor tasks land first if you execute in order 6-8 then 5, OR keep the functions until Task 8 and delete here; **execute this task AFTER Tasks 6-8 to keep the tree green** — see Task ordering note below).

**Task ordering note:** Tasks 5-8 are interdependent at the edges (editors call `loadArtifacts`; the library's create helpers die when editors stop calling them). Execute in the order 6 → 7 → 8 → 5. The plan lists 5 first only because it is conceptually the library layer; the executor should reorder.

- [ ] **Step 1: Failing tests** (`lib/state/__tests__/artifacts.test.ts` — the suite spies on `$lib/api/artifacts`):

```ts
it('getArtifactHeaders applies the staged overlay', async () => {
	// load two headers, stage a rename of one + a delete of the other +
	// a create; assert the overlay result (renamed name, hidden delete,
	// appended temp header).
});

it('renameArtifact stages a name-only update after acquiring the edit lease', async () => {
	// mock acquireArtifactLease -> {ok:true}; assert stageArtifactUpdate
	// called with { name }, and api.updateArtifact NOT called.
});

it('renameArtifact refuses without staging when the lease is denied', async () => { ... });

it('removeArtifact on a staged create reverts the stage without any lock call', async () => { ... });

it('removeArtifact stages a delete under a delete-intent lease and keeps the view unscrubbed until commit', async () => { ... });

it('commit listener upserts changed headers, drops deleted ids and scrubs the view', async () => {
	// call the module's registered onArtifactCommit listener via
	// notifyArtifactCommit({idMap, changed, deletedIds}); assert _items and
	// scrubArtifactFromView(id) per deleted id.
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `artifacts.svelte.ts`.**

```ts
export function getArtifactHeaders(): ArtifactHeader[] {
	return overlayArtifactHeaders(_items);
}

/** Server-truth headers, no staged overlay — for the commit listener and
 * anything that must see committed state only. */
export function getCommittedArtifactHeaders(): ArtifactHeader[] {
	return _items;
}

export async function renameArtifact(id: string, name: string): Promise<void> {
	const header = artifactHeaderById(id); // overlay-aware lookup, see below
	if (!header) throw new Error(`Unknown artifact ${id}`);
	if (isTempId(id)) { stageArtifactUpdate(id, { name }); return; } // folds into the create
	const res = await acquireArtifactLease(id, 'edit');
	if (!res.ok) { setLockNotice(explainLockFailure(res)); return; }
	stageArtifactUpdate(id, { name });
}

export async function removeArtifact(id: string): Promise<void> {
	if (isTempId(id)) { revertStagedArtifact(id); return; }
	if (!(await artifactDeleteLock(id))) return;
	const header = artifactHeaderById(id);
	if (!header) return;
	stageArtifactDelete(id, header);
	// View scrub moves to commit time: until the delete is committed the
	// artifact still exists server-side, and a discard must restore the row
	// without having lost its placements.
}

// module scope — permanent subscription (never torn down; vitest isolates modules per file)
onArtifactCommit(({ changed, deletedIds }) => {
	_items = [
		..._items.filter((a) => !deletedIds.includes(a.id) && !changed.some((h) => h.id === a.id)),
		...changed
	];
	for (const id of deletedIds) void scrubArtifactFromView(id).catch(() => {});
});
```

`artifactHeaderById` should look up in the OVERLAY list so temp-id and renamed entries resolve (TreeRow + editors use it). Note on `explainLockFailure`: edit-gate's `explain` is not exported — export it (renamed `explainLockFailure`) from edit-gate in this task, or route the rename through a notice-based `artifactEditLock(id): Promise<boolean>` wrapper added beside `artifactDeleteLock`. Pick one and keep both rename/delete symmetric.

Keep `handleArtifactFeedEvent` exactly as-is (blind refetch; Decision 7). Keep `loadArtifacts`/`resetArtifacts`; `resetArtifacts` should also call `resetArtifactEdits()`.

- [ ] **Step 4: `ArtifactsSection.svelte`.** Rows render from the overlay automatically. Add a small staged badge: `stagedArtifactState(a.id)` → `'new'` / `'edited'` chips (reuse the Staged-elements section's badge styling in `Sidebar/StagedSection.svelte`); staged-deleted rows are hidden by the overlay so need nothing. Clicking a staged-create row must focus its originating tab: in the open handler, `if (isTempId(a.id)) { const tab = stagedCreateSourceTab(a.id); if (tab) setActiveTab(tab); return; }`. Update the component test accordingly.

- [ ] **Step 5: Run suites + `npm run check` + commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): sidebar artifact library stages renames/deletes and overlays staged state"
```

---

## Task 6: Navigation editor on the commit flow

**Files:**
- Modify: `frontend/src/lib/state/navigation-editor.svelte.ts` (`ensureDraft` :466, `saveDraft` :665, `saveAsDraft` :749, `reloadDraft` :781, `closeDraft` :882, conflict map ~:381)
- Modify: `frontend/src/lib/components/Navigation/NavigationBuilder.svelte` (save handlers :31-49, save buttons :88-103, conflict banner :111-118)
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/navigation-editor.test.ts`

**Interfaces:**
- Consumes: Task 3 (`stageArtifactCreate`/`stageArtifactUpdate`/`onArtifactCommit`/`onArtifactStageDiscarded`/`onArtifactStagedDelete`), Task 4 (`acquireArtifactLease`, `releaseArtifactIfUnneeded`, `lockHolderLabel`).
- Produces: `getNavLockHolder(tabId: string): string | null` + `retryNavLock(tabId: string): Promise<void>` (read-only banner state); `saveDraft`/`saveAsDraft` now stage instead of POST/PUT. `NavDraft` keeps its shape (`artifactId` may now hold a temp id; `artifactRev` becomes display-only and is refreshed from commit headers).

- [ ] **Step 1: Failing tests** (rework the existing save/conflict tests in `navigation-editor.test.ts`; the suite already mocks `$lib/api/artifacts`):

```ts
it('ensureDraft on a saved artifact acquires the art lease before fetching', async () => {
	// mock acquireArtifactLease -> {ok:true}; assert called with (id, 'edit')
	// and that getArtifact still runs (payload needed either way).
});

it('ensureDraft marks the tab read-only when the lease is denied', async () => {
	// acquireArtifactLease -> {ok:false, reason:'conflict', conflicts:[{held_by:'u2', held_by_email:'peer@x', held_mode:'exclusive'}]}
	// expect getNavLockHolder(tabId) === 'peer@x'; draft still loads.
});

it('saveDraft on an unsaved draft stages a create and binds the draft to the temp id', async () => {
	// after save: getStagedArtifactOps() has the create_artifact op,
	// draft.artifactId is a temp id, draft.dirty === false,
	// api.createArtifact was NOT called, tab id is unchanged (nav:draft:N).
});

it('saveDraft on a saved artifact stages a full-payload update', async () => {
	// update op carries name + payload; api.updateArtifact NOT called.
});

it('re-saving coalesces into one staged op', async () => { ... });

it('commit listener rebinds a temp draft to its canonical id and adopts the header rev', async () => {
	// stage a create via saveDraft, then notifyArtifactCommit({idMap: {tmp: 'real'},
	// changed: [header('real')], deletedIds: []});
	// expect the draft re-keyed to 'nav:real', artifactId 'real', tab rebound.
});

it('discard listener re-dirties the draft (update) or unbinds it (create)', async () => { ... });

it('closeDraft releases the lease only when nothing staged needs it', async () => {
	// spy releaseArtifactIfUnneeded; assert called with the artifact id.
});
```

Delete the PUT-409 conflict tests (rev-conflict banner, name-clash discrimination) — that machinery goes away.

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement the store.** Key edits (keep every surviving comment; the long 409-shape comment in `saveDraft` is deleted with the branch it explains):

`ensureDraft` saved branch — acquire first, fail-open into read-only:

```ts
} else {
	const id = tabId.slice('nav:'.length);
	// Check the artifact out BEFORE showing an editable surface (spec: fail
	// fast with "locked by <email>"). A denial still loads the payload — the
	// tab opens read-only with the holder banner instead of refusing.
	const res = await acquireArtifactLease(id, 'edit');
	if (!res.ok) {
		if (res.reason === 'conflict') _lockDenied.set(tabId, lockHolderLabel(res));
		// viewers get no banner: the whole workspace is already read-only for them
	} else {
		_lockDenied.delete(tabId);
	}
	const artifact = await api.getArtifact(id);
	...
```

New state + accessors:

```ts
/** tabId -> peer holder label while the art: lease is denied (read-only). */
const _lockDenied = new SvelteMap<string, string>();

export function getNavLockHolder(tabId: string): string | null {
	return _lockDenied.get(tabId) ?? null;
}

export async function retryNavLock(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft?.artifactId || isTempId(draft.artifactId)) return;
	const res = await acquireArtifactLease(draft.artifactId, 'edit');
	if (res.ok) _lockDenied.delete(tabId);
	else if (res.reason === 'conflict') _lockDenied.set(tabId, lockHolderLabel(res));
}
```

`saveDraft`:

```ts
export async function saveDraft(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	if (tabId.startsWith(EMBEDDED_PREFIX)) {
		throw new Error('embedded navigation drafts cannot be saved');
	}
	const payload = draft.definition as unknown as Record<string, unknown>;
	assertNoNameClash('navigation', draft.name, draft.artifactId); // helper below
	if (draft.artifactId === null) {
		const tempId = stageArtifactCreate('navigation', draft.name, payload, tabId);
		_drafts.set(tabId, { ...draft, artifactId: tempId, dirty: false });
	} else {
		stageArtifactUpdate(draft.artifactId, { name: draft.name, payload });
		_drafts.set(tabId, { ...draft, dirty: false });
	}
}
```

`assertNoNameClash` — a small shared helper, defined ONCE in `artifacts.svelte.ts` (it needs the overlay header list) and used by all three editors. Best-effort duplicate of the server's authoritative check (which now surfaces as a preview/commit 422); it preserves today's at-save feedback. NavigationBuilder's existing catch → `saveError` path renders it.

```ts
/** Best-effort client-side clash check (the server's check is authoritative
 * and now fires at preview/commit as a 422): same kind + same name + a
 * different id, across committed AND staged headers. */
export function assertNoNameClash(
	kind: 'navigation' | 'table' | 'code_snippet',
	name: string,
	excludeId: string | null
): void {
	const clash = getArtifactHeaders().find(
		(h) => h.kind === kind && h.name === name && h.id !== excludeId
	);
	if (clash) throw new Error(`a ${kind === 'code_snippet' ? 'code snippet' : kind} named "${name}" already exists`);
}
```

`saveAsDraft` — always a fresh create; release the original's lease if it becomes unneeded:

```ts
export async function saveAsDraft(tabId: string, name: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	if (tabId.startsWith(EMBEDDED_PREFIX)) throw new Error('embedded navigation drafts cannot be saved');
	assertNoNameClash('navigation', name, null);
	const payload = draft.definition as unknown as Record<string, unknown>;
	const prevId = draft.artifactId;
	const tempId = stageArtifactCreate('navigation', name, payload, tabId);
	_drafts.set(tabId, { ...draft, name, artifactId: tempId, artifactRev: null, dirty: false });
	retitleTab(tabId, name);
	_lockDenied.delete(tabId);
	if (prevId !== null && !isTempId(prevId)) void releaseArtifactIfUnneeded(prevId);
}
```

(The tab is NOT re-keyed at stage time — Decision 4. The old `bindTabToArtifact`/`rekeyTab` dance moves to the commit listener.)

Module-scope listeners:

```ts
onArtifactCommit(({ idMap, changed }) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (!draft.artifactId) continue;
		if (isTempId(draft.artifactId)) {
			const realId = idMap[draft.artifactId];
			if (!realId) continue;
			const header = changed.find((h) => h.id === realId);
			bindTabToArtifact(tabId, realId);
			const newTab = `nav:${realId}`;
			_drafts.delete(tabId);
			_drafts.set(newTab, { ...draft, artifactId: realId, artifactRev: header?.artifact_rev ?? null });
			rekeyTab(tabId, newTab); // per-node previews/expanded follow, as in the old first-save path
		} else {
			const header = changed.find((h) => h.id === draft.artifactId);
			if (header) _drafts.set(tabId, { ...draft, artifactRev: header.artifact_rev });
		}
	}
});

onArtifactCommit(({ deletedIds }) => {
	// a committed staged delete closes any tab still open on the artifact
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId && deletedIds.includes(draft.artifactId)) { closeDraft(tabId); closeTab(tabId); }
	}
});

onArtifactStageDiscarded((id) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId !== id) continue;
		if (isTempId(id)) _drafts.set(tabId, { ...draft, artifactId: null, artifactRev: null, dirty: true });
		else _drafts.set(tabId, { ...draft, dirty: true });
	}
});

onArtifactStagedDelete((id) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId === id) { closeDraft(tabId); closeTab(tabId); }
	}
});
```

(`closeTab` comes from `workspace.svelte.ts`. Register ONE `onArtifactCommit` listener handling both concerns rather than two — the split above is illustrative.)

`closeDraft` — append after the existing cleanup:

```ts
const draft = _drafts.get(tabId); // read BEFORE the delete
...existing cleanup...
_lockDenied.delete(tabId);
if (draft?.artifactId && !isTempId(draft.artifactId)) {
	void releaseArtifactIfUnneeded(draft.artifactId);
}
```

Delete: the `_conflicts` map + `getSaveConflict` + the whole PUT-409 catch in `saveDraft`; `reloadDraft` STAYS (it re-runs `ensureDraft`, now lease-aware — still the recovery path for a stale read-only tab). Delete the `ConflictError` import if now unused.

- [ ] **Step 4: `NavigationBuilder.svelte`.** Replace the rev-conflict banner block (:111-118) with a lock banner:

```svelte
{#if lockHolder !== null}
	<div class="nav-lock-banner ..." role="status">
		Checked out by {lockHolder} — read-only.
		<Button variant="ghost" onclick={() => void retryNavLock(tabId)}>Retry</Button>
	</div>
{/if}
```

with `const lockHolder = $derived(getNavLockHolder(tabId));`, and disable Save/Save-as (and the structural edit affordances if cheap — at minimum the save buttons) when `lockHolder !== null`. The `save()`/`saveAs()` handlers keep their try/catch → `saveError` rendering (name clash now throws client-side or at preview).

- [ ] **Step 5: Run the navigation-editor suite to green**, then full `npm test` + `npm run check`.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): navigation editor - art: lease on open, staged saves, commit rebind"
```

---

## Task 7: Table editor on the commit flow

**Files:**
- Modify: `frontend/src/lib/state/table-editor.svelte.ts` (`ensureTableDraft` :1006, `_evaluateSource` :1050, `saveTableDraft` :1370, `saveAsTableDraft` :1423, `closeTableDraft` :1459, conflict map :846)
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (save handlers :344-362, conflict banner :514-521)
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/table-editor.test.ts` (+ the staged-edits sibling suite if it asserts save behavior)

**Interfaces:**
- Consumes: same as Task 6.
- Produces: `getTableLockHolder(tabId)`, `retryTableLock(tabId)`; staged saves. **The structure mirrors Task 6 exactly — write it out fully anyway (per-file names differ: `tbl:` prefix, `getTableConflict` dies, `rekey` of table tabs uses this store's own tab-keyed maps).**

- [ ] **Step 1: Failing tests.** Same shapes as Task 6's Step 1, adjusted to table names, PLUS the evaluation-source rule:

```ts
it('_evaluateSource uses the inline definition while an op is staged (uncommitted)', async () => {
	// saved artifact draft, clean (dirty=false) but hasStagedArtifactOp(id)=true
	// -> evaluate must be called with {definition}, not {artifactId}: the server
	// head still holds the OLD payload until commit.
});
```

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement.** The edits are Task 6's, applied to this store's names — the executor should read Task 6's Step 3 snippets, then make each of these concrete changes here (re-read each target region first):

1. Add `const _lockDenied = new SvelteMap<string, string>()` + `getTableLockHolder(tabId)` + `retryTableLock(tabId)` (bodies identical to Task 6's `getNavLockHolder`/`retryNavLock`, over this store's `_drafts`).
2. `ensureTableDraft` (:1006) saved branch: `await acquireArtifactLease(id, 'edit')` BEFORE `getArtifact` (:1027); on `{ok:false, reason:'conflict'}` → `_lockDenied.set(tabId, lockHolderLabel(res))`, else clear; still load the payload either way.
3. `saveTableDraft` (:1370): `assertNoNameClash('table', draft.name, draft.artifactId)`; unsaved → `stageArtifactCreate('table', draft.name, payload, tabId)` and bind `artifactId` to the temp id, `dirty: false`, tab NOT re-keyed; saved → `stageArtifactUpdate(draft.artifactId, { name: draft.name, payload })`, `dirty: false`. No `api.createArtifact`/`api.updateArtifact` calls remain.
4. `saveAsTableDraft` (:1423): always `stageArtifactCreate` with a fresh temp id; `retitleTab`; release the previous artifact's lease via `releaseArtifactIfUnneeded` when it was a real id (Task 6's `saveAsDraft` shape).
5. Module-scope `onArtifactCommit` listener: temp drafts re-key to `tbl:<realId>` via `bindTabToArtifact` + this store's own tab-rekey path (the one `saveTableDraft`'s create branch uses today around :1377-1393 — it must carry EVERY tab-keyed map: page state, poll timers, suspension state, sort, script-error recap); non-temp drafts adopt `header.artifact_rev`. `deletedIds` → `closeTableDraft(tabId)` + `closeTab(tabId)`.
6. Module-scope `onArtifactStageDiscarded` listener: temp id → `{ artifactId: null, artifactRev: null, dirty: true }`; real id → `{ dirty: true }`. `onArtifactStagedDelete` → close the tab.
7. `closeTableDraft` (:1459): after existing cleanup, `_lockDenied.delete(tabId)` and `releaseArtifactIfUnneeded` for a real artifactId.
8. Delete `_conflicts` / `getTableConflict` (:846) and the PUT-409 catch (:1395-1414); delete now-unused imports.
9. Change `_evaluateSource` (:1050):

```ts
// Evaluate by artifactId ONLY when the draft matches the server head: a
// dirty draft AND a staged-but-uncommitted save both mean the server would
// evaluate a payload the user is no longer looking at.
if (
	draft.artifactId !== null &&
	!isTempId(draft.artifactId) &&
	!draft.dirty &&
	!hasStagedArtifactOp(draft.artifactId)
) {
	return { artifactId: draft.artifactId };
}
return { definition: draft.definition };
```

- [ ] **Step 4: `TableView.svelte`** — replace the conflict banner with the lock banner + Retry (same pattern as Task 6 Step 4), disable Save/Save-as under `lockHolder !== null`.

- [ ] **Step 5: Run table suites + full `npm test` + `npm run check`.**

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): table editor - art: lease on open, staged saves, staged-aware evaluation source"
```

---

## Task 8: Snippet editor on the commit flow

**Files:**
- Modify: `frontend/src/lib/state/snippet-editor.svelte.ts` (`ensureSnippetDraft` :239, `saveSnippetDraft` :330, `rekeySnippetTab` :289, `closeSnippetDraft` :391, conflict map :17/:220)
- Modify: `frontend/src/lib/components/Snippet/SnippetTab.svelte` (save :71-78, conflict banner :234-247)
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/snippet-editor.test.ts`

**Interfaces:**
- Consumes: same as Task 6; snippet payload shape `{ schema_version: 1, language: 'python', code }` (the `CodeSnippetPayload` shape currently built by `createCodeSnippetArtifact` — check `snippet-editor.svelte.ts:330-360` for the exact literal used today and reuse it).
- Produces: `getSnippetLockHolder(tabId)`, `retrySnippetLock(tabId)`; staged saves. `entryPoints` on the draft: a staged (uncommitted) snippet has NO server-derived entry points — after commit, the listener adopts `header.entry_points ?? []`.

- [ ] **Step 1: Failing tests** — same shapes as Task 6, snippet names (`snip:` prefix), plus:

```ts
it('adopts server-derived entry_points from the commit header', async () => {
	// stage a create; notifyArtifactCommit with a header carrying
	// entry_points: ['script','value']; expect draft.entryPoints updated.
});
```

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement.** Task 6's edits applied to this store (read Task 6 Step 3 first; re-read each region here before editing):

1. `_lockDenied` map + `getSnippetLockHolder(tabId)` + `retrySnippetLock(tabId)`.
2. `ensureSnippetDraft` (:239) saved branch: `acquireArtifactLease` before `getArtifact` (:253); conflict → `_lockDenied`, payload loads regardless.
3. `saveSnippetDraft` (:330): `assertNoNameClash('code_snippet', ...)`; builds `payload = { schema_version: 1, language: 'python', code: draft.code }` (verify the literal against the current create call at ~:335 before writing) and stages `create` (unsaved: `stageArtifactCreate('code_snippet', draft.name, payload, tabId)`, `artifactId` = temp id, no tab re-key) or `update` (`stageArtifactUpdate(id, { name, payload })`); `dirty: false`; no REST calls.
4. Module-scope `onArtifactCommit` listener: temp drafts re-key via the existing `rekeySnippetTab(oldTab, newTab)` helper (:289) + `bindTabToArtifact`, adopting `artifactRev` AND `entryPoints: header?.entry_points ?? draft.entryPoints` from the commit header; non-temp drafts adopt both fields when their header is in `changed`. `deletedIds` → close draft + tab.
5. `onArtifactStageDiscarded` / `onArtifactStagedDelete` listeners as in Task 6.
6. `closeSnippetDraft` (:391): `_lockDenied.delete(tabId)` + `releaseArtifactIfUnneeded` for a real artifactId.
7. Delete the `_conflicts` map (:17), `getSnippetSaveConflict` (:220), the PUT-409 catch (:365-381), and SnippetTab's `dismissedConflictRev` machinery (:69-70).

The snippet-tab console run path posts `{ code }` and is untouched by staging.

- [ ] **Step 4: `SnippetTab.svelte`** — lock banner + Retry; Save disabled under lock or `!canEdit()`.

- [ ] **Step 5: Run snippet suites + full `npm test` + `npm run check`.**

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): snippet editor - art: lease on open, staged saves, entry points from commit"
```

*(Now execute Task 5 — sidebar library — before proceeding to Task 9.)*

---

## Task 9: DiffDrawer — artifacts in the commit review

**Files:**
- Modify: `frontend/src/lib/components/DiffDrawer.svelte` (`total` :85, sections :240+, commit click :198-210, footer :385-408)
- Test: `frontend/src/lib/components/__tests__/DiffDrawer.artifacts.test.ts` (new; model it on `DiffDrawer.strict.test.ts`, which mocks `$lib/state` wholesale)

**Interfaces:**
- Consumes: Task 3's `getStagedArtifactEntries`/`revertStagedArtifact`; Task 4's `reacquireOpenArtifactLeases`; `artifactHeaderById` for display names of update entries staged without headers.
- Produces: `total` includes artifact changes (keeps the empty-commit guard unreachable from the UI); commit 409s render actionable messages.

- [ ] **Step 1: Failing tests:**

```ts
it('counts staged artifact changes into the commit total', async () => {
	// mock getStagedDiff -> empty; getStagedArtifactEntries -> [one update]
	// expect the Commit button enabled with label "Commit (1)".
});

it('renders artifact rows with kind + name and a per-row discard', async () => { ... });

it('maps the required-lock-not-held 409 to an actionable message', async () => {
	// commitStaged rejects with ConflictError whose body.detail === 'required lock not held'
	// expect the rendered commitError to mention a lost lock, not the raw detail.
});

it('reacquires open artifact leases after a successful commit', async () => {
	// commitStaged resolves; expect reacquireOpenArtifactLeases called once.
});
```

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement.** In the script block:

```ts
const artifactEntries = $derived(getStagedArtifactEntries());
const artifactCount = $derived(artifactEntries.length);
const total = $derived(
	diff.counts.added + diff.counts.modified + diff.counts.deleted + artifactCount
);
```

Render an "Artifacts" group inside the Model tab content (after the element/relationship sections), one row per entry — label `create` rows `${e.name} · new ${e.artifactKind}`, `update` rows `${artifactHeaderById(e.id)?.name ?? e.id} · edited`, `delete` rows `${e.header.name} · deleted` — each with a discard button calling `revertStagedArtifact(id)` (the store listeners re-dirty/unbind the editors). Retitle the tab trigger `Model ({total})` → `Changes ({total})` if trivial; otherwise leave it.

`onCommitClick` — after `await commitStaged(...)` succeeds:

```ts
await commitStaged(message, errorCount > 0);
message = '';
open = false;
// My leases for artifacts in the batch were verified+released server-side;
// tabs still open on them re-check-out (best effort — a denial flips that
// tab read-only via its editor's lock-holder state).
void reacquireOpenArtifactLeases((tabId, holder) => markEditorLockDenied(tabId, holder));
```

`markEditorLockDenied` — a tiny dispatcher: the tab prefix (`nav:`/`tbl:`/`snip:`) picks which editor's denied-map setter to call. The three editors each export a setter (e.g. `setNavLockDenied(tabId, holder)` — add these small exports in this task if Tasks 6-8 didn't already expose them; keep them out of components' way in the barrel). Alternatively place the dispatcher in `lib/state/artifact-lock-denied.ts` — executor's choice, one definition.

Commit-error mapping in the catch:

```ts
} catch (err) {
	commitError = friendlyCommitError(err);
}
```

with a small helper (in the component or `lib/state/checkout.svelte.ts` — one place):

```ts
function friendlyCommitError(err: unknown): string {
	if (err instanceof ConflictError) {
		const detail = (err.body as { detail?: unknown } | undefined)?.detail;
		if (detail === 'required lock not held')
			return 'A required lock expired or was released. Close and re-open the affected editor, then commit again.';
		if (detail === 'conflicting concurrent commits')
			return 'Someone else committed overlapping changes. Review the updated state and commit again.';
		if (detail === 'stale base_rev')
			return 'The project moved ahead of this session. Reload and try again.';
	}
	return err instanceof Error ? err.message : String(err);
}
```

(Verify `ConflictError`'s `body` shape against `lib/api/errors.ts` before writing.) A preview 422 (artifact name clash / invalid payload) already lands in `previewError` — confirm the raw server detail reads acceptably and leave as-is.

Also update the Discard-all button's `disabled` to use the artifact-inclusive `total` (it already will, via the shared derived).

- [ ] **Step 4: Run the DiffDrawer suites + full `npm test` + `npm run check`.**

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): DiffDrawer reviews staged artifact ops and maps commit 409s"
```

---

## Task 10: Realtime `scope` gating + staged counters

**Files:**
- Modify: `frontend/src/lib/state/realtime.svelte.ts` (`onCommitEvent` :51, commit case :115-130)
- Modify: `frontend/src/lib/state/table-editor.svelte.ts` (:1555 — the `onCommitEvent` subscription)
- Modify: `frontend/src/lib/components/HistoryDrawer.svelte` (:135 — signature only)
- Modify: `frontend/src/lib/state/unsaved.ts`, `frontend/src/lib/components/StatusBar.svelte`, `frontend/src/lib/components/TopBar.svelte` (staged counters), `frontend/src/lib/components/HistoryDrawer.svelte` (revert gate)
- Test: `frontend/src/lib/state/__tests__/realtime.test.ts`, `frontend/src/lib/state/__tests__/unsaved.test.ts`

**Interfaces:**
- Produces: `onCommitEvent(cb: (info: { scope: string[] }) => void)` — both existing subscribers updated; `hasUnsavedWork()` and the TopBar/StatusBar staged counts include `getStagedArtifactDepth()`.

- [ ] **Step 1: Failing tests:**

```ts
it('an artifact-only commit event adopts the rev but does not fire model-scoped work', () => {
	// handleFeedEvent({type:'commit', rev: 5, scope: ['artifact'], changed_elements: [], ...})
	// -> applyDelta called (rev adoption: previews/commits use strict base_rev
	//    equality, so peers MUST track artifact-only revs), and the commit tap
	//    receives {scope: ['artifact']}.
});
it('a commit event without scope is treated as model-scoped', () => { ... });
```

`unsaved.test.ts`: `hasUnsavedWork()` true when only an artifact op is staged.

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement.**

realtime commit case: keep the delta synthesis + `applyDelta` UNCONDITIONAL (rev adoption is mandatory — `previewStaged` and `commitStaged` send `base_rev` and the backend previews use strict equality); pass scope to taps:

```ts
case 'commit': {
	const scope = e.scope ?? ['model'];
	const delta: OpsResponse = { ...as today... };
	applyDelta(delta);
	for (const tap of _commitTaps) tap({ scope });
	break;
}
```

Rebind case passes `{ scope: ['model'] }`. Subscribers: `table-editor.svelte.ts:1555` becomes

```ts
onCommitEvent(({ scope }) => {
	// artifact-only commits change no model content and never invalidate the
	// server's evaluation caches (spec 2026-07-29 §Feed and caches) — skip the
	// visible-range refresh instead of re-paging every open table.
	if (scope.includes('model')) handleTableModelRevChanged();
});
```

HistoryDrawer's subscription takes (and ignores) the arg — it reloads on every commit including artifact ones (they appear in history).

Counters: in `unsaved.ts` add `getStagedArtifactDepth() > 0` to `hasUnsavedWork()`. Find the TopBar commit badge + StatusBar staged counter (grep `getStagedDepth(` in `lib/components`) and render `getStagedDepth() + getStagedArtifactDepth()`. HistoryDrawer's revert gate (`getStagedDepth() === 0 && getLockState().size === 0` per README) additionally requires `getStagedArtifactDepth() === 0` — grep the actual expression in `HistoryDrawer.svelte` and extend it.

- [ ] **Step 4: Run realtime/unsaved/table suites + full `npm test` + `npm run check`.**

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): commit-event scope gating and artifact-aware staged counters"
```

---

## Task 11: Retire the legacy write wrappers + docs

**Files:**
- Modify: `frontend/src/lib/api/artifacts.ts` (delete `createArtifact` :24, `updateArtifact` :31, `deleteArtifact` :39; keep `listArtifacts`/`getArtifact`/`evaluateNavigation`)
- Modify: `frontend/src/lib/api/index.ts`, `frontend/src/lib/state/index.ts` (barrel entries for deleted functions)
- Modify: `frontend/src/lib/api/__tests__/artifacts.test.ts` (drop create/update/409 cases)
- Modify: `frontend/README.md`
- Test: full suite green is the gate

- [ ] **Step 1: Delete the three write wrappers** and every remaining import. Then prove grep-clean:

Run: `cd frontend/src && grep -rn "updateArtifact\|createArtifact\|deleteArtifact" lib --include='*.ts' --include='*.svelte' | grep -v __tests__ | grep -v artifact-edits`
Expected: no hits outside comments (the staging store's own names like `stageArtifactCreate` don't match these exact identifiers — adjust the grep if needed and record the final command's clean output).

Also verify no non-test caller of `PUT|POST|DELETE /artifacts` remains: `grep -rn "'/artifacts" lib/api` → only the two GETs + evaluate.

- [ ] **Step 2: README.** Update `frontend/README.md`: the "State model (staged-commit flow)" section gains the artifact half (Save = stage; `artifact-edits.svelte.ts`; editor lease lifecycle acquire-on-open / release-on-close / reacquire-after-commit; DiffDrawer artifacts section; commit `scope` gating; the sidebar overlay). Rewrite the artifact-library paragraph that documents `renameArtifact`'s PUT anti-race comment. Keep the section's voice and density.

- [ ] **Step 3: Full verification sweep.**

Run, each expected clean:
- `pixi run -e frontend bash -c 'cd frontend && npm test'`
- `pixi run -e frontend bash -c 'cd frontend && npm run check'`
- `pixi run -e frontend bash -c 'cd frontend && npm run lint'`
- `pixi run core-test` (must still pass untouched — proves no accidental backend edits)

- [ ] **Step 4: Commit**

```bash
git add -A frontend
git commit -m "chore(frontend): retire legacy artifact write wrappers; document the artifact commit flow"
```

---

## Task 12: E2E — lock→edit→commit artifact scenario + suite repair

**Files:**
- Create: `frontend/e2e/artifact-commit.spec.ts`
- Modify: whichever existing specs exercise artifact Save (`snippet-flow.spec.ts` stages+commits a snippet run and saves snippets; the table/navigation specs in `script-embedding.spec.ts` bind saved snippets; grep `Save` across `frontend/e2e/*.spec.ts` first and list the hits before editing)
- Test: the Playwright run itself

- [ ] **Step 1: Repair existing specs.** Any spec that clicked Save and expected the artifact to be immediately persisted/usable (e.g. saves a snippet then binds it as a table script column ref) must now ALSO commit: open the Commit review (`Cmd/Ctrl+S` or the TopBar button), click Commit, await the dialog close. Do this mechanically per failing spec — run the suite first to find them:

Run: `rm -f /tmp/data-rover-e2e.db && pixi run -e frontend bash -c 'cd frontend && npx playwright install chromium && npm run test:e2e'`

(The WASM-gated specs self-skip without the guest binary; fetch it with `bash spikes/code_exec/fetch_python_wasi.sh` if snippet specs must run.)

- [ ] **Step 2: New spec** (`artifact-commit.spec.ts`, reuse `e2e/helpers/auth.ts` — sign in, open the default project):

```ts
test('artifact lock→edit→commit round-trip', async ({ page }) => {
	// 1. create a new table draft (sidebar + button), name it, Save
	//    -> sidebar shows the staged "new" badge; TopBar badge counts 1
	// 2. open the Commit review -> Artifacts row present, Commit (1) enabled
	// 3. Commit -> drawer closes; sidebar row loses the badge (now committed);
	//    History drawer lists the commit with its message
	// 4. rename the artifact from the sidebar (prompt) -> staged again;
	//    commit again; reload the page -> renamed name persists
});
```

Assert through user-visible surfaces only (badges, drawer rows, history list), matching the house e2e style — read a neighboring spec before writing selectors.

- [ ] **Step 3: Run the full e2e suite to green.**

- [ ] **Step 4: Commit**

```bash
git add -A frontend/e2e
git commit -m "test(e2e): artifact lock-edit-commit scenario; repair specs for staged artifact saves"
```

---

## Self-Review

Checked the plan against the spec (Phase 1 bullet: "typed lock resources + `art:` leases, commit-event `scope`, the generalized conflict backstop, frontend artifact-editor lease acquisition") and the handoff scope list:

1. **Spec coverage** — lease acquisition: Tasks 4/6/7/8; `ops.ts` mirror: Task 1; commit-flow saves replacing PUT: Tasks 3/5/6/7/8/11; `changed_artifacts`/`deleted_artifact_ids`: Tasks 2/4/5/6; feed `scope`: Tasks 2/10; new 409s: Tasks 4 (lock conflicts), 9 (commit 409 mapping); legacy-path decision: stated (Decisions 2) and executed (Task 11). Editor lifecycle heartbeats ride the existing checkout heartbeat (leases live in the same registry) — no separate work needed. Frontend vitest items from the spec's Testing section (editor lease lifecycle, feed scope handling) map to Tasks 4/6/10; the e2e lock→edit→commit artifact scenario is Task 12.
2. **Known-issue guards** — empty-commit lease orphan: Decision 6 + Task 4 guard + Task 9 total; `[create, update]` same-temp-id 422: Task 3 coalescing; no `artifact_rev` on ops: Decision 3.
3. **Type consistency** — `ArtifactOp`/`ModelOp`/`artifactResource` (Task 1) are consumed by those names in Tasks 3/4; `StagedArtifactEntry`/`stageArtifact*`/`onArtifactCommit`/`ArtifactCommitInfo` (Task 3) match their uses in Tasks 4-9; `acquireArtifactLease`/`releaseArtifactIfUnneeded`/`reacquireOpenArtifactLeases`/`lockHolderLabel` (Task 4) match Tasks 5-9. `lockHolderLabel` placement resolved: defined in checkout, re-exported via edit-gate.
4. **Known judgment calls left to the executor, flagged in place** — where `assertNoNameClash` and `markEditorLockDenied` live (one definition each); whether the DiffDrawer tab is relabeled; exact snippet payload literal.
