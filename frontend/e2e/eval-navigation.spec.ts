/**
 * Navigations and criteria searches served by the engine over the working
 * copy, in the real sandbox against the real backend, with shadow on: a
 * navigation reads a staged navigation it refers to before any commit, one
 * that reaches a script is answered by the server and says so, a criteria
 * search finds a staged rename, and after a commit and a reload the same
 * navigation reads the committed artifacts.
 *
 * Fixture facts (examples/smart-city.model.json): 5 Organization, 10
 * EdgeGateway, 8 Project and 12 SoftwareSystem elements; `e_000002` is
 * `Organization-002`; every SoftwareSystem has outgoing relationships.
 */

import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { expectLiveFeed } from './helpers/feed';
import { changeBadge, commitStaged } from './helpers/commit';
import { expectReplicaReady } from './helpers/replica';
import { headRev, peer, projectIdByName } from './helpers/api-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, '..', '..', 'examples');

const STEP_CODE = 'def step(el): return [r.destination().id for r in el.outgoing()]\n';

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let projectId: string;
/** The committed navigation the staged one refers to, and the one that refers to it. */
let referred: { id: string; name: string };
let referring: { id: string; name: string };

const scope = (type: string) => ({
	kind: 'path',
	schema_version: 3,
	start: { kind: 'scope', types: [type], criteria: [] },
	steps: [],
	exclude_visited: true
});

/** One `create_artifact` committed by the peer; resolves to its real id. */
async function peerCreateNavigation(name: string, payload: object): Promise<string> {
	const commit = await api.post(`projects/${projectId}/commits`, {
		data: {
			base_rev: await headRev(api, projectId),
			ops: [
				{
					kind: 'create_artifact',
					temp_id: 'tmp_nav',
					artifact_kind: 'navigation',
					name,
					payload
				}
			],
			message: `peer navigation ${name}`,
			lock_tokens: [],
			ack_errors: true
		}
	});
	expect(commit.ok(), await commit.text()).toBeTruthy();
	return ((await commit.json()) as { id_map: Record<string, string> }).id_map.tmp_nav;
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
	const stamp = Date.now();
	const referredName = `eval-referred-${stamp}`;
	referred = {
		id: await peerCreateNavigation(referredName, scope('Organization')),
		name: referredName
	};
	const referringName = `eval-referring-${stamp}`;
	referring = {
		id: await peerCreateNavigation(referringName, {
			kind: 'set_op',
			schema_version: 3,
			op: 'union',
			operands: [
				{ ref: referred.id, step_index: null },
				{ definition: scope('Project'), step_index: null }
			]
		}),
		name: referringName
	};
});

test.afterAll(async () => {
	await api?.dispose();
});

async function openReady(page: Page): Promise<void> {
	await openDefaultProject(page);
	await expectLiveFeed(page);
	await expectReplicaReady(page);
}

/** The POSTs the page sends from now on to a route ending in `suffix`. */
function recordPosts(page: Page, suffix: string): string[] {
	const seen: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith(suffix)) {
			seen.push(request.url());
		}
	});
	return seen;
}

/** Opens a navigation from the sidebar's library; its tab panel. */
async function openNavigation(page: Page, id: string): Promise<Locator> {
	const row = page.locator(`[data-artifact-id="${id}"]`);
	await expect(row).toBeVisible({ timeout: 15_000 });
	await row.dblclick();
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByTestId('results-dock')).toBeVisible({ timeout: 10_000 });
	return tabpanel;
}

/** Closes the navigation tab named `name`. */
async function closeTab(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: `Close ${name}` }).click();
}

async function stagedChangeCount(page: Page): Promise<number> {
	if ((await changeBadge(page).count()) === 0) return 0;
	const match = ((await changeBadge(page).textContent()) ?? '').match(/(\d+)/);
	return match ? Number(match[1]) : 0;
}

test('a navigation reads the staged navigation it refers to, then the committed one after a reload', async ({
	page
}) => {
	test.setTimeout(180_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openReady(page);
	const evaluations = recordPosts(page, '/navigations/evaluate');

	// Committed: the referred navigation's 5 Organizations and the 8 Projects.
	let tabpanel = await openNavigation(page, referring.id);
	let dock = tabpanel.getByTestId('results-dock');
	await expect(dock.getByTestId('results-status')).toContainText('✓ 13 chains', {
		timeout: 15_000
	});
	await expect(dock).toContainText('Organization-001');
	// Shadow on and nothing staged: the server was asked the same.
	await expect.poll(() => evaluations.length, { timeout: 10_000 }).toBeGreaterThan(0);
	await closeTab(page, referring.name);

	// Stage the referred navigation onto the 10 EdgeGateways.
	tabpanel = await openNavigation(page, referred.id);
	await tabpanel
		.getByTestId('path-card')
		.first()
		.getByText('Organization', { exact: true })
		.click();
	await page.getByPlaceholder('Filter types…').fill('Organization');
	await page.getByRole('checkbox', { name: 'Organization', exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('EdgeGateway');
	await page.getByRole('checkbox', { name: 'EdgeGateway', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(tabpanel.getByTestId('results-dock').getByTestId('results-status')).toContainText(
		'✓ 10 chains',
		{ timeout: 15_000 }
	);
	await tabpanel.getByRole('button', { name: /^Save( \*)?$/ }).click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);
	await closeTab(page, referred.name);
	const staged = evaluations.length;

	// The referring one reads the staged one: 10 EdgeGateways and 8 Projects.
	tabpanel = await openNavigation(page, referring.id);
	dock = tabpanel.getByTestId('results-dock');
	await expect(dock.getByTestId('results-status')).toContainText('✓ 18 chains', {
		timeout: 15_000
	});
	await expect(dock).toContainText('EdgeGateway-001');
	await expect(dock).not.toContainText('Organization-001');

	// Staged too, and edited again: the staged referred one less the Projects.
	const renamed = `${referring.name}-renamed`;
	await tabpanel.getByTestId('nav-name').fill(renamed);
	await tabpanel.getByRole('button', { name: /^Save( \*)?$/ }).click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(2);
	await tabpanel.getByRole('combobox', { name: 'Combination operator' }).selectOption('difference');
	await expect(dock.getByTestId('results-status')).toContainText('✓ 10 chains', {
		timeout: 15_000
	});
	await expect(dock).toContainText('EdgeGateway-001');
	await expect(dock.getByTestId('nav-fallback')).toHaveCount(0);
	await tabpanel.getByRole('button', { name: /^Save( \*)?$/ }).click();
	await expect(tabpanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	// While anything is staged the engine answers alone: the server was never asked.
	expect(evaluations.length).toBe(staged);

	await commitStaged(page, 'eval navigation: staged refs');
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);

	// A tab restored by the reload may evaluate before the replica's indicator is read.
	const afterReload = recordPosts(page, '/navigations/evaluate');
	await page.reload();
	await expectLiveFeed(page);
	await expectReplicaReady(page);
	tabpanel = await openNavigation(page, referring.id);
	dock = tabpanel.getByTestId('results-dock');
	await expect(tabpanel.getByTestId('nav-name')).toHaveValue(renamed);
	await expect(dock.getByTestId('results-status')).toContainText('✓ 10 chains', {
		timeout: 15_000
	});
	await expect(dock).toContainText('EdgeGateway-001');
	await expect(dock.getByTestId('nav-fallback')).toHaveCount(0);
	// Nothing staged: the shadow held the engine's answer to the server's.
	await expect.poll(() => afterReload.length, { timeout: 10_000 }).toBeGreaterThan(0);
});

test('a navigation that reaches a script is answered by the server and says so', async ({
	page
}) => {
	test.setTimeout(120_000);
	await openReady(page);

	await page.getByRole('button', { name: 'New navigation' }).click();
	const tabpanel = page.getByRole('tabpanel');
	const dock = tabpanel.getByTestId('results-dock');
	await expect(dock).toContainText('Pick what to start from');
	await tabpanel.getByText('any element', { exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem', exact: true }).click();
	await page.keyboard.press('Escape');
	const status = dock.getByTestId('results-status');
	await expect(status).toContainText('✓ 12 chains', { timeout: 15_000 });
	await expect(dock.getByTestId('nav-fallback')).toHaveCount(0);

	await tabpanel.getByTestId('add-script-step').click();
	const stepRow = tabpanel.getByTestId('script-step');
	await expect(stepRow).toHaveCount(1);
	await stepRow.getByTestId('snippet-mode-inline').click();
	const answered = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST' &&
			response.url().endsWith('/navigations/evaluate') &&
			(response.request().postData() ?? '').includes('r.destination().id'),
		{ timeout: 30_000 }
	);
	await stepRow.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Delete');
	await page.keyboard.insertText(STEP_CODE);
	const response = await answered;
	expect(response.ok(), await response.text()).toBeTruthy();
	const server = (await response.json()) as { total: number; warnings: unknown[] };

	const navWarnings = dock.getByTestId('nav-warnings');
	if (await navWarnings.isVisible().catch(() => false)) {
		const title = (await navWarnings.getAttribute('title')) ?? '';
		test.skip(
			title.includes('unavailable'),
			'snippet runner not booted (guest binary not fetched)'
		);
	}
	await expect(dock.getByTestId('nav-fallback')).toHaveText(
		'Reads committed state: this navigation runs a script on the server.',
		{ timeout: 30_000 }
	);
	expect(server.total).toBeGreaterThan(12);
	await expect(status).toContainText(`✓ ${server.total} chains`, { timeout: 30_000 });
	await expect(dock.locator('tbody tr').first()).toBeVisible();
	await expect(navWarnings).toBeHidden();
});

test('the advanced search finds a staged rename', async ({ page }) => {
	test.setTimeout(120_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openReady(page);
	const searches = recordPosts(page, '/model/search');

	const search = async (text: string): Promise<Locator> => {
		await page.getByTestId('advanced-search-button').click();
		const dialog = page.getByRole('dialog', { name: /advanced search/i });
		await expect(dialog).toBeVisible();
		// The dialog keeps its criteria between searches.
		const value = dialog.locator('input[placeholder="value"]');
		if ((await value.count()) === 0) {
			await dialog.getByRole('button', { name: 'Add criterion' }).click();
			await page.getByRole('menuitem', { name: 'Name / ID' }).click();
		}
		await expect(value).toHaveCount(1);
		await value.fill(text);
		await dialog.getByRole('button', { name: 'Search', exact: true }).click();
		await expect(dialog).toBeHidden();
		const panel = page.getByTestId('results-panel');
		await expect(panel).toBeVisible();
		return panel;
	};

	// Committed: the engine answers, the shadow asks the server the same.
	let panel = await search('Organization-002');
	await expect(panel.getByRole('button', { name: /Organization-002/ })).toBeVisible({
		timeout: 10_000
	});
	await expect.poll(() => searches.length, { timeout: 10_000 }).toBeGreaterThan(0);
	await panel.getByRole('button', { name: /Organization-002/ }).click();
	const nameInput = page.getByTestId('inspector').locator('input[type="text"]').first();
	await expect(nameInput).toHaveValue('Organization-002', { timeout: 10_000 });
	await panel.getByRole('button', { name: 'Close results' }).click();

	const renamed = `eval-renamed-${Date.now()}`;
	await nameInput.fill(renamed);
	await nameInput.blur();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);
	const before = searches.length;
	panel = await search(renamed);
	await expect(panel.getByRole('button', { name: new RegExp(renamed) })).toBeVisible({
		timeout: 10_000
	});
	// Staged: the engine answered alone, the server never asked.
	expect(searches.length).toBe(before);
	await panel.getByRole('button', { name: 'Close results' }).click();

	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const discardAll = drawer.getByRole('button', { name: 'Discard all' });
	await expect(discardAll).toBeEnabled({ timeout: 10_000 });
	await discardAll.click();
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
});
