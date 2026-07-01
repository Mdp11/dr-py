import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the data-rover frontend smoke suite.
 *
 * Two webServers are launched:
 *   1. The FastAPI backend (`pixi run -e api start-backend`) on :8000. Uses a
 *      throwaway SQLite file at /tmp/data-rover-e2e.db; dev-seed creates the
 *      schema and the bootstrap admin (admin@example.com/admin12345). The
 *      "Smart City" project is created by the `setup` project (seed.setup.ts),
 *      not autoloaded.
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
		{ name: 'setup', testMatch: /seed\.setup\.ts/ },
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
			dependencies: ['setup']
		}
	],
	webServer: [
		{
			// Unix absolute-path SQLite DSN (sqlite:/// + /tmp/...). On Windows CI
			// this would need a drive-letter form (sqlite:///C:/...).
			//
			// The DB file is REMOVED before each fresh backend start. It must share
			// the snapshot store's lifecycle: DATA_ROVER_SNAPSHOT_STORE=memory is
			// ephemeral (blobs live only in this process), but the SQLite file would
			// otherwise persist across runs. A stale DB then carries snapshot rows
			// whose blobs are gone from the new process's empty memory store, and
			// hydration fails (KeyError on the missing blob key). Removing the file
			// keeps DB and snapshot store in sync; dev-seed rebuilds rev-0 fresh.
			// `reuseExistingServer` means this command (and the rm) only runs when no
			// backend is already up, so it never clears the DB out from under a live
			// server.
			command:
				'rm -f /tmp/data-rover-e2e.db && DATA_ROVER_DATABASE_URL=sqlite:////tmp/data-rover-e2e.db DATA_ROVER_DEV_SEED=true DATA_ROVER_SNAPSHOT_STORE=memory DATA_ROVER_IDENTITY_PROVIDER=cookie DATA_ROVER_AUTH_COOKIE_SECURE=false DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD=admin12345 pixi run -e api start-backend',
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
