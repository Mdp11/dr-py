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
		conditions: ['browser', ...defaultClientConditions]
	},
	test: {
		environment: 'happy-dom',
		include: ['src/**/*.{test,spec}.{ts,js}'],
		globals: false
	}
});
