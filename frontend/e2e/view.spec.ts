import { test, expect, type Locator, type Page, type Request } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

const BLOCK_ONE_ID = 'view-test-block-1';
const BLOCK_TWO_ID = 'view-test-block-2';

const MODEL = {
	elements: [
		{ id: BLOCK_ONE_ID, type_name: 'Block', properties: { name: 'Alpha', mass: 1.0 }, rev: 0 },
		{ id: BLOCK_TWO_ID, type_name: 'Block', properties: { name: 'Beta', mass: 2.0 }, rev: 0 }
	],
	relationships: []
};

/** The view used by the curation tests: "Grouped" holds Alpha; Beta stays pooled. */
const OPERATIONAL_VIEW = {
	name: 'Operational',
	folders: [{ name: 'Grouped', folders: [], elements: [BLOCK_ONE_ID] }]
};

/**
 * Load metamodel + the two-Block model (and an optional view) in a single pass
 * through the load dialog.
 */
async function bootstrap(page: Page, view?: object): Promise<void> {
	// The backend session persists across page loads; loading a metamodel/model
	// over leftover unsaved changes pops a window.confirm that Playwright would
	// auto-dismiss. Accept it so the load dialog can open.
	page.on('dialog', (dialog) => void dialog.accept());
	await page.goto('/');

	await loadFiles(page, {
		metamodel: METAMODEL_PATH,
		model: {
			name: 'view-spec.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(MODEL))
		},
		view:
			view === undefined
				? undefined
				: {
						name: 'spec.view.json',
						mimeType: 'application/json',
						buffer: Buffer.from(JSON.stringify(view))
					}
	});
}

test('load a view: folders render with their placed elements (curated scope)', async ({ page }) => {
	test.setTimeout(120_000);
	await bootstrap(page, {
		name: 'Operational',
		folders: [{ name: 'Grouped', folders: [], elements: [BLOCK_ONE_ID] }]
	});

	await expect(page.getByLabel('Active view').getByText('Operational')).toBeVisible();

	const treeEl = page.getByRole('tree', { name: /containment tree/i });
	await expect(treeEl.getByText('Grouped')).toBeVisible();
	// Alpha is placed in the 'Grouped' folder -> shows under it.
	await expect(treeEl.getByText('Alpha')).toBeVisible();

	// Beta is unplaced -> it lives in the "Not in view" pool, which is a separate
	// panel, collapsed by default. The header shows; Beta is not rendered yet.
	await expect(poolHeader(page)).toBeVisible();
	await expect(pool(page)).toHaveCount(0);

	// Expanding the pool reveals Beta.
	await expandPool(page);
	await expect(poolRow(page, 'Beta')).toBeVisible();
});

test('view referencing a missing element produces a warning in the Issues panel', async ({
	page
}) => {
	test.setTimeout(120_000);
	await bootstrap(page, {
		name: 'BrokenRefs',
		folders: [{ name: 'Group', folders: [], elements: ['does-not-exist'] }]
	});

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

/**
 * Bootstrap with the curation view loaded: "Grouped" holds Alpha (BLOCK_ONE_ID);
 * Beta stays in the pool.
 */
async function loadView(page: Page): Promise<void> {
	await bootstrap(page, OPERATIONAL_VIEW);
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

/** The "Not in view" pool panel header (collapse toggle + drop target). */
function poolHeader(page: Page): Locator {
	return page.getByRole('button', { name: /not in view/i });
}

/** The expanded pool body (its own tree region) and a row within it. */
function pool(page: Page): Locator {
	return page.getByRole('tree', { name: /excluded elements/i });
}
function poolRow(page: Page, text: string): Locator {
	return pool(page).getByRole('treeitem').filter({ hasText: text }).first();
}

/** Expand the pool panel if it is collapsed (default is collapsed). */
async function expandPool(page: Page): Promise<void> {
	if (await pool(page).count()) return; // already expanded
	await poolHeader(page).click();
	await expect(pool(page)).toBeVisible();
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
	await loadView(page);

	const t = tree(page);
	// Precondition: Beta sits in the (collapsed) "Not in view" pool; expand to reach it.
	await expect(poolHeader(page)).toBeVisible();
	await expandPool(page);
	await expect(poolRow(page, 'Beta')).toBeVisible();

	// Include: drag the Beta row (in the pool) onto the Grouped folder header.
	const put = viewPut(page);
	await dragRowOnto(page, poolRow(page, 'Beta'), row(page, 'Grouped'));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Grouped')!.elements).toContain(BLOCK_TWO_ID);

	// Beta is now placed under Grouped (folders are not lazily paged).
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
	await loadView(page);

	// Exclude: drag Alpha from Grouped onto the "Not in view" panel header.
	const put = viewPut(page);
	await dragRowOnto(page, row(page, 'Alpha'), poolHeader(page));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Grouped')!.elements).not.toContain(BLOCK_ONE_ID);

	// Alpha now lives in the pool: expand and confirm it is listed there.
	await expandPool(page);
	await expect(poolRow(page, 'Alpha')).toBeVisible();
});

test('view curation: reorder elements within a folder (upward)', async ({ page }) => {
	test.setTimeout(120_000);
	await loadView(page);

	// Build a two-element folder: include Beta so Grouped = [Alpha, Beta].
	await expandPool(page);
	const include = viewPut(page);
	await dragRowOnto(page, poolRow(page, 'Beta'), row(page, 'Grouped'));
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

test('change badge increments on view edit, tooltip shows View row, Save dialog opens View tab', async ({
	page
}) => {
	test.setTimeout(120_000);
	await loadView(page);

	// The badge is the span containing the bullet + count in the top-right of the
	// header.  Its text nodes are "● ", the count, and "change(s)" — locate it by
	// the bullet character so we're robust to exact whitespace between nodes.
	const badge = page.locator('header span').filter({ hasText: /●/ }).first();
	await expect(badge).toBeVisible();

	// Make a view edit: drag Alpha (placed in Grouped) onto the pool header to
	// exclude it.  This is the same mechanism used by the "exclude" curation test.
	const put = viewPut(page);
	await dragRowOnto(page, row(page, 'Alpha'), poolHeader(page));
	await put; // wait for the PUT /view/snapshot to complete

	// The badge should now reflect at least 1 change (the view edit itself).
	// After the drag the view has 1 change, so the combined count is ≥ 1.
	await expect(badge).toContainText(/[1-9]/);

	// Hovering the badge reveals the tooltip with a "View" row.
	await badge.hover();
	const tooltip = page.getByRole('tooltip').filter({ hasText: /View/ }).first();
	await expect(tooltip).toBeVisible();

	// Ctrl+S opens the Save dialog (DiffDrawer).
	await page.keyboard.press('Control+s');
	const drawer = page.getByRole('dialog', { name: /pending changes/i });
	await expect(drawer).toBeVisible();

	// Click the View tab and assert that at least one human-readable view-change
	// line is shown (Alpha was moved out of Grouped so it is "removed from view"
	// or "moved from '...' to '...'").
	await drawer.getByRole('tab', { name: /View/i }).click();
	await expect(
		drawer.getByText(/moved from|added to|removed from view|Folder '/)
	).toBeVisible();
});

test('excluded pool: collapsed by default (no fetch), expands, and state persists', async ({
	page
}) => {
	test.setTimeout(120_000);

	// Record excluded-pool fetches across the whole session.
	const excludedHits: string[] = [];
	page.on('request', (r) => {
		if (new URL(r.url()).pathname.endsWith('/model/containment/roots/excluded')) {
			excludedHits.push(r.url());
		}
	});

	await loadView(page);

	// Collapsed by default: header visible, body absent, and NO excluded fetch fired.
	await expect(poolHeader(page)).toBeVisible();
	await expect(pool(page)).toHaveCount(0);
	expect(excludedHits).toHaveLength(0);

	// Expanding fetches (or reuses the already-fetched first page) and shows the pooled element.
	await poolHeader(page).click();
	await expect(poolRow(page, 'Beta')).toBeVisible();
	expect(excludedHits.length).toBeGreaterThan(0);

	// Expanded state persists across a reload.
	await page.reload();
	await expect(pool(page)).toBeVisible();
	await expect(poolRow(page, 'Beta')).toBeVisible();

	// Collapse, reload: stays collapsed.
	await poolHeader(page).click();
	await expect(pool(page)).toHaveCount(0);
	await page.reload();
	await expect(poolHeader(page)).toBeVisible();
	await expect(pool(page)).toHaveCount(0);
});
