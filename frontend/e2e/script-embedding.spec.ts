/**
 * E2E: embedded script evaluation (Code execution M2/M3 frontend, Task F8) —
 * script table columns (`ScriptColumn`) and navigation script steps
 * (`NavScriptStep`) driven against the real WASM sandbox, following the
 * conventions of `snippet-flow.spec.ts` (setCode / runner-availability skip)
 * and `table.spec.ts` (nav -> "Open as table", the ColumnManager's "Table
 * settings" dialog, its documented selectors).
 *
 * Fixture facts relied on below (examples/smart-city.model.json — see
 * table.spec.ts for the fuller writeup of the same fixture):
 *  - 12 SoftwareSystem elements, named "SoftwareSystem-001".."SoftwareSystem-012"
 *    (string `name` property), so picking SoftwareSystem as a nav's sole start
 *    type (no relationship hop needed) is runnable and yields exactly 12 rows
 *    when opened as a table.
 *  - Every SoftwareSystem has real outgoing SystemContainsComponent
 *    relationships (9, in the one spot-checked above) — `el.out()` inside a
 *    script step therefore always expands to a non-empty next frontier,
 *    without depending on any specific target id.
 *
 * Both tests reload the smart-city fixture via `loadFiles` first: the e2e
 * suite shares one backend project across every spec file (`workers: 1`), so
 * a spec that happens to run earlier can leave the model/artifacts in an
 * unrelated state (same rationale as table.spec.ts / snippet-flow.spec.ts).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.metamodel.yaml');
const MODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.model.json');
const VIEW_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.view.json');

// One row (SoftwareSystem-006) deterministically divides by zero; the other
// 11 return their own name — no reliance on call order/memoization (the
// embedded-session memo is documented as unsound across identical bindings
// under module-level mutable state — see core/script/README.md's "Evaluation
// sessions" section — so this snippet avoids that caveat entirely by keying
// the error off fixture data instead of a call counter).
const SCRIPT_COLUMN_CODE =
	'def value(els): return els[0].name if not els[0].name.endswith("-006") else 1 / 0\n';
const INLINE_COLUMN_CODE = 'def value(els): return 2\n';
const STEP_HAPPY_CODE = 'def step(el): return [r["target_id"] for r in el.out()]\n';
const STEP_RAISE_CODE = 'def step(el): return 1 / 0\n';

/** Focus a CM6 editor scoped under `container` and replace its content.
 * `keyboard.insertText` avoids CM auto-indent mangling multi-line python
 * (see snippet-flow.spec.ts) — moot here since every snippet below is a
 * one-line `def f(...): return ...` body, but kept for parity/safety. */
async function setCode(page: Page, container: Locator, code: string): Promise<void> {
	await container.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Delete');
	await page.keyboard.insertText(code);
}

async function buildSoftwareSystemNav(page: Page, tabpanel: Locator): Promise<void> {
	await page.getByRole('button', { name: 'New navigation' }).click();
	const dock = tabpanel.getByTestId('results-dock');
	await expect(dock).toContainText('Pick what to start from');
	await tabpanel.getByText('any element', { exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(tabpanel.getByText('SoftwareSystem', { exact: true })).toBeVisible();
	await expect(dock).toContainText(/✓ \d+ chains/, { timeout: 15_000 });
}

/** Text + error-ness of a script/value cell for every rendered `table-row`,
 * at DOM position `colIndex` within each row's flex children (there is no
 * per-cell testid — TableGrid renders one `<div>` child per visible column,
 * in `visibleCols` order; see TableGrid.svelte). */
async function readColumnCells(
	rows: Locator,
	colIndex: number
): Promise<{ text: string; isError: boolean }[]> {
	const count = await rows.count();
	const out: { text: string; isError: boolean }[] = [];
	for (let i = 0; i < count; i++) {
		const cell = rows.nth(i).locator('> div').nth(colIndex);
		const isError = (await cell.locator('[data-testid="error-cell"]').count()) > 0;
		out.push({ text: ((await cell.textContent()) ?? '').trim(), isError });
	}
	return out;
}

test('script column: ref snippet computes values + error cell + sorts; inline script column computes a constant', async ({
	page
}) => {
	test.setTimeout(120_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	// --- 0. Save a code_snippet artifact defining value() (F1/M1 flow, as
	// snippet-flow.spec.ts does), so the script column below can reference it
	// by ref. entry_points are SERVER-DERIVED from the AST on save — defining
	// value(...) alone is enough to unlock the `value` entry regardless of the
	// tab's entry dropdown (left at its default "script").
	const snippetName = `e2e-script-col-${Date.now()}`;
	await page.getByRole('button', { name: 'New snippet' }).click();
	const snippetEditor = page.locator('[data-testid="snippet-editor"]');
	await expect(snippetEditor.locator('.cm-content')).toBeVisible();
	const snippetTab = page.getByRole('tabpanel');
	await snippetTab.locator('input.w-56').first().fill(snippetName);
	await setCode(page, snippetEditor, SCRIPT_COLUMN_CODE);
	await page.getByTestId('snippet-save').click();
	await expect(page.getByTestId('snippet-save')).toHaveText('Save', { timeout: 10_000 });

	// --- 1. A minimal nav (SoftwareSystem start, no hop — see file header) ->
	// "Open as table" (identical entry point to table.spec.ts). -------------
	await buildSoftwareSystemNav(page, page.getByRole('tabpanel'));
	const navTabpanel = page.getByRole('tabpanel');
	const openAsTableButton = navTabpanel.getByRole('button', { name: 'Open as table' });
	await expect(openAsTableButton).toBeEnabled();
	await openAsTableButton.click();

	const tabpanel = page.getByRole('tabpanel');
	const grid = tabpanel.getByTestId('table-grid');
	await expect(grid).toBeVisible({ timeout: 15_000 });
	const header = tabpanel.getByTestId('table-header');
	const rows = tabpanel.getByTestId('table-row');
	await expect(rows).toHaveCount(12, { timeout: 15_000 });

	// --- 2. Add a script column (behind the ⚙ Settings popup, same add-then-
	// edit shape as add-property-column) and bind it to the saved snippet. ---
	// Header cells carry `role="columnheader"`; that's DELIBERATELY used
	// instead of raw `> div` counting because the header row also renders a
	// trailing non-column "Add a column" trigger (`header-add-column`) as its
	// own `> div` sibling after the `{#each visibleCols}` loop (TableGrid.svelte)
	// — counting all `> div`s would be off by one against row cells (which have
	// no such trailing entry).
	const columnHeaders = header.getByRole('columnheader');
	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Table settings' });
	await expect(settings).toBeVisible();
	const columnCountBefore = await columnHeaders.count();
	await settings.getByTestId('add-script-column').click();
	await expect(columnHeaders).toHaveCount(columnCountBefore + 1, { timeout: 10_000 });
	const scriptColIndex = columnCountBefore; // 0-indexed; appended at the end

	const firstEditor = settings.getByTestId('script-column-editor').nth(0);
	await firstEditor.getByTestId('snippet-ref-select').selectOption({ label: snippetName });

	// Wait for every row's script cell to settle (value or error-cell) before
	// reading them — the column re-evaluates async against the live model.
	await expect
		.poll(
			async () => {
				const cells = await readColumnCells(rows, scriptColIndex);
				return cells.filter((c) => c.text.length > 0 || c.isError).length;
			},
			{ timeout: 30_000 }
		)
		.toBeGreaterThanOrEqual(12);

	const cells = await readColumnCells(rows, scriptColIndex);

	// Runner-availability guard (mirrors snippet-flow.spec.ts's `runAndAwait`):
	// a missing/unfetched WASM guest binary makes every embedded call fail
	// with "script runner unavailable" (core/script/embed.py), which the
	// table renders as an error-cell carrying that exact message — degrade
	// gracefully to a skip rather than failing on infra the harness lacks.
	if (cells.some((c) => c.text.toLowerCase().includes('unavailable'))) {
		test.skip(true, 'snippet runner not booted (guest binary not fetched)');
	}

	// --- 3. Assert: computed values AND at least one error cell. -----------
	const errorCells = cells.filter((c) => c.isError);
	const valueCells = cells.filter((c) => !c.isError);
	expect(errorCells.length, JSON.stringify(cells)).toBeGreaterThanOrEqual(1);
	expect(valueCells.length, JSON.stringify(cells)).toBeGreaterThanOrEqual(1);
	expect(valueCells.some((c) => /^SoftwareSystem-\d{3}$/.test(c.text))).toBeTruthy();

	// --- 4. Sort by the script column: no crash, and the row order changes
	// (the errored row's position moves relative to its neighbors either way,
	// even though the rest were already near-sorted by fixture insertion
	// order — see the CODE comment above). The Table settings dialog is
	// portaled over the grid (table.spec.ts's "close the popup so its overlay
	// stops intercepting clicks on the grid" note applies here too) — close it
	// first, the grid keeps rendering/re-evaluating live underneath. ---------
	await page.keyboard.press('Escape');
	await expect(settings).toBeHidden();
	const before = cells.map((c) => c.text);
	const sortButton = columnHeaders.nth(scriptColIndex).getByRole('button', { name: /^Sort by/ });
	await sortButton.click();
	await expect(sortButton).toContainText(/[▲▼]/, { timeout: 10_000 });
	let after = (await readColumnCells(rows, scriptColIndex)).map((c) => c.text);
	if (JSON.stringify(after) === JSON.stringify(before)) {
		await sortButton.click(); // toggle direction — still shouldn't match
		after = (await readColumnCells(rows, scriptColIndex)).map((c) => c.text);
	}
	expect(after).not.toEqual(before);
	await expect(rows).toHaveCount(12); // grid survived the sort intact

	// --- 5. A second, INLINE script column: trivial constant snippet. ------
	await tabpanel.getByTestId('table-settings-button').click();
	await expect(settings).toBeVisible();
	await settings.getByTestId('add-script-column').click();
	const columnEditors = settings.getByTestId('script-column-editor');
	await expect(columnEditors).toHaveCount(2);
	const inlineColIndex = scriptColIndex + 1;
	await expect(columnHeaders).toHaveCount(columnCountBefore + 2, { timeout: 10_000 });
	const secondEditor = columnEditors.nth(1);
	await secondEditor.getByTestId('snippet-mode-inline').click();
	await setCode(page, secondEditor, INLINE_COLUMN_CODE);

	await expect
		.poll(
			async () => {
				const inlineCells = await readColumnCells(rows, inlineColIndex);
				return inlineCells.filter((c) => c.text === '2').length;
			},
			{ timeout: 20_000 }
		)
		.toBeGreaterThanOrEqual(12);
});

test('script step: el.out() renders real chains; a raising step surfaces nav-warnings', async ({
	page
}) => {
	test.setTimeout(120_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	const tabpanel = page.getByRole('tabpanel');
	await buildSoftwareSystemNav(page, tabpanel);

	// --- 1. Add a script step, switch it to inline, and give it a snippet
	// that follows every REAL outgoing relationship (el.out()) rather than a
	// hardcoded id — robust against exactly which components each system
	// happens to contain. -----------------------------------------------
	await tabpanel.getByTestId('add-script-step').click();
	const stepRow = tabpanel.getByTestId('script-step');
	await expect(stepRow).toHaveCount(1);
	await stepRow.getByTestId('snippet-mode-inline').click();
	await setCode(page, stepRow, STEP_HAPPY_CODE);

	const status = tabpanel.getByTestId('results-status');
	await expect(status).toContainText(/✓ \d+ chains/, { timeout: 30_000 });

	// Runner-availability guard: with no runner booted, EVERY step() call
	// fails with "...script runner unavailable" (core/script/embed.py),
	// which `_hop_script` (core/navigation/evaluate.py) turns into a
	// deduped "script step failed: script runner unavailable" warning —
	// surfacing here even for this non-raising snippet.
	const navWarnings = tabpanel.getByTestId('nav-warnings');
	if (await navWarnings.isVisible().catch(() => false)) {
		const title = (await navWarnings.getAttribute('title')) ?? '';
		test.skip(
			title.includes('unavailable'),
			'snippet runner not booted (guest binary not fetched)'
		);
	}

	// --- 2. Happy path: real neighbor ids -> non-empty chains, no warnings. -
	await expect(navWarnings).toBeHidden();
	const statusText = (await status.textContent()) ?? '';
	const total = Number(statusText.match(/✓ (\d+) chains/)?.[1] ?? '0');
	expect(total).toBeGreaterThan(0); // every SoftwareSystem has real out-edges

	// --- 3. Make the step raise instead: a warning chip appears. -----------
	await setCode(page, stepRow, STEP_RAISE_CODE);
	await expect(navWarnings).toBeVisible({ timeout: 30_000 });
	await expect(navWarnings).toContainText(/script warning/);
});
