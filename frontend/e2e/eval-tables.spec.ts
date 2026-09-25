/**
 * Tables served by the engine over the working copy, in the real sandbox
 * against the real backend, with shadow on: a table reads a staged
 * navigation before any commit, an open table sorted by name re-sorts after
 * a staged rename in the side panel (and Discard restores the order), a
 * script column falls back to the server behind the `table-fallback` marker,
 * and staging a script step onto a table's navigation column flips an open
 * table to the same marker without a reload — unstaging flips it back.
 *
 * Fixture facts (examples/smart-city.model.json — see table.spec.ts and
 * script-embedding.spec.ts for the fuller writeup of the same fixture): 12
 * SoftwareSystem elements, "SoftwareSystem-001".."SoftwareSystem-012" (a
 * string `name`), so a nav whose sole start type is SoftwareSystem (no hop)
 * yields exactly 12 rows opened as a table, and ascending name order is
 * exactly numeric fixture order (same zero-padded width throughout).
 */

import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { expectLiveFeed } from './helpers/feed';
import { changeBadge } from './helpers/commit';
import { expectReplicaReady } from './helpers/replica';
import { headRev, peer, projectIdByName } from './helpers/api-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, '..', '..', 'examples');

const INLINE_COLUMN_CODE = 'def value(els): return 2\n';
const STEP_CODE = 'def step(el): return [r.destination().id for r in el.outgoing()]\n';
const SCRIPT_MARKER = 'Reads committed state: this table runs a script';

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let projectId: string;
/** A committed, script-free navigation a table's navigation column can ref. */
let refNav: { id: string; name: string };

const scope = (type: string) => ({
	kind: 'path',
	schema_version: 3,
	start: { kind: 'scope', types: [type], criteria: [] },
	steps: [],
	exclude_visited: true
});

/** One `create_artifact` committed by the peer; resolves to its real id. */
async function peerCreateNavigation(name: string, payload: object): Promise<string> {
	const commit = await api.post(`projects/${projectId}/commits`, {
		data: {
			base_rev: await headRev(api, projectId),
			ops: [
				{
					kind: 'create_artifact',
					temp_id: 'tmp_nav',
					artifact_kind: 'navigation',
					name,
					payload
				}
			],
			message: `peer navigation ${name}`,
			lock_tokens: [],
			ack_errors: true
		}
	});
	expect(commit.ok(), await commit.text()).toBeTruthy();
	return ((await commit.json()) as { id_map: Record<string, string> }).id_map.tmp_nav;
}

test.beforeAll(async ({ browser, playwright }) => {
	test.setTimeout(120_000);
	// Earlier specs leave the shared project holding other content.
	const page = await browser.newPage();
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, {
		metamodel: join(EXAMPLES, 'smart-city.metamodel.yaml'),
		model: join(EXAMPLES, 'smart-city.model.json'),
		view: join(EXAMPLES, 'smart-city.view.json')
	});
	await page.close();

	api = await peer(playwright);
	projectId = await projectIdByName(api, 'Smart City');
	const name = `eval-tbl-nav-${Date.now()}`;
	refNav = { id: await peerCreateNavigation(name, scope('SoftwareSystem')), name };
});

test.afterAll(async () => {
	await api?.dispose();
});

async function openReady(page: Page): Promise<void> {
	await openDefaultProject(page);
	await expectLiveFeed(page);
	await expectReplicaReady(page);
}

async function stagedChangeCount(page: Page): Promise<number> {
	if ((await changeBadge(page).count()) === 0) return 0;
	const match = ((await changeBadge(page).textContent()) ?? '').match(/(\d+)/);
	return match ? Number(match[1]) : 0;
}

/** Focus a CM6 editor scoped under `container` and replace its content (as
 * script-embedding.spec.ts's `setCode`). */
async function setCode(page: Page, container: Locator, code: string): Promise<void> {
	await container.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Delete');
	await page.keyboard.insertText(code);
}

/** A minimal runnable nav: SoftwareSystem start, no hop (see file header). */
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

/** Text of every rendered `table-row`'s cell at DOM position `colIndex`
 * (as script-embedding.spec.ts's `readColumnCells`, text only). */
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

/** Every rendered `table-row`'s value at DOM position `colIndex`, for an
 * EDITABLE property column: `ValueCell` renders a text `<input>` for such a
 * cell (see `Cell/ValueCell.svelte`), whose value lives in the input's
 * `value`, not the div's `textContent` (empty for an `<input>`). */
async function readEditableColumnValues(rows: Locator, colIndex: number): Promise<string[]> {
	const count = await rows.count();
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		out.push(await rows.nth(i).locator('> div').nth(colIndex).locator('input').inputValue());
	}
	return out;
}

/** Build a fresh table over a plain SoftwareSystem nav ("Open as table"),
 * with 12 rows and one Start element column (index 0). */
async function openSoftwareSystemTable(page: Page): Promise<Locator> {
	const navTabpanel = page.getByRole('tabpanel');
	await buildSoftwareSystemNav(page, navTabpanel);
	const openAsTableButton = navTabpanel.getByRole('button', { name: 'Open as table' });
	await expect(openAsTableButton).toBeEnabled();
	await openAsTableButton.click();
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByTestId('table-grid')).toBeVisible({ timeout: 15_000 });
	await expect(tabpanel.getByTestId('table-row')).toHaveCount(12, { timeout: 15_000 });
	return tabpanel;
}

test('a table over a staged navigation shows its rows before any commit', async ({ page }) => {
	test.setTimeout(120_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openReady(page);

	// A fresh navigation, staged (Save) but never committed.
	const navTabpanel = page.getByRole('tabpanel');
	await buildSoftwareSystemNav(page, navTabpanel);
	const navName = `e2e-staged-nav-${Date.now()}`;
	await navTabpanel.getByTestId('nav-name').fill(navName);
	await navTabpanel.getByRole('button', { name: /^Save( \*)?$/ }).click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);

	// "Open as table" refs the staged (temp-id) navigation by its row source.
	const openAsTableButton = navTabpanel.getByRole('button', { name: 'Open as table' });
	await expect(openAsTableButton).toBeEnabled();
	await openAsTableButton.click();

	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByTestId('table-grid')).toBeVisible({ timeout: 15_000 });
	await expect(tabpanel.getByTestId('table-row')).toHaveCount(12, { timeout: 15_000 });
	await expect(tabpanel.getByTestId('table-fallback')).toHaveCount(0);

	// Clean up: discard the staged create (footer Undo only pops MODEL ops,
	// not artifact ones) so later tests see a clean project.
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const discardAll = drawer.getByRole('button', { name: 'Discard all' });
	await expect(discardAll).toBeEnabled({ timeout: 10_000 });
	await discardAll.click();
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
});

test('an open table sorted by name re-sorts after a staged rename in the side panel; Discard restores the order', async ({
	page
}) => {
	test.setTimeout(120_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openReady(page);

	const tabpanel = await openSoftwareSystemTable(page);
	const rows = tabpanel.getByTestId('table-row');

	// A `name` property column, appended after the Start element column.
	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Columns' });
	await expect(settings).toBeVisible();
	const columnCards = settings.locator('[data-testid^="column-header-band-"]');
	const nameColIndex = await columnCards.count(); // appended at the end
	await settings.getByTestId('add-property-column').click();
	await expect(columnCards).toHaveCount(nameColIndex + 1, { timeout: 10_000 });
	await settings.getByLabel('Property name').fill('name');
	await settings.getByTestId('settings-save').click();
	await expect(settings).toBeHidden();
	await expect(rows.first()).toContainText(/\w/, { timeout: 10_000 });

	// Sort ascending by it, through the Sorting dialog (T-8's flow).
	await tabpanel.getByTestId('table-sort-button').click();
	const sortDialog = page.getByTestId('column-sort-dialog');
	await expect(sortDialog).toBeVisible();
	await sortDialog.getByTestId(`sort-toggle-${nameColIndex}`).click();
	await expect(sortDialog.getByTestId(`sort-dir-${nameColIndex}`)).toContainText('▲', {
		timeout: 10_000
	});
	await sortDialog.getByTestId('sort-done').click();
	await expect(sortDialog).toBeHidden();

	const cellTexts = (): Promise<string[]> => readEditableColumnValues(rows, nameColIndex);
	const before = await cellTexts();
	expect(before).toHaveLength(12);

	// Rename the last (highest-named) row's element via the Inspector — the
	// same checkout path table.spec.ts's cell edit uses (click the row's
	// Start-column ElementCell button to select it, then edit the Inspector's
	// name field). A name starting "AAA" sorts before every fixture name.
	await rows.last().locator('button').first().click();
	const inspector = page.getByTestId('inspector');
	await expect(inspector).toBeVisible({ timeout: 10_000 });
	const nameInput = inspector.locator('input[type="text"]').first();
	const renamed = `AAA-e2e-${Date.now()}`;
	await nameInput.fill(renamed);
	await nameInput.blur();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);

	// Without a reload, the renamed row moves to the front.
	await expect
		.poll(cellTexts, { timeout: 15_000 })
		.toEqual([renamed, ...before.slice(0, before.length - 1)]);

	// Discard restores the original order, again without a reload.
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const discardAll = drawer.getByRole('button', { name: 'Discard all' });
	await expect(discardAll).toBeEnabled({ timeout: 10_000 });
	await discardAll.click();
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
	await expect.poll(cellTexts, { timeout: 15_000 }).toEqual(before);
});

test('a table with a script column shows the fallback marker and its server-served cells', async ({
	page
}) => {
	test.setTimeout(120_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openReady(page);

	const tabpanel = await openSoftwareSystemTable(page);
	const rows = tabpanel.getByTestId('table-row');
	const scriptColIndex = 1; // after the Start element column (index 0)
	const fallback = tabpanel.getByTestId('table-fallback');
	await expect(fallback).toHaveCount(0);

	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Columns' });
	await expect(settings).toBeVisible();
	await settings.getByTestId('add-script-column').click();
	const editor = settings.getByTestId('script-column-editor').nth(0);
	await editor.getByTestId('snippet-mode-inline').click();
	await setCode(page, editor.getByTestId('snippet-editor'), INLINE_COLUMN_CODE);
	await settings.getByTestId('settings-save').click();
	await expect(settings).toBeHidden();

	// The table reaches a script: it falls back to the server, on committed
	// state, and says so.
	await expect(fallback).toHaveText(SCRIPT_MARKER, { timeout: 30_000 });

	// Its cells settle from pending to the computed constant.
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
	// Runner-availability guard (as script-embedding.spec.ts): degrade to a
	// skip rather than failing on infra the harness lacks.
	if (cells.some((c) => c.text.toLowerCase().includes('unavailable'))) {
		test.skip(true, 'snippet runner not booted (guest binary not fetched)');
	}
	expect(cells.every((c) => !c.isError && c.text === '2')).toBeTruthy();
});

test("staging a script step onto a table's navigation column flips it to the server marker; unstaging flips it back", async ({
	page
}) => {
	test.setTimeout(180_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openReady(page);

	const tableName = `e2e-tbl-${Date.now()}`;
	const navTabpanel = page.getByRole('tabpanel');
	await buildSoftwareSystemNav(page, navTabpanel);
	// Named only to title the table tab below — this scratch nav is never
	// saved (the table stays a transient, unsaved draft throughout).
	await navTabpanel.getByTestId('nav-name').fill(tableName);
	const openAsTableButton = navTabpanel.getByRole('button', { name: 'Open as table' });
	await expect(openAsTableButton).toBeEnabled();
	await openAsTableButton.click();

	const tableTabName = `${tableName} (table)`;
	// A bare role query, re-resolving to whichever tab is active — reused
	// below across tab switches rather than reassigned.
	const tabpanel = page.getByRole('tabpanel');
	const rows = tabpanel.getByTestId('table-row');
	const fallback = tabpanel.getByTestId('table-fallback');
	await expect(tabpanel.getByTestId('table-grid')).toBeVisible({ timeout: 15_000 });
	await expect(rows).toHaveCount(12, { timeout: 15_000 });

	// A navigation column refs the committed, script-free navigation. Hidden:
	// the referenced nav isn't row-rooted, so its collapse cell lists all 12
	// SoftwareSystems on every row — visible, that inflates row height enough
	// for virtualization to cull a row from the viewport, which is beside
	// this test's point (script reach, not this column's own values).
	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Columns' });
	await expect(settings).toBeVisible();
	await settings.getByTestId('add-navigation-column').click();
	await settings.getByTestId('toggle-hidden-1').click();
	const navEditor = settings.getByTestId('nav-column-editor').nth(0);
	await navEditor.getByLabel('Saved navigation for column').selectOption({ label: refNav.name });
	await settings.getByTestId('settings-save').click();
	await expect(settings).toBeHidden();
	await expect(fallback).toHaveCount(0);
	await expect(rows).toHaveCount(12, { timeout: 15_000 });

	// Elsewhere, stage a script step onto the referenced navigation.
	const navRow = page.locator(`[data-artifact-id="${refNav.id}"]`);
	await expect(navRow).toBeVisible({ timeout: 15_000 });
	await navRow.dblclick();
	const refTabpanel = page.getByRole('tabpanel');
	await expect(refTabpanel.getByTestId('results-dock')).toBeVisible({ timeout: 10_000 });
	await refTabpanel.getByTestId('add-script-step').click();
	const stepRow = refTabpanel.getByTestId('script-step');
	await expect(stepRow).toHaveCount(1);
	await stepRow.getByTestId('snippet-mode-inline').click();
	await setCode(page, stepRow, STEP_CODE);
	await refTabpanel.getByRole('button', { name: /^Save( \*)?$/ }).click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 15_000 }).toBe(1);

	// Back at the table, without a reload, it flips to the server marker.
	await page.getByRole('tab', { name: tableTabName }).click();
	await expect(fallback).toHaveText(SCRIPT_MARKER, { timeout: 30_000 });
	await expect(rows).toHaveCount(12, { timeout: 15_000 });

	// Unstage the script step (discard the one staged artifact update — the
	// footer Undo only pops MODEL ops): the table flips back.
	await page.getByRole('tab', { name: refNav.name }).click();
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const discardAll = drawer.getByRole('button', { name: 'Discard all' });
	await expect(discardAll).toBeEnabled({ timeout: 10_000 });
	await discardAll.click();
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);

	await page.getByRole('tab', { name: tableTabName }).click();
	await expect(fallback).toHaveCount(0, { timeout: 30_000 });
	await expect(rows).toHaveCount(12, { timeout: 15_000 });
});
