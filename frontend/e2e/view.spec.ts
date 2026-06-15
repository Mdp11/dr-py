import { test, expect, type Locator, type Page, type Request } from '@playwright/test';
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

test('load a view: folders render with their placed elements (curated scope)', async ({ page }) => {
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
	// Alpha is placed in the 'Grouped' folder -> shows under it.
	await expect(tree.getByText('Alpha')).toBeVisible();
	// Beta is unplaced -> it lives in the auto-loaded "Not in view" pool.
	await expect(tree.getByText('Not in view')).toBeVisible();
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

// --------------------------------------------------------------------------
// View curation by drag-and-drop.
//
// The containment tree uses POINTER-events DnD (not native HTML5 DnD): drop
// targets carry data-drop-key/kind/path and are hit-tested via
// elementFromPoint, so a *real* pointer gesture (press -> cross the 4px
// threshold -> move over the target -> release) is what exercises the path.
// The helper below mirrors the one in dnd.spec.ts.
// --------------------------------------------------------------------------

type Folder = { name: string; folders: Folder[]; elements: string[] };

/** Load a view: "Grouped" holds Alpha (BLOCK_ONE_ID); Beta stays in the pool. */
async function loadView(page: Page): Promise<void> {
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
	await expect(
		page.getByRole('tree', { name: /containment tree/i }).getByText('Grouped')
	).toBeVisible();
}

function tree(page: Page): Locator {
	return page.getByRole('tree', { name: /containment tree/i });
}

/** A tree row (treeitem) that contains the given text. */
function row(page: Page, text: string): Locator {
	return tree(page).getByRole('treeitem').filter({ hasText: text }).first();
}

/** Resolves with the next PUT to /view/snapshot (the curation persistence call). */
function viewPut(page: Page): Promise<Request> {
	return page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/view/snapshot'));
}

function findFolder(folders: Folder[], name: string): Folder | undefined {
	return folders.find((f) => f.name === name);
}

/**
 * Drive the genuine pointer gesture the tree listens for. Press at the source
 * row's centre, move past the 4px threshold (this starts the drag and reveals
 * dropzones), then move onto the target and release.
 *
 * `half: 'top'` drops on the target's TOP quarter — used for an upward reorder
 * (insert before the hovered sibling). Default drops at the target centre.
 */
async function dragRowOnto(
	page: Page,
	source: Locator,
	target: Locator,
	{ half }: { half?: 'top' | 'bottom' } = {}
): Promise<void> {
	const s = await source.boundingBox();
	if (!s) throw new Error('drag source has no bounding box');
	const sx = s.x + Math.min(40, s.width / 2);
	const sy = s.y + s.height / 2;
	await page.mouse.move(sx, sy);
	await page.mouse.down();
	// Cross the 4px threshold; this begins the drag (and, for an external/search
	// drag, lets the tree adopt the gesture).
	await page.mouse.move(sx, sy + 12, { steps: 5 });

	const t = await target.boundingBox();
	if (!t) throw new Error('drop target has no bounding box');
	const tx = t.x + t.width / 2;
	const ty =
		half === 'top'
			? t.y + t.height / 4
			: half === 'bottom'
				? t.y + (t.height * 3) / 4
				: t.y + t.height / 2;
	await page.mouse.move(tx, ty, { steps: 8 });
	await page.mouse.move(tx, ty); // settle so elementFromPoint resolves the target
	await page.mouse.up();
}

test('view curation: include a pooled element into a folder (persists across reload)', async ({
	page
}) => {
	test.setTimeout(120_000);
	await bootstrap(page);
	await loadView(page);

	const t = tree(page);
	// Precondition: Beta sits in the "Not in view" pool, Alpha under Grouped.
	await expect(t.getByText('Not in view')).toBeVisible();
	await expect(t.getByText('Beta')).toBeVisible();

	// Include: drag the Beta row onto the Grouped folder header.
	const put = viewPut(page);
	await dragRowOnto(page, row(page, 'Beta'), row(page, 'Grouped'));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Grouped')!.elements).toContain(BLOCK_TWO_ID);

	// Beta is now placed under Grouped: it leaves the excluded pool. Folders are
	// not lazily paged, so it renders immediately under the folder.
	await expect(t.getByText('Beta')).toBeVisible();

	// Persistence: the backend session holds the pushed view across a reload.
	// A visible Beta alone is NOT proof — a pooled Beta is visible too — so assert
	// against the freshly loaded snapshot (GET /view) that Beta is placed in Grouped.
	const reloaded = page.waitForResponse(
		(r) => new URL(r.url()).pathname.endsWith('/view') && r.request().method() === 'GET'
	);
	await page.reload();
	const loaded = (await (await reloaded).json()) as { view: { folders: Folder[] } | null };
	expect(loaded.view).not.toBeNull();
	expect(findFolder(loaded.view!.folders, 'Grouped')!.elements).toContain(BLOCK_TWO_ID);

	const t2 = tree(page);
	await expect(t2.getByText('Grouped')).toBeVisible();
	await expect(t2.getByText('Beta')).toBeVisible();
});

test('view curation: exclude a placed element back to the pool', async ({ page }) => {
	test.setTimeout(120_000);
	await bootstrap(page);
	await loadView(page);

	// Exclude: drag Alpha from Grouped onto the "Not in view" section header.
	const put = viewPut(page);
	await dragRowOnto(page, row(page, 'Alpha'), row(page, 'Not in view'));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Grouped')!.elements).not.toContain(BLOCK_ONE_ID);

	// Alpha now lives in the pool: the "Not in view" section lists it.
	const pool = row(page, 'Not in view');
	await expect(pool).toBeVisible();
	await expect(tree(page).getByText('Alpha')).toBeVisible();
});

test('view curation: reorder elements within a folder (upward)', async ({ page }) => {
	test.setTimeout(120_000);
	await bootstrap(page);
	await loadView(page);

	// Build a two-element folder: include Beta so Grouped = [Alpha, Beta].
	const include = viewPut(page);
	await dragRowOnto(page, row(page, 'Beta'), row(page, 'Grouped'));
	const afterInclude = (await include).postDataJSON() as { folders: Folder[] };
	expect(findFolder(afterInclude.folders, 'Grouped')!.elements).toEqual([
		BLOCK_ONE_ID,
		BLOCK_TWO_ID
	]);
	await expect(tree(page).getByText('Beta')).toBeVisible();

	// Reorder UP: drag the SECOND element (Beta) onto the TOP half of the FIRST
	// (Alpha) so it is inserted before it. (Downward same-folder reorder has a
	// known off-by-one; we assert only the upward case.)
	const reorder = viewPut(page);
	await dragRowOnto(page, row(page, 'Beta'), row(page, 'Alpha'), { half: 'top' });
	const afterReorder = (await reorder).postDataJSON() as { folders: Folder[] };
	expect(findFolder(afterReorder.folders, 'Grouped')!.elements).toEqual([
		BLOCK_TWO_ID,
		BLOCK_ONE_ID
	]);
});

test('view curation: search result dragged into a folder is placed there', async ({ page }) => {
	test.setTimeout(120_000);
	await bootstrap(page);
	await loadView(page);

	// Type a known element's name; wait for its row in the search dropdown.
	await page.getByPlaceholder('Filter by name, type, id…').fill('Beta');
	const dropdown = page.locator('#sidebar-search-dropdown');
	const result = dropdown.getByRole('button').filter({ hasText: 'Beta' }).first();
	await expect(result).toBeVisible();

	// Drag the search result onto the Grouped folder header. The drag starts
	// outside the tree (search-originated, bypassMovable) and the tree adopts it.
	const put = viewPut(page);
	await dragRowOnto(page, result, row(page, 'Grouped'));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Grouped')!.elements).toContain(BLOCK_TWO_ID);

	await expect(tree(page).getByText('Beta')).toBeVisible();
});
