/**
 * The replica in the real sandbox, against the real backend: it opens, it
 * follows the user's own commits, a peer's commits and a batch the feed never
 * announced, and a second open reads the snapshot from the browser's cache.
 * The peer is a second API client with its own cookie jar.
 */

import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { login, openDefaultProject } from './helpers/auth';
import { expectLiveFeed } from './helpers/feed';
import { commitStaged } from './helpers/commit';
import { expectReplicaReady, replica, replicaRev, watchPhases } from './helpers/replica';
import {
	elementIds,
	headRev,
	peer,
	peerCommit,
	projectIdByName,
	silentBump,
	snapshotRev
} from './helpers/api-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, '..', '..', 'examples');

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let projectId: string;
let targets: string[];

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
	targets = await elementIds(api, projectId, 3);
});

test.afterAll(async () => {
	await api?.dispose();
});

async function openReady(page: Page): Promise<void> {
	await openDefaultProject(page);
	await expectLiveFeed(page);
	await expectReplicaReady(page);
}

test('the replica opens in the real sandbox', async ({ page }) => {
	test.setTimeout(120_000);
	// Watched from the picker on: the login page's session probe answers 401 by design.
	await login(page);
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	page.on('pageerror', (error) => errors.push(error.message));
	await page.getByText('Smart City').click();
	await page.waitForURL('**/p/**');
	await expectLiveFeed(page);
	await expectReplicaReady(page);
	const indicator = replica(page);
	await expect(indicator).toHaveAttribute('data-isolated', 'true');
	// Counts the sandbox PAGE's violations; the worker's are not reported.
	await expect(indicator).toHaveAttribute('data-csp-violations', '0');
	expect(await replicaRev(page)).toBe(await headRev(api, projectId));
	expect(errors).toEqual([]);
});

test('an own commit reaches it', async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	const before = await replicaRev(page);

	const filterButton = page.locator('[aria-label="Filter stereotypes"]');
	await filterButton.click();
	const selectAll = page.getByRole('button', { name: 'Select all', exact: true });
	await expect(selectAll).toBeVisible({ timeout: 5_000 });
	await selectAll.click();
	await page.keyboard.press('Escape');

	const tree = page.getByRole('tree', { name: /containment tree/i });
	await expect(tree.getByRole('treeitem').first()).toBeVisible({ timeout: 15_000 });
	await tree.getByRole('treeitem').first().locator('button[aria-label]').first().click();
	const pick = tree.locator('button.flex-1').first();
	await expect(pick).toBeVisible({ timeout: 10_000 });
	await pick.click();
	const nameInput = page.getByTestId('inspector').locator('input[type="text"]').first();
	await expect(nameInput).toBeVisible({ timeout: 10_000 });
	await nameInput.fill(`replica-own-${Date.now()}`);
	await nameInput.blur();
	await commitStaged(page, 'rename for the replica');

	const head = await headRev(api, projectId);
	expect(head).toBeGreaterThan(before);
	await expect(replica(page)).toHaveAttribute('data-rev', String(head), { timeout: 10_000 });
	await expect(replica(page)).toHaveAttribute('data-phase', 'ready');
});

test("a peer's commit reaches it", async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	const phases = await watchPhases(page);

	const rev = await peerCommit(api, projectId, {
		elementId: targets[1],
		patch: { name: `replica-peer-${Date.now()}` }
	});
	await expect(replica(page)).toHaveAttribute('data-rev', String(rev), { timeout: 10_000 });
	await expect(replica(page)).toHaveAttribute('data-phase', 'ready');
	expect(await phases()).toEqual(['ready']);
});

test('a silent bump is healed by the next delta', async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	const phases = await watchPhases(page);
	const replicaCalls: string[] = [];
	page.on('request', (request) => {
		const path = new URL(request.url()).pathname;
		if (path.includes('/replica/')) replicaCalls.push(path.replace(/^.*\/replica\//, ''));
	});

	const silent = await silentBump(api, projectId, {
		elementId: targets[2],
		patch: { name: `replica-silent-${Date.now()}` }
	});
	// The feed said nothing: the replica stays where it was.
	expect(await replicaRev(page)).toBe(silent - 1);

	const rev = await peerCommit(api, projectId, {
		elementId: targets[1],
		patch: { name: `replica-after-${Date.now()}` }
	});
	expect(rev).toBe(silent + 1);
	await expect(replica(page)).toHaveAttribute('data-rev', String(rev), { timeout: 20_000 });
	await expect(replica(page)).toHaveAttribute('data-phase', 'ready');
	test.info().annotations.push({
		type: 'road',
		description: `phases ${JSON.stringify(await phases())}, replica calls ${JSON.stringify(replicaCalls)}`
	});
});

/** The snapshot rev the page's cache holds for the project, or null. */
async function cachedRev(page: Page, id: string): Promise<number | null> {
	return page.evaluate(async (projectId) => {
		// Opening a database that does not exist would create it, without its store.
		const dbs = await indexedDB.databases();
		if (!dbs.some((db) => db.name === 'datarover-snapshots')) return null;
		return new Promise<number | null>((resolve) => {
			const open = indexedDB.open('datarover-snapshots');
			open.onerror = () => resolve(null);
			open.onsuccess = () => {
				const db = open.result;
				const done = (rev: number | null) => {
					db.close();
					resolve(rev);
				};
				if (!db.objectStoreNames.contains('snapshots')) return done(null);
				const get = db.transaction('snapshots').objectStore('snapshots').get(projectId);
				get.onsuccess = () => done((get.result as { rev: number } | undefined)?.rev ?? null);
				get.onerror = () => done(null);
			};
		});
	}, id);
}

test('the second open is a cache hit', async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	const before = await snapshotRev(api, projectId);
	// The cache row is written behind the open; wait for it before reloading.
	await expect.poll(() => cachedRev(page, projectId), { timeout: 10_000 }).toBe(before);

	await page.reload();
	await expectReplicaReady(page);
	const after = await snapshotRev(api, projectId);
	test.info().annotations.push({ type: 'snapshot', description: `rev ${before} -> ${after}` });
	await expect(replica(page)).toHaveAttribute(
		'data-source',
		after === before ? 'cache' : 'network'
	);
	expect(await replicaRev(page)).toBe(await headRev(api, projectId));
});
