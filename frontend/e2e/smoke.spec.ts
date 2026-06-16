import { test, expect, type Download } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

const EMPTY_MODEL = {
	name: 'empty.json',
	mimeType: 'application/json',
	buffer: Buffer.from('{"elements": [], "relationships": []}')
};

const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ENGINE_NAME = `smoke-engine-${RUN_ID}`;

// The backend keeps a single in-memory session across page loads, so a
// previous test's pending changes survive into this one. Loading a new
// metamodel/model then pops a window.confirm ("discards unsaved changes —
// continue?"), which Playwright auto-DISMISSES by default; accept it instead.
test.beforeEach(async ({ page }) => {
	page.on('dialog', (dialog) => void dialog.accept());
});

test('load metamodel + empty model -> create element -> see in diff', async ({ page }) => {
	test.setTimeout(90_000);

	await page.goto('/');

	// --- 1. Load the metamodel + an empty model via the single load dialog ---
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: EMPTY_MODEL });

	// --- 3. Create a Block element via the Tree "New element" popover --------
	await page.getByRole('button', { name: 'New element' }).click();
	await page.getByRole('button', { name: 'Block', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Block' })).toBeVisible();

	// --- 4. Edit its `name` --------------------------------------------------
	const inspector = page.getByTestId('inspector');
	const nameInput = inspector.locator('input[type="text"]').first();
	await nameInput.fill(ENGINE_NAME);
	await nameInput.blur();

	// --- 5. Open the diff drawer and confirm the change is listed ------------
	const saveButton = page.getByRole('button', { name: 'Save', exact: true });
	await expect(saveButton).toBeVisible();
	await saveButton.click();

	const drawer = page.getByRole('dialog', { name: /pending changes/i });
	await expect(drawer).toBeVisible();
	await expect(drawer.getByText(/added \(\d+\)/i)).toBeVisible();
	await expect(drawer.getByText(ENGINE_NAME).first()).toBeVisible();
});

test('Export CR checkbox produces a second .cr.json download', async ({ page }) => {
	test.setTimeout(90_000);

	// Force the <a download> fallback path inside saveJsonToFile.
	await page.addInitScript(() => {
		delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
	});

	await page.goto('/');

	// Same setup as the first smoke test.
	await loadFiles(page, {
		metamodel: METAMODEL_PATH,
		model: {
			name: 'cr-smoke.json',
			mimeType: 'application/json',
			buffer: Buffer.from('{"elements": [], "relationships": []}')
		}
	});

	// Create an element so there's something to save.
	await page.getByRole('button', { name: 'New element' }).click();
	await page.getByRole('button', { name: 'Block', exact: true }).click();
	const inspector = page.getByTestId('inspector');
	const nameInput = inspector.locator('input[type="text"]').first();
	await nameInput.fill(`cr-block-${RUN_ID}`);
	await nameInput.blur();

	// Open the drawer.
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /pending changes/i });
	await expect(drawer).toBeVisible();

	// Check the checkbox.
	const exportCrCheckbox = drawer.getByLabel('Export CR');
	await exportCrCheckbox.check();

	// Two downloads expected: the model JSON first, then the CR. Parallel
	// `waitForEvent('download')` calls both resolve to the *same* first
	// event, so collect every download via a `page.on` listener instead.
	const downloads: Download[] = [];
	page.on('download', (d) => downloads.push(d));

	await drawer.getByRole('button', { name: /save \(\d+\)/i }).click();

	await expect.poll(() => downloads.length, { timeout: 10_000 }).toBe(2);

	expect(downloads[0].suggestedFilename()).toMatch(/\.json$/);
	expect(downloads[0].suggestedFilename()).not.toMatch(/\.cr\.json$/);
	expect(downloads[1].suggestedFilename()).toMatch(/^\d{8}T\d{6}_.+\.cr\.json$/);
});
