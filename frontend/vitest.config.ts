import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Compile .svelte / .svelte.ts (runes) modules so stores like
	// src/lib/state/model.svelte.ts are testable. Prepending 'browser'
	// resolves svelte's client runtime (reactive SvelteMap) instead of the
	// no-op server build; keep Vite's default client conditions behind it
	// (a bare `conditions` array REPLACES the defaults).
	plugins: [svelte()],
	resolve: {
		conditions: ['browser', ...defaultClientConditions],
		// SvelteKit provides the `$lib` alias at build/dev time, but the bare
		// svelte() plugin used here does not — wire it up so component tests can
		// mount components that import via `$lib/...` at runtime.
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
			// SvelteKit runtime modules are not available in vitest (no Kit
			// plugin here); stub them so component tests can import components
			// that use $app/* without a real SvelteKit server.
			'$app/paths': fileURLToPath(new URL('./src/__mocks__/app-paths.ts', import.meta.url))
		}
	},
	test: {
		environment: 'happy-dom',
		include: ['src/**/*.{test,spec}.{ts,js}'],
		globals: false
	}
});
