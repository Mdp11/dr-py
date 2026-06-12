import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

const BLOCK_ONE_ID = 'view-test-block-1';
const BLOCK_TWO_ID = 'view-test-block-2';

async function bootstrap(page: import('@playwright/test').Page): Promise<void> {
	// The backend session persists across page loads; loading a metamodel/model
	// over leftover unsaved changes pops a window.confirm that Playwright would
	// auto-dismiss. Accept it so the load dialogs can open.
	page.on('dialog', (dialog) => void dialog.accept());
	await page.goto('/');

	await page.getByRole('button', { name: 'Load metamodel...' }).click();
	const mmDialog = page.getByRole('dialog', { name: /load metamodel/i });
	await mmDialog.locator('input[type="file"]').setInputFiles(METAMODEL_PATH);
	await mmDialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(mmDialog).toBeHidden();

	const model = {
		elements: [
			{
				id: BLOCK_ONE_ID,
				type_name: 'Block',
				properties: { name: 'Alpha', mass: 1.0 },
				rev: 0
			},
			{
				id: BLOCK_TWO_ID,
				type_name: 'Block',
				properties: { name: 'Beta', mass: 2.0 },
				rev: 0
			}
		],
		relationships: []
	};

	await page.getByRole('button', { name: 'Load model...' }).click();
	const modelDialog = page.getByRole('dialog', { name: /load model/i });
	await modelDialog.locator('input[type="file"]').setInputFiles({
		name: 'view-spec.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify(model))
	});
	await modelDialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(modelDialog).toBeHidden();
}

test('load a view: folders render, placed and unplaced elements appear', async ({ page }) => {
	test.setTimeout(120_000);
	await bootstrap(page);

	const view = {
		name: 'Operational',
		folders: [{ name: 'Grouped', folders: [], elements: [BLOCK_ONE_ID] }]
	};

	await page.getByRole('button', { name: 'Load view...' }).click();
	const dialog = page.getByRole('dialog', { name: /load view/i });
	await dialog.locator('input[type="file"]').setInputFiles({
		name: 'operational.view.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify(view))
	});
	await dialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(dialog).toBeHidden();

	await expect(page.getByLabel('Active view').getByText('Operational')).toBeVisible();

	const tree = page.getByRole('tree', { name: /containment tree/i });
	await expect(tree.getByText('Grouped')).toBeVisible();
	await expect(tree.getByText('Alpha')).toBeVisible();
	await expect(tree.getByText('Beta')).toBeVisible();
});

test('view referencing a missing element produces a warning in the Issues panel', async ({
	page
}) => {
	test.setTimeout(120_000);
	await bootstrap(page);

	const view = {
		name: 'BrokenRefs',
		folders: [{ name: 'Group', folders: [], elements: ['does-not-exist'] }]
	};

	await page.getByRole('button', { name: 'Load view...' }).click();
	const dialog = page.getByRole('dialog', { name: /load view/i });
	await dialog.locator('input[type="file"]').setInputFiles({
		name: 'broken.view.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify(view))
	});
	await dialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(dialog).toBeHidden();

	await page.getByRole('button', { name: 'Validate' }).click();
	await page.getByRole('tab', { name: 'Issues' }).click();
	await expect(page.getByText(/does-not-exist/).first()).toBeVisible();
});
