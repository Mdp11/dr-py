import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the data-rover frontend smoke suite.
 *
 * Two webServers are launched:
 *   1. The FastAPI backend (`pixi run -e api serve`) on :8000, using a dedicated
 *      DATA_ROVER_DATA_DIR so the test never touches the user's workspace data.
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
			command: 'pixi run -e api serve',
			cwd: '..',
			url: 'http://127.0.0.1:8000/healthz',
			timeout: 60_000,
			reuseExistingServer: true,
			env: {
				DATA_ROVER_DATA_DIR: './frontend/e2e/.data'
			}
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
