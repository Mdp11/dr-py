import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ENGINE_NAME = `smoke-engine-${RUN_ID}`;

test('load metamodel + empty model -> create element -> see in diff', async ({ page }) => {
	test.setTimeout(90_000);

	await page.goto('/');

	// --- 1. Load metamodel via file picker -----------------------------------
	await page.getByRole('button', { name: 'Load metamodel...' }).click();
	const mmDialog = page.getByRole('dialog', { name: /load metamodel/i });
	await expect(mmDialog).toBeVisible();
	await mmDialog.locator('input[type="file"]').setInputFiles(METAMODEL_PATH);
	await mmDialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(mmDialog).toBeHidden();

	// --- 2. Load an empty model file ----------------------------------------
	await page.getByRole('button', { name: 'Load model...' }).click();
	const modelDialog = page.getByRole('dialog', { name: /load model/i });
	await expect(modelDialog).toBeVisible();
	await modelDialog
		.locator('input[type="file"]')
		.setInputFiles({
			name: 'empty.json',
			mimeType: 'application/json',
			buffer: Buffer.from('{"elements": [], "relationships": []}')
		});
	await modelDialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(modelDialog).toBeHidden();

	// --- 3. Create a Block element via the TypeFilter "New Block" button -----
	await page.getByRole('button', { name: 'New Block' }).click();
	await expect(page.getByRole('heading', { name: 'Block' })).toBeVisible();

	// --- 4. Edit its `name` --------------------------------------------------
	const inspector = page.getByTestId('inspector');
	const nameInput = inspector.locator('input[type="text"]').first();
	await nameInput.fill(ENGINE_NAME);
	await nameInput.blur();

	// --- 5. Open the diff drawer and confirm the change is listed ------------
	const saveButton = page.getByRole('button', { name: /save \(\d+\)/i });
	await expect(saveButton).toBeVisible();
	await saveButton.click();

	const drawer = page.getByRole('dialog', { name: /pending changes/i });
	await expect(drawer).toBeVisible();
	await expect(drawer.getByText(/added \(\d+\)/i)).toBeVisible();
	await expect(drawer.getByText(ENGINE_NAME).first()).toBeVisible();
});
