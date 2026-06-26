/**
 * E2E: per-element lock/unlock control in the Inspector (Properties header).
 *
 * Loads the smart-city example to a known state, selects an element, and drives
 * the LockControl affordance:
 *
 *   1. Element starts unlocked → control shows "Lock".
 *   2. Click "Lock" → checks the element out WITHOUT editing it (editLock); the
 *      control flips to "Unlock" and the uncommitted badge stays at 0.
 *   3. Click "Unlock" with no staged edits → releases immediately, NO confirm
 *      dialog; the control flips back to "Lock".
 *   4. Edit a property → the element auto-locks; control shows "Unlock" and the
 *      uncommitted badge increments.
 *   5. Click "Unlock" with a staged edit → a confirm dialog warns the edit will
 *      be discarded; accepting reverts the edit (badge back to 0, value
 *      restored) and the control flips back to "Lock".
 */

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.metamodel.yaml');
const MODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.model.json');
const VIEW_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.view.json');

test('lock without editing, then unlock-with-confirm discards staged edits', async ({ page }) => {
	test.setTimeout(120_000);

	// Record every native dialog (confirm) message and accept it. The unlock
	// confirm and any load-time "discard unsaved changes" prompt both flow here;
	// we assert on the recorded messages to prove WHEN a confirm fired.
	const dialogMessages: string[] = [];
	page.on('dialog', (dialog) => {
		dialogMessages.push(dialog.message());
		void dialog.accept();
	});
	const discardPrompts = () => dialogMessages.filter((m) => /will be discarded/i.test(m));

	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	// Reset the stereotype filter to "select all" so elements are visible (guard
	// against leftover filter state from a prior test — see commit-flow.spec.ts).
	const filterButton = page.locator('[aria-label="Filter stereotypes"]');
	await filterButton.click();
	const selectAllBtn = page.getByRole('button', { name: 'Select all', exact: true });
	await expect(selectAllBtn).toBeVisible({ timeout: 5_000 });
	await selectAllBtn.click();
	await page.keyboard.press('Escape');

	const uncommittedBadge = page.locator('footer').getByText(/\d+ uncommitted/);
	await expect(uncommittedBadge).toBeVisible({ timeout: 15_000 });
	await expect(uncommittedBadge).toContainText('0 uncommitted');

	// --- Select an element in the Containment tree -----------------------------
	const treeEl = page.getByRole('tree', { name: /containment tree/i });
	await expect(treeEl.getByRole('treeitem').first()).toBeVisible({ timeout: 15_000 });
	const firstFolderItem = treeEl.getByRole('treeitem').first();
	await firstFolderItem.locator('button[aria-label]').first().click();
	const firstPickButton = treeEl.locator('button.flex-1').first();
	await expect(firstPickButton).toBeVisible({ timeout: 10_000 });
	await firstPickButton.click();

	const inspector = page.getByTestId('inspector');
	await expect(inspector).toBeVisible({ timeout: 10_000 });
	const lockControl = inspector.getByTestId('lock-control');

	// --- 1. Starts unlocked ----------------------------------------------------
	await expect(lockControl).toHaveText('Lock', { timeout: 10_000 });

	// --- 2. Lock without editing ----------------------------------------------
	await lockControl.click();
	await expect(lockControl).toHaveText('Unlock', { timeout: 10_000 });
	// Checking out does not stage an edit.
	await expect(uncommittedBadge).toContainText('0 uncommitted');

	// --- 3. Unlock with no staged edits → no confirm ---------------------------
	await lockControl.click();
	await expect(lockControl).toHaveText('Lock', { timeout: 10_000 });
	expect(discardPrompts()).toHaveLength(0); // no discard warning was shown

	// --- 4. Edit a property → auto-lock ----------------------------------------
	const nameInput = inspector.locator('input[type="text"]').first();
	await expect(nameInput).toBeVisible({ timeout: 10_000 });
	const originalValue = await nameInput.inputValue();
	const editedValue = `lock-ctl-${Date.now()}`;
	await nameInput.fill(editedValue);
	await nameInput.blur();

	await expect(lockControl).toHaveText('Unlock', { timeout: 10_000 });
	await expect(uncommittedBadge).not.toContainText('0 uncommitted', { timeout: 15_000 });

	// --- 5. Unlock with a staged edit → confirm + discard ----------------------
	await lockControl.click();
	// The confirm dialog fired and was accepted.
	await expect.poll(() => discardPrompts().length, { timeout: 10_000 }).toBe(1);
	// The edit was discarded: control back to "Lock", badge back to 0.
	await expect(lockControl).toHaveText('Lock', { timeout: 10_000 });
	await expect(uncommittedBadge).toContainText('0 uncommitted', { timeout: 15_000 });
	// The property value reverted to its original (the staged edit was abandoned).
	await expect(nameInput).toHaveValue(originalValue, { timeout: 10_000 });
	expect(editedValue).not.toEqual(originalValue); // sanity: the edit was real
});
