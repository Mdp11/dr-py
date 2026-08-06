import { expect, type Page } from '@playwright/test';

/**
 * Open the commit review and commit whatever is staged, waiting for the drawer
 * to close.
 *
 * Artifact editors no longer persist on Save — Save STAGES a
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
 */
export async function commitStaged(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const commitButton = drawer.getByRole('button', { name: /^Commit/ });
	await expect(commitButton).toBeEnabled({ timeout: 20_000 });
	await commitButton.click();
	await expect(drawer).toBeHidden({ timeout: 20_000 });
}
