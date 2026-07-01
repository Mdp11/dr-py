import { expect, type Page } from '@playwright/test';

/**
 * Sign in through the /login form as the bootstrap admin and wait for the
 * picker. The admin (admin@example.com / admin12345) comes from
 * DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL/_PASSWORD, which the e2e backend sets; the
 * e2e backend runs the cookie identity provider with AUTH_COOKIE_SECURE=false
 * so the httpOnly session cookie flows over plain http://127.0.0.1.
 */
export async function login(
	page: Page,
	email = 'admin@example.com',
	password = 'admin12345'
): Promise<void> {
	await page.goto('/login');
	await page.getByPlaceholder('Email').fill(email);
	await page.getByPlaceholder('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL('**/projects');
}

/**
 * Log in and open the "Smart City" project (created by the Playwright
 * `setup` project in seed.setup.ts, not autoloaded), landing on the workspace
 * at /p/[projectId]. Existing workspace specs call this in place of the old
 * `page.goto('/')` (which now redirects to /projects).
 */
export async function openDefaultProject(page: Page): Promise<void> {
	await login(page);
	// Guard against racing the picker's projects fetch before clicking.
	await expect(page.getByText('Smart City')).toBeVisible();
	await page.getByText('Smart City').click(); // the dev-seeded default project
	await page.waitForURL('**/p/**');
}
