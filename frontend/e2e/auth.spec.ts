import { test, expect } from '@playwright/test';
import { login } from './helpers/auth';

test('login lands on the picker and lists the seeded project', async ({ page }) => {
	await login(page);
	await expect(page.getByText('Smart City')).toBeVisible();
});

test('admin console is reachable for the dev admin', async ({ page }) => {
	await login(page);
	await page.getByRole('button', { name: 'Admin' }).click();
	await page.waitForURL('**/admin');
	await expect(page.getByText('Administration')).toBeVisible();
});

test('unauthenticated visit redirects to /login', async ({ page }) => {
	await page.goto('/projects');
	await page.waitForURL('**/login');
});
