import { test, expect, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { changeBadge, commitStaged } from './helpers/commit';

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
	await openDefaultProject(page);

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
	// Folders default collapsed: Alpha is not shown until 'Grouped' is expanded.
	await expect(treeEl.getByText('Alpha')).toHaveCount(0);
	await expandFolder(page, 'Grouped');
	// Alpha is placed in the 'Grouped' folder -> shows under it once expanded.
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
	// Issues is a CLOSABLE workspace tab now, not a fixed one: it does not exist
	// until the top bar's Issues control opens it.
	await page.getByRole('button', { name: 'Issues', exact: true }).click();
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

/** Expand a folder row by name (folders default COLLAPSED). No-op if already open. */
async function expandFolder(page: Page, name: string): Promise<void> {
	const expander = row(page, name).getByRole('button', { name: 'Expand' });
	if (await expander.count()) await expander.click();
}

/**
 * Names among `candidates` that currently render as tree rows, in DOM
 * (i.e. visual top-to-bottom) order. Used to assert reorder/placement without
 * inspecting network bodies — a drag stages a `view.*` op rather than PUTting
 * a whole-document snapshot (see the section header comment above), so the
 * tree's own rendered order, which mirrors the optimistically-applied `_view`
 * state, is the only signal left to read.
 */
async function visibleOrder(page: Page, candidates: string[]): Promise<string[]> {
	const rows = await tree(page).getByRole('treeitem').allTextContents();
	const found: string[] = [];
	for (const text of rows) {
		const hit = candidates.find((c) => text.includes(c));
		if (hit !== undefined) found.push(hit);
	}
	return found;
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

test('view curation: include a pooled element into a folder, commit with a message, and it persists across reload', async ({
	page
}) => {
	test.setTimeout(120_000);
	await loadView(page);

	const t = tree(page);
	// Precondition: Beta sits in the (collapsed) "Not in view" pool; expand to reach it.
	await expect(poolHeader(page)).toBeVisible();
	await expandPool(page);
	await expect(poolRow(page, 'Beta')).toBeVisible();

	const badge = changeBadge(page);
	await expect(badge).toContainText('0 change');

	// Include: drag the Beta row (in the pool) onto the Grouped folder header.
	// This only STAGES a `place_element` view op (drop-time `folder:` lease,
	// optimistic local apply) — nothing reaches the server until the commit
	// below, so the badge — not a network request — is what confirms the
	// gesture landed.
	await dragRowOnto(page, poolRow(page, 'Beta'), row(page, 'Grouped'));
	await expect(badge).toContainText('1 change');

	// Beta is now placed under Grouped (folders are not lazily paged); expand to see it.
	await expandFolder(page, 'Grouped');
	await expect(t.getByText('Beta')).toBeVisible();

	// Commit with a message. This is the only path that reaches the server: a
	// commit that carries view ops makes the client refetch `GET /view` once
	// the batch lands, concretizing the change against server truth.
	const commitMessage = `e2e view commit ${Date.now()}`;
	await commitStaged(page, commitMessage);
	await expect(badge).toContainText('0 change');

	// Persistence: reload from scratch and assert the freshly loaded snapshot
	// (GET /view) places Beta in Grouped. A visible Beta after reload alone
	// would NOT be proof (a pooled Beta renders too) — read the actual
	// response, mirroring the durability check the old whole-doc-PUT version
	// of this test made, now against the commit path instead.
	const reloaded = page.waitForResponse(
		(r) => new URL(r.url()).pathname.endsWith('/view') && r.request().method() === 'GET'
	);
	await page.reload();
	const loaded = (await (await reloaded).json()) as {
		view: { folders: { name: string; folders: unknown[]; elements: string[] }[] } | null;
	};
	expect(loaded.view).not.toBeNull();
	const grouped = loaded.view!.folders.find((f) => f.name === 'Grouped');
	expect(grouped?.elements).toContain(BLOCK_TWO_ID);

	const t2 = tree(page);
	await expect(t2.getByText('Grouped')).toBeVisible();
	await expandFolder(page, 'Grouped');
	await expect(t2.getByText('Beta')).toBeVisible();
});

test('view curation: exclude a placed element back to the pool', async ({ page }) => {
	test.setTimeout(120_000);
	await loadView(page);
	await expandFolder(page, 'Grouped'); // folders default collapsed; reveal Alpha to drag it

	const badge = changeBadge(page);

	// Exclude: drag Alpha from Grouped onto the "Not in view" panel header.
	// STAGES a `remove_element` op; no PUT fires (see the include test above
	// for the full rationale).
	await dragRowOnto(page, row(page, 'Alpha'), poolHeader(page));
	await expect(badge).toContainText('1 change');

	// Alpha left Grouped: the main tree no longer shows it at all. The "Not in
	// view" pool's own contents come from a server-fetched complement
	// (`GET /model/containment/roots/excluded`) that only reflects COMMITTED
	// placements, so a merely-staged `remove_element` would leave it stale
	// there — but `registerExcludedRoots` (view-tree.ts) client-side-injects
	// staged-unplaced ids into the pool region, so Alpha shows up immediately
	// anyway.
	await expect(tree(page).getByText('Alpha')).toHaveCount(0);
	await expandPool(page);
	// Alpha must not sit stuck in neither region between the staged remove
	// and the commit, which would read as data loss: the excluded-pool
	// injection makes it appear in the pool the instant the op is staged,
	// well before any commit round trip.
	await expect(poolRow(page, 'Alpha')).toBeVisible();

	await commitStaged(page);
	await expect(badge).toContainText('0 change');
	await expect(poolRow(page, 'Alpha')).toBeVisible();
});

test('view curation: reorder elements within a folder (upward)', async ({ page }) => {
	test.setTimeout(120_000);
	await loadView(page);

	const badge = changeBadge(page);

	// Build a two-element folder: include Beta so Grouped = [Alpha, Beta].
	await expandPool(page);
	await dragRowOnto(page, poolRow(page, 'Beta'), row(page, 'Grouped'));
	await expect(badge).toContainText('1 change');
	await expandFolder(page, 'Grouped'); // reveal Alpha + Beta rows for the reorder drag
	await expect(tree(page).getByText('Beta')).toBeVisible();
	await expect.poll(() => visibleOrder(page, ['Alpha', 'Beta'])).toEqual(['Alpha', 'Beta']);

	// Reorder UP: drag the SECOND element (Beta) onto the TOP half of the FIRST
	// (Alpha) so it is inserted before it. (Downward same-folder reorder has a
	// known off-by-one; we assert only the upward case.)
	await dragRowOnto(page, row(page, 'Beta'), row(page, 'Alpha'), { half: 'top' });
	// Two ops staged now: the include, then the reorder (a `move_element`).
	await expect(badge).toContainText('2 change');
	await expect.poll(() => visibleOrder(page, ['Alpha', 'Beta'])).toEqual(['Beta', 'Alpha']);
});

test('view curation: search result dragged into a folder is placed there', async ({ page }) => {
	test.setTimeout(120_000);
	await loadView(page);

	// Type a known element's name; wait for its row in the search dropdown.
	await page.getByPlaceholder('Filter by name, type, id…').fill('Beta');
	const dropdown = page.locator('#sidebar-search-dropdown');
	// Rows are `<li role="option">` (the ARIA combobox pattern), not buttons.
	const result = dropdown.getByRole('option').filter({ hasText: 'Beta' }).first();
	await expect(result).toBeVisible();

	const badge = changeBadge(page);

	// Drag the search result onto the Grouped folder header. The drag starts
	// outside the tree (search-originated, bypassMovable) and the tree adopts
	// it. STAGES a `place_element` op; no PUT fires.
	await dragRowOnto(page, result, row(page, 'Grouped'));
	await expect(badge).toContainText('1 change');

	await expandFolder(page, 'Grouped');
	await expect(tree(page).getByText('Beta')).toBeVisible();
});

test('change badge increments on view edit, tooltip shows View row, Save dialog opens View tab', async ({
	page
}) => {
	test.setTimeout(120_000);
	await loadView(page);

	const badge = changeBadge(page);
	await expect(badge).toBeVisible();

	// A fresh loadView bootstraps with zero pending changes.
	await expect(badge).toContainText('0 change');

	// Make a view edit: drag Alpha (placed in Grouped) onto the pool header to
	// exclude it. This is the same mechanism used by the "exclude" curation
	// test. It only STAGES a `remove_element` op (optimistic local apply, no
	// PUT), so the badge count is the only signal to wait on.
	await expandFolder(page, 'Grouped'); // folders default collapsed; reveal Alpha to drag it
	await dragRowOnto(page, row(page, 'Alpha'), poolHeader(page));

	// Excluding one element is exactly 1 view change; combined count must be 1.
	await expect(badge).toContainText('1 change');

	// Hovering the badge reveals the tooltip with both a "model" and a "view" row,
	// labelled "Uncommitted (model)" and "Unsaved (view)".
	// Scope to the badge's own group wrapper (the LAST div.group in the header) so
	// we cannot accidentally match the Info/loaded-files tooltip in the first group.
	await badge.hover();
	const badgeGroup = page.locator('header div.group').last();
	const tooltip = badgeGroup.getByRole('tooltip');
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toContainText('Unsaved (view)');
	await expect(tooltip).toContainText('Uncommitted (model)');

	// Ctrl+S opens the Commit dialog (DiffDrawer), titled "Commit changes".
	await page.keyboard.press('Control+s');
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible();

	// Click the View tab and assert that at least one human-readable view-change
	// line is shown. Alpha was excluded from "Grouped" via `stageRemoveElement`
	// (`stagePlaceElementsAt`'s `folderId === null` branch), whose label reads
	// `Removed <name> from "<folder>"` (see view.svelte.ts) — match that prefix
	// rather than the whole vocabulary of labels the journal can produce
	// (Created/Renamed/Deleted/Moved folder, Placed/Moved/Removed element or
	// artifact).
	await drawer.getByRole('tab', { name: /View/i }).click();
	await expect(drawer.getByText(/^Removed .* from /)).toBeVisible();
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
