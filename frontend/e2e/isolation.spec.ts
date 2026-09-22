import { test, expect } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

// The sandbox's policy, verbatim (sandbox/vite.config.ts), pinned here so a
// change to that config fails this test. The app itself serves no CSP.
const SANDBOX_CSP =
	"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; frame-ancestors http://127.0.0.1:5173";

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

test('the sandbox still loads as a top-level page', async ({ page }) => {
	// frame-ancestors governs embedding, not navigation: it never blocks a
	// document from loading on its own, only from being framed elsewhere.
	const res = await page.goto('http://localhost:5174/');
	expect(res?.status()).toBe(200);
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
