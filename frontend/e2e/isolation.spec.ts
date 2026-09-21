import { test, expect } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

// The sandbox's CSP, verbatim (sandbox/vite.config.ts): the app and the
// sandbox both run under it, and this spec is the one place that pins the
// exact string so the two cannot drift silently.
const SANDBOX_CSP =
	"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'";

test('the app is cross-origin isolated', async ({ page }) => {
	await page.goto('/login');
	const isolated = await page.evaluate(() => self.crossOriginIsolated);
	expect(isolated).toBe(true);
});

test('the sandbox site serves its isolation headers', async ({ request }) => {
	const res = await request.get('http://localhost:5174/');
	expect(res.status()).toBe(200);
	const headers = res.headers();
	expect(headers['content-security-policy']).toBe(SANDBOX_CSP);
	expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
	expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
});

test('a missing path on the sandbox site 404s', async ({ request }) => {
	const res = await request.get('http://localhost:5174/no-such-path');
	expect(res.status()).toBe(404);
});

test('the workspace embeds the sandbox once, and only the workspace', async ({ page }) => {
	await openDefaultProject(page);
	const frame = page.locator('iframe[title="Data Rover engine"]');
	await expect(frame).toHaveCount(1);
	const src = await frame.getAttribute('src');
	expect(src === null ? null : new URL(src).origin).toBe('http://localhost:5174');

	// A client-side navigation: the page is unmounted, not unloaded.
	await page.getByRole('button', { name: 'Data Rover', exact: true }).click();
	await page.waitForURL('**/projects');
	await expect(frame).toHaveCount(0);
});
