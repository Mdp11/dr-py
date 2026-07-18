/**
 * E2E: snippet workspace tab — lint, run (real WASM sandbox), stage, commit
 * (Code execution M1 frontend, Task 9).
 *
 * Requires the WASM guest binary to be fetched (spikes/code_exec/vendor/
 * python.wasm — see spikes/code_exec/fetch_python_wasi.sh); without it
 * /snippets/run 503s and the run-dependent tests self-skip via
 * runAndAwait's runner-unavailable notice check below.
 */
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFiles } from './helpers/load';
import { openDefaultProject } from './helpers/auth';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.metamodel.yaml');
const MODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.model.json');
const VIEW_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.view.json');

/** Focus the CM6 editor and replace its content. keyboard.insertText avoids
 * CM auto-indent mangling multi-line python. */
async function setCode(page: Page, code: string): Promise<void> {
	await page.locator('[data-testid="snippet-editor"] .cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Delete');
	await page.keyboard.insertText(code);
}

async function openNewSnippet(page: Page): Promise<void> {
	await openDefaultProject(page);
	await page.getByRole('button', { name: 'New snippet' }).click();
	await expect(page.locator('[data-testid="snippet-editor"] .cm-content')).toBeVisible();
}

/** Run current code; resolve to 'ok' or skip the test when the backend has no
 * runner (guest binary not fetched — /snippets/run 503s). A run that only
 * mutates the model (no print, no trailing expression) produces neither
 * stdout nor a result_repr — its terminal state is the ops list instead, so
 * that testid is included alongside the brief's four. */
async function runAndAwait(page: Page): Promise<void> {
	await page.getByTestId('snippet-run').click();
	const outcome = page
		.getByTestId('snippet-stdout')
		.or(page.getByTestId('snippet-result'))
		.or(page.getByTestId('snippet-error'))
		.or(page.getByTestId('snippet-notice'))
		.or(page.getByTestId('snippet-ops'));
	await expect(outcome.first()).toBeVisible({ timeout: 30_000 });
	const notice = page.getByTestId('snippet-notice');
	if (await notice.isVisible()) {
		const text = (await notice.textContent()) ?? '';
		test.skip(text.includes('unavailable'), 'snippet runner not booted (guest binary not fetched)');
	}
}

test('lint gutter surfaces a sandbox-import warning', async ({ page }) => {
	await openNewSnippet(page);
	await setCode(page, 'import os\n');
	await expect(page.locator('.cm-lint-marker-warning').first()).toBeVisible({ timeout: 10_000 });
});

test('run prints to the console', async ({ page }) => {
	await openNewSnippet(page);
	await setCode(page, 'print("hello from wasm")\n');
	await runAndAwait(page);
	await expect(page.getByTestId('snippet-stdout')).toContainText('hello from wasm');
});

test('stage a snippet edit and commit it', async ({ page }) => {
	test.setTimeout(90_000);

	// The e2e suite shares one backend session for the "Smart City" project
	// across every spec file; an earlier spec (e.g. smoke.spec.ts) can leave
	// it holding a near-empty model with no committed elements, which would
	// make `next(dr.elements())` raise. Load a known-good model first, same
	// as commit-flow.spec.ts does for the same reason.
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });

	await page.getByRole('button', { name: 'New snippet' }).click();
	await expect(page.locator('[data-testid="snippet-editor"] .cm-content')).toBeVisible();
	await setCode(page, 'el = next(dr.elements())\nel.set("name", "Renamed by snippet")\n');
	await runAndAwait(page);

	// Checkpoint 1: ops listed in the console.
	await expect(page.getByTestId('snippet-ops')).toContainText('update');

	// Checkpoint 2: staged — the Stage button flips to its disabled "Staged"
	// state and the StatusBar's uncommitted counter increments (mirrors
	// commit-flow.spec.ts's uncommittedBadge locator/assertions).
	const uncommittedBadge = page.locator('footer').getByText(/\d+ uncommitted/);
	await expect(uncommittedBadge).toContainText('0 uncommitted');
	await page.getByTestId('snippet-stage').click();
	await expect(page.getByTestId('snippet-stage')).toHaveText(/Staged/);
	await expect(page.getByTestId('snippet-stage')).toBeDisabled();
	await expect(uncommittedBadge).not.toContainText('0 uncommitted', { timeout: 15_000 });

	// Checkpoint 3: committed and visible. Open the review drawer (TopBar's
	// "Commit" button, same as commit-flow.spec.ts's Ctrl+S path opens),
	// confirm, and wait for it to close.
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const commitButton = drawer.getByRole('button', { name: /^Commit/ });
	await expect(commitButton).toBeEnabled({ timeout: 20_000 });
	await commitButton.click();
	await expect(drawer).toBeHidden({ timeout: 20_000 });

	// Post-commit: the uncommitted counter drops back to 0. The run result
	// (ops list + Stage button) stays on screen — a commit doesn't clear the
	// snippet console — but the Stage button remains disabled/"Staged" since
	// nothing has re-run since the commit.
	await expect(uncommittedBadge).toContainText('0 uncommitted', { timeout: 15_000 });
	await expect(page.getByTestId('snippet-stage')).toHaveText(/Staged/);

	// The committed rename is findable via the sidebar search.
	const searchInput = page.getByPlaceholder('Filter by name, type, id…');
	await searchInput.fill('Renamed by snippet');
	await expect(page.getByRole('button', { name: /Renamed by snippet/ })).toBeVisible({
		timeout: 10_000
	});
});
