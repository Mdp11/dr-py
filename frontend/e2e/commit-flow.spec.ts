/**
 * E2E smoke: check out → edit → commit (Spec B, Task 14)
 *
 * Loads the smart-city metamodel + model via the file-load dialog to start
 * from a known state, then drives the check-out → edit → commit flow.
 *
 * Flow:
 *   1. Load the app, load smart-city files, wait for the live feed to connect.
 *   2. Assert the badge starts at "0 uncommitted".
 *   3. Click "Select all" in the stereotype filter to ensure elements are visible
 *      (guard against leftover filter state from a previous test loading a
 *      different metamodel — the filter is "initialized once" per page load).
 *   4. Expand the first folder in the Containment tree.
 *   5. Select the first element inside it.
 *   6. Edit a string property in the Inspector (triggers auto-checkout / lock
 *      acquisition via editLock → ensureCheckout).
 *   7. Assert the "uncommitted" badge in the StatusBar increments.
 *   8. Open the DiffDrawer via Ctrl+S.
 *   9. Wait for the preview to finish loading (the Commit button becomes enabled).
 *  10. Click Commit.
 *  11. Assert the badge returns to "0 uncommitted".
 *  12. Re-select the element and assert the edited value persisted (server-side
 *      round-trip: the frontend re-fetches on selection, so this confirms the
 *      commit reached the backend).
 */

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.metamodel.yaml');
const MODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.model.json');
const VIEW_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.view.json');

test('check out, edit, and commit a property', async ({ page }) => {
	test.setTimeout(120_000);

	// Accept any confirm dialogs (e.g. "discard unsaved changes") that may pop up
	// when loading new files over an existing session state.
	page.on('dialog', (dialog) => void dialog.accept());

	await page.goto('/');

	// Load the smart-city example files via the load dialog to ensure a clean,
	// known starting state regardless of what prior tests left in the session.
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });

	// Wait for the live feed to connect — the readiness signal that the model is
	// fully loaded and the WebSocket is up.
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	// Reset the stereotype type filter to "select all" so elements are visible
	// in the tree. When a prior test loaded a different metamodel (e.g. example.
	// metamodel.yaml with only Block type), the filter stays initialized to that
	// set and shows nothing from the smart-city metamodel. The filter picker's
	// "Select all" button resets it without a full page reload.
	const filterButton = page.locator('[aria-label="Filter stereotypes"]');
	await filterButton.click();
	// The picker popup renders a "Select all" button (exact name, not /i which
	// would also match "Deselect all").
	const selectAllBtn = page.getByRole('button', { name: 'Select all', exact: true });
	await expect(selectAllBtn).toBeVisible({ timeout: 5_000 });
	await selectAllBtn.click();
	// Close the picker by pressing Escape.
	await page.keyboard.press('Escape');

	// Confirm the StatusBar shows "0 uncommitted" before we start, so the
	// post-commit assertion is meaningful (not trivially satisfied).
	const uncommittedBadge = page.locator('footer').getByText(/\d+ uncommitted/);
	await expect(uncommittedBadge).toBeVisible({ timeout: 15_000 });
	await expect(uncommittedBadge).toContainText('0 uncommitted');

	// --- Select an element in the Containment tree -----------------------------
	// The tree is role="tree" aria-label="Containment tree". The smart-city view
	// has top-level folders (Organizations, Systems, …). We need to expand a
	// folder and then click an element inside it.
	//
	// TreeRow.svelte: element rows render a `button.flex.flex-1` (the pick/select
	// button, visually the full-width label row) alongside optional toggle and
	// dropdown buttons. Folder rows have no flex-1 button — only a narrow toggle
	// and a dropdown trigger. We locate element pick buttons by their `flex-1`
	// class which uniquely identifies them.
	const treeEl = page.getByRole('tree', { name: /containment tree/i });
	await expect(treeEl).toBeVisible({ timeout: 15_000 });

	// Wait for at least one treeitem (folder or element) to appear.
	await expect(treeEl.getByRole('treeitem').first()).toBeVisible({ timeout: 15_000 });

	// Click the Expand/Collapse toggle of the first folder to open it. The first
	// treeitem in the smart-city view is the "Organizations" folder. Its toggle is
	// the first button[aria-label] inside it (aria-label="Expand" or "Collapse").
	const firstFolderItem = treeEl.getByRole('treeitem').first();
	const expandToggle = firstFolderItem.locator('button[aria-label]').first();
	await expandToggle.click();

	// After expanding, wait for element rows to appear. An element pick button
	// has class "flex-1" (it stretches to fill the row width — see TreeRow.svelte
	// line ~297: `class="flex flex-1 items-center gap-2 rounded ..."`).
	const firstPickButton = treeEl.locator('button.flex-1').first();
	await expect(firstPickButton).toBeVisible({ timeout: 10_000 });
	await firstPickButton.click();

	// --- Edit a property field in the Inspector --------------------------------
	// Inspector has data-testid="inspector". PropertyField renders scalar string
	// props as <input type="text"> with oninput handler; fill() fires input events.
	const inspector = page.getByTestId('inspector');
	await expect(inspector).toBeVisible({ timeout: 10_000 });

	// The first text input in the inspector corresponds to the "name" property
	// (the smart-city Organization elements all have a string "name" property as
	// the first field in NamedElement, the root abstract type).
	const nameInput = inspector.locator('input[type="text"]').first();
	await expect(nameInput).toBeVisible({ timeout: 10_000 });

	// editLock fires an async lock-acquire on the first input event, then emits
	// the op. Give the lock round-trip time before asserting the badge.
	const originalValue = await nameInput.inputValue();
	const editedValue = `smoke-edited-${Date.now()}`;
	await nameInput.fill(editedValue);

	// --- Assert the uncommitted badge incremented ------------------------------
	// StatusBar text is "{n} uncommitted" (no regex needed, but allow any count).
	await expect(uncommittedBadge).not.toContainText('0 uncommitted', { timeout: 15_000 });

	// --- Open the DiffDrawer (Commit panel) via Ctrl+S -------------------------
	// The keyboard shortcut handler calls setDiffDrawerOpen(true). Focus must not
	// be inside an input that captures Ctrl+S — blur the name field first.
	// Note: per keyboard.svelte.ts, Cmd/Ctrl+S works even inside inputs
	// (shortcutWorksInInputs returns true for 'save'), so no blur is strictly
	// needed — but blurring is safer to avoid race conditions with oninput.
	await nameInput.blur();
	await page.keyboard.press('Control+s');

	// DiffDrawer renders as a Dialog with title "Commit changes".
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });

	// --- Wait for the Commit button to become enabled --------------------------
	// The button is disabled while the preview round-trip is in flight
	// (loading=true) or when total===0 or commitBlocked. Its text is:
	//   "Commit ({n})" — no errors
	//   "Commit anyway ({n})" — conformance errors
	// We match either form with a regex.
	const commitButton = drawer.getByRole('button', { name: /^Commit/ });
	await expect(commitButton).toBeVisible();
	await expect(commitButton).toBeEnabled({ timeout: 20_000 });

	// --- Commit ----------------------------------------------------------------
	await commitButton.click();

	// The drawer should close after a successful commit.
	await expect(drawer).toBeHidden({ timeout: 20_000 });

	// --- Assert the badge returned to 0 ----------------------------------------
	await expect(uncommittedBadge).toContainText('0 uncommitted', { timeout: 15_000 });

	// --- Assert the change persisted: re-select the element --------------------
	// After a commit, re-clicking the element forces the frontend to re-fetch its
	// properties from the backend (ensureElement). The value must match what we
	// committed — confirms the commit reached the server successfully.
	//
	// First deselect by clicking elsewhere (so the re-click triggers a new fetch).
	await page.keyboard.press('Escape');
	await firstPickButton.click();

	const inspector2 = page.getByTestId('inspector');
	const nameInput2 = inspector2.locator('input[type="text"]').first();
	await expect(nameInput2).toHaveValue(editedValue, { timeout: 10_000 });

	// Sanity: the value really changed (not a no-op test).
	expect(editedValue).not.toEqual(originalValue);
});
