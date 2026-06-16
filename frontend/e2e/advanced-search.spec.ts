import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

// A model with one Block named "Alpha".
const MODEL = JSON.stringify({
	elements: [{ id: 'e1', type_name: 'Block', properties: { name: 'Alpha' }, rev: 1 }],
	relationships: []
});

/** Load the example metamodel + the one-Block model via the single load dialog. */
async function loadExample(page: Page): Promise<void> {
	// The backend session persists across page loads; loading a metamodel/model
	// over leftover unsaved changes pops a window.confirm that Playwright would
	// auto-dismiss. Accept it so the load dialog can open.
	page.on('dialog', (dialog) => void dialog.accept());
	await page.goto('/');

	await loadFiles(page, {
		metamodel: METAMODEL_PATH,
		model: { name: 'model.json', mimeType: 'application/json', buffer: Buffer.from(MODEL) }
	});
}

test('advanced search finds an element and opens its detail', async ({ page }) => {
	test.setTimeout(90_000);
	await loadExample(page);

	// Open advanced search.
	await page.getByTestId('advanced-search-button').click();
	const dialog = page.getByRole('dialog', { name: /advanced search/i });
	await expect(dialog).toBeVisible();

	// Add a Name / ID criterion (defaults to name + contains) and type "Alpha".
	await dialog.getByRole('button', { name: 'Add criterion' }).click();
	await page.getByRole('menuitem', { name: 'Name / ID' }).click();
	await dialog.locator('input[placeholder="value"]').fill('Alpha');

	// Search.
	await dialog.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(dialog).toBeHidden();

	// Panel shows the result; clicking it opens the Inspector detail.
	const panel = page.getByTestId('results-panel');
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: /Alpha/ }).click();

	const inspector = page.getByTestId('inspector');
	await expect(inspector.locator('input[type="text"]').first()).toHaveValue('Alpha');

	// Close the panel.
	await panel.getByRole('button', { name: 'Close results' }).click();
	await expect(panel).toBeHidden();
});

test('property criterion gates operator on selection and filters ops by datatype', async ({
	page
}) => {
	test.setTimeout(90_000);
	await loadExample(page);

	await page.getByTestId('advanced-search-button').click();
	const dialog = page.getByRole('dialog', { name: /advanced search/i });
	await expect(dialog).toBeVisible();

	// Add a Property criterion.
	await dialog.getByRole('button', { name: 'Add criterion' }).click();
	await page.getByRole('menuitem', { name: 'Property', exact: true }).click();

	// Before a property is chosen, the operator select is disabled.
	const opSelect = dialog.locator('select');
	await expect(opSelect).toBeDisabled();

	// Open the property picker and choose `priority` (an integer property).
	await dialog.getByText('property…').click();
	await page.getByPlaceholder('Filter properties…').fill('priority');
	await page.getByRole('button', { name: /priority/ }).click();

	// Operator is now enabled and offers numeric ops (gt) but not text ops (contains).
	await expect(opSelect).toBeEnabled();
	await expect(opSelect.locator('option[value="gt"]')).toHaveCount(1);
	await expect(opSelect.locator('option[value="contains"]')).toHaveCount(0);
});
