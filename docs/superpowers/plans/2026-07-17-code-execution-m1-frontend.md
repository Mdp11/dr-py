# Code Execution M1 Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-browser Python snippet workspace: CodeMirror editor + lint gutter, run console against `POST /snippets/run`, "Stage ops" into the existing staged-edits buffer, `code_snippet` artifacts in the sidebar library.

**Architecture:** A third dynamic workspace-tab kind (`'snippet'`) mirroring the navigation/table draft-tab lifecycle; a per-tab `snippet-editor.svelte.ts` store modeled on `navigation-editor.svelte.ts` (generation counters, debounce, save-conflict markers); a `snippet-stage.ts` module that remaps facade temp ids, prefetches pre-state, acquires locks, and `emit()`s ops. One sanctioned backend change (D6): server-derived `entry_points` on artifact headers.

**Tech Stack:** Svelte 5 (runes) + SvelteKit, zod v4, CodeMirror 6 (new), vitest + happy-dom + MSW, Playwright. Backend: FastAPI + Pydantic (Task 1 only).

**Spec:** `docs/superpowers/specs/2026-07-17-code-execution-m1-frontend-design.md` (decisions D1–D6).

## Global Constraints

- **All commands through pixi.** Frontend npm scripts MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'` — the bare `pixi run -e frontend npm test` fails ("Missing script").
- **Backend contract is frozen** except Task 1 (D6). Never change `SnippetRunIn/Out`, `SnippetLintOut`, or the snippet routes.
- **`entry_points` is server-derived** — the client never sends it, always adopts it from responses.
- **Ops are dry-run** — snippet ops enter the model only via `emit()` into the staged buffer; never build a parallel apply path.
- **Read `frontend/README.md` before touching `frontend/src/lib/state/`** (CLAUDE.md mandate).
- Frontend per-task gates: `npm test`, `npm run check`, `npm run lint` (all via the `cd frontend` form). Task 1 gates: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -v`, then `pixi run test-core` + `pixi run lint-backend`. Task 9 runs everything incl. e2e + `pixi run tidy`.
- **Do not push `main` / open a PR.** Commit per task on the feature branch (`feature/code-execution-m1-frontend`, created in Task 1).
- Svelte state files use runes (`$state`, `$derived`) + `SvelteMap` from `svelte/reactivity`; control state (generations, timers) uses plain `Map` with the `// eslint-disable-next-line svelte/prefer-svelte-reactivity` comment (see `navigation-editor.svelte.ts`).
- State tests mock the API with `vi.spyOn(apiModule, 'fn')`; `api/__tests__` tests use MSW (`server.ts` + `http`/`HttpResponse`, `BASE = 'http://api.test/api/v1/projects/p1'`, `CFG = { baseUrl: BASE }`).

---

### Task 1: Backend (D6) — `entry_points` on artifact headers

**Files:**
- Modify: `src/data_rover/api/schemas.py` (class `ArtifactHeaderOut`, ~line 646)
- Modify: `src/data_rover/api/routes/artifacts.py` (`_header`, ~line 60)
- Test: `tests/api/test_artifacts_routes.py`

**Interfaces:**
- Produces: `ArtifactHeaderOut.entry_points: list[str] | None` — `None` for non-snippet kinds, the derived list (possibly `[]`) for `code_snippet` rows. `ArtifactOut` inherits it, so single-artifact GET/POST/PUT responses carry it too.

- [ ] **Step 0: Create the feature branch**

```bash
git checkout -b feature/code-execution-m1-frontend
```

- [ ] **Step 1: Write the failing tests** — append to `tests/api/test_artifacts_routes.py`, mirroring the file's existing fixture/helper usage (`client`, `seed_default_project`, `AUTH_HEADERS`, `papi` from `tests/api/conftest.py`) exactly as the neighboring tests do:

```python
def test_snippet_header_carries_entry_points(client, seed_default_project):
    code = "def value(el):\n    return el.name\n"
    created = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": "snip", "payload": {"code": code}},
        headers=AUTH_HEADERS,
    )
    assert created.status_code == 201
    assert sorted(created.json()["entry_points"]) == ["script", "value"]

    listed = client.get(papi("/artifacts"), headers=AUTH_HEADERS)
    row = next(a for a in listed.json()["items"] if a["id"] == created.json()["id"])
    assert sorted(row["entry_points"]) == ["script", "value"]


def test_non_snippet_header_entry_points_is_none(client, seed_default_project):
    created = client.post(
        papi("/artifacts"),
        json={
            "kind": "navigation",
            "name": "nav",
            "payload": {"kind": "path", "start": {"kind": "scope", "types": [], "criteria": []}, "steps": []},
        },
        headers=AUTH_HEADERS,
    )
    assert created.status_code == 201
    listed = client.get(papi("/artifacts"), headers=AUTH_HEADERS)
    row = next(a for a in listed.json()["items"] if a["id"] == created.json()["id"])
    assert row["entry_points"] is None
```

(If the file's existing tests build payloads/requests differently — e.g. a navigation payload helper — copy that form; the assertions are the contract.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -k entry_points -v`
Expected: FAIL — `KeyError: 'entry_points'` (field absent from response).

- [ ] **Step 3: Implement** — in `schemas.py`, add to `ArtifactHeaderOut`:

```python
class ArtifactHeaderOut(BaseModel):
    """Artifact list row: everything the sidebar renders, payload omitted.

    `entry_points` is the ONE payload-derived field surfaced on headers: the
    sidebar's entry-point badges (and the M2/M3 embedding pickers) filter on
    it, and it is server-owned anyway (`_apply_derived_metadata` recomputes it
    on every write). None for non-snippet kinds; a (possibly empty) list for
    `code_snippet` rows."""

    id: str
    kind: str
    name: str
    artifact_rev: int
    updated_at: datetime
    updated_by: str | None = None
    entry_points: list[str] | None = None
```

In `routes/artifacts.py`, extend `_header`:

```python
def _header(row: ArtifactRow) -> ArtifactHeaderOut:
    entry_points: list[str] | None = None
    if row.kind is ArtifactKind.code_snippet:
        raw = row.payload.get("entry_points")
        entry_points = [e for e in raw if isinstance(e, str)] if isinstance(raw, list) else []
    return ArtifactHeaderOut(
        id=row.id,
        kind=row.kind.value,
        name=row.name,
        artifact_rev=row.artifact_rev,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
        entry_points=entry_points,
    )
```

(`_full` already spreads `_header(row).model_dump()`, so `ArtifactOut` picks the field up unchanged.)

- [ ] **Step 4: Run tests**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -v`
Expected: all PASS (new + pre-existing).

- [ ] **Step 5: Full backend gates + commit**

Run: `pixi run test-core && pixi run lint-backend`
Expected: green.

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/artifacts.py tests/api/test_artifacts_routes.py
git commit -m "feat(snippets): surface server-derived entry_points on artifact headers (D6)"
```

---

### Task 2: API client — snippet schemas + `runSnippet`/`lintSnippet`/`cancelSnippet`

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (append snippet schemas; extend `ArtifactHeaderSchema` at line 358)
- Create: `frontend/src/lib/api/snippets.ts`
- Test: `frontend/src/lib/api/__tests__/snippets.test.ts`

**Interfaces:**
- Consumes: Task 1's `entry_points` header field; `Op` from `$lib/state/ops` (type-only import — the pattern `api/model-ops.ts` and `api/checkout.ts` already use).
- Produces (used by Tasks 4–8):
  - `types.ts`: `SnippetErrorSchema`/`SnippetError`, `SnippetDiagnosticSchema`/`SnippetDiagnostic`, `SnippetLintOutSchema`/`SnippetLintOut`, `SnippetRunOutSchema` (wire shape, `ops` as unknown records); `ArtifactHeaderSchema` gains `entry_points: z.array(z.string()).nullable().default(null)`.
  - `snippets.ts`: `type SnippetRunOut = Omit<z.infer<typeof SnippetRunOutSchema>, 'ops'> & { ops: Op[] }`; `interface SnippetRunBody { run_id: string; code?: string; artifact_id?: string; entry?: 'script' | 'value' | 'step'; element_id?: string }`; `runSnippet(body: SnippetRunBody, cfg?: ClientConfig): Promise<SnippetRunOut>`; `lintSnippet(code: string, cfg?: ClientConfig): Promise<SnippetLintOut>`; `cancelSnippet(runId: string, cfg?: ClientConfig): Promise<void>`.

- [ ] **Step 1: Write the failing MSW tests** — `frontend/src/lib/api/__tests__/snippets.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { cancelSnippet, lintSnippet, runSnippet } from '../snippets';

const BASE = 'http://api.test/api/v1/projects/p1';
const CFG = { baseUrl: BASE };

const RUN_OUT = {
	run_id: 'r-1',
	stdout: 'hello\n',
	result_repr: "'x'",
	ops: [{ kind: 'create_element', temp_id: 'tmp_1', type_name: 'Building', properties: { name: 'B' } }],
	error: null,
	duration_ms: 12,
	model_rev: 7,
	stale: false,
	truncated: false
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('snippets api', () => {
	it('runs inline code and parses the full response', async () => {
		server.use(
			http.post(`${BASE}/snippets/run`, async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				expect(body.run_id).toBe('r-1');
				expect(body.code).toBe('print(1)');
				expect(body.entry).toBe('script');
				return HttpResponse.json(RUN_OUT);
			})
		);
		const res = await runSnippet({ run_id: 'r-1', code: 'print(1)', entry: 'script' }, CFG);
		expect(res.stdout).toBe('hello\n');
		expect(res.ops[0].kind).toBe('create_element');
		expect(res.error).toBeNull();
	});

	it('parses an error result', async () => {
		server.use(
			http.post(`${BASE}/snippets/run`, () =>
				HttpResponse.json({
					...RUN_OUT,
					ops: [],
					result_repr: null,
					error: { kind: 'timeout', message: 'wall timeout', traceback: null }
				})
			)
		);
		const res = await runSnippet({ run_id: 'r-1', code: 'while 1: pass' }, CFG);
		expect(res.error?.kind).toBe('timeout');
	});

	it('lints code', async () => {
		server.use(
			http.post(`${BASE}/snippets/lint`, () =>
				HttpResponse.json({
					diagnostics: [{ line: 1, col: 0, severity: 'warning', message: "'os' is not available in the sandbox" }],
					entry_points: ['script', 'value']
				})
			)
		);
		const res = await lintSnippet('import os', CFG);
		expect(res.diagnostics[0].severity).toBe('warning');
		expect(res.entry_points).toContain('value');
	});

	it('cancels by run id', async () => {
		server.use(
			http.post(`${BASE}/snippets/cancel`, async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				expect(body.run_id).toBe('r-9');
				return new HttpResponse(null, { status: 204 });
			})
		);
		await cancelSnippet('r-9', CFG);
	});

	it('parses entry_points on artifact headers', async () => {
		const { listArtifacts } = await import('../artifacts');
		server.use(
			http.get(`${BASE}/artifacts`, () =>
				HttpResponse.json({
					items: [
						{ id: 'a1', kind: 'code_snippet', name: 's', artifact_rev: 1, updated_at: '2026-07-17T00:00:00Z', updated_by: null, entry_points: ['script'] },
						{ id: 'a2', kind: 'navigation', name: 'n', artifact_rev: 1, updated_at: '2026-07-17T00:00:00Z', updated_by: null }
					]
				})
			)
		);
		const res = await listArtifacts(undefined, CFG);
		expect(res.items[0].entry_points).toEqual(['script']);
		expect(res.items[1].entry_points).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/api/__tests__/snippets.test.ts'`
Expected: FAIL — cannot resolve `../snippets`.

- [ ] **Step 3: Implement** — append to `types.ts` (near the artifact schemas):

```ts
// Snippet execution — mirrors api/schemas.py SnippetRunOut/SnippetLintOut.
export const SnippetErrorSchema = z.object({
	kind: z.enum(['syntax', 'runtime', 'timeout', 'cancelled', 'memory', 'limit']),
	message: z.string(),
	traceback: z.string().nullable().default(null)
});
export type SnippetError = z.infer<typeof SnippetErrorSchema>;

export const SnippetDiagnosticSchema = z.object({
	line: z.number().int(),
	col: z.number().int(),
	severity: z.enum(['error', 'warning']),
	message: z.string()
});
export type SnippetDiagnostic = z.infer<typeof SnippetDiagnosticSchema>;

export const SnippetLintOutSchema = z.object({
	diagnostics: z.array(SnippetDiagnosticSchema),
	entry_points: z.array(z.string())
});
export type SnippetLintOut = z.infer<typeof SnippetLintOutSchema>;

/** Wire shape; `ops` is refined to `Op[]` in api/snippets.ts (types.ts cannot
 * import state/ops — state/ops imports Element/Relationship from here). */
export const SnippetRunOutSchema = z.object({
	run_id: z.string(),
	stdout: z.string(),
	result_repr: z.string().nullable(),
	ops: z.array(z.record(z.string(), z.unknown())),
	error: SnippetErrorSchema.nullable(),
	duration_ms: z.number().int(),
	model_rev: z.number().int(),
	stale: z.boolean(),
	truncated: z.boolean()
});
```

Extend `ArtifactHeaderSchema` with `entry_points: z.array(z.string()).nullable().default(null)`.

Create `frontend/src/lib/api/snippets.ts`:

```ts
import { apiFetch, type ClientConfig } from './client';
import { SnippetLintOutSchema, SnippetRunOutSchema, type SnippetLintOut } from './types';
import type { Op } from '$lib/state/ops';
import type { z } from 'zod';

/** SnippetRunOut with `ops` typed as the staged-buffer wire format — the
 * backend records ops in exactly the `state/ops.ts` shape (validated through
 * OPS_ADAPTER server-side), so the cast is the contract, not a guess. */
export type SnippetRunOut = Omit<z.infer<typeof SnippetRunOutSchema>, 'ops'> & { ops: Op[] };

export interface SnippetRunBody {
	run_id: string;
	code?: string;
	artifact_id?: string;
	entry?: 'script' | 'value' | 'step';
	element_id?: string;
}

export function runSnippet(body: SnippetRunBody, cfg?: ClientConfig): Promise<SnippetRunOut> {
	return apiFetch('/snippets/run', { method: 'POST', body, schema: SnippetRunOutSchema }, cfg) as Promise<SnippetRunOut>;
}

export function lintSnippet(code: string, cfg?: ClientConfig): Promise<SnippetLintOut> {
	return apiFetch('/snippets/lint', { method: 'POST', body: { code }, schema: SnippetLintOutSchema }, cfg);
}

export function cancelSnippet(runId: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch('/snippets/cancel', { method: 'POST', body: { run_id: runId } }, cfg);
}
```

(Match `apiFetch`'s actual option shape to the neighboring `api/artifacts.ts` — if the no-schema `cancelSnippet` form differs, copy `deleteArtifact`'s.)

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/api/__tests__/snippets.test.ts'`
Expected: PASS.

- [ ] **Step 5: Gates + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check && npm run lint'`
Expected: green.

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/snippets.ts frontend/src/lib/api/__tests__/snippets.test.ts
git commit -m "feat(snippets-ui): snippet API client + zod schemas, entry_points on artifact headers"
```

---

### Task 3: Snippet drafts — tab kind, store save lifecycle, unsaved wiring

**Files:**
- Modify: `frontend/src/lib/state/workspace.svelte.ts` (kind union + `PREFIX`)
- Create: `frontend/src/lib/state/snippet-editor.svelte.ts` (drafts + save; lint/run added in Task 4)
- Modify: `frontend/src/lib/state/artifacts.svelte.ts` (`createCodeSnippetArtifact`)
- Modify: `frontend/src/lib/state/unsaved.ts` (extend kind unions)
- Modify: `frontend/src/lib/state/index.ts` (barrel exports)
- Test: `frontend/src/lib/state/__tests__/snippet-editor.test.ts`; extend `frontend/src/lib/state/__tests__/unsaved.test.ts`

**Interfaces:**
- Consumes: `openArtifactTab`/`bindTabToArtifact`/`retitleTab` (workspace), `api.getArtifact`/`api.updateArtifact`/`api.createArtifact`, `ConflictError`.
- Produces (used by Tasks 4, 7, 8):
  - `workspace.svelte.ts`: `DynamicTab.kind: 'navigation' | 'table' | 'snippet'`; `PREFIX = { navigation: 'nav', table: 'tbl', snippet: 'snip' }`; snippet tab ids are `snip:draft:<n>` / `snip:<artifactId>`.
  - `snippet-editor.svelte.ts`: `interface SnippetDraft { name: string; artifactId: string | null; artifactRev: number | null; code: string; dirty: boolean; entryPoints: string[] }`; `getSnippetDraft(tabId: string): SnippetDraft | undefined`; `ensureSnippetDraft(tabId: string): Promise<SnippetDraft>`; `updateSnippetCode(tabId: string, code: string): void`; `setSnippetName(tabId: string, name: string): void`; `saveSnippetDraft(tabId: string): Promise<void>`; `getSnippetSaveConflict(tabId: string): number | undefined`; `reloadSnippetDraft(tabId: string): Promise<void>`; `closeSnippetDraft(tabId: string): void`; `hasDirtySnippetDrafts(): boolean`; `resetSnippetEditors(): void`; internal `rekeySnippetTab(oldTab: string, newTab: string): void` (Task 4 extends it).
  - `artifacts.svelte.ts`: `interface CodeSnippetPayload { schema_version: number; language: 'python'; code: string }`; `createCodeSnippetArtifact(name: string, payload: CodeSnippetPayload): Promise<Artifact>`.
  - `unsaved.ts`: `isTabDirty(kind: 'navigation' | 'table' | 'snippet', tabId)`; `isArtifactDirty(kind: 'navigation' | 'table' | 'code_snippet', artifactId)` (maps `code_snippet` → `snip:` prefix); `hasUnsavedWork()` includes `hasDirtySnippetDrafts()`.

- [ ] **Step 1: Write the failing tests** — `snippet-editor.test.ts` (mirror `navigation-editor.test.ts`'s spy pattern):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import {
	closeSnippetDraft,
	ensureSnippetDraft,
	getSnippetDraft,
	getSnippetSaveConflict,
	resetSnippetEditors,
	saveSnippetDraft,
	setSnippetName,
	updateSnippetCode
} from '../snippet-editor.svelte';
import { getDynamicTabs, openArtifactTab, resetWorkspaceTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';

const SNIPPET_ARTIFACT = {
	id: 's1',
	kind: 'code_snippet',
	name: 'My snippet',
	artifact_rev: 3,
	updated_at: '2026-07-17T00:00:00Z',
	updated_by: 'u1',
	entry_points: ['script', 'value'],
	payload: { schema_version: 1, language: 'python', code: 'print(1)\n', entry_points: ['script', 'value'] }
};

beforeEach(() => {
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
});
afterEach(() => {
	resetSnippetEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	vi.restoreAllMocks();
});

describe('snippet drafts', () => {
	it('creates a fresh draft for a snip:draft:* tab', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		expect(tabId).toMatch(/^snip:draft:/);
		const draft = await ensureSnippetDraft(tabId);
		expect(draft.artifactId).toBeNull();
		expect(draft.dirty).toBe(false);
		expect(draft.code).toContain('dr');
	});

	it('loads a saved artifact draft and adopts server entry points', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		const tabId = openArtifactTab('snippet', { artifactId: 's1', title: 'My snippet' });
		const draft = await ensureSnippetDraft(tabId);
		expect(draft.code).toBe('print(1)\n');
		expect(draft.artifactRev).toBe(3);
		expect(draft.entryPoints).toEqual(['script', 'value']);
	});

	it('marks dirty on edit and clean after save; first save rebinds the tab', async () => {
		const create = vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'print(2)\n');
		setSnippetName(tabId, 'My snippet');
		expect(getSnippetDraft(tabId)?.dirty).toBe(true);
		await saveSnippetDraft(tabId);
		expect(create).toHaveBeenCalledWith({
			kind: 'code_snippet',
			name: 'My snippet',
			payload: { schema_version: 1, language: 'python', code: 'print(2)\n' }
		});
		expect(getSnippetDraft(tabId)).toBeUndefined(); // moved to snip:s1
		const moved = getSnippetDraft('snip:s1');
		expect(moved?.dirty).toBe(false);
		expect(moved?.artifactId).toBe('s1');
		expect(getDynamicTabs().find((t) => t.id === 'snip:s1')).toBeDefined();
	});

	it('records a rev conflict on 409 with current_rev and clears it on reload', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		vi.spyOn(artifactsApi, 'updateArtifact').mockRejectedValue(
			new ConflictError(409, { detail: { message: 'stale', current_rev: 9 } }, 'stale')
		);
		const tabId = openArtifactTab('snippet', { artifactId: 's1', title: 'My snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'print(3)\n');
		await expect(saveSnippetDraft(tabId)).rejects.toThrow();
		expect(getSnippetSaveConflict(tabId)).toBe(9);
	});

	it('close drops the draft', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		closeSnippetDraft(tabId);
		expect(getSnippetDraft(tabId)).toBeUndefined();
	});
});
```

Extend `unsaved.test.ts` with (mirror its existing style):

```ts
it('snippet drafts drive isTabDirty/isArtifactDirty/hasUnsavedWork', async () => {
	const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
	await ensureSnippetDraft(tabId);
	expect(isTabDirty('snippet', tabId)).toBe(true); // never-saved draft counts
	expect(hasUnsavedWork()).toBe(true);
	expect(isArtifactDirty('code_snippet', 'nope')).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/state/__tests__/snippet-editor.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** `workspace.svelte.ts`: change `kind: 'navigation' | 'table'` to `kind: 'navigation' | 'table' | 'snippet'` (both in `DynamicTab` and `openArtifactTab`'s parameter) and `const PREFIX = { navigation: 'nav', table: 'tbl', snippet: 'snip' } as const;`. Leave the `initWorkspaceTabs` legacy default (`kind ?? 'navigation'`) untouched.

`artifacts.svelte.ts` — alongside `createTableArtifact`:

```ts
export interface CodeSnippetPayload {
	schema_version: number;
	language: 'python';
	code: string;
}

export async function createCodeSnippetArtifact(
	name: string,
	payload: CodeSnippetPayload
): Promise<Artifact> {
	const created = await api.createArtifact({
		kind: 'code_snippet',
		name,
		payload: payload as unknown as Record<string, unknown>
	});
	await loadArtifacts();
	return created;
}
```

`snippet-editor.svelte.ts` (new — drafts portion; module docstring should explain the per-tab keying and that lint/run state arrives in Task 4):

```ts
/**
 * Per-tab code-snippet drafts, keyed by workspace tab id (`snip:draft:<n>` /
 * `snip:<artifactId>`) — the snippet sibling of navigation-editor.svelte.ts.
 * This module owns the draft + save lifecycle; lint and run state (debounced
 * /snippets/lint, run/stop phases, generation guards) live here too (added
 * with the console work). `entryPoints` mirrors the SERVER-derived value
 * (adopted from artifact responses; a run's availability gating uses the
 * live lint response instead) — the client never sends it.
 */
import { SvelteMap } from 'svelte/reactivity';
import * as artifactsApi from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import { createCodeSnippetArtifact, loadArtifacts } from './artifacts.svelte';
import { bindTabToArtifact, retitleTab } from './workspace.svelte';

export interface SnippetDraft {
	name: string;
	artifactId: string | null;
	artifactRev: number | null;
	code: string;
	dirty: boolean;
	/** Server-derived (artifact responses); [] until first save/load. */
	entryPoints: string[];
}

const DEFAULT_CODE =
	'# Explore the model through the `dr` facade, e.g.:\n' +
	'# for el in dr.elements():\n' +
	'#     print(el.type, el.name)\n';

const _drafts = new SvelteMap<string, SnippetDraft>();
const _conflicts = new SvelteMap<string, number>(); // tabId -> server rev

export function getSnippetDraft(tabId: string): SnippetDraft | undefined {
	return _drafts.get(tabId);
}

export function getSnippetSaveConflict(tabId: string): number | undefined {
	return _conflicts.get(tabId);
}

export function hasDirtySnippetDrafts(): boolean {
	for (const d of _drafts.values()) if (d.dirty) return true;
	return false;
}

function payloadEntryPoints(payload: Record<string, unknown>): string[] {
	const raw = payload['entry_points'];
	return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
}

export async function ensureSnippetDraft(tabId: string): Promise<SnippetDraft> {
	const existing = _drafts.get(tabId);
	if (existing) return existing;
	let draft: SnippetDraft;
	if (tabId.startsWith('snip:draft:')) {
		draft = { name: 'New snippet', artifactId: null, artifactRev: null, code: DEFAULT_CODE, dirty: false, entryPoints: [] };
	} else {
		const artifact = await artifactsApi.getArtifact(tabId.slice('snip:'.length));
		const payload = artifact.payload as Record<string, unknown>;
		draft = {
			name: artifact.name,
			artifactId: artifact.id,
			artifactRev: artifact.artifact_rev,
			code: typeof payload['code'] === 'string' ? payload['code'] : '',
			dirty: false,
			entryPoints: artifact.entry_points ?? payloadEntryPoints(payload)
		};
	}
	_drafts.set(tabId, draft);
	return draft;
}

export function updateSnippetCode(tabId: string, code: string): void {
	const draft = _drafts.get(tabId);
	if (!draft || draft.code === code) return;
	_drafts.set(tabId, { ...draft, code, dirty: true });
}

export function setSnippetName(tabId: string, name: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, name, dirty: true });
	retitleTab(tabId, name);
}

/** Move per-tab state from a draft tab id to its post-save artifact id.
 * Task 4 extends this to carry lint/run state + timers/generations. */
function rekeySnippetTab(oldTab: string, newTab: string): void {
	const conflict = _conflicts.get(oldTab);
	if (conflict !== undefined) {
		_conflicts.delete(oldTab);
		_conflicts.set(newTab, conflict);
	}
}

export async function saveSnippetDraft(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = { schema_version: 1, language: 'python' as const, code: draft.code };
	try {
		if (draft.artifactId === null) {
			const created = await createCodeSnippetArtifact(draft.name, payload);
			bindTabToArtifact(tabId, created.id);
			const newTab = `snip:${created.id}`;
			_drafts.delete(tabId);
			_drafts.set(newTab, {
				...draft,
				artifactId: created.id,
				artifactRev: created.artifact_rev,
				dirty: false,
				entryPoints: created.entry_points ?? payloadEntryPoints(created.payload as Record<string, unknown>)
			});
			rekeySnippetTab(tabId, newTab);
		} else {
			const updated = await artifactsApi.updateArtifact(draft.artifactId, {
				artifact_rev: draft.artifactRev ?? 1,
				name: draft.name,
				payload
			});
			_drafts.set(tabId, {
				...draft,
				artifactRev: updated.artifact_rev,
				dirty: false,
				entryPoints: updated.entry_points ?? payloadEntryPoints(updated.payload as Record<string, unknown>)
			});
			_conflicts.delete(tabId);
			await loadArtifacts().catch(() => {});
		}
	} catch (err) {
		// Same structural 409 discrimination as navigation-editor.saveDraft:
		// only an object detail carrying a numeric current_rev is a REV
		// conflict; the create/rename name-clash 409 has a string detail and
		// must NOT enter conflict state (its recovery would wipe the draft).
		if (err instanceof ConflictError) {
			const detail = (err.body as { detail?: unknown } | undefined)?.detail;
			if (detail !== null && typeof detail === 'object' && typeof (detail as { current_rev?: unknown }).current_rev === 'number') {
				_conflicts.set(tabId, (detail as { current_rev: number }).current_rev);
			}
		}
		throw err;
	}
}

/** Discard the local draft and re-fetch the server copy (409 recovery). */
export async function reloadSnippetDraft(tabId: string): Promise<void> {
	_drafts.delete(tabId);
	_conflicts.delete(tabId);
	await ensureSnippetDraft(tabId);
}

export function closeSnippetDraft(tabId: string): void {
	_drafts.delete(tabId);
	_conflicts.delete(tabId);
}

export function resetSnippetEditors(): void {
	_drafts.clear();
	_conflicts.clear();
}
```

`unsaved.ts` — extend both unions and the mapping:

```ts
import { getSnippetDraft, hasDirtySnippetDrafts } from './snippet-editor.svelte';

export function hasUnsavedWork(): boolean {
	return hasStagedOps() || hasDirtyTableDrafts() || hasDirtyNavDrafts() || hasDirtySnippetDrafts();
}

export function isTabDirty(kind: 'navigation' | 'table' | 'snippet', tabId: string): boolean {
	const draft =
		kind === 'table' ? getTableDraft(tabId) : kind === 'snippet' ? getSnippetDraft(tabId) : getDraft(tabId);
	if (!draft) return false;
	return draft.dirty || draft.artifactId === null;
}

export function isArtifactDirty(
	kind: 'navigation' | 'table' | 'code_snippet',
	artifactId: string
): boolean {
	if (kind === 'code_snippet') return isTabDirty('snippet', `snip:${artifactId}`);
	return isTabDirty(kind, `${kind === 'table' ? 'tbl' : 'nav'}:${artifactId}`);
}
```

`state/index.ts`: export `getSnippetDraft, ensureSnippetDraft, updateSnippetCode, setSnippetName, saveSnippetDraft, getSnippetSaveConflict, reloadSnippetDraft, closeSnippetDraft, resetSnippetEditors` from `./snippet-editor.svelte` and `createCodeSnippetArtifact` from `./artifacts.svelte` (follow the barrel's existing grouping style). Check where `resetNavigationEditors`/`resetArtifacts` are called on project close/switch (grep `resetNavigationEditors` call sites, e.g. the project page teardown / `resetAllStores`-style aggregator) and add `resetSnippetEditors()` beside them.

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/state/__tests__/snippet-editor.test.ts src/lib/state/__tests__/unsaved.test.ts src/lib/state/__tests__/workspace.test.ts'`
Expected: PASS (workspace.test.ts still green).

- [ ] **Step 5: Gates + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check && npm run lint'`
Expected: green.

```bash
git add frontend/src/lib/state/workspace.svelte.ts frontend/src/lib/state/snippet-editor.svelte.ts frontend/src/lib/state/artifacts.svelte.ts frontend/src/lib/state/unsaved.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/snippet-editor.test.ts frontend/src/lib/state/__tests__/unsaved.test.ts
git commit -m "feat(snippets-ui): snippet draft store + 'snippet' workspace tab kind + unsaved wiring"
```

---

### Task 4: Snippet store — lint debounce, run/stop, element context

**Files:**
- Modify: `frontend/src/lib/state/snippet-editor.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts`
- Test: extend `frontend/src/lib/state/__tests__/snippet-editor.test.ts`

**Interfaces:**
- Consumes: Task 2's `runSnippet`/`lintSnippet`/`cancelSnippet` + `SnippetRunOut`; Task 3's draft store; `ApiError` from `$lib/api/errors`.
- Produces (used by Tasks 5, 7):
  - `interface SnippetLintState { diagnostics: SnippetDiagnostic[]; entryPoints: string[] }`; `getSnippetLint(tabId: string): SnippetLintState | undefined`.
  - `type SnippetRunPhase = 'idle' | 'running' | 'stopping'`; `interface SnippetRunState { phase: SnippetRunPhase; runId: string | null; result: SnippetRunOut | null; stagedRunId: string | null; notice: string | null; entry: 'script' | 'value' | 'step'; elementId: string | null; elementLabel: string | null }`; `getSnippetRun(tabId: string): SnippetRunState`.
  - `setSnippetEntry(tabId, entry)`; `setSnippetElementContext(tabId, elementId: string | null, label: string | null)`; `runSnippetTab(tabId): Promise<void>`; `stopSnippetTab(tabId): Promise<void>`; `markRunStaged(tabId): void`; `LINT_DEBOUNCE_MS = 300` (exported for tests).
  - `updateSnippetCode` now also schedules the debounced lint; `ensureSnippetDraft` fires an immediate lint on open; `closeSnippetDraft`/`resetSnippetEditors` cancel timers + bump generations; `rekeySnippetTab` carries lint/run state.

- [ ] **Step 1: Write the failing tests** — append to `snippet-editor.test.ts`:

```ts
import * as snippetsApi from '$lib/api/snippets';
import { ApiError } from '$lib/api/errors';
import {
	getSnippetLint,
	getSnippetRun,
	LINT_DEBOUNCE_MS,
	markRunStaged,
	runSnippetTab,
	setSnippetElementContext,
	setSnippetEntry,
	stopSnippetTab
} from '../snippet-editor.svelte';

const RUN_OUT = {
	run_id: 'r-1',
	stdout: 'hello\n',
	result_repr: null,
	ops: [],
	error: null,
	duration_ms: 5,
	model_rev: 0,
	stale: false,
	truncated: false
};

describe('snippet lint + run', () => {
	it('debounces lint and applies the latest response', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [{ line: 1, col: 0, severity: 'warning', message: 'w' }],
			entry_points: ['script']
		});
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		lint.mockClear(); // drop the open-time immediate lint
		updateSnippetCode(tabId, 'import os\n');
		updateSnippetCode(tabId, 'import os  #\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		expect(lint).toHaveBeenCalledTimes(1);
		expect(lint).toHaveBeenCalledWith('import os  #\n');
		expect(getSnippetLint(tabId)?.diagnostics).toHaveLength(1);
		vi.useRealTimers();
	});

	it('runs and installs the result', async () => {
		vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'print("hello")\n');
		await runSnippetTab(tabId);
		const rs = getSnippetRun(tabId);
		expect(rs.phase).toBe('idle');
		expect(rs.result?.stdout).toBe('hello\n');
	});

	it('sends entry + element_id for a value run', async () => {
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');
		setSnippetElementContext(tabId, 'e1', 'Building e1');
		await runSnippetTab(tabId);
		expect(run.mock.calls[0][0]).toMatchObject({ entry: 'value', element_id: 'e1' });
	});

	it('stop discards the eventual response', async () => {
		let resolveRun!: (v: typeof RUN_OUT) => void;
		vi.spyOn(snippetsApi, 'runSnippet').mockReturnValue(new Promise((r) => (resolveRun = r)));
		vi.spyOn(snippetsApi, 'cancelSnippet').mockResolvedValue(undefined);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		const running = runSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('running');
		await stopSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('idle');
		expect(getSnippetRun(tabId).notice).toContain('wall timeout');
		resolveRun(RUN_OUT);
		await running;
		expect(getSnippetRun(tabId).result).toBeNull(); // discarded
	});

	it('maps 429 and 503 to notices', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		vi.spyOn(snippetsApi, 'runSnippet').mockRejectedValue(new ApiError(429, null, 'busy'));
		await runSnippetTab(tabId);
		expect(getSnippetRun(tabId).notice).toContain('already in progress');
		vi.spyOn(snippetsApi, 'runSnippet').mockRejectedValue(new ApiError(503, null, 'no runner'));
		await runSnippetTab(tabId);
		expect(getSnippetRun(tabId).notice).toContain('unavailable');
	});

	it('markRunStaged pins the staged run id', async () => {
		vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		await runSnippetTab(tabId);
		markRunStaged(tabId);
		expect(getSnippetRun(tabId).stagedRunId).toBe('r-1');
	});
});
```

(The open-time immediate lint in the debounce test: `ensureSnippetDraft` fires it; `mockClear()` isolates the debounced path.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/state/__tests__/snippet-editor.test.ts'`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement** — add to `snippet-editor.svelte.ts`:

```ts
import * as snippetsApi from '$lib/api/snippets';
import type { SnippetRunOut } from '$lib/api/snippets';
import type { SnippetDiagnostic } from '$lib/api/types';
import { ApiError } from '$lib/api/errors';

export const LINT_DEBOUNCE_MS = 300;

export interface SnippetLintState {
	diagnostics: SnippetDiagnostic[];
	entryPoints: string[];
}

export type SnippetRunPhase = 'idle' | 'running' | 'stopping';

export interface SnippetRunState {
	phase: SnippetRunPhase;
	runId: string | null;
	result: SnippetRunOut | null;
	/** run_id of the last result whose ops were staged (disables re-staging). */
	stagedRunId: string | null;
	notice: string | null;
	entry: 'script' | 'value' | 'step';
	elementId: string | null;
	elementLabel: string | null;
}

const IDLE_RUN: SnippetRunState = {
	phase: 'idle', runId: null, result: null, stagedRunId: null,
	notice: null, entry: 'script', elementId: null, elementLabel: null
};

const _lint = new SvelteMap<string, SnippetLintState>();
const _runs = new SvelteMap<string, SnippetRunState>();
// Control state — never read from templates.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _lintTimers = new Map<string, ReturnType<typeof setTimeout>>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _lintGenerations = new Map<string, number>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _runGenerations = new Map<string, number>();

function bump(map: Map<string, number>, tabId: string): number {
	const next = (map.get(tabId) ?? 0) + 1;
	map.set(tabId, next);
	return next;
}

export function getSnippetLint(tabId: string): SnippetLintState | undefined {
	return _lint.get(tabId);
}
export function getSnippetRun(tabId: string): SnippetRunState {
	return _runs.get(tabId) ?? IDLE_RUN;
}
function setRun(tabId: string, patch: Partial<SnippetRunState>): void {
	_runs.set(tabId, { ...getSnippetRun(tabId), ...patch });
}
export function setSnippetEntry(tabId: string, entry: 'script' | 'value' | 'step'): void {
	setRun(tabId, { entry });
}
export function setSnippetElementContext(tabId: string, elementId: string | null, label: string | null): void {
	setRun(tabId, { elementId, elementLabel: label });
}
export function markRunStaged(tabId: string): void {
	const rs = getSnippetRun(tabId);
	if (rs.result) setRun(tabId, { stagedRunId: rs.result.run_id });
}

async function lintNow(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const gen = bump(_lintGenerations, tabId);
	try {
		const out = await snippetsApi.lintSnippet(draft.code);
		if (_lintGenerations.get(tabId) !== gen || !_drafts.has(tabId)) return;
		_lint.set(tabId, { diagnostics: out.diagnostics, entryPoints: out.entry_points });
	} catch {
		// Lint is advisory: a failed request just leaves the last diagnostics.
	}
}

function scheduleLint(tabId: string): void {
	const existing = _lintTimers.get(tabId);
	if (existing !== undefined) clearTimeout(existing);
	_lintTimers.set(
		tabId,
		setTimeout(() => {
			_lintTimers.delete(tabId);
			void lintNow(tabId);
		}, LINT_DEBOUNCE_MS)
	);
}

export async function runSnippetTab(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	const rs = getSnippetRun(tabId);
	if (!draft || rs.phase !== 'idle') return;
	if (rs.entry !== 'script' && rs.elementId === null) return; // UI disables Run too
	const runId = crypto.randomUUID();
	const gen = bump(_runGenerations, tabId);
	setRun(tabId, { phase: 'running', runId, notice: null });
	try {
		const out = await snippetsApi.runSnippet({
			run_id: runId,
			code: draft.code,
			entry: rs.entry,
			element_id: rs.entry === 'script' ? undefined : (rs.elementId ?? undefined)
		});
		if (_runGenerations.get(tabId) !== gen || !_drafts.has(tabId)) return; // stopped/closed/newer
		setRun(tabId, { phase: 'idle', runId: null, result: out });
	} catch (err) {
		if (_runGenerations.get(tabId) !== gen || !_drafts.has(tabId)) return;
		const notice =
			err instanceof ApiError && err.status === 429
				? 'Another run is already in progress — wait for it to finish.'
				: err instanceof ApiError && err.status === 503
					? 'Code execution is unavailable on this server.'
					: 'Run failed — check your connection and try again.';
		setRun(tabId, { phase: 'idle', runId: null, notice });
	}
}

/** Honest Stop (spec D3): the M1 abort is a no-op server-side — the run ends
 * only at wall_timeout_s. We cancel (deregisters + authorizes), orphan the
 * in-flight response via the generation bump, and say so. Until the server
 * slot frees, a new run may 429 (per-user cap) — that is honest too. */
export async function stopSnippetTab(tabId: string): Promise<void> {
	const rs = getSnippetRun(tabId);
	if (rs.phase !== 'running' || rs.runId === null) return;
	setRun(tabId, { phase: 'stopping' });
	bump(_runGenerations, tabId); // discard the eventual response
	try {
		await snippetsApi.cancelSnippet(rs.runId);
	} catch {
		// 404 = run already finished or not ours anymore — nothing to do.
	}
	setRun(tabId, {
		phase: 'idle', runId: null,
		notice: 'Run stopped — the server ends it at the wall timeout.'
	});
}
```

Wire into the Task 3 functions:
- `ensureSnippetDraft`: after `_drafts.set(tabId, draft)`, call `void lintNow(tabId)` (immediate — gutter + entry availability without requiring an edit, mirroring the nav editor's open-run).
- `updateSnippetCode`: after setting the draft, call `scheduleLint(tabId)`.
- `rekeySnippetTab`: also move `_lint`/`_runs` entries, cancel+clear the old tab's `_lintTimers` entry and re-`scheduleLint(newTab)` if one was pending, and bump both generation maps for the old id (orphan in-flight responses; mirror `navigation-editor.rekeyTab`'s reschedule discipline).
- `closeSnippetDraft`: cancel the tab's lint timer, delete `_lint`/`_runs` entries, bump both generations.
- `resetSnippetEditors`: clear all timers/maps, bump all generations.

Export the new functions from `state/index.ts`.

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/state/__tests__/snippet-editor.test.ts'`
Expected: PASS.

- [ ] **Step 5: Gates + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check && npm run lint'`
Expected: green.

```bash
git add frontend/src/lib/state/snippet-editor.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/snippet-editor.test.ts
git commit -m "feat(snippets-ui): lint debounce + run/stop with generation guards + element context"
```

---

### Task 5: Stage ops — remap, prefetch, locks, emit

**Files:**
- Modify: `frontend/src/lib/state/edit-gate.ts` (export the batch primitive)
- Create: `frontend/src/lib/state/snippet-stage.ts`
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/snippet-stage.test.ts`; extend `frontend/src/lib/state/__tests__/edit-gate.test.ts` if it asserts the export surface

**Interfaces:**
- Consumes: `emit`/`ensureElement`/`ensureRelationship`/`getModelRev` (`model.svelte.ts`), `ensureCheckout` (via the new `acquireLocks`), `setLockNotice`, `createTempId`/`isTempId`/`Op` (`ops.ts`), `remapProperties`/`remapValue` (`remap.ts`), `SnippetRunOut` (Task 2), `markRunStaged` (Task 4 — called by the component in Task 7, not here).
- Produces (used by Task 7):
  - `edit-gate.ts`: `acquireLocks(targets: LockTargetIn[], intent: LockIntent): Promise<boolean>` — the existing private `gate` renamed/exported (it already sets/clears the lock notice); `editLock`/`connectLock`/`deleteLock` now call it.
  - `snippet-stage.ts`: `type StageOutcome = { ok: true; count: number } | { ok: false; reason: 'empty' | 'stale' | 'locks' | 'missing' }`; `stageSnippetOps(result: SnippetRunOut): Promise<StageOutcome>`.

- [ ] **Step 1: Write the failing tests** — `snippet-stage.test.ts`. Mock at module level with `vi.spyOn`; seed the model store the way `model.staged.test.ts` seeds it (`seedElements`/`seedRelationships` + `resetModelStore` in afterEach — copy that file's setup helpers):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stageSnippetOps } from '../snippet-stage';
import * as checkout from '../checkout.svelte';
import {
	getCachedElements,
	getStagedOps,
	resetModelStore,
	seedElements,
	seedRelationships
} from '../model.svelte';
import { isTempId } from '../ops';
import type { SnippetRunOut } from '$lib/api/snippets';

const EL = { id: 'e1', type_name: 'Building', properties: { name: 'Town Hall' } };
const REL = { id: 'r1', type_name: 'Owns', source_id: 'e1', target_id: 'e2', properties: {} };

function runOut(ops: SnippetRunOut['ops'], overrides: Partial<SnippetRunOut> = {}): SnippetRunOut {
	return {
		run_id: 'r-1', stdout: '', result_repr: null, ops, error: null,
		duration_ms: 1, model_rev: 0, stale: false, truncated: false, ...overrides
	};
}

beforeEach(() => {
	seedElements([EL, { id: 'e2', type_name: 'District', properties: {} }]);
	seedRelationships([REL]);
	vi.spyOn(checkout, 'ensureCheckout').mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
	resetModelStore();
	vi.restoreAllMocks();
});

describe('stageSnippetOps', () => {
	it('refuses empty and stale batches', async () => {
		expect(await stageSnippetOps(runOut([]))).toEqual({ ok: false, reason: 'empty' });
		const ops = [{ kind: 'update_element', id: 'e1', properties_patch: { name: 'X' } }] as SnippetRunOut['ops'];
		expect(await stageSnippetOps(runOut(ops, { stale: true }))).toEqual({ ok: false, reason: 'stale' });
		expect(await stageSnippetOps(runOut(ops, { model_rev: 99 }))).toEqual({ ok: false, reason: 'stale' });
	});

	it('remaps facade temp ids to fresh client temp ids across the batch', async () => {
		const ops = [
			{ kind: 'create_element', temp_id: 'tmp_1', type_name: 'Building', properties: { name: 'New B' } },
			{ kind: 'create_element', temp_id: 'tmp_2', type_name: 'District', properties: {} },
			{ kind: 'create_relationship', temp_id: 'tmp_3', type_name: 'Owns', source_id: 'tmp_2', target_id: 'tmp_1', properties: {} }
		] as SnippetRunOut['ops'];
		const res = await stageSnippetOps(runOut(ops));
		expect(res).toEqual({ ok: true, count: 3 });
		const staged = getStagedOps();
		const [c1, c2, rel] = staged as [
			Extract<(typeof staged)[number], { kind: 'create_element' }>,
			Extract<(typeof staged)[number], { kind: 'create_element' }>,
			Extract<(typeof staged)[number], { kind: 'create_relationship' }>
		];
		expect(c1.temp_id).not.toBe('tmp_1'); // fresh, collision-free
		expect(isTempId(c1.temp_id)).toBe(true);
		expect(rel.source_id).toBe(c2.temp_id);
		expect(rel.target_id).toBe(c1.temp_id);
	});

	it('acquires locks per intent group and stages nothing on refusal', async () => {
		const ensure = vi
			.spyOn(checkout, 'ensureCheckout')
			.mockResolvedValue({ ok: false, reason: 'conflict', conflicts: [] } as never);
		const ops = [{ kind: 'update_element', id: 'e1', properties_patch: { name: 'X' } }] as SnippetRunOut['ops'];
		const res = await stageSnippetOps(runOut(ops));
		expect(res).toEqual({ ok: false, reason: 'locks' });
		expect(getStagedOps()).toHaveLength(0);
		expect(ensure).toHaveBeenCalledWith([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
	});

	it('derives connect + delete lock targets, skipping temp-id endpoints', async () => {
		const ensure = vi.spyOn(checkout, 'ensureCheckout').mockResolvedValue({ ok: true } as never);
		const ops = [
			{ kind: 'create_element', temp_id: 'tmp_1', type_name: 'Building', properties: {} },
			{ kind: 'create_relationship', temp_id: 'tmp_2', type_name: 'Owns', source_id: 'e1', target_id: 'tmp_1', properties: {} },
			{ kind: 'delete_relationship', id: 'r1' }
		] as SnippetRunOut['ops'];
		const res = await stageSnippetOps(runOut(ops));
		expect(res.ok).toBe(true);
		const intents = ensure.mock.calls.map(([targets, intent]) => [intent, targets]);
		expect(intents).toContainEqual(['connect', [{ resource_id: 'e1', mode: 'exclusive' }]]);
		// delete_relationship locks its SOURCE element (RelationshipsList pattern)
		expect(intents).toContainEqual(['delete', [{ resource_id: 'e1', mode: 'exclusive' }]]);
	});

	it('applies staged ops optimistically (update visible in cache)', async () => {
		const ops = [{ kind: 'update_element', id: 'e1', properties_patch: { name: 'Renamed' } }] as SnippetRunOut['ops'];
		await stageSnippetOps(runOut(ops));
		expect(getCachedElements().get('e1')?.properties.name).toBe('Renamed');
	});
});
```

(If `seedElements`/`seedRelationships` signatures differ from the literal shapes above, copy the element/relationship fixture shapes from `model.staged.test.ts` — the assertions are the contract.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/state/__tests__/snippet-stage.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** In `edit-gate.ts`, rename `gate` → exported `acquireLocks` (keep `explain` private; `editLock`/`connectLock`/`deleteLock` delegate to it unchanged).

Create `snippet-stage.ts`:

```ts
/**
 * Folds a snippet run's dry-run op batch into the staged-edits buffer so it
 * becomes indistinguishable from manual edits (optimistic apply, client-side
 * undo, DiffDrawer, commit, lock release). Three concerns the facade cannot
 * handle guest-side:
 *
 * 1. TEMP-ID REMAP — the facade numbers temp ids per run (`tmp_1`, ...), so
 *    two staged batches would collide; every batch gets fresh `createTempId()`
 *    ids, rewritten across `temp_id`/`source_id`/`target_id` AND ref-shaped
 *    property values (remapProperties).
 * 2. PRE-STATE PREFETCH — update/delete targets may be uncached (the snippet
 *    saw the server model, not the client cache); `emit`'s optimistic journal
 *    needs the entity present to record real pre-state, and relationship ops
 *    need the rel's source_id for lock derivation.
 * 3. LOCKS — one acquireLocks call per intent group (edit/connect/delete),
 *    mirroring what the manual UI acquires for the same edits. Any refusal
 *    stages NOTHING (already-acquired leases from earlier groups just expire
 *    via TTL — same as a user who locked an element and never edited it).
 */
import type { Op } from './ops';
import { createTempId, isTempId } from './ops';
import { remapProperties } from './remap';
import { emit, ensureElement, ensureRelationship, getModelRev } from './model.svelte';
import { acquireLocks } from './edit-gate';
import type { SnippetRunOut } from '$lib/api/snippets';
import type { LockTargetIn } from '$lib/api/types';

export type StageOutcome =
	| { ok: true; count: number }
	| { ok: false; reason: 'empty' | 'stale' | 'locks' | 'missing' };

export async function stageSnippetOps(result: SnippetRunOut): Promise<StageOutcome> {
	if (result.ops.length === 0) return { ok: false, reason: 'empty' };
	if (result.stale || result.model_rev !== getModelRev()) return { ok: false, reason: 'stale' };

	// 1. Remap facade temp ids to fresh client temp ids.
	const mapping: Record<string, string> = {};
	for (const op of result.ops) {
		if (op.kind === 'create_element' || op.kind === 'create_relationship') {
			mapping[op.temp_id] = createTempId();
		}
	}
	const mapId = (id: string): string => mapping[id] ?? id;
	const ops: Op[] = result.ops.map((op) => {
		switch (op.kind) {
			case 'create_element':
				return { ...op, temp_id: mapping[op.temp_id], properties: remapProperties(op.properties, mapping) };
			case 'create_relationship':
				return {
					...op,
					temp_id: mapping[op.temp_id],
					source_id: mapId(op.source_id),
					target_id: mapId(op.target_id),
					properties: remapProperties(op.properties, mapping)
				};
			case 'update_element':
			case 'update_relationship':
				return { ...op, properties_patch: remapProperties(op.properties_patch, mapping) };
			default:
				return op;
		}
	});

	// 2. Prefetch pre-state; resolve relationship sources for lock targets.
	const relSource = new Map<string, string>();
	for (const op of ops) {
		if ((op.kind === 'update_element' || op.kind === 'delete_element') && !isTempId(op.id)) {
			if ((await ensureElement(op.id)) === null) return { ok: false, reason: 'missing' };
		}
		if ((op.kind === 'update_relationship' || op.kind === 'delete_relationship') && !isTempId(op.id)) {
			const rel = await ensureRelationship(op.id);
			if (rel === null) return { ok: false, reason: 'missing' };
			relSource.set(op.id, rel.source_id);
		}
	}

	// 3. Locks, grouped by intent — the same targets the manual UI acquires:
	//    edit   -> exclusive on updated elements / updated rels' sources
	//    delete -> exclusive on deleted elements / deleted rels' sources
	//    connect-> exclusive source + shared target per created relationship
	const edit = new Map<string, LockTargetIn>();
	const del = new Map<string, LockTargetIn>();
	const connect = new Map<string, LockTargetIn>();
	for (const op of ops) {
		if (op.kind === 'update_element' && !isTempId(op.id)) {
			edit.set(op.id, { resource_id: op.id, mode: 'exclusive' });
		} else if (op.kind === 'delete_element' && !isTempId(op.id)) {
			del.set(op.id, { resource_id: op.id, mode: 'exclusive' });
		} else if (op.kind === 'update_relationship' && !isTempId(op.id)) {
			const src = relSource.get(op.id);
			if (src !== undefined) edit.set(src, { resource_id: src, mode: 'exclusive' });
		} else if (op.kind === 'delete_relationship' && !isTempId(op.id)) {
			const src = relSource.get(op.id);
			if (src !== undefined) del.set(src, { resource_id: src, mode: 'exclusive' });
		} else if (op.kind === 'create_relationship') {
			if (!isTempId(op.source_id)) connect.set(op.source_id, { resource_id: op.source_id, mode: 'exclusive' });
			if (!isTempId(op.target_id) && !connect.has(op.target_id)) {
				connect.set(op.target_id, { resource_id: op.target_id, mode: 'shared' });
			}
		}
	}
	const groups: Array<[LockTargetIn[], 'edit' | 'delete' | 'connect']> = [
		[[...edit.values()], 'edit'],
		[[...connect.values()], 'connect'],
		[[...del.values()], 'delete']
	];
	for (const [targets, intent] of groups) {
		if (targets.length === 0) continue;
		if (!(await acquireLocks(targets, intent))) return { ok: false, reason: 'locks' };
	}

	// 4. Stage — indistinguishable from manual edits from here on.
	for (const op of ops) emit(op);
	return { ok: true, count: ops.length };
}
```

Export `stageSnippetOps` (and `acquireLocks`) from `state/index.ts`.

(Check `LockIntent`'s actual literal values in `api/types.ts` — if the delete intent is spelled differently (e.g. `'delete'` vs `'delete-subtree'`), use the value `deleteLock` passes.)

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/state/__tests__/snippet-stage.test.ts src/lib/state/__tests__/edit-gate.test.ts'`
Expected: PASS.

- [ ] **Step 5: Gates + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check && npm run lint'`
Expected: green.

```bash
git add frontend/src/lib/state/snippet-stage.ts frontend/src/lib/state/edit-gate.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/snippet-stage.test.ts
git commit -m "feat(snippets-ui): stage snippet ops — temp-id remap, pre-state prefetch, lock groups, emit"
```

---

### Task 6: CodeMirror 6 — dependency, lint mapping, editor wrapper

**Files:**
- Modify: `frontend/package.json` (+ lockfile) — new devDependencies
- Create: `frontend/src/lib/editor/lint-map.ts`
- Create: `frontend/src/lib/components/Snippet/CodeEditor.svelte`
- Test: `frontend/src/lib/editor/__tests__/lint-map.test.ts`

**Interfaces:**
- Consumes: `SnippetDiagnostic` (Task 2).
- Produces (used by Task 7):
  - `lint-map.ts`: `toCmDiagnostics(doc: Text, diags: SnippetDiagnostic[]): Diagnostic[]` (CM `Text`/`Diagnostic` types).
  - `CodeEditor.svelte` props: `{ code: string; diagnostics: SnippetDiagnostic[]; onChange: (code: string) => void; onRun: () => void }`; exported method `goToLine(line: number): void`. Renders `.cm-editor` with Python highlighting, `lintGutter()`, and a `Mod-Enter` keymap bound to `onRun`.

- [ ] **Step 1: Install the dependency** (inside `frontend/` — never from the repo root):

Run: `pixi run -e frontend bash -c 'cd frontend && npm install -D codemirror @codemirror/lang-python @codemirror/lint'`
Expected: package.json devDependencies gain the three packages (@codemirror/state, view etc. arrive transitively).

- [ ] **Step 2: Write the failing test** — `lint-map.test.ts` (pure, no DOM):

```ts
import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { toCmDiagnostics } from '../lint-map';

const doc = Text.of(['import os', 'print(x)']);

describe('toCmDiagnostics', () => {
	it('maps 1-based line + 0-based col to doc offsets', () => {
		const [d] = toCmDiagnostics(doc, [{ line: 2, col: 6, severity: 'warning', message: 'unknown name x' }]);
		expect(d.from).toBe(doc.line(2).from + 6);
		expect(d.to).toBe(doc.line(2).to);
		expect(d.severity).toBe('warning');
	});

	it('clamps col overflow to the line end and drops out-of-range lines', () => {
		const [d] = toCmDiagnostics(doc, [{ line: 1, col: 999, severity: 'error', message: 'boom' }]);
		expect(d.from).toBe(doc.line(1).to);
		expect(toCmDiagnostics(doc, [{ line: 99, col: 0, severity: 'error', message: 'gone' }])).toHaveLength(0);
	});
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/editor/__tests__/lint-map.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement.** `lint-map.ts`:

```ts
import type { Text } from '@codemirror/state';
import type { Diagnostic } from '@codemirror/lint';
import type { SnippetDiagnostic } from '$lib/api/types';

/** Server lint speaks 1-based lines / 0-based cols; CM wants doc offsets.
 * Out-of-range lines (stale lint vs a shorter doc) are dropped, cols clamp
 * to the line end, and the range runs to end-of-line (a squiggle under the
 * rest of the line beats a zero-width mark). */
export function toCmDiagnostics(doc: Text, diags: SnippetDiagnostic[]): Diagnostic[] {
	return diags.flatMap((d) => {
		if (d.line < 1 || d.line > doc.lines) return [];
		const line = doc.line(d.line);
		const from = Math.min(line.from + Math.max(0, d.col), line.to);
		return [{ from, to: line.to, severity: d.severity, message: d.message }];
	});
}
```

`CodeEditor.svelte` — thin, logic-free (CM6 does not run under happy-dom; everything testable lives in `lint-map.ts` and the stores):

```svelte
<script lang="ts">
	import { untrack } from 'svelte';
	import { basicSetup } from 'codemirror';
	import { EditorView, keymap } from '@codemirror/view';
	import { python } from '@codemirror/lang-python';
	import { lintGutter, setDiagnostics } from '@codemirror/lint';
	import { toCmDiagnostics } from '$lib/editor/lint-map';
	import type { SnippetDiagnostic } from '$lib/api/types';

	let {
		code,
		diagnostics = [],
		onChange,
		onRun
	}: {
		code: string;
		diagnostics?: SnippetDiagnostic[];
		onChange: (code: string) => void;
		onRun: () => void;
	} = $props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;

	export function goToLine(line: number): void {
		if (!view || line < 1 || line > view.state.doc.lines) return;
		const pos = view.state.doc.line(line).from;
		view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
		view.focus();
	}

	// Creation must NOT reactively track `code`/handlers — tracking them would
	// destroy and recreate the editor on every keystroke. The listeners call
	// the CURRENT props (props stay live bindings), so untrack is safe.
	$effect(() => {
		view = untrack(
			() =>
				new EditorView({
					parent: host,
					doc: code,
					extensions: [
						basicSetup,
						python(),
						lintGutter(),
						keymap.of([{ key: 'Mod-Enter', run: () => (onRun(), true) }]),
						EditorView.updateListener.of((u) => {
							if (u.docChanged) onChange(u.state.doc.toString());
						})
					]
				})
		);
		return () => view?.destroy();
	});

	// External code replacement (draft load/reload) — not user typing.
	$effect(() => {
		if (view && code !== view.state.doc.toString()) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
		}
	});

	$effect(() => {
		if (view) view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, diagnostics)));
	});
</script>

<div bind:this={host} class="h-full overflow-auto text-sm" data-testid="snippet-editor"></div>
```

- [ ] **Step 5: Run tests + gates**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check && npm run lint'`
Expected: green (lint-map test passes; the .svelte file type-checks).

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/editor frontend/src/lib/components/Snippet/CodeEditor.svelte
git commit -m "feat(snippets-ui): CodeMirror 6 editor wrapper + server-lint diagnostics mapping"
```

---

### Task 7: SnippetTab — console, element picker, workspace wiring

**Files:**
- Create: `frontend/src/lib/snippet/console-view.ts` (pure view-model helpers)
- Create: `frontend/src/lib/components/Snippet/SnippetTab.svelte`
- Create: `frontend/src/lib/components/Snippet/SnippetConsole.svelte`
- Create: `frontend/src/lib/components/Snippet/ElementContextRow.svelte`
- Modify: `frontend/src/lib/components/Workspace.svelte` (mount + close branch)
- Test: `frontend/src/lib/snippet/__tests__/console-view.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6 (`ensureSnippetDraft`, `getSnippetDraft`, `updateSnippetCode`, `setSnippetName`, `saveSnippetDraft`, `getSnippetSaveConflict`, `reloadSnippetDraft`, `getSnippetLint`, `getSnippetRun`, `setSnippetEntry`, `setSnippetElementContext`, `runSnippetTab`, `stopSnippetTab`, `markRunStaged`, `stageSnippetOps`, `closeSnippetDraft`, `CodeEditor.svelte`); `getModelRev`, `canEdit`, `getSelection` (`selection.svelte.ts`), `listElementsPage` (`$lib/api/model-read`, `{ q, limit }`), `elementDisplayName` (`$lib/util/element-name`).
- Produces:
  - `console-view.ts`: `isResultStale(result: Pick<SnippetRunOut, 'stale' | 'model_rev'>, currentRev: number): boolean`; `errorKindLabel(kind: SnippetError['kind']): string`; `opSummary(op: Op): string`; `tracebackLines(tb: string): Array<{ text: string; line: number | null }>` (extracts `line N` refs for `File "<snippet>", line N` entries so the console can link them to `goToLine`).
  - `SnippetTab.svelte` prop `{ tabId: string }` — mounted by `Workspace.svelte` for `kind === 'snippet'`.
  - Stable test ids for e2e (Task 9): `snippet-run`, `snippet-stop`, `snippet-save`, `snippet-stdout`, `snippet-result`, `snippet-error`, `snippet-stale`, `snippet-notice`, `snippet-ops`, `snippet-stage`, `snippet-entry`, `snippet-element-search`.

- [ ] **Step 1: Write the failing tests** — `console-view.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { errorKindLabel, isResultStale, opSummary, tracebackLines } from '../console-view';

describe('console-view', () => {
	it('flags staleness from the flag or a moved rev', () => {
		expect(isResultStale({ stale: false, model_rev: 5 }, 5)).toBe(false);
		expect(isResultStale({ stale: true, model_rev: 5 }, 5)).toBe(true);
		expect(isResultStale({ stale: false, model_rev: 5 }, 6)).toBe(true);
	});

	it('labels every error kind, including the never-produced ones', () => {
		for (const kind of ['syntax', 'runtime', 'timeout', 'cancelled', 'memory', 'limit'] as const) {
			expect(errorKindLabel(kind)).toBeTruthy();
		}
		expect(errorKindLabel('timeout')).toMatch(/timed out/i);
	});

	it('summarizes ops compactly', () => {
		expect(
			opSummary({ kind: 'create_element', temp_id: 'tmp_x', type_name: 'Building', properties: { name: 'B1' } })
		).toBe('create Building "B1"');
		expect(opSummary({ kind: 'update_element', id: 'e1', properties_patch: { name: 'N', height: 3 } })).toBe(
			'update e1 (name, height)'
		);
		expect(opSummary({ kind: 'delete_relationship', id: 'r1' })).toBe('delete relationship r1');
	});

	it('extracts snippet line refs from a traceback', () => {
		const tb = 'Traceback (most recent call last):\n  File "<snippet>", line 3, in <module>\nKeyError: 1';
		const lines = tracebackLines(tb);
		expect(lines[1].line).toBe(3);
		expect(lines[0].line).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/snippet/__tests__/console-view.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `console-view.ts`:**

```ts
import type { Op } from '$lib/state/ops';
import type { SnippetError, SnippetRunOut } from '$lib/api/snippets';

export function isResultStale(
	result: Pick<SnippetRunOut, 'stale' | 'model_rev'>,
	currentRev: number
): boolean {
	return result.stale || result.model_rev !== currentRev;
}

/** M1 runners only produce syntax/runtime/timeout/memory; cancelled/limit are
 * declared-but-unemitted (backend M2) and still render sensibly if they ever
 * appear — the console must not switch on an incomplete union. */
export function errorKindLabel(kind: SnippetError['kind']): string {
	switch (kind) {
		case 'syntax': return 'Syntax error';
		case 'runtime': return 'Runtime error';
		case 'timeout': return 'Timed out';
		case 'memory': return 'Out of memory';
		case 'cancelled': return 'Cancelled';
		case 'limit': return 'Limit exceeded';
	}
}

export function opSummary(op: Op): string {
	switch (op.kind) {
		case 'create_element': {
			const name = op.properties['name'];
			return typeof name === 'string' ? `create ${op.type_name} "${name}"` : `create ${op.type_name}`;
		}
		case 'update_element': return `update ${op.id} (${Object.keys(op.properties_patch).join(', ')})`;
		case 'delete_element': return `delete ${op.id}`;
		case 'create_relationship': return `connect ${op.type_name}: ${op.source_id} → ${op.target_id}`;
		case 'update_relationship': return `update relationship ${op.id} (${Object.keys(op.properties_patch).join(', ')})`;
		case 'delete_relationship': return `delete relationship ${op.id}`;
	}
}

const SNIPPET_LINE_RE = /File "<snippet>", line (\d+)/;

export function tracebackLines(tb: string): Array<{ text: string; line: number | null }> {
	return tb.split('\n').map((text) => {
		const m = SNIPPET_LINE_RE.exec(text);
		return { text, line: m ? Number(m[1]) : null };
	});
}
```

(Run one facade error through the real backend during Task 9's e2e work; if the traceback frame label differs from `<snippet>`, widen `SNIPPET_LINE_RE` to match the actual label — the regex is the only place that knows it.)

- [ ] **Step 4: Build the components.** Follow the repo's component idiom (Tailwind classes, `$lib/components/ui` primitives, `$derived` off store getters). Structure:

`SnippetTab.svelte` (prop `tabId: string`):
- On mount (`$effect` keyed by `tabId`): `void ensureSnippetDraft(tabId)`; render nothing until `getSnippetDraft(tabId)` exists.
- Toolbar: name input (value `draft.name`, change → `setSnippetName`); Run button (`data-testid="snippet-run"`, disabled when `run.phase !== 'idle'` or (`run.entry !== 'script'` and `run.elementId === null`), click → `runSnippetTab(tabId)`); Stop button (`data-testid="snippet-stop"`, only while `run.phase !== 'idle'`, click → `stopSnippetTab(tabId)`); entry `<select>` (`data-testid="snippet-entry"`, options `script` always, `value`/`step` disabled unless `getSnippetLint(tabId)?.entryPoints` includes them); Save button (`data-testid="snippet-save"`, hidden when `!canEdit()`, click → `saveSnippetDraft(tabId).catch(...)` with the error shown in a small alert line; on a rev conflict — `getSnippetSaveConflict(tabId) !== undefined` — show "Saved elsewhere (rev N). [Reload server copy] [Keep editing]" where Reload calls `reloadSnippetDraft(tabId)`).
- `<CodeEditor bind:this={editor} code={draft.code} diagnostics={getSnippetLint(tabId)?.diagnostics ?? []} onChange={(c) => updateSnippetCode(tabId, c)} onRun={() => void runSnippetTab(tabId)} />` in the top pane; `<SnippetConsole {tabId} onGoToLine={(l) => editor?.goToLine(l)} />` below (flex column, editor ~60%).
- `<ElementContextRow {tabId} />` between toolbar and editor, rendered only when `run.entry !== 'script'`.

`SnippetConsole.svelte` (props `tabId: string`, `onGoToLine: (line: number) => void`):
- `const run = $derived(getSnippetRun(tabId));` `const stale = $derived(run.result ? isResultStale(run.result, getModelRev()) : false);`
- While `phase === 'running'`: spinner + "Running…". While `'stopping'`: "Stopping — run ends at wall timeout".
- `run.notice` → `data-testid="snippet-notice"` alert line.
- With a result: stdout `<pre data-testid="snippet-stdout">` (render only when non-empty); `result_repr` `<pre data-testid="snippet-result">`; `truncated` → badge "output truncated at server limit"; `duration_ms` caption; error block `data-testid="snippet-error"` with `errorKindLabel(error.kind)` badge, message, collapsible traceback rendered via `tracebackLines` where entries with `line !== null` are buttons calling `onGoToLine(line)`.
- Stale banner `data-testid="snippet-stale"`: "The model changed during/after this run — results may be out of date. Re-run before staging."
- Ops list `data-testid="snippet-ops"`: one row per op via `opSummary`; footer button `data-testid="snippet-stage"` "Stage ops (N)" — hidden when `!canEdit()` or `ops.length === 0`; disabled when `stale` or `run.stagedRunId === run.result.run_id` (label flips to "Staged"); click:

```ts
async function stage(): Promise<void> {
	const result = getSnippetRun(tabId).result;
	if (!result) return;
	const outcome = await stageSnippetOps(result);
	if (outcome.ok) markRunStaged(tabId);
	else if (outcome.reason === 'stale') staleNotice = true; // re-derive banner; Stage stays disabled
	// 'locks' surfaces through the shared lock-notice UI; 'missing'/'empty' show a local alert line
}
```

`ElementContextRow.svelte` (prop `tabId: string`):
- Shows current binding (`run.elementLabel ?? 'no element bound'`).
- "Use current selection" button: enabled when `getSelection()?.kind === 'element'`; click → look up the element in `getCachedElements()` and `setSnippetElementContext(tabId, sel.id, elementDisplayName(el))`.
- Search `<input data-testid="snippet-element-search">`: on input, debounce 250 ms then `listElementsPage({ q, limit: 8 })`; render a small result list (name + type), click → `setSnippetElementContext(tabId, el.id, elementDisplayName(el))` and clear the list. Plain component-local `$state` — this micro-search needs no store.

`Workspace.svelte` — three edits:

```ts
import SnippetTab from './Snippet/SnippetTab.svelte';
import { closeSnippetDraft } from '$lib/state';
```

close branch:

```ts
if (tab.kind === 'table') closeTableDraft(tab.id);
else if (tab.kind === 'snippet') closeSnippetDraft(tab.id);
else closeDraft(tab.id);
```

content branch:

```svelte
{#if tab.kind === 'table'}
	<TableView tabId={tab.id} />
{:else if tab.kind === 'snippet'}
	<SnippetTab tabId={tab.id} />
{:else}
	<NavigationBuilder tabId={tab.id} />
{/if}
```

(`isTabDirty(tab.kind, tab.id)` in the tab strip now accepts `'snippet'` from Task 3 — no change needed.)

- [ ] **Step 5: Run tests + gates**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check && npm run lint'`
Expected: green — `npm run check` is the real gate on this task's Svelte code.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/snippet frontend/src/lib/components/Snippet frontend/src/lib/components/Workspace.svelte
git commit -m "feat(snippets-ui): snippet workspace tab — console, ops staging UI, element context picker"
```

---

### Task 8: Sidebar — Snippets section, entry-point badges, view-tree rows

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/ArtifactsSection.svelte`
- Modify: `frontend/src/lib/components/Sidebar/TreeRow.svelte`
- Test: extend `frontend/src/lib/state/__tests__/workspace.test.ts` (open/rekey by the `snip` prefix) — the Svelte templates themselves are covered by `npm run check` + Task 9's e2e.

**Interfaces:**
- Consumes: Task 2's `ArtifactHeader.entry_points`; Task 3's tab kind + `isArtifactDirty('code_snippet', id)`; `openArtifactTab('snippet', …)`.
- Produces: sidebar "Snippets" section (New/open/rename/delete/drag) + `value`/`step` badges; view-tree snippet rows open the editor tab.

- [ ] **Step 1: Write the failing test** — append to `workspace.test.ts`:

```ts
it('opens snippet tabs under the snip prefix and dedupes by artifact', () => {
	const a = openArtifactTab('snippet', { artifactId: 's1', title: 'S' });
	expect(a).toBe('snip:s1');
	const b = openArtifactTab('snippet', { artifactId: 's1', title: 'S' });
	expect(b).toBe(a);
	const draft = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
	expect(draft).toMatch(/^snip:draft:/);
});
```

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- run src/lib/state/__tests__/workspace.test.ts'`
Expected: PASS immediately (Task 3 already landed the prefix) — this pins the contract the sidebar relies on; if it fails, Task 3 regressed.

- [ ] **Step 2: `ArtifactsSection.svelte`.** Widen the local type and add the section:

```ts
import { ChevronDown, ChevronRight, FileCode, Plus, Route, Table } from '@lucide/svelte';

type ArtifactKind = 'navigation' | 'table' | 'code_snippet';

const SECTIONS: SectionConfig[] = [
	// ...existing navigation + table entries unchanged...
	{
		kind: 'code_snippet',
		title: 'Snippets',
		singular: 'snippet',
		icon: FileCode,
		open: (o) => openArtifactTab('snippet', o)
	}
];

let collapsed = $state<Record<ArtifactKind, boolean>>({ navigation: false, table: false, code_snippet: false });
```

In the row template, after the name span, render the badges (a snippet always has `script`; badge only the embeddable extras):

```svelte
{#if cfg.kind === 'code_snippet'}
	{#each (item.entry_points ?? []).filter((e) => e !== 'script') as ep (ep)}
		<span class="rounded bg-muted px-1 text-[10px] text-muted-foreground">{ep}</span>
	{/each}
{/if}
```

(`isArtifactDirty(cfg.kind, item.id)` already accepts `'code_snippet'` from Task 3. The existing `beginDrag({ kind: 'artifact', id, artifactKind: cfg.kind })` passes `'code_snippet'` through untouched — `tree-drag.svelte.ts` types `artifactKind` as `string`.)

- [ ] **Step 3: `TreeRow.svelte`.** Three touch points:

`onOpenArtifact` (~line 179):

```ts
function onOpenArtifact(): void {
	if (!artifactHeader) return;
	if (artifactHeader.kind === 'table') {
		openArtifactTab('table', { artifactId, title: artifactHeader.name });
	} else if (artifactHeader.kind === 'code_snippet') {
		openArtifactTab('snippet', { artifactId, title: artifactHeader.name });
	} else {
		openNavigationTab({ artifactId, title: artifactHeader.name });
	}
}
```

Icon block (~line 329): add `{:else if artifactHeader.kind === 'code_snippet'}<FileCode class="h-3 w-3" />` (import `FileCode`).

Dirty marker (~line 336): extend the kind guard to `artifactHeader.kind === 'table' || artifactHeader.kind === 'navigation' || artifactHeader.kind === 'code_snippet'` (the union on `isArtifactDirty` now admits it).

- [ ] **Step 4: Gates + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check && npm run lint'`
Expected: green.

```bash
git add frontend/src/lib/components/Sidebar/ArtifactsSection.svelte frontend/src/lib/components/Sidebar/TreeRow.svelte frontend/src/lib/state/__tests__/workspace.test.ts
git commit -m "feat(snippets-ui): sidebar Snippets section with entry-point badges + view-tree rows"
```

---

### Task 9: E2E flow, docs, full gates

**Files:**
- Create: `frontend/e2e/snippet-flow.spec.ts`
- Modify: `frontend/README.md` (workspace layout + state-module map + test-suite list)
- Modify: `CLAUDE.md` (one line in the frontend pointer of the "Code execution (snippets)" subsection noting the M1 frontend exists)

**Interfaces:**
- Consumes: the full Task 2–8 surface; e2e helpers (`openDefaultProject` from `e2e/helpers/auth.ts` — cookie login + "Smart City" project); the Playwright config's self-booted backend (which boots the WASM runner only when `spikes/code_exec/vendor/python.wasm` is fetched — otherwise `/snippets/run` 503s and the run-dependent tests skip).

- [ ] **Step 1: Write the spec** — `frontend/e2e/snippet-flow.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

/** Focus the CM6 editor and replace its content. keyboard.insertText avoids
 * CM auto-indent mangling multi-line python. */
async function setCode(page: Page, code: string): Promise<void> {
	await page.locator('[data-testid="snippet-editor"] .cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Delete');
	await page.keyboard.insertText(code);
}

async function openNewSnippet(page: Page): Promise<void> {
	await openDefaultProject(page);
	await page.getByRole('button', { name: 'New snippet' }).click();
	await expect(page.locator('[data-testid="snippet-editor"] .cm-content')).toBeVisible();
}

/** Run current code; resolve to 'ok' or skip the test when the backend has no
 * runner (guest binary not fetched — /snippets/run 503s). */
async function runAndAwait(page: Page): Promise<void> {
	await page.getByTestId('snippet-run').click();
	const outcome = page
		.getByTestId('snippet-stdout')
		.or(page.getByTestId('snippet-result'))
		.or(page.getByTestId('snippet-error'))
		.or(page.getByTestId('snippet-notice'));
	await expect(outcome.first()).toBeVisible({ timeout: 30_000 });
	const notice = page.getByTestId('snippet-notice');
	if (await notice.isVisible()) {
		const text = (await notice.textContent()) ?? '';
		test.skip(text.includes('unavailable'), 'snippet runner not booted (guest binary not fetched)');
	}
}

test('lint gutter surfaces a sandbox-import warning', async ({ page }) => {
	await openNewSnippet(page);
	await setCode(page, 'import os\n');
	await expect(page.locator('.cm-lint-marker-warning').first()).toBeVisible({ timeout: 10_000 });
});

test('run prints to the console', async ({ page }) => {
	await openNewSnippet(page);
	await setCode(page, 'print("hello from wasm")\n');
	await runAndAwait(page);
	await expect(page.getByTestId('snippet-stdout')).toContainText('hello from wasm');
});

test('stage a snippet edit and commit it', async ({ page }) => {
	await openNewSnippet(page);
	await setCode(page, 'el = next(dr.elements())\nel.set("name", "Renamed by snippet")\n');
	await runAndAwait(page);
	await expect(page.getByTestId('snippet-ops')).toContainText('update');
	await page.getByTestId('snippet-stage').click();
	await expect(page.getByTestId('snippet-stage')).toHaveText(/Staged/);
	// Commit through the standard review — mirror commit-flow.spec.ts's exact
	// open-review/confirm selectors if these drift.
	await page.getByRole('button', { name: /Commit/ }).click();
	await page.getByRole('button', { name: /^Commit( \(\d+\))?$/ }).last().click();
	await expect(page.getByTestId('snippet-stage')).toBeHidden({ timeout: 15_000 }); // ops cleared with the buffer? see note
});
```

Note on the last assertion: after a successful commit the staged buffer clears but the run result (and its ops list) remains on screen with the Stage button disabled ("Staged"). Assert what the implementation actually renders — the durable assertions are: staged-count in the status bar increments after staging, and the committed rename is findable (`page.getByPlaceholder('Search')`-style sidebar search for "Renamed by snippet" showing a hit). Mirror `commit-flow.spec.ts` for the commit-dialog selectors and the status-bar staged counter; adjust the tail of this test to those real affordances while keeping its three checkpoints: ops listed → staged → committed-and-visible.

- [ ] **Step 2: Run the e2e suite**

Run: `rm -f /tmp/data-rover-e2e.db && pixi run -e frontend bash -c 'cd frontend && npx playwright install chromium && npm run test:e2e -- snippet-flow.spec.ts'`
Expected: 3 passed (or run-dependent tests skipped with the runner-absent message if the guest binary is missing — fetch it first with `bash spikes/code_exec/fetch_python_wasi.sh` so they actually run).

Then the full suite: `rm -f /tmp/data-rover-e2e.db && pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`
Expected: all existing suites still green.

- [ ] **Step 3: Docs.** `frontend/README.md`: add the snippet tab to the Workspace bullet in Layout; add `snippet-editor.svelte.ts` / `snippet-stage.ts` lines to the state map in "Where to find things" (one line each, matching the existing style); add `snippet-flow.spec.ts` to the e2e suite list. `CLAUDE.md`: in the "Code execution (snippets)" subsection, append one sentence: the M1 frontend (snippet workspace tab, console, ops staging) lives in `frontend/src/lib/{state/snippet-editor.svelte.ts,state/snippet-stage.ts,components/Snippet/}`.

- [ ] **Step 4: Full gates**

Run: `pixi run tidy && pixi run test-core && pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: all green (tidy may reformat — re-stage anything it touches).

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/snippet-flow.spec.ts frontend/README.md CLAUDE.md
git commit -m "test(snippets-ui): e2e snippet flow (lint, run, stage, commit) + docs"
```

---

## Self-review notes (resolved inline)

- **Spec coverage:** D1/CM6→T6; D2/inline runs→T4 (`code` always sent); D3/honest Stop→T4; D4/picker→T7 (`ElementContextRow`); D5/tab kind→T3; D6/header entry_points→T1+T2; §4 surface→T3/T8; §5 components→T6/T7; §6 state+api→T2/T3/T4; §7 stage-ops→T5 (+T7 button wiring); §8 artifact save→T3; §9 error table→T4 (notices) + T7 (console) + T5 (lock/stale gating); §10 tests→every task + T9 e2e. Spec §10's "component tests with mocked editor" is delivered as pure view-model tests (`console-view.test.ts`) + svelte-check + e2e — the repo has no component-testing harness (no testing-library dep) and adding one is out of scope.
- **Deviation from spec §6:** dirty tracking uses the codebase's `dirty: boolean` flag (nav/table pattern) instead of the spec's `code !== savedCode` comparison — same observable behavior, consistent with `unsaved.ts`.
- **Deviation from spec §7:** lock acquisition calls `acquireLocks` (the exported edit-gate batch primitive) grouped by intent rather than per-op `editLock`/`deleteLock`/`connectLock` wrappers — same lock targets/notice, one call per group, honest all-or-nothing per group with TTL-expiry for partially-acquired leases (documented in `snippet-stage.ts`'s docstring).
- **Type consistency:** `SnippetRunOut` (ops-refined) is exported from `api/snippets.ts` and consumed by T4 (`SnippetRunState.result`), T5 (`stageSnippetOps(result)`), T7 (console); `SnippetDiagnostic` from `types.ts` used by T4 lint state and T6 `toCmDiagnostics`; tab prefix `snip:` used by T3 store, T7 mount, T8 open; `markRunStaged`/`stagedRunId` pair T4↔T7.
- **Codebase-lookup steps (deliberate, mirroring the M1-backend plan's stance):** T1's test-helper form, T2's no-schema `apiFetch` form, T5's `seedElements` fixture shapes + `LockIntent` literal, T9's commit-dialog selectors — each is a one-look copy from a named existing file; all assertions/contracts are fully specified here.
- **Model guidance for SDD:** cheap model for T2, T6, T8 (mechanical mirrors); standard for T1, T3, T4, T7, T9; standard-or-capable for T5 (the one genuinely new mechanism); capable model for the final whole-branch review.
