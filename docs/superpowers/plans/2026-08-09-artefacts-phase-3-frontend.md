# Artefacts Phase 3 Frontend (Import/Export UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the frontend for the artefacts Phase 3 import/export backend: a TopBar toolbar with an Artifacts menu, an export dialog with live closure preview + name filter, a plan→confirm import dialog, a per-tab export button, and the New Project wizard's artifact-bundle slot with skipped-artifact reporting (one small backend change).

**Architecture:** Thin zod API client (`lib/api/artifact-bundle.ts`) + two self-contained dialog components driven by `lib/state/ui` open-state (the `setDiffDrawerOpen` pattern), mounted once inside a new `ArtifactsMenu` component on a new growable TopBar toolbar region. No new global store — dialog contents are component-local. Spec: `docs/superpowers/specs/2026-08-09-artefacts-phase-3-frontend-design.md` (read it first).

**Tech Stack:** Svelte 5 (runes), zod, MSW + vitest (happy-dom), shadcn-svelte primitives (`$lib/components/ui`), lucide icons, FastAPI + pydantic (Task 1 only).

## Global Constraints

- Work on branch `feature/artefacts-phase-3-frontend` off `main`. Never push.
- **The backend bundle contract is FROZEN.** The ONLY sanctioned backend change is Task 1's `ProjectOut.skipped_artifacts`. If a route seems wrong, STOP and raise it.
- Import must NEVER place artifacts in the view. Do not add placement.
- Viewer gating is hide-not-disable (`canEdit()` from `$lib/state`), matching `ArtifactsSection.svelte`.
- On a 409 from `POST /artifacts/import` carrying `body.plan`, the client MUST re-render from `body.plan`, never from the plan it submitted.
- Frontend tests/lint run INSIDE `frontend/`: `pixi run frontend-test` (vitest), and the real lint gate is `pixi run -e frontend bash -c 'cd frontend && npm run lint'`. Run `npm run format` before lint. Backend: `pixi run core-test`.
- Frontend files are indented with TABS (prettier config); Python with 4 spaces (ruff).
- Commit style: conventional commits (`feat(ui): …`, `feat(api): …`, `test: …`), body optional, no attribution lines beyond the repo's convention.
- Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`, `$bindable`) — NOT Svelte 4 stores. Reactive collections come from `svelte/reactivity` (`SvelteSet`, `SvelteMap`).
- Existing helpers you must reuse (do not re-implement): `apiFetch`/`apiFetchRaw` (`$lib/api/client`), `ConflictError` (`$lib/api/errors`), `saveResponseToFile` (`$lib/util/fileSave`), `getCommittedArtifactHeaders`/`loadArtifacts` (`$lib/state`), `getStagedArtifactDepth`, `canEdit`, `isTempId` (`$lib/state/ops`).

---

### Task 0: Branch setup

**Files:** none

- [ ] **Step 1: Create the branch**

```bash
cd /home/mdp/workspace/data-rover-py
git checkout -b feature/artefacts-phase-3-frontend main
```

Expected: clean tree on the new branch (`git status --short` empty).

---

### Task 1: Backend — `ProjectOut.skipped_artifacts`

The wizard route currently discards `importer.import_project(...)`'s return value (a `list[SkippedEntry]` with `bundle_id` + `reason`), so a wizard user gets no signal that artifacts were skipped. Surface it on the create response.

**Files:**
- Modify: `src/data_rover/api/routes/projects.py` (ProjectOut ~line 50, create route ~line 118)
- Test: `tests/api/test_projects_wizard.py`

**Interfaces:**
- Produces (wire): `POST /api/v1/projects` response gains `skipped_artifacts: [{bundle_id: str, reason: str}]`, `[]` when nothing was skipped. `GET /projects`, `GET /projects/{id}`, clone keep the empty default. Task 8's frontend schema mirrors this exact shape.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_projects_wizard.py` (reuse the existing `_as_admin`, `CSRF`, `_MM`, `_bundle_bytes`, `_hostile_bundle_bytes` helpers already in that file — read them first):

```python
def test_wizard_create_reports_skipped_artifacts() -> None:
    """The create response carries the importer's skip list; a clean bundle
    reports an empty one, and the list/get routes always default to []."""
    c = _as_admin()
    with _MM.open("rb") as fh:
        r = c.post(
            "/api/v1/projects",
            data={"name": "Skippy"},
            files={
                "metamodel": ("mm.yaml", fh, "application/yaml"),
                "artifacts": ("b.json", _hostile_bundle_bytes(), "application/json"),
            },
            headers=CSRF,
        )
    assert r.status_code == 201, r.text
    body = r.json()
    skipped = body["skipped_artifacts"]
    assert len(skipped) >= 1
    assert all(s["bundle_id"] and s["reason"] for s in skipped)
    # list/get keep the empty default
    listed = next(p for p in c.get("/api/v1/projects").json() if p["id"] == body["id"])
    assert listed["skipped_artifacts"] == []


def test_wizard_create_clean_bundle_reports_no_skips() -> None:
    c = _as_admin()
    with _MM.open("rb") as fh:
        r = c.post(
            "/api/v1/projects",
            data={"name": "Clean"},
            files={
                "metamodel": ("mm.yaml", fh, "application/yaml"),
                "artifacts": ("b.json", _bundle_bytes(), "application/json"),
            },
            headers=CSRF,
        )
    assert r.status_code == 201, r.text
    assert r.json()["skipped_artifacts"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pixi run -e core-dev pytest tests/api/test_projects_wizard.py -k skipped_or_clean -v
# (use: -k "reports_skipped_artifacts or reports_no_skips")
```

Expected: FAIL with `KeyError: 'skipped_artifacts'`.

- [ ] **Step 3: Implement**

In `src/data_rover/api/routes/projects.py`:

```python
class SkippedArtifactOut(BaseModel):
    """One bundle artifact the importer reported-and-skipped (mirrors the
    importer's SkippedEntry — kept as its own wire type so the projects
    router does not leak the bundle module's internal model)."""

    bundle_id: str
    reason: str


class ProjectOut(BaseModel):
    id: str
    name: str
    role: Role
    #: Populated ONLY by the create route (the one caller that runs the
    #: importer); list/get/clone leave the default so existing consumers
    #: see an additive, always-present field.
    skipped_artifacts: list[SkippedArtifactOut] = Field(default_factory=list)
```

(`Field` import: `from pydantic import BaseModel, Field` — check the existing import line.)

In the create route, replace the discarded call:

```python
    skipped = importer.import_project(
        project_id=project_id,
        name=name,
        owner_id=admin.id,
        metamodel_yaml=metamodel_yaml,
        model_json=model_json,
        view_json=view_json,
        artifact_bundle=artifact_bundle,
    )
    return ProjectOut(
        id=project_id,
        name=name,
        role=Role.owner,
        skipped_artifacts=[
            SkippedArtifactOut(bundle_id=s.bundle_id, reason=s.reason)
            for s in skipped
        ],
    )
```

- [ ] **Step 4: Run the api test file, then the full backend suite**

```bash
pixi run -e core-dev pytest tests/api/test_projects_wizard.py -v
pixi run core-test
```

Expected: PASS (1689+2 passed, 26 deselected — the deselected are `integration`-marked).

- [ ] **Step 5: Lint and commit**

```bash
pixi run backend-lint
git add src/data_rover/api/routes/projects.py tests/api/test_projects_wizard.py
git commit -m "feat(api): report skipped artifacts on wizard project creation"
```

---

### Task 2: API client — `lib/api/artifact-bundle.ts`

**Files:**
- Create: `frontend/src/lib/api/artifact-bundle.ts`
- Test: `frontend/src/lib/api/__tests__/artifact-bundle.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `apiFetchRaw`, `ClientConfig` from `./client`; `ConflictError` from `./errors`.
- Produces (used by Tasks 4–5):
  - `ArtifactBundleSchema` / `type ArtifactBundle`
  - `ExportPreviewSchema` / `type ExportPreview` (`{artifacts: {id,kind,name}[], dangling_refs: string[]}`)
  - `ImportPlanSchema` / `type ImportPlan`, `type PlanEntry` (`{bundle_id, kind, name, action: 'create'|'reuse'|'copy', existing_id: string|null, copy_name: string|null}`), `type SkippedEntry` (`{bundle_id, reason}`)
  - `type ImportConfirmResponse` (`{rev: number|null, created: {bundle_id,id,name}[], reused: {bundle_id,existing_id}[], skipped: SkippedEntry[]}`)
  - `class StalePlanImportError extends Error { detail: string; plan: ImportPlan }`
  - `exportPreview(rootIds: string[], cfg?): Promise<ExportPreview>`
  - `exportBundle(rootIds: string[], cfg?): Promise<Response>`
  - `importPlan(bundle: ArtifactBundle, cfg?): Promise<ImportPlan>`
  - `importConfirm(input: {bundle: ArtifactBundle; decisions: Record<string, 'create'|'reuse'|'copy'>; copyNames: Record<string, string>; message: string}, cfg?): Promise<ImportConfirmResponse>`
  - `parseBundleText(text: string): ArtifactBundle` (throws on malformed JSON / wrong shape)
  - `BUNDLE_FILENAME = 'artifacts.bundle.json'`

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/api/__tests__/artifact-bundle.test.ts`, following `artifacts.test.ts`'s harness (same `server` import, `BASE`/`CFG` constants):

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { ConflictError } from '../errors';
import {
	exportBundle,
	exportPreview,
	importConfirm,
	importPlan,
	parseBundleText,
	StalePlanImportError,
	type ArtifactBundle
} from '../artifact-bundle';

const BASE = 'http://api.test/api/v1/projects/p1';
const CFG = { baseUrl: BASE };

const BUNDLE: ArtifactBundle = {
	format: 'datarover.artifact-bundle/v1',
	exported_at: '2026-08-09T00:00:00Z',
	source_project: { id: 'src', name: 'Source' },
	roots: ['n1'],
	artifacts: [{ id: 'n1', kind: 'navigation', name: 'Routes', payload: {} }]
};

const PLAN = {
	entries: [
		{
			bundle_id: 'n1',
			kind: 'navigation',
			name: 'Routes',
			action: 'reuse',
			existing_id: 'x1',
			copy_name: 'Routes (2)'
		}
	],
	skipped: [{ bundle_id: 'd1', reason: 'unknown kind' }]
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('artifact-bundle api', () => {
	it('posts root ids and parses the export preview', async () => {
		server.use(
			http.post(`${BASE}/artifacts/export/preview`, async ({ request }) => {
				expect(await request.json()).toEqual({ root_ids: ['a1'] });
				return HttpResponse.json({
					artifacts: [{ id: 'a1', kind: 'table', name: 'T' }],
					dangling_refs: ['ghost']
				});
			})
		);
		const res = await exportPreview(['a1'], CFG);
		expect(res.artifacts[0].name).toBe('T');
		expect(res.dangling_refs).toEqual(['ghost']);
	});

	it('returns the raw export response for streaming', async () => {
		server.use(
			http.post(`${BASE}/artifacts/export`, () => HttpResponse.json(BUNDLE))
		);
		const resp = await exportBundle(['n1'], CFG);
		expect(resp.ok).toBe(true);
		expect((await resp.json()).format).toBe('datarover.artifact-bundle/v1');
	});

	it('fetches an import plan for a bundle', async () => {
		server.use(
			http.post(`${BASE}/artifacts/import/plan`, () => HttpResponse.json(PLAN))
		);
		const plan = await importPlan(BUNDLE, CFG);
		expect(plan.entries[0].action).toBe('reuse');
		expect(plan.skipped[0].reason).toBe('unknown kind');
	});

	it('confirms with snake_case field names and parses the result', async () => {
		server.use(
			http.post(`${BASE}/artifacts/import`, async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				expect(body.copy_names).toEqual({ n1: 'Renamed' });
				expect(body.decisions).toEqual({ n1: 'copy' });
				return HttpResponse.json({
					rev: 7,
					created: [{ bundle_id: 'n1', id: 'new1', name: 'Renamed' }],
					reused: [],
					skipped: []
				});
			})
		);
		const res = await importConfirm(
			{ bundle: BUNDLE, decisions: { n1: 'copy' }, copyNames: { n1: 'Renamed' }, message: '' },
			CFG
		);
		expect(res.rev).toBe(7);
		expect(res.created[0].name).toBe('Renamed');
	});

	it('throws StalePlanImportError on a 409 that carries a fresh plan', async () => {
		server.use(
			http.post(`${BASE}/artifacts/import`, () =>
				HttpResponse.json({ detail: 'import plan is stale: x', plan: PLAN }, { status: 409 })
			)
		);
		const err = await importConfirm(
			{ bundle: BUNDLE, decisions: {}, copyNames: {}, message: '' },
			CFG
		).catch((e) => e);
		expect(err).toBeInstanceOf(StalePlanImportError);
		expect(err.plan.entries[0].bundle_id).toBe('n1');
		expect(err.detail).toContain('stale');
	});

	it('rethrows a plan-less 409 as a plain ConflictError', async () => {
		server.use(
			http.post(`${BASE}/artifacts/import`, () =>
				HttpResponse.json({ detail: 'model_rev conflict', model_rev: 9 }, { status: 409 })
			)
		);
		const err = await importConfirm(
			{ bundle: BUNDLE, decisions: {}, copyNames: {}, message: '' },
			CFG
		).catch((e) => e);
		expect(err).toBeInstanceOf(ConflictError);
		expect(err).not.toBeInstanceOf(StalePlanImportError);
	});

	it('parseBundleText rejects a wrong-format file', () => {
		expect(() => parseBundleText(JSON.stringify({ format: 'nope' }))).toThrow();
		expect(() => parseBundleText('not json')).toThrow();
		expect(parseBundleText(JSON.stringify(BUNDLE)).artifacts).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pixi run frontend-test -- run src/lib/api/__tests__/artifact-bundle.test.ts
```

Expected: FAIL — module `../artifact-bundle` not found.

- [ ] **Step 3: Implement `frontend/src/lib/api/artifact-bundle.ts`**

```ts
/**
 * Client for the four Phase-3 bundle routes. Export + preview are
 * viewer-allowed reads; plan + confirm are part of the write flow (the
 * backend keeps them out of the read-only allowlist), so the UI must gate
 * their affordances on `canEdit()`.
 */
import { z } from 'zod';
import { apiFetch, apiFetchRaw, type ClientConfig } from './client';
import { ConflictError } from './errors';

export const BUNDLE_FORMAT = 'datarover.artifact-bundle/v1' as const;
/** The filename the export route pins via Content-Disposition. */
export const BUNDLE_FILENAME = 'artifacts.bundle.json';

export const BundleArtifactSchema = z.object({
	id: z.string(),
	kind: z.string(),
	name: z.string(),
	payload: z.record(z.string(), z.unknown()).default({})
});

export const ArtifactBundleSchema = z.object({
	format: z.literal(BUNDLE_FORMAT),
	exported_at: z.string(),
	source_project: z.object({ id: z.string(), name: z.string() }),
	roots: z.array(z.string()).default([]),
	artifacts: z.array(BundleArtifactSchema).default([])
});
export type ArtifactBundle = z.infer<typeof ArtifactBundleSchema>;

export const ExportPreviewSchema = z.object({
	artifacts: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string() })).default([]),
	dangling_refs: z.array(z.string()).default([])
});
export type ExportPreview = z.infer<typeof ExportPreviewSchema>;

export const PlanEntrySchema = z.object({
	bundle_id: z.string(),
	kind: z.string(),
	name: z.string(),
	action: z.enum(['create', 'reuse', 'copy']),
	existing_id: z.string().nullable().default(null),
	copy_name: z.string().nullable().default(null)
});
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

export const SkippedEntrySchema = z.object({ bundle_id: z.string(), reason: z.string() });
export type SkippedEntry = z.infer<typeof SkippedEntrySchema>;

export const ImportPlanSchema = z.object({
	entries: z.array(PlanEntrySchema).default([]),
	skipped: z.array(SkippedEntrySchema).default([])
});
export type ImportPlan = z.infer<typeof ImportPlanSchema>;

export const ImportConfirmResponseSchema = z.object({
	rev: z.number().int().nullable(),
	created: z
		.array(z.object({ bundle_id: z.string(), id: z.string(), name: z.string() }))
		.default([]),
	reused: z.array(z.object({ bundle_id: z.string(), existing_id: z.string() })).default([]),
	skipped: z.array(SkippedEntrySchema).default([])
});
export type ImportConfirmResponse = z.infer<typeof ImportConfirmResponseSchema>;

/**
 * A 409 from POST /artifacts/import that carried a freshly-derived plan.
 * The caller MUST re-render from {@link plan} — the plan it submitted is
 * stale by definition and resubmitting it loops forever.
 */
export class StalePlanImportError extends Error {
	constructor(
		public readonly detail: string,
		public readonly plan: ImportPlan
	) {
		super(detail);
		this.name = 'StalePlanImportError';
	}
}

export function exportPreview(rootIds: string[], cfg?: ClientConfig): Promise<ExportPreview> {
	return apiFetch(
		'/artifacts/export/preview',
		{ method: 'POST', body: { root_ids: rootIds }, schema: ExportPreviewSchema },
		cfg
	);
}

/** Raw Response so the caller can stream it to a file (saveResponseToFile). */
export function exportBundle(rootIds: string[], cfg?: ClientConfig): Promise<Response> {
	return apiFetchRaw('/artifacts/export', { method: 'POST', body: { root_ids: rootIds } }, cfg);
}

export function importPlan(bundle: ArtifactBundle, cfg?: ClientConfig): Promise<ImportPlan> {
	return apiFetch(
		'/artifacts/import/plan',
		{ method: 'POST', body: bundle, schema: ImportPlanSchema },
		cfg
	);
}

export async function importConfirm(
	input: {
		bundle: ArtifactBundle;
		decisions: Record<string, 'create' | 'reuse' | 'copy'>;
		copyNames: Record<string, string>;
		message: string;
	},
	cfg?: ClientConfig
): Promise<ImportConfirmResponse> {
	try {
		return await apiFetch(
			'/artifacts/import',
			{
				method: 'POST',
				body: {
					bundle: input.bundle,
					decisions: input.decisions,
					copy_names: input.copyNames,
					message: input.message
				},
				schema: ImportConfirmResponseSchema
			},
			cfg
		);
	} catch (err) {
		// Two 409 shapes: {detail, plan} (stale plan — recover by re-rendering
		// the fresh plan) vs create_commit's {detail, model_rev} (no plan).
		if (err instanceof ConflictError && err.body !== null && typeof err.body === 'object') {
			const planRaw = (err.body as { plan?: unknown }).plan;
			if (planRaw !== undefined) {
				const parsed = ImportPlanSchema.safeParse(planRaw);
				if (parsed.success) throw new StalePlanImportError(err.message, parsed.data);
			}
		}
		throw err;
	}
}

/** Parse a picked bundle file's text. Throws on bad JSON or a wrong shape —
 * the dialog catches and shows an inline error instead of a server 422. */
export function parseBundleText(text: string): ArtifactBundle {
	return ArtifactBundleSchema.parse(JSON.parse(text));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pixi run frontend-test -- run src/lib/api/__tests__/artifact-bundle.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Format, lint, commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run format && npm run lint && npm run check'
git add frontend/src/lib/api/artifact-bundle.ts frontend/src/lib/api/__tests__/artifact-bundle.test.ts
git commit -m "feat(ui): artifact-bundle API client with typed 409 discrimination"
```

---

### Task 3: UI open-state — export/import dialog openers

**Files:**
- Modify: `frontend/src/lib/state/ui.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (re-export the new functions where the other ui accessors are re-exported)
- Test: `frontend/src/lib/state/__tests__/ui-artifact-dialogs.test.ts`

**Interfaces:**
- Produces (used by Tasks 4–7):
  - `getExportArtifactsOpen(): boolean`, `setExportArtifactsOpen(open: boolean): void` (closing clears the seed)
  - `openExportArtifacts(seedRootIds?: string[]): void` — sets seed then opens
  - `getExportArtifactsSeed(): string[]`
  - `getImportArtifactsOpen(): boolean`, `setImportArtifactsOpen(open: boolean): void`, `openImportArtifacts(): void`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
	getExportArtifactsOpen,
	getExportArtifactsSeed,
	getImportArtifactsOpen,
	openExportArtifacts,
	openImportArtifacts,
	setExportArtifactsOpen,
	setImportArtifactsOpen
} from '../ui.svelte';

describe('artifact dialog open-state', () => {
	it('opens export with a seed and clears it on close', () => {
		expect(getExportArtifactsOpen()).toBe(false);
		openExportArtifacts(['a1', 'a2']);
		expect(getExportArtifactsOpen()).toBe(true);
		expect(getExportArtifactsSeed()).toEqual(['a1', 'a2']);
		setExportArtifactsOpen(false);
		expect(getExportArtifactsOpen()).toBe(false);
		expect(getExportArtifactsSeed()).toEqual([]);
	});

	it('defaults the export seed to empty', () => {
		openExportArtifacts();
		expect(getExportArtifactsSeed()).toEqual([]);
		setExportArtifactsOpen(false);
	});

	it('tracks import open-state', () => {
		expect(getImportArtifactsOpen()).toBe(false);
		openImportArtifacts();
		expect(getImportArtifactsOpen()).toBe(true);
		setImportArtifactsOpen(false);
		expect(getImportArtifactsOpen()).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pixi run frontend-test -- run src/lib/state/__tests__/ui-artifact-dialogs.test.ts
```

Expected: FAIL — exports not found.

- [ ] **Step 3: Implement**

Append to `frontend/src/lib/state/ui.svelte.ts`:

```ts
// Artifact export/import dialogs (mounted once in ArtifactsMenu, opened from
// three surfaces: the TopBar menu, the command palette, and the workspace tab
// strip's per-artifact export button — which passes a seed selection).
let _exportArtifactsOpen: boolean = $state(false);
let _exportArtifactsSeed: string[] = $state([]);
let _importArtifactsOpen: boolean = $state(false);

export function getExportArtifactsOpen(): boolean {
	return _exportArtifactsOpen;
}

export function getExportArtifactsSeed(): string[] {
	return _exportArtifactsSeed;
}

/** Open the export dialog, pre-checking `seedRootIds` (unknown ids are
 * ignored by the dialog itself — it intersects with committed headers). */
export function openExportArtifacts(seedRootIds: string[] = []): void {
	_exportArtifactsSeed = seedRootIds;
	_exportArtifactsOpen = true;
}

export function setExportArtifactsOpen(open: boolean): void {
	_exportArtifactsOpen = open;
	if (!open) _exportArtifactsSeed = [];
}

export function getImportArtifactsOpen(): boolean {
	return _importArtifactsOpen;
}

export function setImportArtifactsOpen(open: boolean): void {
	_importArtifactsOpen = open;
}

export function openImportArtifacts(): void {
	_importArtifactsOpen = true;
}
```

Then re-export all six new functions from `frontend/src/lib/state/index.ts`, next to `setDiffDrawerOpen`/`setHistoryDrawerOpen`.

- [ ] **Step 4: Run tests**

```bash
pixi run frontend-test -- run src/lib/state/__tests__/ui-artifact-dialogs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run format && npm run lint && npm run check'
git add frontend/src/lib/state/ui.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/ui-artifact-dialogs.test.ts
git commit -m "feat(ui): open-state for artifact export/import dialogs"
```

---

### Task 4: Export dialog

**Files:**
- Create: `frontend/src/lib/components/ExportArtifactsDialog.svelte`
- Test: `frontend/src/lib/components/__tests__/ExportArtifactsDialog.test.ts`

**Interfaces:**
- Consumes: Task 2's `exportPreview`/`exportBundle`/`BUNDLE_FILENAME`; Task 3's export open-state; `getCommittedArtifactHeaders`, `getStagedArtifactDepth` from `$lib/state`; `saveResponseToFile` from `$lib/util/fileSave`; `Dialog`, `Button`, `Input` primitives; kind icons `Route`/`Table`/`FileCode` from `@lucide/svelte` (same mapping as `ArtifactsSection.svelte`).
- Produces: a self-mounting dialog with **no props** — it reads/writes the ui store (`getExportArtifactsOpen`/`setExportArtifactsOpen`/`getExportArtifactsSeed`). Task 6 mounts it.

**Behavior contract (from the spec, §3):**
- Rows: `getCommittedArtifactHeaders()` grouped under Navigations/Tables/Snippets. Muted note "Uncommitted artifact changes are not exported." when `getStagedArtifactDepth() > 0`.
- Filter input at top (`data-testid="export-filter"`, autofocus, placeholder "Filter artifacts…"): case-insensitive substring on name; a section with no visible rows collapses; selection persists for hidden rows; when hidden-but-checked rows exist show "+N selected not shown".
- Checkbox per row, per-section "all" checkbox, global "Select all".
- Debounced preview (300 ms, generation-guarded): on every selection change call `exportPreview([...checked])`; render dependency badges on closure rows that are not checked, and `dangling_refs` count as a warning line. Empty selection: skip the call, clear the preview.
- Seeded open: when the dialog opens, `checked = seed ∩ committed header ids`; run the preview immediately (no debounce) when non-empty.
- Export button: disabled when `checked.size === 0` or a save is in flight. On click: `exportBundle([...checked])` → `saveResponseToFile(resp, BUNDLE_FILENAME)` → close. `AbortError` (user cancelled the save picker) is silent and keeps the dialog open; other errors render an inline `role="alert"`.

- [ ] **Step 1: Write the failing tests**

Follow the harness of `artifacts-section.test.ts` (mount/unmount + `flushSync`, `vi.spyOn` on api modules, `resetArtifacts`/`loadArtifacts` seeding). Use `vi.useFakeTimers()` for the debounce.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import * as bundleApi from '$lib/api/artifact-bundle';
import * as fileSave from '$lib/util/fileSave';
import {
	loadArtifacts,
	openExportArtifacts,
	resetArtifacts,
	setExportArtifactsOpen
} from '$lib/state';
import ExportArtifactsDialog from '../ExportArtifactsDialog.svelte';

const HEADERS = [
	{ id: 'n1', kind: 'navigation', name: 'Bus routes', artifact_rev: 1, updated_at: '', updated_by: null, entry_points: null },
	{ id: 't1', kind: 'table', name: 'Fleet table', artifact_rev: 1, updated_at: '', updated_by: null, entry_points: null },
	{ id: 's1', kind: 'code_snippet', name: 'helpers', artifact_rev: 1, updated_at: '', updated_by: null, entry_points: null }
];

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(async () => {
	vi.useFakeTimers();
	resetArtifacts();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: HEADERS });
	await loadArtifacts();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	setExportArtifactsOpen(false);
	host.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function open(seed: string[] = []) {
	app = mount(ExportArtifactsDialog, { target: host });
	openExportArtifacts(seed);
	flushSync();
}

function rowCheckbox(id: string): HTMLInputElement {
	const el = document.body.querySelector<HTMLInputElement>(`[data-testid="export-row-${id}"] input`);
	if (!el) throw new Error(`row ${id} not rendered`);
	return el;
}

describe('ExportArtifactsDialog', () => {
	it('debounces one preview per selection settle and badges dependencies', async () => {
		const preview = vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({
			artifacts: [
				{ id: 'n1', kind: 'navigation', name: 'Bus routes' },
				{ id: 's1', kind: 'code_snippet', name: 'helpers' }
			],
			dangling_refs: ['ghost']
		});
		open();
		rowCheckbox('n1').click();
		flushSync();
		expect(preview).not.toHaveBeenCalled(); // debounced
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		expect(preview).toHaveBeenCalledTimes(1);
		expect(preview).toHaveBeenCalledWith(['n1']);
		// s1 is in the closure but unchecked -> dependency badge
		expect(
			document.body.querySelector('[data-testid="export-row-s1"]')?.textContent
		).toContain('dependency');
		expect(document.body.textContent).toContain('1 dangling');
	});

	it('seeded open pre-checks and previews immediately', async () => {
		const preview = vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({
			artifacts: [{ id: 't1', kind: 'table', name: 'Fleet table' }],
			dangling_refs: []
		});
		open(['t1', 'not-a-real-id']);
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(rowCheckbox('t1').checked).toBe(true);
		expect(preview).toHaveBeenCalledWith(['t1']); // unknown id dropped
	});

	it('filter narrows rows but selection persists and is reported', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open(['n1']);
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		const filter = document.body.querySelector<HTMLInputElement>('[data-testid="export-filter"]')!;
		filter.value = 'fleet';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(document.body.querySelector('[data-testid="export-row-n1"]')).toBeNull();
		expect(document.body.querySelector('[data-testid="export-row-t1"]')).not.toBeNull();
		expect(document.body.textContent).toContain('+1 selected not shown');
	});

	it('exports checked roots and closes; empty selection disables the button', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		const resp = new Response('{}');
		const exp = vi.spyOn(bundleApi, 'exportBundle').mockResolvedValue(resp);
		const save = vi
			.spyOn(fileSave, 'saveResponseToFile')
			.mockResolvedValue({ filename: 'artifacts.bundle.json', handle: null });
		open();
		const btn = document.body.querySelector<HTMLButtonElement>('[data-testid="export-submit"]')!;
		expect(btn.disabled).toBe(true);
		rowCheckbox('n1').click();
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		expect(btn.disabled).toBe(false);
		btn.click();
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(exp).toHaveBeenCalledWith(['n1']);
		expect(save).toHaveBeenCalledWith(resp, 'artifacts.bundle.json');
	});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/ExportArtifactsDialog.test.ts
```

Expected: FAIL — component not found.

- [ ] **Step 3: Implement the component**

`frontend/src/lib/components/ExportArtifactsDialog.svelte`. Skeleton (implementer fills styling from `ApplyCrDialog.svelte`/`NewProjectWizard.svelte` conventions — compact text sizes, `border-border`, `text-muted-foreground`):

```svelte
<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { FileCode, Route, Table, TriangleAlert } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		getCommittedArtifactHeaders,
		getExportArtifactsOpen,
		getExportArtifactsSeed,
		getStagedArtifactDepth,
		setExportArtifactsOpen
	} from '$lib/state';
	import {
		BUNDLE_FILENAME,
		exportBundle,
		exportPreview,
		type ExportPreview
	} from '$lib/api/artifact-bundle';
	import { saveResponseToFile } from '$lib/util/fileSave';

	const SECTIONS = [
		{ kind: 'navigation', title: 'Navigations', icon: Route },
		{ kind: 'table', title: 'Tables', icon: Table },
		{ kind: 'code_snippet', title: 'Snippets', icon: FileCode }
	] as const;

	const open = $derived(getExportArtifactsOpen());
	const headers = $derived(getCommittedArtifactHeaders());
	const hasStaged = $derived(getStagedArtifactDepth() > 0);

	const checked = new SvelteSet<string>();
	let filter = $state('');
	let preview = $state<ExportPreview | null>(null);
	let previewError = $state<string | null>(null);
	let exportError = $state<string | null>(null);
	let saving = $state(false);

	const DEBOUNCE_MS = 300;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let gen = 0;

	// Ids in the preview closure (checked roots + pulled-in dependencies).
	const closureIds = $derived(new Set((preview?.artifacts ?? []).map((a) => a.id)));

	const visible = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return headers.filter((h) => q === '' || h.name.toLowerCase().includes(q));
	});
	const hiddenSelected = $derived(
		[...checked].filter((id) => !visible.some((h) => h.id === id)).length
	);

	// Open/close lifecycle: seed the selection and fire the first preview
	// immediately; closing resets every piece of local state.
	$effect(() => {
		if (open) {
			const ids = new Set(getCommittedArtifactHeaders().map((h) => h.id));
			checked.clear();
			for (const id of getExportArtifactsSeed()) if (ids.has(id)) checked.add(id);
			filter = '';
			preview = null;
			previewError = null;
			exportError = null;
			if (checked.size > 0) void runPreview();
		} else {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			gen++;
		}
	});

	async function runPreview(): Promise<void> {
		const g = ++gen;
		if (checked.size === 0) {
			preview = null;
			previewError = null;
			return;
		}
		try {
			const res = await exportPreview([...checked]);
			if (g !== gen) return; // stale response
			preview = res;
			previewError = null;
		} catch {
			if (g !== gen) return;
			previewError = 'Could not compute the bundle preview.';
		}
	}

	function schedulePreview(): void {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => void runPreview(), DEBOUNCE_MS);
	}

	function toggle(id: string): void {
		if (checked.has(id)) checked.delete(id);
		else checked.add(id);
		schedulePreview();
	}

	async function onExport(): Promise<void> {
		exportError = null;
		saving = true;
		try {
			const resp = await exportBundle([...checked]);
			await saveResponseToFile(resp, BUNDLE_FILENAME);
			setExportArtifactsOpen(false);
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return; // user cancelled save
			exportError = 'Export failed. Try again.';
		} finally {
			saving = false;
		}
	}
</script>
```

Template essentials (checkbox rows carry `data-testid="export-row-{id}"`; the filter input `data-testid="export-filter"`; submit `data-testid="export-submit"`):

- `Dialog.Root open={open} onOpenChange={(v) => setExportArtifactsOpen(v)}` wrapping `Dialog.Content`.
- Header: title "Export artifacts", description "Selected artifacts and everything they reference are bundled into one file."
- `{#if hasStaged}` muted note "Uncommitted artifact changes are not exported."
- Filter `<Input data-testid="export-filter" bind:value={filter} placeholder="Filter artifacts…" />` + a "Select all" checkbox toggling every visible row.
- Per section (skip a section whose visible rows are empty): section title + per-section "all" checkbox + rows:

```svelte
{#each visible.filter((h) => h.kind === section.kind) as h (h.id)}
	<label data-testid={`export-row-${h.id}`} class="flex items-center gap-2 …">
		<input type="checkbox" checked={checked.has(h.id)} onchange={() => toggle(h.id)} />
		<section.icon class="size-3.5 shrink-0 text-info" />
		<span class="flex-1 truncate">{h.name}</span>
		{#if !checked.has(h.id) && closureIds.has(h.id)}
			<span class="rounded bg-muted px-1 text-[10px] text-muted-foreground">dependency</span>
		{/if}
	</label>
{/each}
```

- `{#if hiddenSelected > 0}` muted "+{hiddenSelected} selected not shown".
- Footer: summary line — `{preview?.artifacts.length ?? checked.size} artifacts`, and when `preview` has dangling refs a `TriangleAlert` + `{preview.dangling_refs.length} dangling ref(s)` in `text-warning`; `{#if previewError}<p role="alert">…</p>{/if}`; `{#if exportError}<p role="alert">…</p>{/if}`; Cancel button (`setExportArtifactsOpen(false)`) + `<Button data-testid="export-submit" disabled={checked.size === 0 || saving} onclick={() => void onExport()}>Export bundle</Button>`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/ExportArtifactsDialog.test.ts
```

Expected: PASS (4 tests). If the Dialog primitive portals content outside `host`, query `document.body` (the tests above already do).

- [ ] **Step 5: Format, lint, commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run format && npm run lint && npm run check'
git add frontend/src/lib/components/ExportArtifactsDialog.svelte frontend/src/lib/components/__tests__/ExportArtifactsDialog.test.ts
git commit -m "feat(ui): export-artifacts dialog with live closure preview"
```

---

### Task 5: Import dialog

**Files:**
- Create: `frontend/src/lib/components/ImportArtifactsDialog.svelte`
- Test: `frontend/src/lib/components/__tests__/ImportArtifactsDialog.test.ts`

**Interfaces:**
- Consumes: Task 2's `importPlan`/`importConfirm`/`parseBundleText`/`StalePlanImportError` + types; Task 3's import open-state; `loadArtifacts` from `$lib/state`; `ConflictError` from `$lib/api/errors`; Dialog/Button/Input primitives; kind icons as in Task 4.
- Produces: a self-mounting, prop-less dialog reading `getImportArtifactsOpen`/`setImportArtifactsOpen`. Task 6 mounts it.

**Behavior contract (spec §4):**
- Phase `pick`: file input (`data-testid="import-file"`, `accept=".json"`) + drop zone. Read file text → `parseBundleText` → on parse error show inline error and stay; on success `importPlan(bundle)` → phase `review`.
- Phase `review`:
  - Header: file name, "from {source_project.name}", exported_at.
  - Rows (`data-testid="import-row-{bundle_id}"`): kind icon, name, native `<select data-testid="import-action-{bundle_id}">` whose options are the row's LEGAL actions only:
    `create` → `['create','copy']`; `reuse` → `['reuse','copy']`; `copy` → `['copy','reuse']` (plan default first = selected). Labels: `Create`, `Reuse existing`, `Copy under new name`.
  - Hints: reuse rows "identical already exists"; copy rows "differs from existing".
  - When the effective action is `copy`: inline `<input data-testid="import-name-{bundle_id}">` shown, value = user edit ?? `copy_name ?? name`. Only USER-EDITED values are sent (`copyNames` record written exclusively by the input handler).
  - Skipped list below (`data-testid="import-skipped"`): one line per entry, `{bundle_id} — {reason}`.
  - Banner slot (`role="alert"`, `data-testid="import-banner"`) for conflict messages.
  - Footer: message `<Input data-testid="import-message" placeholder="Imported N artifacts from {source}">`; summary "X to create, Y to reuse, Z skipped"; Cancel; `<Button data-testid="import-submit">Import (N)</Button>` where N = non-reuse count (enabled even at 0 — all-reuse is a legitimate no-op; disabled only while busy or when `plan.entries` is empty AND skipped is also empty… keep it simple: disabled while busy).
- Phase `result` (`data-testid="import-result"`): created (name list), reused count, skipped list; `rev === null` renders "Nothing to import — everything already exists." as SUCCESS. Fire `void loadArtifacts()` on entering result. Close button.
- Conflicts: `StalePlanImportError` → `plan = err.plan`, RESEED decisions/copyNames (keep a prior decision only if still legal for the fresh entry; keep a copy-name edit only if the fresh decision is copy), banner = err.detail, stay in review. Plain `ConflictError` → re-run `importPlan(bundle)`, reseed the same way, banner = "The project changed concurrently — the plan was refreshed." No automatic retry loops.
- Closing the dialog resets ALL local state (phase, bundle, plan, decisions, edits, banner).

- [ ] **Step 1: Write the failing tests**

Same harness as Task 4. File-pick can be driven by calling the component's exported test hook — instead, drive it through the real input using a `File` and `Object.defineProperty(input, 'files', …)` + `dispatchEvent(new Event('change'))`; `File.text()` works in happy-dom.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as bundleApi from '$lib/api/artifact-bundle';
import { StalePlanImportError } from '$lib/api/artifact-bundle';
import { ConflictError } from '$lib/api/errors';
import * as artifactsApi from '$lib/api/artifacts';
import { openImportArtifacts, resetArtifacts, setImportArtifactsOpen } from '$lib/state';
import ImportArtifactsDialog from '../ImportArtifactsDialog.svelte';

const BUNDLE = {
	format: 'datarover.artifact-bundle/v1',
	exported_at: '2026-08-09T00:00:00Z',
	source_project: { id: 'src', name: 'City' },
	roots: ['n1'],
	artifacts: [
		{ id: 'n1', kind: 'navigation', name: 'Bus routes', payload: {} },
		{ id: 's1', kind: 'code_snippet', name: 'helpers', payload: {} }
	]
};

const PLAN = {
	entries: [
		{ bundle_id: 'n1', kind: 'navigation', name: 'Bus routes', action: 'create', existing_id: null, copy_name: null },
		{ bundle_id: 's1', kind: 'code_snippet', name: 'helpers', action: 'copy', existing_id: 'x9', copy_name: 'helpers (2)' }
	],
	skipped: [{ bundle_id: 'd1', reason: 'unknown kind' }]
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetArtifacts();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(ImportArtifactsDialog, { target: host });
	openImportArtifacts();
	flushSync();
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	setImportArtifactsOpen(false);
	host.remove();
	vi.restoreAllMocks();
});

async function pickBundle(json: string, name = 'fleet.bundle.json'): Promise<void> {
	const input = document.body.querySelector<HTMLInputElement>('[data-testid="import-file"]')!;
	const file = new File([json], name, { type: 'application/json' });
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
	// file.text() + importPlan are async — let both microtasks settle
	await vi.waitFor(() => {
		if (!document.body.querySelector('[data-testid="import-row-n1"], [data-testid="import-parse-error"]'))
			throw new Error('not settled');
	});
	flushSync();
}

describe('ImportArtifactsDialog', () => {
	it('rejects a malformed file inline without calling the server', async () => {
		const plan = vi.spyOn(bundleApi, 'importPlan');
		const input = document.body.querySelector<HTMLInputElement>('[data-testid="import-file"]')!;
		const file = new File(['{"format":"nope"}'], 'x.json');
		Object.defineProperty(input, 'files', { value: [file], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-parse-error"]')) throw new Error('pending');
		});
		expect(plan).not.toHaveBeenCalled();
	});

	it('renders the plan with per-row legal actions and the copy rename box', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		await pickBundle(JSON.stringify(BUNDLE));
		const createSel = document.body.querySelector<HTMLSelectElement>('[data-testid="import-action-n1"]')!;
		expect([...createSel.options].map((o) => o.value)).toEqual(['create', 'copy']);
		const copySel = document.body.querySelector<HTMLSelectElement>('[data-testid="import-action-s1"]')!;
		expect([...copySel.options].map((o) => o.value)).toEqual(['copy', 'reuse']);
		expect(
			document.body.querySelector<HTMLInputElement>('[data-testid="import-name-s1"]')!.value
		).toBe('helpers (2)');
		expect(document.body.querySelector('[data-testid="import-skipped"]')?.textContent).toContain('unknown kind');
	});

	it('sends only user-edited copy names and shows the result', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		const confirm = vi.spyOn(bundleApi, 'importConfirm').mockResolvedValue({
			rev: 5,
			created: [
				{ bundle_id: 'n1', id: 'a', name: 'Bus routes' },
				{ bundle_id: 's1', id: 'b', name: 'helpers (2)' }
			],
			reused: [],
			skipped: PLAN.skipped
		});
		await pickBundle(JSON.stringify(BUNDLE));
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-result"]')) throw new Error('pending');
		});
		const arg = confirm.mock.calls[0][0];
		expect(arg.copyNames).toEqual({}); // untouched proposal NOT sent
		expect(arg.decisions).toEqual({ n1: 'create', s1: 'copy' });
	});

	it('re-renders from the fresh plan on a stale-plan 409', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		const freshPlan = {
			entries: [
				{ bundle_id: 'n1', kind: 'navigation', name: 'Bus routes', action: 'reuse', existing_id: 'e1', copy_name: 'Bus routes (2)' },
				PLAN.entries[1]
			],
			skipped: []
		};
		vi.spyOn(bundleApi, 'importConfirm').mockRejectedValue(
			new StalePlanImportError('import plan is stale: name taken', freshPlan)
		);
		await pickBundle(JSON.stringify(BUNDLE));
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-banner"]')) throw new Error('pending');
		});
		flushSync();
		expect(document.body.querySelector('[data-testid="import-banner"]')?.textContent).toContain('stale');
		// n1's fresh legal set is reuse/copy — the old 'create' default is gone
		const sel = document.body.querySelector<HTMLSelectElement>('[data-testid="import-action-n1"]')!;
		expect([...sel.options].map((o) => o.value)).toEqual(['reuse', 'copy']);
	});

	it('re-plans from the held bundle on a plan-less 409', async () => {
		const plan = vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		vi.spyOn(bundleApi, 'importConfirm').mockRejectedValue(
			new ConflictError(409, { detail: 'conflict', model_rev: 3 }, 'conflict')
		);
		await pickBundle(JSON.stringify(BUNDLE));
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-banner"]')) throw new Error('pending');
		});
		expect(plan).toHaveBeenCalledTimes(2); // pick + re-plan
		expect(document.body.querySelector('[data-testid="import-banner"]')?.textContent).toContain('concurrently');
	});

	it('renders rev:null as a successful no-op', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue({ entries: [PLAN.entries[1]], skipped: [] });
		vi.spyOn(bundleApi, 'importConfirm').mockResolvedValue({
			rev: null,
			created: [],
			reused: [{ bundle_id: 's1', existing_id: 'x9' }],
			skipped: []
		});
		await pickBundle(JSON.stringify(BUNDLE));
		const sel = document.body.querySelector<HTMLSelectElement>('[data-testid="import-action-s1"]')!;
		sel.value = 'reuse';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-result"]')) throw new Error('pending');
		});
		expect(document.body.querySelector('[data-testid="import-result"]')?.textContent).toContain(
			'Nothing to import'
		);
	});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/ImportArtifactsDialog.test.ts
```

Expected: FAIL — component not found.

- [ ] **Step 3: Implement the component**

Core script (template follows the behavior contract; styling per repo conventions):

```svelte
<script lang="ts">
	import { FileCode, Route, Table } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { getImportArtifactsOpen, loadArtifacts, setImportArtifactsOpen } from '$lib/state';
	import { ConflictError } from '$lib/api/errors';
	import {
		importConfirm,
		importPlan,
		parseBundleText,
		StalePlanImportError,
		type ArtifactBundle,
		type ImportConfirmResponse,
		type ImportPlan,
		type PlanEntry
	} from '$lib/api/artifact-bundle';

	type Action = 'create' | 'reuse' | 'copy';
	type Phase = 'pick' | 'review' | 'result';

	const ICONS: Record<string, typeof Route> = {
		navigation: Route,
		table: Table,
		code_snippet: FileCode
	};
	const ACTION_LABEL: Record<Action, string> = {
		create: 'Create',
		reuse: 'Reuse existing',
		copy: 'Copy under new name'
	};

	const open = $derived(getImportArtifactsOpen());

	let phase = $state<Phase>('pick');
	let fileName = $state('');
	let bundle = $state<ArtifactBundle | null>(null);
	let plan = $state<ImportPlan | null>(null);
	let decisions = $state<Record<string, Action>>({});
	let copyNames = $state<Record<string, string>>({}); // USER edits only
	let message = $state('');
	let banner = $state<string | null>(null);
	let parseError = $state<string | null>(null);
	let busy = $state(false);
	let result = $state<ImportConfirmResponse | null>(null);

	$effect(() => {
		if (!open) reset();
	});

	function reset(): void {
		phase = 'pick';
		fileName = '';
		bundle = null;
		plan = null;
		decisions = {};
		copyNames = {};
		message = '';
		banner = null;
		parseError = null;
		busy = false;
		result = null;
	}

	/** The actions build_import_ops can honor for this entry — mirror of the
	 * backend matrix; offering anything wider guarantees a StalePlanError. */
	function legalActions(e: PlanEntry): Action[] {
		if (e.action === 'create') return ['create', 'copy'];
		if (e.action === 'reuse') return ['reuse', 'copy'];
		return ['copy', 'reuse'];
	}

	function effectiveAction(e: PlanEntry): Action {
		return decisions[e.bundle_id] ?? e.action;
	}

	/** Adopt a fresh plan, keeping prior decisions/renames only where the
	 * fresh entry still allows them. */
	function adoptPlan(fresh: ImportPlan): void {
		const d: Record<string, Action> = {};
		const c: Record<string, string> = {};
		for (const e of fresh.entries) {
			const prev = decisions[e.bundle_id];
			d[e.bundle_id] = prev !== undefined && legalActions(e).includes(prev) ? prev : e.action;
			const name = copyNames[e.bundle_id];
			if (name !== undefined && d[e.bundle_id] === 'copy') c[e.bundle_id] = name;
		}
		plan = fresh;
		decisions = d;
		copyNames = c;
	}

	async function onFilePicked(f: File | null | undefined): Promise<void> {
		if (!f) return;
		parseError = null;
		let parsed: ArtifactBundle;
		try {
			parsed = parseBundleText(await f.text());
		} catch {
			parseError = 'Not a valid artifact bundle file.';
			return;
		}
		fileName = f.name;
		bundle = parsed;
		busy = true;
		try {
			const p = await importPlan(parsed);
			decisions = {};
			copyNames = {};
			adoptPlan(p);
			phase = 'review';
		} catch (err) {
			parseError = err instanceof Error ? err.message : 'Could not plan the import.';
		} finally {
			busy = false;
		}
	}

	const toCreate = $derived(
		(plan?.entries ?? []).filter((e) => effectiveAction(e) !== 'reuse').length
	);
	const toReuse = $derived((plan?.entries ?? []).filter((e) => effectiveAction(e) === 'reuse').length);

	async function onConfirm(): Promise<void> {
		if (bundle === null || plan === null) return;
		banner = null;
		busy = true;
		try {
			const d: Record<string, Action> = {};
			for (const e of plan.entries) d[e.bundle_id] = effectiveAction(e);
			const res = await importConfirm({
				bundle,
				decisions: d,
				copyNames,
				message: message.trim()
			});
			result = res;
			phase = 'result';
			void loadArtifacts().catch(() => {});
		} catch (err) {
			if (err instanceof StalePlanImportError) {
				adoptPlan(err.plan);
				banner = err.detail;
			} else if (err instanceof ConflictError && bundle !== null) {
				try {
					adoptPlan(await importPlan(bundle));
					banner = 'The project changed concurrently — the plan was refreshed.';
				} catch {
					banner = 'The project changed concurrently. Close and retry.';
				}
			} else {
				banner = err instanceof Error ? err.message : 'Import failed.';
			}
		} finally {
			busy = false;
		}
	}
</script>
```

Template notes:
- pick phase: hidden `<input type="file" accept=".json" data-testid="import-file" onchange={(e) => void onFilePicked((e.target as HTMLInputElement).files?.[0])}>` behind a `FileSlot`-style drop-zone button; `{#if parseError}<p data-testid="import-parse-error" role="alert">{parseError}</p>{/if}`.
- review phase: banner `{#if banner}<p data-testid="import-banner" role="alert">{banner}</p>{/if}`; rows with `<select data-testid={`import-action-${e.bundle_id}`} value={effectiveAction(e)} onchange={…decisions[e.bundle_id] = value…}>` iterating `legalActions(e)` with `ACTION_LABEL`; copy-name input `{#if effectiveAction(e) === 'copy'}<input data-testid={`import-name-${e.bundle_id}`} value={copyNames[e.bundle_id] ?? e.copy_name ?? e.name} oninput={(ev) => (copyNames = { ...copyNames, [e.bundle_id]: ev.currentTarget.value })}>{/if}`; hints per row action; skipped block `data-testid="import-skipped"`; footer with message input (placeholder `Imported {toCreate} artifacts from {bundle?.source_project.name}`), summary `{toCreate} to create, {toReuse} to reuse, {plan?.skipped.length ?? 0} skipped`, Cancel, `<Button data-testid="import-submit" disabled={busy} onclick={() => void onConfirm()}>Import ({toCreate})</Button>`.
- result phase: `data-testid="import-result"` block; when `result.rev === null` → "Nothing to import — everything already exists."; otherwise created list (`{name}` each), "{result.reused.length} reused", skipped repeats; Close button → `setImportArtifactsOpen(false)`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/ImportArtifactsDialog.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Format, lint, commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run format && npm run lint && npm run check'
git add frontend/src/lib/components/ImportArtifactsDialog.svelte frontend/src/lib/components/__tests__/ImportArtifactsDialog.test.ts
git commit -m "feat(ui): plan-and-confirm import-artifacts dialog"
```

---

### Task 6: ArtifactsMenu + TopBar toolbar + command palette

**Files:**
- Create: `frontend/src/lib/components/ArtifactsMenu.svelte`
- Modify: `frontend/src/lib/components/TopBar.svelte` (left cluster, after the Info tooltip div)
- Modify: `frontend/src/lib/components/CommandPalette.svelte` (two new action items)
- Test: `frontend/src/lib/components/__tests__/ArtifactsMenu.test.ts`

**Interfaces:**
- Consumes: Task 3 openers; Task 4/5 dialogs (mounted here, once); `canEdit` from `$lib/state`; `DropdownMenu` primitives; `Package` icon.
- Produces: `<ArtifactsMenu />`, prop-less.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import { resetArtifacts, setProjectInfo } from '$lib/state';
import { resetCheckout } from '$lib/state/checkout.svelte';
import ArtifactsMenu from '../ArtifactsMenu.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetArtifacts();
	resetCheckout();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	vi.restoreAllMocks();
});

function openMenu(role: 'editor' | 'viewer') {
	setProjectInfo({ role, lockTtlSeconds: 300 });
	app = mount(ArtifactsMenu, { target: host });
	flushSync();
	host.querySelector<HTMLButtonElement>('[data-testid="artifacts-menu-trigger"]')!.click();
	flushSync();
}

describe('ArtifactsMenu', () => {
	it('offers Export and Import to an editor', () => {
		openMenu('editor');
		const items = [...document.body.querySelectorAll('[role="menuitem"]')].map(
			(n) => n.textContent?.trim()
		);
		expect(items).toContain('Export…');
		expect(items).toContain('Import…');
	});

	it('hides Import from a viewer', () => {
		openMenu('viewer');
		const items = [...document.body.querySelectorAll('[role="menuitem"]')].map(
			(n) => n.textContent?.trim()
		);
		expect(items).toContain('Export…');
		expect(items).not.toContain('Import…');
	});
});
```

(If `setProjectInfo`'s exact signature differs, mirror how `artifacts-section.test.ts` sets the editor role — it uses `setProjectInfo({ role: 'editor', lockTtlSeconds: 300 })`.)

- [ ] **Step 2: Run to verify failure**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/ArtifactsMenu.test.ts
```

Expected: FAIL — component not found.

- [ ] **Step 3: Implement**

`ArtifactsMenu.svelte`:

```svelte
<script lang="ts">
	import { ChevronDown, Package } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { canEdit, openExportArtifacts, openImportArtifacts } from '$lib/state';
	import ExportArtifactsDialog from './ExportArtifactsDialog.svelte';
	import ImportArtifactsDialog from './ImportArtifactsDialog.svelte';

	const editable = $derived(canEdit());
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		data-testid="artifacts-menu-trigger"
		class="flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
	>
		<Package class="h-3.5 w-3.5" />
		Artifacts
		<ChevronDown class="h-3 w-3" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-40">
		<DropdownMenu.Item onclick={() => openExportArtifacts()}>Export…</DropdownMenu.Item>
		{#if editable}
			<DropdownMenu.Item onclick={() => openImportArtifacts()}>Import…</DropdownMenu.Item>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>

<ExportArtifactsDialog />
<ImportArtifactsDialog />
```

`TopBar.svelte` — in the left cluster, after the Info tooltip `</div>`, add the toolbar region (this is THE growable toolbar; future feature buttons append inside the `<nav>`):

```svelte
			<div class="h-5 w-px bg-border" aria-hidden="true"></div>
			<nav aria-label="Toolbar" class="flex items-center gap-1">
				<ArtifactsMenu />
			</nav>
```

plus `import ArtifactsMenu from './ArtifactsMenu.svelte';`.

`CommandPalette.svelte` — add beside the existing `action:*` items (import `canEdit`, `openExportArtifacts`, `openImportArtifacts` from `$lib/state`; close the palette first, matching how the other actions do it):

```svelte
			<Command.Item value="action:export-artifacts" onSelect={actionExportArtifacts}>
				Export artifacts…
			</Command.Item>
			{#if canEdit()}
				<Command.Item value="action:import-artifacts" onSelect={actionImportArtifacts}>
					Import artifacts…
				</Command.Item>
			{/if}
```

```ts
	function actionExportArtifacts(): void {
		setCommandPaletteOpen(false);
		openExportArtifacts();
	}
	function actionImportArtifacts(): void {
		setCommandPaletteOpen(false);
		openImportArtifacts();
	}
```

- [ ] **Step 4: Run the new test + the whole component suite (TopBar tests must stay green)**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/ArtifactsMenu.test.ts
pixi run frontend-test
```

Expected: new tests PASS; no regressions (TopBar.test.ts renders the header — if it asserts on left-cluster structure, update it to tolerate the new nav).

- [ ] **Step 5: Format, lint, commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run format && npm run lint && npm run check'
git add frontend/src/lib/components/ArtifactsMenu.svelte frontend/src/lib/components/TopBar.svelte frontend/src/lib/components/CommandPalette.svelte frontend/src/lib/components/__tests__/ArtifactsMenu.test.ts
git commit -m "feat(ui): TopBar toolbar with Artifacts export/import menu + palette entries"
```

---

### Task 7: Workspace tab export button

**Files:**
- Modify: `frontend/src/lib/components/Workspace.svelte`
- Test: `frontend/src/lib/components/__tests__/Workspace.export-button.test.ts`

**Interfaces:**
- Consumes: `openExportArtifacts`, `getExportArtifactsSeed`, `getExportArtifactsOpen` (Task 3), `isTempId` from `$lib/state/ops`, existing `getDynamicTabs`/`getActiveTab`/`openArtifactTab`.

**Behavior:** when the ACTIVE tab is a dynamic tab whose `artifactId` is non-null and not a temp id, render one small icon button (`data-testid="tab-export"`, `aria-label` `Export {tab.title}…`) at the right end of the `Tabs.List`; clicking calls `openExportArtifacts([artifactId])`. No button on the static tabs, on drafts (`artifactId === null`), or on temp-id staged creates. Viewer-allowed (export is a read).

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import {
	getExportArtifactsOpen,
	getExportArtifactsSeed,
	openArtifactTab,
	resetArtifacts,
	resetWorkspaceTabs,
	setActiveTab,
	setExportArtifactsOpen,
	setProjectInfo
} from '$lib/state';
import { resetCheckout } from '$lib/state/checkout.svelte';
import Workspace from '../Workspace.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetArtifacts();
	resetWorkspaceTabs();
	resetCheckout();
	setProjectInfo({ role: 'viewer', lockTtlSeconds: 300 });
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Workspace, { target: host });
	flushSync();
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	setExportArtifactsOpen(false);
	resetWorkspaceTabs();
	host.remove();
	vi.restoreAllMocks();
});

describe('workspace tab export button', () => {
	it('is absent on static tabs and drafts, present on a saved-artifact tab', () => {
		expect(host.querySelector('[data-testid="tab-export"]')).toBeNull();
		const draft = openArtifactTab('table', { artifactId: null, title: 'New table' });
		setActiveTab(draft);
		flushSync();
		expect(host.querySelector('[data-testid="tab-export"]')).toBeNull();
		const saved = openArtifactTab('table', { artifactId: 'art1', title: 'Fleet' });
		setActiveTab(saved);
		flushSync();
		expect(host.querySelector('[data-testid="tab-export"]')).not.toBeNull();
	});

	it('opens the export dialog seeded with the tab artifact', () => {
		const saved = openArtifactTab('table', { artifactId: 'art1', title: 'Fleet' });
		setActiveTab(saved);
		flushSync();
		host.querySelector<HTMLButtonElement>('[data-testid="tab-export"]')!.click();
		flushSync();
		expect(getExportArtifactsOpen()).toBe(true);
		expect(getExportArtifactsSeed()).toEqual(['art1']);
	});
});
```

(Note: mounting Workspace renders TableView etc. for the open tab; if a child component requires more state than the reset defaults, mock at the boundary the existing `WorkspacePage.*.test.ts` files use — check them if the mount throws.)

- [ ] **Step 2: Run to verify failure**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/Workspace.export-button.test.ts
```

Expected: FAIL — no `[data-testid="tab-export"]`.

- [ ] **Step 3: Implement**

In `Workspace.svelte`, inside `Tabs.List` after the `{#each dynamicTabs …}` triggers:

```svelte
				{@const activeArtifact = dynamicTabs.find(
					(t) => t.id === activeTab && t.artifactId !== null && !isTempId(t.artifactId)
				)}
				{#if activeArtifact && activeArtifact.artifactId !== null}
					{@const seedId = activeArtifact.artifactId}
					<button
						type="button"
						data-testid="tab-export"
						aria-label={`Export ${activeArtifact.title}…`}
						title={`Export ${activeArtifact.title}…`}
						class="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
						onclick={() => openExportArtifacts([seedId])}
					>
						<FileUp class="size-3.5" />
					</button>
				{/if}
```

Imports: `FileUp` added to the `@lucide/svelte` import, `openExportArtifacts` added to the `$lib/state` import, `import { isTempId } from '$lib/state/ops';`.

- [ ] **Step 4: Run tests**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/Workspace.export-button.test.ts
pixi run frontend-test
```

Expected: PASS; no regressions.

- [ ] **Step 5: Format, lint, commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run format && npm run lint && npm run check'
git add frontend/src/lib/components/Workspace.svelte frontend/src/lib/components/__tests__/Workspace.export-button.test.ts
git commit -m "feat(ui): per-tab export button seeding the export dialog"
```

---

### Task 8: New Project wizard — artifacts slot + skipped warning

**Files:**
- Modify: `frontend/src/lib/api/projects.ts`
- Modify: `frontend/src/lib/components/projects/NewProjectWizard.svelte`
- Test: extend `frontend/src/lib/components/__tests__/NewProjectWizard.test.ts` (read it first; extend, don't rewrite)

**Interfaces:**
- Consumes: Task 1's wire field. `FileSlot` (existing), `cancelJourney` (existing import in the wizard).
- Produces: `CreateProjectInput` gains `artifacts?: File | null`; `createProject` returns `ProjectCreated` (`ProjectSummary & { skipped_artifacts: {bundle_id, reason}[] }`).

- [ ] **Step 1: Write the failing tests**

Add to `NewProjectWizard.test.ts`, following its existing harness (it mocks `$lib/api/projects`):

```ts
it('sends the artifacts bundle part and reports skipped artifacts before navigating', async () => {
	const create = vi.spyOn(projectsApi, 'createProject').mockResolvedValue({
		id: 'p9',
		name: 'P',
		role: 'owner',
		skipped_artifacts: [{ bundle_id: 'd1', reason: 'unknown kind' }]
	});
	const onCreated = vi.fn();
	// …mount wizard with onCreated, fill name + metamodel file per the
	// existing tests, then also set the artifacts slot:
	// setFile('[data-testid="artifacts-input"]', new File(['{}'], 'b.json'))
	// …submit…
	expect(create.mock.calls[0][0].artifacts).toBeInstanceOf(File);
	// navigation is DEFERRED: the warning panel shows first
	expect(onCreated).not.toHaveBeenCalled();
	expect(document.body.textContent).toContain('unknown kind');
	document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-open-anyway"]')!.click();
	await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('p9'));
});

it('navigates straight through when nothing was skipped', async () => {
	vi.spyOn(projectsApi, 'createProject').mockResolvedValue({
		id: 'p9',
		name: 'P',
		role: 'owner',
		skipped_artifacts: []
	});
	// …fill + submit as above (no artifacts file needed)…
	await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('p9'));
});
```

(Adapt mount/fill helpers to the file's existing style — the point of the assertions is the deferred-navigation contract and the FormData field.)

- [ ] **Step 2: Run to verify failure**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/NewProjectWizard.test.ts
```

Expected: new cases FAIL (`skipped_artifacts` unknown / no artifacts slot / no warning panel).

- [ ] **Step 3: Implement**

`projects.ts`:

```ts
export const SkippedArtifactSchema = z.object({ bundle_id: z.string(), reason: z.string() });
export const ProjectCreatedSchema = ProjectSummarySchema.extend({
	skipped_artifacts: z.array(SkippedArtifactSchema).default([])
});
export type ProjectCreated = z.infer<typeof ProjectCreatedSchema>;

export interface CreateProjectInput {
	name: string;
	metamodel: File;
	model?: File | null;
	view?: File | null;
	artifacts?: File | null;
}

export function createProject(
	input: CreateProjectInput,
	onProgress?: (loaded: number, total: number | null) => void
): Promise<ProjectCreated> {
	const form = new FormData();
	form.set('name', input.name);
	form.set('metamodel', input.metamodel);
	if (input.model) form.set('model', input.model);
	if (input.view) form.set('view', input.view);
	if (input.artifacts) form.set('artifacts', input.artifacts);
	return apiUpload('/projects', { body: form, schema: ProjectCreatedSchema, onProgress }, API);
}
```

`NewProjectWizard.svelte`:
- add `let artifacts = $state<File | null>(null);` and `let skipped = $state<{ bundle_id: string; reason: string }[] | null>(null);` + `let createdId = $state<string | null>(null);`
- fourth slot after View:

```svelte
					<FileSlot
						label="Artifacts"
						hint=".bundle.json"
						accept=".json"
						disabled={pending}
						testid="artifacts-input"
						bind:file={artifacts}
					/>
```

- submit handler: pass `artifacts` through; after `createProject` resolves, branch:

```ts
			const created = await createProject({ name, metamodel, model, view, artifacts }, (l, t) => {
				journeyUpload(l, t);
			});
			if (created.skipped_artifacts.length > 0) {
				// Show the warning BEFORE entering the project: the journey bar is
				// torn down (boot() starts its own when the user proceeds).
				cancelJourney();
				createdId = created.id;
				skipped = created.skipped_artifacts;
				return;
			}
			await onCreated(created.id);
```

- template: when `skipped !== null`, replace the form body with the warning panel (project IS created):

```svelte
				<div class="flex flex-col gap-3 px-6 py-5">
					<p class="text-sm text-foreground/90">
						Project created — {skipped.length}
						{skipped.length === 1 ? 'artifact was' : 'artifacts were'} skipped:
					</p>
					<ul class="flex flex-col gap-1 text-xs text-warning">
						{#each skipped as s (s.bundle_id)}
							<li>{s.bundle_id} — {s.reason}</li>
						{/each}
					</ul>
				</div>
				<Dialog.Footer class="border-t border-border bg-muted/30 px-6 py-4">
					<Button
						type="button"
						data-testid="wizard-open-anyway"
						onclick={() => createdId !== null && void onCreated(createdId)}
					>
						Open project
					</Button>
				</Dialog.Footer>
```

- reset `skipped`/`createdId`/`artifacts` when the dialog closes (there is a `$effect`/handler for `open` — extend whatever the file already does on close; if nothing, add `$effect(() => { if (!open) { skipped = null; createdId = null; artifacts = null; } })`).

- [ ] **Step 4: Run tests**

```bash
pixi run frontend-test -- run src/lib/components/__tests__/NewProjectWizard.test.ts
pixi run frontend-test
```

Expected: PASS; no regressions (ProjectsPage.test.ts touches the wizard — keep it green).

- [ ] **Step 5: Format, lint, commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run format && npm run lint && npm run check'
git add frontend/src/lib/api/projects.ts frontend/src/lib/components/projects/NewProjectWizard.svelte frontend/src/lib/components/__tests__/NewProjectWizard.test.ts
git commit -m "feat(ui): wizard artifacts-bundle slot with skipped-artifact warning"
```

---

### Task 9: Docs + full gates

**Files:**
- Modify: `frontend/README.md` (Layout bullet for TopBar; add an "Artifact import/export" paragraph near the artifacts architecture section; "Where to find things" entries for `api/artifact-bundle.ts`, `ArtifactsMenu.svelte`, the two dialogs)
- Modify: `CLAUDE.md` (extend the Phase 3 bullet's tail with one sentence: the frontend now exposes export/preview/import via the TopBar Artifacts menu + workspace tab button, and the wizard accepts a bundle and surfaces `ProjectOut.skipped_artifacts`)

- [ ] **Step 1: Write the doc updates**

`frontend/README.md`:
- TopBar bullet: mention the toolbar region ("a growable toolbar next to the logo hosts feature menus; first occupant is **Artifacts** — Export…/Import…").
- New paragraph (after the artifact staged-commit bullets): export = viewer-allowed closure download with live preview (`ExportArtifactsDialog`, seeded by the workspace tab-strip export button); import = stateless plan→confirm through `ImportArtifactsDialog` (per-row create/reuse/copy + rename, fresh-plan 409 recovery, `rev: null` no-op); the imported artifacts appear ONLY in the flat artifacts list, never in the view; wizard's fourth slot + skipped warning.
- "Where to find things": `api/artifact-bundle.ts — bundle export/preview/import client (typed stale-plan 409)`, `components/ArtifactsMenu.svelte + Export/ImportArtifactsDialog`.

`CLAUDE.md`: append one sentence to the Phase 3 bullet — do not restructure it.

- [ ] **Step 2: Run ALL gates**

```bash
pixi run core-test
pixi run frontend-test
pixi run -e frontend bash -c 'cd frontend && npm run lint && npm run check'
```

Expected: all green (core: 1691 passed, 26 deselected; frontend: ~1780+ passed).

- [ ] **Step 3: Commit**

```bash
git add frontend/README.md CLAUDE.md
git commit -m "docs: artifact import/export UI + wizard bundle slot"
```

---

## After the tasks

Per the session process precedent (NOT part of any single task):
1. Final whole-branch review on the most capable model (`superpowers:requesting-code-review` / the repo's review flow).
2. ONE fix wave for the findings, re-reviewed.
3. `git checkout main && git merge --no-ff feature/artefacts-phase-3-frontend && git branch -d feature/artefacts-phase-3-frontend`.
4. Do NOT push unless the user asks.

## Self-Review (completed)

- **Spec coverage:** toolbar+menu (T6), palette (T6), tab button (T7), export dialog incl. filter/seed/staged-note (T4), import dialog incl. both 409 shapes + rev:null + skipped (T5), API client + typed errors (T2), ui open-state (T3), wizard slot + backend skip list (T1+T8), docs+gates (T9). Standing declines (no view placement, no staging) are constraints, not tasks. ✔
- **Placeholder scan:** all steps carry runnable code or exact file-anchored instructions; the two "adapt to the file's existing harness" notes in T5/T8 point at concrete files whose patterns the implementer must read — deliberate, since those harnesses already exist. ✔
- **Type consistency:** `ExportPreview`/`ImportPlan`/`PlanEntry`/`StalePlanImportError`/`ImportConfirmResponse` names match between T2 and T4/T5; `openExportArtifacts`/seed accessors match T3↔T4/T6/T7; `skipped_artifacts` shape matches T1↔T8. ✔
