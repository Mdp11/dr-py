/**
 * With the tables surface switched to the server, a table that reaches a
 * script shows the "Scripts need the engine" state instead of computed
 * cells: the server does not evaluate scripts.
 *
 * Fixture facts (examples/smart-city.model.json): 12 SoftwareSystem elements.
 */

import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { expectLiveFeed } from './helpers/feed';
import { headRev, peer, projectIdByName } from './helpers/api-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, '..', '..', 'examples');

let api: APIRequestContext;
let projectId: string;
const SCRIPT_TABLE_NAME = `need-engine-${Date.now()}`;
let scriptTableId: string;

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
	scriptTableId = await peerCreate('table', SCRIPT_TABLE_NAME, {
		row_source: { kind: 'scope', types: ['SoftwareSystem'] },
		columns: [
			{ kind: 'element', source: { kind: 'row' }, header: 'System' },
			{
				kind: 'script',
				snippet: { definition: { code: 'def value(els): return 2\n' } },
				header: 'Computed'
			}
		]
	});
});

test.afterAll(async () => {
	await api?.dispose();
});

test('a script table with the tables surface on the server says scripts need the engine', async ({
	page
}) => {
	test.setTimeout(120_000);
	await page.addInitScript(() => {
		try {
			localStorage.setItem('dr.surfaces', JSON.stringify({ tables: 'server' }));
		} catch {
			// A frame without storage has nothing to set.
		}
	});
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await expectLiveFeed(page);

	const row = page.locator(`[data-artifact-id="${scriptTableId}"]`);
	await expect(row).toBeVisible({ timeout: 15_000 });
	await row.dblclick();
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByTestId('scripts-need-engine')).toContainText(
		'Scripts need the engine',
		{ timeout: 30_000 }
	);
	await expect(tabpanel.getByTestId('table-row')).toHaveCount(0);
});
