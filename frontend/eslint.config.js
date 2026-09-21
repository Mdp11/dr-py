import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	},
	{
		// shadcn-svelte design-system primitives are generic and accept
		// arbitrary `href` values (internal or external), so the consumer —
		// not these vendored components — is responsible for route resolution.
		files: ['src/lib/components/ui/**/*.svelte'],
		rules: {
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		// The app bundle never holds the engine: production code imports its
		// types only (`import type` is erased). Tests and the in-process test
		// link run it for real.
		files: ['**/*.ts', '**/*.js', '**/*.svelte'],
		ignores: ['**/__tests__/**', 'src/lib/engine/testing.ts'],
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: '$engine',
							message: 'Import engine types only (`import type`).',
							allowTypeImports: true
						}
					],
					patterns: [
						{
							group: ['$sandbox', '$sandbox/*'],
							message: 'Import sandbox types only (`import type`).',
							allowTypeImports: true
						}
					]
				}
			]
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
