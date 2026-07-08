import { expect, test } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

test('build, run, save, and place a navigation', async ({ page }) => {
	test.setTimeout(90_000);
	await openDefaultProject(page);

	// New navigation from the sidebar Navigations section: opens a new tab
	// immediately (no dialog), titled "New navigation". bits-ui hides inactive
	// Tabs.Content panels via the `hidden` attribute, so getByRole('tabpanel')
	// resolves to the one active panel.
	await page.getByRole('button', { name: 'New navigation' }).click();
	await expect(page.getByText('New navigation', { exact: true })).toBeVisible();
	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByRole('button', { name: 'Run' })).toBeVisible();

	// Pick a start type (smart-city metamodel has no "Building" type — use the
	// concrete SoftwareSystem type, which has instances in the seeded model).
	// The picker is a checkbox filter list, not role="option".
	await page.getByText('Any type').click();
	const picker = page.getByPlaceholder('Filter types…');
	await picker.fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem' }).click();
	await page.keyboard.press('Escape');

	// Run the (0-step) navigation and expect chains.
	await tabpanel.getByRole('button', { name: 'Run' }).click();
	await expect(tabpanel.getByText(/of \d+ chains/)).toBeVisible();

	// Save under a name. The draft-name input has no placeholder/label/role
	// name of its own; it's a controlled <input class="w-56"> in the builder
	// header, so it's located via toHaveValue rather than a CSS value= match
	// (Svelte sets the DOM property, not the static attribute).
	const nameInput = tabpanel.locator('input.w-56');
	await expect(nameInput).toHaveValue('New navigation');
	await nameInput.fill('Buildings nav');
	await tabpanel.getByRole('button', { name: /^Save/ }).click();
	await expect(page.locator('[data-artifact-id]', { hasText: 'Buildings nav' })).toBeVisible();

	// Reopen from the sidebar after closing the tab. The close button's
	// accessible name follows the tab's live title ("Close <title>").
	await page.getByRole('button', { name: 'Close Buildings nav' }).click();
	await page.locator('[data-artifact-id]', { hasText: 'Buildings nav' }).dblclick();
	await expect(page.getByRole('tabpanel').getByRole('button', { name: 'Run' })).toBeVisible();
});
