# Stage 1 Navigation Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Frontend half of Stage 1 (spec: `docs/superpowers/specs/2026-07-05-stage-1-navigation-engine-builder-design.md`): dynamic workspace tabs, a sidebar Artifacts section, the navigation builder with paged chain preview, and view-tree artifact placement. Requires the backend plan (`2026-07-05-stage-1-navigation-backend.md`) to be implemented first — every API call below exists there.

**Architecture:** New `api/artifacts.ts` + `state/artifacts.svelte.ts` following the accessor-function store convention; `workspace.svelte.ts` generalizes from a 3-literal union to built-ins + dynamic closable tabs with per-project localStorage persistence; the builder reuses `StereotypePicker`/`CriterionRow`/`connection-rules.ts`; the view tree gains an `'artifact'` node kind fed by the extended `Folder.artifacts` field.

**Tech Stack:** SvelteKit (SPA), Svelte 5 runes, TypeScript, zod, bits-ui, Tailwind, vitest + happy-dom + MSW, Playwright.

## Global Constraints

- Read `frontend/README.md` before touching `frontend/src/lib/state/` (repo instruction).
- All frontend commands run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'` (vitest), `... npm run check` (svelte-check), `... npm run test:e2e` (Playwright). The bare `pixi run -e frontend npm test` FAILS (wrong cwd).
- Store convention: private `let _x = $state(...)` + exported `getX()/setX()`; never export a rune. Re-export every new public accessor from `src/lib/state/index.ts`. Every new store gets a `resetX()` for tests/reload.
- API convention: one module per resource in `src/lib/api/`, zod response schemas in `src/lib/api/types.ts`, `apiFetch(path, {method, body, schema, query})` (project-scoped base URL is ambient; CSRF header automatic).
- Vitest: `globals:false` (import from `vitest`), MSW per test file (`server.listen({onUnhandledRequest:'error'})`), reset stores in `beforeEach`.
- Backend wire contracts (from the backend plan): `GET/POST /artifacts`, `GET/PUT/DELETE /artifacts/{id}`, `POST /navigations/evaluate` → `{step_types, chains: TreeItem[][], total, truncated}`; PUT 409 body `{detail: {message, current_rev}}`; feed event `{type:'artifact', action:'created'|'updated'|'deleted', artifact: <header>}`; view folders carry `artifacts: [{id, kind}]`.
- Commit after every green task with this repo's commit trailer (Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>).

---

### Task 1: Types + `api/artifacts.ts`

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (append after `TreeItemPageSchema`, ~:340)
- Create: `frontend/src/lib/api/artifacts.ts`
- Modify: `frontend/src/lib/api/index.ts` (add `export * as artifacts from './artifacts';`)
- Test: `frontend/src/lib/api/__tests__/artifacts.test.ts`

**Interfaces:**
- Produces (types): `ArtifactHeader`, `Artifact` (header + `payload`), `ArtifactList`, `NavScope`, `NavStep`, `PathNavigation`, `NavOperand`, `SetExpression`, `NavigationDefinition`, `ChainPage` + matching zod schemas (`ArtifactHeaderSchema`, `ArtifactSchema`, `ArtifactListSchema`, `NavigationDefinitionSchema`, `ChainPageSchema`).
- Produces (api): `listArtifacts(kind?)`, `getArtifact(id)`, `createArtifact({kind, name, payload})`, `updateArtifact(id, {artifact_rev, name?, payload?})`, `deleteArtifact(id)`, `evaluateNavigation(body: {definition?, artifact_id?, limit?, offset?})`.

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/api/__tests__/artifacts.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import {
	createArtifact,
	evaluateNavigation,
	listArtifacts,
	updateArtifact
} from '../artifacts';
import { ConflictError } from '../errors';

const BASE = 'http://api.test/api/v1/projects/p1';
const CFG = { baseUrl: BASE };

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 1,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: 'u1'
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('artifacts api', () => {
	it('lists headers with a kind filter', async () => {
		server.use(
			http.get(`${BASE}/artifacts`, ({ request }) => {
				expect(new URL(request.url).searchParams.get('kind')).toBe('navigation');
				return HttpResponse.json({ items: [HEADER] });
			})
		);
		const res = await listArtifacts('navigation', CFG);
		expect(res.items[0].name).toBe('Sensors');
	});

	it('creates and returns the full artifact', async () => {
		server.use(
			http.post(`${BASE}/artifacts`, async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				expect(body.kind).toBe('navigation');
				return HttpResponse.json({ ...HEADER, payload: body.payload }, { status: 201 });
			})
		);
		const res = await createArtifact(
			{
				kind: 'navigation',
				name: 'Sensors',
				payload: { kind: 'path', start: { kind: 'scope', types: [] }, steps: [] }
			},
			CFG
		);
		expect(res.payload.kind).toBe('path');
	});

	it('surfaces a stale-rev PUT as ConflictError', async () => {
		server.use(
			http.put(`${BASE}/artifacts/a1`, () =>
				HttpResponse.json(
					{ detail: { message: 'stale', current_rev: 3 } },
					{ status: 409 }
				)
			)
		);
		await expect(
			updateArtifact('a1', { artifact_rev: 1, name: 'x' }, CFG)
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('evaluates and parses a chain page', async () => {
		server.use(
			http.post(`${BASE}/navigations/evaluate`, () =>
				HttpResponse.json({
					step_types: ['Owns'],
					chains: [
						[
							{ id: 'b1', type_name: 'Building', display_name: 'Plant', child_count: 0 },
							{ id: 's1', type_name: 'Sensor', display_name: 'T-1', child_count: 0 }
						]
					],
					total: 1,
					truncated: false
				})
			)
		);
		const page = await evaluateNavigation({ artifact_id: 'a1' }, CFG);
		expect(page.chains[0][1].display_name).toBe('T-1');
		expect(page.total).toBe(1);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- artifacts.test'`
Expected: FAIL — module `../artifacts` not found.

- [ ] **Step 3: Add types + schemas**

Append to `frontend/src/lib/api/types.ts`:

```ts
// ---------------------------------------------------------------------------
// Project artifacts (Stage 1: saved navigations; tables/diagrams later)
// ---------------------------------------------------------------------------

export const ArtifactHeaderSchema = z.object({
	id: z.string(),
	kind: z.string(),
	name: z.string(),
	artifact_rev: z.number().int(),
	updated_at: z.string(),
	updated_by: z.string().nullable().default(null)
});
export type ArtifactHeader = z.infer<typeof ArtifactHeaderSchema>;

export const ArtifactListSchema = z.object({
	items: z.array(ArtifactHeaderSchema).default([])
});
export type ArtifactList = z.infer<typeof ArtifactListSchema>;

// Navigation definition — mirrors core/navigation/schema.py. Criteria reuse
// the advanced-search criterion wire shape (lib/search/types.ts Criterion).
export type NavDirection = 'out' | 'in' | 'either';

export interface NavScope {
	kind: 'scope';
	types: string[];
	criteria: unknown[]; // search Criterion objects; typed at the editor layer
}

export interface NavStep {
	relationship_type: string;
	direction: NavDirection;
	target: NavScope;
	children: NavStep[];
}

export interface PathNavigation {
	kind: 'path';
	schema_version: number;
	start: NavScope | SetExpression;
	steps: NavStep[];
}

export interface NavOperand {
	ref?: string | null;
	definition?: NavigationDefinition | null;
	step_index?: number | null;
}

export interface SetExpression {
	kind: 'set_op';
	schema_version: number;
	op: 'union' | 'intersection' | 'difference' | 'symmetric_difference';
	operands: NavOperand[];
}

export type NavigationDefinition = PathNavigation | SetExpression;

const NavScopeSchema: z.ZodType<NavScope> = z.object({
	kind: z.literal('scope'),
	types: z.array(z.string()).default([]),
	criteria: z.array(z.unknown()).default([])
});

const NavStepSchema: z.ZodType<NavStep> = z.lazy(() =>
	z.object({
		relationship_type: z.string(),
		direction: z.enum(['out', 'in', 'either']).default('out'),
		target: NavScopeSchema.default({ kind: 'scope', types: [], criteria: [] }),
		children: z.array(NavStepSchema).default([])
	})
);

export const NavigationDefinitionSchema: z.ZodType<NavigationDefinition> = z.lazy(() =>
	z.union([
		z.object({
			kind: z.literal('path'),
			schema_version: z.number().int().default(1),
			start: z.union([NavScopeSchema, NavigationDefinitionSchema.and(z.object({ kind: z.literal('set_op') }))]),
			steps: z.array(NavStepSchema).default([])
		}) as z.ZodType<PathNavigation>,
		z.object({
			kind: z.literal('set_op'),
			schema_version: z.number().int().default(1),
			op: z.enum(['union', 'intersection', 'difference', 'symmetric_difference']),
			operands: z.array(
				z.object({
					ref: z.string().nullable().optional(),
					definition: NavigationDefinitionSchema.nullable().optional(),
					step_index: z.number().int().nullable().optional()
				})
			)
		}) as z.ZodType<SetExpression>
	])
);

export const ArtifactSchema = ArtifactHeaderSchema.extend({
	payload: z.record(z.string(), z.unknown()).default({})
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ChainPageSchema = z.object({
	step_types: z.array(z.string()).default([]),
	chains: z.array(z.array(TreeItemSchema)).default([]),
	total: z.number().int().default(0),
	truncated: z.boolean().default(false)
});
export type ChainPage = z.infer<typeof ChainPageSchema>;
```

If the `z.union`/`z.and` start-node encoding fights zod's type inference, simplify: type `start` as `z.unknown()` in the schema and keep the TS interface strict — the schema only guards transport shape; the editor constructs definitions itself. Prefer the simple variant over fighting zod.

- [ ] **Step 4: Add the api module**

`frontend/src/lib/api/artifacts.ts`:

```ts
import { apiFetch, type ClientConfig } from './client';
import {
	ArtifactListSchema,
	ArtifactSchema,
	ChainPageSchema,
	type Artifact,
	type ArtifactList,
	type ChainPage,
	type NavigationDefinition
} from './types';

export function listArtifacts(kind?: string, cfg?: ClientConfig): Promise<ArtifactList> {
	return apiFetch('/artifacts', { method: 'GET', schema: ArtifactListSchema, query: { kind } }, cfg);
}

export function getArtifact(id: string, cfg?: ClientConfig): Promise<Artifact> {
	return apiFetch(`/artifacts/${id}`, { method: 'GET', schema: ArtifactSchema }, cfg);
}

export function createArtifact(
	body: { kind: string; name: string; payload: Record<string, unknown> },
	cfg?: ClientConfig
): Promise<Artifact> {
	return apiFetch('/artifacts', { method: 'POST', body, schema: ArtifactSchema }, cfg);
}

export function updateArtifact(
	id: string,
	body: { artifact_rev: number; name?: string; payload?: Record<string, unknown> },
	cfg?: ClientConfig
): Promise<Artifact> {
	return apiFetch(`/artifacts/${id}`, { method: 'PUT', body, schema: ArtifactSchema }, cfg);
}

export function deleteArtifact(id: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch(`/artifacts/${id}`, { method: 'DELETE' }, cfg);
}

export function evaluateNavigation(
	body: {
		definition?: NavigationDefinition;
		artifact_id?: string;
		limit?: number;
		offset?: number;
	},
	cfg?: ClientConfig
): Promise<ChainPage> {
	return apiFetch(
		'/navigations/evaluate',
		{ method: 'POST', body, schema: ChainPageSchema },
		cfg
	);
}
```

Add to `frontend/src/lib/api/index.ts` (alphabetical among the `export * as` lines):

```ts
export * as artifacts from './artifacts';
```

- [ ] **Step 5: Run tests, then commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- artifacts.test'`
Expected: PASS.

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: no new svelte-check errors.

```bash
git add frontend/src/lib/api
git commit -m "feat(frontend): artifacts api client + navigation types"
```

---

### Task 2: Artifacts store + feed event

**Files:**
- Create: `frontend/src/lib/state/artifacts.svelte.ts`
- Modify: `frontend/src/lib/api/feed.ts` (FeedEvent union, :17-39)
- Modify: `frontend/src/lib/state/realtime.svelte.ts` (`handleFeedEvent`, :94-135)
- Modify: `frontend/src/lib/state/index.ts` (re-exports)
- Modify: `frontend/src/routes/p/[projectId]/+page.svelte` (boot: load artifacts)
- Test: `frontend/src/lib/state/__tests__/artifacts.test.ts`

**Interfaces:**
- Produces: `getArtifactHeaders(): ArtifactHeader[]`, `getArtifactsLoading(): boolean`, `loadArtifacts(): Promise<void>`, `createNavigationArtifact(name, payload): Promise<Artifact>`, `renameArtifact(id, name): Promise<void>`, `removeArtifact(id): Promise<void>`, `artifactHeaderById(id): ArtifactHeader | undefined`, `handleArtifactFeedEvent(): void` (refetch), `resetArtifacts(): void`.
- The store keeps ONLY headers; payloads are fetched by the editor on open (feed events carry headers, so list refresh never needs payloads).

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/state/__tests__/artifacts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '$lib/api/artifacts';
import {
	getArtifactHeaders,
	loadArtifacts,
	removeArtifact,
	renameArtifact,
	resetArtifacts
} from '../artifacts.svelte';

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 2,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: null
};

beforeEach(() => resetArtifacts());
afterEach(() => vi.restoreAllMocks());

describe('artifacts store', () => {
	it('loads headers', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		expect(getArtifactHeaders()).toEqual([HEADER]);
	});

	it('rename uses the loaded rev and refreshes', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		const update = vi
			.spyOn(api, 'updateArtifact')
			.mockResolvedValue({ ...HEADER, name: 'N2', artifact_rev: 3, payload: {} });
		await renameArtifact('a1', 'N2');
		expect(update).toHaveBeenCalledWith('a1', { artifact_rev: 2, name: 'N2' });
		expect(getArtifactHeaders()[0].name).toBe('N2');
	});

	it('remove deletes and drops the header', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		vi.spyOn(api, 'deleteArtifact').mockResolvedValue(undefined);
		await removeArtifact('a1');
		expect(getArtifactHeaders()).toEqual([]);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- state/__tests__/artifacts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

`frontend/src/lib/state/artifacts.svelte.ts`:

```ts
/**
 * Project-artifact library (Stage 1: saved navigations). Holds HEADERS only —
 * payloads are fetched by whichever editor opens the artifact. Kept fresh by
 * `artifact` feed events (peers' creates/renames/deletes) via a plain
 * refetch: the list is small and headers are cheap.
 */
import * as api from '$lib/api/artifacts';
import type { Artifact, ArtifactHeader, NavigationDefinition } from '$lib/api/types';

let _items = $state<ArtifactHeader[]>([]);
let _loading = $state(false);

export function getArtifactHeaders(): ArtifactHeader[] {
	return _items;
}
export function getArtifactsLoading(): boolean {
	return _loading;
}
export function artifactHeaderById(id: string): ArtifactHeader | undefined {
	return _items.find((a) => a.id === id);
}

export async function loadArtifacts(): Promise<void> {
	_loading = true;
	try {
		_items = (await api.listArtifacts()).items;
	} finally {
		_loading = false;
	}
}

export async function createNavigationArtifact(
	name: string,
	payload: NavigationDefinition
): Promise<Artifact> {
	const created = await api.createArtifact({
		kind: 'navigation',
		name,
		payload: payload as unknown as Record<string, unknown>
	});
	await loadArtifacts();
	return created;
}

export async function renameArtifact(id: string, name: string): Promise<void> {
	const header = artifactHeaderById(id);
	if (!header) throw new Error(`Unknown artifact ${id}`);
	await api.updateArtifact(id, { artifact_rev: header.artifact_rev, name });
	await loadArtifacts();
}

export async function removeArtifact(id: string): Promise<void> {
	await api.deleteArtifact(id);
	_items = _items.filter((a) => a.id !== id);
}

/** Feed reducer hook: an `artifact` event means the library changed somewhere. */
export function handleArtifactFeedEvent(): void {
	void loadArtifacts().catch(() => {});
}

export function resetArtifacts(): void {
	_items = [];
	_loading = false;
}
```

- [ ] **Step 4: Wire the feed event**

In `frontend/src/lib/api/feed.ts`, add to the `FeedEvent` union:

```ts
	| {
			type: 'artifact';
			action: 'created' | 'updated' | 'deleted';
			artifact: { id: string; kind: string; name: string; artifact_rev: number };
	  }
```

In `frontend/src/lib/state/realtime.svelte.ts` `handleFeedEvent` switch, add (import `handleArtifactFeedEvent` from `./artifacts.svelte`):

```ts
		case 'artifact':
			handleArtifactFeedEvent();
			break;
```

In `frontend/src/lib/state/index.ts`, re-export the new store's public surface (match the file's grouping style):

```ts
export {
	artifactHeaderById,
	createNavigationArtifact,
	getArtifactHeaders,
	getArtifactsLoading,
	loadArtifacts,
	removeArtifact,
	renameArtifact,
	resetArtifacts
} from './artifacts.svelte';
```

In `frontend/src/routes/p/[projectId]/+page.svelte` `boot()`, after `await refreshView();` add:

```ts
		await loadArtifacts().catch(() => {}); // artifact library is best-effort
```

(import `loadArtifacts` via the existing `$lib/state` import block). Also add `resetArtifacts()` alongside the other resets in the model-reload path of this page (find where `resetModelStore()` is called for reload and add it there).

- [ ] **Step 5: Run tests + check, commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- artifacts && npm run check'`
Expected: PASS, no new check errors.

```bash
git add frontend/src/lib/state frontend/src/lib/api/feed.ts frontend/src/routes
git commit -m "feat(frontend): artifacts store + feed-driven library refresh"
```

---

### Task 3: Dynamic workspace tabs

**Files:**
- Modify: `frontend/src/lib/state/workspace.svelte.ts` (full rewrite — currently 12 lines)
- Modify: `frontend/src/lib/components/Workspace.svelte`
- Modify: `frontend/src/lib/state/index.ts` (new exports)
- Test: `frontend/src/lib/state/__tests__/workspace.test.ts`

**Interfaces:**
- Produces:
  - `type WorkspaceTab = string` (kept exported — existing consumers compare `'detail' | 'graph' | 'issues'` literals; those remain valid ids)
  - `interface DynamicTab { id: string; kind: 'navigation'; artifactId: string | null; title: string }`
  - `getActiveTab(): string`, `setActiveTab(id: string): void` (unchanged signatures for `CommandPalette`)
  - `getDynamicTabs(): DynamicTab[]`
  - `openNavigationTab(opts: { artifactId: string | null; title: string }): string` — reuses an existing tab for the same `artifactId`, returns the tab id and activates it. Draft tabs (`artifactId: null`) get id `nav:draft:<n>`; saved ones `nav:<artifactId>`.
  - `closeTab(id: string): void` (activates `'detail'` if the active tab closes)
  - `retitleTab(id: string, title: string): void`, `bindTabToArtifact(id: string, artifactId: string): void` (draft → saved after first save; re-keys the tab id and returns nothing — the tab object is mutated in place, callers re-read `getDynamicTabs()`)
  - `initWorkspaceTabs(projectId: string): void` (restore persisted saved-artifact tabs), `resetWorkspaceTabs(): void`
- Persistence: localStorage `ui.workspace.tabs.<projectId>` = `{ active: string, tabs: Array<{id, kind, artifactId, title}> }`; **draft tabs are not persisted** (their unsaved definitions live only in editor memory).

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/state/__tests__/workspace.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
	bindTabToArtifact,
	closeTab,
	getActiveTab,
	getDynamicTabs,
	initWorkspaceTabs,
	openNavigationTab,
	resetWorkspaceTabs,
	setActiveTab
} from '../workspace.svelte';

beforeEach(() => {
	localStorage.clear();
	resetWorkspaceTabs();
});

describe('dynamic workspace tabs', () => {
	it('defaults to detail with no dynamic tabs', () => {
		expect(getActiveTab()).toBe('detail');
		expect(getDynamicTabs()).toEqual([]);
	});

	it('opens, activates, and dedupes navigation tabs by artifact', () => {
		initWorkspaceTabs('p1');
		const id = openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		expect(getActiveTab()).toBe(id);
		const again = openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		expect(again).toBe(id);
		expect(getDynamicTabs()).toHaveLength(1);
	});

	it('closing the active tab falls back to detail', () => {
		initWorkspaceTabs('p1');
		const id = openNavigationTab({ artifactId: null, title: 'New navigation' });
		closeTab(id);
		expect(getActiveTab()).toBe('detail');
		expect(getDynamicTabs()).toEqual([]);
	});

	it('persists saved tabs per project, not drafts', () => {
		initWorkspaceTabs('p1');
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		openNavigationTab({ artifactId: null, title: 'New navigation' });
		resetWorkspaceTabs();
		initWorkspaceTabs('p1');
		const tabs = getDynamicTabs();
		expect(tabs).toHaveLength(1);
		expect(tabs[0].artifactId).toBe('a1');
	});

	it('bindTabToArtifact converts a draft into a persisted saved tab', () => {
		initWorkspaceTabs('p1');
		const id = openNavigationTab({ artifactId: null, title: 'New navigation' });
		bindTabToArtifact(id, 'a9');
		setActiveTab(getDynamicTabs()[0].id);
		resetWorkspaceTabs();
		initWorkspaceTabs('p1');
		expect(getDynamicTabs()[0].artifactId).toBe('a9');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- workspace.test'`
Expected: FAIL — missing exports.

- [ ] **Step 3: Rewrite the store**

`frontend/src/lib/state/workspace.svelte.ts`:

```ts
/**
 * Workspace tab strip: three fixed built-ins (detail/graph/issues) plus
 * dynamic closable tabs (Stage 1: navigation editors; tables/diagrams later).
 * The active id is either a built-in literal or a dynamic tab id, so existing
 * `setActiveTab('detail')` call sites are untouched. Saved-artifact tabs are
 * persisted per project under `ui.workspace.tabs.<projectId>`; DRAFT tabs
 * (unsaved definitions, artifactId null) are memory-only by design.
 */

export type WorkspaceTab = string;
export const BUILTIN_TABS = ['detail', 'graph', 'issues'] as const;

export interface DynamicTab {
	id: string;
	kind: 'navigation';
	artifactId: string | null;
	title: string;
}

let _activeTab: string = $state('detail');
let _tabs = $state<DynamicTab[]>([]);
let _projectId: string | null = null;
let _draftSeq = 0;

export function getActiveTab(): string {
	return _activeTab;
}
export function setActiveTab(t: string): void {
	_activeTab = t;
	persist();
}
export function getDynamicTabs(): DynamicTab[] {
	return _tabs;
}

export function openNavigationTab(opts: {
	artifactId: string | null;
	title: string;
}): string {
	if (opts.artifactId !== null) {
		const existing = _tabs.find((t) => t.artifactId === opts.artifactId);
		if (existing) {
			_activeTab = existing.id;
			persist();
			return existing.id;
		}
	}
	const id = opts.artifactId === null ? `nav:draft:${++_draftSeq}` : `nav:${opts.artifactId}`;
	_tabs = [..._tabs, { id, kind: 'navigation', artifactId: opts.artifactId, title: opts.title }];
	_activeTab = id;
	persist();
	return id;
}

export function closeTab(id: string): void {
	_tabs = _tabs.filter((t) => t.id !== id);
	if (_activeTab === id) _activeTab = 'detail';
	persist();
}

export function retitleTab(id: string, title: string): void {
	_tabs = _tabs.map((t) => (t.id === id ? { ...t, title } : t));
	persist();
}

/** After the first save of a draft: bind it to its new artifact id (re-keyed). */
export function bindTabToArtifact(id: string, artifactId: string): void {
	const newId = `nav:${artifactId}`;
	_tabs = _tabs.map((t) => (t.id === id ? { ...t, id: newId, artifactId } : t));
	if (_activeTab === id) _activeTab = newId;
	persist();
}

function storageKey(): string | null {
	return _projectId ? `ui.workspace.tabs.${_projectId}` : null;
}

function persist(): void {
	const key = storageKey();
	if (!key) return;
	const saved = _tabs.filter((t) => t.artifactId !== null);
	try {
		localStorage.setItem(key, JSON.stringify({ active: _activeTab, tabs: saved }));
	} catch {
		/* storage full/denied: tabs simply don't persist */
	}
}

export function initWorkspaceTabs(projectId: string): void {
	_projectId = projectId;
	try {
		const raw = localStorage.getItem(`ui.workspace.tabs.${projectId}`);
		if (!raw) return;
		const parsed = JSON.parse(raw) as { active?: string; tabs?: DynamicTab[] };
		_tabs = (parsed.tabs ?? []).filter((t) => t.artifactId !== null);
		const active = parsed.active ?? 'detail';
		_activeTab =
			(BUILTIN_TABS as readonly string[]).includes(active) ||
			_tabs.some((t) => t.id === active)
				? active
				: 'detail';
	} catch {
		_tabs = [];
		_activeTab = 'detail';
	}
}

export function resetWorkspaceTabs(): void {
	_activeTab = 'detail';
	_tabs = [];
	_projectId = null;
	_draftSeq = 0;
}
```

- [ ] **Step 4: Render dynamic tabs**

Rewrite `frontend/src/lib/components/Workspace.svelte`:

```svelte
<script lang="ts">
	import { X } from '@lucide/svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import { closeTab, getActiveTab, getDynamicTabs, setActiveTab } from '$lib/state';
	import DetailView from './Workspace/DetailView.svelte';
	import GraphView from './Workspace/GraphView.svelte';
	import IssuesPanel from './Workspace/IssuesPanel.svelte';
	import NavigationBuilder from './Navigation/NavigationBuilder.svelte';

	const activeTab = $derived(getActiveTab());
	const dynamicTabs = $derived(getDynamicTabs());

	function onValueChange(v: string): void {
		setActiveTab(v);
	}
</script>

<section class="flex h-full flex-col overflow-hidden bg-zinc-950 text-sm text-zinc-200">
	<Tabs.Root value={activeTab} {onValueChange} class="flex h-full flex-col">
		<Tabs.List
			class="h-9 w-full justify-start overflow-x-auto rounded-none border-b border-zinc-800 bg-zinc-950 px-2"
		>
			<Tabs.Trigger value="detail" class="h-7 text-xs">Detail</Tabs.Trigger>
			<Tabs.Trigger value="graph" class="h-7 text-xs">Graph</Tabs.Trigger>
			<Tabs.Trigger value="issues" class="h-7 text-xs">Issues</Tabs.Trigger>
			{#each dynamicTabs as tab (tab.id)}
				<Tabs.Trigger value={tab.id} class="group h-7 gap-1 text-xs">
					<span class="max-w-40 truncate">{tab.title}</span>
					<button
						type="button"
						aria-label="Close {tab.title}"
						class="rounded p-0.5 opacity-50 hover:bg-zinc-700 hover:opacity-100"
						onclick={(e) => {
							e.stopPropagation();
							closeTab(tab.id);
						}}
					>
						<X class="size-3" />
					</button>
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
		<Tabs.Content value="detail" class="flex-1 overflow-auto">
			<DetailView />
		</Tabs.Content>
		<Tabs.Content value="graph" class="flex-1 overflow-hidden">
			<GraphView />
		</Tabs.Content>
		<Tabs.Content value="issues" class="flex-1 overflow-hidden">
			<IssuesPanel />
		</Tabs.Content>
		{#each dynamicTabs as tab (tab.id)}
			<Tabs.Content value={tab.id} class="flex-1 overflow-hidden">
				<NavigationBuilder tabId={tab.id} />
			</Tabs.Content>
		{/each}
	</Tabs.Root>
</section>
```

Until Task 5 exists, create a stub `frontend/src/lib/components/Navigation/NavigationBuilder.svelte`:

```svelte
<script lang="ts">
	let { tabId }: { tabId: string } = $props();
</script>

<div class="p-4 text-xs text-zinc-500">Navigation builder ({tabId}) — Task 5.</div>
```

Also: in `frontend/src/routes/p/[projectId]/+page.svelte`, call `initWorkspaceTabs(projectId)` where the page reads the route param (alongside `setActiveProject` usage — check `+layout.ts`/`+page.svelte` for where `projectId` is available; call once per mount). Re-export any new names from `state/index.ts` (`getDynamicTabs`, `openNavigationTab`, `closeTab`, `retitleTab`, `bindTabToArtifact`, `initWorkspaceTabs`, `resetWorkspaceTabs`, `BUILTIN_TABS`).

- [ ] **Step 5: Run tests + check, commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- workspace && npm run check'`
Expected: PASS; existing `WorkspacePage.*` tests stay green (built-in behavior unchanged).

```bash
git add frontend/src/lib/state frontend/src/lib/components frontend/src/routes
git commit -m "feat(frontend): dynamic closable workspace tabs with per-project persistence"
```

---

### Task 4: Sidebar Artifacts section

**Files:**
- Create: `frontend/src/lib/components/Sidebar/ArtifactsSection.svelte`
- Modify: `frontend/src/lib/components/Sidebar.svelte` (insert between `ViewSelector` and `ContainmentTree`)
- Modify: `frontend/src/lib/state/tree-drag.svelte.ts` (`DragPayload` union)
- Test: `frontend/src/lib/components/__tests__/artifacts-section.test.ts`

**Interfaces:**
- Consumes: artifacts store (Task 2), tabs (Task 3), `canEdit()` from checkout, `beginDrag` from tree-drag.
- Produces: `DragPayload` gains `{ kind: 'artifact'; id: string; artifactKind: string }` (Task 6 consumes it in the tree's drop machinery).

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/components/__tests__/artifacts-section.test.ts` (follow `lock-control.test.ts` mount/MSW pattern):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as api from '$lib/api/artifacts';
import { loadArtifacts, resetArtifacts, resetWorkspaceTabs, getDynamicTabs } from '$lib/state';
import ArtifactsSection from '../Sidebar/ArtifactsSection.svelte';

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 1,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: null
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(async () => {
	resetArtifacts();
	resetWorkspaceTabs();
	vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
	await loadArtifacts();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	vi.restoreAllMocks();
});

describe('ArtifactsSection', () => {
	it('lists navigation artifacts', () => {
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		expect(host.textContent).toContain('Navigations');
		expect(host.textContent).toContain('Sensors');
	});

	it('double-click opens a navigation tab', async () => {
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		const row = host.querySelector('[data-artifact-id="a1"]');
		expect(row).not.toBeNull();
		row!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		expect(getDynamicTabs()).toHaveLength(1);
		expect(getDynamicTabs()[0].artifactId).toBe('a1');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- artifacts-section'`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement**

Extend `DragPayload` in `frontend/src/lib/state/tree-drag.svelte.ts`:

```ts
export type DragPayload =
	| { kind: 'element'; ids: string[] }
	| { kind: 'folder'; path: string[] }
	| { kind: 'artifact'; id: string; artifactKind: string };
```

`frontend/src/lib/components/Sidebar/ArtifactsSection.svelte`:

```svelte
<script lang="ts">
	import { ChevronDown, ChevronRight, Plus, Route } from '@lucide/svelte';
	import {
		beginDrag,
		canEdit,
		getArtifactHeaders,
		openNavigationTab,
		removeArtifact,
		renameArtifact
	} from '$lib/state';

	let collapsed = $state(false);
	const navigations = $derived(
		getArtifactHeaders().filter((a) => a.kind === 'navigation')
	);
	const editable = $derived(canEdit());

	function openNew(): void {
		openNavigationTab({ artifactId: null, title: 'New navigation' });
	}
	function openExisting(id: string, name: string): void {
		openNavigationTab({ artifactId: id, title: name });
	}
	async function rename(id: string, current: string): Promise<void> {
		const name = window.prompt('Rename navigation', current);
		if (name && name !== current) await renameArtifact(id, name);
	}
	async function del(id: string, name: string): Promise<void> {
		if (window.confirm(`Delete navigation "${name}"?`)) await removeArtifact(id);
	}
	function onPointerDown(e: PointerEvent, id: string): void {
		if (e.button !== 0) return;
		beginDrag({ kind: 'artifact', id, artifactKind: 'navigation' }, true);
	}
</script>

<section class="border-b border-zinc-800 px-2 py-1.5">
	<div class="flex items-center justify-between">
		<button
			type="button"
			class="flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-200"
			onclick={() => (collapsed = !collapsed)}
		>
			{#if collapsed}<ChevronRight class="size-3" />{:else}<ChevronDown class="size-3" />{/if}
			Navigations
			<span class="text-zinc-600">({navigations.length})</span>
		</button>
		{#if editable}
			<button
				type="button"
				aria-label="New navigation"
				class="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
				onclick={openNew}
			>
				<Plus class="size-3.5" />
			</button>
		{/if}
	</div>
	{#if !collapsed}
		<ul class="mt-1 space-y-0.5">
			{#each navigations as nav (nav.id)}
				<li
					data-artifact-id={nav.id}
					class="group flex cursor-default items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-zinc-300 hover:bg-zinc-900"
					onpointerdown={(e) => onPointerDown(e, nav.id)}
					ondblclick={() => openExisting(nav.id, nav.name)}
				>
					<Route class="size-3.5 shrink-0 text-sky-500" />
					<span class="flex-1 truncate">{nav.name}</span>
					{#if editable}
						<button
							type="button"
							class="hidden text-zinc-500 hover:text-zinc-200 group-hover:inline"
							onclick={() => void rename(nav.id, nav.name)}>Rename</button
						>
						<button
							type="button"
							class="hidden text-zinc-500 hover:text-red-400 group-hover:inline"
							onclick={() => void del(nav.id, nav.name)}>Delete</button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
```

In `Sidebar.svelte`, insert between `<ViewSelector />` and `<ContainmentTree />`:

```svelte
		<ViewSelector />
		<ArtifactsSection />
		<ContainmentTree />
```

with the import added to the script block. Note the `beginDrag(..., true)` bypass-movable flag mirrors how Search-originated drags work; Task 6 teaches the tree to complete artifact drops (until then a drop is a no-op — `endDrag` fires regardless, no dangling state).

- [ ] **Step 4: Run tests + check, commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- artifacts-section && npm run check'`
Expected: PASS.

```bash
git add frontend/src/lib/components frontend/src/lib/state/tree-drag.svelte.ts
git commit -m "feat(frontend): sidebar artifacts section with drag source + tab opening"
```

---

### Task 5: Navigation editor state + builder UI

The largest task: the per-tab editor store and the builder component tree. Sub-structured so state lands (tested) before UI.

**Files:**
- Create: `frontend/src/lib/state/navigation-editor.svelte.ts`
- Create: `frontend/src/lib/components/Navigation/NavigationBuilder.svelte` (replace Task 3 stub)
- Create: `frontend/src/lib/components/Navigation/ScopeEditor.svelte`
- Create: `frontend/src/lib/components/Navigation/StepRow.svelte`
- Create: `frontend/src/lib/components/Navigation/SetExpressionEditor.svelte`
- Create: `frontend/src/lib/components/Navigation/ChainPreview.svelte`
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/navigation-editor.test.ts`

**Interfaces:**
- Produces (store, keyed by workspace `tabId`):
  - `interface NavDraft { name: string; artifactId: string | null; artifactRev: number | null; definition: NavigationDefinition; dirty: boolean }`
  - `ensureDraft(tabId: string): Promise<NavDraft>` — creates an empty path draft for `nav:draft:*` tabs; for `nav:<id>` tabs fetches the artifact payload once
  - `getDraft(tabId): NavDraft | undefined`, `updateDefinition(tabId, defn): void` (marks dirty, clears preview), `setDraftName(tabId, name): void`
  - `saveDraft(tabId): Promise<void>` — create (then `bindTabToArtifact`) or update with `artifactRev`; on `ConflictError` sets `getSaveConflict(tabId)` truthy so the UI offers reload-and-retry
  - `runPreview(tabId): Promise<void>`, `loadMorePreview(tabId): Promise<void>`, `getPreview(tabId): { stepTypes: string[]; chains: TreeItem[][]; total: number; truncated: boolean; loading: boolean } | undefined`
  - `closeDraft(tabId): void`, `resetNavigationEditors(): void`
- Preview paging: `PAGE = 100`, `loadMorePreview` appends `offset = chains.length` pages until `total`.
- Empty path draft: `{ kind: 'path', schema_version: 1, start: { kind: 'scope', types: [], criteria: [] }, steps: [] }`.

- [ ] **Step 1: Write the failing store tests**

`frontend/src/lib/state/__tests__/navigation-editor.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import {
	ensureDraft,
	getDraft,
	getPreview,
	resetNavigationEditors,
	runPreview,
	saveDraft,
	updateDefinition
} from '../navigation-editor.svelte';
import { resetWorkspaceTabs, openNavigationTab, getDynamicTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';

const CHAIN_PAGE = {
	step_types: ['Owns'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 1,
	truncated: false
};

beforeEach(() => {
	resetNavigationEditors();
	resetWorkspaceTabs();
	resetArtifacts();
});
afterEach(() => vi.restoreAllMocks());

describe('navigation editor store', () => {
	it('creates an empty path draft for draft tabs', async () => {
		const draft = await ensureDraft('nav:draft:1');
		expect(draft.definition).toEqual({
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: [], criteria: [] },
			steps: []
		});
		expect(draft.artifactId).toBeNull();
		expect(draft.dirty).toBe(false);
	});

	it('loads the artifact payload for saved tabs', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1', kind: 'navigation', name: 'Sensors', artifact_rev: 4,
			updated_at: '', updated_by: null,
			payload: { kind: 'path', schema_version: 1,
				start: { kind: 'scope', types: ['Building'], criteria: [] }, steps: [] }
		});
		const draft = await ensureDraft('nav:a1');
		expect(draft.name).toBe('Sensors');
		expect(draft.artifactRev).toBe(4);
	});

	it('updateDefinition marks dirty and clears the preview', async () => {
		await ensureDraft('nav:draft:1');
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await runPreview('nav:draft:1');
		expect(getPreview('nav:draft:1')?.total).toBe(1);
		updateDefinition('nav:draft:1', {
			kind: 'path', schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] }, steps: []
		});
		expect(getDraft('nav:draft:1')?.dirty).toBe(true);
		expect(getPreview('nav:draft:1')).toBeUndefined();
	});

	it('first save creates the artifact and binds the tab', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		const create = vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue({
			id: 'a9', kind: 'navigation', name: 'Mine', artifact_rev: 1,
			updated_at: '', updated_by: null, payload: {}
		});
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
		const draft = getDraft(tabId)!;
		draft.name = 'Mine';
		await saveDraft(tabId);
		expect(create).toHaveBeenCalled();
		expect(getDynamicTabs()[0].artifactId).toBe('a9');
		expect(getDraft('nav:a9')?.artifactRev).toBe(1);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- navigation-editor'`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the store**

`frontend/src/lib/state/navigation-editor.svelte.ts`:

```ts
/**
 * Per-tab navigation drafts. Keyed by the workspace tab id so several
 * navigations can be open at once. Definitions are edited as plain JSON
 * objects (the backend's NAVIGATION_ADAPTER is the source of truth for
 * validity; the editor keeps them structurally correct by construction).
 * Editing invalidates the preview: chains shown always correspond to the
 * definition on screen.
 */
import { SvelteMap } from 'svelte/reactivity';
import * as api from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import type { NavigationDefinition, TreeItem } from '$lib/api/types';
import { loadArtifacts } from './artifacts.svelte';
import { bindTabToArtifact, retitleTab } from './workspace.svelte';

const PAGE = 100;

export interface NavDraft {
	name: string;
	artifactId: string | null;
	artifactRev: number | null;
	definition: NavigationDefinition;
	dirty: boolean;
}

export interface NavPreview {
	stepTypes: string[];
	chains: TreeItem[][];
	total: number;
	truncated: boolean;
	loading: boolean;
}

const _drafts = new SvelteMap<string, NavDraft>();
const _previews = new SvelteMap<string, NavPreview>();
const _conflicts = new SvelteMap<string, number>(); // tabId -> server rev

export function emptyPath(): NavigationDefinition {
	return {
		kind: 'path',
		schema_version: 1,
		start: { kind: 'scope', types: [], criteria: [] },
		steps: []
	};
}

export function getDraft(tabId: string): NavDraft | undefined {
	return _drafts.get(tabId);
}
export function getPreview(tabId: string): NavPreview | undefined {
	return _previews.get(tabId);
}
export function getSaveConflict(tabId: string): number | undefined {
	return _conflicts.get(tabId);
}

export async function ensureDraft(tabId: string): Promise<NavDraft> {
	const existing = _drafts.get(tabId);
	if (existing) return existing;
	let draft: NavDraft;
	if (tabId.startsWith('nav:draft:')) {
		draft = {
			name: 'New navigation',
			artifactId: null,
			artifactRev: null,
			definition: emptyPath(),
			dirty: false
		};
	} else {
		const id = tabId.slice('nav:'.length);
		const artifact = await api.getArtifact(id);
		draft = {
			name: artifact.name,
			artifactId: artifact.id,
			artifactRev: artifact.artifact_rev,
			definition: artifact.payload as unknown as NavigationDefinition,
			dirty: false
		};
	}
	_drafts.set(tabId, draft);
	return draft;
}

export function updateDefinition(tabId: string, defn: NavigationDefinition): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, definition: defn, dirty: true });
	_previews.delete(tabId); // stale: preview must match what's on screen
}

export function setDraftName(tabId: string, name: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, name, dirty: true });
	retitleTab(tabId, name);
}

export async function saveDraft(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = draft.definition as unknown as Record<string, unknown>;
	try {
		if (draft.artifactId === null) {
			const created = await api.createArtifact({
				kind: 'navigation',
				name: draft.name,
				payload
			});
			bindTabToArtifact(tabId, created.id);
			_drafts.delete(tabId);
			_drafts.set(`nav:${created.id}`, {
				...draft,
				artifactId: created.id,
				artifactRev: created.artifact_rev,
				dirty: false
			});
			const preview = _previews.get(tabId);
			_previews.delete(tabId);
			if (preview) _previews.set(`nav:${created.id}`, preview);
		} else {
			const updated = await api.updateArtifact(draft.artifactId, {
				artifact_rev: draft.artifactRev ?? 1,
				name: draft.name,
				payload
			});
			_drafts.set(tabId, { ...draft, artifactRev: updated.artifact_rev, dirty: false });
			_conflicts.delete(tabId);
		}
		await loadArtifacts().catch(() => {});
	} catch (err) {
		if (err instanceof ConflictError) {
			// stale rev — remember it so the UI can offer reload-and-retry
			_conflicts.set(tabId, -1);
		}
		throw err;
	}
}

/** Discard the local draft and re-fetch the server copy (409 recovery). */
export async function reloadDraft(tabId: string): Promise<void> {
	_drafts.delete(tabId);
	_previews.delete(tabId);
	_conflicts.delete(tabId);
	await ensureDraft(tabId);
}

export async function runPreview(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_previews.set(tabId, {
		stepTypes: [], chains: [], total: 0, truncated: false, loading: true
	});
	try {
		const page = await api.evaluateNavigation({
			definition: draft.definition,
			limit: PAGE,
			offset: 0
		});
		_previews.set(tabId, {
			stepTypes: page.step_types,
			chains: page.chains,
			total: page.total,
			truncated: page.truncated,
			loading: false
		});
	} catch (err) {
		_previews.delete(tabId);
		throw err;
	}
}

export async function loadMorePreview(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	const preview = _previews.get(tabId);
	if (!draft || !preview || preview.loading) return;
	if (preview.chains.length >= preview.total) return;
	_previews.set(tabId, { ...preview, loading: true });
	const page = await api.evaluateNavigation({
		definition: draft.definition,
		limit: PAGE,
		offset: preview.chains.length
	});
	_previews.set(tabId, {
		...preview,
		chains: [...preview.chains, ...page.chains],
		total: page.total,
		truncated: page.truncated,
		loading: false
	});
}

export function closeDraft(tabId: string): void {
	_drafts.delete(tabId);
	_previews.delete(tabId);
	_conflicts.delete(tabId);
}

export function resetNavigationEditors(): void {
	_drafts.clear();
	_previews.clear();
	_conflicts.clear();
}
```

Re-export all public names from `state/index.ts`. In `workspace.svelte.ts`'s `closeTab`, also call `closeDraft(id)` — import it lazily to avoid a cycle, or better: have `Workspace.svelte`'s close handler call both `closeTab(tab.id)` and `closeDraft(tab.id)` (no store-to-store import; do it in the component).

- [ ] **Step 4: Run the store tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- navigation-editor'`
Expected: PASS.

- [ ] **Step 5: Build the components**

All under `frontend/src/lib/components/Navigation/`. Shared conventions: metamodel from `getMetamodel()`; pickers are `StereotypePicker` (`mode: 'filter'` for multi-type scopes, `mode: 'create'` for single picks); criteria rows reuse `CriterionRow` with `target="element"` (its `Criterion` objects are wire-compatible with backend criteria).

`ScopeEditor.svelte` — edits a `NavScope` (types + criteria):

```svelte
<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { getMetamodel } from '$lib/state';
	import type { NavScope } from '$lib/api/types';
	import type { Criterion } from '$lib/search/types';
	import { newCriterion } from '$lib/search/types';
	import CriterionRow from '../Sidebar/CriterionRow.svelte';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	type Props = {
		scope: NavScope;
		/** When set, only these type names are offered (hop targets). */
		allowedTypes?: string[] | null;
		label: string;
		onChange: (next: NavScope) => void;
	};
	let { scope, allowedTypes = null, label, onChange }: Props = $props();

	const mm = $derived(getMetamodel());
	const typeNames = $derived(
		allowedTypes ?? [...(mm?.elements ?? []).map((e) => e.name)].sort()
	);
	const checked = $derived(new SvelteSet(scope.types));
	let pickerOpen = $state(false);

	function toggleType(name: string): void {
		const next = new Set(scope.types);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		onChange({ ...scope, types: [...next].sort() });
	}
	function setCriterion(index: number, next: Criterion): void {
		const criteria = [...(scope.criteria as Criterion[])];
		criteria[index] = next;
		onChange({ ...scope, criteria });
	}
	function removeCriterion(index: number): void {
		onChange({ ...scope, criteria: scope.criteria.filter((_, i) => i !== index) });
	}
	function addCriterion(): void {
		onChange({
			...scope,
			criteria: [...(scope.criteria as Criterion[]), newCriterion('property')]
		});
	}
</script>

<div class="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/40 p-2">
	<div class="flex items-center gap-2">
		<span class="text-xs font-medium text-zinc-400">{label}</span>
		<StereotypePicker
			mode="filter"
			names={typeNames}
			{checked}
			onToggle={toggleType}
			onSelectAll={() => onChange({ ...scope, types: [...typeNames] })}
			onDeselectAll={() => onChange({ ...scope, types: [] })}
			open={pickerOpen}
			onOpenChange={(v) => (pickerOpen = v)}
			searchPlaceholder="Filter types…"
		>
			{#snippet trigger()}
				<span class="cursor-pointer rounded border border-zinc-700 px-1.5 py-0.5 text-xs">
					{scope.types.length === 0 ? 'Any type' : scope.types.join(', ')}
				</span>
			{/snippet}
		</StereotypePicker>
	</div>
	{#each scope.criteria as criterion, i (i)}
		<CriterionRow
			criterion={criterion as Criterion}
			index={i}
			target="element"
			onChange={setCriterion}
			onRemove={removeCriterion}
		/>
	{/each}
	<button
		type="button"
		class="text-xs text-sky-500 hover:text-sky-300"
		onclick={addCriterion}>+ condition</button
	>
</div>
```

Check `StereotypePicker`'s exact trigger-snippet prop shape against `CriterionRow`'s existing usage before writing; mirror it exactly.

`StepRow.svelte` — one hop:

```svelte
<script lang="ts">
	import { Trash2 } from '@lucide/svelte';
	import { getMetamodel } from '$lib/state';
	import { allowedTargetTypes, relationshipTypesFromSource } from '$lib/metamodel/connection-rules';
	import type { NavDirection, NavScope, NavStep } from '$lib/api/types';
	import ScopeEditor from './ScopeEditor.svelte';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	type Props = {
		step: NavStep;
		index: number;
		/** Types flowing INTO this step (previous scope's types; [] = any). */
		sourceTypes: string[];
		onChange: (index: number, next: NavStep) => void;
		onRemove: (index: number) => void;
	};
	let { step, index, sourceTypes, onChange, onRemove }: Props = $props();

	const mm = $derived(getMetamodel());
	let relPickerOpen = $state(false);

	// Valid hop types from the incoming types; unconstrained when sourceTypes
	// is empty or direction is 'in'/'either' (keep permissive: the backend is
	// the semantic authority, the picker is a convenience filter).
	const relTypeNames = $derived.by(() => {
		if (!mm) return [];
		if (step.direction !== 'out' || sourceTypes.length === 0) {
			return mm.relationships.filter((r) => !r.abstract).map((r) => r.name).sort();
		}
		const names = new Set<string>();
		for (const t of sourceTypes) {
			for (const entry of relationshipTypesFromSource(mm, t)) names.add(entry.rt.name);
		}
		return [...names].sort();
	});

	// Target types the mapping allows (narrows the ScopeEditor's type list).
	const targetTypeOptions = $derived.by(() => {
		if (!mm || step.direction !== 'out' || sourceTypes.length === 0) return null;
		const rt = mm.relationships.find((r) => r.name === step.relationship_type);
		if (!rt) return null;
		const out = new Set<string>();
		for (const t of sourceTypes) for (const n of allowedTargetTypes(mm, t, rt)) out.add(n);
		return out.size > 0 ? [...out].sort() : null;
	});

	function patch(next: Partial<NavStep>): void {
		onChange(index, { ...step, ...next });
	}
</script>

<div class="space-y-1.5 rounded border border-zinc-800 p-2">
	<div class="flex items-center gap-2 text-xs">
		<span class="text-zinc-500">Step {index + 1}</span>
		<StereotypePicker
			mode="create"
			names={relTypeNames}
			onPick={(name) => patch({ relationship_type: name })}
			open={relPickerOpen}
			onOpenChange={(v) => (relPickerOpen = v)}
			searchPlaceholder="Relationship type…"
		>
			{#snippet trigger()}
				<span class="cursor-pointer rounded border border-zinc-700 px-1.5 py-0.5">
					{step.relationship_type || 'pick relationship'}
				</span>
			{/snippet}
		</StereotypePicker>
		<select
			class="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
			value={step.direction}
			onchange={(e) => patch({ direction: e.currentTarget.value as NavDirection })}
		>
			<option value="out">outgoing</option>
			<option value="in">incoming</option>
			<option value="either">either</option>
		</select>
		<button
			type="button"
			aria-label="Remove step"
			class="ml-auto text-zinc-500 hover:text-red-400"
			onclick={() => onRemove(index)}
		>
			<Trash2 class="size-3.5" />
		</button>
	</div>
	<ScopeEditor
		scope={step.target}
		allowedTypes={targetTypeOptions}
		label="Target filter"
		onChange={(next: NavScope) => patch({ target: next })}
	/>
</div>
```

`ChainPreview.svelte` — the Run/results panel:

```svelte
<script lang="ts">
	import { getPreview, loadMorePreview, runPreview, select } from '$lib/state';

	let { tabId }: { tabId: string } = $props();
	const preview = $derived(getPreview(tabId));
	let error = $state<string | null>(null);

	async function run(): Promise<void> {
		error = null;
		try {
			await runPreview(tabId);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Evaluation failed';
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col border-t border-zinc-800">
	<div class="flex items-center gap-2 px-2 py-1.5">
		<button
			type="button"
			class="rounded bg-sky-700 px-2 py-0.5 text-xs text-white hover:bg-sky-600"
			onclick={() => void run()}>Run</button
		>
		{#if preview && !preview.loading}
			<span class="text-xs text-zinc-500">
				{preview.chains.length} of {preview.total} chains
				{#if preview.truncated}(results capped){/if}
			</span>
		{/if}
		{#if error}<span class="text-xs text-red-400">{error}</span>{/if}
	</div>
	{#if preview}
		<div class="min-h-0 flex-1 overflow-auto px-2 pb-2">
			<table class="w-full text-xs">
				<thead>
					<tr class="text-left text-zinc-500">
						<th class="py-1 pr-2 font-normal">Start</th>
						{#each preview.stepTypes as st, i (i)}
							<th class="py-1 pr-2 font-normal">{st} →</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each preview.chains as chain, ci (ci)}
						<tr class="border-t border-zinc-900">
							{#each chain as item (item.id)}
								<td class="py-0.5 pr-2">
									<button
										type="button"
										class="rounded bg-zinc-800 px-1.5 py-0.5 hover:bg-zinc-700"
										title={item.type_name}
										onclick={() => select({ kind: 'element', id: item.id })}
									>
										{item.display_name}
									</button>
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
			{#if !preview.loading && preview.chains.length < preview.total}
				<button
					type="button"
					class="mt-1 text-xs text-sky-500 hover:text-sky-300"
					onclick={() => void loadMorePreview(tabId)}>Load more</button
				>
			{/if}
			{#if preview.loading}<p class="py-2 text-xs text-zinc-500">Evaluating…</p>{/if}
		</div>
	{/if}
</div>
```

`SetExpressionEditor.svelte` — operator + operand list (library refs, plus "use current path" seeding handled by the parent):

```svelte
<script lang="ts">
	import { Trash2 } from '@lucide/svelte';
	import { getArtifactHeaders } from '$lib/state';
	import type { NavOperand, SetExpression } from '$lib/api/types';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	type Props = { expr: SetExpression; onChange: (next: SetExpression) => void };
	let { expr, onChange }: Props = $props();

	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));
	let addOpen = $state(false);

	function nameFor(op: NavOperand): string {
		if (op.ref) return navHeaders.find((h) => h.id === op.ref)?.name ?? op.ref;
		return op.definition?.kind === 'path' ? '(inline path)' : '(inline set)';
	}
	function addRef(name: string): void {
		const header = navHeaders.find((h) => h.name === name);
		if (!header) return;
		onChange({ ...expr, operands: [...expr.operands, { ref: header.id }] });
	}
	function removeOperand(i: number): void {
		onChange({ ...expr, operands: expr.operands.filter((_, idx) => idx !== i) });
	}
	function setStepIndex(i: number, raw: string): void {
		const operands = [...expr.operands];
		operands[i] = { ...operands[i], step_index: raw === '' ? null : Number(raw) };
		onChange({ ...expr, operands });
	}
</script>

<div class="space-y-1.5 rounded border border-zinc-800 p-2 text-xs">
	<div class="flex items-center gap-2">
		<span class="text-zinc-400">Set operation</span>
		<select
			class="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5"
			value={expr.op}
			onchange={(e) => onChange({ ...expr, op: e.currentTarget.value as SetExpression['op'] })}
		>
			<option value="union">union</option>
			<option value="intersection">intersection</option>
			<option value="difference">difference</option>
			<option value="symmetric_difference">symmetric difference</option>
		</select>
	</div>
	<ul class="space-y-1">
		{#each expr.operands as op, i (i)}
			<li class="flex items-center gap-2">
				<span class="flex-1 truncate">{nameFor(op)}</span>
				<label class="text-zinc-500">
					step
					<input
						class="w-10 rounded border border-zinc-700 bg-zinc-900 px-1"
						type="number"
						min="0"
						value={op.step_index ?? ''}
						placeholder="last"
						oninput={(e) => setStepIndex(i, e.currentTarget.value)}
					/>
				</label>
				<button type="button" class="text-zinc-500 hover:text-red-400"
					onclick={() => removeOperand(i)}><Trash2 class="size-3" /></button>
			</li>
		{/each}
	</ul>
	<StereotypePicker
		mode="create"
		names={navHeaders.map((h) => h.name)}
		onPick={addRef}
		open={addOpen}
		onOpenChange={(v) => (addOpen = v)}
		searchPlaceholder="Add saved navigation…"
	>
		{#snippet trigger()}
			<span class="cursor-pointer text-sky-500 hover:text-sky-300">+ operand</span>
		{/snippet}
	</StereotypePicker>
</div>
```

`NavigationBuilder.svelte` (replaces the stub) — mode toggle, name, save, steps, preview:

```svelte
<script lang="ts">
	import { canEdit, getDraft, getSaveConflict, reloadDraft, saveDraft, setDraftName, updateDefinition, ensureDraft } from '$lib/state';
	import type { NavScope, NavStep, PathNavigation, SetExpression } from '$lib/api/types';
	import ScopeEditor from './ScopeEditor.svelte';
	import StepRow from './StepRow.svelte';
	import SetExpressionEditor from './SetExpressionEditor.svelte';
	import ChainPreview from './ChainPreview.svelte';

	let { tabId }: { tabId: string } = $props();
	$effect(() => {
		void ensureDraft(tabId);
	});
	const draft = $derived(getDraft(tabId));
	const conflict = $derived(getSaveConflict(tabId));
	const editable = $derived(canEdit());
	let saveError = $state<string | null>(null);

	const path = $derived(
		draft?.definition.kind === 'path' ? (draft.definition as PathNavigation) : null
	);
	const setExpr = $derived(
		draft?.definition.kind === 'set_op' ? (draft.definition as SetExpression) : null
	);
	// Types flowing into step i: previous step's target types, or the start
	// scope's types for step 0 ([] = unconstrained).
	function sourceTypesFor(i: number): string[] {
		if (!path) return [];
		if (i === 0) return path.start.kind === 'scope' ? path.start.types : [];
		return path.steps[i - 1].target.types;
	}

	function patchPath(next: Partial<PathNavigation>): void {
		if (!path) return;
		updateDefinition(tabId, { ...path, ...next });
	}
	function setStep(i: number, next: NavStep): void {
		if (!path) return;
		patchPath({ steps: path.steps.map((s, idx) => (idx === i ? next : s)) });
	}
	function removeStep(i: number): void {
		if (!path) return;
		patchPath({ steps: path.steps.filter((_, idx) => idx !== i) });
	}
	function addStep(): void {
		if (!path) return;
		patchPath({
			steps: [...path.steps, {
				relationship_type: '', direction: 'out',
				target: { kind: 'scope', types: [], criteria: [] }, children: []
			}]
		});
	}
	function toSetExpression(): void {
		if (!draft) return;
		// Seed operand[0] with the current path INLINE (spec: "current draft
		// inline"), so switching modes loses nothing.
		const operands = path ? [{ definition: path, step_index: null }] : [];
		updateDefinition(tabId, {
			kind: 'set_op', schema_version: 1, op: 'union', operands
		} as SetExpression);
	}
	function toPath(): void {
		updateDefinition(tabId, {
			kind: 'path', schema_version: 1,
			start: { kind: 'scope', types: [], criteria: [] }, steps: []
		} as PathNavigation);
	}
	async function save(): Promise<void> {
		saveError = null;
		try {
			await saveDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-zinc-500">Loading…</p>
{:else}
	<div class="flex h-full flex-col">
		<div class="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
			<input
				class="w-56 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable}
				oninput={(e) => setDraftName(tabId, e.currentTarget.value)}
			/>
			<div class="flex rounded border border-zinc-700 text-xs">
				<button type="button"
					class="px-2 py-0.5 {path ? 'bg-zinc-700' : ''}" onclick={toPath}>Path</button>
				<button type="button"
					class="px-2 py-0.5 {setExpr ? 'bg-zinc-700' : ''}" onclick={toSetExpression}>Set op</button>
			</div>
			{#if editable}
				<button
					type="button"
					class="ml-auto rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-40"
					disabled={!draft.dirty && draft.artifactId !== null}
					onclick={() => void save()}
				>
					Save{draft.dirty ? ' *' : ''}
				</button>
			{/if}
		</div>
		{#if conflict !== undefined}
			<div class="flex items-center gap-2 bg-amber-950/60 px-3 py-1.5 text-xs text-amber-300">
				Someone else modified this navigation.
				<button type="button" class="underline" onclick={() => void reloadDraft(tabId)}>
					Reload their version
				</button>
			</div>
		{/if}
		{#if saveError}
			<p class="px-3 py-1 text-xs text-red-400">{saveError}</p>
		{/if}
		<div class="min-h-0 flex-1 space-y-2 overflow-auto p-3">
			{#if path}
				{#if path.start.kind === 'scope'}
					<ScopeEditor
						scope={path.start}
						label="Start"
						onChange={(next: NavScope) => patchPath({ start: next })}
					/>
				{:else}
					<SetExpressionEditor
						expr={path.start}
						onChange={(next) => patchPath({ start: next })}
					/>
				{/if}
				{#each path.steps as step, i (i)}
					<StepRow {step} index={i} sourceTypes={sourceTypesFor(i)}
						onChange={setStep} onRemove={removeStep} />
				{/each}
				<button type="button" class="text-xs text-sky-500 hover:text-sky-300"
					onclick={addStep}>+ add step</button>
			{:else if setExpr}
				<SetExpressionEditor expr={setExpr} onChange={(next) => updateDefinition(tabId, next)} />
			{/if}
		</div>
		<ChainPreview {tabId} />
	</div>
{/if}
```

Also: in `Workspace.svelte`'s close button handler, call `closeDraft(tab.id)` before `closeTab(tab.id)` (import from `$lib/state`).

- [ ] **Step 6: Run everything + check, commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: all vitest suites PASS; svelte-check clean. Fix any prop-shape mismatches against `StereotypePicker`/`CriterionRow` by reading those components — they are the source of truth.

```bash
git add frontend/src/lib
git commit -m "feat(frontend): navigation builder with step editor, set ops, chain preview"
```

---

### Task 6: View-tree artifact placement

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (`Folder`/`FolderSchema`, :124-136)
- Modify: `frontend/src/lib/components/Sidebar/view-tree.ts` (`NodeKind` :40, `UnifiedTree` :42-54, `ingestFolder`, drop-legality helpers)
- Modify: `frontend/src/lib/state/view.svelte.ts` (mutators)
- Modify: `frontend/src/lib/state/view-ops.ts` (pure helpers)
- Modify: `frontend/src/lib/components/Sidebar/ContainmentTree.svelte` (render artifact rows, accept artifact drops, dblclick-open)
- Test: `frontend/src/lib/state/__tests__/view-ops.artifacts.test.ts`, extend `frontend/src/lib/components/Sidebar/__tests__/view-tree*.test.ts` (or wherever the existing view-tree tests live — locate with `git grep -l buildUnifiedTree frontend/src`)

**Interfaces:**
- `Folder` gains `artifacts: { id: string; kind: string }[]` (zod `.default([])` — old payloads parse).
- `NodeKind` gains `'artifact'`; artifact node keys are `NUL + 'A' + NUL + <artifactId>` via new helpers `artifactKey(id)`, `isArtifactKey(key)`, `artifactIdFromKey(key)`; `UnifiedTree` gains `artifactRef: Map<string, { id: string; kind: string }>`.
- `view-ops.ts` gains `placeArtifactInFolder(view, folderPath, ref): View` and `removeArtifactFromView(view, artifactId): View` (pure, clone-based, like `placeElementsInView`). An artifact may sit in several folders; `placeArtifactInFolder` is a no-op if that folder already holds the id.
- `view.svelte.ts` gains `placeArtifact(folderPath: string[], ref: {id, kind}): Promise<void>` and `removeArtifact(folderPath: string[], artifactId: string): Promise<void>` (clone → mutate → `pushView`).
- Tree behavior: artifact rows render with a kind icon + name from `artifactHeaderById` (fallback: skip the row entirely when the id is unknown — the tolerate-dangling rule), no expand caret, dblclick opens the tab, drag-out re-places between folders, context/remove button removes from folder. Artifact drops are legal ONLY onto folder targets (not the excluded pool, not root, not elements).

- [ ] **Step 1: Write the failing pure-logic tests**

`frontend/src/lib/state/__tests__/view-ops.artifacts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { placeArtifactInFolder, removeArtifactFromView } from '../view-ops';
import type { View } from '$lib/api/types';

const REF = { id: 'a1', kind: 'navigation' };

function view(): View {
	return {
		name: 'v',
		folders: [
			{ name: 'F', folders: [{ name: 'G', folders: [], elements: [], artifacts: [] }], elements: [], artifacts: [] }
		]
	};
}

describe('artifact placement ops', () => {
	it('places into a nested folder without mutating the input', () => {
		const v = view();
		const next = placeArtifactInFolder(v, ['F', 'G'], REF);
		expect(next.folders[0].folders[0].artifacts).toEqual([REF]);
		expect(v.folders[0].folders[0].artifacts).toEqual([]);
	});

	it('is idempotent per folder but allows multi-folder placement', () => {
		let v = placeArtifactInFolder(view(), ['F'], REF);
		v = placeArtifactInFolder(v, ['F'], REF);
		expect(v.folders[0].artifacts).toEqual([REF]);
		v = placeArtifactInFolder(v, ['F', 'G'], REF);
		expect(v.folders[0].folders[0].artifacts).toEqual([REF]);
	});

	it('removeArtifactFromView drops every placement', () => {
		let v = placeArtifactInFolder(view(), ['F'], REF);
		v = placeArtifactInFolder(v, ['F', 'G'], REF);
		v = removeArtifactFromView(v, 'a1');
		expect(v.folders[0].artifacts).toEqual([]);
		expect(v.folders[0].folders[0].artifacts).toEqual([]);
	});
});
```

Plus a `buildUnifiedTree` case in the existing view-tree test file: a view whose folder carries `artifacts: [{id:'a1',kind:'navigation'}]` produces a child key `artifactKey('a1')` with `kind.get(key) === 'artifact'` and `artifactRef.get(key)` equal to the ref — copy the file's existing fixture style.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- view-ops.artifacts'`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement**

`types.ts` — extend the interface + schema:

```ts
export interface ArtifactRef {
	id: string;
	kind: string;
}

export interface Folder {
	name: string;
	folders: Folder[];
	elements: string[];
	artifacts: ArtifactRef[];
}

export const FolderSchema: z.ZodType<Folder> = z.lazy(() =>
	z.object({
		name: z.string(),
		folders: z.array(FolderSchema).default([]),
		elements: z.array(z.string()).default([]),
		artifacts: z
			.array(z.object({ id: z.string(), kind: z.string() }))
			.default([])
	})
);
```

Then chase the compile errors: every literal `{ name, folders: [], elements: [] }` folder constructor in `view.svelte.ts` / `view-ops.ts` / tests gains `artifacts: []` (svelte-check will list them all).

`view-ops.ts` additions (mirror `placeElementsInView`'s clone-then-mutate shape, reusing its `cloneView`/`findFolderByPath`):

```ts
export function placeArtifactInFolder(
	view: View,
	folderPath: string[],
	ref: ArtifactRef
): View {
	const next = cloneView(view);
	const folder = findFolderByPath(next, folderPath);
	if (!folder || folderPath.length === 0) {
		throw new Error(`Folder not found: ${folderPath.join('/')}`);
	}
	if (!folder.artifacts.some((a) => a.id === ref.id)) {
		folder.artifacts.push({ ...ref });
	}
	return next;
}

export function removeArtifactFromView(view: View, artifactId: string): View {
	const next = cloneView(view);
	const scrub = (folders: Folder[]): void => {
		for (const f of folders) {
			f.artifacts = f.artifacts.filter((a) => a.id !== artifactId);
			scrub(f.folders);
		}
	};
	scrub(next.folders);
	return next;
}
```

(Check `findFolderByPath`'s root-path behavior first — if `[]` returns a virtual root, adjust the guard; `cloneView` must deep-copy `artifacts` — verify and extend it if it clones field-by-field.)

`view.svelte.ts` mutators (same shape as `createFolder`):

```ts
export async function placeArtifact(
	folderPath: string[],
	ref: { id: string; kind: string }
): Promise<void> {
	if (_view === null) throw new Error('No active view');
	await pushView(placeArtifactInFolder(_view, folderPath, ref));
}

export async function removeArtifact(folderPath: string[], artifactId: string): Promise<void> {
	if (_view === null) throw new Error('No active view');
	const next = cloneView(_view);
	const folder = findFolderByPath(next, folderPath);
	if (!folder) throw new Error(`Folder not found: ${folderPath.join('/')}`);
	folder.artifacts = folder.artifacts.filter((a) => a.id !== artifactId);
	await pushView(next);
}
```

`view-tree.ts`: add the key helpers next to `folderKey`/`isFolderKey`; extend `NodeKind`; add `artifactRef` to `UnifiedTree` (constructed in `buildUnifiedTree`); in `ingestFolder`, after elements, append artifact child keys:

```ts
	for (const ref of folder.artifacts) {
		const key = artifactKey(ref.id);
		children.push(key);
		tree.kind.set(key, 'artifact');
		tree.artifactRef.set(key, ref);
	}
```

(adapt names to the function's actual local variables — read `ingestFolder` before editing). Drop legality: in `canDropElement`/`resolveElementDrop` add an artifact-payload path — a new `canDropArtifact(dropKind): boolean` that returns true only for folder drop targets; wire it where the tree consults `getDragPayload()`.

`ContainmentTree.svelte`: three integration points (locate by searching the file):
1. **Row rendering** — where `kind.get(key)` chooses element vs folder markup, add the `'artifact'` branch: icon (`Route` for `kind==='navigation'`), label from `artifactHeaderById(artifactIdFromKey(key))?.name`; if the header is unknown, render nothing (dangling ref tolerated). `ondblclick` → `openNavigationTab({ artifactId, title: name })`. A small ✕/remove affordance calls `removeArtifact(folderPathOfParent, artifactId)` (the parent folder path is available from the row's parent key via `folderPathFromKey`).
2. **Drop handling** — where the pointer-up handler switches on `getDragPayload().kind`, add `case 'artifact'`: if the drop target is a folder key → `placeArtifact(folderPathFromKey(targetKey), { id, kind: artifactKind })`; when the artifact was dragged from another folder (drag began on a tree artifact row rather than the sidebar section), remove it from the source folder first (single `pushView`: build the next view with both edits via the pure ops, then one `placeArtifact`-style push — add a `moveArtifactInView` pure helper if needed).
3. **Drag start on artifact rows** — reuse the row pointer-down machinery with payload `{ kind: 'artifact', id, artifactKind }`.

- [ ] **Step 4: Run the full frontend suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS — including all pre-existing view-tree/view-ops/dnd tests (the `artifacts: []` default keeps old fixtures valid via zod, but TS fixture literals need the field — svelte-check finds them).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib
git commit -m "feat(frontend): artifact nodes in the view tree with DnD placement"
```

---

### Task 7: E2E + full verification

**Files:**
- Create: `frontend/e2e/navigation.spec.ts`
- Test: the whole suite.

- [ ] **Step 1: Write the e2e spec**

`frontend/e2e/navigation.spec.ts` (follow `advanced-search.spec.ts` / `view.spec.ts` structure and the `openDefaultProject()` helper; adapt selectors to what those specs use):

```ts
import { expect, test } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

test('build, run, save, and place a navigation', async ({ page }) => {
	await openDefaultProject(page);

	// New navigation from the sidebar artifacts section
	await page.getByRole('button', { name: 'New navigation' }).click();
	await expect(page.getByText('New navigation')).toBeVisible();

	// Pick a start type (smart-city metamodel: adapt the type name to one
	// that exists in examples/smart-city.metamodel.yaml — check the file)
	await page.getByText('Any type').click();
	const picker = page.getByPlaceholder('Filter types…');
	await picker.fill('Building');
	await page.getByRole('option', { name: 'Building' }).first().click();
	await page.keyboard.press('Escape');

	// Run the (0-step) navigation and expect chains
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByText(/of \d+ chains/)).toBeVisible();

	// Save under a name
	const nameInput = page.locator('input[value="New navigation"]');
	await nameInput.fill('Buildings nav');
	await page.getByRole('button', { name: /^Save/ }).click();
	await expect(
		page.locator('[data-artifact-id]', { hasText: 'Buildings nav' })
	).toBeVisible();

	// Reopen from the sidebar after closing the tab
	await page.getByRole('button', { name: 'Close Buildings nav' }).click();
	await page.locator('[data-artifact-id]', { hasText: 'Buildings nav' }).dblclick();
	await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();
});
```

(Drag-into-folder is exercised by unit tests in Task 6; pointer-event DnD in Playwright is flaky and `dnd.spec.ts` shows what's feasible — add a drag step only if that spec's helpers make it cheap.)

- [ ] **Step 2: Run the e2e**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e -- navigation.spec.ts'`
Expected: PASS (the Playwright config boots backend + dev server itself). Selector fixes are expected here — iterate against the real DOM.

- [ ] **Step 3: Full verification**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Run: `pixi run tidy`
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e
git commit -m "test(e2e): navigation build-run-save-reopen flow"
```
