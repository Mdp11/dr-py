/**
 * E2E smoke: History drawer — list → diff → revert (Phase 8)
 *
 * Flow:
 *   1. Load the app with the simple example metamodel + an empty model.
 *   2. Create a Block element, edit its name, commit it (commit A).
 *   3. Edit the same element again, commit again (commit B) — now at rev N.
 *   4. Open the History drawer and assert at least two commit rows are visible.
 *   5. Click "Diff" on the first (most recent) commit row and assert the
 *      CompareDiff header renders ("+N added" / "~N modified" / "−N deleted").
 *   6. Go back to the list.
 *   7. Click "Revert to here" on the SECOND (older) commit row (targeting rev
 *      N-1). Confirm, and assert history grows — a compensating commit appears
 *      (history is append-only; model_rev advances). This is the most robust
 *      signal that revert completed: it does not depend on any specific element
 *      value, only on the history list length increasing.
 */

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';

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

test('History: list, diff, and revert a commit', async ({ page }) => {
	test.setTimeout(240_000);

	await openDefaultProject(page);

	// Wait for the live feed before interacting — the dev-seeded smart-city model
	// hydrates on first access and the frontend eagerly loads the containment tree.
	await expect(page.getByText('live')).toBeVisible({ timeout: 120_000 });

	// 1. Load the example metamodel + empty model for a clean, known starting state.
	//    The loadFiles helper handles the 409 "model not empty" guard by falling
	//    back to DELETE /metamodel before the initial upload.
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: EMPTY_MODEL });

	// Wait for the live feed to reconnect after the model reload.
	await expect(page.getByText('live')).toBeVisible({ timeout: 30_000 });

	// Confirm we start with a clean staged buffer.
	const uncommittedBadge = page.locator('footer').getByText(/\d+ uncommitted/);
	await expect(uncommittedBadge).toBeVisible({ timeout: 15_000 });
	await expect(uncommittedBadge).toContainText('0 uncommitted');

	// Helper: commit staged changes via the DiffDrawer.
	async function commitStaged(): Promise<void> {
		await page.keyboard.press('Control+s');
		const diffDrawer = page.getByRole('dialog', { name: /commit changes/i });
		await expect(diffDrawer).toBeVisible({ timeout: 10_000 });
		const commitBtn = diffDrawer.getByRole('button', { name: /^Commit/ });
		await expect(commitBtn).toBeEnabled({ timeout: 20_000 });
		await commitBtn.click();
		await expect(diffDrawer).toBeHidden({ timeout: 20_000 });
		await expect(uncommittedBadge).toContainText('0 uncommitted', { timeout: 15_000 });
	}

	// 2. Create a Block element and make the FIRST commit.
	await page.getByRole('button', { name: 'New element' }).click();
	await page.getByRole('button', { name: 'Block', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Block' })).toBeVisible();

	const inspector = page.getByTestId('inspector');
	const nameInput = inspector.locator('input[type="text"]').first();
	await nameInput.fill(`history-smoke-A-${Date.now()}`);
	await nameInput.blur();
	await expect(uncommittedBadge).not.toContainText('0 uncommitted', { timeout: 15_000 });
	await commitStaged();
	// commit A is now at model_rev N-1

	// 3. Edit the element again and make the SECOND commit.
	//    Re-select the element from the tree so the Inspector is active.
	const treeEl = page.getByRole('tree', { name: /containment tree/i });
	await expect(treeEl).toBeVisible({ timeout: 10_000 });
	const firstPickButton = treeEl.locator('button.flex-1').first();
	await expect(firstPickButton).toBeVisible({ timeout: 10_000 });
	await firstPickButton.click();

	const nameInput2 = inspector.locator('input[type="text"]').first();
	await nameInput2.fill(`history-smoke-B-${Date.now()}`);
	await nameInput2.blur();
	await expect(uncommittedBadge).not.toContainText('0 uncommitted', { timeout: 15_000 });
	await commitStaged();
	// commit B is now at model_rev N

	// 4. Open the History drawer via the TopBar "History" button.
	await page.getByRole('button', { name: 'History', exact: true }).click();

	const historyDrawer = page.getByRole('dialog', { name: /commit history/i });
	await expect(historyDrawer).toBeVisible({ timeout: 10_000 });

	// The drawer lists commits newest-first. Assert at least two rows are visible
	// (commits A and B). Each row has a monospace rev label "r{n}".
	const commitRows = historyDrawer.locator('[data-testid="commit-row"]');
	await expect(commitRows.first()).toBeVisible({ timeout: 15_000 });
	const countBefore = await commitRows.count();
	// We made 2 commits; expect at least 2 rows.
	expect(countBefore).toBeGreaterThanOrEqual(2);

	// 5. Click the "Diff" button on the first (most recent) commit row.
	const firstDiffBtn = historyDrawer.getByRole('button', { name: 'Diff' }).first();
	await expect(firstDiffBtn).toBeVisible({ timeout: 10_000 });
	await firstDiffBtn.click();

	// CompareDiff renders count labels: "+N added", "~N modified", "−N deleted".
	// Use first() to avoid strict-mode failure when all three labels are rendered.
	await expect(historyDrawer.getByText(/added|modified|deleted/i).first()).toBeVisible({
		timeout: 20_000
	});

	// 6. Go back to the list.
	// The Back button is a plain <button> with text "Back" in the diff header.
	const backBtn = historyDrawer.getByRole('button', { name: 'Back' });
	await expect(backBtn).toBeVisible({ timeout: 5_000 });
	await backBtn.click();

	// Confirm we're back in list mode.
	await expect(commitRows.first()).toBeVisible({ timeout: 10_000 });

	// 7. Revert to the SECOND (older) commit row — this is the commit BEFORE the
	//    most recent one, so revert will undo the last edit (B → A).
	//    The history is newest-first, so nth(1) is the second-oldest visible commit.
	const olderRow = commitRows.nth(1);
	const revertBtn = olderRow.getByRole('button', { name: 'Revert to here' });
	await expect(revertBtn).toBeVisible({ timeout: 10_000 });
	await revertBtn.click();

	// The inline confirm panel appears. The "Revert" confirm button is enabled
	// because the buffer is clean (we just committed).
	const confirmRevertBtn = historyDrawer.getByRole('button', { name: 'Revert', exact: true });
	await expect(confirmRevertBtn).toBeVisible({ timeout: 5_000 });
	await expect(confirmRevertBtn).toBeEnabled({ timeout: 5_000 });
	await confirmRevertBtn.click();

	// Revert appends a compensating commit (history is append-only; model_rev
	// advances). Assert the history list grows beyond countBefore. This is the
	// most robust signal: it does not depend on element values or tree position,
	// only on the observable list growing when the feed event arrives.
	await expect
		.poll(
			async () => {
				return await commitRows.count();
			},
			{ timeout: 30_000, message: 'Expected history list to grow after revert' }
		)
		.toBeGreaterThan(countBefore);

	// Dismiss the drawer.
	await page.keyboard.press('Escape');
	await expect(historyDrawer).toBeHidden({ timeout: 5_000 });
});
