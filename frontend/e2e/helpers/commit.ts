import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The TopBar's combined change counter (model ops + artifact ops + view
 * journal depth — see `TopBar.svelte`'s `combinedChanges`). Located by the
 * bullet, not the whole string: its text nodes are "● ", the count and
 * "change(s)" separately, so a text-engine regex over the lot is
 * whitespace-fragile (same rationale as artifact-commit.spec.ts's local copy,
 * which this centralizes).
 */
export function changeBadge(page: Page): Locator {
	return page.locator('header span').filter({ hasText: /●/ }).first();
}

/**
 * Open the commit review and commit whatever is staged, waiting for the drawer
 * to close.
 *
 * Artifact editors do not persist on Save — Save STAGES a
 * `create_artifact`/`update_artifact` op, and only this drawer's Commit posts
 * the batch. Specs that save a navigation/table/snippet and then need it to
 * EXIST server-side (reopen it from the library, reference it from a picker)
 * therefore have to come through here first.
 *
 * The button text is "Commit ({n})" without conformance errors and
 * "Commit anyway ({n})" with them — hence the `/^Commit/` prefix match, the
 * same one commit-flow.spec.ts and history.spec.ts use. It stays disabled while
 * the preview round-trip is in flight, so the enabled-wait is the real
 * synchronisation point.
 *
 * `message`, when given, fills the drawer's "Commit message" field before
 * clicking Commit (a plain string is fine — the field has no validation).
 */
export async function commitStaged(page: Page, message?: string): Promise<void> {
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	if (message !== undefined) await drawer.getByLabel('Commit message').fill(message);
	const commitButton = drawer.getByRole('button', { name: /^Commit/ });
	await expect(commitButton).toBeEnabled({ timeout: 20_000 });
	await commitButton.click();
	await expect(drawer).toBeHidden({ timeout: 20_000 });
}
