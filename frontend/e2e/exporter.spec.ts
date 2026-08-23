/**
 * E2E: exporter artifact — the add-table picker across every tab lifecycle
 * (`Export/ExporterTab.svelte`).
 *
 * The picker copies the chosen table's definition into a new `ExporterEntry`
 * at add time (`addExporterEntry` → `entryForTable`), and the draft's tab id
 * changes shape twice over the artifact's life: `exp:draft:N` while unsaved,
 * re-keyed to `exp:<realId>` when the staged create's commit mints a real id
 * (`bindTabToArtifact`), and minted directly as `exp:<realId>` on a sidebar
 * reopen. A key-mismatch bug in any of those hops makes the picker fail
 * SILENTLY (`addExporterEntry` no-ops when `_drafts.get(tabId)` misses), so
 * this spec adds a table in all three states:
 *
 *   1. on a fresh draft tab (never saved),
 *   2. right after Save + commit (the re-keyed tab), and
 *   3. on the artifact reopened from the sidebar Exporters section — which
 *      loads the COMMITTED payload, so the entry added in (2) but never saved
 *      must be gone before the third add lands at index 1.
 *
 * The empty-picker states (no tables at all / staged-only tables → disabled
 * input + explanatory hint) are covered by ExporterTab.test.ts instead: the
 * suite shares one backend project across spec files (`workers: 1`), so this
 * spec cannot assume a table-less library at any point.
 *
 * Selectors follow artifact-commit.spec.ts (the `[data-artifact-id]` +
 * `span.flex-1` sidebar-row pattern) and the tab's own `data-testid`s. Names
 * are unique per run: both artifacts are COMMITTED, so a fixed name would
 * clash with a rerun's uniqueness check against a reused backend.
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDefaultProject } from './helpers/auth';
import { commitStaged } from './helpers/commit';
import { expectLiveFeed } from './helpers/feed';
import { loadFiles } from './helpers/load';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.metamodel.yaml');
const MODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.model.json');
const VIEW_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.view.json');

test('add-table picker works on a draft, after the commit rebind, and on a sidebar reopen', async ({
	page
}) => {
	test.setTimeout(180_000);

	const tableName = `e2e-exporter-table-${Date.now()}`;
	const exporterName = `e2e-exporter-${Date.now()}`;

	// One handler for the whole test: accepts the load dialog's confirm and
	// answers the table Save as… `window.prompt` with the table's name.
	page.on('dialog', (dialog) => {
		if (dialog.type() === 'prompt') void dialog.accept(tableName);
		else void dialog.accept();
	});

	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expectLiveFeed(page, 60_000);

	// --- 1. A committed table for the picker to offer (staged creates are
	// temp-id-filtered out of it by design, so Save alone is not enough).
	await page.getByRole('button', { name: 'New table' }).click();
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByTestId('table-grid')).toBeVisible({ timeout: 15_000 });
	await tabpanel.getByRole('button', { name: /Save as/ }).click();
	await expect(
		page
			.locator('[data-artifact-id]')
			.filter({ has: page.locator('span.flex-1', { hasText: tableName }) })
	).toBeVisible({ timeout: 10_000 });
	await commitStaged(page);
	await page.getByRole('button', { name: `Close ${tableName}` }).click();

	// --- 2. Fresh draft exporter: name it uniquely, add the table.
	await page.getByRole('button', { name: 'New exporter' }).click();
	const expPanel = page.getByRole('tabpanel');
	const nameInput = expPanel.getByRole('textbox').first();
	await nameInput.fill(exporterName);
	const input = expPanel.getByTestId('add-table-input');
	await expect(input).toBeEnabled({ timeout: 15_000 });
	await input.fill(tableName);
	await expect(expPanel.getByRole('option', { name: tableName })).toBeVisible({ timeout: 10_000 });
	await input.press('Enter');
	await expect(expPanel.getByTestId('export-entry-0')).toBeVisible({ timeout: 10_000 });

	// --- 3. Save + commit (the tab is re-keyed from exp:draft:N to
	// exp:<realId>), then add again on the re-keyed tab.
	await expPanel.getByTestId('exporter-save').click();
	await commitStaged(page);
	const input2 = page.getByRole('tabpanel').getByTestId('add-table-input');
	await expect(input2).toBeEnabled({ timeout: 15_000 });
	await input2.fill(tableName);
	await expect(page.getByRole('tabpanel').getByRole('option', { name: tableName })).toBeVisible({
		timeout: 10_000
	});
	await input2.press('Enter');
	await expect(page.getByRole('tabpanel').getByTestId('export-entry-1')).toBeVisible({
		timeout: 10_000
	});

	// --- 4. Close and reopen from the sidebar. The reopen loads the COMMITTED
	// payload — one entry, since step 3's second add was never saved — so the
	// fresh add must land at index 1.
	await page.getByRole('button', { name: `Close ${exporterName}` }).click();
	const exporterItem = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: exporterName }) });
	await exporterItem.dblclick();
	const reopened = page.getByRole('tabpanel');
	const input3 = reopened.getByTestId('add-table-input');
	await expect(input3).toBeEnabled({ timeout: 15_000 });
	await expect(reopened.getByTestId('export-entry-0')).toBeVisible({ timeout: 10_000 });
	await expect(reopened.getByTestId('export-entry-1')).toHaveCount(0);
	await input3.fill(tableName);
	await expect(reopened.getByRole('option', { name: tableName })).toBeVisible({ timeout: 10_000 });
	await input3.press('Enter');
	await expect(reopened.getByTestId('export-entry-1')).toBeVisible({ timeout: 10_000 });
});
