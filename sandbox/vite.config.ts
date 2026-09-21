import { defineConfig } from 'vite';

// The policy the page and the worker run under; `server` carries it too, so
// `vite dev` is never laxer than what ships.
const headers = {
	'Content-Security-Policy':
		"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'",
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'cross-origin'
};

export default defineConfig({
	appType: 'mpa',
	worker: { format: 'es' },
	build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
	preview: { host: 'localhost', port: 5174, strictPort: true, headers },
	server: { headers }
});
