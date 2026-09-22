import { defineConfig, loadEnv } from 'vite';

// The policy the page and the worker run under; `server` carries it too, so
// `vite dev` is never laxer than what ships. `frame-ancestors` names the one
// origin allowed to embed this site — `loadEnv`, not `process.env`, so an
// `.env` file that sets the app's origin for `src/origins.ts` sets it here too.
export default defineConfig(({ mode }) => {
	const appOrigin =
		loadEnv(mode, process.cwd(), 'VITE_').VITE_APP_ORIGIN ?? 'http://127.0.0.1:5173';
	const headers = {
		'Content-Security-Policy': `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; frame-ancestors ${appOrigin}`,
		'Cross-Origin-Embedder-Policy': 'require-corp',
		'Cross-Origin-Resource-Policy': 'cross-origin'
	};

	return {
		appType: 'mpa',
		worker: { format: 'es' },
		build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
		preview: { host: 'localhost', port: 5174, strictPort: true, headers },
		server: { headers }
	};
});
