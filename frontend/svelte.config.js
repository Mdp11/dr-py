import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({
			fallback: 'index.html',
			precompress: false,
			strict: false
		}),
		// Production code imports these as types only (see eslint.config.js).
		alias: {
			$engine: '../engine/src/index.ts',
			$sandbox: '../sandbox/src'
		}
	}
};

export default config;
