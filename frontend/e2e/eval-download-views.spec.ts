/**
 * The model download and a view's warnings, each on the engine and on the
 * server against the real backend, shadow on: the engine's file is the
 * server's bytes, with an edit staged too, and a view's warnings follow the
 * staged view ops on the engine where the server's follow the committed view.
 *
 * The model is three Blocks: Alpha contains Child (`BlockHasPart`), Beta is
 * alone. The view places Alpha in "Grouped" and Beta in "Other".
 */

import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { changeBadge } from './helpers/commit';
import { expectLiveFeed } from './helpers/feed';
import { expectReplicaReady } from './helpers/replica';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

const ALPHA = 'dl-block-alpha';
const BETA = 'dl-block-beta';
const CHILD = 'dl-block-child';

const MODEL = {
	elements: [
		{ id: ALPHA, type_name: 'Block', properties: { name: 'Alpha', mass: 1.0 }, rev: 0 },
		{ id: BETA, type_name: 'Block', properties: { name: 'Beta', mass: 2.0 }, rev: 0 },
		{ id: CHILD, type_name: 'Block', properties: { name: 'Child', mass: 3.0 }, rev: 0 }
	],
	relationships: [
		{
			id: 'dl-rel-part',
			type_name: 'BlockHasPart',
			source_id: ALPHA,
			target_id: CHILD,
			properties: {},
			rev: 0
		}
	]
};

const VIEW = {
	name: 'Operational',
	folders: [
		{ name: 'Grouped', folders: [], elements: [ALPHA] },
		{ name: 'Other', folders: [], elements: [BETA] }
	]
};

const BROKEN_VIEW = {
	name: 'BrokenRefs',
	folders: [{ name: 'Group', folders: [], elements: ['does-not-exist'] }]
};

test.describe.configure({ mode: 'serial' });

function json(name: string, body: object) {
	return { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(body)) };
}

async function bootstrap(page: Page, side: 'engine' | 'server', view: object): Promise<void> {
	await page.addInitScript(
		(surfaces) => {
			// The `.download` fallback path: no native file picker.
			delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
			try {
				localStorage.setItem('dr.surfaces', JSON.stringify(surfaces));
			} catch {
				// A frame without storage has nothing to set.
			}
		},
		{ download: side, views: side }
	);
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, {
		metamodel: METAMODEL_PATH,
		model: json('download-views.json', MODEL),
		view: json('spec.view.json', view)
	});
	await expectLiveFeed(page);
	await expectReplicaReady(page);
}

function tree(page: Page): Locator {
	return page.getByRole('tree', { name: /containment tree/i });
}

function row(page: Page, text: string): Locator {
	return tree(page).getByRole('treeitem').filter({ hasText: text }).first();
}

async function expandFolder(page: Page, name: string): Promise<void> {
	const expander = row(page, name).getByRole('button', { name: 'Expand' });
	if (await expander.count()) await expander.click();
}

function projectId(page: Page): string {
	const match = /\/p\/([^/?#]+)/.exec(page.url());
	if (match === null) throw new Error(`no project id in ${page.url()}`);
	return match[1];
}

async function serverDownload(page: Page): Promise<Buffer> {
	const res = await page.request.get(`/api/v1/projects/${projectId(page)}/model/download`);
	expect(res.ok(), await res.text()).toBeTruthy();
	return Buffer.from(await res.body());
}

/** Exports through the model menu; resolves to the downloaded file's bytes. */
async function exportedBytes(page: Page): Promise<Buffer> {
	await page.getByTestId('model-menu-trigger').click();
	const downloading = page.waitForEvent('download', { timeout: 60_000 });
	await page.getByRole('menuitem', { name: 'Export' }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe('model.json');
	return readFile(await download.path());
}

async function stagedChangeCount(page: Page): Promise<number> {
	if ((await changeBadge(page).count()) === 0) return 0;
	const match = ((await changeBadge(page).textContent()) ?? '').match(/(\d+)/);
	return match ? Number(match[1]) : 0;
}

/** Discards every staged change through the commit drawer, releasing the leases they took. */
async function discardAll(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	await drawer.getByRole('button', { name: 'Discard all' }).click();
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
}

function warningCount(page: Page): Locator {
	return page.getByLabel('Active view').getByTitle('View has warnings');
}

async function openIssues(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Validate' }).click();
	await page.getByRole('button', { name: 'Issues', exact: true }).click();
	await page.getByRole('tab', { name: 'Issues' }).click();
}

for (const side of ['engine', 'server'] as const) {
	test.describe(`with the download and the views on the ${side}`, () => {
		test('the export is the server bytes, with nothing staged and with an edit staged', async ({
			page
		}) => {
			test.setTimeout(180_000);
			await bootstrap(page, side, VIEW);

			const committed = await serverDownload(page);
			// On the engine the shadow asks the server for the same file: the request
			// it makes shows the comparison ran, so a clean console is not vacuous.
			const shadowAsked =
				side === 'engine'
					? page.waitForRequest((req) => /\/model\/download$/.test(new URL(req.url()).pathname), {
							timeout: 60_000
						})
					: null;
			expect((await exportedBytes(page)).equals(committed)).toBeTruthy();
			await shadowAsked;

			// Stage a property edit: the file stays the committed state.
			await expandFolder(page, 'Grouped');
			await row(page, 'Alpha').click();
			const inspector = page.getByTestId('inspector');
			await expect(inspector).toBeVisible({ timeout: 10_000 });
			const nameInput = inspector.locator('input[type="text"]').first();
			await nameInput.fill(`Staged-${Date.now()}`);
			await nameInput.blur();
			await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);

			try {
				const staged = await exportedBytes(page);
				expect(staged.equals(committed)).toBeTruthy();
				expect(staged.equals(await serverDownload(page))).toBeTruthy();
			} finally {
				await discardAll(page);
			}
		});

		test('a view naming an unknown element warns in the Issues tab', async ({ page }) => {
			test.setTimeout(120_000);
			await bootstrap(page, side, BROKEN_VIEW);
			await openIssues(page);
			await expect(page.getByText(/does-not-exist/).first()).toBeVisible();
		});

		test('a staged delete of a placed element warns before the commit on the engine only', async ({
			page
		}) => {
			test.setTimeout(120_000);
			await bootstrap(page, side, VIEW);
			await expect(page.getByLabel('Active view').getByText('Operational')).toBeVisible();
			await expect(warningCount(page)).toHaveCount(0);

			// The view places Beta in "Other"; the engine's working model lacks it once the delete is staged.
			await expandFolder(page, 'Other');
			await row(page, 'Beta').getByRole('button', { name: /^Beta/ }).click();
			await page.getByTestId('delete-element').click();
			await page
				.getByRole('dialog', { name: /delete element/i })
				.getByRole('button', { name: 'Delete', exact: true })
				.click();
			try {
				await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBeGreaterThan(0);

				if (side === 'engine') {
					await expect(warningCount(page)).toHaveText('1', { timeout: 15_000 });
				} else {
					await expect(warningCount(page)).toHaveCount(0);
				}
			} finally {
				// Discarding the delete takes the warning away again.
				await discardAll(page);
			}
			await expect(warningCount(page)).toHaveCount(0, { timeout: 15_000 });
		});
	});
}
