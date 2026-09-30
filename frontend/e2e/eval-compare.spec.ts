/**
 * The Compare and Apply CR dialog, each on the engine and on the server
 * against the real backend, shadow on. The other file is the server's own
 * download with one element renamed, one leaf deleted and one added; Preview
 * lists those three, Replace stages the edits that make the model match, and
 * a CR saved with Create CR previews to the same counts. With an edit staged
 * the engine answers over it and stages on top, where the server's Replace
 * stays disabled.
 *
 * The model is four Blocks: Alpha contains Child (`BlockHasPart`), Beta and
 * Gamma are alone.
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

const ALPHA = 'cmp-block-alpha';
const BETA = 'cmp-block-beta';
const CHILD = 'cmp-block-child';
const GAMMA = 'cmp-block-gamma';
const DELTA = 'cmp-block-delta';

const MODEL = {
	elements: [
		{ id: ALPHA, type_name: 'Block', properties: { name: 'Alpha', mass: 1.0 }, rev: 0 },
		{ id: BETA, type_name: 'Block', properties: { name: 'Beta', mass: 2.0 }, rev: 0 },
		{ id: CHILD, type_name: 'Block', properties: { name: 'Child', mass: 3.0 }, rev: 0 },
		{ id: GAMMA, type_name: 'Block', properties: { name: 'Gamma', mass: 4.0 }, rev: 0 }
	],
	relationships: [
		{
			id: 'cmp-rel-part',
			type_name: 'BlockHasPart',
			source_id: ALPHA,
			target_id: CHILD,
			properties: {},
			rev: 0
		}
	]
};

const RENAMED = 'Beta-renamed';

// One element added, one modified, one deleted: the ops the file asks for.
const FILE_OPS = 3;

test.describe.configure({ mode: 'serial' });

function json(name: string, body: object) {
	return { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(body)) };
}

async function bootstrap(page: Page, side: 'engine' | 'server'): Promise<void> {
	await page.addInitScript(
		(surfaces) => {
			// Create CR takes the `.download` fallback: no native file picker.
			delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
			try {
				localStorage.setItem('dr.surfaces', JSON.stringify(surfaces));
			} catch {
				// A frame without storage has nothing to set.
			}
		},
		{ compare: side }
	);
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, {
		metamodel: METAMODEL_PATH,
		model: json('compare.json', MODEL)
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

function projectId(page: Page): string {
	const match = /\/p\/([^/?#]+)/.exec(page.url());
	if (match === null) throw new Error(`no project id in ${page.url()}`);
	return match[1];
}

type Entity = { id: string; type_name: string; properties: Record<string, unknown>; rev: number };

/** The server's download with Beta renamed, Gamma deleted and Delta added. */
async function otherFile(page: Page) {
	const res = await page.request.get(`/api/v1/projects/${projectId(page)}/model/download`);
	expect(res.ok(), await res.text()).toBeTruthy();
	const body = (await res.json()) as { elements: Entity[]; relationships: unknown[] };
	const elements = body.elements
		.filter((e) => e.id !== GAMMA)
		.map((e) => (e.id === BETA ? { ...e, properties: { ...e.properties, name: RENAMED } } : e));
	elements.push({
		id: DELTA,
		type_name: 'Block',
		properties: { name: 'Delta', mass: 5.0 },
		rev: 0
	});
	return json('other.json', { ...body, elements });
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

async function openDialog(page: Page, item: 'Compare…' | 'Apply CR…'): Promise<Locator> {
	await page.getByTestId('model-menu-trigger').click();
	await page.getByRole('menuitem', { name: item }).click();
	const dialog = page.getByRole('dialog', {
		name: item === 'Compare…' ? /compare models/i : /apply change requests/i
	});
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	return dialog;
}

async function expectCounts(dialog: Locator, modified = 1): Promise<void> {
	const preview = dialog.getByTestId('proposal-preview');
	await expect(preview).toBeVisible({ timeout: 60_000 });
	await expect(preview).toContainText('+1 added');
	await expect(preview).toContainText(`~${modified} modified`);
	await expect(preview).toContainText('−1 deleted');
}

async function previewOtherFile(page: Page, modified = 1): Promise<Locator> {
	const dialog = await openDialog(page, 'Compare…');
	await dialog.getByTestId('mcd-file-input').setInputFiles(await otherFile(page));
	await dialog.getByTestId('mcd-preview').click();
	await expectCounts(dialog, modified);
	return dialog;
}

/** Stages a name edit on Alpha through the inspector. */
async function stageAlphaEdit(page: Page): Promise<void> {
	await row(page, 'Alpha').click();
	const inspector = page.getByTestId('inspector');
	await expect(inspector).toBeVisible({ timeout: 10_000 });
	const nameInput = inspector.locator('input[type="text"]').first();
	await nameInput.fill(`Staged-${Date.now()}`);
	await nameInput.blur();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);
}

for (const side of ['engine', 'server'] as const) {
	test.describe(`with the compare on the ${side}`, () => {
		test('a file previews as one added, one modified, one deleted, and Replace stages its ops', async ({
			page
		}) => {
			test.setTimeout(180_000);
			await bootstrap(page, side);

			const dialog = await previewOtherFile(page);
			await expect(dialog.getByTestId('mcd-staged-note')).toHaveCount(0);

			await dialog.getByTestId('mcd-replace').click();
			await expect(dialog).toBeHidden({ timeout: 30_000 });
			try {
				await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(FILE_OPS);
			} finally {
				await discardAll(page);
			}
		});

		test('with an edit staged, the engine answers over it and Replace stages; the server disables Replace', async ({
			page
		}) => {
			test.setTimeout(180_000);
			await bootstrap(page, side);
			await stageAlphaEdit(page);

			try {
				// The engine diffs the working copy, where Alpha's staged name differs from the
				// file's too; the server diffs the committed model.
				const dialog = await previewOtherFile(page, side === 'engine' ? 2 : 1);
				if (side === 'engine') {
					await expect(dialog.getByTestId('mcd-staged-note')).toHaveText('Includes staged changes');
					await expect(dialog.getByTestId('mcd-replace')).toBeEnabled();
					await dialog.getByTestId('mcd-replace').click();
					await expect(dialog).toBeHidden({ timeout: 30_000 });
					await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBeGreaterThan(1);
					// The staged state has the file's names.
					await expect(row(page, RENAMED)).toBeVisible({ timeout: 10_000 });
				} else {
					await expect(dialog.getByTestId('mcd-replace')).toBeDisabled();
					await expect(dialog.getByTestId('mcd-gate-hint')).toHaveText(
						'Commit or discard your staged edits first.'
					);
					await page.keyboard.press('Escape');
				}
			} finally {
				await discardAll(page);
			}
		});

		test('a CR saved with Create CR previews to the same counts through Apply CR', async ({
			page
		}) => {
			test.setTimeout(180_000);
			await bootstrap(page, side);

			const compare = await openDialog(page, 'Compare…');
			await compare.getByTestId('mcd-file-input').setInputFiles(await otherFile(page));
			const downloading = page.waitForEvent('download', { timeout: 60_000 });
			await compare.getByTestId('mcd-create-cr').click();
			const download = await downloading;
			const cr = await readFile(await download.path());
			await page.keyboard.press('Escape');
			await expect(compare).toBeHidden({ timeout: 10_000 });

			const apply = await openDialog(page, 'Apply CR…');
			await apply.getByTestId('mcd-file-input').setInputFiles({
				name: download.suggestedFilename(),
				mimeType: 'application/json',
				buffer: cr
			});
			await apply.getByTestId('mcd-preview').click();
			await expectCounts(apply);
			await page.keyboard.press('Escape');
			await expect.poll(() => stagedChangeCount(page)).toBe(0);
		});
	});
}
