import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the data-rover frontend smoke suite.
 *
 * Two webServers are launched:
 *   1. The FastAPI backend (`pixi run -e api serve`) on :8000. The backend
 *      keeps a single in-memory session — there is no persistent storage to
 *      isolate between runs.
 *   2. The Vite dev server (`npm run dev`) on :5173.
 *
 * Both are reused if already running locally to keep the iteration loop fast.
 */
export default defineConfig({
	testDir: 'e2e',
	fullyParallel: false,
	workers: 1,
	reporter: process.env.CI ? 'line' : 'list',
	use: {
		baseURL: 'http://127.0.0.1:5173',
		headless: true,
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } }
		}
	],
	webServer: [
		{
			command: 'pixi run -e api start-backend',
			cwd: '..',
			url: 'http://127.0.0.1:8000/healthz',
			timeout: 60_000,
			reuseExistingServer: true
		},
		{
			command: 'npm run dev',
			cwd: '.',
			port: 5173,
			timeout: 60_000,
			reuseExistingServer: true
		}
	]
});
