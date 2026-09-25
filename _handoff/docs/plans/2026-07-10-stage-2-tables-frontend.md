# Stage 2 — Table System — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the table UI — a pure `columns.ts` helper module, a
`table-editor` Svelte store, `components/Table/` (grid, column manager, cell
editing through the existing checkout flow), the workspace/sidebar/tree
generalizations to a second artifact kind, xlsx download, "open navigation as
table", and root-level artifact placement in the view.

**Architecture:** Mirrors Stage 1's navigation frontend one-for-one:
`lib/table/columns.ts` (pure, unit-tested) ↔ `lib/navigation/tree.ts`;
`state/table-editor.svelte.ts` ↔ `state/navigation-editor.svelte.ts`;
`components/Table/` ↔ `components/Navigation/`. Cell editing reuses the
Inspector's exact path (`editLock` → `emit` → `DiffDrawer` → `POST /commits`),
inventing no new mutation surface.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, zod, vitest (happy-dom +
MSW), Playwright. All npm scripts run **from inside `frontend/`**.

## Global Constraints

- Frontend npm scripts MUST run via
  `pixi run -e frontend bash -c 'cd frontend && <cmd>'` — the bare
  `pixi run -e frontend npm test` fails ("Missing script") because pixi runs from
  the repo root.
- `npm run lint` has two **pre-existing** prettier failures on main
  (`ProjectCard.test.ts`, `UsersTab.test.ts`). Don't fix them; don't add new ones.
- Svelte cards that register/unregister store state inside `$effect` MUST use the
  `untrack()` idiom (see `PathCard.svelte`) — a literal read-then-write effect
  infinite-loops.
- Cell editing goes through the existing checkout flow (locks → staged
  `set_property` → `POST /commits`), same as the Inspector — never a new path.
- `apiFetchRaw` (in `src/lib/api/client.ts`) already returns the raw `Response`
  with CSRF applied; use it for the xlsx download — no client change needed.
- Follow existing patterns: zod schemas in `src/lib/api/types.ts`, API modules in
  `src/lib/api/`, state stores in `src/lib/state/`.

## Verification commands

- Unit: `pixi run -e frontend bash -c 'cd frontend && npm test'`
- One file: `pixi run -e frontend bash -c 'cd frontend && npm test -- columns'`
- Types: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
- E2E: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`

---

### Task 1: API types + client for tables

**Files:**
- Modify: `src/lib/api/types.ts`
- Create: `src/lib/api/tables.ts`
- Test: `src/lib/api/__tests__/tables.test.ts` (if the dir convention exists; else
  colocate as `src/lib/api/tables.test.ts` following the repo's pattern)

**Interfaces:**
- Produces: zod schemas `TableDefinitionSchema`, `TablePageSchema`, `TableCellSchema`,
  and TS types `TableDefinition`, `TablePage`, `TableCell`, `TableColumn`,
  `TableRow`, `TableSort`; client functions `evaluateTable`, `exportTable`.

- [ ] **Step 1: Write the failing client test**

In the test file (use MSW like the existing `artifacts` tests — read
`src/lib/api/*.test.ts` or the MSW handler setup first):

```ts
import { describe, it, expect } from 'vitest';
import { TablePageSchema } from '$lib/api/types';

describe('TablePageSchema', () => {
  it('parses an element + value row', () => {
    const page = TablePageSchema.parse({
      columns: [{ kind: 'element', header: '', width_px: null }],
      rows: [{ key: ['e1'], cells: [
        { kind: 'element', item: { id: 'e1', type_name: 'Block',
          display_name: 'B', child_count: 0 } }] }],
      total: 1, truncated: false, offset: 0, model_rev: 3,
    });
    expect(page.rows[0].cells[0].kind).toBe('element');
  });

  it('parses a value cell with editable flag', () => {
    const page = TablePageSchema.parse({
      columns: [{ kind: 'property', header: 'Mass', width_px: 120 }],
      rows: [{ key: ['e1'], cells: [
        { kind: 'value', present: true, value: 10, element_id: 'e1', editable: true }] }],
      total: 1, truncated: false, offset: 0, model_rev: 3,
    });
    const cell = page.rows[0].cells[0];
    expect(cell.kind === 'value' && cell.editable).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- tables'`
Expected: FAIL (`TablePageSchema` not exported).

- [ ] **Step 3: Add zod schemas + types**

In `src/lib/api/types.ts`, after the navigation/`ChainPage` schemas, add (reusing
`TreeItemSchema` already defined there — find it, it backs `ChainPage`):

```ts
// ---- Table definition (mirrors core/table/schema.py) -----------------------
export const NavigationSourceSchema = z.object({
  ref: z.string().nullish(),
  definition: NavigationDefinitionSchema.nullish(),
});

const RowSlotSchema = z.object({ kind: z.literal('row'), chain_index: z.number().int().default(0) });
const ColumnRefSchema = z.object({ kind: z.literal('column'), index: z.number().int() });
export const ColumnSourceSchema = z.discriminatedUnion('kind', [RowSlotSchema, ColumnRefSchema]);

export const ScopeRowsSchema = z.object({
  kind: z.literal('scope'), types: z.array(z.string()).default([]),
  criteria: z.array(CriterionSchema).default([]),
});
export const NavigationRowsSchema = z.object({
  kind: z.literal('navigation'), navigation: NavigationSourceSchema,
  step_index: z.number().int().nullish(),
});
export const ChainRowsSchema = z.object({
  kind: z.literal('chains'), navigation: NavigationSourceSchema,
});
export const RowSourceSchema = z.discriminatedUnion('kind', [
  ScopeRowsSchema, NavigationRowsSchema, ChainRowsSchema,
]);

const ElementColumnSchema = z.object({
  kind: z.literal('element'), source: ColumnSourceSchema.default({ kind: 'row', chain_index: 0 }),
  header: z.string().default(''), width_px: z.number().int().nullish(),
});
const PropertyColumnSchema = z.object({
  kind: z.literal('property'), source: ColumnSourceSchema.default({ kind: 'row', chain_index: 0 }),
  name: z.string(), mode: z.enum(['collapse', 'expand']).default('collapse'),
  keep_empty: z.boolean().default(true),
  header: z.string().default(''), width_px: z.number().int().nullish(),
});
const NavigationColumnSchema = z.object({
  kind: z.literal('navigation'), source: ColumnSourceSchema.default({ kind: 'row', chain_index: 0 }),
  navigation: NavigationSourceSchema, step_index: z.number().int().nullish(),
  mode: z.enum(['collapse', 'expand']).default('collapse'),
  keep_empty: z.boolean().default(true),
  sort_mode: z.enum(['value', 'count']).default('value'),
  cell_cap: z.number().int().default(20),
  header: z.string().default(''), width_px: z.number().int().nullish(),
});
export const ColumnSchema = z.discriminatedUnion('kind', [
  ElementColumnSchema, PropertyColumnSchema, NavigationColumnSchema,
]);

export const TableDefinitionSchema = z.object({
  schema_version: z.number().int().default(1),
  row_source: RowSourceSchema,
  columns: z.array(ColumnSchema).min(1),
  default_cell_mode: z.enum(['collapse', 'expand']).default('collapse'),
});
export type TableDefinition = z.infer<typeof TableDefinitionSchema>;
export type Column = z.infer<typeof ColumnSchema>;
export type RowSource = z.infer<typeof RowSourceSchema>;
export type ColumnSource = z.infer<typeof ColumnSourceSchema>;

// ---- Table page (evaluate response) ----------------------------------------
export const TableColumnSchema = z.object({
  kind: z.string(), header: z.string(), width_px: z.number().int().nullish(),
});
export const TableCellSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('element'), item: TreeItemSchema.nullable() }),
  z.object({ kind: z.literal('value'), present: z.boolean(), value: z.unknown().nullable(),
             element_id: z.string().nullable(), editable: z.boolean() }),
  z.object({ kind: z.literal('values'), present: z.boolean(), values: z.array(z.unknown()),
             total: z.number().int(), truncated: z.boolean() }),
  z.object({ kind: z.literal('elements'), items: z.array(TreeItemSchema),
             total: z.number().int(), truncated: z.boolean() }),
]);
export const TableRowSchema = z.object({
  key: z.array(z.unknown()), cells: z.array(TableCellSchema),
});
export const TablePageSchema = z.object({
  columns: z.array(TableColumnSchema), rows: z.array(TableRowSchema),
  total: z.number().int(), truncated: z.boolean(), offset: z.number().int(),
  model_rev: z.number().int(),
});
export type TablePage = z.infer<typeof TablePageSchema>;
export type TableCell = z.infer<typeof TableCellSchema>;
export type TableColumn = z.infer<typeof TableColumnSchema>;
export type TableRow = z.infer<typeof TableRowSchema>;
export type TableSort = { column: number; direction: 'asc' | 'desc' };
```

(Names `NavigationDefinitionSchema`, `CriterionSchema`, `TreeItemSchema` already
exist — confirm the exact exported identifiers and match them.)

- [ ] **Step 4: Write the client module**

Create `src/lib/api/tables.ts`:

```ts
import { apiFetch, apiFetchRaw, type ClientConfig } from './client';
import { TablePageSchema, type TableDefinition, type TablePage, type TableSort } from './types';

interface EvaluateArgs {
  definition?: TableDefinition;
  artifactId?: string;
  offset?: number;
  limit?: number;
  sort?: TableSort;
}

export function evaluateTable(args: EvaluateArgs, cfg?: ClientConfig): Promise<TablePage> {
  const body = {
    definition: args.definition, artifact_id: args.artifactId,
    offset: args.offset ?? 0, limit: args.limit ?? 100, sort: args.sort,
  };
  return apiFetch('/tables/evaluate', { method: 'POST', body, schema: TablePageSchema }, cfg);
}

/** Fetch the xlsx as a Blob (raw Response → blob); caller triggers the download. */
export async function exportTable(
  args: { definition?: TableDefinition; artifactId?: string; sort?: TableSort },
  cfg?: ClientConfig,
): Promise<{ blob: Blob; filename: string }> {
  const res = await apiFetchRaw('/tables/export', {
    method: 'POST',
    body: { definition: args.definition, artifact_id: args.artifactId, sort: args.sort },
  }, cfg);
  const disp = res.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(disp);
  return { blob: await res.blob(), filename: m?.[1] ?? 'table.xlsx' };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- tables'`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/api/types.ts frontend/src/lib/api/tables.ts frontend/src/lib/api/**/tables.test.ts
git commit -m "feat(frontend): table API types and client"
```

---

### Task 2: `lib/table/columns.ts` — pure column edits

**Files:**
- Create: `src/lib/table/columns.ts`
- Test: `src/lib/table/__tests__/columns.test.ts`

**Interfaces:**
- Consumes: `TableDefinition`, `Column`, `ColumnSource` (Task 1 types).
- Produces pure functions (all return a NEW `TableDefinition`, never mutate):
  - `addColumn(defn, col) -> TableDefinition`
  - `removeColumn(defn, index) -> TableDefinition` (throws `ColumnInUseError` if
    another column sources it)
  - `moveColumn(defn, from, to) -> TableDefinition` (**remaps every
    `ColumnRef.index`**; throws if a move would make a ref point forward)
  - `renameColumn(defn, index, header) -> TableDefinition`
  - `setColumnWidth(defn, index, width_px) -> TableDefinition`
  - `setColumnMode(defn, index, mode) -> TableDefinition`
  - `columnLabel(col) -> string`
  - `class ColumnInUseError extends Error`

This is the module worth the most tests: index remapping on move is exactly the
kind of arithmetic that silently corrupts a definition.

- [ ] **Step 1: Write the failing tests**

In `src/lib/table/__tests__/columns.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { addColumn, removeColumn, moveColumn, ColumnInUseError } from '$lib/table/columns';
import type { TableDefinition } from '$lib/api/types';

const base: TableDefinition = {
  schema_version: 1, default_cell_mode: 'collapse',
  row_source: { kind: 'scope', types: ['Block'], criteria: [] },
  columns: [
    { kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null },
  ],
};

describe('columns', () => {
  it('addColumn appends', () => {
    const d = addColumn(base, { kind: 'property', source: { kind: 'row', chain_index: 0 },
      name: 'mass', mode: 'collapse', keep_empty: true, header: '', width_px: null });
    expect(d.columns).toHaveLength(2);
    expect(base.columns).toHaveLength(1); // immutable
  });

  it('removeColumn throws when another column sources it', () => {
    const withNav = addColumn(base, { kind: 'navigation',
      source: { kind: 'column', index: 0 }, mode: 'collapse', keep_empty: true,
      sort_mode: 'value', cell_cap: 20, header: '', width_px: null,
      navigation: { definition: { kind: 'path', start: { kind: 'row' }, steps: [] } } });
    expect(() => removeColumn(withNav, 0)).toThrow(ColumnInUseError);
  });

  it('moveColumn remaps ColumnRef.index', () => {
    // cols: [element(0), property(1), navigation source=column(1)(2)]
    let d = addColumn(base, { kind: 'property', source: { kind: 'row', chain_index: 0 },
      name: 'mass', mode: 'collapse', keep_empty: true, header: '', width_px: null });
    d = addColumn(d, { kind: 'navigation', source: { kind: 'column', index: 1 },
      mode: 'collapse', keep_empty: true, sort_mode: 'value', cell_cap: 20,
      header: '', width_px: null,
      navigation: { definition: { kind: 'path', start: { kind: 'row' }, steps: [] } } });
    // move property from 1 → 0; the nav column's source must follow to index 1
    const moved = moveColumn(d, 1, 0);
    const nav = moved.columns[2];
    expect(nav.source).toEqual({ kind: 'column', index: 0 });
  });

  it('moveColumn rejects a move that points a ref forward', () => {
    let d = addColumn(base, { kind: 'property', source: { kind: 'row', chain_index: 0 },
      name: 'mass', mode: 'collapse', keep_empty: true, header: '', width_px: null });
    d = addColumn(d, { kind: 'navigation', source: { kind: 'column', index: 1 },
      mode: 'collapse', keep_empty: true, sort_mode: 'value', cell_cap: 20,
      header: '', width_px: null,
      navigation: { definition: { kind: 'path', start: { kind: 'row' }, steps: [] } } });
    // moving the nav column (2) before its source (1) would make it point forward
    expect(() => moveColumn(d, 2, 1)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- columns'`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `columns.ts`**

Create `src/lib/table/columns.ts`:

```ts
import type { Column, ColumnSource, TableDefinition } from '$lib/api/types';

export class ColumnInUseError extends Error {}

function clone(defn: TableDefinition): TableDefinition {
  return structuredClone(defn);
}

function sourcesColumn(col: Column, index: number): boolean {
  return col.source.kind === 'column' && col.source.index === index;
}

export function addColumn(defn: TableDefinition, col: Column): TableDefinition {
  const next = clone(defn);
  next.columns.push(structuredClone(col));
  return next;
}

export function removeColumn(defn: TableDefinition, index: number): TableDefinition {
  for (let i = 0; i < defn.columns.length; i++) {
    if (i !== index && sourcesColumn(defn.columns[i], index)) {
      throw new ColumnInUseError(`column ${i} sources column ${index}`);
    }
  }
  const next = clone(defn);
  next.columns.splice(index, 1);
  // shift down any ColumnRef.index that pointed past the removed column
  for (const c of next.columns) {
    if (c.source.kind === 'column' && c.source.index > index) c.source.index -= 1;
  }
  return next;
}

export function moveColumn(defn: TableDefinition, from: number, to: number): TableDefinition {
  const n = defn.columns.length;
  if (from === to) return clone(defn);
  // build the new index mapping: old position → new position
  const order = [...Array(n).keys()];
  order.splice(to, 0, order.splice(from, 1)[0]);
  const oldToNew = new Map<number, number>();
  order.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));

  const next = clone(defn);
  next.columns = order.map((oldIdx) => structuredClone(defn.columns[oldIdx]));
  // remap every ColumnRef to its source's new position, and validate backward
  next.columns.forEach((c, newIdx) => {
    if (c.source.kind === 'column') {
      const remapped = oldToNew.get(c.source.index);
      if (remapped === undefined) throw new Error('dangling column source');
      if (remapped >= newIdx) {
        throw new Error(`move makes column ${newIdx} source column ${remapped} (forward)`);
      }
      c.source.index = remapped;
    }
  });
  return next;
}

export function renameColumn(defn: TableDefinition, index: number, header: string): TableDefinition {
  const next = clone(defn);
  next.columns[index].header = header;
  return next;
}

export function setColumnWidth(defn: TableDefinition, index: number, width_px: number | null): TableDefinition {
  const next = clone(defn);
  next.columns[index].width_px = width_px;
  return next;
}

export function setColumnMode(defn: TableDefinition, index: number, mode: 'collapse' | 'expand'): TableDefinition {
  const next = clone(defn);
  const c = next.columns[index];
  if (c.kind !== 'element') c.mode = mode;
  return next;
}

export function columnLabel(col: Column): string {
  if (col.header) return col.header;
  if (col.kind === 'property') return col.name;
  if (col.kind === 'element') return 'Element';
  return 'Navigation';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- columns'`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/table/
git commit -m "feat(frontend): pure table column-edit helpers with ColumnRef remapping"
```

---

### Task 3: `table-editor` store

**Files:**
- Create: `src/lib/state/table-editor.svelte.ts`
- Modify: `src/lib/state/index.ts` (re-export, if the repo barrels state)
- Test: `src/lib/state/__tests__/table-editor.test.ts`

**Interfaces:**
- Consumes: `evaluateTable`, `exportTable` (Task 1); `columns.ts` (Task 2);
  `getArtifact`/`createArtifact`/`updateArtifact` (existing `api/artifacts.ts`);
  `bindTabToArtifact` (workspace).
- Produces:
  - `interface TableDraft { name; artifactId: string|null; artifactRev: number|null; definition: TableDefinition; dirty: boolean }`
  - Getters: `getTableDraft(tabId)`, `getTablePage(tabId)`, `getTableSort(tabId)`,
    `getTableLoading(tabId)`, `getTableError(tabId)`, `getTableConflict(tabId)`.
  - Lifecycle: `ensureTableDraft(tabId)`, `updateTableDefinition(tabId, defn)`,
    `setTableName(tabId, name)`, `setTableSort(tabId, sort)`,
    `loadTablePage(tabId, offset)`, `saveTableDraft(tabId)`,
    `saveAsTableDraft(tabId, name)`, `reloadTableDraft(tabId)`,
    `closeTableDraft(tabId)`, `downloadTable(tabId)`, `resetTableEditors()`.

Model the store on `navigation-editor.svelte.ts` — read it first. Key differences:
a table has one page (not per-node previews), and a definition/sort change resets
to offset 0.

- [ ] **Step 1: Write the failing test**

In `src/lib/state/__tests__/table-editor.test.ts` (follow the navigation-editor
test's MSW/mock setup):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as tablesApi from '$lib/api/tables';
import {
  ensureTableDraft, getTableDraft, updateTableDefinition, setTableSort,
  getTablePage, resetTableEditors,
} from '$lib/state/table-editor.svelte';

describe('table-editor', () => {
  beforeEach(() => resetTableEditors());

  it('ensureTableDraft creates an empty draft for a draft tab', async () => {
    await ensureTableDraft('tbl:draft:1');
    const d = getTableDraft('tbl:draft:1');
    expect(d?.artifactId).toBeNull();
    expect(d?.definition.columns.length).toBeGreaterThanOrEqual(1);
  });

  it('setTableSort resets the loaded page offset', async () => {
    const spy = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue({
      columns: [], rows: [], total: 0, truncated: false, offset: 0, model_rev: 1,
    });
    await ensureTableDraft('tbl:draft:2');
    setTableSort('tbl:draft:2', { column: 0, direction: 'asc' });
    // the store re-requests page 0 with the sort
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls.at(-1)![0];
    expect(lastCall.offset ?? 0).toBe(0);
    expect(lastCall.sort).toEqual({ column: 0, direction: 'asc' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- table-editor'`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the store**

Create `src/lib/state/table-editor.svelte.ts`. Use `SvelteMap` for reactive
per-tab state; follow `navigation-editor.svelte.ts` for the save/save-as/reload/
conflict handling (including the `{ current_rev }` ConflictError shape). A default
empty definition:

```ts
function emptyDefinition(): TableDefinition {
  return {
    schema_version: 1, default_cell_mode: 'collapse',
    row_source: { kind: 'scope', types: [], criteria: [] },
    columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 },
                header: '', width_px: null }],
  };
}
```

Core behaviours (match the navigation-editor equivalents exactly where they
overlap):

- `ensureTableDraft(tabId)`: `tbl:draft:*` → empty draft; else `tbl:<id>` →
  `getArtifact(id)`, parse payload via `TableDefinitionSchema`, then
  `loadTablePage(tabId, 0)`.
- `updateTableDefinition(tabId, defn)`: set `definition`, `dirty=true`, reset to
  page 0, and `loadTablePage(tabId, 0)`.
- `setTableSort(tabId, sort)`: store sort, `loadTablePage(tabId, 0)`.
- `loadTablePage(tabId, offset)`: call `evaluateTable({ definition or artifactId,
  offset, limit, sort })`; store `TablePage`; guard staleness with a per-tab
  generation counter (copy the navigation-editor `_generations` idiom). On a
  422/500 store the message in `_errors`.
- `saveTableDraft(tabId)`: create (`createArtifact({kind:'table', name, payload})`)
  or update (`updateArtifact(id, {artifact_rev, name, payload})`); on first save
  call `bindTabToArtifact(tabId, id)` and re-key the store entry (copy
  `rekeyTab`); on `{current_rev}` ConflictError set `_conflicts`.
- `saveAsTableDraft(tabId, name)`: always `createArtifact`, fork.
- `downloadTable(tabId)`: `const { blob, filename } = await exportTable(...)`, then
  `URL.createObjectURL` + a synthetic `<a download>` click + `revokeObjectURL`.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- table-editor'`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/state/table-editor.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/table-editor.test.ts
git commit -m "feat(frontend): table-editor store (draft lifecycle, paging, sort, export)"
```

---

### Task 4: Generalize workspace tabs to `kind: navigation | table`

**Files:**
- Modify: `src/lib/state/workspace.svelte.ts`
- Modify: `src/lib/components/Workspace.svelte`
- Modify callers of `openNavigationTab` (`ArtifactsSection.svelte`,
  `TreeRow.svelte`, `NavigationBuilder.svelte`)
- Test: `src/lib/state/__tests__/workspace.test.ts` (extend)

**Interfaces:**
- Produces: `DynamicTab.kind: 'navigation' | 'table'`; `openArtifactTab(kind,
  {artifactId, title})` (id prefixes `nav:` / `tbl:`); `bindTabToArtifact` uses the
  tab's own kind for the prefix. `openNavigationTab` kept as a thin wrapper
  (`openArtifactTab('navigation', …)`) to avoid touching every caller at once.

- [ ] **Step 1: Write the failing test**

Extend the workspace test:

```ts
it('openArtifactTab creates a tbl: tab for a table', () => {
  const id = openArtifactTab('table', { artifactId: 'abc', title: 'T' });
  expect(id).toBe('tbl:abc');
  expect(getDynamicTabs().find((t) => t.id === id)?.kind).toBe('table');
});

it('bindTabToArtifact keeps the table prefix', () => {
  const id = openArtifactTab('table', { artifactId: null, title: 'draft' });
  expect(id.startsWith('tbl:draft:')).toBe(true);
  bindTabToArtifact(id, 'saved1');
  expect(getDynamicTabs().find((t) => t.artifactId === 'saved1')?.id).toBe('tbl:saved1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- workspace'`
Expected: FAIL (`openArtifactTab` missing; kind is `'navigation'` only).

- [ ] **Step 3: Generalize the store**

In `workspace.svelte.ts`:

- Change `DynamicTab.kind` to `'navigation' | 'table'`.
- Add:

```ts
const PREFIX = { navigation: 'nav', table: 'tbl' } as const;

export function openArtifactTab(
  kind: 'navigation' | 'table',
  opts: { artifactId: string | null; title: string },
): string {
  const p = PREFIX[kind];
  if (opts.artifactId !== null) {
    const existing = _tabs.find((t) => t.artifactId === opts.artifactId && t.kind === kind);
    if (existing) { _activeTab = existing.id; persist(); return existing.id; }
  }
  const id = opts.artifactId === null ? `${p}:draft:${++_draftSeq}` : `${p}:${opts.artifactId}`;
  _tabs = [..._tabs, { id, kind, artifactId: opts.artifactId, title: opts.title }];
  _activeTab = id;
  persist();
  return id;
}

export function openNavigationTab(opts: { artifactId: string | null; title: string }): string {
  return openArtifactTab('navigation', opts);
}
```

- Fix `bindTabToArtifact` to derive the prefix from the tab's kind:

```ts
export function bindTabToArtifact(id: string, artifactId: string): void {
  _tabs = _tabs.map((t) =>
    t.id === id ? { ...t, id: `${PREFIX[t.kind]}:${artifactId}`, artifactId } : t);
  const bound = _tabs.find((t) => t.artifactId === artifactId);
  if (_activeTab === id && bound) _activeTab = bound.id;
  persist();
}
```

- The persisted-tab restore in `initWorkspaceTabs` already stores the whole
  `DynamicTab` (which now includes `kind`); no change needed beyond ensuring the
  parsed shape carries `kind` (default `'navigation'` for any legacy record).

- [ ] **Step 4: Host both builders in `Workspace.svelte`**

In `Workspace.svelte`, in the `{#each getDynamicTabs()}` body, dispatch on kind:

```svelte
{#if tab.kind === 'table'}
  <TableView tabId={tab.id} />
{:else}
  <NavigationBuilder tabId={tab.id} />
{/if}
```

Import `TableView` (Task 5). The close button calls `closeTableDraft(tab.id)` for
table tabs, `closeDraft(tab.id)` for navigation tabs, then `closeTab(tab.id)`.

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- workspace'`
Expected: PASS. (`TableView` may not exist yet — if the Svelte import breaks the
build, land Task 5's shell first, or temporarily stub `TableView.svelte`.)

- [ ] **Step 6: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/state/workspace.svelte.ts frontend/src/lib/components/Workspace.svelte frontend/src/lib/state/__tests__/workspace.test.ts
git commit -m "feat(frontend): generalize workspace tabs to navigation|table kinds"
```

---

### Task 5: `TableView` + `TableGrid` (read-only render)

**Files:**
- Create: `src/lib/components/Table/TableView.svelte`
- Create: `src/lib/components/Table/TableGrid.svelte`
- Create: `src/lib/components/Table/Cell/ElementCell.svelte`,
  `ValueCell.svelte`, `ValuesCell.svelte`, `ElementsCell.svelte`
- Test: extend the e2e later; for now a vitest render smoke test
  `src/lib/components/Table/__tests__/TableGrid.test.ts`

**Interfaces:**
- Consumes: `table-editor` store (Task 3), `windowing.ts` helpers
  (`computeWindow`, `shouldLoadMore` — reuse from `Sidebar/windowing.ts`),
  `select()` (existing selection), `columnLabel`.
- Produces: the read-only table surface. Editing lands in Task 6.

- [ ] **Step 1: Write a render smoke test**

```ts
import { render } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import TableGrid from '$lib/components/Table/TableGrid.svelte';
import * as store from '$lib/state/table-editor.svelte';

describe('TableGrid', () => {
  it('renders a header per column and a row per page row', () => {
    vi.spyOn(store, 'getTablePage').mockReturnValue({
      columns: [{ kind: 'element', header: 'Block', width_px: null },
                { kind: 'property', header: 'Mass', width_px: null }],
      rows: [{ key: ['e1'], cells: [
        { kind: 'element', item: { id: 'e1', type_name: 'Block', display_name: 'B', child_count: 0 } },
        { kind: 'value', present: true, value: 10, element_id: 'e1', editable: true }] }],
      total: 1, truncated: false, offset: 0, model_rev: 1,
    });
    vi.spyOn(store, 'getTableLoading').mockReturnValue(false);
    const { getByText } = render(TableGrid, { props: { tabId: 'tbl:draft:1' } });
    expect(getByText('Block')).toBeTruthy();
    expect(getByText('Mass')).toBeTruthy();
    expect(getByText('B')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- TableGrid'`
Expected: FAIL (component missing).

- [ ] **Step 3: Build the components**

`TableView.svelte` (tab root): name input, Save / Save as… / **Export** buttons,
conflict banner, then `<TableGrid tabId={tabId} />` and a `ColumnManager` (Task 7).
Call `ensureTableDraft(tabId)` in an `$effect` (guarded so it runs once — copy
`NavigationBuilder.svelte`'s effect shape).

`TableGrid.svelte`: sticky header row with `data-testid="table-header"`; each
header cell shows `columns[i].header || kind`, a sort caret button (calls
`setTableSort`), and a drag-resize handle on its right edge (pointermove →
`setColumnWidth` on release). Body uses the windowing helpers over `page.rows`;
each row is a fixed-height `<div role="row">` of cells dispatched by `cell.kind`:

```svelte
{#if cell.kind === 'element'}<ElementCell {cell} />
{:else if cell.kind === 'value'}<ValueCell {cell} {tabId} />
{:else if cell.kind === 'values'}<ValuesCell {cell} />
{:else}<ElementsCell {cell} />{/if}
```

`ElementCell.svelte`: a button showing `cell.item?.display_name` (— when null) that
calls `select({ kind: 'element', id: cell.item.id })`.

`ElementsCell.svelte`: chips of `cell.items` (each a `select()` button); a
"+N more" indicator when `cell.truncated` (using `cell.total`).

`ValuesCell.svelte`: read-only `cell.values.join(', ')`.

`ValueCell.svelte`: for now render `cell.present ? String(cell.value ?? '') : ''`
greyed when `!cell.present`. Editing is Task 6.

Use `data-testid="table-grid"` on the scroll container and `data-testid="table-row"`
on rows for the e2e.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- TableGrid'`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/components/Table/
git commit -m "feat(frontend): read-only TableView + TableGrid with windowed rows"
```

---

### Task 6: Inline property-cell editing

**Files:**
- Modify: `src/lib/components/Table/Cell/ValueCell.svelte`
- Test: extend `TableGrid.test.ts` or a focused `ValueCell.test.ts`

**Interfaces:**
- Consumes: `editLock(elementId)` (`state/edit-gate.ts`), `emit(op)` +
  `getStagedOpsFor(id)` (`state/model.svelte.ts`), `canEdit`/peer-lock state
  (`state/checkout.svelte.ts`), `PropertyField.svelte` (existing typed editor).
- Produces: an editable value cell that stages a `set_property` exactly like the
  Inspector.

- [ ] **Step 1: Write the failing test**

```ts
import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import ValueCell from '$lib/components/Table/Cell/ValueCell.svelte';
import * as gate from '$lib/state/edit-gate';
import * as model from '$lib/state/model.svelte';

describe('ValueCell editing', () => {
  it('acquires a lock then stages a set_property on edit', async () => {
    vi.spyOn(gate, 'editLock').mockResolvedValue(true);
    const emit = vi.spyOn(model, 'emit').mockImplementation(() => {});
    const { getByRole } = render(ValueCell, { props: {
      tabId: 't', cell: { kind: 'value', present: true, value: 1,
        element_id: 'e1', editable: true } } });
    const input = getByRole('spinbutton'); // or textbox depending on datatype
    await fireEvent.change(input, { target: { value: '5' } });
    await fireEvent.blur(input);
    expect(gate.editLock).toHaveBeenCalledWith('e1');
    expect(emit).toHaveBeenCalled();
  });

  it('renders read-only when editable is false', () => {
    const { queryByRole } = render(ValueCell, { props: {
      tabId: 't', cell: { kind: 'value', present: true, value: 1,
        element_id: 'e1', editable: false } } });
    expect(queryByRole('spinbutton')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- ValueCell'`
Expected: FAIL (no editing wired).

- [ ] **Step 3: Wire editing**

In `ValueCell.svelte`: when `cell.editable && canEdit()` and no peer lock, render an
inline editor. Overlay staged values first:

```svelte
<script lang="ts">
  import { editLock } from '$lib/state/edit-gate';
  import { emit, getStagedOpsFor } from '$lib/state/model.svelte';
  import { canEdit } from '$lib/state/checkout.svelte';

  let { cell, tabId }: { cell: Extract<TableCell, { kind: 'value' }>; tabId: string } = $props();

  const staged = $derived(
    cell.element_id
      ? getStagedOpsFor(cell.element_id).find(
          (o) => 'properties_patch' in o && cell.column_name! in (o.properties_patch ?? {}))
      : undefined,
  );
  const shown = $derived(staged ? /* staged value */ … : cell.value);

  async function commitEdit(next: unknown) {
    if (!cell.element_id) return;
    const ok = await editLock(cell.element_id);
    if (!ok) return;
    emit({ kind: 'update_element', id: cell.element_id,
           properties_patch: { [propertyName]: next } });
  }
</script>
```

The property name is needed for the patch: add `column_name` to the value cell's
props by threading the column's `name` from `TableGrid` (the grid knows
`page.columns[i]` but the property *name* is in the definition, not the column-out;
simplest: `evaluate` already returns `element_id`, so pass the definition column's
`name` down from `TableView` → `TableGrid` → `ValueCell`). For the typed editor,
prefer reusing `PropertyField.svelte`'s logic; if reuse is heavy, a minimal
`<input>` typed by the column datatype is acceptable for Stage 2 — but wire the
same `emit` op. Commit itself happens through the existing `DiffDrawer` (already
mounted app-wide) — the cell only stages.

After a commit elsewhere bumps `model_rev`, the page refetches (Task 8 feed wiring)
and the staged overlay clears via the normal `clearStaged()` path.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- ValueCell'`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/components/Table/
git commit -m "feat(frontend): inline property-cell editing via the checkout flow"
```

---

### Task 7: Column manager + row-source editor + navigation-column editor

**Files:**
- Create: `src/lib/components/Table/ColumnManager.svelte`
- Create: `src/lib/components/Table/RowSourceEditor.svelte`
- Create: `src/lib/components/Table/NavigationColumnEditor.svelte`
- Modify: `src/lib/components/Table/TableView.svelte` (mount the manager)
- Test: `src/lib/components/Table/__tests__/ColumnManager.test.ts`

**Interfaces:**
- Consumes: `columns.ts` (Task 2), `updateTableDefinition` (Task 3),
  `ScopeEditor.svelte` (reuse from `components/Navigation/`),
  `NavigationNode.svelte` (reuse, with a `RowStart` start).
- Produces: the definition-editing UI.

- [ ] **Step 1: Write the failing test**

```ts
import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import ColumnManager from '$lib/components/Table/ColumnManager.svelte';
import * as store from '$lib/state/table-editor.svelte';

describe('ColumnManager', () => {
  it('adds a property column via updateTableDefinition', async () => {
    vi.spyOn(store, 'getTableDraft').mockReturnValue({
      name: '', artifactId: null, artifactRev: null, dirty: false,
      definition: { schema_version: 1, default_cell_mode: 'collapse',
        row_source: { kind: 'scope', types: ['Block'], criteria: [] },
        columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 },
                    header: '', width_px: null }] },
    });
    const upd = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
    const { getByTestId } = render(ColumnManager, { props: { tabId: 't' } });
    await fireEvent.click(getByTestId('add-property-column'));
    expect(upd).toHaveBeenCalled();
    const defn = upd.mock.calls.at(-1)![1];
    expect(defn.columns.some((c: any) => c.kind === 'property')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- ColumnManager'`
Expected: FAIL (component missing).

- [ ] **Step 3: Build the editors**

`RowSourceEditor.svelte`: a `<select>` over `scope | navigation | chains`; scope
reuses `ScopeEditor.svelte`; navigation/chains embed a navigation source picker
(ref from the library or inline `NavigationNode`). On change →
`updateTableDefinition`.

`ColumnManager.svelte`: lists `draft.definition.columns` with per-column controls
(rename → `renameColumn`; remove → `removeColumn`, catching `ColumnInUseError` and
showing a message; reorder up/down → `moveColumn`; mode toggle → `setColumnMode`;
for nav columns, `sort_mode`, `cell_cap`, `keep_empty`, and `source`). Add buttons:
`data-testid="add-element-column"`, `add-property-column` (offers the union of
effective properties across scoped types — fetch via an existing metamodel helper
or a properties endpoint; for Stage 2 a free-text name input is acceptable if no
helper is readily reusable), `add-navigation-column`. Every mutation routes through
`columns.ts` then `updateTableDefinition`.

`NavigationColumnEditor.svelte`: embeds `NavigationNode.svelte` from
`components/Navigation/` with the start fixed to `{ kind: 'row' }`, plus the column
source selector (row slot / earlier column), `step_index`, `sort_mode`, `cell_cap`,
`mode`, `keep_empty`.

Follow the `untrack()` idiom if any of these register/unregister store state in an
`$effect`.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- ColumnManager'`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/components/Table/
git commit -m "feat(frontend): table column manager, row-source and nav-column editors"
```

---

### Task 8: Feed-triggered page refresh + sidebar Tables section

**Files:**
- Modify: `src/lib/state/artifacts.svelte.ts` (kind-driven headers already; ensure
  table create/list helpers)
- Modify: `src/lib/components/Sidebar/ArtifactsSection.svelte` (Tables section)
- Modify: `src/lib/state/table-editor.svelte.ts` (subscribe to commit/model_rev)
- Test: extend `artifacts` store tests

**Interfaces:**
- Consumes: `getArtifactHeaders` (filter `kind==='table'`), the feed
  commit-event hook, `getModelRev`.
- Produces: a Tables section in the sidebar (create/open/rename/delete/drag), and
  a table page that refetches when `model_rev` moves.

- [ ] **Step 1: Write the failing test**

```ts
// in the artifacts store test
it('lists table headers separately from navigations', () => {
  // seed _items with one navigation + one table header (via loadArtifacts mock)
  // assert a getTableHeaders()/filter returns only the table
});
```

And for refresh, a table-editor test asserting that a `model_rev` change triggers
`evaluateTable` again (spy + manually invoke the exported feed handler).

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- artifacts'`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `artifacts.svelte.ts`: add `createTableArtifact(name, payload)` mirroring
  `createNavigationArtifact`; `getArtifactHeaders` already returns all kinds, so a
  `Tables` section just filters `kind === 'table'`.
- `ArtifactsSection.svelte`: render two sections (Navigations, Tables) from a small
  config array `[{ kind:'navigation', title:'Navigations', open: openNavigationTab },
  { kind:'table', title:'Tables', open: (o)=>openArtifactTab('table', o) }]`. New /
  open (dblclick) / rename / delete / `beginDrag({kind:'artifact', id,
  artifactKind:'table'})` all parameterized by kind. Gate by `canEdit()`.
- `table-editor.svelte.ts`: expose `handleTableModelRevChanged()` (or subscribe to
  the same commit-feed signal `navigation-editor` uses, if any) that re-runs
  `loadTablePage(tabId, currentOffset)` for every open table tab, debounced. Wire it
  at the feed dispatch site (find where commit/feed events fan out to stores).

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- artifacts table-editor'`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/state/artifacts.svelte.ts frontend/src/lib/components/Sidebar/ArtifactsSection.svelte frontend/src/lib/state/table-editor.svelte.ts
git commit -m "feat(frontend): sidebar Tables section and feed-triggered page refresh"
```

---

### Task 9: "Open navigation as table" + table tree node

**Files:**
- Modify: `src/lib/components/Navigation/NavigationBuilder.svelte` (Open-as-table button)
- Modify: `src/lib/components/Sidebar/TreeRow.svelte` (dispatch open by kind; table icon)
- Test: extend the navigation e2e or a focused vitest

**Interfaces:**
- Consumes: `openArtifactTab('table', …)`, `ensureTableDraft`,
  `updateTableDefinition`, the current navigation draft's definition + artifactId.
- Produces: a transient table from a navigation; a table node that opens a table
  tab.

- [ ] **Step 1: Write the failing test**

A vitest on the helper that builds the transient definition:

```ts
import { describe, it, expect } from 'vitest';
import { navigationAsTableDefinition } from '$lib/table/columns';

describe('navigationAsTableDefinition', () => {
  it('uses a ref when the navigation is saved', () => {
    const d = navigationAsTableDefinition({ artifactId: 'nav1', definition: {
      kind: 'path', start: { kind: 'scope', types: ['Block'] },
      steps: [{ kind: 'relationship', relationship_type: 'BlockHasPart', direction: 'out' }] } });
    expect(d.row_source).toEqual({ kind: 'chains', navigation: { ref: 'nav1' } });
    // one element column per chain step (start + 1 hop = 2)
    expect(d.columns.filter((c) => c.kind === 'element')).toHaveLength(2);
    expect(d.columns[1].source).toEqual({ kind: 'row', chain_index: 1 });
  });

  it('embeds inline when the navigation is an unsaved draft', () => {
    const defn = { kind: 'path', start: { kind: 'scope', types: ['Block'] }, steps: [] } as const;
    const d = navigationAsTableDefinition({ artifactId: null, definition: defn });
    expect(d.row_source).toEqual({ kind: 'chains', navigation: { definition: defn } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- navigationAsTable'`
Expected: FAIL (`navigationAsTableDefinition` missing).

- [ ] **Step 3: Implement**

Add `navigationAsTableDefinition({ artifactId, definition })` to `columns.ts`: build
`row_source = { kind:'chains', navigation: artifactId ? { ref: artifactId } :
{ definition } }`, and one `element` column per chain step. Chain step count =
`start` + one per `relationship` step in `definition.steps` (filter `kind ===
'relationship'`); `chain_index` 0..n, header from the step's relationship type
(reuse `chainColumns` from `navigation/tree.ts` for labels).

In `NavigationBuilder.svelte`, add an "Open as table" button (disabled while the
draft is empty/non-runnable — reuse `isRunnable`). On click:
`const id = openArtifactTab('table', { artifactId: null, title: draft.name ?
\`${draft.name} (table)\` : 'Table' });` then `await ensureTableDraft(id)` and
`updateTableDefinition(id, navigationAsTableDefinition({ artifactId: draft.artifactId,
definition: draft.definition }))`.

In `TreeRow.svelte`: replace the hardcoded `openNavigationTab({ artifactId, title })`
on artifact double-click with a kind dispatch: `artifactHeader.kind === 'table' ?
openArtifactTab('table', {...}) : openNavigationTab({...})`. Add a table icon (e.g.
`Table` from `@lucide/svelte`) alongside the existing `Route` nav icon, chosen by
`artifactHeader.kind`.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- navigationAsTable'`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/table/columns.ts frontend/src/lib/components/Navigation/NavigationBuilder.svelte frontend/src/lib/components/Sidebar/TreeRow.svelte
git commit -m "feat(frontend): open-navigation-as-table and table tree nodes"
```

---

### Task 10: Root-level artifact placement (view ops)

**Files:**
- Modify: `src/lib/state/view-ops.ts`
- Modify: `src/lib/state/view.svelte.ts`
- Modify: `src/lib/components/Sidebar/ContainmentTree.svelte` /
  `view-tree.ts` (render root artifacts)
- Test: `src/lib/components/Sidebar/view-tree-dnd.test.ts` or `view-ops` unit test

**Interfaces:**
- Consumes: the new `View.artifacts` field (backend Task 11) — the frontend `View`
  type must gain `artifacts`.
- Produces: `placeArtifactInView(view, [], ref)` / `moveArtifactInView` /
  `removeArtifactFromFolder` handling the root path (`[]`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { placeArtifactInView, findFolderByPath } from '$lib/state/view-ops';

describe('root artifact placement', () => {
  it('places an artifact at the view root', () => {
    const view = { name: 'v', folders: [], artifacts: [] } as any;
    const next = placeArtifactInView(view, [], { id: 'tbl1', kind: 'table' });
    expect(next.artifacts).toEqual([{ id: 'tbl1', kind: 'table' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- view-ops'`
Expected: FAIL (root placement pushes into the detached virtual root, or the type
lacks `artifacts`).

- [ ] **Step 3: Implement**

- Add `artifacts` to the frontend `View`/`Folder` types (in `api/types.ts` view
  schemas) if not already present at root.
- In `view-ops.ts`, add an explicit `path.length === 0` branch to
  `placeArtifactInView`, `moveArtifactInView`, and `removeArtifactFromView` that
  operates on `view.artifacts` instead of a folder. Do NOT route root placement
  through `findFolderByPath(view, [])` (its virtual root is detached — leave a
  code comment warning, or add an assertion that it is never called for artifact
  mutation).
- Render root artifacts in the view tree: wherever `view.folders` root elements are
  built into tree rows, also emit rows for `view.artifacts` (reuse the existing
  artifact `TreeRow` variant; `parentFolderPath = []`).
- Ensure `removeArtifactFromFolder([], id)` (called by `TreeRow`) removes from
  `view.artifacts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- view-ops view-tree'`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/state/view-ops.ts frontend/src/lib/state/view.svelte.ts frontend/src/lib/components/Sidebar/ frontend/src/lib/api/types.ts
git commit -m "feat(frontend): place artifacts at the view root"
```

---

### Task 11: End-to-end table flow

**Files:**
- Create: `frontend/e2e/table.spec.ts`
- Reuse: `frontend/e2e/helpers/auth.ts` (`openDefaultProject`),
  `frontend/e2e/helpers/load.ts` (seeded Smart City project)

**Interfaces:**
- Consumes: the whole stack.

- [ ] **Step 1: Write the e2e**

`frontend/e2e/table.spec.ts` — read `navigation.spec.ts` first for the harness
(`openDefaultProject`, `data-testid` conventions):

```ts
import { test, expect } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

test('open navigation as table, add a column, edit a cell, save, reopen', async ({ page }) => {
  await openDefaultProject(page);
  // 1. build a minimal navigation (reuse navigation.spec steps) OR open a saved one
  //    then click "Open as table"
  await page.getByRole('button', { name: /open as table/i }).click();
  await expect(page.getByTestId('table-grid')).toBeVisible();

  // 2. add a property column via the column manager
  await page.getByTestId('add-property-column').click();
  // choose a property (name input or select) — match ColumnManager's UI

  // 3. edit an editable value cell → stage → commit through the DiffDrawer
  const cell = page.getByTestId('table-row').first().getByRole('spinbutton').first();
  if (await cell.count()) {
    await cell.fill('42');
    await cell.blur();
    await page.getByRole('button', { name: /commit/i }).click();
    await expect(page.getByText(/committed|saved/i)).toBeVisible();
  }

  // 4. Save as… a real artifact, then reopen from the sidebar Tables section
  await page.getByRole('button', { name: /save as/i }).click();
  await page.getByRole('textbox', { name: /name/i }).fill('My Table');
  await page.getByRole('button', { name: /save/i }).click();
  await expect(page.getByText('My Table')).toBeVisible();
});
```

Adjust selectors to the real UI as you build it; keep the four checkpoints (open →
add column → edit+commit → save+reopen).

- [ ] **Step 2: Run the e2e**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e -- table'`
Expected: PASS (the e2e harness boots backend + dev server itself).

- [ ] **Step 3: Full e2e regression**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`
Expected: prior specs still green (navigation, commit-flow, dnd, view, …) plus the
new table spec.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/table.spec.ts
git commit -m "test(frontend): e2e table flow — nav-as-table, edit-commit, save, reopen"
```

---

### Task 12: Frontend integration sweep

- [ ] **Step 1: Full unit suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Expected: green.

- [ ] **Step 2: Typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: no svelte-check errors.

- [ ] **Step 3: Lint (no NEW failures)**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run lint'`
Expected: only the two pre-existing prettier failures (`ProjectCard.test.ts`,
`UsersTab.test.ts`) — no new ones.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore(frontend): table system integration fixups"
```

## Self-Review notes (for the executor)

- The `ValueCell` needs the property *name* to build the `set_property` patch;
  the evaluate response's column-out does not carry it. Thread the definition
  column's `name` from `TableView` → `TableGrid` → `ValueCell` (Task 6 Step 3).
- `openNavigationTab` is kept as a wrapper so Task 4 doesn't have to touch every
  caller in one commit; new code calls `openArtifactTab`.
- Root-artifact placement must NOT go through `findFolderByPath(view, [])` — that
  virtual root is detached and silently drops writes (Task 10 Step 3).
- The backend plan is a prerequisite for Tasks 1, 8, 9, 10, 11 (types mirror the
  backend schemas; the routes must exist). Land the backend plan first, or run the
  two plans against a shared branch with the backend tasks ahead.
