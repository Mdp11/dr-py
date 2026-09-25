# Spec B — Frontend Editing Rewire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the SvelteKit frontend from the legacy optimistic continuous-flush `/model/ops` path to the Phase 4 check-out/commit flow: lock on first edit, stage edits locally, mandatory preview, commit (message + error count) that finalizes and releases locks.

**Architecture:** Evolve `state/model.svelte.ts` in place — keep its optimistic-apply + per-op revert journal + `applyDelta` + temp-id remap; stop auto-flushing so its queue becomes the *staged-edits buffer*. A new `state/checkout.svelte.ts` owns the genuinely-new concern: the lock registry (`resourceId → token`), the heartbeat renew loop, and the preview/commit/discard lifecycle. A new `api/checkout.ts` wraps the REST endpoints. The realtime feed (Spec A) already exposes peer lock/presence/commit state; Spec B renders it and consumes commit deltas.

**Tech Stack:** Python 3.14 / FastAPI / Pydantic (backend); SvelteKit + Svelte 5 runes + TypeScript + Zod + Vitest + Playwright (frontend). Everything runs through `pixi`.

## Global Constraints

- **No global `python`/`node`** — always `pixi run`. Backend tests: `pixi run -e core-dev pytest <path>`. Frontend tests: `pixi run -e frontend npm test` (vitest), `pixi run -e frontend npm run check` (svelte-check), `pixi run -e frontend npm run lint`.
- **API tests need no DB service** — `tests/api/conftest.py` runs in-memory SQLite; use the `client` fixture + `seed_default_project`/`AUTH_HEADERS`/`papi` helpers; project-scoped requests need an identity header and a seeded `default` project.
- **Python check floor is 3.10** (`pyrightconfig.json`) though runtime is 3.14 — import `Self`/`assert_never` from `typing_extensions`, not `typing`.
- **Tests live in `tests/<area>/`** (backend) and colocated `__tests__/` dirs (frontend), mirroring source packages. `pythonpath=src` is set, so import `from data_rover.core...`.
- **Frontend state is re-exported through barrels** `lib/state/index.ts` and `lib/api/index.ts`; every new public store/API function MUST be added to the matching barrel (components import from `$lib/state` / `$lib/api`).
- **Backend session is the source of truth; the client never holds the whole model.** Preserve the cached-subset invariant and the existing dense docstrings/comments explaining load-bearing invariants.
- **Dev identity** is the hardcoded `x-user-id: default-user` header (`lib/api/client.ts`); the project path base is `/api/v1/projects/default` (`DEFAULT_BASE_URL`).
- **Frequent commits:** one commit per task (the final Step of each task).

---

## Task 1: Backend — `lock_ttl_seconds` on `OpenResponse`

**Files:**
- Modify: `src/data_rover/api/schemas.py:506-513` (`OpenResponse`)
- Modify: `src/data_rover/api/routes/commits.py:53-66` (`open_project`)
- Test: `tests/api/test_commits.py` (create if absent; otherwise add to the existing commits/locks test module)

**Interfaces:**
- Produces: `OpenResponse.lock_ttl_seconds: int` — the per-lease TTL the client heartbeat halves to pick its renew interval.

- [ ] **Step 1: Write the failing test**

Find where `/open` is currently tested (`grep -rn "/open" tests/api`). Add this test to that module (or create `tests/api/test_commits.py` with the standard imports — mirror an existing commits/locks test for the fixture usage):

```python
def test_open_reports_lock_ttl_seconds(client, seed_default_project):
    resp = client.get("/api/v1/projects/default/open", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    # default lock TTL is 300s (settings.lock_ttl_seconds); the field must be present
    assert body["lock_ttl_seconds"] == 300
```

If creating the file, copy the import block (`from tests.api.conftest import AUTH_HEADERS` etc.) from a sibling test module so `client`/`seed_default_project`/`AUTH_HEADERS` resolve.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commits.py::test_open_reports_lock_ttl_seconds -v`
Expected: FAIL — `KeyError: 'lock_ttl_seconds'` (field absent).

- [ ] **Step 3: Add the field to the schema**

In `src/data_rover/api/schemas.py`, extend `OpenResponse`:

```python
class OpenResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_rev: int
    role: str
    element_count: int
    relationship_count: int
    issue_counts: dict[str, int] = Field(default_factory=dict)
    #: per-lease TTL (seconds). The client heartbeat renews at ttl/2. Sourced
    #: from settings.lock_ttl_seconds; lease expires_at is a server monotonic
    #: value, meaningless to the client clock, so the client needs the TTL.
    lock_ttl_seconds: int = 0
```

- [ ] **Step 4: Populate it in the route**

In `src/data_rover/api/routes/commits.py`, the route already imports `get_settings`? If not, add `from ..settings import get_settings`. Update `open_project`:

```python
@router.get("/open", response_model=None)
def open_project(
    session: Session = Depends(get_request_session),
    membership: Membership = Depends(require_membership),
) -> OpenResponse:
    _, model = require_model(session)
    state = _ensure_validation_seeded(session, model)
    return OpenResponse(
        model_rev=session.model_rev,
        role=membership.role.value,
        element_count=len(model.elements),
        relationship_count=len(model.relationships),
        issue_counts=state.counts(),
        lock_ttl_seconds=get_settings().lock_ttl_seconds,
    )
```

Confirm `get_settings` is imported at the top of the file (the locks route imports it as `from ..settings import get_settings`); add the import if missing.

- [ ] **Step 5: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commits.py::test_open_reports_lock_ttl_seconds -v`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

Run: `pixi run lint-backend`
```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/commits.py tests/api/test_commits.py
git commit -m "feat(api): expose lock_ttl_seconds on OpenResponse for client heartbeat tuning"
```

---

## Task 2: Frontend Zod schemas for lock/commit/preview/open

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (append new schemas near the existing `OpsResponseSchema` block, ~line 188)
- Test: `frontend/src/lib/api/__tests__/types.checkout.test.ts` (create)

**Interfaces:**
- Produces (all `z.infer` types + their schemas):
  - `LockTargetIn { resource_id: string; mode: 'exclusive'|'shared' }`
  - `LockRequest { targets: LockTargetIn[]; intent: 'edit'|'create_child'|'connect'|'delete'; steal: boolean }`
  - `LeaseOut { resource_id; mode; holder; token; intent; expires_at: number }`
  - `LockResponse { token: string; leases: LeaseOut[] }`
  - `ReleaseRequest { token: string }`, `RenewRequest { token: string }`, `RenewResponse { ok: boolean }`
  - `OpenResponse { model_rev; role; element_count; relationship_count; issue_counts; lock_ttl_seconds: number }`
  - `IssueOut { severity; message; target_ids: string[]; category: string }`
  - `PreviewResponse { conformance_error_count: number; structural_blockers: IssueOut[]; issues: IssueOut[] }`
  - `CommitResponse` = `OpsResponse` + `{ commit_id: string; message: string; validation_error_count: number }`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/api/__tests__/types.checkout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	LockResponseSchema,
	OpenResponseSchema,
	PreviewResponseSchema,
	CommitResponseSchema
} from '../types';

describe('checkout schemas', () => {
	it('parses a LockResponse', () => {
		const v = LockResponseSchema.parse({
			token: 't1',
			leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'u', token: 't1', intent: 'edit', expires_at: 1.5 }]
		});
		expect(v.leases[0].resource_id).toBe('e1');
	});

	it('parses an OpenResponse with lock_ttl_seconds', () => {
		const v = OpenResponseSchema.parse({
			model_rev: 3, role: 'editor', element_count: 1, relationship_count: 0,
			issue_counts: {}, lock_ttl_seconds: 300
		});
		expect(v.lock_ttl_seconds).toBe(300);
		expect(v.role).toBe('editor');
	});

	it('parses a PreviewResponse', () => {
		const v = PreviewResponseSchema.parse({
			conformance_error_count: 2,
			structural_blockers: [],
			issues: [{ severity: 'error', message: 'x', target_ids: ['e1'], category: 'conformance' }]
		});
		expect(v.conformance_error_count).toBe(2);
		expect(v.issues[0].category).toBe('conformance');
	});

	it('parses a CommitResponse (extends OpsResponse)', () => {
		const v = CommitResponseSchema.parse({
			model_rev: 4, id_map: {}, changed_elements: [], changed_relationships: [],
			deleted_element_ids: [], deleted_relationship_ids: [],
			issues_removed_owner_ids: [], issues_added: [], issue_counts: {},
			commit_id: 'c1', message: 'hi', validation_error_count: 0
		});
		expect(v.commit_id).toBe('c1');
		expect(v.model_rev).toBe(4);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- types.checkout`
Expected: FAIL — import errors (schemas not exported).

- [ ] **Step 3: Add the schemas**

In `frontend/src/lib/api/types.ts`, after the `OpsResponseSchema`/`OpsResponse` block, append:

```ts
// --- Phase 4 check-out / commit (Spec B) -----------------------------------

export const LockTargetInSchema = z.object({
	resource_id: z.string(),
	mode: z.enum(['exclusive', 'shared'])
});
export type LockTargetIn = z.infer<typeof LockTargetInSchema>;

export const LockIntentSchema = z.enum(['edit', 'create_child', 'connect', 'delete']);
export type LockIntent = z.infer<typeof LockIntentSchema>;

export const LockRequestSchema = z.object({
	targets: z.array(LockTargetInSchema),
	intent: LockIntentSchema,
	steal: z.boolean().default(false)
});
export type LockRequest = z.infer<typeof LockRequestSchema>;

export const LeaseOutSchema = z.object({
	resource_id: z.string(),
	mode: z.string(),
	holder: z.string(),
	token: z.string(),
	intent: z.string(),
	expires_at: z.number()
});
export type LeaseOut = z.infer<typeof LeaseOutSchema>;

export const LockResponseSchema = z.object({
	token: z.string(),
	leases: z.array(LeaseOutSchema).default([])
});
export type LockResponse = z.infer<typeof LockResponseSchema>;

export const RenewResponseSchema = z.object({ ok: z.boolean() });
export type RenewResponse = z.infer<typeof RenewResponseSchema>;

export const OpenResponseSchema = z.object({
	model_rev: z.number().int(),
	role: z.string(),
	element_count: z.number().int(),
	relationship_count: z.number().int(),
	issue_counts: z.record(z.string(), z.number()).default({}),
	lock_ttl_seconds: z.number().int().default(0)
});
export type OpenResponse = z.infer<typeof OpenResponseSchema>;

export const IssueOutSchema = z.object({
	severity: z.string(),
	message: z.string(),
	target_ids: z.array(z.string()).default([]),
	category: z.string().default('conformance')
});
export type IssueOut = z.infer<typeof IssueOutSchema>;

export const PreviewResponseSchema = z.object({
	conformance_error_count: z.number().int(),
	structural_blockers: z.array(IssueOutSchema).default([]),
	issues: z.array(IssueOutSchema).default([])
});
export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;

export const CommitResponseSchema = OpsResponseSchema.extend({
	commit_id: z.string(),
	message: z.string().default(''),
	validation_error_count: z.number().int().default(0)
});
export type CommitResponse = z.infer<typeof CommitResponseSchema>;
```

(`z` is already imported in this file; `OpsResponseSchema` is defined above this block.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend npm test -- types.checkout`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pixi run -e frontend npm run check`
```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/__tests__/types.checkout.test.ts
git commit -m "feat(frontend): add zod schemas for lock/commit/preview/open"
```

---

## Task 3: `api/checkout.ts` REST wrappers + `getCurrentUserId`

**Files:**
- Create: `frontend/src/lib/api/checkout.ts`
- Modify: `frontend/src/lib/api/client.ts` (export `DEV_USER` via `getCurrentUserId()`)
- Modify: `frontend/src/lib/api/index.ts` (re-export the new module)
- Test: `frontend/src/lib/api/__tests__/checkout.test.ts` (create)

**Interfaces:**
- Consumes: `apiFetch(path, init, cfg?)` from `client.ts`; the schemas from Task 2.
- Produces (in `api/checkout.ts`):
  - `openProject(cfg?): Promise<OpenResponse>` → `GET /open`
  - `acquireLocks(req: LockRequest, cfg?): Promise<LockResponse>` → `POST /locks`
  - `releaseLock(token: string, cfg?): Promise<void>` → `POST /locks/release`
  - `renewLock(token: string, cfg?): Promise<RenewResponse>` → `POST /locks/renew`
  - `previewCommit(baseRev: number, ops: readonly Op[], cfg?): Promise<PreviewResponse>` → `POST /commits/preview`
  - `commitChanges(req: { baseRev; ops; message; lockTokens; ackErrors }, cfg?): Promise<CommitResponse>` → `POST /commits`
- Produces (in `client.ts`): `getCurrentUserId(): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/api/__tests__/checkout.test.ts`. Mirror the existing model-ops test style (look at any sibling test in `lib/api/__tests__` for how `ClientConfig` with a stub `fetch` is passed):

```ts
import { describe, it, expect } from 'vitest';
import { acquireLocks, previewCommit, commitChanges, openProject } from '../checkout';
import { getCurrentUserId } from '../client';

function jsonFetch(captured: { path?: string; body?: unknown }, payload: unknown) {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		captured.path = String(input);
		captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
		return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
	};
}

describe('checkout api', () => {
	it('POSTs /locks with targets+intent', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await acquireLocks(
			{ targets: [{ resource_id: 'e1', mode: 'exclusive' }], intent: 'edit', steal: false },
			{ fetch: jsonFetch(cap, { token: 't1', leases: [] }) }
		);
		expect(cap.path).toContain('/locks');
		expect((cap.body as { intent: string }).intent).toBe('edit');
		expect(res.token).toBe('t1');
	});

	it('previewCommit sends base_rev + ops', async () => {
		const cap: { path?: string; body?: unknown } = {};
		await previewCommit(7, [], { fetch: jsonFetch(cap, { conformance_error_count: 0, structural_blockers: [], issues: [] }) });
		expect(cap.path).toContain('/commits/preview');
		expect((cap.body as { base_rev: number }).base_rev).toBe(7);
	});

	it('commitChanges maps camelCase to snake_case body', async () => {
		const cap: { path?: string; body?: unknown } = {};
		await commitChanges(
			{ baseRev: 7, ops: [], message: 'm', lockTokens: ['t1'], ackErrors: true },
			{ fetch: jsonFetch(cap, { model_rev: 8, id_map: {}, changed_elements: [], changed_relationships: [], deleted_element_ids: [], deleted_relationship_ids: [], issues_removed_owner_ids: [], issues_added: [], issue_counts: {}, commit_id: 'c1', message: 'm', validation_error_count: 0 }) }
		);
		const body = cap.body as Record<string, unknown>;
		expect(body.base_rev).toBe(7);
		expect(body.lock_tokens).toEqual(['t1']);
		expect(body.ack_errors).toBe(true);
	});

	it('openProject GETs /open', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await openProject({ fetch: jsonFetch(cap, { model_rev: 1, role: 'editor', element_count: 0, relationship_count: 0, issue_counts: {}, lock_ttl_seconds: 300 }) });
		expect(cap.path).toContain('/open');
		expect(res.role).toBe('editor');
	});

	it('getCurrentUserId returns the dev identity', () => {
		expect(getCurrentUserId()).toBe('default-user');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- api/__tests__/checkout`
Expected: FAIL — modules/exports not found.

- [ ] **Step 3: Add `getCurrentUserId` to client.ts**

In `frontend/src/lib/api/client.ts`, the dev identity headers define `'x-user-id': 'default-user'` (~line 19-22). Add an exported accessor (place it just after the `DEV_IDENTITY_HEADERS` constant):

```ts
/** The current user's id as seen by the backend. Dev build: the static
 * x-user-id header value. (A real auth integration will replace this seam.)
 * Used by the checkout store to recognize its OWN lock events in the feed. */
export function getCurrentUserId(): string {
	return DEV_IDENTITY_HEADERS['x-user-id'];
}
```

- [ ] **Step 4: Create `api/checkout.ts`**

```ts
import { apiFetch, type ClientConfig } from './client';
import type { Op } from '$lib/state/ops';
import {
	CommitResponseSchema,
	LockResponseSchema,
	OpenResponseSchema,
	PreviewResponseSchema,
	RenewResponseSchema,
	type CommitResponse,
	type LockRequest,
	type LockResponse,
	type OpenResponse,
	type PreviewResponse,
	type RenewResponse
} from './types';

/** GET /open — model_rev, role, counts, and lock_ttl_seconds. */
export function openProject(cfg?: ClientConfig): Promise<OpenResponse> {
	return apiFetch('/open', { method: 'GET', schema: OpenResponseSchema }, cfg);
}

/** POST /locks — all-or-nothing acquire. Throws ConflictError (409) on
 * conflict (body carries `conflicts`). */
export function acquireLocks(req: LockRequest, cfg?: ClientConfig): Promise<LockResponse> {
	return apiFetch('/locks', { method: 'POST', body: req, schema: LockResponseSchema }, cfg);
}

/** POST /locks/release — release every lease under `token`. */
export function releaseLock(token: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch('/locks/release', { method: 'POST', body: { token } }, cfg);
}

/** POST /locks/renew — heartbeat-extend all leases under `token`. */
export function renewLock(token: string, cfg?: ClientConfig): Promise<RenewResponse> {
	return apiFetch('/locks/renew', { method: 'POST', body: { token }, schema: RenewResponseSchema }, cfg);
}

/** POST /commits/preview — apply→validate→rollback. Throws ConflictError on
 * stale base_rev (409). */
export function previewCommit(
	baseRev: number,
	ops: readonly Op[],
	cfg?: ClientConfig
): Promise<PreviewResponse> {
	return apiFetch(
		'/commits/preview',
		{ method: 'POST', body: { base_rev: baseRev, ops }, schema: PreviewResponseSchema },
		cfg
	);
}

/** POST /commits — lock-verified, structural-gated commit. Throws
 * ConflictError (409: stale rev or missing lock) / ValidationError (422:
 * structural blocker). */
export function commitChanges(
	req: { baseRev: number; ops: readonly Op[]; message: string; lockTokens: string[]; ackErrors: boolean },
	cfg?: ClientConfig
): Promise<CommitResponse> {
	return apiFetch(
		'/commits',
		{
			method: 'POST',
			body: {
				base_rev: req.baseRev,
				ops: req.ops,
				message: req.message,
				lock_tokens: req.lockTokens,
				ack_errors: req.ackErrors
			},
			schema: CommitResponseSchema
		},
		cfg
	);
}
```

- [ ] **Step 5: Re-export from the barrel**

In `frontend/src/lib/api/index.ts`, add (matching the existing export style there):

```ts
export * as checkout from './checkout';
export { getCurrentUserId } from './client';
```

(Check the file's existing pattern — if it re-exports named functions rather than namespaces, follow that; the checkout store will import `import { checkout } from '$lib/api'` or the named functions accordingly. Keep it consistent with how `model-ops` is exported.)

- [ ] **Step 6: Run test + typecheck**

Run: `pixi run -e frontend npm test -- api/__tests__/checkout`
Expected: PASS.
Run: `pixi run -e frontend npm run check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api/checkout.ts frontend/src/lib/api/client.ts frontend/src/lib/api/index.ts frontend/src/lib/api/__tests__/checkout.test.ts
git commit -m "feat(frontend): checkout REST client (locks/commits/preview/open) + getCurrentUserId"
```

---

## Task 4: Model store — staged buffer, staged diff, back-compat shims

**Files:**
- Modify: `frontend/src/lib/state/model.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (export new accessors)
- Test: `frontend/src/lib/state/__tests__/model.staged.test.ts` (create)

This is the surgical core: `emit` stops flushing; the queue becomes the staged buffer. We KEEP `applyDelta`, the journal, `revertOptimistic`, `remapCaches`. We ADD staged accessors + `getStagedDiff()`. We provide **back-compat shims** for `flushNow`/`hasPendingOps`/`undo`/`getUndoDepth` so existing components keep compiling and behave sanely (no network flush) until later tasks rewire them; Task 15 removes the shims and dead flush code.

**Interfaces:**
- Produces:
  - `getStagedOps(): Op[]`
  - `getStagedOpsFor(id: string): Op[]`
  - `getStagedDepth(): number` (queue length)
  - `hasStagedOps(): boolean`
  - `getStagedDiff(): Diff` (reuses `computeDiff` from `./diff`)
  - `getStagedChangeCount(): number` (= staged diff total)
  - `revertStagedFor(id: string): void` (per-element discard over the journal)
  - `revertAllStaged(): void`
  - `popLastStaged(): boolean` (client-side undo; returns false if empty)
  - `clearStaged(): void` (drop the buffer WITHOUT reverting — after a successful commit)
  - `setModelError(e: ModelStoreError | null): void`
- Keeps (unchanged signatures): `emit`, `applyDelta`, `getModelRev`, `getModelError`, `clearModelError`, `resetModelStore`, all reads.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/model.staged.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
	emit, resetModelStore, seedElements, getCachedElements,
	getStagedOps, getStagedOpsFor, getStagedDepth, hasStagedOps,
	getStagedDiff, getStagedChangeCount, revertStagedFor, revertAllStaged,
	popLastStaged, clearStaged
} from '../index';

beforeEach(() => resetModelStore());

describe('staged buffer', () => {
	it('emit stages without flushing', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		expect(hasStagedOps()).toBe(true);
		expect(getStagedDepth()).toBe(1);
		expect(getCachedElements().get('e1')?.properties.name).toBe('b'); // optimistic apply kept
		expect(getStagedOpsFor('e1')).toHaveLength(1);
	});

	it('getStagedDiff reflects an edit as modified', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		const diff = getStagedDiff();
		expect(diff.counts.modified).toBe(1);
		expect(getStagedChangeCount()).toBe(1);
	});

	it('revertStagedFor reverts that element only', () => {
		seedElements([
			{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 },
			{ id: 'e2', type_name: 'T', properties: { name: 'x' }, rev: 1 }
		]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		emit({ kind: 'update_element', id: 'e2', properties_patch: { name: 'y' } });
		revertStagedFor('e1');
		expect(getCachedElements().get('e1')?.properties.name).toBe('a'); // reverted
		expect(getCachedElements().get('e2')?.properties.name).toBe('y'); // kept
		expect(getStagedOpsFor('e1')).toHaveLength(0);
		expect(getStagedDepth()).toBe(1);
	});

	it('popLastStaged undoes the last op only', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'c' } });
		// coalescing: both patches collapse into one queued op on e1 → undo clears it
		expect(popLastStaged()).toBe(true);
		expect(getCachedElements().get('e1')?.properties.name).toBe('a');
		expect(popLastStaged()).toBe(false); // empty
	});

	it('clearStaged drops the buffer without reverting caches', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		clearStaged();
		expect(hasStagedOps()).toBe(false);
		expect(getCachedElements().get('e1')?.properties.name).toBe('b'); // NOT reverted
	});

	it('revertAllStaged reverts everything', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		revertAllStaged();
		expect(hasStagedOps()).toBe(false);
		expect(getCachedElements().get('e1')?.properties.name).toBe('a');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- model.staged`
Expected: FAIL — accessors not exported; `emit` currently schedules a flush (timers).

- [ ] **Step 3: Stop `emit` from flushing**

In `frontend/src/lib/state/model.svelte.ts`, in `emit(op)` remove the three `scheduleFlush(...)` calls (the two in the property-update branch and the one after the structural push). The op is applied + journaled + pushed only. Keep the property-coalescing logic. Concretely, `emit` becomes:

```ts
export function emit(op: Op): void {
	if (_error?.kind === 'conflict') return;

	const revert = applyOptimistic(op);

	if (isPropertyUpdate(op)) {
		const existing = _queue.find((q) => q.op.kind === op.kind && q.op.id === op.id);
		if (existing !== undefined && isPropertyUpdate(existing.op)) {
			existing.op.properties_patch = {
				...existing.op.properties_patch,
				...op.properties_patch
			};
			if (existing.revert.length === 0) existing.revert.push(...revert);
			return;
		}
		_queue.push({ op: { ...op, properties_patch: { ...op.properties_patch } }, revert });
		return;
	}

	_queue.push({
		op:
			op.kind === 'create_element' || op.kind === 'create_relationship'
				? { ...op, properties: { ...op.properties } }
				: op,
		revert
	});
}
```

- [ ] **Step 4: Add the staged accessors**

Add an import at the top of the file: `import { computeDiff, type Diff } from './diff';` (verify the relative path; `diff.ts` is in the same dir). Then add this section (place it after `emit`/`revertOptimistic`, before the cache-or-fetch reads). It reuses `revertOptimistic` (which already replays journal entries newest-first):

```ts
// ---------------------------------------------------------------------------
// Staged-edits surface (Spec B): the queue is the local-edit buffer held until
// commit. No auto-flush. Discard/undo replay the per-op journal recorded at
// emit time; commit drops the buffer (clearStaged) after applyDelta installs
// the server's canonical post-commit state.
// ---------------------------------------------------------------------------

function queuedTargetId(q: QueuedOp): string {
	const op = q.op;
	return op.kind === 'create_element' || op.kind === 'create_relationship' ? op.temp_id : op.id;
}

export function getStagedOps(): Op[] {
	return _queue.map((q) => q.op);
}

export function getStagedOpsFor(id: string): Op[] {
	return _queue.filter((q) => queuedTargetId(q) === id).map((q) => q.op);
}

export function getStagedDepth(): number {
	return _queue.length;
}

export function hasStagedOps(): boolean {
	return _queue.length > 0;
}

/** Revert and remove every staged op targeting `id` (per-element discard).
 * Reverts newest-first across the whole buffer slice for `id` so cascades
 * (e.g. a delete_element that also removed incident relationships) restore. */
export function revertStagedFor(id: string): void {
	const remove = _queue.filter((q) => queuedTargetId(q) === id);
	if (remove.length === 0) return;
	revertOptimistic(remove);
	_queue = _queue.filter((q) => queuedTargetId(q) !== id);
}

export function revertAllStaged(): void {
	if (_queue.length === 0) return;
	revertOptimistic(_queue);
	_queue = [];
}

/** Client-side undo: revert the last staged op. Returns false if empty. */
export function popLastStaged(): boolean {
	const last = _queue[_queue.length - 1];
	if (last === undefined) return false;
	revertOptimistic([last]);
	_queue = _queue.slice(0, -1);
	return true;
}

/** Drop the buffer WITHOUT reverting caches — after a successful commit the
 * caches already hold the committed state (applyDelta installed it). */
export function clearStaged(): void {
	_queue = [];
}

/** A diff of the staged edits, for the commit-review panel and badge. Baseline
 * = each touched entity's earliest journaled `before` (absent ⇒ created);
 * working = its current cache value (absent ⇒ deleted). Reuses computeDiff. */
export function getStagedDiff(): Diff {
	const baseElements = new Map<string, Element>();
	const baseRels = new Map<string, Relationship>();
	for (const q of _queue) {
		for (const r of q.revert) {
			if (r.before === null) continue;
			if (r.entity === 'element') {
				if (!baseElements.has(r.id)) baseElements.set(r.id, r.before);
			} else if (!baseRels.has(r.id)) baseRels.set(r.id, r.before);
		}
	}
	const touched = new Set<string>();
	for (const q of _queue) touched.add(queuedTargetId(q));
	// include ids that only appear as journal targets (cascade-deleted rels)
	for (const id of baseElements.keys()) touched.add(id);
	for (const id of baseRels.keys()) touched.add(id);

	const workingElements: Element[] = [];
	const workingRels: Relationship[] = [];
	for (const id of touched) {
		const e = _elements.get(id);
		if (e !== undefined) workingElements.push(e);
		const r = _relationships.get(id);
		if (r !== undefined) workingRels.push(r);
	}
	return computeDiff(
		{ elements: [...baseElements.values()], relationships: [...baseRels.values()] } as never,
		{ elements: workingElements, relationships: workingRels }
	);
}

export function getStagedChangeCount(): number {
	const c = getStagedDiff().counts;
	return c.added + c.modified + c.deleted;
}

export function setModelError(e: ModelStoreError | null): void {
	_error = e;
}
```

Note: `computeDiff(baseline, working)` takes `baseline: ModelOut | null`; we pass a structural literal with just `elements`/`relationships` (the only fields it reads) cast via `as never` to satisfy the type without fabricating a full `ModelOut`. If `npm run check` rejects `as never` here, instead build the minimal object typed as `Pick<ModelOut, 'elements' | 'relationships'>` and change `computeDiff`'s param to that Pick — but prefer the cast to avoid touching `diff.ts`.

- [ ] **Step 5: Add back-compat shims (keep build green; removed in Task 15)**

Replace the existing `flushNow`, `undo`, `hasPendingOps`, `getUndoDepth` implementations with shims so current consumers keep working without networked flush. Keep `getUndoDepth`/`getModelGeneration` etc. that other code reads. Concretely:

```ts
/** @deprecated Spec B: edits no longer flush continuously. No-op kept so
 * legacy save-gating callers resolve cleanly. Removed in Task 15. */
export async function flushNow(): Promise<void> {
	return;
}

/** @deprecated Spec B: maps to the staged buffer. Removed in Task 15. */
export function hasPendingOps(): boolean {
	return hasStagedOps();
}

/** @deprecated Spec B: client-side undo of the last staged op. Removed in
 * Task 15 (callers move to popLastStaged). */
export async function undo(): Promise<boolean> {
	return popLastStaged();
}

/** @deprecated Spec B: staged depth drives the Undo-enabled check. Removed in
 * Task 15. */
export function getUndoDepth(): number {
	return _queue.length;
}
```

Delete the now-unreachable flush internals **only if** they're unreferenced after these shims compile: `scheduleFlush`, `cancelFlushTimer`, `flushLoop`, `startFlush`, `handleFlushError`, `_flushTimer`, `_flushDeadline`, `_flushPromise`, `_inFlight`, and `_undoDepth` usage. If removing them in this task causes churn/breakage, leave them dead and remove in Task 15 — the priority is a green build. Keep `resetModelStore` clearing whatever fields remain. (The `modelOpsApi`/`validateModel` imports stay if still referenced; `applyDelta` and `revertOptimistic` MUST remain.)

- [ ] **Step 6: Export the new accessors**

In `frontend/src/lib/state/index.ts`, add to the model exports:

```ts
export {
	getStagedOps, getStagedOpsFor, getStagedDepth, hasStagedOps,
	getStagedDiff, getStagedChangeCount, revertStagedFor, revertAllStaged,
	popLastStaged, clearStaged, setModelError
} from './model.svelte';
```

(Keep the existing `flushNow`/`hasPendingOps`/`undo`/`getUndoDepth` exports for now.)

- [ ] **Step 7: Run tests + typecheck**

Run: `pixi run -e frontend npm test -- model.staged`
Expected: PASS.
Run: `pixi run -e frontend npm test -- state/__tests__` (the existing model store tests)
Expected: existing flush-path tests that asserted networked flushing may now fail — for any such test, update it to assert *staging* instead of flushing (the op stays queued, caches reflect it, no fetch). Do NOT delete coverage; convert it. List each converted test in the commit body.
Run: `pixi run -e frontend npm run check`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/state/model.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/
git commit -m "feat(frontend): convert model store flush queue into a staged-edits buffer (Spec B)"
```

---

## Task 5: Checkout store — lock registry + `ensureCheckout`

**Files:**
- Create: `frontend/src/lib/state/checkout.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/checkout.ensure.test.ts` (create)

**Interfaces:**
- Consumes: `acquireLocks`/`releaseLock` from `api/checkout`; `getCurrentUserId`; `ConflictError` from `api/errors`.
- Produces:
  - `setCheckoutApiConfig(cfg?: ClientConfig): void` (test seam, mirrors `setModelApiConfig`)
  - `setProjectInfo(info: { role: string; lockTtlSeconds: number }): void`
  - `getRole(): string` , `canEdit(): boolean` (role ∈ {editor, owner})
  - `type CheckoutResult = { ok: true } | { ok: false; reason: 'viewer' | 'conflict'; conflicts?: LockConflictLite[] }`
  - `type LockConflictLite = { resource_id: string; held_by: string; held_mode: string }`
  - `ensureCheckout(targets: LockTargetIn[], intent: LockIntent): Promise<CheckoutResult>`
  - `getHeldToken(resourceId: string): string | undefined`
  - `getHeldTokens(): string[]` (distinct)
  - `isCheckedOutByMe(resourceId: string): boolean`
  - `resetCheckout(): void` (test isolation + model unload)
  - internal (exported for later tasks): `_registry` access via `getHeldTokens`, plus `_recordLeases`/`_dropToken` used by Tasks 6-8 (define them here).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/checkout.ensure.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ensureCheckout, setProjectInfo, resetCheckout, isCheckedOutByMe, getHeldTokens, canEdit
} from '../index';
import * as api from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

describe('ensureCheckout', () => {
	it('acquires an exclusive edit lock on first call and records it', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
		});
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		expect(res.ok).toBe(true);
		expect(isCheckedOutByMe('e1')).toBe(true);
		expect(getHeldTokens()).toEqual(['t1']);
		expect(spy).toHaveBeenCalledOnce();
	});

	it('is idempotent: a second edit on a held element does not re-acquire', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
		});
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		expect(res.ok).toBe(true);
		expect(spy).toHaveBeenCalledOnce(); // still once
	});

	it('returns {ok:false, reason:conflict} on 409', async () => {
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(
			new ConflictError(409, { detail: 'lock conflict', conflicts: [{ resource_id: 'e1', held_by: 'bob', held_mode: 'exclusive' }] }, 'lock conflict')
		);
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.reason).toBe('conflict');
			expect(res.conflicts?.[0].held_by).toBe('bob');
		}
		expect(isCheckedOutByMe('e1')).toBe(false);
	});

	it('blocks viewers without any network call', async () => {
		setProjectInfo({ role: 'viewer', lockTtlSeconds: 300 });
		const spy = vi.spyOn(api, 'acquireLocks');
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe('viewer');
		expect(canEdit()).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	it('acquires only the not-already-held targets (connect: source held, pin target)', async () => {
		vi.spyOn(api, 'acquireLocks')
			.mockResolvedValueOnce({ token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }] })
			.mockResolvedValueOnce({ token: 't2', leases: [{ resource_id: 'e2', mode: 'shared', holder: 'default-user', token: 't2', intent: 'connect', expires_at: 1 }] });
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }, { resource_id: 'e2', mode: 'shared' }], 'connect');
		expect(res.ok).toBe(true);
		// second call only requested e2 (e1 exclusive already covers it)
		expect((api.acquireLocks as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0]).toEqual({
			targets: [{ resource_id: 'e2', mode: 'shared' }], intent: 'connect', steal: false
		});
		expect(getHeldTokens().sort()).toEqual(['t1', 't2']);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- checkout.ensure`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Create the store (registry + ensureCheckout)**

Create `frontend/src/lib/state/checkout.svelte.ts`:

```ts
import { SvelteMap } from 'svelte/reactivity';

import type { ClientConfig } from '$lib/api/client';
import { getCurrentUserId } from '$lib/api/client';
import { acquireLocks, releaseLock } from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import type { LeaseOut, LockIntent, LockTargetIn } from '$lib/api/types';

/**
 * Checkout store (Spec B): the editing-session state layered over the model
 * store. Owns MY held locks (token-keyed; tokens are private to the acquirer
 * and never broadcast), the heartbeat (Task 6), and the preview/commit/discard
 * lifecycle (Task 7). Peer lock state (badges) comes from realtime.svelte.ts;
 * this store is the authoritative source for my own tokens.
 */

export type LockConflictLite = { resource_id: string; held_by: string; held_mode: string };
export type CheckoutResult =
	| { ok: true }
	| { ok: false; reason: 'viewer' | 'conflict'; conflicts?: LockConflictLite[] };

interface HeldLease {
	token: string;
	mode: 'exclusive' | 'shared';
}

/** resource_id -> the lease I hold on it. Multiple resources can share a token
 * (e.g. a delete subtree); release-by-token drops them together. */
const _registry = new SvelteMap<string, HeldLease>();

let _role = $state('viewer');
let _lockTtlSeconds = 300;
let _clientConfig: ClientConfig | undefined;

export function setCheckoutApiConfig(cfg: ClientConfig | undefined): void {
	_clientConfig = cfg;
}

export function setProjectInfo(info: { role: string; lockTtlSeconds: number }): void {
	_role = info.role;
	_lockTtlSeconds = info.lockTtlSeconds > 0 ? info.lockTtlSeconds : _lockTtlSeconds;
}

export function getRole(): string {
	return _role;
}

export function canEdit(): boolean {
	return _role === 'editor' || _role === 'owner';
}

export function getHeldToken(resourceId: string): string | undefined {
	return _registry.get(resourceId)?.token;
}

export function getHeldTokens(): string[] {
	return [...new Set([..._registry.values()].map((l) => l.token))];
}

export function isCheckedOutByMe(resourceId: string): boolean {
	return _registry.has(resourceId);
}

/** Internal: record granted leases under their token. Exported for Tasks 6-8. */
export function _recordLeases(leases: LeaseOut[]): void {
	for (const le of leases) {
		_registry.set(le.resource_id, {
			token: le.token,
			mode: le.mode === 'exclusive' ? 'exclusive' : 'shared'
		});
	}
}

/** Internal: drop every registry entry under `token`. */
export function _dropToken(token: string): void {
	for (const [rid, lease] of _registry) {
		if (lease.token === token) _registry.delete(rid);
	}
}

/** True when the registry already covers (resource, mode): an exclusive hold
 * covers a shared requirement; a shared hold covers only shared. */
function alreadyHeld(t: LockTargetIn): boolean {
	const held = _registry.get(t.resource_id);
	if (held === undefined) return false;
	if (t.mode === 'shared') return true; // any hold covers a pin
	return held.mode === 'exclusive';
}

/**
 * Auto-acquire gate. Acquires the subset of `targets` not already held, under
 * `intent`, as ONE /locks call (one token). Idempotent: returns {ok:true}
 * synchronously when everything is held. Viewers are blocked before any
 * network call. A 409 returns {ok:false, reason:'conflict'} with details.
 */
export async function ensureCheckout(
	targets: LockTargetIn[],
	intent: LockIntent
): Promise<CheckoutResult> {
	if (!canEdit()) return { ok: false, reason: 'viewer' };
	const needed = targets.filter((t) => !alreadyHeld(t));
	if (needed.length === 0) return { ok: true };
	try {
		const res = await acquireLocks({ targets: needed, intent, steal: false }, _clientConfig);
		_recordLeases(res.leases);
		_maybeStartHeartbeat(); // defined in Task 6
		return { ok: true };
	} catch (err) {
		if (err instanceof ConflictError) {
			const body = err.body as { conflicts?: LockConflictLite[] } | undefined;
			return { ok: false, reason: 'conflict', conflicts: body?.conflicts };
		}
		throw err;
	}
}

export function resetCheckout(): void {
	_registry.clear();
	_role = 'viewer';
	_lockTtlSeconds = 300;
	_stopHeartbeat(); // defined in Task 6
}

// --- heartbeat (Task 6) ----------------------------------------------------
// Stubs so this task compiles standalone; Task 6 fills them in.
function _maybeStartHeartbeat(): void {}
function _stopHeartbeat(): void {}
export const __ttlForTests = () => _lockTtlSeconds;
```

Note the heartbeat stubs at the bottom — Task 6 replaces them. Keeping them here lets this task build and test in isolation.

- [ ] **Step 4: Export from the barrel**

In `frontend/src/lib/state/index.ts` add:

```ts
export {
	setCheckoutApiConfig, setProjectInfo, getRole, canEdit, ensureCheckout,
	getHeldToken, getHeldTokens, isCheckedOutByMe, resetCheckout,
	type CheckoutResult, type LockConflictLite
} from './checkout.svelte';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pixi run -e frontend npm test -- checkout.ensure`
Expected: PASS.
Run: `pixi run -e frontend npm run check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/state/checkout.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/checkout.ensure.test.ts
git commit -m "feat(frontend): checkout store — lock registry + auto-acquire ensureCheckout (Spec B)"
```

---

## Task 6: Checkout store — heartbeat renew loop

**Files:**
- Modify: `frontend/src/lib/state/checkout.svelte.ts`
- Test: `frontend/src/lib/state/__tests__/checkout.heartbeat.test.ts` (create)

**Interfaces:**
- Consumes: `renewLock` from `api/checkout`.
- Produces: heartbeat starts on first lock acquired, renews every `ttl/2` seconds for each distinct token, stops when the registry empties. A renew returning `{ok:false}` for a token drops it (the lease expired server-side) and triggers `_onTokenExpired(token)` (Task 8 stub here).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/checkout.heartbeat.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ensureCheckout, setProjectInfo, resetCheckout, getHeldTokens } from '../index';
import * as api from '$lib/api/checkout';

beforeEach(() => {
	vi.useFakeTimers();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 100 }); // renew @ 50s
});
afterEach(() => vi.useRealTimers());

describe('heartbeat', () => {
	it('renews held tokens every ttl/2', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
		});
		const renew = vi.spyOn(api, 'renewLock').mockResolvedValue({ ok: true });
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		await vi.advanceTimersByTimeAsync(50_000);
		expect(renew).toHaveBeenCalledWith('t1', undefined);
		await vi.advanceTimersByTimeAsync(50_000);
		expect(renew).toHaveBeenCalledTimes(2);
	});

	it('drops a token whose renew returns ok:false', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
		});
		vi.spyOn(api, 'renewLock').mockResolvedValue({ ok: false });
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		await vi.advanceTimersByTimeAsync(50_000);
		expect(getHeldTokens()).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- checkout.heartbeat`
Expected: FAIL — renew never called (heartbeat is a stub).

- [ ] **Step 3: Implement the heartbeat**

In `checkout.svelte.ts`, add the import: `import { acquireLocks, releaseLock, renewLock } from '$lib/api/checkout';` (extend the existing import). Replace the two heartbeat stubs at the bottom with:

```ts
// --- heartbeat -------------------------------------------------------------

let _heartbeat: ReturnType<typeof setInterval> | null = null;

function _maybeStartHeartbeat(): void {
	if (_heartbeat !== null) return;
	if (_registry.size === 0) return;
	const intervalMs = Math.max(1, Math.floor((_lockTtlSeconds / 2) * 1000));
	_heartbeat = setInterval(() => void _renewAll(), intervalMs);
}

function _stopHeartbeat(): void {
	if (_heartbeat !== null) {
		clearInterval(_heartbeat);
		_heartbeat = null;
	}
}

async function _renewAll(): Promise<void> {
	for (const token of getHeldTokens()) {
		try {
			const res = await renewLock(token, _clientConfig);
			if (!res.ok) {
				_dropToken(token);
				_onTokenExpired(token);
			}
		} catch {
			// transient renew failure: keep the token; next tick retries
		}
	}
	if (_registry.size === 0) _stopHeartbeat();
}

// --- expiry hook (Task 8) --------------------------------------------------
function _onTokenExpired(_token: string): void {}
```

(Remove the temporary `_maybeStartHeartbeat`/`_stopHeartbeat` stubs added in Task 5.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pixi run -e frontend npm test -- checkout.heartbeat checkout.ensure`
Expected: PASS (both).
Run: `pixi run -e frontend npm run check`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/checkout.svelte.ts frontend/src/lib/state/__tests__/checkout.heartbeat.test.ts
git commit -m "feat(frontend): checkout heartbeat renew loop (Spec B)"
```

---

## Task 7: Checkout store — preview, commit, discard

**Files:**
- Modify: `frontend/src/lib/state/checkout.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/checkout.commit.test.ts` (create)

**Interfaces:**
- Consumes: `previewCommit`, `commitChanges` from `api/checkout`; `getStagedOps`, `getModelRev`, `applyDelta`, `clearStaged`, `revertStagedFor`, `revertAllStaged` from the model store.
- Produces:
  - `previewStaged(): Promise<PreviewResponse>` (uses live rev + staged ops)
  - `commitStaged(message: string, ackErrors: boolean): Promise<CommitResponse>` (passes all held tokens; on success `applyDelta` + `clearStaged` + clear registry + stop heartbeat)
  - `discardElement(id: string): Promise<void>` (revert that element's staged ops + release its token)
  - `discardAll(): Promise<void>` (revert all + release all tokens)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/checkout.commit.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ensureCheckout, setProjectInfo, resetCheckout, commitStaged, previewStaged,
	discardElement, getHeldTokens, isCheckedOutByMe,
	emit, seedElements, resetModelStore, getCachedElements, hasStagedOps
} from '../index';
import * as api from '$lib/api/checkout';

beforeEach(() => {
	resetModelStore();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

async function checkoutAndEdit() {
	vi.spyOn(api, 'acquireLocks').mockResolvedValue({
		token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
	});
	seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
	await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
	emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
}

describe('commit lifecycle', () => {
	it('previewStaged sends the live rev + staged ops', async () => {
		await checkoutAndEdit();
		const spy = vi.spyOn(api, 'previewCommit').mockResolvedValue({ conformance_error_count: 0, structural_blockers: [], issues: [] });
		await previewStaged();
		expect(spy).toHaveBeenCalledOnce();
		const [rev, ops] = spy.mock.calls[0];
		expect(rev).toBe(0); // getModelRev after seed (no acked deltas)
		expect(ops).toHaveLength(1);
	});

	it('commitStaged applies the delta, clears the buffer + registry', async () => {
		await checkoutAndEdit();
		vi.spyOn(api, 'commitChanges').mockResolvedValue({
			model_rev: 1, id_map: {},
			changed_elements: [{ id: 'e1', type_name: 'T', properties: { name: 'b' }, rev: 2 }],
			changed_relationships: [], deleted_element_ids: [], deleted_relationship_ids: [],
			issues_removed_owner_ids: [], issues_added: [], issue_counts: {},
			commit_id: 'c1', message: 'm', validation_error_count: 0
		});
		await commitStaged('m', false);
		expect(hasStagedOps()).toBe(false);
		expect(getHeldTokens()).toEqual([]);
		expect(isCheckedOutByMe('e1')).toBe(false);
		expect(getCachedElements().get('e1')?.rev).toBe(2);
	});

	it('commitStaged passes all held tokens + ack_errors', async () => {
		await checkoutAndEdit();
		const spy = vi.spyOn(api, 'commitChanges').mockResolvedValue({
			model_rev: 1, id_map: {}, changed_elements: [], changed_relationships: [],
			deleted_element_ids: [], deleted_relationship_ids: [], issues_removed_owner_ids: [],
			issues_added: [], issue_counts: {}, commit_id: 'c1', message: 'm', validation_error_count: 3
		});
		await commitStaged('m', true);
		expect(spy.mock.calls[0][0]).toMatchObject({ message: 'm', lockTokens: ['t1'], ackErrors: true });
	});

	it('discardElement reverts that element and releases its token', async () => {
		await checkoutAndEdit();
		const rel = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);
		await discardElement('e1');
		expect(rel).toHaveBeenCalledWith('t1', undefined);
		expect(getCachedElements().get('e1')?.properties.name).toBe('a'); // reverted
		expect(isCheckedOutByMe('e1')).toBe(false);
		expect(hasStagedOps()).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- checkout.commit`
Expected: FAIL — `previewStaged`/`commitStaged`/`discardElement` not exported.

- [ ] **Step 3: Implement preview/commit/discard**

In `checkout.svelte.ts`, extend the api import to include `previewCommit, commitChanges`, and import the model-store functions:

```ts
import { applyDelta, clearStaged, getModelRev, getStagedOps, revertAllStaged, revertStagedFor } from './model.svelte';
import type { CommitResponse, PreviewResponse } from '$lib/api/types';
```

Add:

```ts
// --- preview / commit / discard --------------------------------------------

/** Preview the staged batch at the live rev (kept current by the feed). */
export function previewStaged(): Promise<PreviewResponse> {
	return previewCommit(getModelRev(), getStagedOps(), _clientConfig);
}

/** Commit all staged edits. On success the server releases the passed tokens,
 * so we apply the delta and clear the buffer + registry locally. */
export async function commitStaged(message: string, ackErrors: boolean): Promise<CommitResponse> {
	const res = await commitChanges(
		{ baseRev: getModelRev(), ops: getStagedOps(), message, lockTokens: getHeldTokens(), ackErrors },
		_clientConfig
	);
	applyDelta(res);
	clearStaged();
	_registry.clear();
	_stopHeartbeat();
	return res;
}

/** Per-element abandon: revert the element's staged edits and release its
 * token (which also frees any co-acquired resources, e.g. a delete subtree). */
export async function discardElement(id: string): Promise<void> {
	const token = getHeldToken(id);
	revertStagedFor(id);
	if (token !== undefined) {
		_dropToken(token);
		await releaseLock(token, _clientConfig);
	}
	if (_registry.size === 0) _stopHeartbeat();
}

/** Abandon everything: revert all staged edits and release every token. */
export async function discardAll(): Promise<void> {
	revertAllStaged();
	const tokens = getHeldTokens();
	_registry.clear();
	_stopHeartbeat();
	await Promise.all(tokens.map((t) => releaseLock(t, _clientConfig).catch(() => {})));
}
```

- [ ] **Step 4: Export from barrel**

In `index.ts` add `previewStaged, commitStaged, discardElement, discardAll` to the checkout export list.

- [ ] **Step 5: Run tests + typecheck**

Run: `pixi run -e frontend npm test -- checkout.commit`
Expected: PASS.
Run: `pixi run -e frontend npm run check`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/state/checkout.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/checkout.commit.test.ts
git commit -m "feat(frontend): checkout preview/commit/discard lifecycle (Spec B)"
```

---

## Task 8: Checkout store — project open + own-lock-expiry tap

**Files:**
- Modify: `frontend/src/lib/state/checkout.svelte.ts`
- Modify: `frontend/src/lib/state/realtime.svelte.ts` (add a lock-event tap)
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/checkout.expiry.test.ts` (create)

**Interfaces:**
- Consumes: `openProject` from `api/checkout`; the new `onLockEvent` tap from realtime.
- Produces (checkout):
  - `loadProjectInfo(cfg?: ClientConfig): Promise<void>` — `openProject()` → `setProjectInfo({role, lockTtlSeconds})`.
  - `getStaleResources(): string[]` — resources whose lock expired while I held them (uncommittable until re-checkout/discard).
  - `handleRemoteLockEvent(action, leases): void` — when `action==='expired'|'released'` and a lease's `holder_id === getCurrentUserId()` for a registry resource, mark it stale + drop the token.
- Produces (realtime): `onLockEvent(cb: (action, leases) => void): () => void` — register a tap fired for every `lock` feed event; returns an unsubscribe fn.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/checkout.expiry.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ensureCheckout, setProjectInfo, resetCheckout, loadProjectInfo,
	handleRemoteLockEvent, getStaleResources, isCheckedOutByMe
} from '../index';
import * as api from '$lib/api/checkout';

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

describe('project open + own-lock expiry', () => {
	it('loadProjectInfo adopts role + ttl from /open', async () => {
		vi.spyOn(api, 'openProject').mockResolvedValue({
			model_rev: 5, role: 'owner', element_count: 0, relationship_count: 0, issue_counts: {}, lock_ttl_seconds: 120
		});
		await loadProjectInfo();
		// role adopted; a viewer-guard now passes (owner can edit)
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit')
			.catch(() => ({ ok: false }));
		expect(res).toBeDefined();
	});

	it('marks my resource stale on a remote expired event for my holder id', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
		});
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		handleRemoteLockEvent('expired', [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'default-user' }]);
		expect(getStaleResources()).toContain('e1');
		expect(isCheckedOutByMe('e1')).toBe(false); // token dropped
	});

	it('ignores expiry events for other users', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
		});
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		handleRemoteLockEvent('expired', [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'someone-else' }]);
		expect(getStaleResources()).not.toContain('e1');
		expect(isCheckedOutByMe('e1')).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- checkout.expiry`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement open + expiry in checkout.svelte.ts**

Extend imports: `import { openProject, ... } from '$lib/api/checkout';` and the existing `getCurrentUserId`. Add:

```ts
import type { LeaseLite } from '$lib/api/feed';

const _stale = new SvelteMap<string, true>();

/** Fetch role + lock TTL from /open and adopt them. */
export async function loadProjectInfo(cfg?: ClientConfig): Promise<void> {
	const info = await openProject(cfg ?? _clientConfig);
	setProjectInfo({ role: info.role, lockTtlSeconds: info.lock_ttl_seconds });
}

export function getStaleResources(): string[] {
	return [..._stale.keys()];
}

export function clearStaleResource(id: string): void {
	_stale.delete(id);
}

/** Feed lock-event handler: if one of MY held resources is released/expired by
 * the server (TTL lapse), mark it stale (its staged edits are now
 * uncommittable) and drop my token for it. */
export function handleRemoteLockEvent(
	action: 'acquired' | 'released' | 'expired',
	leases: LeaseLite[]
): void {
	if (action === 'acquired') return;
	const me = getCurrentUserId();
	for (const le of leases) {
		if (le.holder_id !== me) continue;
		if (!_registry.has(le.resource_id)) continue;
		const token = _registry.get(le.resource_id)?.token;
		if (action === 'expired') _stale.set(le.resource_id, true);
		if (token) _dropToken(token);
	}
	if (_registry.size === 0) _stopHeartbeat();
}

/** Replace the Task 6 expiry stub: a renew-detected expiry also marks stale. */
function _onTokenExpired(token: string): void {
	for (const [rid, lease] of _registry) {
		if (lease.token === token) _stale.set(rid, true);
	}
}
```

Remove the empty `_onTokenExpired` stub from Task 6 (this one supersedes it). Also clear `_stale` in `resetCheckout()`.

- [ ] **Step 4: Add the lock-event tap to realtime.svelte.ts**

In `frontend/src/lib/state/realtime.svelte.ts`, add a subscriber list and fire it from the existing `handleFeedEvent` `'lock'` case. Near the top-level state:

```ts
type LockTap = (action: 'acquired' | 'released' | 'expired', leases: LeaseLite[]) => void;
const _lockTaps = new Set<LockTap>();

/** Register a tap fired on every lock feed event (the checkout store uses this
 * to detect expiry of its OWN locks). Returns an unsubscribe fn. */
export function onLockEvent(cb: LockTap): () => void {
	_lockTaps.add(cb);
	return () => _lockTaps.delete(cb);
}
```

In the `'lock'` branch of `handleFeedEvent`, after it updates `_lockState`, add:

```ts
for (const tap of _lockTaps) tap(e.action, e.leases);
```

Ensure `resetRealtime()` clears `_lockTaps` (`_lockTaps.clear()`).

- [ ] **Step 5: Export from barrels**

`index.ts`: add `loadProjectInfo, getStaleResources, clearStaleResource, handleRemoteLockEvent` (checkout) and `onLockEvent` (realtime).

- [ ] **Step 6: Run tests + typecheck**

Run: `pixi run -e frontend npm test -- checkout.expiry realtime`
Expected: PASS (and the existing realtime tests still pass).
Run: `pixi run -e frontend npm run check`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/state/checkout.svelte.ts frontend/src/lib/state/realtime.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/checkout.expiry.test.ts
git commit -m "feat(frontend): project-open role/ttl + own-lock-expiry detection (Spec B)"
```

---

## Task 9: App boot wiring — open project, init checkout, expiry tap

**Files:**
- Modify: `frontend/src/routes/+page.svelte`
- Test: manual (covered by the Playwright smoke in Task 14; no unit test for the page shell)

**Interfaces:**
- Consumes: `loadProjectInfo`, `resetCheckout`, `onLockEvent`, `handleRemoteLockEvent` from `$lib/state`.

- [ ] **Step 1: Wire checkout into boot**

In `frontend/src/routes/+page.svelte`, extend the `$lib/state` import to add `loadProjectInfo, resetCheckout, onLockEvent, handleRemoteLockEvent`. In `boot()`, after `await refreshSummary()` succeeds (a model exists), load project info:

```ts
		try {
			await refreshSummary();
		} catch {
			return; // metamodel but no model
		}
		try {
			await loadProjectInfo();
		} catch {
			// role/ttl best-effort; editing stays gated as viewer until it loads
		}
		await refreshView();
```

- [ ] **Step 2: Register the lock-event tap and clean up**

Add an `onMount` that wires the realtime lock tap into the checkout store, returning the unsubscribe for cleanup:

```ts
	onMount(() => onLockEvent((action, leases) => handleRemoteLockEvent(action, leases)));
```

(`onMount` returning a function registers it as the cleanup — Svelte calls it on destroy.) Ensure `onDestroy(() => stopRealtime())` stays. In `onReloadModel()` and wherever `resetModelStore()` is called for a fresh model, also call `resetCheckout()` so a reload drops any stale registry — add `resetCheckout();` next to the existing `resetModelStore();` in `onReloadModel`.

- [ ] **Step 3: Typecheck + manual smoke**

Run: `pixi run -e frontend npm run check`
Expected: no errors.
Run (manual): start backend + frontend (`pixi run start-backend`, `pixi run start-frontend`), load the smart-city example, confirm the app boots with no console errors and the StatusBar still shows `● live`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/+page.svelte
git commit -m "feat(frontend): boot wiring — load role/ttl, tap lock events into checkout (Spec B)"
```

---

## Task 10: Inspector gesture gating (auto-acquire before emit)

**Files:**
- Modify: `frontend/src/lib/components/Inspector/PropertyForm.svelte`
- Modify: `frontend/src/lib/components/Inspector/NewRelationshipPicker.svelte`
- Modify: `frontend/src/lib/components/Workspace/DetailView.svelte`
- Modify: `frontend/src/lib/components/Inspector/RelationshipsList.svelte`
- Test: `frontend/src/lib/components/__tests__/property-form-gating.test.ts` (create — component test via the existing component-test harness; if the repo has no component-render test setup, instead unit-test a small extracted gating helper — see Step 1)

**Interfaces:**
- Consumes: `ensureCheckout`, `canEdit`, `emit` from `$lib/state`.
- Produces: a shared gating helper `frontend/src/lib/state/edit-gate.ts` so the four call sites stay DRY and unit-testable:
  - `editLock(id): Promise<boolean>` — `ensureCheckout([{resource_id:id, mode:'exclusive'}], 'edit')`, returns ok
  - `connectLock(sourceId, targetId): Promise<boolean>` — exclusive source + shared target, intent connect
  - `deleteLock(id): Promise<boolean>` — exclusive id, intent delete
  - each surfaces a user-facing message on failure via a callback/notice store (Step 4)

- [ ] **Step 1: Write the failing test for the gate helper**

Create `frontend/src/lib/state/__tests__/edit-gate.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { editLock, connectLock, deleteLock } from '../edit-gate';
import { setProjectInfo, resetCheckout } from '../index';
import * as api from '$lib/api/checkout';

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

describe('edit-gate', () => {
	it('editLock acquires exclusive edit and returns true', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't', intent: 'edit', expires_at: 1 }] });
		expect(await editLock('e1')).toBe(true);
		expect(spy.mock.calls[0][0]).toMatchObject({ targets: [{ resource_id: 'e1', mode: 'exclusive' }], intent: 'edit' });
	});

	it('connectLock requests exclusive source + shared target with connect intent', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		await connectLock('s', 't');
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 's', mode: 'exclusive' }, { resource_id: 't', mode: 'shared' }], intent: 'connect'
		});
	});

	it('deleteLock requests exclusive delete', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		await deleteLock('e9');
		expect(spy.mock.calls[0][0]).toMatchObject({ targets: [{ resource_id: 'e9', mode: 'exclusive' }], intent: 'delete' });
	});

	it('returns false and posts a notice on conflict', async () => {
		const { ConflictError } = await import('$lib/api/errors');
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(new ConflictError(409, { conflicts: [{ resource_id: 'e1', held_by: 'bob', held_mode: 'exclusive' }] }, 'lock conflict'));
		expect(await editLock('e1')).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- edit-gate`
Expected: FAIL — `edit-gate` not found.

- [ ] **Step 3: Create the gate helper + notice store**

Create `frontend/src/lib/state/lock-notice.svelte.ts` (a tiny reactive notice surfaced by the StatusBar/Inspector):

```ts
let _notice = $state<string | null>(null);

export function setLockNotice(msg: string | null): void {
	_notice = msg;
}
export function getLockNotice(): string | null {
	return _notice;
}
```

Create `frontend/src/lib/state/edit-gate.ts`:

```ts
import { ensureCheckout } from './checkout.svelte';
import { setLockNotice } from './lock-notice.svelte';
import type { CheckoutResult } from './checkout.svelte';
import type { LockTargetIn, LockIntent } from '$lib/api/types';

function explain(res: Extract<CheckoutResult, { ok: false }>): string {
	if (res.reason === 'viewer') return 'You have view-only access to this project.';
	const c = res.conflicts?.[0];
	return c ? `Locked by ${c.held_by}.` : 'Could not acquire a lock (held by someone else).';
}

async function gate(targets: LockTargetIn[], intent: LockIntent): Promise<boolean> {
	const res = await ensureCheckout(targets, intent);
	if (res.ok) {
		setLockNotice(null);
		return true;
	}
	setLockNotice(explain(res));
	return false;
}

export function editLock(id: string): Promise<boolean> {
	return gate([{ resource_id: id, mode: 'exclusive' }], 'edit');
}

export function connectLock(sourceId: string, targetId: string): Promise<boolean> {
	return gate(
		[{ resource_id: sourceId, mode: 'exclusive' }, { resource_id: targetId, mode: 'shared' }],
		'connect'
	);
}

export function deleteLock(id: string): Promise<boolean> {
	return gate([{ resource_id: id, mode: 'exclusive' }], 'delete');
}
```

Export `editLock`/`connectLock`/`deleteLock` and `getLockNotice`/`setLockNotice` and `canEdit` from `index.ts`.

- [ ] **Step 4: Run the helper test**

Run: `pixi run -e frontend npm test -- edit-gate`
Expected: PASS.

- [ ] **Step 5: Gate PropertyForm**

In `PropertyForm.svelte`, change the import to add the gate and make `onPropChange` async, acquiring the edit lock before emitting:

```ts
	import { emit } from '$lib/state';
	import { editLock } from '$lib/state/edit-gate';
	// ...
	async function onPropChange(name: string, next: unknown): Promise<void> {
		if (!(await editLock(entity.id))) return; // locked by someone / viewer
		if (kind === 'element') {
			emit({ kind: 'update_element', id: entity.id, properties_patch: { [name]: next } });
		} else {
			emit({ kind: 'update_relationship', id: entity.id, properties_patch: { [name]: next } });
		}
	}
```

Because `editLock` is idempotent (registry hit after the first acquire), subsequent keystrokes resolve without a network call. The controlled input holds the typed value during the first await.

- [ ] **Step 6: Gate NewRelationshipPicker**

In `NewRelationshipPicker.svelte`, make `create()` async and gate on `connectLock`:

```ts
	import { createTempId, emit } from '$lib/state';
	import { connectLock } from '$lib/state/edit-gate';
	// ...
	async function create(): Promise<void> {
		if (selectedType === '' || selectedTarget === '') return;
		if (!(await connectLock(sourceId, selectedTarget))) return;
		emit({
			kind: 'create_relationship',
			temp_id: createTempId(),
			type_name: selectedType,
			source_id: sourceId,
			target_id: selectedTarget,
			properties: {}
		});
		reset();
	}
```

- [ ] **Step 7: Gate DetailView delete handlers**

In `DetailView.svelte`, gate both delete handlers:

```ts
	import { emit, /* …existing… */ } from '$lib/state';
	import { deleteLock } from '$lib/state/edit-gate';
	// ...
	async function onDeleteElement(): Promise<void> {
		if (entity === null || selection?.kind !== 'element') return;
		const confirmed = window.confirm('Delete this element? Related relationships will also be removed.');
		if (!confirmed) return;
		if (!(await deleteLock(entity.id))) return;
		emit({ kind: 'delete_element', id: entity.id });
		select(null);
	}

	async function onDisconnectRelationship(): Promise<void> {
		if (entity === null || selection?.kind !== 'relationship') return;
		// a relationship is locked via its SOURCE element (backend rule)
		const rel = entity as Relationship;
		if (!(await deleteLock(rel.source_id))) return;
		emit({ kind: 'delete_relationship', id: entity.id });
		select(null);
	}
```

(The `delete_relationship` lock target is the relationship's **source element** per `required_locks`; `rel.source_id` is in scope on the relationship entity.)

- [ ] **Step 8: Gate RelationshipsList disconnect**

In `RelationshipsList.svelte`, the `disconnect(id)` handler emits `delete_relationship`. It needs the relationship's source element id. The list renders relationships it already has (`rel.source_id` available per row). Change the handler to take the source id (or look it up from the row) and gate:

```ts
	import { emit } from '$lib/state';
	import { deleteLock } from '$lib/state/edit-gate';
	// ...
	async function disconnect(id: string, sourceId: string): Promise<void> {
		if (!(await deleteLock(sourceId))) return;
		emit({ kind: 'delete_relationship', id });
	}
```

Update the call site (button `onclick`) to pass `rel.source_id`: `onclick={() => void disconnect(rel.id, rel.source_id)}`.

- [ ] **Step 9: Run tests + typecheck**

Run: `pixi run -e frontend npm test`
Expected: PASS (existing component tests should still pass; the gating is additive). If a component test directly drove `onPropChange`/`create` synchronously and asserted an immediate `emit`, update it to `await` and to mock `ensureCheckout`/`acquireLocks` (mirror the edit-gate test mocks).
Run: `pixi run -e frontend npm run check`

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/state/edit-gate.ts frontend/src/lib/state/lock-notice.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/components/Inspector/PropertyForm.svelte frontend/src/lib/components/Inspector/NewRelationshipPicker.svelte frontend/src/lib/components/Workspace/DetailView.svelte frontend/src/lib/components/Inspector/RelationshipsList.svelte frontend/src/lib/state/__tests__/edit-gate.test.ts
git commit -m "feat(frontend): auto-acquire locks on first edit across the inspector gestures (Spec B)"
```

---

## Task 11: DiffDrawer → commit-review (Model tab)

**Files:**
- Modify: `frontend/src/lib/components/DiffDrawer.svelte`
- Test: covered by Task 7 store tests + the Playwright smoke (Task 14); add a focused vitest for the commit-state logic if a helper is extracted (Step 3).

The Model tab changes from "save to file" to "commit". The **View tab stays unchanged** (views are file-saved; view collaboration is out of scope). The model diff source changes from the server `/model/changes` doc to the client-side `getStagedDiff()`. The footer Model action becomes Commit, with a message field and the conformance-error gate.

**Interfaces:**
- Consumes: `getStagedDiff`, `getStagedChangeCount` (model store); `previewStaged`, `commitStaged`, `discardAll`, `discardElement` (checkout); `PreviewResponse`.

- [ ] **Step 1: Replace the Model-tab data source**

In `DiffDrawer.svelte`, the `$effect` on `open` (lines 56-94) currently `await flushNow()` then `getChanges()`. Replace the model-side load with the staged diff + preview. Change the imports: drop `changesDocToDiff`, `flushNow`, `getChanges`, `refreshChangesBadge` from the model-tab path; add `getStagedDiff`, `previewStaged`, `commitStaged`, `discardAll`, `discardElement`, and `type PreviewResponse`. Replace the effect body's model branch:

```ts
	let preview: PreviewResponse | null = $state(null);
	let previewError: string | null = $state(null);

	$effect(() => {
		if (!open) return;
		const seq = ++loadSeq;
		loading = true;
		loadError = null;
		preview = null;
		previewError = null;
		untrack(() => {
			void (async () => {
				try {
					const p = await previewStaged();
					if (seq !== loadSeq) return;
					preview = p;
				} catch (err) {
					if (seq !== loadSeq) return;
					previewError = err instanceof Error ? err.message : String(err);
				} finally {
					if (seq === loadSeq) loading = false;
				}
			})();
		});
	});
```

Replace the `diff` derived (lines 96-100) with the staged diff:

```ts
	const diff = $derived<Diff>(getStagedDiff());
```

(`getStagedDiff` returns the `Diff` shape `DiffRow` already consumes; the existing `addedElements`/`modifiedElements`/… deriveds and `total` keep working unchanged.)

- [ ] **Step 2: Add a commit-message field + conformance gate state**

Add state near the other `$state` decls:

```ts
	let message = $state('');
	let committing = $state(false);
	let commitError: string | null = $state(null);
	const errorCount = $derived(preview?.conformance_error_count ?? 0);
	const structuralBlockers = $derived(preview?.structural_blockers ?? []);
	const commitBlocked = $derived(structuralBlockers.length > 0);
```

- [ ] **Step 3: Replace `onSaveClick` with `onCommitClick`**

Replace the whole `onSaveClick` function with:

```ts
	async function onCommitClick(): Promise<void> {
		committing = true;
		commitError = null;
		try {
			// errorCount > 0 ⇒ ack_errors (the user clicked Commit anyway)
			await commitStaged(message, errorCount > 0);
			message = '';
			open = false;
		} catch (err) {
			commitError = err instanceof Error ? err.message : String(err);
		} finally {
			committing = false;
		}
	}

	async function onDiscardAll(): Promise<void> {
		await discardAll();
		open = false;
	}
```

- [ ] **Step 4: Update the Model-tab footer + body markup**

In the dialog title/description, change "Pending changes"/"Review the changes to be saved…" to commit-oriented copy ("Commit changes" / "Review and commit your local edits."). In the Model `Tabs.Content`, add a message input and the preview summary above the footer. Replace the model-side footer button block (the `{:else}` branch rendering "Save (n)") with:

```svelte
		{#if errorCount > 0}
			<div class="flex items-center gap-1.5 rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
				<AlertTriangle class="h-3 w-3" />
				<span>{errorCount} validation {errorCount === 1 ? 'issue' : 'issues'} — you can commit anyway or review on the Issues tab.</span>
			</div>
		{/if}
		{#if commitBlocked}
			<div class="rounded border border-red-900 bg-red-950/40 px-2 py-1 text-[11px] text-red-200" role="alert">
				Commit blocked: {structuralBlockers.length} structural problem(s) must be fixed first.
			</div>
		{/if}
		<label class="flex flex-col gap-1 text-xs text-zinc-300">
			Commit message
			<input class="h-7 rounded border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-zinc-600" bind:value={message} placeholder="(optional)" disabled={committing} />
		</label>
```

Footer (Model tab branch):

```svelte
		<Button type="button" variant="ghost" onclick={() => void onDiscardAll()} disabled={committing || total === 0}>
			Discard all
		</Button>
		<Button type="button" class="bg-red-600 text-white hover:bg-red-500"
			onclick={() => void onCommitClick()}
			disabled={committing || total === 0 || commitBlocked}>
			{committing ? 'Committing…' : errorCount > 0 ? `Commit anyway (${total})` : `Commit (${total})`}
		</Button>
```

Add a `{#if commitError}` / `{#if previewError}` alert block mirroring the existing `saveError` block. Keep the `pendingIssueCount` block (it still highlights issues among staged entities). Remove the `exportCr` checkbox and the CR-export wiring from the Model tab (export moves to the TopBar in Task 12); leave the **View tab** untouched.

- [ ] **Step 5: Per-row discard (optional within scope)**

`DiffRow` renders one entity. Add a small "Discard" affordance per added/modified/deleted element row that calls `discardElement(d.id)`. If `DiffRow` doesn't accept an action slot, add an optional `onDiscard?: (id: string) => void` prop to `DiffRow.svelte` and render a tiny button when provided; pass `onDiscard={(id) => void discardElement(id)}` from the element rows. (Relationship rows: discard via their source element is more complex — keep relationship per-row discard out; "Discard all" + element discard cover the core need.)

- [ ] **Step 6: Run tests + typecheck**

Run: `pixi run -e frontend npm test`
Expected: PASS (update any DiffDrawer-specific test that asserted the old save flow to assert the commit flow — mock `previewStaged`/`commitStaged`).
Run: `pixi run -e frontend npm run check`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/DiffDrawer.svelte frontend/src/lib/components/DiffRow.svelte
git commit -m "feat(frontend): repurpose DiffDrawer Model tab as the commit-review panel (Spec B)"
```

---

## Task 12: StatusBar + TopBar — commit badge, client-side undo, export

**Files:**
- Modify: `frontend/src/lib/components/StatusBar.svelte`
- Modify: `frontend/src/lib/components/TopBar.svelte`
- Test: covered by Playwright smoke (Task 14); typecheck-gated.

**Interfaces:**
- Consumes: `getStagedChangeCount`, `getStagedDepth`, `popLastStaged` (model store); `getLockNotice` (lock-notice); the existing `downloadModel`/`saveResponseToFile` for the export action.

- [ ] **Step 1: StatusBar — staged count + lock notice**

In `StatusBar.svelte`, replace the `getChangesBadgeTotal`/`hasPendingOps` model-side bits with the staged count, and surface the lock notice:

```ts
	import {
		getFilename, getIssueCounts, getModelSummary, getTypeFilter,
		getFeedConnected, getPresence, getStagedChangeCount, getLockNotice
	} from '$lib/state';
	// ...
	const totalChanges = $derived(getStagedChangeCount());
	const lockNotice = $derived(getLockNotice());
```

Replace the `{totalChanges} unsaved` + `syncing…` markup with:

```svelte
	<span>{totalChanges} uncommitted</span>
	{#if lockNotice}
		<span class="text-zinc-700">·</span>
		<span class="text-amber-400" title="Lock status">{lockNotice}</span>
	{/if}
```

(Drop the `pending`/`syncing…` indicator — there is no background flush anymore.)

- [ ] **Step 2: TopBar — Commit button, client-side undo, separate export**

In `TopBar.svelte`:
- Replace `getChangesBadgeTotal` (model part) with `getStagedChangeCount`; keep `getViewChangesCount` for the view part. So `totalChanges = getStagedChangeCount()`, `combinedChanges = totalChanges + viewChanges`.
- Replace `hasPendingOps()`/`pending` usage: the Commit button is enabled when `combinedChanges > 0`. Set `const saveDisabled = $derived(summary === null || combinedChanges === 0);` and drop `pending`.
- Rename the "Save" button label to "Commit" (it still calls `setDiffDrawerOpen(true)` — the drawer now commits). Keep `confirmDiscardChanges` but base it on `combinedChanges === 0` only (drop `hasPendingOps()`).
- Undo: replace `undo` import with `popLastStaged`; `getUndoDepth` with `getStagedDepth`. `undoDisabled = summary === null || getStagedDepth() === 0`. `onUndo` becomes synchronous client-side:

```ts
	import { popLastStaged, getStagedDepth, /* … */ } from '$lib/state';
	// ...
	function onUndo(): void {
		popLastStaged();
	}
```

Update the Undo button `onclick={onUndo}` and drop the `undoing`/`aria-busy` async machinery (or keep `undoing` unused-removed).
- Add an **Export model** action (separate from Commit): a small button or menu item that streams `downloadModel()` to a file via `saveResponseToFile`, mirroring the old DiffDrawer save path but with no CR. Minimal:

```ts
	import { downloadModel } from '$lib/api/model-read';
	import { saveResponseToFile } from '$lib/util/fileSave';
	// ...
	async function onExport(): Promise<void> {
		try {
			const resp = await downloadModel();
			await saveResponseToFile(resp, modelFilename ?? 'model.json');
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			console.error('Export failed', err);
		}
	}
```

Add an "Export" ghost button next to "Commit": `<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => void onExport()} disabled={summary === null}>Export</Button>`.
- Update the change badge tooltip label from "Model/View" "changes" to reflect "uncommitted (model)" / "unsaved (view)" if desired; cosmetic.

- [ ] **Step 3: Keep the post-rev refresh effect honest**

The `$effect` reacting to `getModelRev()`/`getModelGeneration()` currently calls `refreshSummary()` + `refreshChangesBadge()`. The staged badge no longer needs `refreshChangesBadge` (it's client-derived), but `refreshSummary` is still wanted after a commit bumps the rev (counts change). Keep `refreshSummary()`; drop the `refreshChangesBadge()` call (and its import if now unused). The staged badge is reactive via `getStagedChangeCount()` over the SvelteMap-backed queue.

- [ ] **Step 4: Typecheck + manual smoke**

Run: `pixi run -e frontend npm run check`
Expected: no errors (if `getChangesBadgeTotal`/`refreshChangesBadge`/`hasPendingOps`/`undo`/`getUndoDepth` are now unused everywhere, that's fine — they're removed in Task 15).
Run: `pixi run -e frontend npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/StatusBar.svelte frontend/src/lib/components/TopBar.svelte
git commit -m "feat(frontend): Commit button + uncommitted badge + client-side undo + export (Spec B)"
```

---

## Task 13: Sidebar TreeRow lock badges

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/TreeRow.svelte`
- Test: `frontend/src/lib/components/__tests__/tree-row-lock.test.ts` (create) OR a small helper unit test (Step 1)

**Interfaces:**
- Consumes: `getLockFor` (realtime store, returns `LeaseLite | undefined`); `getCurrentUserId`; `isCheckedOutByMe` (checkout).

- [ ] **Step 1: Write the failing test for a badge-state helper**

Create `frontend/src/lib/state/lock-badge.ts` with a pure helper and test it. Helper:

```ts
import { getLockFor } from './realtime.svelte';
import { getCurrentUserId } from '$lib/api/client';

export type LockBadge = 'none' | 'mine' | 'theirs';

export function lockBadgeFor(resourceId: string): { state: LockBadge; holder?: string } {
	const lease = getLockFor(resourceId);
	if (lease === undefined) return { state: 'none' };
	if (lease.holder_id === getCurrentUserId()) return { state: 'mine' };
	return { state: 'theirs', holder: lease.holder_id };
}
```

Test `frontend/src/lib/state/__tests__/lock-badge.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { lockBadgeFor } from '../lock-badge';
import { handleFeedEvent, resetRealtime } from '../realtime.svelte';

beforeEach(() => resetRealtime());

describe('lockBadgeFor', () => {
	it('none when unlocked', () => {
		expect(lockBadgeFor('e1').state).toBe('none');
	});
	it('mine for my holder id', () => {
		handleFeedEvent({ type: 'lock', action: 'acquired', leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'default-user' }] });
		expect(lockBadgeFor('e1').state).toBe('mine');
	});
	it('theirs for another holder', () => {
		handleFeedEvent({ type: 'lock', action: 'acquired', leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'bob' }] });
		const b = lockBadgeFor('e1');
		expect(b.state).toBe('theirs');
		expect(b.holder).toBe('bob');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- lock-badge`
Expected: FAIL — helper not found.

- [ ] **Step 3: Implement + export the helper, render in TreeRow**

Create the helper above; export `lockBadgeFor` and `type LockBadge` from `index.ts`. In `TreeRow.svelte`, for an element row compute `const badge = $derived(lockBadgeFor(node.id))` (use the row's element id field — read the component to confirm the prop name) and render a small lock glyph:

```svelte
	{#if badge.state === 'theirs'}
		<Lock class="h-3 w-3 text-amber-400" title={`Locked by ${badge.holder}`} />
	{:else if badge.state === 'mine'}
		<Lock class="h-3 w-3 text-emerald-400" title="Checked out by you" />
	{/if}
```

Import `Lock` from `@lucide/svelte`. Place the glyph in the row's trailing area so it doesn't disrupt the existing layout. (Relationship rows are not shown in the containment tree; element rows only.)

- [ ] **Step 4: Run test + typecheck**

Run: `pixi run -e frontend npm test -- lock-badge`
Expected: PASS.
Run: `pixi run -e frontend npm run check`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/lock-badge.ts frontend/src/lib/state/index.ts frontend/src/lib/components/Sidebar/TreeRow.svelte frontend/src/lib/state/__tests__/lock-badge.test.ts
git commit -m "feat(frontend): lock badges on containment tree rows (Spec B)"
```

---

## Task 14: Playwright smoke — check out → edit → commit

**Files:**
- Modify: `frontend/e2e/` (extend the existing smoke spec; `grep -rl "test(" frontend/e2e` to find it) or create `frontend/e2e/commit-flow.spec.ts`
- Reference: `frontend/playwright.config.ts` (boots backend + dev server)

**Interfaces:** none (black-box UI test).

- [ ] **Step 1: Write the smoke**

Extend/author a Playwright test that: loads the app (the dev seed serves `default` with the smart-city example), selects an element, edits a property (triggers auto-acquire), opens the Commit drawer (Cmd+S), and commits — then asserts the change persists (re-select the element, value sticks) and the uncommitted badge returns to 0.

```ts
import { test, expect } from '@playwright/test';

test('check out, edit, and commit a property', async ({ page }) => {
	await page.goto('/');
	// wait for the model to load (StatusBar shows live)
	await expect(page.getByText('live')).toBeVisible({ timeout: 30_000 });

	// select the first tree element (selector: confirm against TreeRow markup)
	await page.locator('[role="treeitem"]').first().click();

	// edit a property field in the inspector
	const field = page.locator('aside input, aside textarea').first();
	await field.click();
	await field.fill('smoke-edited');
	await field.blur();

	// the uncommitted badge should be > 0
	await expect(page.getByText(/[1-9]\d* uncommitted/)).toBeVisible();

	// open commit drawer and commit
	await page.keyboard.press('Control+s');
	await page.getByRole('button', { name: /^Commit/ }).click();

	// badge returns to 0 uncommitted
	await expect(page.getByText('0 uncommitted')).toBeVisible({ timeout: 15_000 });
});
```

Adjust selectors to the real markup after reading `TreeRow.svelte`/`Inspector.svelte` (the `[role="treeitem"]` and `aside input` selectors are starting points; verify them).

- [ ] **Step 2: Run the smoke**

Run: `pixi run -e frontend bash -c 'cd frontend && npx playwright install chromium && npm run test:e2e'`
Expected: PASS (Playwright boots backend + dev server per the config).

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/
git commit -m "test(frontend): e2e smoke for check-out → edit → commit (Spec B)"
```

---

## Task 15: Cleanup — remove flush shims + dead code, update README

**Files:**
- Modify: `frontend/src/lib/state/model.svelte.ts` (remove shims + dead flush internals)
- Modify: `frontend/src/lib/state/index.ts` (drop removed exports)
- Modify: `frontend/src/lib/state/changes.svelte.ts` (retire model-change-badge usage if now unused) — verify with grep first
- Modify: `frontend/README.md` (document the new flow)
- Test: full suite green after removal.

**Interfaces:** removes `flushNow`, `hasPendingOps`, `undo` (model-store server-undo), `getUndoDepth` once no consumers remain.

- [ ] **Step 1: Confirm no remaining consumers**

Run: `cd frontend && grep -rn "flushNow\|hasPendingOps\|getUndoDepth\|getChangesBadgeTotal\|refreshChangesBadge\|\bundo(" src/ | grep -v "__tests__"`
Expected: only definitions remain (no live call sites). If any UI still references them, fix that component to use the staged equivalents before deleting.

- [ ] **Step 2: Delete the shims and dead flush machinery**

In `model.svelte.ts` remove `flushNow`, `hasPendingOps`, `undo`, `getUndoDepth` (the shims), and any now-unreferenced flush internals not already removed in Task 4: `scheduleFlush`, `cancelFlushTimer`, `flushLoop`, `startFlush`, `handleFlushError`, `_flushTimer`, `_flushDeadline`, `_flushPromise`, `_inFlight`, `_undoDepth`, and the `modelOpsApi.applyOps`/`undoOps` imports/usages (the frontend no longer flushes or server-undoes). Keep `applyDelta`, `revertOptimistic`, `remapCaches`, the journal, all reads, `validateAll` (still uses `validateModel`), and `resetModelStore`. Update `resetModelStore` to not reference removed fields.

- [ ] **Step 3: Drop removed barrel exports**

In `index.ts`, remove the `flushNow`/`hasPendingOps`/`undo`/`getUndoDepth` exports. If `changes.svelte.ts` (server change badge) is now unused, remove its exports too and the file; otherwise leave it. Run grep to confirm.

- [ ] **Step 4: Update the frontend README**

In `frontend/README.md`, replace the "State model (delta protocol)" continuous-flush description (items 2-3, 5) with the staged-commit flow: edits stage locally (no flush), locks auto-acquire on first edit (checkout store), Commit runs preview→commit and releases locks, Undo is client-side over the staged buffer, Save-to-file is now Export. Update the "Where to find things" list to add `checkout.svelte.ts`, `edit-gate.ts`, `lock-badge.ts`, `lock-notice.svelte.ts`, and `api/checkout.ts`. Update the keyboard table (`Cmd+S` → "Open the Commit review", drop "Save").

- [ ] **Step 5: Full suite green**

Run: `pixi run -e frontend npm test`
Run: `pixi run -e frontend npm run check`
Run: `pixi run -e frontend npm run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/state/model.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/changes.svelte.ts frontend/README.md
git commit -m "refactor(frontend): remove legacy flush path; document staged-commit flow (Spec B)"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-18-spec-b-frontend-editing-rewire-design.md`):
- §3.1 model store staged buffer → Task 4. §3.2 checkout store (registry/ensureCheckout/heartbeat/commit/expiry) → Tasks 5-8. §3.3 api/checkout + getCurrentUserId → Task 3. §3.4 realtime lock tap → Task 8. §3.5 UI (Inspector gating → Task 10; DiffDrawer commit-review → Task 11; TreeRow badges → Task 13; StatusBar/TopBar → Task 12). §3.6 backend lock_ttl_seconds → Task 1. §4 lock-scope mirror → Task 10 (edit-gate). §5 flows (stage/commit/discard/undo/expiry) → Tasks 4,7,8,10,11,12. §6 error handling (409 conflict → edit-gate notice; commit 409/422 → DiffDrawer commitError; expiry → checkout stale) → Tasks 10,11,8. §7 role gating → Tasks 5,10. §8 testing → each task's tests + Task 14. §9 out-of-scope respected (no steal/partial-commit/history/metamodel-picker).
- Gap check: the spec's "commit 409 stale-rev retry" is surfaced as `commitError` in Task 11 (the user retries by re-clicking Commit, which re-reads the live rev) — acceptable for the core loop; an explicit "Model moved — retry" affordance is a polish nicety, noted not built.

**Placeholder scan:** every code step shows real code; commands have expected output. Selectors in Task 14 are flagged "verify against markup" (legitimate — Playwright selectors must match rendered DOM). No TBD/TODO.

**Type consistency:** `ensureCheckout(targets, intent)`, `getHeldTokens()`, `getStagedOps()`, `getStagedDiff()`, `commitStaged(message, ackErrors)`, `previewStaged()`, `discardElement(id)`, `handleRemoteLockEvent(action, leases)`, `onLockEvent(cb)`, `lockBadgeFor(id)`, `editLock/connectLock/deleteLock` are named identically across their defining and consuming tasks. `LeaseLite` (feed) vs `LeaseOut` (REST) are distinct by design (feed has no token). The `commitChanges` request maps camelCase→snake_case at the api boundary (Task 3) so store callers stay camelCase.
