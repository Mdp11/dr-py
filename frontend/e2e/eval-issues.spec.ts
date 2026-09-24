/**
 * Live validation issues served by the engine over the working copy, in the
 * real sandbox against the real backend, with shadow on: a staged facet
 * violation shows in the Issues panel before any commit and Discard clears
 * it, strict mode blocks the commit dialog on it, Validate marks it "new" in
 * the overlay, and after the commit it reads "on server".
 *
 * Fixture fact (examples/smart-city.metamodel.yaml): `name` (NamedElement)
 * has `max_length: 200`, so a 201-character rename is a facet CONFORMANCE
 * error: `name: length 201 exceeds max_length 200`.
 */

import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';
import { expectLiveFeed } from './helpers/feed';
import { changeBadge } from './helpers/commit';
import { expectReplicaReady } from './helpers/replica';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(__dirname, '..', '..', 'examples');

const TOO_LONG = 'x'.repeat(201);
const TOO_LONG_MESSAGE = 'name: length 201 exceeds max_length 200';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
	page.on('dialog', (dialog) => void dialog.accept());
});

function nameInput(page: Page): Locator {
	return page.getByTestId('inspector').locator('input[type="text"]').first();
}

function searchInput(page: Page): Locator {
	return page.getByPlaceholder('Filter by name, type, id…');
}

/** Searches the sidebar for `name` and opens the hit whose id is `id`. */
async function searchAndOpen(page: Page, name: string, id: string): Promise<void> {
	await searchInput(page).fill(name);
	const hit = page.getByRole('option').and(page.locator(`[title="${id}"]`));
	await expect(hit).toBeVisible({ timeout: 10_000 });
	await hit.click();
	await expect(nameInput(page)).toHaveValue(name, { timeout: 10_000 });
}

async function stagedChangeCount(page: Page): Promise<number> {
	if ((await changeBadge(page).count()) === 0) return 0;
	const match = ((await changeBadge(page).textContent()) ?? '').match(/(\d+)/);
	return match ? Number(match[1]) : 0;
}

/** Opens (or focuses) the singleton Issues tab and returns its tabpanel. */
async function issuesTab(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Issues', exact: true }).click();
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel).toBeVisible({ timeout: 10_000 });
	return tabpanel;
}

/** The issue row (a list item) whose message is `message`. */
function issueRow(tabpanel: Locator, message: string): Locator {
	return tabpanel.locator('li').filter({ hasText: message });
}

async function setStrictMode(page: Page, on: boolean): Promise<void> {
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: /settings/i });
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await expect(dialog.getByText('Loading')).toBeHidden({ timeout: 10_000 });
	const toggle = dialog.getByRole('switch', { name: 'Strict mode' });
	await expect(toggle).toBeVisible({ timeout: 5_000 });
	const checked = (await toggle.getAttribute('aria-checked')) === 'true';
	if (checked !== on) {
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', String(on), { timeout: 10_000 });
	}
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden({ timeout: 5_000 });
}

test('a staged facet violation lives in the Issues panel, blocks a strict commit, is marked "new" under Validate, and reads "on server" once committed', async ({
	page
}) => {
	test.setTimeout(180_000);
	await openDefaultProject(page);
	await loadFiles(page, {
		metamodel: join(EXAMPLES, 'smart-city.metamodel.yaml'),
		model: join(EXAMPLES, 'smart-city.model.json'),
		view: join(EXAMPLES, 'smart-city.view.json')
	});
	await expectLiveFeed(page);
	await expectReplicaReady(page);

	// Stage the violation: Organization-002's name past max_length 200.
	await searchAndOpen(page, 'Organization-002', 'e_000002');
	await nameInput(page).fill(TOO_LONG);
	await nameInput(page).blur();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);

	// It shows in the Issues panel before any commit, tagged "new".
	const tabpanel = await issuesTab(page);
	const row = issueRow(tabpanel, TOO_LONG_MESSAGE);
	await expect(row).toBeVisible({ timeout: 15_000 });
	await expect(row.getByText('new', { exact: true })).toBeVisible();

	// Discard removes it (the sidebar's per-entity revert, `staged-revert`).
	await page.getByTestId('staged-revert').click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
	await expect(row).toHaveCount(0, { timeout: 15_000 });

	// Stage it again for the strict-mode and commit steps below.
	await nameInput(page).fill(TOO_LONG);
	await nameInput(page).blur();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);
	await expect(row).toBeVisible({ timeout: 15_000 });

	// In strict mode, the commit dialog blocks it.
	await setStrictMode(page, true);
	await page.keyboard.press('Control+s');
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	await expect(drawer.getByText(/loading changes/i)).toBeHidden({ timeout: 30_000 });
	await expect(drawer.getByText(/strict mode is on/i)).toBeVisible({ timeout: 20_000 });
	const commitButton = drawer.getByRole('button', { name: /^Commit/ });
	await expect(commitButton).toBeDisabled({ timeout: 5_000 });
	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden({ timeout: 10_000 });

	// Validate shows the overlay with the staged issue marked "new" — the
	// overlay-only "last run" label proves the click actually re-ran it, not
	// just that the live list still shows the same row it showed before.
	await page.getByRole('button', { name: 'Validate', exact: true }).click();
	await expect(tabpanel.getByText(/^last run /)).toBeVisible({ timeout: 15_000 });
	await expect(row).toBeVisible({ timeout: 15_000 });
	await expect(row.getByText('new', { exact: true })).toBeVisible();

	// Back off strict mode so the commit below can land, then commit. The
	// staged 201-character value is unbroken, so it widens the dialog's grid
	// track and the footer overflows past the viewport; focus and Enter need
	// no pointer geometry.
	await setStrictMode(page, false);
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const commitAnywayButton = drawer.getByRole('button', { name: /^Commit/ });
	await expect(commitAnywayButton).toBeEnabled({ timeout: 20_000 });
	await commitAnywayButton.focus();
	await page.keyboard.press('Enter');
	await expect(drawer).toBeHidden({ timeout: 20_000 });
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);

	// After the commit, the issue stays, now "on server".
	await expect(row).toBeVisible({ timeout: 15_000 });
	await expect(row.getByText('on server', { exact: true })).toBeVisible({ timeout: 15_000 });
});
