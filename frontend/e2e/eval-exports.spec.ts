/**
 * Exports rendered by the engine over the working copy, in the real sandbox
 * against the real backend, with shadow on and the `exports` surface forced
 * to the engine: a table's CSV is the server's bytes, an exporter with two
 * entries and a manifest downloads a zip whose entries and `model_rev` are
 * the expected ones, a staged rename lands in the file behind the
 * `export-staged-note`, and a table with a script column is the server's file
 * behind `export-fallback`.
 *
 * Fixture facts (examples/smart-city.model.json): 12 SoftwareSystem
 * elements, "SoftwareSystem-001".."SoftwareSystem-012", each with a string
 * `name`.
 */

import { test, expect } from './fixtures';
import type { APIRequestContext, Download, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { expectLiveFeed } from './helpers/feed';
import { changeBadge } from './helpers/commit';
import { expectReplicaReady } from './helpers/replica';
import { headRev, peer, projectIdByName } from './helpers/api-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, '..', '..', 'examples');

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let projectId: string;
const stamp = Date.now();
const TABLE_NAME = `eval-exp-table-${stamp}`;
const SCRIPT_TABLE_NAME = `eval-exp-script-${stamp}`;
const EXPORTER_NAME = `eval-exp-exporter-${stamp}`;
let tableId: string;
let scriptTableId: string;
let exporterId: string;

const systemColumns = [
	{ kind: 'element', source: { kind: 'row' }, header: 'System' },
	{ kind: 'property', source: { kind: 'row' }, name: 'name', header: 'Name' }
];
const rowSource = { kind: 'scope', types: ['SoftwareSystem'] };

/** One `create_artifact` committed by the peer; resolves to its real id. */
async function peerCreate(kind: string, name: string, payload: object): Promise<string> {
	const commit = await api.post(`projects/${projectId}/commits`, {
		data: {
			base_rev: await headRev(api, projectId),
			ops: [{ kind: 'create_artifact', temp_id: 'tmp_a', artifact_kind: kind, name, payload }],
			message: `peer ${kind} ${name}`,
			lock_tokens: [],
			ack_errors: true
		}
	});
	expect(commit.ok(), await commit.text()).toBeTruthy();
	return ((await commit.json()) as { id_map: Record<string, string> }).id_map.tmp_a;
}

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
	tableId = await peerCreate('table', TABLE_NAME, {
		row_source: rowSource,
		columns: systemColumns
	});
	scriptTableId = await peerCreate('table', SCRIPT_TABLE_NAME, {
		row_source: rowSource,
		columns: [
			...systemColumns,
			{
				kind: 'script',
				snippet: { definition: { code: 'def value(els): return 2\n' } },
				header: 'Computed'
			}
		]
	});
	exporterId = await peerCreate('exporter', EXPORTER_NAME, {
		output: { mode: 'zip', manifest: true },
		entries: [
			{ source: { ref: tableId }, name: 'alpha', format: 'json' },
			{ source: { ref: tableId }, name: 'beta', folder: 'sub', format: 'csv' }
		]
	});
});

test.afterAll(async () => {
	await api?.dispose();
});

async function openReady(page: Page): Promise<void> {
	// The `.download` fallback path: no native file picker.
	await page.addInitScript(() => {
		delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
		try {
			localStorage.setItem('dr.surfaces', JSON.stringify({ exports: 'engine' }));
		} catch {
			// A frame without storage has nothing to set.
		}
	});
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await expectLiveFeed(page);
	await expectReplicaReady(page);
}

async function openArtifact(page: Page, id: string): Promise<void> {
	const row = page.locator(`[data-artifact-id="${id}"]`);
	await expect(row).toBeVisible({ timeout: 15_000 });
	await row.dblclick();
}

/** Exports the open table as `format` through the Export menu and dialog. */
async function exportTable(page: Page, format: string): Promise<Download> {
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByTestId('table-row')).toHaveCount(12, { timeout: 15_000 });
	await tabpanel.getByTestId('table-export-button').click();
	await page.getByTestId(`table-export-${format}`).click();
	const dialog = page.getByTestId('table-export-dialog');
	await expect(dialog).toBeVisible();
	const download = page.waitForEvent('download', { timeout: 60_000 });
	await dialog.getByTestId('export-confirm').click();
	return download;
}

async function stagedChangeCount(page: Page): Promise<number> {
	if ((await changeBadge(page).count()) === 0) return 0;
	const match = ((await changeBadge(page).textContent()) ?? '').match(/(\d+)/);
	return match ? Number(match[1]) : 0;
}

test("a table's CSV is the server's bytes", async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	await openArtifact(page, tableId);
	const download = await exportTable(page, 'csv');
	expect(download.suggestedFilename()).toMatch(/\.csv$/);
	const engineBytes = await readFile(await download.path());
	await expect(page.getByRole('tabpanel').getByTestId('export-fallback')).toHaveCount(0);

	// The page asks the server for the same definition, with the API client's headers.
	const serverBytes = await page.evaluate(
		async ({ project, artifact }) => {
			const res = await fetch(`/api/v1/projects/${project}/tables/export`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'data-rover' },
				body: JSON.stringify({ artifact_id: artifact, format: 'csv' })
			});
			if (!res.ok) throw new Error(`export ${res.status}`);
			return Array.from(new Uint8Array(await res.arrayBuffer()));
		},
		{ project: projectId, artifact: tableId }
	);
	const text = engineBytes.toString('utf8');
	expect(text).toContain('SoftwareSystem-001');
	expect(Buffer.from(serverBytes).equals(engineBytes)).toBeTruthy();
});

test('an exporter with two entries and a manifest downloads a zip', async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	await openArtifact(page, exporterId);
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByTestId('export-entry-1')).toBeVisible({ timeout: 15_000 });
	const downloading = page.waitForEvent('download', { timeout: 60_000 });
	await tabpanel.getByTestId('exporter-run').click();
	const download = await downloading;
	expect(download.suggestedFilename()).toMatch(/\.zip$/);
	await expect(tabpanel.getByTestId('export-fallback')).toHaveCount(0);

	const entries = unzipSync(new Uint8Array(await readFile(await download.path())));
	expect(Object.keys(entries).sort()).toEqual(['alpha.json', 'manifest.json', 'sub/beta.csv']);
	const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json'])) as {
		model_rev: number;
	};
	expect(manifest.model_rev).toBe(await headRev(api, projectId));
});

test("a staged rename is in the table's CSV, behind the staged note", async ({ page }) => {
	test.setTimeout(120_000);
	await openReady(page);
	await openArtifact(page, tableId);
	const tabpanel = page.getByRole('tabpanel');
	const rows = tabpanel.getByTestId('table-row');
	await expect(rows).toHaveCount(12, { timeout: 15_000 });
	await expect(tabpanel.getByTestId('export-staged-note')).toHaveCount(0);

	await rows.last().locator('button').first().click();
	const inspector = page.getByTestId('inspector');
	await expect(inspector).toBeVisible({ timeout: 10_000 });
	const nameInput = inspector.locator('input[type="text"]').first();
	const renamed = `Staged-e2e-${Date.now()}`;
	await nameInput.fill(renamed);
	await nameInput.blur();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);
	await expect(tabpanel.getByTestId('export-staged-note')).toBeVisible({ timeout: 10_000 });

	try {
		const download = await exportTable(page, 'csv');
		expect((await readFile(await download.path())).toString('utf8')).toContain(renamed);
	} finally {
		await page.getByRole('button', { name: 'Commit', exact: true }).click();
		const drawer = page.getByRole('dialog', { name: /commit changes/i });
		await expect(drawer).toBeVisible({ timeout: 10_000 });
		const discardAll = drawer.getByRole('button', { name: 'Discard all' });
		await expect(discardAll).toBeEnabled({ timeout: 10_000 });
		await discardAll.click();
		await expect(drawer).toBeHidden({ timeout: 10_000 });
		await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
	}
});

test('a table with a script column exports through the server behind the fallback note', async ({
	page
}) => {
	test.setTimeout(180_000);
	await openReady(page);
	await openArtifact(page, scriptTableId);
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByTestId('export-fallback')).toHaveCount(0);
	const download = await exportTable(page, 'csv');
	expect(download.suggestedFilename()).toMatch(/\.csv$/);
	await expect(tabpanel.getByTestId('export-fallback')).toBeVisible({ timeout: 30_000 });
});
