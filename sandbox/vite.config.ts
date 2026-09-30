import { copyFileSync, createReadStream, mkdirSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// The only Pyodide files the sandbox serves or ships; the script worker loads
// them from this origin and nothing else of the package leaves `node_modules`.
export const PYODIDE_FILES: readonly string[] = [
	'pyodide.mjs',
	'pyodide.asm.mjs',
	'pyodide.asm.wasm',
	'python_stdlib.zip',
	'pyodide-lock.json'
];

const PYODIDE_TYPES: Record<string, string> = {
	'.mjs': 'text/javascript',
	'.wasm': 'application/wasm',
	'.zip': 'application/zip',
	'.json': 'application/json'
};

// `vite dev` serves the five files from the package and 404s the rest of
// `/pyodide/`; a build copies them into `<outDir>/pyodide/` after every bundle
// write, `--watch` rebuilds included (`vite preview` then serves them as
// static files).
function pyodideAssets(headers: Record<string, string>): Plugin {
	let packageDir = '';
	let outDir = '';
	const notFound = (res: ServerResponse) => {
		res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('Not Found');
	};
	return {
		name: 'sandbox-pyodide-assets',
		configResolved(config) {
			packageDir = resolve(config.root, 'node_modules', 'pyodide');
			outDir = resolve(config.root, config.build.outDir);
		},
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = (req.url ?? '').split(/[?#]/, 1)[0] ?? '';
				if (path !== '/pyodide' && !path.startsWith('/pyodide/')) return next();
				// Compared as received: an encoded or dotted path is no name in the list.
				const name = path.slice('/pyodide/'.length);
				if ((req.method !== 'GET' && req.method !== 'HEAD') || !PYODIDE_FILES.includes(name)) {
					return notFound(res);
				}
				const file = join(packageDir, name);
				res.writeHead(200, {
					...headers,
					'Content-Type':
						PYODIDE_TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream',
					'Content-Length': statSync(file).size
				});
				if (req.method === 'HEAD') return res.end();
				createReadStream(file).pipe(res);
			});
		},
		writeBundle() {
			const target = join(outDir, 'pyodide');
			mkdirSync(target, { recursive: true });
			for (const name of PYODIDE_FILES) copyFileSync(join(packageDir, name), join(target, name));
		}
	};
}

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
		plugins: [pyodideAssets(headers)],
		worker: { format: 'es' },
		build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
		preview: { host: 'localhost', port: 5174, strictPort: true, headers },
		server: { headers }
	};
});
