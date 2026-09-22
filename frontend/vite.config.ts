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

export default defineConfig({
	plugins: [crossOriginIsolation(), tailwindcss(), sveltekit()],
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
