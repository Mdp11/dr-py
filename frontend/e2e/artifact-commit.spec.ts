/**
 * E2E: artifact lock → edit → commit round-trip (artefacts revamp Phase 1,
 * frontend rewire).
 *
 * Saving an artifact editor no longer persists anything: it STAGES a
 * `create_artifact`/`update_artifact` op onto the artifact buffer, and the
 * change reaches the server only when the commit review's Commit button posts
 * the mixed batch to `/commits`. This spec walks the whole visible arc of that
 * for a table artifact — the surfaces a user would actually notice:
 *
 *   1. New table → name it → Save
 *      → the sidebar row carries the staged "new" badge and the TopBar's
 *        `● n changes` counter counts it (it counts artifact ops now, not just
 *        model ops).
 *   2. Open the commit review
 *      → the tab trigger reads "Changes (1)" (relabelled from "Model (n)"
 *        precisely because artifact ops ride this batch), an Artifacts section
 *        lists the row, and Commit is reachable for an artifact-ONLY batch.
 *   3. Commit
 *      → the drawer closes, the sidebar row loses its badge (it is server
 *        truth now, re-keyed off its temp id), the counter is back to 0, and
 *        the History drawer's newest commit carries the message we typed.
 *   4. Rename from the sidebar → staged AGAIN ("edited" badge) → commit →
 *      RELOAD the page and the new name is still there. The reload is the
 *      point: it is the only assertion that separates "the client re-rendered
 *      its own optimism" from "the server has it".
 *
 * Selectors follow the house style of navigation.spec.ts / table.spec.ts (the
 * `[data-artifact-id]` + `span.flex-1` sidebar-row pattern, `table-name`) and
 * view.spec.ts (the change badge), and assert only through user-visible
 * surfaces. The lease is exercised rather than asserted: the sidebar rename
 * takes an `art:` exclusive and `POST /commits` verifies it, so a lease that
 * never happened would 409 at the commit below rather than pass quietly.
 */
import { expect, test } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

test('artifact lock → edit → commit round-trip', async ({ page }) => {
	test.setTimeout(120_000);

	// Unique per run: the e2e suite shares one backend project across spec files
	// (workers: 1), and this test COMMITS its artifact, so the name outlives the
	// test — a fixed one would clash with a rerun's uniqueness check.
	const name = `e2e-artifact-${Date.now()}`;
	const renamed = `${name}-renamed`;
	const commitMessage = `e2e artifact commit ${name}`;

	// The sidebar's Rename is a native `window.prompt`; nothing else in this
	// test opens a dialog, so one handler answering every prompt with the new
	// name is unambiguous.
	page.on('dialog', (dialog) => {
		if (dialog.type() === 'prompt') void dialog.accept(renamed);
		else void dialog.accept();
	});

	await openDefaultProject(page);

	// The TopBar's combined counter — model ops + artifact ops + view edits.
	// Located by the bullet, not by the whole string: its text nodes are "● ",
	// the count and "change(s)" separately, so a text-engine regex over the lot
	// is whitespace-fragile (same rationale as view.spec.ts's `badge`).
	const changeBadge = page.locator('header span').filter({ hasText: /●/ }).first();
	await expect(changeBadge).toBeVisible({ timeout: 15_000 });
	await expect(changeBadge).toContainText('● 0 changes');

	// --- 1. New table → name → Save (= stage a create) -----------------------
	await page.getByRole('button', { name: 'New table' }).click();
	const tabpanel = page.getByRole('tabpanel');
	const nameInput = tabpanel.getByTestId('table-name');
	await expect(nameInput).toHaveValue('New table');
	await nameInput.fill(name);
	// `/^Save( \*)?$/` — exact, so it can't also match the "Save as…" button;
	// the ` *` suffix is TableView's unsaved marker.
	await tabpanel.getByRole('button', { name: /^Save( \*)?$/ }).click();

	// The sidebar library is server truth PLUS the staged overlay, so a staged
	// create is already a row — under a temp id, badged "new".
	const row = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: new RegExp(`^${name}$`) }) });
	await expect(row).toBeVisible({ timeout: 10_000 });
	await expect(row.locator('[data-staged-state]')).toHaveText('new');
	await expect(changeBadge).toContainText('● 1 change');

	// --- 2. The commit review lists it under Artifacts -----------------------
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	// Relabelled from "Model (n)": the tab now also holds artifact ops.
	await expect(drawer.getByRole('tab', { name: 'Changes (1)' })).toBeVisible();
	await expect(drawer.getByRole('heading', { name: 'Artifacts (1)' })).toBeVisible();
	await expect(drawer.getByText(name, { exact: true })).toBeVisible();
	await expect(drawer.getByText('new table', { exact: true })).toBeVisible();

	await drawer.getByLabel('Commit message').fill(commitMessage);

	// --- 3. Commit: the batch is artifact-only, and Commit is still reachable -
	const commitButton = drawer.getByRole('button', { name: /^Commit \(1\)$/ });
	await expect(commitButton).toBeEnabled({ timeout: 20_000 });
	await commitButton.click();
	await expect(drawer).toBeHidden({ timeout: 20_000 });

	// The row survives the temp-id → real-id re-key and drops its badge.
	await expect(changeBadge).toContainText('● 0 changes', { timeout: 15_000 });
	await expect(row).toBeVisible();
	await expect(row.locator('[data-staged-state]')).toHaveCount(0);

	// The commit reached the journal under our message.
	await page.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'History', exact: true }).click();
	const historyDrawer = page.getByRole('dialog', { name: /commit history/i });
	await expect(historyDrawer.locator('[data-testid="commit-row"]').first()).toContainText(
		commitMessage,
		{ timeout: 15_000 }
	);
	await page.keyboard.press('Escape');
	await expect(historyDrawer).toBeHidden({ timeout: 5_000 });

	// Close the editor tab so the rename below is a true library-only edit (the
	// sidebar path, not the open editor's). The `art:` lease it releases on the
	// way out is incidental: a lease left live here is harmless to later specs,
	// since a model revert / metamodel rebind no longer counts `art:` leases as
	// "the project is busy" (see `state/quiet.ts`).
	await page.getByRole('button', { name: `Close ${name}` }).click();

	// --- 4. Rename from the sidebar → staged again → commit → reload ---------
	// Rename/Delete only render on row hover (`group-hover:inline`).
	await row.hover();
	await row.getByRole('button', { name: 'Rename' }).click();

	const renamedRow = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: new RegExp(`^${renamed}$`) }) });
	await expect(renamedRow).toBeVisible({ timeout: 10_000 });
	await expect(renamedRow.locator('[data-staged-state]')).toHaveText('edited');
	await expect(changeBadge).toContainText('● 1 change');

	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const commitButton2 = drawer.getByRole('button', { name: /^Commit \(1\)$/ });
	await expect(commitButton2).toBeEnabled({ timeout: 20_000 });
	await commitButton2.click();
	await expect(drawer).toBeHidden({ timeout: 20_000 });
	await expect(changeBadge).toContainText('● 0 changes', { timeout: 15_000 });

	// The round-trip that matters: a fresh page load re-fetches the library from
	// the server, so the renamed row here is the server's copy, not our overlay.
	await page.reload();
	await expect(
		page
			.locator('[data-artifact-id]')
			.filter({ has: page.locator('span.flex-1', { hasText: new RegExp(`^${renamed}$`) }) })
	).toBeVisible({ timeout: 30_000 });
	await expect(
		page
			.locator('[data-artifact-id]')
			.filter({ has: page.locator('span.flex-1', { hasText: new RegExp(`^${name}$`) }) })
	).toHaveCount(0);
});
