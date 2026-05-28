import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

function resolveAgainstWorkspace(p: string | undefined): string | null {
	if (!p) return null;
	if (isAbsolute(p)) return p;
	const root = process.env.PIXI_PROJECT_ROOT ?? process.cwd();
	return resolve(root, p);
}

const AUTOLOAD_METAMODEL = resolveAgainstWorkspace(process.env.AUTOLOAD_METAMODEL_PATH);
const AUTOLOAD_MODEL = resolveAgainstWorkspace(process.env.AUTOLOAD_MODEL_PATH);
const AUTOLOAD_VIEW = resolveAgainstWorkspace(process.env.AUTOLOAD_VIEW_PATH);

// Surface filenames to the client via Vite's standard VITE_* prefix. Must be
// set before defineConfig runs so SvelteKit's env loader picks them up.
if (AUTOLOAD_METAMODEL) {
	process.env.VITE_AUTOLOAD_METAMODEL_NAME = basename(AUTOLOAD_METAMODEL);
}
if (AUTOLOAD_MODEL) {
	process.env.VITE_AUTOLOAD_MODEL_NAME = basename(AUTOLOAD_MODEL);
}
if (AUTOLOAD_VIEW) {
	process.env.VITE_AUTOLOAD_VIEW_NAME = basename(AUTOLOAD_VIEW);
}

/**
 * Dev-only autoload helper. When AUTOLOAD_METAMODEL_PATH / AUTOLOAD_MODEL_PATH /
 * AUTOLOAD_VIEW_PATH env vars are set (e.g. via `pixi run start-frontend <mm>
 * <model> <view>`), serve those local files from `/__autoload/metamodel`,
 * `/__autoload/model`, and `/__autoload/view` so the client can fetch them on
 * mount.
 */
function autoloadPlugin(): Plugin {
	return {
		name: 'data-rover-autoload',
		apply: 'serve',
		configureServer(server) {
			function serve(path: string | null, contentType: string) {
				return (_req: IncomingMessage, res: ServerResponse) => {
					if (!path) {
						res.statusCode = 404;
						res.end('autoload path not configured');
						return;
					}
					if (!existsSync(path) || !statSync(path).isFile()) {
						res.statusCode = 404;
						res.end(`autoload file not found: ${path}`);
						return;
					}
					res.setHeader('Content-Type', contentType);
					createReadStream(path).pipe(res);
				};
			}
			server.middlewares.use(
				'/__autoload/metamodel',
				serve(AUTOLOAD_METAMODEL, 'application/octet-stream')
			);
			server.middlewares.use('/__autoload/model', serve(AUTOLOAD_MODEL, 'application/json'));
			server.middlewares.use('/__autoload/view', serve(AUTOLOAD_VIEW, 'application/json'));

			if (AUTOLOAD_METAMODEL || AUTOLOAD_MODEL || AUTOLOAD_VIEW) {
				server.config.logger.info(
					`[autoload] metamodel=${AUTOLOAD_METAMODEL ?? '(none)'} model=${AUTOLOAD_MODEL ?? '(none)'} view=${AUTOLOAD_VIEW ?? '(none)'}`
				);
			}
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), autoloadPlugin()],
	server: {
		host: '127.0.0.1',
		port: 5173,
		proxy: {
			'/api/v1': {
				target: 'http://127.0.0.1:8000',
				changeOrigin: true
			}
		}
	}
});
