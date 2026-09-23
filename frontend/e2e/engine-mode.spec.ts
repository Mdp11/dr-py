/**
 * The workspace read by the engine: every surface answered by the replica in
 * the real sandbox, against the real backend, with a second API client as
 * the peer — and a tab whose engine cannot start reads from the server.
 */

import { test, expect, engineMode, watchShadow } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { login, openDefaultProject } from './helpers/auth';
import { expectLiveFeed } from './helpers/feed';
import { commitStaged } from './helpers/commit';
import { expectReplicaReady, replica, watchPhases } from './helpers/replica';
import { headRev, peer, peerCommit, peerRebind, projectIdByName } from './helpers/api-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, '..', '..', 'examples');

/** Elements of the smart-city example: one searched by its loaded name, one a peer renames. */
const SEARCHED = { id: 'e_000002', name: 'Organization-002' };
const RENAMED_BY_PEER = 'e_000003';

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

async function openReady(page: Page): Promise<void> {
	await openDefaultProject(page);
	await expectLiveFeed(page);
	await expectReplicaReady(page);
}

function tree(page: Page) {
	return page.getByRole('tree', { name: /containment tree/i });
}

/** Shows every stereotype in the tree, then opens its first root. */
async function expandFirstRoot(page: Page): Promise<void> {
	await page.locator('[aria-label="Filter stereotypes"]').click();
	const selectAll = page.getByRole('button', { name: 'Select all', exact: true });
	await expect(selectAll).toBeVisible({ timeout: 5_000 });
	await selectAll.click();
	await page.keyboard.press('Escape');
	const first = tree(page).getByRole('treeitem').first();
	await expect(first).toBeVisible({ timeout: 15_000 });
	await first.locator('button[aria-label]').first().click();
	await expect(tree(page).getByRole('treeitem').nth(1)).toBeVisible({ timeout: 10_000 });
}

function searchInput(page: Page) {
	return page.getByPlaceholder('Filter by name, type, id…');
}

/** The "Not in view" pool panel — the smart-city view places only a handful
 * of elements, so a freshly created, unplaced root renders here, never under
 * the view's folders (see CLAUDE.md's Shell section on view mode). */
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
 * exist in the DOM until scrolled into range. `target` ranks low (alphabetically
 * near the top of ~700 unplaced roots), so a handful of scroll steps suffice. */
async function scrollUntilVisible(page: Page, container: Locator, target: Locator): Promise<void> {
	for (let i = 0; i < 30; i++) {
		if ((await target.count()) > 0 && (await target.isVisible())) return;
		await container.evaluate((el) => {
			el.scrollTop += 200;
		});
		await page.waitForTimeout(50);
	}
}

/** Searches the sidebar for `name` and opens the hit whose id is `id`. */
async function searchAndOpen(page: Page, name: string, id: string): Promise<void> {
	await searchInput(page).fill(name);
	const hit = page.getByRole('option').and(page.locator(`[title="${id}"]`));
	await expect(hit).toBeVisible({ timeout: 10_000 });
	await hit.click();
	await expect(nameInput(page)).toHaveValue(name, { timeout: 10_000 });
}

function nameInput(page: Page) {
	return page.getByTestId('inspector').locator('input[type="text"]').first();
}

/** The walk every read surface serves: a tree node, a search, an element, its relationships. */
async function walk(page: Page): Promise<void> {
	await expandFirstRoot(page);
	await searchAndOpen(page, SEARCHED.name, SEARCHED.id);
	const relationships = page
		.getByTestId('inspector')
		.getByRole('button', { name: 'Edit relationship' })
		.first();
	await expect(relationships).toBeAttached({ timeout: 10_000 });
}

/** The model reads the page sends from now on, as `METHOD path?query` under the project. */
function recordModelReads(page: Page): string[] {
	const seen: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		const at = url.pathname.indexOf('/model/');
		if (at < 0) return;
		seen.push(`${request.method()} ${url.pathname.slice(at)}${url.search}`);
	});
	return seen;
}

test('the workspace is served by the engine', async ({ page }) => {
	test.setTimeout(120_000);
	const shadowed = recordModelReads(page);
	await openReady(page);
	await walk(page);
	// Shadow on: each surface's read went to the server a second time.
	const expected: Array<[string, RegExp]> = [
		['summary', /^GET \/model\/summary/],
		['tree', /^GET \/model\/(containment\/roots|elements\/[^/?]+\/children)/],
		['search', /^GET \/model\/elements\?.*q=/],
		['elements', /^GET \/model\/elements\/[^/?]+$/],
		['relationships', /^GET \/model\/elements\/[^/?]+\/relationships/]
	];
	for (const [surface, pattern] of expected) {
		await expect
			.poll(() => shadowed.some((line) => pattern.test(line)), { message: surface })
			.toBe(true);
	}

	await page.evaluate(() => localStorage.removeItem('dr.shadow'));
	const direct = recordModelReads(page);
	await page.reload();
	await expectLiveFeed(page);
	await expectReplicaReady(page);
	await walk(page);
	const served = direct.filter((line) =>
		/^\w+ \/model\/(summary|elements|containment\/)/.test(line)
	);
	expect(served, 'model reads the server answered').toEqual([]);
});

test('an own commit shows in the tree and the search', async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	await expandFirstRoot(page);
	const row = tree(page).getByRole('treeitem').nth(1);
	await row.locator('button.flex-1').first().click();
	const renamed = `engine-own-${Date.now()}`;
	await expect(nameInput(page)).toBeVisible({ timeout: 10_000 });
	await nameInput(page).fill(renamed);
	await nameInput(page).blur();
	await commitStaged(page, 'rename on the engine');
	await expect(replica(page)).toHaveAttribute('data-rev', String(await headRev(api, projectId)), {
		timeout: 10_000
	});

	await expect(tree(page).getByRole('treeitem').filter({ hasText: renamed })).toBeVisible({
		timeout: 10_000
	});
	await searchInput(page).fill(renamed);
	await expect(page.getByRole('option').filter({ hasText: renamed })).toBeVisible({
		timeout: 10_000
	});
});

test("a peer's commit shows", async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	const current = await api.get(`projects/${projectId}/model/elements/${RENAMED_BY_PEER}`);
	expect(current.ok(), await current.text()).toBeTruthy();
	const name = ((await current.json()) as { properties: { name: string } }).properties.name;
	await searchAndOpen(page, name, RENAMED_BY_PEER);

	const renamed = `engine-peer-${Date.now()}`;
	const rev = await peerCommit(api, projectId, {
		elementId: RENAMED_BY_PEER,
		patch: { name: renamed }
	});
	await expect(replica(page)).toHaveAttribute('data-rev', String(rev), { timeout: 10_000 });
	await expect(nameInput(page)).toHaveValue(renamed, { timeout: 10_000 });
});

test('a model replaced outside the journal heals', async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	const phases = await watchPhases(page);

	const name = `engine-legacy-${Date.now()}`;
	const created = await api.post(`projects/${projectId}/model/elements`, {
		data: { type: 'Organization', properties: { name } }
	});
	expect(created.ok(), await created.text()).toBeTruthy();
	const id = ((await created.json()) as { id: string }).id;
	const rev = await headRev(api, projectId);

	await expect(replica(page)).toHaveAttribute('data-rev', String(rev), { timeout: 30_000 });
	await expect(replica(page)).toHaveAttribute('data-phase', 'ready');
	const seen = await phases();
	expect(seen[0]).toBe('ready');
	expect(seen).toContain('resyncing');
	expect(seen[seen.length - 1]).toBe('ready');

	await searchInput(page).fill(name);
	await expect(page.getByRole('option').and(page.locator(`[title="${id}"]`))).toBeVisible({
		timeout: 10_000
	});
});

test("a peer's rebind with a new element shows after Reload", async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	await expandFirstRoot(page);
	// Establish the pool's baseline fetch BEFORE the peer's commit: it stays
	// expanded and open through the rebind, so its later contents can only
	// change through the reactive refetch this test is proving — not through
	// the "first expansion always fetches fresh" path `expandPool` would take
	// if called again afterwards.
	await expandPool(page);
	await expect(pool(page).getByRole('treeitem').first()).toBeVisible({ timeout: 10_000 });

	const created = await peerRebind(api, projectId, {
		typeName: 'Organization',
		properties: { name: 'After rebind' }
	});

	const rebindBanner = page.getByRole('alert').filter({ hasText: 'metamodel was changed' });
	await expect(rebindBanner).toBeVisible({ timeout: 15_000 });

	const phases = await watchPhases(page);
	await rebindBanner.getByRole('button', { name: 'Reload' }).click();

	await expect(replica(page)).toHaveAttribute('data-rev', String(created.rev), { timeout: 30_000 });
	await expect(replica(page)).toHaveAttribute('data-phase', 'ready');
	const seen = await phases();
	expect(seen).toContain('resyncing');
	expect(seen[seen.length - 1]).toBe('ready');

	// No page reload happened: the URL is still the workspace's.
	expect(page.url()).toContain(`/p/${projectId}`);

	await scrollUntilVisible(page, pool(page), poolRow(page, 'After rebind'));
	await expect(poolRow(page, 'After rebind')).toBeVisible({ timeout: 10_000 });
});

test('the boot fallback', async ({ browser }) => {
	test.setTimeout(120_000);
	// The sandbox's host: the app refuses to embed it, so the engine never starts.
	const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
	try {
		const shadow = watchShadow(context);
		await engineMode(context);
		const page = await context.newPage();
		// The session cookie is per host: this context logs in on its own.
		await login(page);
		await page.getByText('Smart City').click();
		await page.waitForURL('**/p/**');

		await expect(replica(page)).toHaveAttribute('data-phase', 'server', { timeout: 30_000 });
		const notice = page.getByTestId('replica-notice');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText(
			'The in-browser engine could not start — this tab reads from the server instead. Reload the page to try again.'
		);

		await expandFirstRoot(page);
		await searchAndOpen(page, SEARCHED.name, SEARCHED.id);

		await notice.getByRole('button', { name: 'Dismiss' }).click();
		await expect(notice).toBeHidden();
		expect(shadow, 'shadow comparison').toEqual([]);
	} finally {
		await context.close();
	}
});
