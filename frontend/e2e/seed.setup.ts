import { test as setup, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Playwright runs with cwd = the config dir (frontend/), so examples/ is one up.
const EXAMPLES = resolve(process.cwd(), '..', 'examples');
const API = 'http://127.0.0.1:8000/api/v1';

/**
 * The backend no longer autoloads a default model, so the e2e suite creates
 * its "Smart City" project itself via the wizard API. Runs as a Playwright
 * setup project (webServer guaranteed up); the shared `request` context keeps
 * the session cookie from login across calls. Idempotent so `reuseExistingServer`
 * reruns are safe.
 */
setup('seed the Smart City project', async ({ request }) => {
	const login = await request.post(`${API}/auth/login`, {
		data: { email: 'admin@example.com', password: 'admin12345' }
	});
	expect(login.ok(), await login.text()).toBeTruthy();

	const existing = await request.get(`${API}/projects`);
	const names = (await existing.json()).map((p: { name: string }) => p.name);
	if (names.includes('Smart City')) return; // already seeded (reused server)

	const res = await request.post(`${API}/projects`, {
		headers: { 'x-requested-with': 'data-rover' }, // CSRF: cookie is present
		multipart: {
			name: 'Smart City',
			metamodel: {
				name: 'smart-city.metamodel.yaml',
				mimeType: 'application/yaml',
				buffer: readFileSync(resolve(EXAMPLES, 'smart-city.metamodel.yaml'))
			},
			model: {
				name: 'smart-city.model.json',
				mimeType: 'application/json',
				buffer: readFileSync(resolve(EXAMPLES, 'smart-city.model.json'))
			},
			view: {
				name: 'smart-city.view.json',
				mimeType: 'application/json',
				buffer: readFileSync(resolve(EXAMPLES, 'smart-city.view.json'))
			}
		}
	});
	expect(res.status(), await res.text()).toBe(201);
});
