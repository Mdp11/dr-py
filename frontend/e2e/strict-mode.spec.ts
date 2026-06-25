/**
 * E2E smoke: strict-mode commit gate (Task 9)
 *
 * Flow:
 *   1. Load the app with the example metamodel + an empty model.
 *   2. Open Settings and enable strict mode.
 *   3. Create a Block element WITHOUT setting a name — the `name` property has
 *      multiplicity "1" on the NamedElement base type, so leaving it unset
 *      produces a CONFORMANCE error in the preview.
 *   4. Open the Commit review (Ctrl+S) and assert:
 *      - The "Strict mode is on: …" alert is visible.
 *      - The Commit button is disabled (commitBlocked = true when wouldBlock).
 *   5. Close the Commit review, open Settings, and disable strict mode.
 *   6. Open the Commit review again and assert:
 *      - The "Strict mode is on" alert is gone.
 *      - The Commit button is enabled (same batch, no longer blocked).
 */

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

const EMPTY_MODEL = {
	name: 'empty.json',
	mimeType: 'application/json',
	buffer: Buffer.from('{"elements": [], "relationships": []}')
};

// Accept the "discard unsaved changes" confirm dialog that fires when loading
// new files on top of an existing backend session state.
test.beforeEach(async ({ page }) => {
	page.on('dialog', (dialog) => void dialog.accept());
});

test('Strict mode: commit is blocked when on, enabled when off', async ({ page }) => {
	test.setTimeout(240_000);

	await page.goto('/');

	// Wait for the live feed before interacting.
	await expect(page.getByText('live')).toBeVisible({ timeout: 120_000 });

	// 1. Load the example metamodel + empty model for a clean, known starting state.
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: EMPTY_MODEL });

	// Wait for the live feed to reconnect after the model reload.
	await expect(page.getByText('live')).toBeVisible({ timeout: 30_000 });

	// Confirm we start with a clean staged buffer.
	const uncommittedBadge = page.locator('footer').getByText(/\d+ uncommitted/);
	await expect(uncommittedBadge).toBeVisible({ timeout: 15_000 });
	await expect(uncommittedBadge).toContainText('0 uncommitted');

	// 2. Open Settings and enable strict mode.
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const settingsDialog = page.getByRole('dialog', { name: /settings/i });
	await expect(settingsDialog).toBeVisible({ timeout: 10_000 });

	// The toggle is a <button role="switch" aria-label="Strict mode">.
	// It fetches the current setting on open; wait for the loading state to resolve.
	await expect(settingsDialog.getByText('Loading')).toBeHidden({ timeout: 10_000 });

	const strictToggle = settingsDialog.getByRole('switch', { name: 'Strict mode' });
	await expect(strictToggle).toBeVisible({ timeout: 5_000 });
	// Strict mode should be off initially; enable it.
	await expect(strictToggle).toHaveAttribute('aria-checked', 'false');
	await strictToggle.click();
	// Wait until the toggle reflects the new state (the PATCH call may take a moment).
	await expect(strictToggle).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });

	// Close the Settings dialog.
	await page.keyboard.press('Escape');
	await expect(settingsDialog).toBeHidden({ timeout: 5_000 });

	// 3. Create a Block element WITHOUT filling in the name.
	//    The NamedElement base type has name: string, multiplicity "1".
	//    Leaving it unset (properties: {}) produces a multiplicity CONFORMANCE error.
	await page.getByRole('button', { name: 'New element' }).click();
	await page.getByRole('button', { name: 'Block', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Block' })).toBeVisible();

	// Confirm the staged buffer now shows uncommitted changes.
	await expect(uncommittedBadge).not.toContainText('0 uncommitted', { timeout: 15_000 });

	// 4. Open the Commit review via Ctrl+S.
	await page.keyboard.press('Control+s');
	const diffDrawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(diffDrawer).toBeVisible({ timeout: 10_000 });

	// Wait for the preview round-trip to finish (loading indicator disappears).
	await expect(diffDrawer.getByText(/loading changes/i)).toBeHidden({ timeout: 30_000 });

	// Assert the strict-mode alert is shown.
	await expect(diffDrawer.getByText(/strict mode is on/i)).toBeVisible({ timeout: 20_000 });

	// Assert the Commit button is disabled (commitBlocked = true when wouldBlock).
	const commitBtn = diffDrawer.getByRole('button', { name: /^Commit/ });
	await expect(commitBtn).toBeDisabled({ timeout: 5_000 });

	// 5. Close the Commit review, reopen Settings, and disable strict mode.
	await page.keyboard.press('Escape');
	await expect(diffDrawer).toBeHidden({ timeout: 10_000 });

	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
	await expect(settingsDialog.getByText('Loading')).toBeHidden({ timeout: 10_000 });

	const strictToggle2 = settingsDialog.getByRole('switch', { name: 'Strict mode' });
	await expect(strictToggle2).toHaveAttribute('aria-checked', 'true');
	await strictToggle2.click();
	await expect(strictToggle2).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 });

	await page.keyboard.press('Escape');
	await expect(settingsDialog).toBeHidden({ timeout: 5_000 });

	// 6. Open the Commit review again with the same uncommitted batch.
	await page.keyboard.press('Control+s');
	await expect(diffDrawer).toBeVisible({ timeout: 10_000 });

	// Wait for the preview round-trip to finish.
	await expect(diffDrawer.getByText(/loading changes/i)).toBeHidden({ timeout: 30_000 });

	// Assert the strict-mode alert is gone.
	await expect(diffDrawer.getByText(/strict mode is on/i)).toBeHidden({ timeout: 10_000 });

	// Assert the Commit button is now enabled (same batch, but no longer blocked).
	// The button may read "Commit anyway (1)" if conformance errors are still surfaced
	// without strict mode, or "Commit (1)" if the server now reports would_block=false.
	// Either way it must be enabled.
	await expect(commitBtn).toBeEnabled({ timeout: 20_000 });

	// Dismiss the drawer.
	await page.keyboard.press('Escape');
	await expect(diffDrawer).toBeHidden({ timeout: 5_000 });
});
