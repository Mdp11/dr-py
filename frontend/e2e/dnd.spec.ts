import { test, expect, type Locator, type Page, type Request } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

const ALPHA = 'dnd-block-alpha';
const BETA = 'dnd-block-beta';

type Folder = { name: string; folders: Folder[]; elements: string[] };

async function bootstrap(page: Page): Promise<void> {
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
			{ id: ALPHA, type_name: 'Block', properties: { name: 'Alpha', mass: 1.0 }, rev: 0 },
			{ id: BETA, type_name: 'Block', properties: { name: 'Beta', mass: 2.0 }, rev: 0 }
		],
		relationships: []
	};

	await page.getByRole('button', { name: 'Load model...' }).click();
	const modelDialog = page.getByRole('dialog', { name: /load model/i });
	await modelDialog.locator('input[type="file"]').setInputFiles({
		name: 'dnd-spec.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify(model))
	});
	await modelDialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(modelDialog).toBeHidden();
}

/** Load a view: "Grouped" holds Alpha, "Target" is empty. */
async function loadView(page: Page): Promise<void> {
	const view = {
		name: 'Operational',
		folders: [
			{ name: 'Grouped', folders: [], elements: [ALPHA] },
			{ name: 'Target', folders: [], elements: [] }
		]
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
	await expect(
		page.getByRole('tree', { name: /containment tree/i }).getByText('Grouped')
	).toBeVisible();
}

function row(page: Page, text: string): Locator {
	return page.getByRole('treeitem').filter({ hasText: text }).first();
}

/**
 * Drive the pointer-events drag-and-drop the app actually uses. The tree no
 * longer relies on native HTML5 DnD (which failed to initiate in some Chromium
 * setups); it tracks pointer events and hit-tests drop targets via
 * elementFromPoint. Real mouse input generates those pointer events, so — unlike
 * the old synthetic DragEvent approach — this exercises the genuine gesture path
 * (press → cross threshold → move → release) end to end.
 */
async function pointerDragDrop(
	page: Page,
	source: Locator,
	target: Locator,
	{ waitForTarget = false }: { waitForTarget?: boolean } = {}
): Promise<void> {
	const s = await source.boundingBox();
	if (!s) throw new Error('drag source has no bounding box');
	const sx = s.x + Math.min(40, s.width / 2);
	const sy = s.y + s.height / 2;
	await page.mouse.move(sx, sy);
	await page.mouse.down();
	// Move past the drag threshold; this is what starts the drag and reveals the
	// "move to top level" dropzone.
	await page.mouse.move(sx, sy + 12, { steps: 4 });

	if (waitForTarget) await expect(target).toBeVisible();
	const t = await target.boundingBox();
	if (!t) throw new Error('drop target has no bounding box');
	const tx = t.x + t.width / 2;
	const ty = t.y + t.height / 2;
	await page.mouse.move(tx, ty, { steps: 12 });
	await page.mouse.move(tx, ty); // settle so elementFromPoint resolves the target
	await page.mouse.up();
}

function viewPut(page: Page): Promise<Request> {
	return page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/view/snapshot'));
}

function findFolder(folders: Folder[], name: string): Folder | undefined {
	return folders.find((f) => f.name === name);
}

test.beforeEach(async ({ page }) => {
	test.setTimeout(120_000);
	await bootstrap(page);
	await loadView(page);
});

test('drag an element into a folder places it there', async ({ page }) => {
	const put = viewPut(page);
	await pointerDragDrop(page, row(page, 'Beta'), row(page, 'Target'));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Target')!.elements).toContain(BETA);
});

test('drag a placed element to the view root unplaces it', async ({ page }) => {
	const put = viewPut(page);
	await pointerDragDrop(
		page,
		row(page, 'Alpha'),
		page.getByRole('button', { name: 'Move to top level' }),
		{ waitForTarget: true }
	);
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Grouped')!.elements).not.toContain(ALPHA);
});

test('drag a folder onto another folder reparents it', async ({ page }) => {
	const put = viewPut(page);
	await pointerDragDrop(page, row(page, 'Grouped'), row(page, 'Target'));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Grouped')).toBeUndefined();
	expect(findFolder(findFolder(body.folders, 'Target')!.folders, 'Grouped')).toBeDefined();
});

test('multi-selected elements all move on a single drag', async ({ page }) => {
	const tree = page.getByRole('tree', { name: /containment tree/i });
	await tree.getByText('Alpha').click({ modifiers: ['ControlOrMeta'] });
	await tree.getByText('Beta').click({ modifiers: ['ControlOrMeta'] });

	const put = viewPut(page);
	await pointerDragDrop(page, row(page, 'Beta'), row(page, 'Target'));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	const target = findFolder(body.folders, 'Target')!;
	expect(target.elements).toEqual(expect.arrayContaining([ALPHA, BETA]));
});
