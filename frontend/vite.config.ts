import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
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
