/**
 * Custom validation rules served by the engine over the working copy, in the
 * real sandbox against the real backend, with shadow on: a rule set saved in
 * the Rules tab is staged, and the Issues panel lists its issues before any
 * commit, marked "new", with its drifted rule in the skipped banner; Discard
 * removes both. Committed, its issues stay, now "on server". A staged edit
 * two hops from a rule's owner makes the owner's issue appear live and Undo
 * clears it; in strict mode the same edit blocks the commit dialog. The spec
 * deletes its rule set at the end, since the suite shares one project.
 *
 * Fixture facts (examples/smart-city.*): Organization-002 (e_000002) has
 * `country: FR`; Organization-001 (e_000001) Owns a Team that the Person
 * "Ada Akiyama" (e_000031) is a MemberOf, so renaming her reaches
 * Organization-001 along Owns → MemberOf. Organization has no property
 * `no_such_property`.
 */

import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';
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

const SENTINEL = 'e2e-rule-sentinel';
const ATLANTIS_MESSAGE = 'e2e: Organization-002 is not in Atlantis';
const SENTINEL_MESSAGE = `e2e: a team member is called ${SENTINEL}`;
const DRIFTED_RULE = 'e2e-drifted';

const RULES_YAML = `rules:
  - name: e2e-org-in-atlantis
    applies_to: Organization
    when:
      property: name
      equals: Organization-002
    then:
      property: country
      equals: Atlantis
    message: "${ATLANTIS_MESSAGE}"
  - name: ${DRIFTED_RULE}
    applies_to: Organization
    then:
      property: no_such_property
      exists: true
  - name: e2e-no-sentinel-member
    applies_to: Organization
    then:
      relationship:
        type: Owns
        direction: outgoing
        to: Team
        where:
          relationship:
            type: MemberOf
            direction: incoming
            to: Person
            where:
              property: name
              equals: ${SENTINEL}
            exists: true
        exists: false
    message: "${SENTINEL_MESSAGE}"
`;

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
	page.on('dialog', (dialog) => void dialog.accept());
});

/** The rule set name the running test is using, for `afterEach` to sweep up —
 * set as soon as the test picks its name, cleared by nothing (each test
 * generates its own timestamped name). */
let cleanupRuleSet: string | undefined;

/**
 * Regardless of pass/fail: strict mode back off (a failure between
 * `setStrictMode(page, true)` and `setStrictMode(page, false)` below would
 * otherwise leave it on for `strict-mode.spec.ts`'s next test — the suite is
 * serial, one worker) and the rule set this test made, deleted, in case an
 * assertion failed before the test's own cleanup ran. Both go through the
 * owner peer client, disposed after. `delete_artifact` needs the artifact's
 * own exclusive lease (`locking.py`'s `required_locks`), acquired and
 * released here exactly as `peerCommit` does for an element's.
 */
test.afterEach(async ({ playwright }) => {
	const api = await peer(playwright);
	try {
		const projectId = await projectIdByName(api, 'Smart City');
		const settings = await api.patch(`projects/${projectId}/settings`, {
			data: { strict_mode: false }
		});
		expect(settings.ok(), await settings.text()).toBeTruthy();
		if (cleanupRuleSet !== undefined) {
			const base = `projects/${projectId}`;
			const list = await api.get(`${base}/artifacts?kind=validation_rules`);
			expect(list.ok(), await list.text()).toBeTruthy();
			const items = ((await list.json()) as { items: { id: string; name: string }[] }).items;
			const leftover = items.find((a) => a.name === cleanupRuleSet);
			if (leftover) {
				const lock = await api.post(`${base}/locks`, {
					data: {
						targets: [{ resource_id: leftover.id, mode: 'exclusive', type: 'artifact' }],
						intent: 'delete'
					}
				});
				expect(lock.ok(), await lock.text()).toBeTruthy();
				const { token } = (await lock.json()) as { token: string };
				try {
					const commit = await api.post(`${base}/commits`, {
						data: {
							base_rev: await headRev(api, projectId),
							ops: [{ kind: 'delete_artifact', id: leftover.id }],
							message: 'e2e cleanup: leftover rule set',
							lock_tokens: [token],
							ack_errors: true
						}
					});
					expect(commit.ok(), await commit.text()).toBeTruthy();
				} finally {
					await api.post(`${base}/locks/release`, { data: { token } });
				}
			}
		}
	} finally {
		await api.dispose();
	}
});

function nameInput(page: Page): Locator {
	return page.getByTestId('inspector').locator('input[type="text"]').first();
}

/** Searches the sidebar for `name` and opens the hit whose id is `id`. */
async function searchAndOpen(page: Page, name: string, id: string): Promise<void> {
	await page.getByPlaceholder('Filter by name, type, id…').fill(name);
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

function skippedBanner(page: Page): Locator {
	return page.getByTestId('rules-skipped-banner');
}

function commitDrawer(page: Page): Locator {
	return page.getByRole('dialog', { name: /commit changes/i });
}

/** Stages `name` on the inspector's selected element. */
async function stageRename(page: Page, name: string): Promise<void> {
	await nameInput(page).fill(name);
	await nameInput(page).blur();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);
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

test('a staged rule set lists its issues and its drifted rule before any commit, keeps them once committed, reaches two hops live, and blocks a strict commit', async ({
	page
}) => {
	test.setTimeout(240_000);
	const setName = `e2e-rules-${Date.now()}`;
	cleanupRuleSet = setName;

	await openDefaultProject(page);
	await loadFiles(page, {
		metamodel: join(EXAMPLES, 'smart-city.metamodel.yaml'),
		model: join(EXAMPLES, 'smart-city.model.json'),
		view: join(EXAMPLES, 'smart-city.view.json')
	});
	await expectLiveFeed(page);
	await expectReplicaReady(page);

	// --- A new rule set, written and saved in the Rules tab (= staged) -------
	await page.getByRole('button', { name: 'New rule set' }).click();
	const rulesTab = page.getByTestId('rules-tab');
	await expect(rulesTab.getByTestId('rules-editor').locator('.cm-content')).toBeVisible({
		timeout: 10_000
	});
	await rulesTab.getByLabel('Rule set name').fill(setName);
	await rulesTab.getByTestId('rules-editor').locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Delete');
	// insertText: typing would let the editor auto-indent the YAML.
	await page.keyboard.insertText(RULES_YAML);
	// The lint answers: the drifted rule is a warning, and Save stays enabled.
	await expect(rulesTab.getByTestId('rules-drift-warnings')).toContainText(DRIFTED_RULE, {
		timeout: 15_000
	});
	await rulesTab.getByTestId('rules-save').click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);

	// --- The Issues panel shows the staged set's issue and its skipped rule --
	const tabpanel = await issuesTab(page);
	const atlantis = issueRow(tabpanel, ATLANTIS_MESSAGE);
	await expect(atlantis).toHaveCount(1, { timeout: 20_000 });
	await expect(atlantis.getByText('new', { exact: true })).toBeVisible();
	await expect(skippedBanner(page)).toContainText('1 rule skipped — schema mismatch');
	await expect(skippedBanner(page)).toContainText(DRIFTED_RULE);
	await expect(issueRow(tabpanel, SENTINEL_MESSAGE)).toHaveCount(0);

	// --- Discard removes both ------------------------------------------------
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = commitDrawer(page);
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	await expect(drawer.getByText(setName, { exact: true })).toBeVisible({ timeout: 10_000 });
	await drawer.getByRole('button', { name: 'Discard', exact: true }).click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
	if (await drawer.isVisible()) await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await expect(atlantis).toHaveCount(0, { timeout: 20_000 });
	await expect(skippedBanner(page)).toHaveCount(0);

	// --- Saved again and committed: the issue stays, now on the server ------
	await page.getByRole('tab', { name: new RegExp(setName) }).click();
	await rulesTab.getByTestId('rules-save').click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);
	await issuesTab(page);
	await expect(atlantis).toHaveCount(1, { timeout: 20_000 });
	await expect(atlantis.getByText('new', { exact: true })).toBeVisible();
	await commitStaged(page, `e2e rules ${setName}`);
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
	await expect(atlantis).toHaveCount(1, { timeout: 20_000 });
	await expect(atlantis.getByText('on server', { exact: true })).toBeVisible({
		timeout: 20_000
	});
	await expect(skippedBanner(page)).toContainText(DRIFTED_RULE);

	// --- An edit two hops from the owner makes its issue appear; Undo clears --
	const sentinel = issueRow(tabpanel, SENTINEL_MESSAGE);
	await searchAndOpen(page, 'Ada Akiyama', 'e_000031');
	await stageRename(page, SENTINEL);
	await expect(sentinel).toHaveCount(1, { timeout: 20_000 });
	await expect(sentinel.getByText('new', { exact: true })).toBeVisible();
	await expect(sentinel.getByTitle('e_000001')).toBeVisible();
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
	await expect(sentinel).toHaveCount(0, { timeout: 20_000 });
	await expect(atlantis.getByText('on server', { exact: true })).toBeVisible();

	// --- In strict mode, the committed rule blocks the commit dialog ---------
	await expect(nameInput(page)).toHaveValue('Ada Akiyama', { timeout: 10_000 });
	await stageRename(page, SENTINEL);
	await expect(sentinel).toHaveCount(1, { timeout: 20_000 });
	await setStrictMode(page, true);
	await page.keyboard.press('Control+s');
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	await expect(drawer.getByText(/loading changes/i)).toBeHidden({ timeout: 30_000 });
	await expect(drawer.getByText(/strict mode is on/i)).toBeVisible({ timeout: 20_000 });
	await expect(drawer.getByRole('button', { name: /^Commit/ })).toBeDisabled({ timeout: 5_000 });
	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden({ timeout: 10_000 });
	await setStrictMode(page, false);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
	await expect(sentinel).toHaveCount(0, { timeout: 20_000 });

	// --- Clean up: delete the rule set, and its issues and skip go with it ---
	const row = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: new RegExp(`^${setName}`) }) });
	await row.hover();
	await row.getByRole('button', { name: 'Delete' }).click();
	await page.getByTestId('confirm-dialog-confirm').click();
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(1);
	await commitStaged(page, `e2e rules cleanup ${setName}`);
	await expect.poll(() => stagedChangeCount(page), { timeout: 10_000 }).toBe(0);
	await issuesTab(page);
	await expect(atlantis).toHaveCount(0, { timeout: 20_000 });
	await expect(skippedBanner(page)).toHaveCount(0);
});
