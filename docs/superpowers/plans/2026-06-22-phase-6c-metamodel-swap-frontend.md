# Phase 6C — Metamodel-Swap Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a member upload a candidate metamodel, view the sandbox conformance diff, and (as owner) adopt it via a non-destructive rebind — wiring the deferred frontend half of Phase 6B plus two small backend follow-ups.

**Architecture:** A `SwapMetamodelDrawer` launched from the TopBar drives a `pick → diff → review → rebind` flow against the existing `POST /metamodel/diff` (any member, read-only) and `POST /metamodel/rebind` (owner-only) endpoints. The realtime feed gains a `rebind` event that raises a manual reload banner on peers. Two backend routes stop returning a bare 500 when the post-commit snapshot write fails (the commit already landed; hydration recovers).

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, zod, `@tanstack/svelte-query`, vitest + happy-dom + MSW (frontend); FastAPI, pytest + in-memory SQLite (backend). Everything runs through **pixi**.

## Global Constraints

- No global `python`/`node`: every command goes through `pixi run` (envs: `core-dev` for backend lint/test, `frontend` for the UI).
- Frontend lint/typecheck must pass: `pixi run -e frontend npm run check` (svelte-check) and `pixi run -e frontend npm run lint`.
- Backend must pass ruff + mypy + pyright (`pixi run lint-backend`) and pytest (`pixi run -e core-dev pytest`). Python check floor is 3.10 — import `Self`/`assert_never` from `typing_extensions`, not `typing`.
- Frontend API client convention: a `string` body is sent as-is with `Content-Type: application/x-yaml` and NOT JS-parsed; `apiFetch` accepts a native `query` option for query params.
- Frontend `Issue` type is `{ severity: 'error' | 'warning'; message: string; target_ids: string[] }`; `IssueOut` is `{ severity: string; message: string; target_ids: string[]; category: string }`. The diff/rebind endpoints return `IssueOut` shape.
- Run a single frontend test file with: `pixi run -e frontend bash -c 'cd frontend && npx vitest run <path>'`.
- Run a single backend test with: `pixi run -e core-dev pytest <path>::<test> -v`.
- Commit after each task (frequent commits).

---

### Task 1: API client — `diffMetamodel` + `rebindMetamodel` + schemas

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (add `MetamodelDiffSchema`, `RebindSchema` near `IssueOutSchema`, line ~243)
- Modify: `frontend/src/lib/api/metamodel.ts` (add two functions)
- Test: `frontend/src/lib/api/__tests__/metamodel.test.ts` (extend)

**Interfaces:**
- Consumes: `apiFetch(path, init, cfg)` with `init.query`, `init.schema`; existing `IssueOutSchema` from `types.ts`.
- Produces:
  - `MetamodelDiff = { now_failing: IssueOut[]; now_passing: IssueOut[]; unchanged_count: number; current_error_count: number; candidate_error_count: number }`
  - `Rebind = { model_rev: number; metamodel_id: string; validation_error_count: number; issue_counts: Record<string,number>; issues: IssueOut[] }`
  - `diffMetamodel(body: string, cfg?: ClientConfig): Promise<MetamodelDiff>`
  - `rebindMetamodel(body: string, opts: { baseRev: number; message: string }, cfg?: ClientConfig): Promise<Rebind>`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/api/__tests__/metamodel.test.ts` (add `diffMetamodel, rebindMetamodel` to the import on line 4):

```ts
const diffPayload = {
	now_failing: [{ severity: 'error', message: 'x is an instance of unknown type', target_ids: ['x'], category: 'conformance' }],
	now_passing: [],
	unchanged_count: 3,
	current_error_count: 3,
	candidate_error_count: 4
};

const rebindPayload = {
	model_rev: 8,
	metamodel_id: 'mm-2',
	validation_error_count: 1,
	issue_counts: { conformance: 1 },
	issues: [{ severity: 'error', message: 'x is an instance of unknown type', target_ids: ['x'], category: 'conformance' }]
};

describe('metamodel swap client', () => {
	it('diffMetamodel posts the blob as YAML and parses the diff', async () => {
		let ct: string | null = null;
		let text = '';
		server.use(
			http.post(`${BASE}/metamodel/diff`, async ({ request }) => {
				ct = request.headers.get('content-type');
				text = await request.text();
				return HttpResponse.json(diffPayload);
			})
		);
		const result = await diffMetamodel('elements: []\n', cfg);
		expect(ct).toContain('yaml');
		expect(text).toBe('elements: []\n');
		expect(result.now_failing[0].target_ids).toEqual(['x']);
		expect(result.unchanged_count).toBe(3);
		expect(result.candidate_error_count).toBe(4);
	});

	it('rebindMetamodel sends base_rev + message as query params', async () => {
		let url: URL | null = null;
		let text = '';
		server.use(
			http.post(`${BASE}/metamodel/rebind`, async ({ request }) => {
				url = new URL(request.url);
				text = await request.text();
				return HttpResponse.json(rebindPayload);
			})
		);
		const result = await rebindMetamodel('elements: []\n', { baseRev: 7, message: 'swap' }, cfg);
		expect(url!.searchParams.get('base_rev')).toBe('7');
		expect(url!.searchParams.get('message')).toBe('swap');
		expect(text).toBe('elements: []\n');
		expect(result.model_rev).toBe(8);
		expect(result.metamodel_id).toBe('mm-2');
		expect(result.issues[0].category).toBe('conformance');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/metamodel.test.ts'`
Expected: FAIL — `diffMetamodel`/`rebindMetamodel` not exported.

- [ ] **Step 3: Add the schemas to `types.ts`**

Insert after `IssueOutSchema`/`IssueOut` (line ~243):

```ts
export const MetamodelDiffSchema = z.object({
	now_failing: z.array(IssueOutSchema).default([]),
	now_passing: z.array(IssueOutSchema).default([]),
	unchanged_count: z.number().int(),
	current_error_count: z.number().int(),
	candidate_error_count: z.number().int()
});
export type MetamodelDiff = z.infer<typeof MetamodelDiffSchema>;

export const RebindSchema = z.object({
	model_rev: z.number().int(),
	metamodel_id: z.string(),
	validation_error_count: z.number().int(),
	issue_counts: z.record(z.string(), z.number()).default({}),
	issues: z.array(IssueOutSchema).default([])
});
export type Rebind = z.infer<typeof RebindSchema>;
```

- [ ] **Step 4: Add the client functions to `metamodel.ts`**

Update the import on line 2 and append the functions:

```ts
import { apiFetch, type ApiFetchInit, type ClientConfig } from './client';
import {
	MetamodelSchema,
	MetamodelDiffSchema,
	RebindSchema,
	type Metamodel,
	type MetamodelDiff,
	type Rebind
} from './types';

// ... existing getMetamodel / uploadMetamodel / clearMetamodel unchanged ...

/**
 * Run the read-only sandbox conformance diff (Phase 6B). Validates the live
 * model against a CANDIDATE metamodel without mutating anything. Any member.
 * The blob is sent as raw YAML (no JS-side parse), mirroring uploadMetamodel.
 */
export function diffMetamodel(body: string, cfg?: ClientConfig): Promise<MetamodelDiff> {
	const init: ApiFetchInit = {
		method: 'POST',
		body,
		schema: MetamodelDiffSchema,
		headers: { 'Content-Type': 'application/x-yaml' }
	};
	return apiFetch('/metamodel/diff', init, cfg);
}

/**
 * Adopt a candidate metamodel via a non-destructive journaled rebind (owner
 * only). `baseRev`/`message` ride query params; the raw body is the blob.
 */
export function rebindMetamodel(
	body: string,
	opts: { baseRev: number; message: string },
	cfg?: ClientConfig
): Promise<Rebind> {
	const init: ApiFetchInit = {
		method: 'POST',
		body,
		schema: RebindSchema,
		headers: { 'Content-Type': 'application/x-yaml' },
		query: { base_rev: opts.baseRev, message: opts.message }
	};
	return apiFetch('/metamodel/rebind', init, cfg);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/metamodel.test.ts'`
Expected: PASS (all tests, old + new).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/metamodel.ts frontend/src/lib/api/__tests__/metamodel.test.ts
git commit -m "feat(frontend): add diffMetamodel + rebindMetamodel API client"
```

---

### Task 2: Feed `rebind` event + realtime pending-reload state

**Files:**
- Modify: `frontend/src/lib/api/feed.ts:14-29` (extend `FeedEvent` union)
- Modify: `frontend/src/lib/state/realtime.svelte.ts` (handle `rebind`, add `_pendingRebind`)
- Test: `frontend/src/lib/state/__tests__/realtime.test.ts` (extend)

**Interfaces:**
- Consumes: `handleFeedEvent(e: FeedEvent)`, the existing `FeedEvent` union.
- Produces:
  - `FeedEvent` gains `{ type: 'rebind'; rev: number; from_metamodel_id: string | null; to_metamodel_id: string; validation_error_count: number }`
  - `getPendingRebind(): { rev: number; count: number } | null`
  - `clearPendingRebind(): void`
  - `resetRealtime()` clears pending state too.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/state/__tests__/realtime.test.ts` (import `getPendingRebind, clearPendingRebind` from `../realtime.svelte`):

```ts
describe('rebind event', () => {
	afterEach(() => resetRealtime());

	it('a rebind event sets pending reload state', () => {
		expect(getPendingRebind()).toBeNull();
		handleFeedEvent({
			type: 'rebind',
			rev: 12,
			from_metamodel_id: 'mm-1',
			to_metamodel_id: 'mm-2',
			validation_error_count: 4
		});
		expect(getPendingRebind()).toEqual({ rev: 12, count: 4 });
	});

	it('clearPendingRebind resets it', () => {
		handleFeedEvent({
			type: 'rebind',
			rev: 12,
			from_metamodel_id: null,
			to_metamodel_id: 'mm-2',
			validation_error_count: 0
		});
		clearPendingRebind();
		expect(getPendingRebind()).toBeNull();
	});
});
```

Check the top of `realtime.test.ts` for the existing imports of `handleFeedEvent`/`resetRealtime`/`afterEach`; add the two new named imports to that existing import line rather than duplicating.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/realtime.test.ts'`
Expected: FAIL — `getPendingRebind` not exported / `rebind` not in union.

- [ ] **Step 3: Extend the `FeedEvent` union**

In `frontend/src/lib/api/feed.ts`, add a member to the union (after the `presence` line, before the closing `;`):

```ts
	| { type: 'presence'; action: 'join' | 'leave'; user_id: string; connected: string[] }
	| {
			type: 'rebind';
			rev: number;
			from_metamodel_id: string | null;
			to_metamodel_id: string;
			validation_error_count: number;
	  };
```

- [ ] **Step 4: Handle `rebind` in the realtime store**

In `frontend/src/lib/state/realtime.svelte.ts`, add state near the other `let _…` declarations (line ~24):

```ts
let _pendingRebind = $state<{ rev: number; count: number } | null>(null);
```

Add accessors near the other getters:

```ts
export function getPendingRebind(): { rev: number; count: number } | null {
	return _pendingRebind;
}

export function clearPendingRebind(): void {
	_pendingRebind = null;
}
```

Add a `case` in `handleFeedEvent`'s `switch` (after the `commit` case):

```ts
		case 'rebind':
			_pendingRebind = { rev: e.rev, count: e.validation_error_count };
			break;
```

Add to `resetRealtime()` (after `_lockTaps.clear();`):

```ts
	_pendingRebind = null;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/realtime.test.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/feed.ts frontend/src/lib/state/realtime.svelte.ts frontend/src/lib/state/__tests__/realtime.test.ts
git commit -m "feat(frontend): handle rebind feed event + pending-reload state"
```

---

### Task 3: `SwapMetamodelDrawer` — read path (pick → diff review)

**Files:**
- Create: `frontend/src/lib/components/SwapMetamodelDrawer.svelte`
- Create: `frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts`

**Interfaces:**
- Consumes: `diffMetamodel` (Task 1); `MetamodelDiff`, `IssueOut` (Task 1); `getRole` from `$lib/state` (re-exported from `checkout.svelte`).
- Produces: `<SwapMetamodelDrawer bind:open />` — a dialog that, on file pick, calls `diffMetamodel` and renders the counts headline + two capped (200) issue sections. Owner-gated rebind affordance is a stub placeholder this task; Task 4 fills it.

Confirm `getRole` is exported from `$lib/state` (it lives in `checkout.svelte.ts`); if it is not re-exported there, import it from `$lib/state/checkout.svelte` instead. Confirm the dialog primitive path (`$lib/components/ui/dialog`) by checking how `LoadFilesDialog.svelte` imports it, and mirror that.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import SwapMetamodelDrawer from '../SwapMetamodelDrawer.svelte';

// Mock the API client so no network is needed.
vi.mock('$lib/api/metamodel', () => ({
	diffMetamodel: vi.fn(),
	rebindMetamodel: vi.fn()
}));
import { diffMetamodel } from '$lib/api/metamodel';

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function file(text: string, name = 'cand.metamodel.yaml'): File {
	return new File([text], name, { type: 'application/x-yaml' });
}

describe('SwapMetamodelDrawer read path', () => {
	it('runs the diff on file pick and shows the counts headline', async () => {
		(diffMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			now_failing: [
				{ severity: 'error', message: 'a unknown type', target_ids: ['a'], category: 'conformance' }
			],
			now_passing: [],
			unchanged_count: 5,
			current_error_count: 5,
			candidate_error_count: 6
		});
		render(SwapMetamodelDrawer, { open: true });
		const input = screen.getByLabelText(/candidate metamodel/i) as HTMLInputElement;
		await fireEvent.change(input, { target: { files: [file('elements: []\n')] } });
		expect(diffMetamodel).toHaveBeenCalledWith('elements: []\n');
		expect(await screen.findByText(/1 now failing/i)).toBeTruthy();
		expect(screen.getByText(/0 now passing/i)).toBeTruthy();
		expect(screen.getByText(/5 unchanged/i)).toBeTruthy();
	});

	it('caps each issue section at 200 with an "and N more" footer', async () => {
		const many = Array.from({ length: 250 }, (_, i) => ({
			severity: 'error',
			message: `issue ${i}`,
			target_ids: [`e${i}`],
			category: 'conformance'
		}));
		(diffMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			now_failing: many,
			now_passing: [],
			unchanged_count: 0,
			current_error_count: 0,
			candidate_error_count: 250
		});
		render(SwapMetamodelDrawer, { open: true });
		const input = screen.getByLabelText(/candidate metamodel/i) as HTMLInputElement;
		await fireEvent.change(input, { target: { files: [file('elements: []\n')] } });
		expect(await screen.findByText(/and 50 more/i)).toBeTruthy();
	});

	it('surfaces a parse error when the diff call rejects', async () => {
		(diffMetamodel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bad yaml'));
		render(SwapMetamodelDrawer, { open: true });
		const input = screen.getByLabelText(/candidate metamodel/i) as HTMLInputElement;
		await fireEvent.change(input, { target: { files: [file('nope')] } });
		expect(await screen.findByText(/couldn.t read the candidate/i)).toBeTruthy();
	});
});
```

If `@testing-library/svelte` import differs from the repo convention, check an existing component test (e.g. `frontend/src/lib/components/__tests__/`) and match its render/query imports exactly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/SwapMetamodelDrawer.test.ts'`
Expected: FAIL — component file does not exist.

- [ ] **Step 3: Create the drawer (read path)**

Create `frontend/src/lib/components/SwapMetamodelDrawer.svelte`. Mirror `LoadFilesDialog.svelte`'s dialog import; the markup below uses the same `$lib/components/ui/dialog` primitives — adjust names if the repo's API differs.

```svelte
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { diffMetamodel } from '$lib/api/metamodel';
	import type { MetamodelDiff } from '$lib/api/types';
	import type { IssueOut } from '$lib/api/types';
	import { AlertCircle, AlertTriangle } from '@lucide/svelte';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

	const CAP = 200;

	type Step = 'pick' | 'diffing' | 'review' | 'error';
	let step = $state<Step>('pick');
	let errorMsg = $state<string | null>(null);
	let blob = $state<string | null>(null);
	let candidateName = $state<string | null>(null);
	let diff = $state<MetamodelDiff | null>(null);

	function reset(): void {
		step = 'pick';
		errorMsg = null;
		blob = null;
		candidateName = null;
		diff = null;
	}

	async function onPick(ev: Event): Promise<void> {
		const input = ev.currentTarget as HTMLInputElement;
		const f = input.files?.[0];
		if (!f) return;
		candidateName = f.name;
		step = 'diffing';
		errorMsg = null;
		try {
			const text = await f.text();
			blob = text;
			diff = await diffMetamodel(text);
			step = 'review';
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
			step = 'error';
			errorMsg = `Couldn't read the candidate or run the diff: ${errorMsg}`;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (!o) reset(); }}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Swap metamodel</Dialog.Title>
		</Dialog.Header>

		<div class="flex flex-col gap-3 text-sm">
			<label class="flex flex-col gap-1">
				<span class="text-xs text-zinc-400">Candidate metamodel</span>
				<input
					type="file"
					accept=".yaml,.yml,.json"
					class="text-xs"
					onchange={onPick}
				/>
			</label>

			{#if step === 'diffing'}
				<p class="text-zinc-400">Running diff…</p>
			{/if}

			{#if step === 'error' && errorMsg}
				<p class="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-red-200">
					{errorMsg}
				</p>
			{/if}

			{#if step === 'review' && diff}
				<div class="flex flex-wrap items-center gap-3 text-xs">
					<span class="text-red-300">{diff.now_failing.length} now failing</span>
					<span class="text-emerald-300">{diff.now_passing.length} now passing</span>
					<span class="text-zinc-400">{diff.unchanged_count} unchanged</span>
					<span class="text-zinc-500">
						errors {diff.current_error_count} → {diff.candidate_error_count}
					</span>
				</div>

				{@render section('Now failing', diff.now_failing, 'fail')}
				{@render section('Now passing', diff.now_passing, 'pass')}

				<!-- REBIND-SLOT: Task 4 inserts the rebind affordance here. -->
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="ghost" size="sm" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#snippet section(title: string, issues: IssueOut[], kind: 'fail' | 'pass')}
	{#if issues.length > 0}
		<section class="flex flex-col gap-1">
			<h3 class="text-[10px] font-semibold uppercase tracking-wider {kind === 'fail' ? 'text-red-300' : 'text-emerald-300'}">
				{title} ({issues.length})
			</h3>
			<ul class="flex max-h-48 flex-col gap-1 overflow-auto">
				{#each issues.slice(0, CAP) as it (it.message + it.target_ids.join(','))}
					<li class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 text-xs">
						<div class="flex items-start gap-1.5">
							{#if it.severity === 'error'}
								<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
							{:else}
								<AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
							{/if}
							<span class="flex-1 text-zinc-200">{it.message}</span>
						</div>
						{#if it.target_ids.length > 0}
							<div class="flex flex-wrap gap-1 pl-5">
								{#each it.target_ids as tid (tid)}
									<span class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300" title={tid}>
										{tid}
									</span>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
			{#if issues.length > CAP}
				<p class="text-[10px] text-zinc-500">…and {issues.length - CAP} more</p>
			{/if}
		</section>
	{/if}
{/snippet}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/SwapMetamodelDrawer.test.ts'`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pixi run -e frontend npm run check`
Expected: no new svelte-check errors in `SwapMetamodelDrawer.svelte`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/SwapMetamodelDrawer.svelte frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts
git commit -m "feat(frontend): SwapMetamodelDrawer diff-review read path"
```

---

### Task 4: `SwapMetamodelDrawer` — rebind write path (gating, confirm, refresh)

**Files:**
- Modify: `frontend/src/lib/components/SwapMetamodelDrawer.svelte` (replace the `REBIND-SLOT` comment + extend `<script>`)
- Modify: `frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts` (add the write-path describe block)

**Interfaces:**
- Consumes: `rebindMetamodel` (Task 1); `getRole`, `getModelRev`, `getStagedDepth`, `setIssues`, `setMetamodelFilename`, `refreshSummary` from `$lib/state`; `getLockState` from `$lib/state/realtime.svelte`; `getMetamodel as fetchMetamodel` from `$lib/api/metamodel`; `setMetamodel` from `$lib/state`.
- Produces: the drawer's owner-only rebind button + quiet-project gating + success refresh sequence + error branches. No new exports.

Before writing, confirm these exact exports exist in `$lib/state` (grep `frontend/src/lib/state/index.ts`): `getRole`, `getModelRev`, `getStagedDepth`, `setIssues`, `setMetamodelFilename`, `refreshSummary`, `setMetamodel`. If any is missing from the barrel, import it from its defining module (e.g. `getRole`/`getStagedDepth` from `$lib/state/checkout.svelte` or `model.svelte`, `getLockState` from `$lib/state/realtime.svelte`). `refreshSummary` may be async — `await` it.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts`. Extend the top mock so the realtime + state modules are controllable:

```ts
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getRole: vi.fn(() => 'owner'),
		getModelRev: vi.fn(() => 7),
		getStagedDepth: vi.fn(() => 0),
		setIssues: vi.fn(),
		setMetamodel: vi.fn(),
		setMetamodelFilename: vi.fn(),
		refreshSummary: vi.fn(async () => {})
	};
});
vi.mock('$lib/state/realtime.svelte', () => ({ getLockState: vi.fn(() => new Map()) }));

import { rebindMetamodel, getMetamodel as fetchMetamodel } from '$lib/api/metamodel';
import { getRole, getStagedDepth, setIssues, refreshSummary } from '$lib/state';
import { getLockState } from '$lib/state/realtime.svelte';
```

Add `getMetamodel` to the `$lib/api/metamodel` mock factory at the top of the file:

```ts
vi.mock('$lib/api/metamodel', () => ({
	diffMetamodel: vi.fn(),
	rebindMetamodel: vi.fn(),
	getMetamodel: vi.fn()
}));
```

Then the describe block (helper `pickAndDiff` factors out reaching the review step):

```ts
describe('SwapMetamodelDrawer rebind path', () => {
	async function pickAndDiff() {
		(diffMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			now_failing: [], now_passing: [], unchanged_count: 2,
			current_error_count: 2, candidate_error_count: 2
		});
		render(SwapMetamodelDrawer, { open: true });
		const input = screen.getByLabelText(/candidate metamodel/i) as HTMLInputElement;
		await fireEvent.change(input, { target: { files: [file('elements: []\n')] } });
		await screen.findByText(/2 unchanged/i);
	}

	it('hides the rebind button for non-owners', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('editor');
		await pickAndDiff();
		expect(screen.queryByRole('button', { name: /^rebind/i })).toBeNull();
		expect(screen.getByText(/read-only for your role/i)).toBeTruthy();
	});

	it('blocks rebind when staged edits exist (quiet-project)', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		(getStagedDepth as ReturnType<typeof vi.fn>).mockReturnValue(3);
		await pickAndDiff();
		expect(screen.getByText(/needs a quiet project/i)).toBeTruthy();
		expect((screen.getByRole('button', { name: /^rebind/i }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('blocks rebind when a lease is live', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		(getStagedDepth as ReturnType<typeof vi.fn>).mockReturnValue(0);
		(getLockState as ReturnType<typeof vi.fn>).mockReturnValue(new Map([['e1', {}]]));
		await pickAndDiff();
		expect((screen.getByRole('button', { name: /^rebind/i }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('on success refreshes metamodel, issues, summary and closes', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		(getStagedDepth as ReturnType<typeof vi.fn>).mockReturnValue(0);
		(getLockState as ReturnType<typeof vi.fn>).mockReturnValue(new Map());
		(rebindMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			model_rev: 8, metamodel_id: 'mm-2', validation_error_count: 1,
			issue_counts: { conformance: 1 },
			issues: [{ severity: 'error', message: 'x unknown', target_ids: ['x'], category: 'conformance' }]
		});
		(fetchMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({ elements: [], relationships: [] });
		await pickAndDiff();
		await fireEvent.click(screen.getByRole('button', { name: /^rebind/i }));
		await vi.waitFor(() => expect(rebindMetamodel).toHaveBeenCalledWith('elements: []\n', { baseRev: 7, message: '' }));
		expect(fetchMetamodel).toHaveBeenCalled();
		expect(setIssues).toHaveBeenCalled();
		expect(refreshSummary).toHaveBeenCalled();
	});

	it('shows a stale-rev message on 409 base_rev', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		(getStagedDepth as ReturnType<typeof vi.fn>).mockReturnValue(0);
		(getLockState as ReturnType<typeof vi.fn>).mockReturnValue(new Map());
		const err = Object.assign(new Error('stale'), { status: 409, body: { detail: 'stale base_rev' } });
		(rebindMetamodel as ReturnType<typeof vi.fn>).mockRejectedValue(err);
		await pickAndDiff();
		await fireEvent.click(screen.getByRole('button', { name: /^rebind/i }));
		expect(await screen.findByText(/re-run the diff/i)).toBeTruthy();
	});
});
```

Check how `ApiError` exposes its status/body (look at `frontend/src/lib/api/client.ts` / `errors`); match the error branch's discrimination (status code + `detail` text) to that shape. Adjust the fabricated `err` in the test and the component's `catch` to the real `ApiError` fields.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/SwapMetamodelDrawer.test.ts'`
Expected: FAIL — no rebind button / gating text.

- [ ] **Step 3: Extend the drawer `<script>`**

Add imports and state to `SwapMetamodelDrawer.svelte`'s `<script>`:

```ts
	import { rebindMetamodel, getMetamodel as fetchMetamodel } from '$lib/api/metamodel';
	import {
		getRole,
		getModelRev,
		getStagedDepth,
		setIssues,
		setMetamodel,
		setMetamodelFilename,
		refreshSummary
	} from '$lib/state';
	import { getLockState } from '$lib/state/realtime.svelte';
	import { ApiError } from '$lib/api';
	import type { Issue } from '$lib/api/types';

	let message = $state('');
	let rebinding = $state(false);
	let rebindError = $state<string | null>(null);

	const isOwner = $derived(getRole() === 'owner');
	const quiet = $derived(getStagedDepth() === 0 && getLockState().size === 0);

	function toIssue(o: { severity: string; message: string; target_ids: string[] }): Issue {
		return {
			severity: o.severity === 'warning' ? 'warning' : 'error',
			message: o.message,
			target_ids: o.target_ids
		};
	}

	async function onRebind(): Promise<void> {
		if (!blob || !isOwner || !quiet) return;
		rebinding = true;
		rebindError = null;
		try {
			const res = await rebindMetamodel(blob, { baseRev: getModelRev(), message });
			const mm = await fetchMetamodel();
			setMetamodel(mm);
			if (candidateName) setMetamodelFilename(candidateName);
			setIssues(res.issues.map(toIssue));
			await refreshSummary();
			open = false;
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				const detail = typeof e.body === 'object' && e.body && 'detail' in e.body ? String((e.body as { detail: unknown }).detail) : '';
				rebindError = detail.includes('lock')
					? 'The project is not quiet (a lock is active). Try again once edits are committed.'
					: 'The model changed since you ran the diff — re-run the diff and try again.';
			} else if (e instanceof ApiError && e.status === 422) {
				rebindError = 'The candidate metamodel is invalid.';
			} else {
				rebindError = 'Rebind failed; no changes were applied.';
			}
		} finally {
			rebinding = false;
		}
	}
```

Confirm `ApiError`'s real field names (`status`, `body`) against `$lib/api` and adjust if they differ (e.g. `statusCode`/`payload`).

- [ ] **Step 4: Replace the `REBIND-SLOT` markup**

Swap the `<!-- REBIND-SLOT ... -->` comment for:

```svelte
				<div class="mt-2 flex flex-col gap-2 border-t border-zinc-800 pt-2">
					{#if !isOwner}
						<p class="text-xs text-zinc-500">The diff is read-only for your role. Only an owner can rebind.</p>
					{:else}
						{#if !quiet}
							<p class="text-xs text-amber-300">
								Commit or discard your staged edits first — rebind needs a quiet project (no active locks).
							</p>
						{/if}
						<label class="flex flex-col gap-1">
							<span class="text-xs text-zinc-400">Commit message (optional)</span>
							<input
								class="rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
								bind:value={message}
								placeholder="Adopt candidate metamodel"
							/>
						</label>
						<p class="text-[10px] text-zinc-500">
							A rebind may land with conformance issues and is journaled (revertible later).
						</p>
						{#if rebindError}
							<p class="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-xs text-red-200">{rebindError}</p>
						{/if}
						<Button
							size="sm"
							class="self-start"
							disabled={!quiet || rebinding}
							aria-busy={rebinding}
							onclick={() => void onRebind()}
						>
							{rebinding ? 'Rebinding…' : 'Rebind'}
						</Button>
					{/if}
				</div>
```

Also add `message`/`rebindError`/`rebinding` resets to `reset()`:

```ts
		message = '';
		rebindError = null;
		rebinding = false;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/SwapMetamodelDrawer.test.ts'`
Expected: PASS (read + write path).

- [ ] **Step 6: Typecheck + lint**

Run: `pixi run -e frontend npm run check && pixi run -e frontend npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/SwapMetamodelDrawer.svelte frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts
git commit -m "feat(frontend): SwapMetamodelDrawer owner rebind path + gating"
```

---

### Task 5: Wiring — TopBar entry + reload banner

**Files:**
- Modify: `frontend/src/lib/components/TopBar.svelte` (add a "Swap Metamodel" button + drawer instance)
- Modify: `frontend/src/routes/+page.svelte` (add the pending-rebind reload banner)
- Test: `frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts` is enough for the drawer; add a small banner test at `frontend/src/lib/state/__tests__/realtime.test.ts` is already covered. Add a focused TopBar render test only if the repo already tests TopBar; otherwise rely on typecheck + e2e.

**Interfaces:**
- Consumes: `SwapMetamodelDrawer` (Tasks 3–4); `getMetamodel` from `$lib/state`; `getPendingRebind`/`clearPendingRebind` (Task 2); `getMetamodel as fetchMetamodel`, `setMetamodel`, `refreshSummary`, `runValidation`.
- Produces: a user-reachable entry point + the peer reload banner.

- [ ] **Step 1: Add the TopBar entry**

In `frontend/src/lib/components/TopBar.svelte`:

Add to the imports:

```ts
	import SwapMetamodelDrawer from './SwapMetamodelDrawer.svelte';
```

Add state near `let loadOpen = $state(false);`:

```ts
	let swapOpen = $state(false);
```

Add a button in the left cluster, after the "Load Model" `<Button>` (around line 136):

```svelte
			<Button
				variant="ghost"
				size="sm"
				class="h-7 gap-1 text-xs"
				disabled={metamodel === null}
				onclick={() => (swapOpen = true)}
			>
				Swap Metamodel
			</Button>
```

Add the drawer instance near the bottom, beside `<LoadFilesDialog .../>`:

```svelte
<SwapMetamodelDrawer bind:open={swapOpen} />
```

- [ ] **Step 2: Add the reload banner to `+page.svelte`**

Read `frontend/src/routes/+page.svelte` first to find the grid root. Add imports:

```ts
	import { getPendingRebind, clearPendingRebind } from '$lib/state/realtime.svelte';
	import { getMetamodel as fetchMetamodel } from '$lib/api/metamodel';
	import { setMetamodel, refreshSummary } from '$lib/state';
	import { runValidation } from '$lib/state/validate-action';
```

Add a derived + handler in the `<script>`:

```ts
	const pendingRebind = $derived(getPendingRebind());

	async function onReloadRebind(): Promise<void> {
		const mm = await fetchMetamodel();
		setMetamodel(mm);
		await refreshSummary();
		await runValidation();
		clearPendingRebind();
	}
```

Add the banner near the top of the page markup (above the grid, inside the root element):

```svelte
{#if pendingRebind}
	<div class="col-span-5 flex items-center justify-between gap-3 bg-amber-950/60 px-3 py-1.5 text-xs text-amber-100">
		<span>The metamodel was changed to rev {pendingRebind.rev} ({pendingRebind.count} conformance issues). Reload to continue.</span>
		<Button size="sm" variant="ghost" class="h-6 text-xs" onclick={() => void onReloadRebind()}>Reload</Button>
	</div>
{/if}
```

Confirm `Button` is already imported in `+page.svelte`; if not, add `import { Button } from '$lib/components/ui/button';`. Match the `col-span-5` to the page's actual grid column count (check the existing grid classes; the README shows a 5-col TopBar span).

- [ ] **Step 3: Typecheck + lint**

Run: `pixi run -e frontend npm run check && pixi run -e frontend npm run lint`
Expected: clean.

- [ ] **Step 4: Run the full frontend unit suite**

Run: `pixi run -e frontend npm test`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/TopBar.svelte frontend/src/routes/+page.svelte
git commit -m "feat(frontend): wire Swap Metamodel entry + peer reload banner"
```

---

### Task 6: Backend — downgrade post-commit snapshot 500 in `commits.py`

**Files:**
- Modify: `src/data_rover/api/routes/commits.py:198-201` (wrap `_maybe_periodic_snapshot`)
- Test: `tests/api/test_commits_route.py` (add a test; reuses the module's `client` fixture + `_rev`/`_etype` helpers and `AUTH_HEADERS`/`papi` from conftest)

**Interfaces:**
- Consumes: `_maybe_periodic_snapshot(db, project_id, session, rev)` (already imported in `commits.py`).
- Produces: a commit whose durable `db.commit()` succeeded but whose periodic snapshot raised still returns 200 (no rollback), logging a warning.

Note on the test harness: in this suite `papi(path) -> str` returns just the URL path; requests go through `client.post(papi("/commits"), headers=AUTH_HEADERS, json=...)`. Mirror the existing `test_commit_creates_freefloating_without_lock` (no lock needed). `_maybe_periodic_snapshot` is called `if persisted:` — a free-floating commit persists, so monkeypatching it to raise exercises the new `except`.

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_commits_route.py`:

```python
def test_commit_survives_post_commit_snapshot_failure(
    client: TestClient, monkeypatch
) -> None:
    import data_rover.api.routes.commits as commits_mod

    def _boom(*a, **k):
        raise RuntimeError("snapshot store down")

    monkeypatch.setattr(commits_mod, "_maybe_periodic_snapshot", _boom)

    before = _rev(client)
    r = client.post(
        papi("/commits"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": before,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_n",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
            "lock_tokens": [],
            "message": "new",
        },
    )
    # the durable commit landed and rev advanced despite the snapshot failure
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == before + 1
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commits_route.py::test_commit_survives_post_commit_snapshot_failure -v`
Expected: FAIL — currently the raised error propagates as a 500.

- [ ] **Step 3: Wrap the periodic snapshot**

In `commits.py`, replace lines 198-201:

```python
        # f. periodic snapshot: mirrors apply_ops so a hot commit-only project
        #    doesn't accumulate an unbounded replay tail. The durable commit has
        #    already landed; a snapshot failure here is recoverable (hydration
        #    rebuilds the snapshot on the next cache-miss), so we log and proceed
        #    rather than returning a 500 that would mislead the client into
        #    thinking the commit failed.
        if persisted:
            try:
                _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
            except Exception:
                logger.warning(
                    "post-commit snapshot failed for project %s at rev %s; "
                    "commit is durable, hydration will rebuild",
                    project_id,
                    session.model_rev,
                    exc_info=True,
                )
```

Ensure a module logger exists at the top of `commits.py` (`import logging` + `logger = logging.getLogger(__name__)`); if one already exists, reuse it.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commits_route.py::test_commit_survives_post_commit_snapshot_failure -v`
Expected: PASS.

- [ ] **Step 5: Run the commit suite + lint**

Run: `pixi run -e core-dev pytest tests/api/test_commits_route.py -q && pixi run lint-backend`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/commits.py tests/api/test_commits_route.py
git commit -m "fix(api): post-commit snapshot failure logs a warning, not a 500"
```

---

### Task 7: Backend — downgrade post-commit snapshot 500 in rebind + spec footnote

**Files:**
- Modify: `src/data_rover/api/routes/metamodel_swap.py:185` (wrap `write_snapshot`)
- Modify: `docs/superpowers/specs/2026-06-22-phase-6b-metamodel-swap-design.md` (§5 footnote)
- Test: `tests/api/test_metamodel_rebind.py` (add a test)

**Interfaces:**
- Consumes: `write_snapshot(project_id, session, rev)` (already imported in `metamodel_swap.py`).
- Produces: a rebind whose durable `db.commit()` succeeded but whose forced snapshot raised still returns 200 (no rollback), logging a warning.

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_metamodel_rebind.py`. This module already defines the `client` fixture (seeds project + uploads `_MM` + a model + one element, with owner `AUTH_HEADERS` set on the client), the `_MM_RENAMED` candidate blob, and `_rev(client)`. Mirror `test_rebind_succeeds_and_journals`:

```python
def test_rebind_survives_post_commit_snapshot_failure(
    client: TestClient, monkeypatch
) -> None:
    import data_rover.api.routes.metamodel_swap as swap_mod

    def _boom(*a, **k):
        raise RuntimeError("snapshot store down")

    monkeypatch.setattr(swap_mod, "write_snapshot", _boom)

    before = _rev(client)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={before}&message=swap",
        content=_MM_RENAMED,
        headers={"content-type": "application/x-yaml"},
    )
    # the rebind is durable and rev advanced despite the snapshot failure
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == before + 1
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_rebind.py::test_rebind_survives_post_commit_snapshot_failure -v`
Expected: FAIL — `write_snapshot` raising currently propagates as a 500.

- [ ] **Step 3: Wrap `write_snapshot` in the rebind route**

In `metamodel_swap.py`, replace line 185 (`write_snapshot(project_id, session, session.model_rev)`) with:

```python
        # The durable commit has already landed (db.commit above). Forcing a
        # snapshot here keeps the replay tail from spanning a rebind boundary,
        # but a failure is recoverable — hydration rebuilds the snapshot on the
        # next cache-miss. Log and proceed rather than raising a 500 that would
        # mislead the client into thinking the rebind failed.
        try:
            write_snapshot(project_id, session, session.model_rev)
        except Exception:
            logger.warning(
                "post-rebind snapshot failed for project %s at rev %s; "
                "rebind is durable, hydration will rebuild",
                project_id,
                session.model_rev,
                exc_info=True,
            )
```

Add `import logging` + `logger = logging.getLogger(__name__)` at the top of `metamodel_swap.py` if absent.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_rebind.py::test_rebind_survives_post_commit_snapshot_failure -v`
Expected: PASS.

- [ ] **Step 5: Add the spec footnote**

In `docs/superpowers/specs/2026-06-22-phase-6b-metamodel-swap-design.md`, find the §5 bullet beginning "**Hydration is unchanged** and correct across a rebind:" and append a footnote sentence:

```
  - **Hydration is unchanged** and correct across a rebind: it loads the metamodel from
    `ModelRow.metamodel_id` (latest) and replays the (empty-ops) rebind commit as a no-op;
    the forced snapshot means the tail never crosses a rebind boundary anyway.
    *(Footnote, Phase 6C: "unchanged" refers to hydration's replay/snapshot logic, not its
    strictness — hydration loads under `strict=False`, so it tolerates instances of unknown
    types introduced by a type-removing rebind rather than rejecting them. See Phase 6B
    Decision #2 / the unknown-type CONFORMANCE check.)*
```

- [ ] **Step 6: Run the rebind suite + lint**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_rebind.py -q && pixi run lint-backend`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/metamodel_swap.py tests/api/test_metamodel_rebind.py docs/superpowers/specs/2026-06-22-phase-6b-metamodel-swap-design.md
git commit -m "fix(api): post-rebind snapshot failure logs a warning, not a 500; footnote 6B spec"
```

---

### Task 8: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Frontend unit + typecheck + lint**

Run: `pixi run -e frontend npm test && pixi run -e frontend npm run check && pixi run -e frontend npm run lint`
Expected: all PASS/clean.

- [ ] **Step 2: Backend tests + lint**

Run: `pixi run -e core-dev pytest tests/api -q && pixi run lint-backend`
Expected: all PASS/clean.

- [ ] **Step 3: (Optional) e2e smoke**

If quick, extend or run the Playwright smoke to open the drawer and assert the diff counts render. Otherwise note it as manual follow-up.

Run: `pixi run -e frontend bash -c 'cd frontend && npx playwright install chromium && npm run test:e2e'`
Expected: PASS (or document as deferred).

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test: phase 6c full-suite verification fixups"
```
