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
	await page.getByRole('button', { name: 'Load...', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: /load files/i });
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('metamodel-file-input').setInputFiles(files.metamodel);
	await dialog.getByTestId('model-file-input').setInputFiles(files.model);
	if (files.view !== undefined) {
		await dialog.getByTestId('view-file-input').setInputFiles(files.view);
	}
	await dialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(dialog).toBeHidden();
}
