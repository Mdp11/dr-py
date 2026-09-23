/**
 * A staged model edit visible in the tree before it commits: with
 * `dr.surfaces = {staging: 'engine'}`, the five read surfaces are served by
 * the replica's own working copy, so a create/rename/delete staged in the
 * browser shows up in the tree (or the "Not in view" pool, for an element no
 * view places), search and the Inspector without a commit — and a peer's
 * commit that invalidates a staged edit parks it as a conflict instead of
 * silently losing it. Shadow comparison is gated off while anything is
 * staged (D12), so the `shadowWatch` fixture failing on any `[shadow]` line
 * doubles as proof the gate holds.
 */

import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { expectLiveFeed } from './helpers/feed';
import { changeBadge, commitStaged } from './helpers/commit';
import { expectReplicaReady, replica } from './helpers/replica';
import { headRev, peer, projectIdByName } from './helpers/api-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, '..', '..', 'examples');

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let projectId: string;

test.beforeAll(async ({ browser, playwright }) => {
	test.setTimeout(120_000);
	// Earlier specs leave the shared project holding other content.
	const page = await browser.newPage();
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, {
		metamodel: join(EXAMPLES, 'smart-city.metamodel.yaml'),
		model: join(EXAMPLES, 'smart-city.model.json'),
		view: join(EXAMPLES, 'smart-city.view.json')
	});
	await page.close();

	api = await peer(playwright);
	projectId = await projectIdByName(api, 'Smart City');
});

test.afterAll(async () => {
	await api?.dispose();
});

/** Forces the store's `staging` switch to `engine` for THIS page only, before
 * the app boots — `dr.surfaces` already defaults every read surface to
 * `engine` (surfaces.ts's `SURFACE_DEFAULTS`), so the one thing this spec
 * needs to add is the switch that also stages EDITS there. */
async function useEngineStaging(page: Page): Promise<void> {
	await page.addInitScript(() => {
		localStorage.setItem('dr.surfaces', JSON.stringify({ staging: 'engine' }));
	});
}

async function openReady(page: Page): Promise<void> {
	await useEngineStaging(page);
	await openDefaultProject(page);
	await expectLiveFeed(page);
	await expectReplicaReady(page);
}

function tree(page: Page) {
	return page.getByRole('tree', { name: /containment tree/i });
}

/** The "Not in view" pool panel — the smart-city view places only a handful
 * of elements (Organizations e_000001..5 among them), so any OTHER element —
 * in particular a freshly staged create, which no view places — renders
 * here, never under the view's own folders. */
function pool(page: Page) {
	return page.getByRole('tree', { name: /excluded elements/i });
}
function poolRow(page: Page, text: string) {
	return pool(page).getByRole('treeitem').filter({ hasText: text }).first();
}

/** Expands the pool panel if it is collapsed (the default). No-op otherwise. */
async function expandPool(page: Page): Promise<void> {
	if (await pool(page).count()) return;
	await page.getByRole('button', { name: /not in view/i }).click();
	await expect(pool(page)).toBeVisible();
}

/** The pool is virtualized (windowed): a row past the on-screen slice does not
 * exist in the DOM until scrolled into range. Rows sort by (display name,
 * id) — this spec's created elements are named with a leading digit so they
 * sort to the very top, needing at most a couple of scroll steps. */
async function scrollUntilVisible(page: Page, container: Locator, target: Locator): Promise<void> {
	for (let i = 0; i < 30; i++) {
		if ((await target.count()) > 0 && (await target.isVisible())) return;
		await container.evaluate((el) => {
			el.scrollTop += 200;
		});
		await page.waitForTimeout(50);
	}
}

/** Selects every stereotype (the tree's default, but set explicitly for
 * safety) and expands the view's "Organizations" folder, revealing
 * Organization-001..005 as tree rows. */
async function expandOrganizationsFolder(page: Page): Promise<void> {
	await page.locator('[aria-label="Filter stereotypes"]').click();
	const selectAll = page.getByRole('button', { name: 'Select all', exact: true });
	await expect(selectAll).toBeVisible({ timeout: 5_000 });
	await selectAll.click();
	await page.keyboard.press('Escape');
	const folder = tree(page).getByRole('treeitem').filter({ hasText: 'Organizations' }).first();
	await expect(folder).toBeVisible({ timeout: 15_000 });
	await folder.locator('button[aria-label]').first().click();
	await expect(
		tree(page).getByRole('treeitem').filter({ hasText: 'Organization-001' })
	).toBeVisible({ timeout: 10_000 });
}

function searchInput(page: Page) {
	return page.getByPlaceholder('Filter by name, type, id…');
}

function nameInput(page: Page) {
	return page.getByTestId('inspector').locator('input[type="text"]').first();
}

/** Searches for a known, server-known element by name+id and opens it. */
async function searchAndOpen(page: Page, name: string, id: string): Promise<void> {
	await searchInput(page).fill(name);
	const hit = page.getByRole('option').and(page.locator(`[title="${id}"]`));
	await expect(hit).toBeVisible({ timeout: 10_000 });
	await hit.click();
	await expect(nameInput(page)).toHaveValue(name, { timeout: 10_000 });
}

/** Searches by name alone — for a staged create, whose temp id this spec
 * never reads out of the DOM. */
async function searchAndOpenByName(page: Page, name: string): Promise<void> {
	await searchInput(page).fill(name);
	const hit = page.getByRole('option').filter({ hasText: name });
	await expect(hit).toBeVisible({ timeout: 10_000 });
	await hit.click();
	await expect(nameInput(page)).toHaveValue(name, { timeout: 10_000 });
}

/** Creates an element from the tree's "New element" action and names it via
 * the Inspector, which the create leaves open (`onCreateElement` selects the
 * new temp id). Leaves the Inspector showing it, named. */
async function createAndName(page: Page, typeName: string, name: string): Promise<void> {
	await page.locator('[aria-label="New element"]').click();
	await page.getByPlaceholder('Search stereotypes…').fill(typeName);
	await page.getByRole('button', { name: typeName, exact: true }).click();
	await expect(page.getByTestId('inspector-stereotype')).toHaveText(typeName, { timeout: 10_000 });
	await nameInput(page).fill(name);
	await nameInput(page).blur();
	await expect(nameInput(page)).toHaveValue(name);
}

/** Renames the element the Inspector currently shows. */
async function renameSelected(page: Page, name: string): Promise<void> {
	await nameInput(page).fill(name);
	await nameInput(page).blur();
	await expect(nameInput(page)).toHaveValue(name);
}

/** Deletes the element the Inspector currently shows, confirming the dialog. */
async function deleteSelected(page: Page): Promise<void> {
	await page.getByTestId('delete-element').click();
	await page.getByTestId('confirm-dialog-confirm').click();
}

/** The TopBar's combined-change count, read past the "● " glyph and the
 * trailing "change"/"changes" word rather than matched as one fragile string. */
async function stagedChangeCount(page: Page): Promise<number> {
	const text = (await changeBadge(page).textContent()) ?? '';
	const match = text.match(/(\d+)/);
	if (!match) throw new Error(`change badge carries no count: ${text}`);
	return Number(match[1]);
}

/**
 * A peer's delete through the locked commit path — `api-client.ts`'s
 * `peerCommit` has no delete variant, and this spec needs one to park a
 * conflict on a local staged rename. Same shape as `peerCommit`: a
 * DELETE-intent exclusive lease, then one commit; the lease is released in a
 * `finally` so a failed commit never leaves it held.
 */
async function peerDeleteElement(
	api: APIRequestContext,
	projectId: string,
	elementId: string
): Promise<number> {
	const base = `projects/${projectId}`;
	const baseRev = await headRev(api, projectId);
	const lock = await api.post(`${base}/locks`, {
		data: { targets: [{ resource_id: elementId, mode: 'exclusive' }], intent: 'delete' }
	});
	expect(lock.ok(), await lock.text()).toBeTruthy();
	const { token } = (await lock.json()) as { token: string };
	try {
		const commit = await api.post(`${base}/commits`, {
			data: {
				base_rev: baseRev,
				ops: [{ kind: 'delete_element', id: elementId }],
				message: 'peer delete',
				lock_tokens: [token],
				ack_errors: true
			}
		});
		expect(commit.ok(), await commit.text()).toBeTruthy();
		return ((await commit.json()) as { model_rev: number }).model_rev;
	} finally {
		await api.post(`${base}/locks/release`, { data: { token } });
	}
}

test('a staged create, rename and cascading delete show before any commit, and Undo/Discard unwind them', async ({
	page
}) => {
	test.setTimeout(120_000);
	const startRev = await headRev(api, projectId);
	await openReady(page);
	await expandOrganizationsFolder(page);

	// ----- create -----------------------------------------------------------
	const createName = `0-t1-create-${Date.now()}`;
	await createAndName(page, 'Organization', createName);

	// the pool (no view places the new root) — proves the TREE surface, not
	// just search, is served staged-inclusive by the replica
	await expandPool(page);
	await scrollUntilVisible(page, pool(page), poolRow(page, createName));
	await expect(poolRow(page, createName)).toBeVisible({ timeout: 10_000 });

	// search finds it, and opening the hit re-shows it in the Inspector
	await searchAndOpenByName(page, createName);

	// ----- rename an existing element ---------------------------------------
	await searchAndOpen(page, 'Organization-001', 'e_000001');
	const renamedName = `t1-renamed-${Date.now()}`;
	await renameSelected(page, renamedName);

	await expect(tree(page).getByRole('treeitem').filter({ hasText: renamedName })).toBeVisible({
		timeout: 10_000
	});
	await searchInput(page).fill(renamedName);
	await expect(page.getByRole('option').filter({ hasText: renamedName })).toBeVisible({
		timeout: 10_000
	});

	// ----- delete one with children (cascades: 5 elements + 13 relationships,
	// see examples/smart-city.model.json's Owns/MemberOf/Responsible edges off
	// e_000004 and its four owned Teams) -------------------------------------
	await searchAndOpen(page, 'Organization-004', 'e_000004');
	await deleteSelected(page);
	await expect(
		tree(page).getByRole('treeitem').filter({ hasText: 'Organization-004' })
	).toHaveCount(0, { timeout: 10_000 });

	// ----- the change badge counts: 1 created + 1 modified + 18 cascaded ----
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(20);

	// nothing landed on the server through any of this
	expect(await headRev(api, projectId)).toBe(startRev);

	// ----- Undo removes the last (the delete) -------------------------------
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(2);
	await expect(
		tree(page).getByRole('treeitem').filter({ hasText: 'Organization-004' })
	).toBeVisible({ timeout: 10_000 });

	// ----- Discard all empties the create and leaves the delete undone ------
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const discardAll = drawer.getByRole('button', { name: 'Discard all' });
	await expect(discardAll).toBeEnabled({ timeout: 10_000 });
	await discardAll.click();
	await expect(drawer).toBeHidden({ timeout: 10_000 });

	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
	await expect(page.getByRole('option').filter({ hasText: createName })).toHaveCount(0);
	await searchInput(page).fill('');
	await expect(
		tree(page).getByRole('treeitem').filter({ hasText: 'Organization-001' })
	).toBeVisible({ timeout: 10_000 });
	await expect(
		tree(page).getByRole('treeitem').filter({ hasText: 'Organization-004' })
	).toBeVisible({ timeout: 10_000 });

	expect(await headRev(api, projectId)).toBe(startRev);
});

test('a committed create shows under its server id, and a peer commit parks a staged rename', async ({
	page
}) => {
	test.setTimeout(120_000);
	await openReady(page);

	// ----- create + rename (naming it) + commit -----------------------------
	const createName = `0-t2-create-${Date.now()}`;
	await createAndName(page, 'Organization', createName);
	await commitStaged(page, 'create for the engine');

	await expandPool(page);
	await scrollUntilVisible(page, pool(page), poolRow(page, createName));
	const row = poolRow(page, createName);
	await expect(row).toBeVisible({ timeout: 10_000 });
	const rowId = await row.locator('button.flex-1').first().getAttribute('title');
	expect(rowId).not.toBeNull();
	expect(rowId).not.toMatch(/^tmp_/);

	await searchInput(page).fill(createName);
	await expect(page.getByRole('option').filter({ hasText: createName })).toBeVisible({
		timeout: 10_000
	});

	// ----- stage a rename the peer will conflict, and one that survives it --
	const CONFLICT_ID = 'e_000002';
	const REST_ID = 'e_000003';
	const conflictName = `t2-conflict-${Date.now()}`;
	const restName = `t2-rest-${Date.now()}`;

	await searchAndOpen(page, 'Organization-002', CONFLICT_ID);
	await renameSelected(page, conflictName);
	await searchAndOpen(page, 'Organization-003', REST_ID);
	await renameSelected(page, restName);

	const peerRev = await peerDeleteElement(api, projectId, CONFLICT_ID);
	await expect(replica(page)).toHaveAttribute('data-rev', String(peerRev), { timeout: 15_000 });

	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });

	const conflicts = drawer.getByTestId('staged-conflicts');
	await expect(conflicts).toBeVisible({ timeout: 15_000 });
	await expect(conflicts).toContainText('1 staged edits no longer apply');
	await expect(conflicts).toContainText(`No element with id '${CONFLICT_ID}`);

	await conflicts.getByRole('button', { name: 'Discard' }).click();
	await expect(drawer.getByTestId('staged-conflicts')).toHaveCount(0);

	const commitButton = drawer.getByRole('button', { name: /^Commit/ });
	await expect(commitButton).toBeEnabled({ timeout: 20_000 });
	await commitButton.click();
	await expect(drawer).toBeHidden({ timeout: 20_000 });

	// the rest (the surviving rename) landed
	await searchInput(page).fill(restName);
	await expect(page.getByRole('option').filter({ hasText: restName })).toBeVisible({
		timeout: 10_000
	});

	// ----- reload: a fresh replica, nothing staged --------------------------
	await page.reload();
	await expectLiveFeed(page);
	await expectReplicaReady(page);

	await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
	expect(await stagedChangeCount(page)).toBe(0);
});
