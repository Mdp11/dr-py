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

	// --- 5. Open the commit drawer and confirm the change is listed ----------
	// Spec B: "Save" was renamed to "Commit" (opens the DiffDrawer/commit panel).
	const commitButton = page.getByRole('button', { name: 'Commit', exact: true });
	await expect(commitButton).toBeVisible();
	await commitButton.click();

	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible();
	// Spec B: getStagedDiff tracks per-op reverts; a newly created element that is
	// also edited in the same session appears as "Modified" (the update op's revert
	// snapshot becomes the diff baseline), not "Added". Either status confirms the
	// change is staged — the important assertion is the ENGINE_NAME check below.
	await expect(drawer.getByText(/(?:added|modified) \(\d+\)/i)).toBeVisible();
	await expect(drawer.getByText(ENGINE_NAME).first()).toBeVisible();
});

test('Export button downloads the model as a .json file', async ({ page }) => {
	test.setTimeout(90_000);

	// Force the <a download> fallback path inside saveJsonToFile so the
	// download event fires without the native file-picker dialog.
	await page.addInitScript(() => {
		delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
	});

	await page.goto('/');

	// Spec B: the old DiffDrawer save-to-file flow (with "Export CR" checkbox) was
	// replaced.  "Commit" now persists changes server-side; the separate "Export"
	// button in the TopBar downloads the current model as JSON.
	await loadFiles(page, {
		metamodel: METAMODEL_PATH,
		model: {
			name: 'export-smoke.json',
			mimeType: 'application/json',
			buffer: Buffer.from('{"elements": [], "relationships": []}')
		}
	});

	// Collect downloads via listener (works for both the <a> fallback and the
	// File System Access API path, though we forced the fallback above).
	const downloads: Download[] = [];
	page.on('download', (d) => downloads.push(d));

	// Click the TopBar "Export" button — downloads the active model JSON.
	await page.getByRole('button', { name: 'Export', exact: true }).click();

	await expect.poll(() => downloads.length, { timeout: 10_000 }).toBe(1);

	// The downloaded file must be a plain .json (not a .cr.json).
	expect(downloads[0].suggestedFilename()).toMatch(/\.json$/);
	expect(downloads[0].suggestedFilename()).not.toMatch(/\.cr\.json$/);
});
