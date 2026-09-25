# Table UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seven table improvements: multi-line multi-value cells, per-column edit/add buttons in the grid header, durable default-collapsed navigation cards in table settings, drag-to-reorder columns (header + settings), a hide/unhide (eye) toggle per column, a "Step to use" field on Earlier-column sources that reference a navigation column, and a much larger, resizable settings dialog.

**Architecture:** Backend gets two additive schema fields (`Column.hidden`, `ColumnRef.step_index`) honored at export/evaluation; everything else is frontend. Hidden columns stay fully evaluated (ColumnRefs may depend on them) and are filtered only at render (TableGrid) and export (xlsx route). Multi-line cells require variable-height row virtualization (prefix-sum windowing). PathCard collapse state moves from component-local `$state` into the navigation-editor store, keyed `(tabId, pathKey)`, defaulting to collapsed for embedded (table-settings) drafts.

**Tech Stack:** Python 3.14 (pyright floor 3.10) / Pydantic / FastAPI / openpyxl; SvelteKit + Svelte 5 runes + Zod + vitest (happy-dom, `mount`/`flushSync`, spy-based API stubbing).

## Global Constraints

- **Work in an isolated git worktree** branched from `main` (branch `feature/table-ux-improvements`). Another session owns `feature/navigation-property-step` and edits `NavigationColumnEditor.svelte` (the `step_index` label), `RowSourceEditor.svelte`, `Navigation/` components, and `navigation/tree.ts` — do not touch that branch or the main checkout.
- All commands run through pixi: `pixi run -e core-dev pytest tests/...`, and frontend commands MUST run from inside `frontend/` (`pixi run -e frontend bash -c 'cd frontend && npm test -- <pattern>'`).
- Never deep-clone a `TableDefinition` (breaks the inline-nav mirror; see `frontend/src/lib/table/columns.ts` module doc). All copies are copy-on-write at column granularity.
- Match Svelte 5 idiom: `$props`, `$state`, `$derived`, `$derived.by`, `$effect`, `$state.raw` for reference-compared definitions.
- Preserve existing `data-testid` hooks; component tests use `mount`/`flushSync`/`unmount` from `svelte`, not testing-library.
- Don't import stdlib typing features newer than Python 3.10 from `typing` (use `typing_extensions`).
- Dense "why" docstrings/comments are the house style in `core/` — preserve and extend them.
- Commit after every task (conventional-commit style, matching `git log`).

---

### Task 0: Worktree + environment setup

**Files:** none (infrastructure)

- [ ] **Step 1: Create the worktree and branch**

```bash
cd /home/mdp/workspace/data-rover-py
git worktree add ../data-rover-tables -b feature/table-ux-improvements main
```

- [ ] **Step 2: Install environments in the worktree**

```bash
cd /home/mdp/workspace/data-rover-tables
pixi install -e core-dev -e frontend
pixi run -e frontend bash -c 'cd frontend && npm install'
```

- [ ] **Step 3: Sanity-check both test suites run**

Run: `pixi run -e core-dev pytest tests/table -q` → all pass.
Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/components/Table'` → all pass.

All subsequent tasks run inside `/home/mdp/workspace/data-rover-tables`.

---

### Task 1: Backend — `hidden` flag on columns + xlsx export filtering

**Files:**
- Modify: `src/data_rover/core/table/schema.py` (the three column classes)
- Modify: `src/data_rover/api/routes/tables.py:243-251` (export route)
- Test: `tests/table/test_schema.py`, `tests/api/test_table_export.py`

**Interfaces:**
- Produces: `ElementColumn.hidden / PropertyColumn.hidden / NavigationColumn.hidden: bool = False`. Presentation-only: evaluation, sorting, ColumnRefs are untouched; only the export route (and, in Task 5, the frontend grid) filter on it.

- [ ] **Step 1: Write failing tests**

In `tests/table/test_schema.py` add:

```python
def test_hidden_defaults_false_and_parses():
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": []},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}},
                {"kind": "property", "name": "p", "hidden": True},
            ],
        }
    )
    assert defn.columns[0].hidden is False
    assert defn.columns[1].hidden is True
```

In `tests/api/test_table_export.py` add (mirror the existing test's setup style — seeded project, `papi` helper, small scope model):

```python
def test_export_skips_hidden_columns(client, seed_default_project):
    # same model/table setup as the existing header test, but the middle
    # column is hidden AND referenced by a later visible column — the export
    # must omit the hidden column while the dependent one still evaluates.
    ...post a definition with columns:
        [element (visible), navigation hidden mode=expand,
         property sourced {"kind": "column", "index": 1} (visible)]
    wb = openpyxl.load_workbook(io.BytesIO(resp.content))
    ws = wb.active
    header = [c.value for c in ws[1]]
    assert len(header) == 2          # hidden column absent
    assert "Navigation" not in header
```

(Adapt names/types to whatever the existing export tests seed — copy their model-building helper.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_schema.py -k hidden tests/api/test_table_export.py -k hidden -v`
Expected: FAIL (`hidden` not a field / 3 header cells).

- [ ] **Step 3: Implement**

`schema.py` — add to each of `ElementColumn`, `PropertyColumn`, `NavigationColumn` (after `width_px`):

```python
    #: Presentation-only: a hidden column is still evaluated (later columns
    #: may reference it via ColumnRef) but is omitted from the grid and the
    #: xlsx export. Never feed this into evaluation — dropping the column
    #: would shift ColumnRef indices and the expand-slot arithmetic.
    hidden: bool = False
```

`routes/tables.py` export route — replace lines 243-251 with:

```python
    # Hidden columns are evaluated (a visible column may reference them) but
    # never exported: filter headers/widths AND each row's cells by position.
    visible = [i for i, c in enumerate(defn.columns) if not c.hidden]
    headers = [defn.columns[i].header or defn.columns[i].kind for i in visible]
    widths = [defn.columns[i].width_px for i in visible]
    all_rows = iter_export_rows(metamodel, model, defn, ordered, limits)
    blob = build_workbook(
        model,
        headers,
        widths,
        name,
        ([row[i] for i in visible] for row in all_rows),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table tests/api/test_table_export.py -q`
Expected: PASS (including all pre-existing tests).

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-core && pixi run lint-backend
git add -A && git commit -m "feat(table): hidden column flag, honored by xlsx export"
```

---

### Task 2: Backend — `ColumnRef.step_index` (use a specific step of a referenced navigation column)

**Files:**
- Modify: `src/data_rover/core/table/schema.py` (`ColumnRef`, `_validate_sources`, `_source_arity`)
- Modify: `src/data_rover/core/table/evaluate.py` (`resolve_source_elements` + new helper)
- Test: `tests/table/test_schema.py`, `tests/table/test_build_rows.py` or `tests/table/test_cells.py`

**Interfaces:**
- Produces: `ColumnRef.step_index: int | None = None`. Semantics: only legal when the referenced column is a `navigation` column. When set, the reference resolves to the elements at that chain step (0 = chain start, negative = Python-style) instead of the referenced column's own projection. For an `expand` navigation column, only chains that project (at the column's own step) to this row's expanded element are considered. `_source_arity`: a nav ref with `step_index` set is multi-binding (`single=False`).

- [ ] **Step 1: Write failing schema tests** (`tests/table/test_schema.py`)

```python
def test_source_step_index_requires_navigation_ref():
    with pytest.raises(ValidationError, match="navigation column"):
        TABLE_ADAPTER.validate_python(
            {
                "row_source": {"kind": "scope", "types": []},
                "columns": [
                    {"kind": "element", "source": {"kind": "row"}},
                    {
                        "kind": "property",
                        "name": "p",
                        "source": {"kind": "column", "index": 0, "step_index": 1},
                    },
                ],
            }
        )


def test_source_step_index_on_expand_nav_is_multi_binding():
    # an element column needs a single-binding source; a step-index override
    # on an expand nav ref returns the (possibly many) step elements
    with pytest.raises(ValidationError, match="single-binding"):
        TABLE_ADAPTER.validate_python(
            {
                "row_source": {"kind": "scope", "types": []},
                "columns": [
                    {"kind": "element", "source": {"kind": "row"}},
                    {"kind": "navigation", "navigation": {}, "mode": "expand"},
                    {
                        "kind": "element",
                        "source": {"kind": "column", "index": 1, "step_index": 1},
                    },
                ],
            }
        )
```

- [ ] **Step 2: Write failing evaluation tests** (`tests/table/test_cells.py`, reusing its model-building helpers; build a two-hop model A→B→C)

```python
def test_column_ref_step_index_collapse():
    # nav column (collapse) reaches C (last step); a property column sourced
    # from it with step_index=1 reads B's property values.
    ...


def test_column_ref_step_index_expand_filters_by_row_element():
    # nav column (expand) → one row per reached C; a values column sourced
    # {"kind": "column", "index": <nav>, "step_index": 1} shows only the
    # intermediate B(s) on chains reaching THAT row's C.
    ...


def test_column_ref_step_index_out_of_range_raises():
    with pytest.raises(ValueError, match="step_index"):
        ...  # step_index=9 against a 3-long chain → build/evaluate raises
```

Copy the metamodel/model fixtures used by `test_property_step_navigation_resolution` in the same file; keep assertions on concrete cell values.

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table -k step_index -v`
Expected: FAIL (unknown field / wrong values).

- [ ] **Step 4: Implement schema**

`schema.py`:

```python
class ColumnRef(BaseModel):
    kind: Literal["column"] = "column"
    index: int = Field(ge=0)
    #: Only legal when the referenced column is a NAVIGATION column: resolve
    #: this reference to the elements at THIS chain step (0 = the chain's
    #: start) instead of the referenced column's own projected step. None =
    #: the referenced column's own behavior (unchanged).
    step_index: int | None = None
```

In `_validate_sources`, after the backward-only check:

```python
            if isinstance(src, ColumnRef) and src.step_index is not None:
                if self.columns[src.index].kind != "navigation":
                    raise ValueError(
                        f"column {i}: source step_index requires the referenced "
                        "column to be a navigation column"
                    )
```

In `_source_arity`, change the navigation branch:

```python
        if ref.kind == "navigation":
            # a step-index override re-projects the chains and can return MANY
            # elements per row even off an expand column — no longer single.
            single = ref.mode == "expand" and src.step_index is None
            return True, single
```

- [ ] **Step 5: Implement evaluation**

`evaluate.py` — in `resolve_source_elements`, replace the block from `ref_col = defn.columns[source.index]` down to the navigation branch with:

```python
    ref_col = defn.columns[source.index]
    if ref_col.kind == "navigation" and source.step_index is not None:
        # Step-override reference: re-evaluate the navigation and read the
        # requested chain step. Off an EXPAND column the row is pinned to one
        # projected element, so only chains projecting to it count.
        roots = resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits
        )
        match: str | None = None
        if ref_col.mode == "expand":
            b = key[_expand_slot_of(defn, base_slots, source.index)]
            if not isinstance(b, str):
                return []
            match = b
        return _navigation_step_elements(
            mm, model, ref_col, roots, limits,
            step=source.step_index, match_projected=match,
        )
    if getattr(ref_col, "mode", "collapse") == "expand":
        b = key[_expand_slot_of(defn, base_slots, source.index)]
        return [b] if isinstance(b, str) else []
    ...  # (element / navigation / property branches unchanged)
```

New helper next to `_navigation_reached_ex`:

```python
def _navigation_step_elements(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn,
    roots: list[str],
    limits: TableLimits,
    *,
    step: int,
    match_projected: str | None,
) -> list[str]:
    """Elements at chain step `step` of `col`'s navigation, evaluated from
    `roots`. With `match_projected` set (the expand-column case) only chains
    whose OWN projection — the column's `step_index` — equals it contribute,
    keeping the reference row-correct. Mirrors `_navigation_reached_ex`'s
    dedup-preserving-order and its ValueError-on-out-of-range (API → 422)."""
    defn = col.navigation.definition
    if defn is None or not roots:
        return []
    result = evaluate(mm, model, defn, limits.nav_limits, row_elements=roots)
    proj = col.step_index if col.step_index is not None else -1
    seen: dict[str, None] = {}
    for chain in result.chains:
        _check_step_index(step, len(chain))
        if match_projected is not None:
            _check_step_index(proj, len(chain))
            if chain[proj] != match_projected:
                continue
        seen[chain[step]] = None
    return list(seen)
```

- [ ] **Step 6: Run tests**

Run: `pixi run -e core-dev pytest tests/table tests/api -q`
Expected: PASS.

- [ ] **Step 7: Lint + commit**

```bash
pixi run lint-core && pixi run lint-backend
git add -A && git commit -m "feat(table): step_index on earlier-column sources referencing a navigation column"
```

---

### Task 3: Frontend foundation — Zod fields + column factories + step-count helper

**Files:**
- Modify: `frontend/src/lib/api/types.ts:581-634`
- Modify: `frontend/src/lib/table/columns.ts`
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte:127-158` (use the factories)
- Test: `frontend/src/lib/table/__tests__/columns.test.ts`

**Interfaces:**
- Produces (columns.ts):
  - `newPropertyColumn(): Column` / `newNavigationColumn(): Column` — the exact literals currently inlined in ColumnManager's `addPropertyColumn`/`addNavigationColumn` (plus `hidden: false`).
  - `navMaxStepIndex(defn: NavigationDefinition): number` — `defn.kind === 'path' ? chainColumns(defn).length - 1 : 0` (a set_op has a single implicit column).
- Produces (types.ts): `ColumnRefSchema` gains `step_index: z.number().int().nullish()`; each column schema gains `hidden: z.boolean().default(false)`.

- [ ] **Step 1: Write failing tests** (`columns.test.ts`)

```ts
import { navMaxStepIndex, newNavigationColumn, newPropertyColumn } from '../columns';

test('factories produce schema-valid defaults', () => {
	expect(ColumnSchema.parse(newPropertyColumn())).toMatchObject({ hidden: false, name: '' });
	expect(ColumnSchema.parse(newNavigationColumn())).toMatchObject({ hidden: false, cell_cap: 20 });
});

test('navMaxStepIndex counts chain columns', () => {
	const path = {
		kind: 'path',
		start: { kind: 'scope', types: [], criteria: [] },
		steps: [
			{ kind: 'relationship', relationship_type: 'r', direction: 'out', target_types: [], children: [] },
			{ kind: 'filter', criteria: [] },
			{ kind: 'relationship', relationship_type: 's', direction: 'out', target_types: [], children: [] }
		]
	} as NavigationDefinition;
	expect(navMaxStepIndex(path)).toBe(2); // start + 2 relationship hops → max index 2
	expect(navMaxStepIndex({ kind: 'set_op', op: 'union', operands: [] } as NavigationDefinition)).toBe(0);
});

test('hidden and source step_index round-trip through the definition schema', () => {
	const defn = TableDefinitionSchema.parse({
		row_source: { kind: 'scope', types: [] },
		columns: [
			{ kind: 'element', source: { kind: 'row' } },
			{ kind: 'navigation', navigation: {}, hidden: true },
			{ kind: 'property', name: 'p', source: { kind: 'column', index: 1, step_index: 1 } }
		]
	});
	expect(defn.columns[1].hidden).toBe(true);
	expect((defn.columns[2].source as { step_index?: number | null }).step_index).toBe(1);
});
```

(Adjust the set_op literal to whatever `NavigationDefinitionSchema` requires — check `emptyCombine()` in `navigation/tree.ts` for a valid shape.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/table'`
Expected: FAIL.

- [ ] **Step 3: Implement**

types.ts:

```ts
const ColumnRefSchema = z.object({
	kind: z.literal('column'),
	index: z.number().int(),
	// only meaningful when the referenced column is a navigation column: the
	// chain step this reference reads (null = the column's own projection)
	step_index: z.number().int().nullish()
});
```

Add `hidden: z.boolean().default(false)` to `ElementColumnSchema`, `PropertyColumnSchema`, `NavigationColumnSchema` (after `width_px`).

columns.ts:

```ts
/** Fresh default columns for the two addable kinds — shared by ColumnManager's
 * add buttons and the grid header's "+" menu. */
export function newPropertyColumn(): Column {
	return {
		kind: 'property',
		source: { kind: 'row', chain_index: 0 },
		name: '',
		mode: 'collapse',
		keep_empty: true,
		header: '',
		width_px: null,
		hidden: false
	};
}

export function newNavigationColumn(): Column {
	return {
		kind: 'navigation',
		source: { kind: 'row', chain_index: 0 },
		navigation: {},
		step_index: null,
		mode: 'collapse',
		keep_empty: true,
		sort_mode: 'value',
		cell_cap: 20,
		header: '',
		width_px: null,
		hidden: false
	};
}

/** Highest addressable chain step of a navigation definition: a path has one
 * column per relationship/property hop plus the start (index 0); a set_op
 * root exposes a single implicit column. */
export function navMaxStepIndex(defn: NavigationDefinition): number {
	return defn.kind === 'path' ? Math.max(0, chainColumns(defn).length - 1) : 0;
}
```

ColumnManager: replace the bodies of `addPropertyColumn`/`addNavigationColumn` with `apply(addColumn(defn, newPropertyColumn()))` / `apply(addColumn(defn, newNavigationColumn()))` and import the factories.

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/table src/lib/components/Table'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(frontend): table schema fields (hidden, source step_index) + column factories"
```

---

### Task 4: Frontend — multi-line multi-value cells + variable-height windowing

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/windowing.ts` (new `computeWindowVariable`)
- Modify: `frontend/src/lib/components/Table/TableGrid.svelte`
- Modify: `frontend/src/lib/components/Table/Cell/ValuesCell.svelte`, `frontend/src/lib/components/Table/Cell/ElementsCell.svelte`
- Test: `frontend/src/lib/components/Sidebar/windowing.test.ts`, `frontend/src/lib/components/Table/__tests__/TableGrid.test.ts`

**Interfaces:**
- Produces: `computeWindowVariable({ scrollTop, viewportH, offsets, overscan }): WindowSlice` where `offsets` is a prefix-sum array of length `total + 1` (`offsets[0] = 0`, `offsets[i+1] = offsets[i] + heightOf(row i)`). Same `WindowSlice` return shape as `computeWindow`.
- Row height rule in TableGrid: `lines(row) = max over cells of cellLines(cell)`; `cellLines` = 1 for `element`/`value`, `max(1, values.length + (truncated ? 1 : 0))` for `values`, `max(1, items.length + (truncated ? 1 : 0))` for `elements`; unloaded (sparse) rows = 1 line; row height = `lines * ROW_H` (28).

- [ ] **Step 1: Write failing windowing unit tests** (`windowing.test.ts`)

```ts
import { computeWindowVariable } from './windowing';

describe('computeWindowVariable', () => {
	// 4 rows of heights 28, 84, 28, 56 → offsets [0, 28, 112, 140, 196]
	const offsets = [0, 28, 112, 140, 196];

	it('windows by cumulative height', () => {
		const w = computeWindowVariable({ scrollTop: 30, viewportH: 100, offsets, overscan: 0 });
		expect(w.start).toBe(1); // row 1 spans 28..112 — first intersecting scrollTop 30
		expect(w.end).toBe(3); // rows 1..2 cover through y=140 ≥ 130
		expect(w.padTop).toBe(28);
		expect(w.padBottom).toBe(196 - 140);
	});

	it('clamps overscan at the ends and handles empty', () => {
		expect(computeWindowVariable({ scrollTop: 0, viewportH: 50, offsets: [0], overscan: 5 }))
			.toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
		const w = computeWindowVariable({ scrollTop: 0, viewportH: 1000, offsets, overscan: 8 });
		expect(w).toMatchObject({ start: 0, end: 4, padTop: 0, padBottom: 0 });
	});
});
```

- [ ] **Step 2: Run to verify failure**, then **implement** in `windowing.ts`:

```ts
/**
 * Variable-row-height counterpart of {@link computeWindow}: `offsets` is a
 * prefix-sum array (offsets[i] = y of row i's top; offsets[total] = full
 * height). Binary-searches the first/last intersecting rows so a 50k-row
 * table costs O(log n) per scroll frame.
 */
export function computeWindowVariable(args: {
	scrollTop: number;
	viewportH: number;
	offsets: number[];
	overscan: number;
}): WindowSlice {
	const { scrollTop, viewportH, offsets, overscan } = args;
	const total = offsets.length - 1;
	if (total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
	// first row whose bottom edge is past scrollTop
	let lo = 0, hi = total - 1, first = total - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid + 1] > scrollTop) { first = mid; hi = mid - 1; } else lo = mid + 1;
	}
	const bottom = scrollTop + viewportH;
	let last = first;
	while (last < total && offsets[last] < bottom) last++;
	const start = Math.max(0, first - overscan);
	const end = Math.min(total, last + overscan);
	return { start, end, padTop: offsets[start], padBottom: offsets[total] - offsets[end] };
}
```

Run the unit tests → PASS. Commit checkpoint optional.

- [ ] **Step 3: Write failing TableGrid test** (`TableGrid.test.ts`, following the file's existing mount/stub pattern)

```ts
it('gives a row one line per value in its tallest cell', async () => {
	// page with one row whose 'values' cell has 3 values (truncated: false)
	...mount TableGrid with a stubbed page...
	const row = root.querySelector('[data-testid="table-row"]') as HTMLElement;
	expect(row.style.height).toBe('84px'); // 3 lines * 28
	const lines = row.querySelectorAll('[data-testid="cell-line"]');
	expect(lines.length).toBe(3);
});
```

And a `ValuesCell`-level assertion (same test file or a new `Cell` test): each value renders inside its own `[data-testid="cell-line"]` wrapper; the count badge sits on the first line; `+N more` / `…` truncation marker gets its own final line.

- [ ] **Step 4: Implement TableGrid changes**

- Add:

```ts
	// One line per value: the row is as tall as its tallest cell. Sparse
	// (unloaded) rows count 1 line — heights can shift as rows stream in,
	// which is the standard estimated-height virtualization tradeoff.
	function cellLines(cell: TableCell): number {
		if (cell.kind === 'values') return Math.max(1, cell.values.length + (cell.truncated ? 1 : 0));
		if (cell.kind === 'elements') return Math.max(1, cell.items.length + (cell.truncated ? 1 : 0));
		return 1;
	}
	const offsets = $derived.by(() => {
		const out = new Array<number>(rows.length + 1);
		out[0] = 0;
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const lines = r ? Math.max(1, ...r.cells.map(cellLines)) : 1;
			out[i + 1] = out[i] + lines * ROW_H;
		}
		return out;
	});
	const win = $derived(
		computeWindowVariable({ scrollTop, viewportH, offsets, overscan: OVERSCAN })
	);
```

- Loaded row div: `style="height:{offsets[win.start + i + 1] - offsets[win.start + i]}px"`; change the row's cell wrapper from `items-center` to `items-start` (placeholder rows keep `height:{ROW_H}px` and `items-center`).
- Wrap the single-line cell components so they stay centered on the first line: give the cell wrapper's direct child a 28px line box — simplest is adding `class="flex h-7 w-full min-w-0 items-center"` around `ElementCell`/`ValueCell` (leave `ValuesCell`/`ElementsCell` to manage their own lines).

- [ ] **Step 5: Implement the two cell components**

`ValuesCell.svelte` — replace the container + chips with stacked lines (update the header comment: the row is no longer a fixed-height strip):

```svelte
<div class="flex w-full min-w-0 flex-col overflow-hidden" title={tooltip}>
	{#if cell.values.length === 0}
		<span class="flex h-7 items-center text-muted-foreground/50">—</span>
	{:else if cell.values.length === 1}
		<span class="flex h-7 items-center truncate" class:text-muted-foreground={!cell.present}>{texts[0]}</span>
	{:else}
		{#each texts as text, i (i)}
			<span data-testid="cell-line" class="flex h-7 min-w-0 items-center gap-1 whitespace-nowrap">
				{#if i === 0}
					<span data-testid="cell-count" class="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">{cell.total}</span>
				{/if}
				<span class="min-w-0 truncate rounded bg-muted/50 px-1.5 py-0.5" class:text-muted-foreground={!cell.present}>{text}</span>
			</span>
		{/each}
		{#if cell.truncated}
			<span data-testid="cell-line" class="flex h-7 items-center text-[10px] text-muted-foreground/70">…</span>
		{/if}
	{/if}
</div>
```

`ElementsCell.svelte` — same structure: one `data-testid="cell-line"` per element chip (chip stays a `<button>` with the same `select` onclick, `max-w-40` → `min-w-0 max-w-full`), count badge on the first line when `cell.total > 1`, `+{n} more` marker as its own final line.

- [ ] **Step 6: Run tests** — `npm test -- --run src/lib/components/Table src/lib/components/Sidebar` → PASS (fix any pre-existing TableGrid assertions that assumed 28px rows).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(frontend): one line per value in multi-value cells (variable-height rows)"
```

---

### Task 5: Frontend — hidden columns in the grid + eye toggle in settings

**Files:**
- Modify: `frontend/src/lib/components/Table/TableGrid.svelte`
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte`
- Test: `frontend/src/lib/components/Table/__tests__/TableGrid.test.ts`, `__tests__/ColumnManager.test.ts`

**Interfaces:**
- Consumes: `Column.hidden` (Task 3). TableGrid keys everything by **definition index** — hidden filtering only changes which indices render, never the indices themselves (sort, resize, `columnNameFor`, `setColumnWidth` all keep definition indices).

- [ ] **Step 1: Write failing tests**

TableGrid: a page of 3 columns where the draft definition marks column 1 `hidden: true` → header renders 2 cells, rows render 2 cells, and the remaining cells correspond to definition columns 0 and 2 (assert on header text).
ColumnManager: `toggle-hidden-{i}` button exists per column; clicking it calls `updateTableDefinition` with `columns[i].hidden === true`; the button's `aria-label` flips between `Hide column` and `Show column` and the icon flips (query the svg by `data-testid="eye-off-icon"` presence or by aria-label only).

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement TableGrid**

```ts
	// Hidden columns are evaluated server-side (ColumnRefs may target them)
	// but never rendered. Pairs keep the DEFINITION index i — sort, resize and
	// width all speak definition indices; only DOM order is compacted.
	const visibleCols = $derived.by(() => {
		const cols = page?.columns ?? [];
		const defCols = getTableDraft(tabId)?.definition.columns;
		return cols.map((col, i) => ({ col, i })).filter(({ i }) => !defCols?.[i]?.hidden);
	});
```

- Header: `{#each visibleCols as v (v.i)}` using `v.col` / `v.i` everywhere (`widthFor(v.col, v.i)`, `toggleSort(v.i)`, resize handlers).
- Body + placeholder rows: `{#each visibleCols as v (v.i)}{@const cell = row.cells[v.i]}` (guard `cell` undefined → render empty div) with `widthFor(v.col, v.i)`.
- `autoFitColumn(defIndex: number, domIndex: number)`: header/child lookups use `domIndex` (`visibleCols.findIndex((v) => v.i === defIndex)` at the call site is fine), `setColumnWidth` uses `defIndex`.

- [ ] **Step 4: Implement ColumnManager eye toggle**

Import `Eye, EyeOff` from `@lucide/svelte`. Insert between the move-down and remove buttons:

```svelte
<button
	type="button"
	data-testid="toggle-hidden-{i}"
	class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted"
	aria-label={col.hidden ? 'Show column' : 'Hide column'}
	title={col.hidden
		? 'Show this column in the table and exports again'
		: 'Hide from the table and exports — still computed and usable as an "Earlier column" source'}
	onclick={() => onColumnChange(i, { ...col, hidden: !col.hidden })}
>
	{#if col.hidden}<EyeOff class="size-3" />{:else}<Eye class="size-3" />{/if}
</button>
```

Also dim a hidden column's row: add `class:opacity-60={col.hidden}` on the card's inner header `div` (the `flex flex-wrap` one), not the whole card (the editor stays usable).

- [ ] **Step 5: Run tests** — `npm test -- --run src/lib/components/Table` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(frontend): hide/unhide columns (eye toggle; grid + export omit them)"
```

---

### Task 6: Frontend — store-backed PathCard collapse (default collapsed in table settings, durable across edits)

**Files:**
- Modify: `frontend/src/lib/state/navigation-editor.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (barrel export)
- Modify: `frontend/src/lib/components/Navigation/PathCard.svelte:92-99,246-254,286,317`
- Test: `frontend/src/lib/state/__tests__/` (wherever navigation-editor tests live — grep `navigation-editor` under `__tests__`), `frontend/src/lib/components/Table/__tests__/ColumnManager.reorder.test.ts` style end-to-end component test

**Interfaces:**
- Produces (navigation-editor store, exported through `$lib/state`):
  - `isCardCollapsed(tabId: string, path: NodePath): boolean` — explicit override if one was recorded, else **default collapsed when the draft is embedded** (`getDraft(tabId)?.embedded != null`, i.e. table settings), expanded otherwise.
  - `setCardCollapsed(tabId: string, path: NodePath, collapsed: boolean): void`
- The map is keyed `(tabId, pathKey)` and must follow `_expanded`'s lifecycle exactly: carried by `moveTabState` (`navigation-editor.svelte.ts:311-314`), remapped by `applyStructuralEdit` (`:555-563`, via `edit.remapPath`), deleted wherever `_expanded.delete(tabId)` / `.clear()` runs (`:727`, `:825`, `:836`).

- [ ] **Step 1: Write failing store tests**

```ts
it('defaults collapsed for embedded drafts, expanded for standalone', () => {
	ensureEmbeddedDraft('navemb:t', emptyRowPath(), { rowContext: true, rowElementId: null });
	expect(isCardCollapsed('navemb:t', [])).toBe(true);
	ensureDraft('nav:standalone'); // or however standalone drafts are created in existing tests
	expect(isCardCollapsed('nav:standalone', [])).toBe(false);
});

it('an explicit toggle survives definition updates and structural edits', () => {
	setCardCollapsed('navemb:t', [], false);
	updateDefinition('navemb:t', someEditedDefinition);
	expect(isCardCollapsed('navemb:t', [])).toBe(false);
});
```

(Mirror setup from the existing navigation-editor store tests; find them with `grep -rl 'ensureEmbeddedDraft' frontend/src/lib --include='*.test.ts'`.)

- [ ] **Step 2: Write the failing regression component test** (new file `frontend/src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts`, modeled on `ColumnManager.reorder.test.ts` which drives the REAL table + navigation stores):

```ts
it('a PathCard expanded by the user stays expanded when a column is added', async () => {
	// mount ColumnManager with one inline-navigation column (PathCard renders collapsed by default)
	const toggle = root.querySelector('[data-testid="path-collapse-toggle"]') as HTMLButtonElement;
	expect(toggle.getAttribute('aria-expanded')).toBe('false'); // default collapsed (task 3 requirement)
	toggle.click(); flushSync();
	expect(toggle.getAttribute('aria-expanded')).toBe('true');
	(root.querySelector('[data-testid="add-property-column"]') as HTMLButtonElement).click();
	await Promise.resolve(); flushSync();
	const t2 = root.querySelector('[data-testid="path-collapse-toggle"]') as HTMLButtonElement;
	expect(t2.getAttribute('aria-expanded')).toBe('true'); // state preserved
});
```

- [ ] **Step 3: Run to verify failure** (`aria-expanded` starts `'true'` today → first assertion fails).

- [ ] **Step 4: Implement the store**

Next to `_expanded` (`navigation-editor.svelte.ts:103`):

```ts
/** tabId -> pathKey -> the user's explicit card-collapse choice. PathCard's
 * disclosure USED to be component-local $state, which silently reset to
 * expanded whenever a card remounted (auto-wrap into a combination, dialog
 * reopen, editor reuse). Store-keyed state survives remounts; the DEFAULT
 * (no entry) is collapsed for EMBEDDED drafts — a table-settings dialog
 * full of expanded navigation builders is unreadable — and expanded for
 * standalone navigation tabs. Follows `_expanded`'s lifecycle: moved by
 * moveTabState, remapped by applyStructuralEdit, dropped with the draft. */
const _cardCollapsed = new SvelteMap<string, SvelteMap<string, boolean>>();

export function isCardCollapsed(tabId: string, path: NodePath): boolean {
	const explicit = _cardCollapsed.get(tabId)?.get(pathKey(path));
	if (explicit !== undefined) return explicit;
	return getDraft(tabId)?.embedded != null;
}

export function setCardCollapsed(tabId: string, path: NodePath, collapsed: boolean): void {
	let m = _cardCollapsed.get(tabId);
	if (!m) {
		m = new SvelteMap();
		_cardCollapsed.set(tabId, m);
	}
	m.set(pathKey(path), collapsed);
}
```

Then wire the lifecycle by mirroring every `_expanded` touchpoint found via `grep -n '_expanded' navigation-editor.svelte.ts`:
- `moveTabState` (~:311): move the inner map `oldTab` → `newTab`.
- `applyStructuralEdit` (~:558-563): rebuild the inner map through `edit.remapPath` exactly as the expanded set is rebuilt (drop entries whose remap returns null, if that's what `_expanded` does — match it).
- The `_expanded.delete(tabId)` sites (~:727 closeDraft, ~:825) and `.clear()` (~:836 reset): same for `_cardCollapsed`.
- Export both functions from the barrel (`state/index.ts`, inside the existing `./navigation-editor.svelte` export block ending at line 245).

- [ ] **Step 5: Rewire PathCard**

Replace `let collapsed = $state(false);` (line 99) with:

```ts
	const collapsed = $derived(isCardCollapsed(tabId, path));
```

(import `isCardCollapsed`, `setCardCollapsed` from `$lib/state`; keep the comment, updated to say the state now lives in the store so it survives remounts and defaults per context). Toggle button `onclick={() => setCardCollapsed(tabId, path, !collapsed)}`.

- [ ] **Step 6: Run the full navigation + table component suites**

Run: `npm test -- --run src/lib/components/Navigation src/lib/components/Table src/lib/state`
Expected: PASS. Existing Navigation tests that assumed expanded-by-default still pass because standalone drafts default expanded; fix any that mount PathCard with an embedded draft expecting expanded (they now must toggle first — that's the intended behavior change).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(frontend): durable PathCard collapse, default-collapsed in table settings"
```

---

### Task 7: Frontend — shared ColumnSourceEditor + "Step to use" field

**Files:**
- Create: `frontend/src/lib/components/Table/ColumnSourceEditor.svelte`
- Modify: `frontend/src/lib/components/Table/NavigationColumnEditor.svelte:178-193,225-267` and `PropertyColumnEditor.svelte:78-93,128-170` (replace the duplicated source rows)
- Test: new `frontend/src/lib/components/Table/__tests__/ColumnSourceEditor.test.ts`

**Interfaces:**
- Consumes: `navMaxStepIndex` (Task 3), `ColumnRef.step_index` (Tasks 2–3), `api.getArtifact` from `$lib/api/artifacts`.
- Produces: `ColumnSourceEditor.svelte` with props:

```ts
let { source, columns, columnIndex, rowSource, onSourceChange }: {
	source: ColumnSource;
	columns: Column[];
	columnIndex: number;
	rowSource: RowSource | null;
	onSourceChange: (next: ColumnSource) => void;
} = $props();
```

It renders exactly today's source row (kind select, chain-step input for a `chains` row source, earlier-column select) **plus**, when the selected earlier column is a `navigation` column, a "Step to use" numeric input bound to `source.step_index` (`data-testid="source-step-index"`).

- [ ] **Step 1: Write failing component tests** (`ColumnSourceEditor.test.ts`, mount-based)

Cases:
1. Renders the kind select; "Earlier column" disabled when `columnIndex === 0`.
2. With a prior navigation column and `source = { kind: 'column', index: 1 }`: the `source-step-index` input renders with `min="0"`, `max="2"` for an inline 2-hop path (use the path literal from Task 3's test), placeholder `column's step`, empty value.
3. Typing `5` clamps: `onSourceChange` called with `step_index: 2`; clearing → `step_index: null`.
4. With the prior column being a *property* column: no step input.
5. Selecting a different earlier column resets `step_index` to null (`onSourceChange` receives `{ kind: 'column', index: 0, step_index: null }`).
6. Saved-ref navigation: stub `vi.spyOn(api, 'getArtifact')` resolving a payload path with 1 hop → after a tick, `max` is `1`.

- [ ] **Step 2: Run to verify failure** (component doesn't exist).

- [ ] **Step 3: Implement `ColumnSourceEditor.svelte`**

Move the markup verbatim from `PropertyColumnEditor.svelte:128-170` (`<div class="flex flex-wrap items-center gap-2"> <span>source</span> …`), rewritten against the props above (`setSourceKind`/`setSourceChainIndex`/`setSourceColumnIndex` now call `onSourceChange` with a `ColumnSource`). Add:

```ts
	const refColumn = $derived(
		source.kind === 'column' ? (columns[source.index] ?? null) : null
	);
	// Max addressable chain step of the referenced navigation: inline
	// definitions are computed synchronously; a saved ref is fetched once and
	// cached per artifact id. While unknown the input is unconstrained — the
	// backend still 422s an out-of-range value.
	const stepCache = new Map<string, number>(); // control state, not reactive
	let refMaxStep = $state<number | null>(null);
	$effect(() => {
		if (refColumn?.kind !== 'navigation') { refMaxStep = null; return; }
		const nav = refColumn.navigation;
		if (nav.definition) { refMaxStep = navMaxStepIndex(nav.definition); return; }
		if (!nav.ref) { refMaxStep = null; return; }
		const cached = stepCache.get(nav.ref);
		if (cached !== undefined) { refMaxStep = cached; return; }
		refMaxStep = null;
		const ref = nav.ref;
		void api.getArtifact(ref).then((a) => {
			const max = navMaxStepIndex(a.payload as unknown as NavigationDefinition);
			stepCache.set(ref, max);
			if (refColumn?.kind === 'navigation' && refColumn.navigation.ref === ref) refMaxStep = max;
		}).catch(() => {});
	});
	function setStepIndex(e: Event): void {
		if (source.kind !== 'column') return;
		const raw = (e.currentTarget as HTMLInputElement).value.trim();
		let v = raw === '' ? null : Math.max(0, Math.floor(Number(raw)));
		if (v !== null && !Number.isFinite(v)) v = null;
		if (v !== null && refMaxStep !== null) v = Math.min(v, refMaxStep);
		onSourceChange({ ...source, step_index: v });
	}
```

Markup addition, inside the `{:else}` (earlier-column) branch after the column `<select>`:

```svelte
	{#if refColumn?.kind === 'navigation'}
		<label
			class="flex items-center gap-1"
			title="Which chain step of that navigation this column reads (0 = its start; empty = the step the column itself shows)"
		>
			Step to use
			<input
				data-testid="source-step-index"
				type="number"
				min="0"
				max={refMaxStep ?? undefined}
				placeholder="column's step"
				class="w-20 rounded border border-input bg-card px-1 py-0.5"
				value={source.step_index ?? ''}
				oninput={setStepIndex}
			/>
		</label>
	{/if}
```

`setSourceColumnIndex` must emit `{ kind: 'column', index: v, step_index: null }` (reset on retarget). `setSourceKind`'s column default likewise omits/nulls `step_index`.

- [ ] **Step 4: Swap it into both editors**

In `NavigationColumnEditor.svelte` and `PropertyColumnEditor.svelte`: delete their local `setSourceKind`/`setSourceChainIndex`/`setSourceColumnIndex` and the whole source-row markup; render instead:

```svelte
<ColumnSourceEditor
	source={column.source}
	{columns}
	{columnIndex}
	{rowSource}
	onSourceChange={(source) => onChange({ ...column, source })}
/>
```

Keep `priorColumns` only if still used elsewhere; otherwise remove.

- [ ] **Step 5: Run the Table component suite** — existing `NavigationColumnEditor`/`PropertyColumnEditor` tests must keep passing (their source-row selectors — `aria-label="Column source kind"` / `"Source column"` — still resolve inside the shared component).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(frontend): Step-to-use on earlier-column sources referencing a navigation (shared ColumnSourceEditor)"
```

---

### Task 8: Frontend — edit/add buttons in the grid header + focused settings mode

**Files:**
- Modify: `frontend/src/lib/components/Table/TableGrid.svelte` (header buttons + props)
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (focus state + handlers + dialog title)
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte` (`focusIndex` prop)
- Test: `__tests__/TableGrid.test.ts`, `__tests__/TableView.test.ts`, `__tests__/ColumnManager.test.ts`

**Interfaces:**
- TableGrid new optional props (rendered only when provided — TableView passes them only when `editable`):

```ts
	onEditColumn?: (index: number) => void;   // definition index
	onAddColumn?: (kind: 'property' | 'navigation') => void;
```

- ColumnManager new prop: `focusIndex?: number | null = null`. Non-null → render ONLY that column's card: no RowSourceEditor, no other columns, no add buttons, no move/remove buttons (rename input, eye toggle, and the kind editor stay).

- [ ] **Step 1: Write failing tests**

TableGrid: with `onEditColumn` provided, each header cell has `[data-testid="header-edit-{i}"]`; clicking it calls the handler with the definition index (including when an earlier column is hidden — header for def-column 2 still reports 2). With `onAddColumn` provided, `[data-testid="header-add-column"]` exists after the last header cell; clicking it opens a menu with "Property column" / "Navigation column" items that call `onAddColumn('property'|'navigation')`. Without the props: no buttons.
ColumnManager: `focusIndex={1}` renders exactly one card (no `row-source` testid, no `add-property-column`, no `move-up-1`, no `remove-column-1`).
TableView: clicking a header edit button opens the dialog showing only that column (mock page like the existing TableView tests; assert `column-manager` shows 1 card); the dialog Settings button path still shows all.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement TableGrid header**

Import `Pencil, Plus` from `@lucide/svelte` and `* as DropdownMenu from '$lib/components/ui/dropdown-menu'`. In each header cell (after the sort button, before the resize handle):

```svelte
	{#if onEditColumn}
		<button
			type="button"
			data-testid="header-edit-{v.i}"
			aria-label="Edit column {v.col.header || columnKindLabel(v.col.kind)}"
			title="Edit this column's settings"
			class="shrink-0 text-muted-foreground/50 transition-colors hover:text-foreground"
			onclick={() => onEditColumn?.(v.i)}
		>
			<Pencil class="size-3" />
		</button>
	{/if}
```

After the `{#each}` closes, still inside the header row:

```svelte
	{#if onAddColumn}
		<div class="flex shrink-0 items-center px-1">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					data-testid="header-add-column"
					aria-label="Add a column"
					title="Add a column"
					class="rounded border border-dashed border-input px-1.5 py-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
				>
					<Plus class="size-3" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start">
					<DropdownMenu.Item onSelect={() => onAddColumn?.('property')}>Property column</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={() => onAddColumn?.('navigation')}>Navigation column</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
	{/if}
```

(Match the existing DropdownMenu usage in `PathCard.svelte:435-480` for exact component API.)

- [ ] **Step 4: Implement TableView focus plumbing**

```ts
	import { addColumn, newNavigationColumn, newPropertyColumn } from '$lib/table/columns';
	import { updateTableDefinition } from '$lib/state';

	let settingsFocus = $state<number | null>(null);
	function editColumn(index: number): void {
		settingsFocus = index;
		settingsOpen = true;
	}
	function addColumnFromHeader(kind: 'property' | 'navigation'): void {
		const d = getTableDraft(tabId);
		if (!d) return;
		updateTableDefinition(tabId, addColumn(d.definition, kind === 'property' ? newPropertyColumn() : newNavigationColumn()));
		settingsFocus = getTableDraft(tabId)!.definition.columns.length - 1;
		settingsOpen = true;
	}
```

- Settings button `onclick={() => { settingsFocus = null; settingsOpen = true; }}`.
- `<TableGrid {tabId} onEditColumn={editable ? editColumn : undefined} onAddColumn={editable ? addColumnFromHeader : undefined} />`.
- Dialog: `<Dialog.Root bind:open={settingsOpen} onOpenChange={(o) => { if (!o) settingsFocus = null; }}>`; `<Dialog.Title …>{settingsFocus === null ? 'Table settings' : 'Column settings'}</Dialog.Title>`; `<ColumnManager {tabId} focusIndex={settingsFocus} />`.

- [ ] **Step 5: Implement ColumnManager focus mode**

```ts
	let { tabId, focusIndex = null }: { tabId: string; focusIndex?: number | null } = $props();
```

- Wrap `<RowSourceEditor …>` and the add-buttons `<div>` in `{#if focusIndex === null}`.
- Column loop: `{#if focusIndex === null || focusIndex === i}` around each card's content (keep the `{#each}` itself so index-keyed editor reuse is undisturbed).
- Wrap the move-up/move-down and remove buttons in `{#if focusIndex === null}`.

- [ ] **Step 6: Run tests** — `npm test -- --run src/lib/components/Table` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(frontend): per-column edit/add buttons in the table header with focused settings"
```

---

### Task 9: Frontend — settings dialog much larger + resizable

**Files:**
- Modify: `frontend/src/lib/components/Table/TableView.svelte:154-163`
- Test: `__tests__/TableView.test.ts`

- [ ] **Step 1: Write failing test**

Open settings (mock like existing tests); assert `[data-testid="table-settings-dialog"]` has inline `style` width/height set and `[data-testid="settings-resize-handle"]` exists. Simulate `pointerdown` at (0,0) + `pointermove` to (50, 40) + `pointerup` on the handle → the dialog's inline width grew by 100 and height by 80 (2× deltas — the dialog is center-anchored, so each edge moves half the size change; doubling keeps the corner under the cursor).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
	// The settings dialog is a working surface, not an alert: open big
	// (most of the viewport) and let the user resize from the corner. The
	// Dialog primitive centers via translate(-50%,-50%), so width/height are
	// controlled here and deltas are doubled to keep the grip under the cursor.
	const DLG_MIN_W = 640;
	const DLG_MIN_H = 400;
	let dlgW = $state(Math.min(1280, (typeof window === 'undefined' ? 1280 : window.innerWidth) * 0.92));
	let dlgH = $state((typeof window === 'undefined' ? 720 : window.innerHeight) * 0.85);
	let dlgResize: { x: number; y: number; w: number; h: number } | null = null;
	function onDlgResizeStart(e: PointerEvent): void {
		if (e.button !== 0) return;
		dlgResize = { x: e.clientX, y: e.clientY, w: dlgW, h: dlgH };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function onDlgResizeMove(e: PointerEvent): void {
		if (!dlgResize) return;
		dlgW = Math.min(Math.max(DLG_MIN_W, dlgResize.w + 2 * (e.clientX - dlgResize.x)), window.innerWidth * 0.98);
		dlgH = Math.min(Math.max(DLG_MIN_H, dlgResize.h + 2 * (e.clientY - dlgResize.y)), window.innerHeight * 0.95);
	}
	function onDlgResizeEnd(): void {
		dlgResize = null;
	}
```

Markup:

```svelte
	<Dialog.Root bind:open={settingsOpen} onOpenChange={(o) => { if (!o) settingsFocus = null; }}>
		<Dialog.Content
			data-testid="table-settings-dialog"
			class="flex max-w-none flex-col overflow-hidden"
			style="width:{dlgW}px;height:{dlgH}px"
		>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">
				{settingsFocus === null ? 'Table settings' : 'Column settings'}
			</Dialog.Title>
			<div class="min-h-0 flex-1 overflow-y-auto pr-1">
				<ColumnManager {tabId} focusIndex={settingsFocus} />
			</div>
			<div
				role="separator"
				aria-orientation="horizontal"
				tabindex="-1"
				data-testid="settings-resize-handle"
				class="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize touch-none select-none"
				onpointerdown={onDlgResizeStart}
				onpointermove={onDlgResizeMove}
				onpointerup={onDlgResizeEnd}
				onpointercancel={onDlgResizeEnd}
			></div>
		</Dialog.Content>
	</Dialog.Root>
```

If `Dialog.Content` doesn't forward `style`/`data-testid`, check `frontend/src/lib/components/ui/dialog/dialog-content.svelte` — it spreads rest props; if `class` merging strips `max-w-none`, verify with the rendered DOM in the test and adjust (`!max-w-none` as a last resort).

- [ ] **Step 4: Run tests → PASS. Commit.**

```bash
git add -A && git commit -m "feat(frontend): large resizable table-settings dialog"
```

---

### Task 10: Frontend — drag-to-reorder columns (settings list + grid header)

**Files:**
- Create: `frontend/src/lib/table/column-dnd.svelte.ts`
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte` (grip + handlers + drop highlight)
- Modify: `frontend/src/lib/components/Table/TableGrid.svelte` (header-cell drag + drop highlight)
- Test: new `frontend/src/lib/table/__tests__/column-dnd.test.ts`, extend `__tests__/ColumnManager.reorder.test.ts`, `__tests__/TableGrid.test.ts`

**Interfaces:**
- Produces `createColumnDrag` (Svelte 5 runes module — `.svelte.ts`):

```ts
export interface ColumnDragState {
	from: number | null;    // definition index being dragged (null = idle)
	over: number | null;    // definition index currently hovered as drop target
	valid: boolean;         // would moveColumn(from, over) succeed?
	onPointerDown(e: PointerEvent, index: number): void;
	onPointerMove(e: PointerEvent): void;
	onPointerUp(e: PointerEvent): void;
}
export function createColumnDrag(opts: {
	attr: string; // e.g. 'data-col-drop' — drop targets carry attr="<defIndex>"
	getDefinition: () => TableDefinition | undefined;
	onDrop: (from: number, to: number) => void;
}): ColumnDragState;
```

Behavior: `onPointerDown` arms (capture pointer, remember index + origin, `preventDefault` only after threshold); `onPointerMove` past a 4px threshold sets `from`, then hit-tests `document.elementFromPoint(e.clientX, e.clientY)?.closest(\`[${attr}]\`)` → `over` = parsed attr value; `valid` = `from !== over` and `moveColumn(defn, from, over)` doesn't throw (call in try/catch — it's pure). `onPointerUp` fires `onDrop(from, over)` when valid, then resets all state. This mirrors the tree DnD idiom (`ContainmentTree.svelte` — `elementFromPoint` + `data-drop-key`, threshold-gated), minus autoscroll.

- [ ] **Step 1: Write failing unit tests** (`column-dnd.test.ts`): stub `document.elementFromPoint` with `vi.spyOn`; fake elements with `setAttribute('data-col-drop', '2')` and a `closest` that returns themselves. Cases: below-threshold move keeps `from === null`; drag 0 over 2 (no refs) → `valid === true`, drop calls `onDrop(0, 2)`; a definition where column 2 refs column 1 and dragging 1 past 2 → `valid === false`, no `onDrop`; pointerup always resets.

- [ ] **Step 2: Run to verify failure**, then **implement** `column-dnd.svelte.ts`:

```ts
import { moveColumn } from './columns';
import type { TableDefinition } from '$lib/api/types';

const DRAG_THRESHOLD_PX = 4;

/** Pointer-driven column reorder shared by the settings list and the grid
 * header. Same idiom as the tree's drag controller: threshold-gated
 * pointerdown, hit-testing via document.elementFromPoint + closest(attr)
 * (works across both hosts' DOM without per-target dragover handlers), and
 * the move validated with the PURE moveColumn before the drop is offered —
 * a forward-ref-violating drop shows as invalid instead of throwing late. */
export function createColumnDrag(opts: {
	attr: string;
	getDefinition: () => TableDefinition | undefined;
	onDrop: (from: number, to: number) => void;
}): ColumnDragState {
	let from = $state<number | null>(null);
	let over = $state<number | null>(null);
	let valid = $state(false);
	let armed: { index: number; x: number; y: number } | null = null;

	function reset(): void {
		from = null;
		over = null;
		valid = false;
		armed = null;
	}

	return {
		get from() { return from; },
		get over() { return over; },
		get valid() { return valid; },
		onPointerDown(e: PointerEvent, index: number): void {
			if (e.button !== 0) return;
			armed = { index, x: e.clientX, y: e.clientY };
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		},
		onPointerMove(e: PointerEvent): void {
			if (!armed) return;
			if (from === null) {
				if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) < DRAG_THRESHOLD_PX) return;
				from = armed.index;
			}
			const hit = document
				.elementFromPoint(e.clientX, e.clientY)
				?.closest(`[${opts.attr}]`) as HTMLElement | null;
			const t = hit ? Number(hit.getAttribute(opts.attr)) : NaN;
			over = Number.isInteger(t) ? t : null;
			const defn = opts.getDefinition();
			if (over === null || from === over || !defn) {
				valid = false;
				return;
			}
			try {
				moveColumn(defn, from, over);
				valid = true;
			} catch {
				valid = false;
			}
		},
		onPointerUp(): void {
			if (from !== null && over !== null && valid && from !== over) opts.onDrop(from, over);
			reset();
		}
	};
}
```

(Export the `ColumnDragState` interface. If `$state` in a plain returned object trips svelte-check, switch to a class with `$state` fields — same public shape.)

- [ ] **Step 3: Wire into ColumnManager**

- Each column card root div gets `data-col-drop={i}` and drop-target feedback `class:ring-1={drag.over === i && drag.from !== null} class:ring-primary={drag.valid} class:ring-destructive={drag.over === i && drag.from !== null && !drag.valid} class:opacity-50={drag.from === i}`.
- A grip at the row start (before the index badge):

```svelte
	<span
		role="button"
		tabindex="-1"
		data-testid="drag-column-{i}"
		aria-label="Drag to reorder"
		title="Drag to reorder"
		class="shrink-0 cursor-grab touch-none select-none text-muted-foreground/50"
		onpointerdown={(e) => drag.onPointerDown(e, i)}
		onpointermove={(e) => drag.onPointerMove(e)}
		onpointerup={(e) => drag.onPointerUp(e)}
		onpointercancel={(e) => drag.onPointerUp(e)}
	>⠿</span>
```

- Controller:

```ts
	const drag = createColumnDrag({
		attr: 'data-col-drop',
		getDefinition: () => defn,
		onDrop: (fromIdx, toIdx) => {
			const current = defn;
			if (!current) return;
			tryApply(() => {
				const next = moveColumn(current, fromIdx, toIdx);
				remapTableSortForMove(tabId, fromIdx, toIdx);
				return next;
			});
		}
	});
```

Hide the grip in focus mode (`{#if focusIndex === null}`), keep the ↑/↓ buttons (accessibility fallback).

- [ ] **Step 4: Wire into TableGrid header**

- Header cell div gets `data-col-hdr-drop={v.i}` plus the same feedback classes; pointer handlers on the header cell itself, gated so buttons/handles keep working:

```ts
	function onHeaderPointerDown(e: PointerEvent, index: number): void {
		const t = e.target as HTMLElement;
		if (t.closest('button, [role="separator"]')) return; // sort/edit/resize own these
		hdrDrag.onPointerDown(e, index);
	}
```

- Controller with the drop applying through the store (imports already present):

```ts
	const hdrDrag = createColumnDrag({
		attr: 'data-col-hdr-drop',
		getDefinition: () => getTableDraft(tabId)?.definition,
		onDrop: (fromIdx, toIdx) => {
			const draft = getTableDraft(tabId);
			if (!draft) return;
			try {
				const next = moveColumn(draft.definition, fromIdx, toIdx);
				remapTableSortForMove(tabId, fromIdx, toIdx);
				updateTableDefinition(tabId, next);
			} catch {
				/* forward-ref move: the hover highlight already showed invalid */
			}
		}
	});
```

(import `moveColumn` and `remapTableSortForMove`.)

- [ ] **Step 5: Component tests** — ColumnManager: pointer-simulate a drag of column 2's grip onto column 0's card (stub `document.elementFromPoint` to return the target card) and assert the definition order changed and each column kept its own inline definition (extend `ColumnManager.reorder.test.ts`, which already asserts pairing). TableGrid: drag header 1 onto header 0 → `updateTableDefinition` called with swapped columns; clicking (no move past threshold) still sorts.

- [ ] **Step 6: Run tests → PASS. Commit.**

```bash
git add -A && git commit -m "feat(frontend): drag-to-reorder columns from the grid header and settings"
```

---

### Task 11: Final verification sweep

**Files:** none new.

- [ ] **Step 1: Full backend suite + linters**

```bash
pixi run test-core
pixi run lint-core && pixi run lint-backend
```

Expected: all pass (ruff, mypy, pyright all green).

- [ ] **Step 2: Full frontend suite + svelte-check + repo tidy**

```bash
pixi run -e frontend bash -c 'cd frontend && npm test -- --run'
pixi run -e frontend bash -c 'cd frontend && npm run check'
pixi run tidy
```

Expected: 0 failures, 0 svelte-check errors; commit any formatting deltas.

- [ ] **Step 3: E2E smoke (best effort)**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'
```

The table e2e opens settings via `table-settings-button` (unchanged testid). If e2e fails for infrastructure reasons (ports, missing browsers), record the failure output and move on — unit/component coverage above is the gate.

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A && git commit -m "chore: post-implementation tidy" # only if there are changes
```

Do NOT merge into `main` and do NOT touch `feature/navigation-property-step` — the branch is handed back for review (superpowers:finishing-a-development-branch).

---

## Design decisions (recorded)

1. **Hidden = presentation-only.** Columns are index-addressed throughout the evaluator (`ColumnRef.index`, expand-slot arithmetic), so hidden columns must keep evaluating; filtering happens at the grid and the export route only. Sorting by a hidden column keeps working.
2. **`step_index` lives on `ColumnRef`,** not on the consuming column: it modifies what the *reference* resolves to. For an `expand` navigation ref, chains are filtered to those projecting to the row's expanded element — the only row-correct semantics without retaining chains in row keys. A nav ref with `step_index` is multi-binding.
3. **PathCard collapse moves to the store** because component-local `$state` dies on remount (auto-wrap restructures, dialog reopen, index-keyed editor reuse). Default: collapsed in embedded (table-settings) drafts, expanded in standalone tabs.
4. **Variable-height rows use estimated-height virtualization** (unloaded rows = 1 line); scroll can shift slightly as sparse rows stream in — accepted tradeoff, standard for sparse caches.
5. **Header "+" appends then opens focused settings** — the new column needs configuration anyway, and this reuses one dialog rather than inventing an inline header editor.
6. **Known overlap with the navigation session:** the other branch adds a property-step kind (extra `chainColumns` entries — our `navMaxStepIndex` picks that up automatically on merge) and renames the nav-column `step` label in the same editors. Expect small, mechanical merge conflicts in `NavigationColumnEditor.svelte`/`PropertyColumnEditor.svelte` (we replace their source rows with `ColumnSourceEditor`) and `PathCard.svelte` (collapse wiring vs. new step rows).
