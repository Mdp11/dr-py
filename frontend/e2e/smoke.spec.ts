import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_METAMODEL = readFileSync(
	join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml'),
	'utf-8'
);

// Unique names per run so the test stays robust against a stale data-dir on
// `reuseExistingServer`. The pixi-managed e2e data dir is normally wiped
// between runs (see .gitignore), but be defensive.
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const MM_NAME = `smoke_mm_${RUN_ID}`;
const MODEL_NAME = `smoke_${RUN_ID}`;
const ENGINE_NAME = `smoke-engine-${RUN_ID}`;

test('load -> edit -> save -> reload persists', async ({ page }) => {
	test.setTimeout(90_000);

	await page.goto('/');

	// --- 1. Upload metamodel via the TopBar ----------------------------------
	await page.getByRole('button', { name: /metamodel/i }).first().click();
	await page.getByRole('menuitem').filter({ hasText: 'Upload new...' }).click();

	const uploadDialog = page.getByRole('dialog', { name: /upload metamodel/i });
	await expect(uploadDialog).toBeVisible();
	await uploadDialog.getByLabel('Name').fill(MM_NAME);
	await uploadDialog.getByLabel(/body/i).fill(EXAMPLE_METAMODEL);
	await uploadDialog.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadDialog).toBeHidden();

	// TopBar label should reflect the uploaded metamodel.
	await expect(page.getByRole('button', { name: new RegExp(MM_NAME) })).toBeVisible();

	// --- 2. Create model -----------------------------------------------------
	await page.getByRole('button', { name: /^model$/i }).first().click();
	await page.getByRole('menuitem').filter({ hasText: 'Create new model...' }).click();

	const createDialog = page.getByRole('dialog', { name: /create model/i });
	await expect(createDialog).toBeVisible();
	await createDialog.getByLabel('Name').fill(MODEL_NAME);
	// Metamodel select gets pre-filled from the topbar selection; just submit.
	await createDialog.getByRole('button', { name: 'Create' }).click();
	await expect(createDialog).toBeHidden();

	// TopBar should now show the model name.
	await expect(page.getByRole('button', { name: new RegExp(MODEL_NAME) })).toBeVisible();

	// --- 3 & 4. Create an element via the "+ New Block" TypeFilter button ----
	await page.getByRole('button', { name: 'New Block' }).click();

	// The new element is auto-selected; its detail view shows the temp id and
	// an editable `name` property form (inherited from NamedElement).
	await expect(page.getByRole('heading', { name: 'Block' })).toBeVisible();

	// --- 5. Edit its `name` to ENGINE_NAME -----------------------------------
	// Scope to the Inspector aside so we don't accidentally type into the
	// sidebar Search input. The Block's first string property (inherited from
	// NamedElement) is `name`.
	const inspector = page.getByTestId('inspector');
	const nameInput = inspector.locator('input[type="text"]').first();
	await nameInput.fill(ENGINE_NAME);
	await nameInput.blur();

	// --- 6. Save button shows the change count ------------------------------
	const saveButton = page.getByRole('button', { name: /save \(\d+\)/i });
	await expect(saveButton).toBeVisible();

	// --- 7. Open the Diff Drawer ---------------------------------------------
	await saveButton.click();
	const drawer = page.getByRole('dialog', { name: /pending changes/i });
	await expect(drawer).toBeVisible();

	// --- 8. Verify the drawer shows the Added section with our element name --
	await expect(drawer.getByText(/added \(\d+\)/i)).toBeVisible();
	await expect(drawer.getByText(ENGINE_NAME).first()).toBeVisible();

	// --- 9 & 10. Click the Save button inside the drawer ---------------------
	await drawer.getByRole('button', { name: /save \(\d+\)/i }).click();
	await expect(drawer).toBeHidden();

	// Change count should reset (Save button reverts to plain "Save").
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

	// --- 11. Reload the page -------------------------------------------------
	await page.reload();

	// --- 12. Re-select metamodel + model -------------------------------------
	await page.getByRole('button', { name: /metamodel/i }).first().click();
	await page.getByRole('menuitem').filter({ hasText: MM_NAME }).click();
	await expect(page.getByRole('button', { name: new RegExp(MM_NAME) })).toBeVisible();

	await page.getByRole('button', { name: /^model$/i }).first().click();
	await page.getByRole('menuitem').filter({ hasText: MODEL_NAME }).click();
	await expect(page.getByRole('button', { name: new RegExp(MODEL_NAME) })).toBeVisible();

	// --- 13. The element should be in the tree -------------------------------
	await expect(page.getByText(ENGINE_NAME).first()).toBeVisible();
});
