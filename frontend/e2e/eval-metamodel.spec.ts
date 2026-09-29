/**
 * Metamodel previews answered by the engine over the working copy, in the
 * real sandbox against the real backend, with the `metamodel` surface on the
 * engine, its default, and shadow on except where a case says otherwise: a
 * required property appended to a type lists the elements it fails in "Now
 * failing" with no staged note, a staged element edit shows the note and moves
 * the counts, the commit drawer's preview of the staged rebind never sends the
 * rebind to the server (shadow off, to watch the requests), and the same
 * preview with shadow on is compared to the server's and stays silent.
 *
 * Fixture facts (examples/smart-city.metamodel.yaml, smart-city.model.json):
 * 12 SoftwareSystem elements, each with a string `name`; the type's property
 * list is one `repository_url` line.
 */

import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { expectLiveFeed } from './helpers/feed';
import { changeBadge } from './helpers/commit';
import { expectReplicaReady } from './helpers/replica';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, '..', '..', 'examples');
const METAMODEL_PATH = join(EXAMPLES, 'smart-city.metamodel.yaml');

const ANCHOR =
	'      - {name: repository_url, datatype: string, multiplicity: "0..1", pattern: \'^https://.+\'}\n';
const NEW_PROPERTY = '      - {name: e2e_owner, datatype: string, multiplicity: "1"}\n';

test.describe.configure({ mode: 'serial' });

async function openReady(page: Page): Promise<void> {
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await expectLiveFeed(page);
	await expectReplicaReady(page);
}

async function stagedChangeCount(page: Page): Promise<number> {
	if ((await changeBadge(page).count()) === 0) return 0;
	const match = ((await changeBadge(page).textContent()) ?? '').match(/(\d+)/);
	return match ? Number(match[1]) : 0;
}

/** Opens the Metamodel tab in its YAML view and returns its editor's content. */
async function openYaml(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Metamodel', exact: true }).click();
	await page.getByRole('button', { name: 'YAML', exact: true }).click();
	const content = page.getByTestId('metamodel-editor').locator('.cm-content');
	await expect(content).toBeVisible({ timeout: 15_000 });
	return content;
}

/** Replaces the buffer with the example's YAML plus the required property. */
async function appendRequiredProperty(page: Page, content: Locator): Promise<void> {
	const yaml = await readFile(METAMODEL_PATH, 'utf8');
	expect(yaml).toContain(ANCHOR);
	await content.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Delete');
	// insertText: typing would let the editor auto-indent the YAML.
	await page.keyboard.insertText(yaml.replace(ANCHOR, ANCHOR + NEW_PROPERTY));
}

function nameInput(page: Page): Locator {
	return page.getByTestId('inspector').locator('input[type="text"]').first();
}

/** Stages a 201-character name (past `max_length` 200) on SoftwareSystem-001. */
async function stageTooLongName(page: Page): Promise<void> {
	await page.getByPlaceholder('Filter by name, type, id…').fill('SoftwareSystem-001');
	const hit = page.getByRole('option').first();
	await expect(hit).toBeVisible({ timeout: 10_000 });
	await hit.click();
	await expect(nameInput(page)).toHaveValue('SoftwareSystem-001', { timeout: 10_000 });
	await nameInput(page).fill('x'.repeat(201));
	await nameInput(page).blur();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBeGreaterThan(0);
}

/**
 * Discards the staged edits and the metamodel draft through the commit drawer.
 * A spec that leaves the metamodel lease held blocks the specs after it.
 */
async function discardAll(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const button = drawer.getByRole('button', { name: 'Discard all' });
	await expect(button).toBeEnabled({ timeout: 10_000 });
	// A staged 201-character name widens the drawer past the viewport: focus and
	// Enter need no pointer geometry.
	await button.focus();
	await page.keyboard.press('Enter');
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
}

async function preview(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Preview changes' }).click();
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByText(/now failing$/)).toBeVisible({ timeout: 60_000 });
	return tabpanel;
}

/** The "errors A → B" pair of the open preview. */
async function errorCounts(tabpanel: Locator): Promise<[number, number]> {
	const text = (await tabpanel.getByText(/^errors \d+ → \d+$/).textContent()) ?? '';
	const match = text.match(/(\d+) → (\d+)/);
	if (!match) throw new Error(`no error counts in ${text}`);
	return [Number(match[1]), Number(match[2])];
}

test.beforeAll(async ({ browser }) => {
	test.setTimeout(120_000);
	// Earlier specs leave the shared project holding other content.
	const page = await browser.newPage();
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, {
		metamodel: METAMODEL_PATH,
		model: join(EXAMPLES, 'smart-city.model.json'),
		view: join(EXAMPLES, 'smart-city.view.json')
	});
	await page.close();
});

test('a required property appended to a type is previewed by the engine, with no staged note', async ({
	page
}) => {
	test.setTimeout(180_000);
	await openReady(page);
	const content = await openYaml(page);
	await appendRequiredProperty(page, content);
	const tabpanel = await preview(page);
	await expect(tabpanel.getByText(/^\d+ now failing$/)).toHaveText('12 now failing');
	await expect(tabpanel.getByText(/e2e_owner/).first()).toBeVisible();
	await expect(tabpanel.getByTestId('metamodel-staged-note')).toHaveCount(0);
	await tabpanel.getByRole('button', { name: 'Discard changes' }).click();
	await expect(tabpanel.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);
});

test('a staged element edit shows the note and moves the counts', async ({ page }) => {
	test.setTimeout(180_000);
	await openReady(page);
	const content = await openYaml(page);
	await appendRequiredProperty(page, content);
	const tabpanel = await preview(page);
	await expect(tabpanel.getByTestId('metamodel-staged-note')).toHaveCount(0);
	const [before] = await errorCounts(tabpanel);

	// Stage a facet violation on an element: the preview reads the working copy.
	await stageTooLongName(page);
	await page.getByRole('button', { name: 'Metamodel', exact: true }).click();
	await preview(page);
	await expect(tabpanel.getByTestId('metamodel-staged-note')).toBeVisible({ timeout: 10_000 });
	await expect
		.poll(async () => (await errorCounts(tabpanel))[0], { timeout: 30_000 })
		.toBe(before + 1);
	await discardAll(page);
});

test("the commit drawer's rebind preview never sends the rebind to the server", async ({
	page
}) => {
	test.setTimeout(180_000);
	const previews: string[] = [];
	// The shadow re-asks the server for the whole batch; this spec watches what the
	// answer itself sends, so it runs with the shadow off.
	await page.addInitScript(() => {
		try {
			localStorage.removeItem('dr.shadow');
		} catch {
			// A frame without storage has nothing to remove.
		}
	});
	page.on('request', (request) => {
		if (request.url().includes('/commits/preview')) previews.push(request.postData() ?? '');
	});
	await openReady(page);
	const content = await openYaml(page);
	await appendRequiredProperty(page, content);
	await preview(page);
	await stageTooLongName(page);
	previews.length = 0;

	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	await expect(drawer.getByText(/loading changes/i)).toBeHidden({ timeout: 30_000 });
	await expect(drawer.getByRole('button', { name: /^Commit/ })).toBeEnabled({ timeout: 30_000 });
	expect(previews.filter((body) => body.includes('metamodel.rebind'))).toEqual([]);
	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await discardAll(page);
});

test("the commit drawer's rebind preview agrees with the server's under the shadow", async ({
	page
}) => {
	test.setTimeout(180_000);
	await openReady(page);
	const content = await openYaml(page);
	await appendRequiredProperty(page, content);
	await preview(page);
	await stageTooLongName(page);

	// The shadow asks the server for the whole batch, rebind included; its answer
	// is compared before the fixture judges the run.
	const probe = page.waitForResponse(
		(response) =>
			response.url().includes('/commits/preview') &&
			(response.request().postData() ?? '').includes('metamodel.rebind'),
		{ timeout: 60_000 }
	);
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	await expect(drawer.getByText(/loading changes/i)).toBeHidden({ timeout: 30_000 });
	await expect(drawer.getByRole('button', { name: /^Commit/ })).toBeEnabled({ timeout: 30_000 });
	expect((await probe).status()).toBe(200);
	// The comparison runs after the answer lands, and a mismatch is re-tested
	// before it is reported.
	await page.waitForTimeout(3_000);
	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await discardAll(page);
});
