import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the data-rover frontend smoke suite.
 *
 * Two webServers are launched:
 *   1. The FastAPI backend (`pixi run -e api start-backend`) on :8000. Uses a
 *      throwaway SQLite file at /tmp/data-rover-e2e.db with dev-seed enabled so
 *      the default user+project exist before any test runs.
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
			// Unix absolute-path SQLite DSN (sqlite:/// + /tmp/...). On Windows CI
			// this would need a drive-letter form (sqlite:///C:/...).
			command:
				'DATA_ROVER_DATABASE_URL=sqlite:////tmp/data-rover-e2e.db DATA_ROVER_DEV_SEED=true pixi run -e api start-backend',
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
