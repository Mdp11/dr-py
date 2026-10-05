import type { IncomingMessage, ServerResponse } from 'node:http';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Connect, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// COOP/COEP so the app can host the sandbox iframe cross-origin isolated:
// `server.headers`/`preview.headers` don't reach SvelteKit's own
// pages, only static assets, so this sets both on every response by hand.
// First in `plugins` so it also covers what sveltekit()'s own middleware
// serves.
export function crossOriginIsolation(): Plugin {
	const setHeaders: Connect.NextHandleFunction = (req, res, next) => {
		res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
		res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
		next();
	};
	return {
		name: 'cross-origin-isolation',
		configureServer(server) {
			server.middlewares.use(setHeaders);
		},
		configurePreviewServer(server) {
			server.middlewares.use(setHeaders);
		}
	};
}

// The sandbox is `localhost:5174`, so the app must not be `localhost` too
// (same site): a request on `localhost:<port>` is sent to `127.0.0.1:<port>`.
export function localhostRedirectHandler(
	req: IncomingMessage,
	res: ServerResponse,
	next: () => void
): void {
	const host = req.headers.host ?? '';
	if (!host.startsWith('localhost:')) return next();
	res.statusCode = 302;
	res.setHeader('Location', `http://127.0.0.1:${host.slice('localhost:'.length)}${req.url ?? '/'}`);
	res.end();
}

export function localhostRedirect(): Plugin {
	return {
		name: 'localhost-redirect',
		configureServer: (server) => void server.middlewares.use(localhostRedirectHandler),
		configurePreviewServer: (server) => void server.middlewares.use(localhostRedirectHandler)
	};
}

export default defineConfig({
	plugins: [localhostRedirect(), crossOriginIsolation(), tailwindcss(), sveltekit()],
	preview: { host: '127.0.0.1' },
	server: {
		host: '127.0.0.1',
		port: 5173,
		// Pre-transform the workspace page (the heaviest route) at dev-server
		// start. Without this, the first visit to /p/[projectId] can discover
		// new deps and trigger a full page reload mid-project-open, which aborts
		// the freshly-connecting realtime feed WebSocket ("ws proxy error:
		// socket hang up" here, an abnormal-close traceback on the backend).
		warmup: {
			clientFiles: ['./src/routes/p/[projectId]/+page.svelte']
		},
		proxy: {
			'/api/v1': {
				target: 'http://127.0.0.1:8000',
				changeOrigin: true,
				ws: true
			}
		}
	}
});
