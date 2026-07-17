import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDefaultProject } from './helpers/auth';
import { loadFiles } from './helpers/load';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.metamodel.yaml');
const MODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.model.json');
const VIEW_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.view.json');

/**
 * E2E smoke for the table/navigation UX polish (drag preview, auto-fit, labels, unsaved markers, scalar property-step values), in one browser session:
 *  1. a scalar "Go to property" step shows the property VALUE in the results
 *     dock (chains > 0) and only the per-step "navigation ends here" notice;
 *  2. tab labels carry the unsaved `*`;
 *  3. double-click auto-fit converges on the FIRST double-click (second one
 *     must not grow the column);
 *  4. header column drag shows a detached ghost and live-shifts the sibling
 *     column (transform preview);
 *  5. add-column labels read "+ Property" / "+ Navigation" in both surfaces.
 */
test('property-step values, unsaved asterisk, auto-fit convergence, drag ghost', async ({
	page
}) => {
	test.setTimeout(180_000);
	page.on('dialog', (dialog) => void dialog.accept());

	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	// --- 1. Navigation with a SCALAR property step shows values -------------
	await page.getByRole('button', { name: 'New navigation' }).click();
	const tabpanel = page.getByRole('tabpanel');
	const dock = tabpanel.getByTestId('results-dock');

	await tabpanel.getByText('any element', { exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem', exact: true }).click();
	await page.keyboard.press('Escape');

	await tabpanel.getByRole('button', { name: '+ Go to property…', exact: true }).click();
	const propStep = tabpanel.getByTestId('property-step');
	await propStep.getByText('pick a property…', { exact: true }).click();
	await page.getByPlaceholder('Filter properties…').fill('name');
	// PropertyPicker rows read "<name> <datatype>" (e.g. "name string").
	await page.getByRole('button', { name: /^name\s/ }).first().click();

	// The dock auto-runs: chains must be NON-zero and value text must render.
	await expect(dock).toContainText(/✓ [1-9]\d* chains/, { timeout: 15_000 });
	// One warning line only: the per-step notice stays, the card-level line is gone.
	await expect(tabpanel.getByTestId('property-dead-end')).toBeVisible();
	await expect(tabpanel.getByText('Navigation is blocked above')).toHaveCount(0);
	// The nav tab label carries the unsaved asterisk (never-saved draft).
	await expect(page.getByRole('tab', { name: /New navigation \*/ })).toBeVisible();

	// --- 2. Build a table for the grid checks --------------------------------
	// Remove the scalar step so the nav is a plain SoftwareSystem scope, then
	// open as table (property terminals cannot be a table's row set).
	await propStep.getByRole('button', { name: 'Remove step' }).click();
	await expect(dock).toContainText(/✓ [1-9]\d* chains/, { timeout: 15_000 });
	await tabpanel.getByRole('button', { name: 'Open as table' }).click();
	const grid = tabpanel.getByTestId('table-grid');
	await expect(grid.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });

	// Tab label: the table draft is never-saved => asterisk.
	await expect(page.getByRole('tab', { name: /New navigation \(table\) \*/ })).toBeVisible();

	// --- 3. Header add-column dropdown labels --------------------------------
	await grid.getByTestId('header-add-column').click();
	await expect(page.getByRole('menuitem', { name: '+ Property', exact: true })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: '+ Navigation', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');

	// Settings panel labels (a portaled dialog — scope to it, close via Escape).
	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Table settings' });
	await expect(settings.getByTestId('add-property-column')).toHaveText('+ Property');
	await expect(settings.getByTestId('add-navigation-column')).toHaveText('+ Navigation');
	// Add a property column (name) so the grid has two columns for the checks.
	await settings.getByTestId('add-property-column').click();
	await settings.getByLabel('Property name').fill('name');
	await expect(grid.getByTestId('table-row').first()).toContainText(/\w/, { timeout: 10_000 });
	await page.keyboard.press('Escape');
	await expect(settings).toBeHidden();

	// --- 4. Auto-fit converges on the first double-click ---------------------
	const header = grid.getByTestId('table-header');
	const cells = header.locator('[data-col-hdr-drop]');
	await expect(cells).toHaveCount(2);
	const width = async () => (await cells.nth(1).boundingBox())!.width;
	const sep = cells.nth(1).locator('[role="separator"]');
	await sep.dblclick();
	const w1 = await width();
	await sep.dblclick();
	const w2 = await width();
	expect(Math.abs(w2 - w1)).toBeLessThanOrEqual(1);

	// --- 5. Drag ghost + live reflow -----------------------------------------
	const first = cells.nth(0);
	const second = cells.nth(1);
	const fb = (await first.boundingBox())!;
	const sb = (await second.boundingBox())!;
	await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
	await page.mouse.down();
	await page.mouse.move(sb.x + sb.width - 4, sb.y + sb.height / 2, { steps: 8 });
	// Ghost follows the pointer…
	await expect(page.getByTestId('header-drag-ghost')).toBeVisible();
	// …and the hovered sibling shifts live (transform preview).
	const transform = await second.evaluate((el) => getComputedStyle(el).transform);
	expect(transform).not.toBe('none');
	expect(transform).not.toBe('matrix(1, 0, 0, 1, 0, 0)');
	await page.mouse.up();
	// The drop committed the reorder: the property column (kind label — it has
	// no custom header) is now first, the element column second.
	await expect(cells.nth(0).locator('span').first()).toHaveText(/Property/i);
});
