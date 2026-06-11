import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Compile .svelte / .svelte.ts (runes) modules so stores like
	// src/lib/state/model.svelte.ts are testable. `conditions: ['browser']`
	// resolves svelte's client runtime (reactive SvelteMap) instead of the
	// no-op server build.
	plugins: [svelte()],
	resolve: {
		conditions: ['browser']
	},
	test: {
		environment: 'happy-dom',
		include: ['src/**/*.{test,spec}.{ts,js}'],
		globals: false
	}
});
