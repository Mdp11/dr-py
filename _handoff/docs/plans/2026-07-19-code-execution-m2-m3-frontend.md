# Code Execution — M2+M3 Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the client side of `ScriptColumn` and `ScriptStep`: a "+ Script" table column with ref/inline snippet editing, a "Script step" in the navigation builder, error-cell rendering, and warnings banners.

**Architecture:** Per spec `docs/superpowers/specs/2026-07-19-code-execution-m2-m3-design.md` §7, on top of the backend plan (`2026-07-19-code-execution-m2-m3-backend.md`, must be merged/green first). One new shared component — `SnippetSourceEditor.svelte` (ref/inline toggle + `code_snippet` artifact picker filtered by `entry_points` + inline `CodeEditor` mount with its own debounced lint) — is consumed by both the new `ScriptColumnEditor` and the new `ScriptStepRow`. The existing `CodeEditor.svelte` is already reusable; no extraction needed. Definitions stay plain JSON validated by Zod; the backend is the source of truth.

**Tech Stack:** SvelteKit + Svelte 5 runes, Zod, CodeMirror 6 (already a dependency), vitest (raw `mount`/`flushSync` convention, MSW per-test), Playwright.

## Global Constraints

- **All frontend commands run from inside `frontend/`** via pixi:
  - unit tests: `pixi run -e frontend bash -c 'cd frontend && npm test'`
  - a single file: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/table/__tests__/columns.test.ts'`
  - svelte-check: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
  - e2e: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'` (boots backend + dev server itself; the backend branch must be checked out).
- **Read `frontend/README.md` before touching `frontend/src/lib/state/`** (repo rule).
- Component tests use raw `mount`/`unmount`/`flushSync` + `vi.spyOn` on stores — copy the header pattern of `src/lib/components/Table/__tests__/ColumnManager.test.ts`.
- **Column identity is by reference** (`src/lib/table/columns.ts:14-26`): editors must emit whole-column patches via `onChange(next)`; never mutate a column in place.
- Snippet artifacts are `kind: 'code_snippet'`; pickers filter with `entryAvailable('value'|'step', header.entry_points)` from `src/lib/snippet/entry-stubs.ts`.
- The inline snippet editor is a plain `CodeEditor` mount over `snippet.definition.code` — do NOT copy `NavigationColumnEditor`'s embedded-draft machinery (its `$state.raw`/mirror-effect complexity exists for tree editing; a code string doesn't need it).
- Branch: continue on `feature/code-execution-m2-m3` (after the backend plan's tasks are committed).

---

## File Structure

New files:

- `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte` — shared ref/inline editor for `{ref?|definition?}` snippet sources.
- `frontend/src/lib/components/Table/ScriptColumnEditor.svelte`
- `frontend/src/lib/components/Table/Cell/ErrorCell.svelte`
- `frontend/src/lib/components/Navigation/ScriptStepRow.svelte`
- Tests: `Snippet/__tests__/snippet-source-editor.test.ts`, `Table/__tests__/ScriptColumnEditor.test.ts`, `Table/Cell/__tests__/ErrorCell.test.ts`, `Navigation/__tests__/script-step-row.test.ts`, `e2e/script-embedding.spec.ts`.

Modified files:

- `frontend/src/lib/api/types.ts` — `SnippetSourceSchema`, `ScriptColumnSchema` (union at 722), error cell (union at 745), `warnings` on `TablePageSchema` (772) + `ChainPageSchema` (491), `NavScriptStep` (+ union at 408).
- `frontend/src/lib/table/columns.ts` — `newScriptColumn`, label cases.
- `frontend/src/lib/components/Table/ColumnManager.svelte` — "+ Script" button + editor dispatch branch.
- `frontend/src/lib/components/Table/TableGrid.svelte` — explicit `elements` branch + `error` branch + `cellLines`.
- `frontend/src/lib/components/Table/TableView.svelte` — warnings banner.
- `frontend/src/lib/state/table-editor.svelte.ts` — thread `warnings` into `TableData`, `getTableWarnings`.
- `frontend/src/lib/components/Navigation/PathCard.svelte` — "Script step" insert + `ScriptStepRow` dispatch.
- `frontend/src/lib/state/navigation-editor.svelte.ts` — `NavPreview.warnings` threading.
- `frontend/src/lib/components/Navigation/ResultsDock.svelte` — warnings display.
- `frontend/README.md` — snippet-embedding section.

---

## Task F1: Types + schemas

**Files:**
- Modify: `frontend/src/lib/api/types.ts`
- Test: `frontend/src/lib/api/__tests__/tables.test.ts`, `frontend/src/lib/api/__tests__/artifacts.test.ts` (or wherever `ChainPageSchema` round-trips are tested — check `artifacts.test.ts` / `types.checkout.test.ts` and put the chain case next to existing `ChainPageSchema` uses)

**Interfaces — Produces:**

```ts
export const SnippetDefinitionSchema = z.object({
    schema_version: z.number().int().default(1),
    language: z.literal('python').default('python'),
    code: z.string(),
    entry_points: z.array(z.string()).default([])
});
export const SnippetSourceSchema = z.object({
    ref: z.string().nullish(),
    definition: SnippetDefinitionSchema.nullish()
});
export type SnippetSource = z.infer<typeof SnippetSourceSchema>;

export const ScriptColumnSchema = z.object({
    kind: z.literal('script'),
    source: ColumnSourceSchema.default({ kind: 'row', chain_index: 0 }),
    snippet: SnippetSourceSchema.default({}),
    mode: z.enum(['collapse', 'expand']).default('collapse'),
    keep_empty: z.boolean().default(true),
    header: z.string().default(''),
    width_px: z.number().int().nullish(),
    hidden: z.boolean().default(false)
});
// ColumnSchema union (line ~722) gains ScriptColumnSchema

// TableCellSchema union (line ~745) gains:
z.object({ kind: z.literal('error'), message: z.string(), traceback: z.string().nullish() })

// TablePageSchema (~772) and ChainPageSchema (~491) gain:
warnings: z.array(z.string()).default([])

// Step union (plain TS interfaces, ~384-408):
export interface NavScriptStep {
    kind: 'script';
    snippet: SnippetSource;
    comment?: string | null;
}
export type NavStepItem = NavRelationshipStep | NavFilterStep | NavPropertyStep | NavScriptStep;
```

- [ ] **Step 1: Write the failing tests** — extend `src/lib/api/__tests__/tables.test.ts` with `TablePageSchema.parse` cases: a page containing an `error` cell (`{kind:'error', message:'boom', traceback:null}`), a `warnings: ['w']` field, and a `TableDefinitionSchema.parse` round-trip of a script column (`{kind:'script', snippet:{definition:{code:'def value(els): return 1'}}}` and `{kind:'script', snippet:{ref:'a1'}}`). Add a `ChainPageSchema.parse` case with `warnings`.
- [ ] **Step 2: Run to verify failure** — `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/tables.test.ts'` → FAIL (unknown discriminator / missing key).
- [ ] **Step 3: Implement** the schema additions above at the noted line anchors (reuse `SnippetDefinitionSchema` if one already exists near the snippet types at ~555 — search first; don't duplicate).
- [ ] **Step 4: Run tests** → PASS. Run `npm run check` → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(snippet-ui): script column/step + error cell + warnings types"`

---

## Task F2: Column factory + labels

**Files:**
- Modify: `frontend/src/lib/table/columns.ts`
- Test: `frontend/src/lib/table/__tests__/columns.test.ts`

**Interfaces — Produces:**

```ts
export function newScriptColumn(): Column {
    return {
        kind: 'script',
        source: { kind: 'row', chain_index: 0 },
        snippet: {},
        mode: 'collapse',
        keep_empty: true,
        header: '',
        width_px: null,
        hidden: false
    };
}
```

`columnLabel` returns `'Script'` for `kind === 'script'` (before the navigation fall-through at 224-229); `columnKindLabel('script')` → `'Script'` (236-241).

- [ ] **Step 1: Failing tests** — `newScriptColumn()` shape; `columnLabel({...script col})` === `'Script'`; `columnKindLabel('script')` === `'Script'`; `removeColumn`/`moveColumn` treat a script column with a `ColumnRef` source like any other (one case each, mirroring existing tests).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(snippet-ui): newScriptColumn factory + labels"`

---

## Task F3: `SnippetSourceEditor.svelte` (shared ref/inline editor)

**Files:**
- Create: `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte`
- Test: `frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts`

**Interfaces — Produces (props):**

```ts
let { snippet, entry, onChange }: {
    snippet: SnippetSource;
    entry: 'value' | 'step';            // which entry point this context needs
    onChange: (next: SnippetSource) => void;
} = $props();
```

Behavior:
- Mode derived like `NavigationColumnEditor.svelte:58`: `inline = $derived(snippet.definition != null)`; ref mode otherwise (including unconfigured `{}`).
- Two toggle buttons (`data-testid="snippet-mode-ref"` / `"snippet-mode-inline"`). Switch-to-inline seeds the definition from the referenced artifact's code when a ref is set (fetch via `getArtifact(ref)`; fall back to the entry stub `STUBS[entry]` from `$lib/snippet/entry-stubs` when unset). Switch-to-ref emits `{ ref: null, definition: null }`-equivalent `{}` (clears both) so the user re-picks.
- Ref mode: a `<select data-testid="snippet-ref-select">` over `getArtifactHeaders().filter(a => a.kind === 'code_snippet' && entryAvailable(entry, a.entry_points))`, emitting `onChange({ ref: id })`. Show a hint row when the currently-set ref is missing from the list ("snippet not found or lacks a {entry}() entry point") — do not clear it silently.
- Inline mode: mount `CodeEditor` (`code={snippet.definition.code}`, `onChange={(code) => onChange({ definition: { ...snippet.definition, code } })}`, `onRun={() => {}}`) plus **local debounced lint** (300 ms, generation-guarded like `snippet-editor.svelte.ts:126-154` but component-local):

```ts
let diagnostics: SnippetDiagnostic[] = $state([]);
let lintSeq = 0;
let lintTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLint(code: string): void {
    if (lintTimer) clearTimeout(lintTimer);
    lintTimer = setTimeout(async () => {
        const seq = ++lintSeq;
        try {
            const out = await lintSnippet(code);
            if (seq !== lintSeq) return;
            diagnostics = out.diagnostics;
            entryPoints = out.entry_points;
        } catch {
            /* lint is advisory; ignore transport errors */
        }
    }, 300);
}
```

  Below the editor, a warning line when the inline code lacks the required entry (`!entryPoints.includes(entry)`): "define {entry}() to use this snippet here" (`data-testid="snippet-entry-warning"`).

- [ ] **Step 1: Failing tests** (raw `mount` + MSW `server.use(http.post('*/snippets/lint', ...))` for the lint call; `vi.spyOn` `artifacts.svelte` store for headers): ref-mode select filters by kind + entry (`value` snippet listed under `entry='value'`, hidden under `entry='step'`); picking emits `{ref}`; toggle to inline seeds a stub and emits `{definition}`; inline typing emits definition patches; entry warning appears when lint returns `entry_points` without the required entry (use `vi.useFakeTimers()` to advance the debounce).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run + `npm run check`** → PASS/clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(snippet-ui): shared SnippetSourceEditor (ref picker + inline CodeMirror with local lint)"`

---

## Task F4: `ScriptColumnEditor` + ColumnManager wiring

**Files:**
- Create: `frontend/src/lib/components/Table/ScriptColumnEditor.svelte`
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte`
- Test: `frontend/src/lib/components/Table/__tests__/ScriptColumnEditor.test.ts`, extend `ColumnManager.test.ts`

**Interfaces:**
- `ScriptColumnEditor` props mirror `PropertyColumnEditor.svelte:20-32` (`column: Extract<Column, {kind:'script'}>`, `columnIndex`, `columns`, `rowSource`, `onChange`). Layout: `<ColumnSourceEditor>` first (same props/wiring as PropertyColumnEditor), then `<SnippetSourceEditor snippet={column.snippet} entry="value" onChange={(s) => onChange({ ...column, snippet: s })} />`, then the split (`mode`) + `keep_empty` checkboxes copied from PropertyColumnEditor (98-104).
- `ColumnManager.svelte`: `addScriptColumn()` beside `addNavigationColumn` (151-159) using `newScriptColumn()`; a `+ Script` button (`data-testid="add-script-column"`) in the button row (317-336); an `{:else if col.kind === 'script'}` branch in the editor dispatch (275-292).

- [ ] **Step 1: Failing tests** — ScriptColumnEditor: renders source editor + snippet editor; mode/keep_empty toggles emit whole-column patches. ColumnManager: clicking `add-script-column` calls `updateTableDefinition` with a script column appended (extend the `scopeDraft` fixture helper to accept script columns).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run + check** → PASS/clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(snippet-ui): script column editor + ColumnManager '+ Script'"`

---

## Task F5: Error cells + table warnings banner

**Files:**
- Create: `frontend/src/lib/components/Table/Cell/ErrorCell.svelte`
- Modify: `frontend/src/lib/components/Table/TableGrid.svelte`, `frontend/src/lib/components/Table/TableView.svelte`, `frontend/src/lib/state/table-editor.svelte.ts`
- Test: `frontend/src/lib/components/Table/Cell/__tests__/ErrorCell.test.ts`, extend `TableGrid.test.ts`, `TableView.test.ts`, `src/lib/state/__tests__/table-editor.test.ts`

**Interfaces:**
- `ErrorCell.svelte`: prop `cell: Extract<TableCell, { kind: 'error' }>`; renders a warning glyph (⚠) + `cell.message` in destructive/warning styling, `title={cell.traceback ?? cell.message}` for hover detail; `data-testid="error-cell"`.
- `TableGrid.svelte:402-414`: make the `elements` branch explicit and add `{:else if cell.kind === 'error'}<ErrorCell {cell} />`. `cellLines` (76-80) returns 1 for `error`.
- `table-editor.svelte.ts`: `TableData` (83-92) gains `warnings: string[]`; `installPage` (329-343) sets it from `page.warnings`; `mergePage` (352-363) keeps the existing value (page-0 loads own it — same policy as `truncated`). Export `getTableWarnings(tabId): string[]`.
- `TableView.svelte`: banner after the conflict-banner block (198-205), same styling family:

```svelte
{#if warnings.length > 0}
    <div class="bg-warning/15 px-3 py-1.5 text-xs text-warning" data-testid="table-warnings">
        {warnings.join(' · ')}
    </div>
{/if}
```

- [ ] **Step 1: Failing tests** — ErrorCell renders message + title; TableGrid dispatches an `error` cell to ErrorCell (extend the existing grid fixture with an error cell); table-editor threads `warnings` from an installed page; TableView shows the banner when `getTableWarnings` is non-empty (spy).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run + check** → PASS/clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(snippet-ui): error cells + table warnings banner"`

---

## Task F6: Navigation — `ScriptStepRow` + PathCard insert

**Files:**
- Create: `frontend/src/lib/components/Navigation/ScriptStepRow.svelte`
- Modify: `frontend/src/lib/components/Navigation/PathCard.svelte`, `frontend/src/lib/state/navigation-editor.svelte.ts` (only if step-mutation helpers hardcode step kinds — check `insertStep` at PathCard:192-211 and the state helpers it calls)
- Test: `frontend/src/lib/components/Navigation/__tests__/script-step-row.test.ts`, extend `path-card.test.ts`

**Interfaces:**
- `ScriptStepRow.svelte` props mirror `PropertyStepRow.svelte` (check its exact prop list and copy: step + index + change/remove callbacks). Body: step-kind label "Script", `<SnippetSourceEditor snippet={step.snippet} entry="step" onChange={(s) => onStepChange({ ...step, snippet: s })} />` in the row's expandable area, plus the `comment` input the other rows have.
- `PathCard.svelte`: extend the insert menu (192-211) with a `Script step` option inserting `{ kind: 'script', snippet: {}, comment: null }`; extend the step-row dispatch with the `script` kind → `ScriptStepRow`.

- [ ] **Step 1: Failing tests** — path-card: insert menu offers "Script step" and inserts the default shape; script-step-row: renders SnippetSourceEditor with `entry="step"`, emits step patches, comment edits work.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run + check** → PASS/clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(snippet-ui): script step row + PathCard insert"`

---

## Task F7: Navigation warnings in ResultsDock

**Files:**
- Modify: `frontend/src/lib/state/navigation-editor.svelte.ts`, `frontend/src/lib/components/Navigation/ResultsDock.svelte`
- Test: extend `src/lib/state/__tests__/navigation-editor.test.ts`, `Navigation/__tests__/results-dock.test.ts`

**Interfaces:**
- `NavPreview` (navigation-editor.svelte.ts:91-99) gains `warnings: string[]`; `runPreview` (786-840, mapping at 823-830) and `loadMorePreview` (842+) carry `page.warnings` (load-more keeps the first page's warnings — same policy as table `mergePage`).
- `ResultsDock.svelte`: render warnings next to the truncation notice (156-158): `{#if preview.warnings.length}<span class="text-warning" data-testid="nav-warnings" title={preview.warnings.join('\n')}>⚠ {preview.warnings.length} script warning{preview.warnings.length > 1 ? 's' : ''}</span>{/if}`.

- [ ] **Step 1: Failing tests** — navigation-editor: `runPreview` stores `warnings` from an MSW-mocked ChainPage; results-dock: renders the warning chip when preview has warnings.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run + check** → PASS/clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(snippet-ui): navigation script warnings in ResultsDock"`

---

## Task F8: Playwright e2e + docs + full verification

**Files:**
- Create: `frontend/e2e/script-embedding.spec.ts`
- Modify: `frontend/README.md`

- [ ] **Step 1: Write the e2e spec** (template: `e2e/table.spec.ts` — reuse `openDefaultProject`/`loadFiles` helpers and its selector conventions):
  1. **Script column flow**: create a snippet artifact via the snippet tab (as `e2e/snippet-flow.spec.ts` does) with `def value(els): return els[0].name if els[0].name != 'X' else 1/0` (an error for one row); open a table; `data-testid="add-script-column"`; pick the saved snippet in `snippet-ref-select`; assert computed value cells appear AND one `data-testid="error-cell"`; click the column header to sort — no crash, rows reorder.
  2. **Inline script column**: add a second script column, switch `snippet-mode-inline`, type a trivial `def value(els): return 2` body, assert cells show `2`.
  3. **Script step flow**: open the navigation builder; insert "Script step" with an inline `def step(el): return []`-style snippet against a known relationship (return a real neighbor id via `el.out()`), run preview, assert chains render; then make it raise and assert `data-testid="nav-warnings"` appears.
- [ ] **Step 2: Run e2e** — `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`. Note: the e2e backend boots per playwright config — script cells require the WASM guest binary; if the harness backend has no runner, cells show "script runner unavailable" error cells. Check how `snippet-flow.spec.ts` handles runner availability (it exercises real runs, so the harness must already fetch the binary — follow whatever it does; if it skips without the binary, apply the same skip guard).
- [ ] **Step 3: `frontend/README.md`** — add a short "Script columns & steps (M2/M3)" subsection under the snippet-workspace docs: SnippetSourceEditor's ref/inline contract, error cells, `warnings` threading (TableData/NavPreview), and the local-lint pattern (component-local debounce, not the tab-level `_lint` map).
- [ ] **Step 4: Full verification**

```bash
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'
pixi run dr-tidy
```

- [ ] **Step 5: Commit** — `git commit -m "test(snippet-ui): script embedding e2e + docs"`

---

## Execution notes

- F1 → F2 → (F3 → F4, F5 in parallel) → F6 → F7 → F8. F5 only needs F1.
- Backend plan must be complete on the branch first — the route contracts (`error` cells, `warnings`) are consumed here, and e2e runs against the real backend.
