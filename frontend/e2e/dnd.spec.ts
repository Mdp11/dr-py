import { test, expect, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { changeBadge } from './helpers/commit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

const ALPHA = 'dnd-block-alpha';
const BETA = 'dnd-block-beta';

/**
 * Load metamodel + a two-Block model + a view ("Grouped" holds Alpha, "Target"
 * is empty) in a single pass through the load dialog.
 */
async function bootstrap(page: Page): Promise<void> {
	// The backend session persists across page loads; loading a metamodel/model
	// over leftover unsaved changes pops a window.confirm that Playwright would
	// auto-dismiss. Accept it so the load dialog can open.
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);

	const model = {
		elements: [
			{ id: ALPHA, type_name: 'Block', properties: { name: 'Alpha', mass: 1.0 }, rev: 0 },
			{ id: BETA, type_name: 'Block', properties: { name: 'Beta', mass: 2.0 }, rev: 0 }
		],
		relationships: []
	};
	const view = {
		name: 'Operational',
		folders: [
			{ name: 'Grouped', folders: [], elements: [ALPHA] },
			{ name: 'Target', folders: [], elements: [] }
		]
	};

	await loadFiles(page, {
		metamodel: METAMODEL_PATH,
		model: {
			name: 'dnd-spec.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(model))
		},
		view: {
			name: 'operational.view.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(view))
		}
	});
	await expect(
		page.getByRole('tree', { name: /containment tree/i }).getByText('Grouped')
	).toBeVisible();
}

/** The main containment tree (distinct from the "Not in view" pool's own tree). */
function mainTree(page: Page): Locator {
	return page.getByRole('tree', { name: /containment tree/i });
}

/** A tree row (treeitem) that contains the given text — matches EITHER the
 * main tree or the excluded-pool tree, since both are `role="tree"`. */
function row(page: Page, text: string): Locator {
	return page.getByRole('treeitem').filter({ hasText: text }).first();
}

/** Expand a folder row by name (folders default COLLAPSED). No-op if already open. */
async function expandFolder(page: Page, name: string): Promise<void> {
	const expander = row(page, name).getByRole('button', { name: 'Expand' });
	if (await expander.count()) await expander.click();
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
	// Press via an actionability-checked hover, not a raw mouse.move: raw mouse
	// events have no hit-target check, so right after bootstrap they can land on
	// the project-open progress overlay (which outlives the tree becoming
	// "visible" by design) and the row's onPointerDown never fires — the drag
	// silently never starts. hover() waits until the row actually receives
	// pointer events at the press point.
	await source.hover({ position: { x: sx - s.x, y: sy - s.y } });
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

/**
 * Expand the "Not in view" excluded-pool panel (collapsed by default; no fetch
 * while collapsed) and wait for its element tree to render. Idempotent enough
 * for tests: only clicks when currently collapsed.
 */
async function expandExcludedPool(page: Page): Promise<void> {
	const pool = page.getByRole('tree', { name: /excluded elements/i });
	if (await pool.isVisible().catch(() => false)) return;
	await page.getByRole('button', { name: /not in view/i }).click();
	await expect(pool).toBeVisible();
}

test.beforeEach(async ({ page }) => {
	test.setTimeout(120_000);
	await bootstrap(page);
});

// A drag no longer PUTs a whole-document snapshot: it stages a `view.*` op
// (drop-time `folder:` lease, optimistic local apply — see view.svelte.ts)
// that reaches the server only through a DiffDrawer commit. So a drag's
// observable effects here are (1) the optimistic tree already shows the new
// placement and (2) the TopBar's combined-changes counter picked up the
// staged op(s) — persistence itself is covered end-to-end by view.spec.ts's
// commit-and-reload test.

test('drag an element into a folder places it there', async ({ page }) => {
	// Beta is not placed in any folder, so it lives in the "Not in view" excluded
	// pool — a separate panel that is collapsed by default (and unfetched while
	// collapsed). Expand it so Beta renders as a draggable row.
	await expandExcludedPool(page);
	const badge = changeBadge(page);
	await expect(badge).toContainText('0 change');
	await pointerDragDrop(page, row(page, 'Beta'), row(page, 'Target'));

	await expect(badge).toContainText('1 change');
	await expandFolder(page, 'Target');
	// "Beta" now renders nested one level under "Target" (aria-level 2, not the
	// top-level 1) — not merely visible somewhere, since it left the pool too.
	await expect(row(page, 'Beta')).toHaveAttribute('aria-level', '2');
});

test('drag a placed element to the view root unplaces it', async ({ page }) => {
	await expandFolder(page, 'Grouped'); // folders default collapsed; reveal Alpha to drag it
	const badge = changeBadge(page);
	await pointerDragDrop(
		page,
		row(page, 'Alpha'),
		page.getByRole('button', { name: 'Move to top level' }),
		{ waitForTarget: true }
	);

	await expect(badge).toContainText('1 change');
	// Alpha left "Grouped": the main tree no longer shows it at all. It does
	// NOT (yet) reappear in the "Not in view" pool — that panel's contents
	// come from a server-fetched complement (`GET /model/containment/roots/
	// excluded`) that only reflects COMMITTED placements; a locally staged
	// `remove_element` has no server-side effect until commit, so the pool
	// stays stale until then (see view.spec.ts's "exclude" curation test for
	// the full round trip through a commit).
	//
	// TODO(excluded-pool-gap): the SECOND half of that state is a known BUG this
	// assertion PINS as current behaviour — Alpha is in neither the tree nor the
	// pool, i.e. it has vanished from the UI until commit. This line stays
	// `toHaveCount(0)` (Alpha correctly leaves the MAIN tree), but the sibling
	// pool assertion in view.spec.ts must INVERT when the pool-injection fix
	// lands, and this comment should go with it. Do not "fix" either test to
	// keep it green — fix the pool.
	await expect(mainTree(page).getByText('Alpha')).toHaveCount(0);
});

test('drag a folder onto another folder reparents it', async ({ page }) => {
	const badge = changeBadge(page);
	await pointerDragDrop(page, row(page, 'Grouped'), row(page, 'Target'));

	await expect(badge).toContainText('1 change');
	// "Grouped" is no longer top-level; expanding "Target" reveals it nested one
	// level down (aria-level 2 instead of the original top-level 1).
	await expandFolder(page, 'Target');
	await expect(row(page, 'Grouped')).toHaveAttribute('aria-level', '2');
});

test('multi-selected elements all move on a single drag', async ({ page }) => {
	// Alpha is placed (in "Grouped", in the in-view tree); Beta is unplaced, so it
	// lives in the collapsed "Not in view" pool. Expand the pool, then ctrl-select
	// one row from each section before dragging.
	await expandExcludedPool(page);
	await expandFolder(page, 'Grouped'); // reveal placed Alpha in the in-view tree
	const pool = page.getByRole('tree', { name: /excluded elements/i });
	await mainTree(page)
		.getByText('Alpha')
		.click({ modifiers: ['ControlOrMeta'] });
	await pool.getByText('Beta').click({ modifiers: ['ControlOrMeta'] });

	const badge = changeBadge(page);
	await pointerDragDrop(page, row(page, 'Beta'), row(page, 'Target'));

	// Two elements moved in one gesture -> two staged view ops.
	await expect(badge).toContainText('2 change');
	await expandFolder(page, 'Target');
	await expect(row(page, 'Alpha')).toHaveAttribute('aria-level', '2');
	await expect(row(page, 'Beta')).toHaveAttribute('aria-level', '2');
});
