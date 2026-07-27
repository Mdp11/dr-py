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
 *   5. Click "Unlock" with a staged edit → the in-app ConfirmDialog warns the
 *      edit will be discarded; confirming reverts the edit (badge back to 0,
 *      value restored) and the control flips back to "Lock".
 *
 * The confirmation is the app's own dialog, not `window.confirm`, so it is
 * driven through the DOM (`confirm-dialog` test ids) rather than Playwright's
 * native-dialog channel.
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

	// Blanket-accept any native dialog. Nothing in this flow raises one any more
	// (the unlock confirmation is the in-app dialog located below), but a stray
	// browser prompt would hang the test rather than fail it, so the handler
	// stays as insurance.
	page.on('dialog', (dialog) => void dialog.accept());

	const confirmDialog = page.getByTestId('confirm-dialog');
	const confirmButton = page.getByTestId('confirm-dialog-confirm');

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
	// The control reaching "Lock" already proves nothing blocked on a prompt;
	// this pins that no dialog was left standing either.
	await expect(confirmDialog).toBeHidden();

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
	// The confirmation is raised, names what is at stake, and is accepted.
	await expect(confirmDialog).toBeVisible({ timeout: 10_000 });
	await expect(confirmDialog).toContainText(/will be discarded/i);
	await confirmButton.click();
	await expect(confirmDialog).toBeHidden({ timeout: 10_000 });
	// The edit was discarded: control back to "Lock", badge back to 0.
	await expect(lockControl).toHaveText('Lock', { timeout: 10_000 });
	await expect(uncommittedBadge).toContainText('0 uncommitted', { timeout: 15_000 });
	// The property value reverted to its original (the staged edit was abandoned).
	await expect(nameInput).toHaveValue(originalValue, { timeout: 10_000 });
	expect(editedValue).not.toEqual(originalValue); // sanity: the edit was real
});
