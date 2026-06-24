import { expect, type Page } from '@playwright/test';

/** A file path on disk, or an in-memory file payload for Playwright. */
export type FileArg = string | { name: string; mimeType: string; buffer: Buffer };

/**
 * Drive the single "Load..." dialog: metamodel + model are required, the view
 * is optional. They are applied in one batch (the backend enforces the order
 * metamodel -> model -> view), mirroring how the app loads all three at once.
 */
export async function loadFiles(
	page: Page,
	files: { metamodel: FileArg; model: FileArg; view?: FileArg }
): Promise<void> {
	await page.getByRole('button', { name: 'Load Model', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: /load files/i });
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('metamodel-file-input').setInputFiles(files.metamodel);
	await dialog.getByTestId('model-file-input').setInputFiles(files.model);
	if (files.view !== undefined) {
		await dialog.getByTestId('view-file-input').setInputFiles(files.view);
	}
	// The metamodel onchange handler is async (calls file.text()); wait for the
	// Load button to become enabled (canSubmit derived from metamodelBody + modelFile)
	// before clicking so we don't click while the button is still disabled.
	const loadBtn = dialog.getByRole('button', { name: 'Load', exact: true });
	await expect(loadBtn).toBeEnabled({ timeout: 10_000 });
	await loadBtn.click();
	// The backend processes three sequential uploads (metamodel → model → view);
	// on a cold dev environment this can take well over 5 s. Use a generous
	// timeout so transient slowness does not flake the caller.
	await expect(dialog).toBeHidden({ timeout: 60_000 });
}
