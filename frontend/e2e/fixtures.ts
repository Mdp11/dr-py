/**
 * The test every workspace spec runs under: all five read surfaces on the
 * engine (now every one by default — see `lib/engine/surfaces.ts`) and
 * shadow comparison on, set in `localStorage` before the app boots, and a
 * test fails on any `[shadow]` console line — the engine and the server
 * answered one read differently.
 */

import { test as base, expect, type BrowserContext } from '@playwright/test';

export { expect };

/**
 * Shadow comparison for every page of `context`. The key is written once
 * per tab (a `sessionStorage` marker), so a test that removes it and
 * reloads keeps it removed. The script also runs in the sandbox's frame,
 * whose storage is its own origin's and read by nothing.
 */
export async function engineMode(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		try {
			if (sessionStorage.getItem('e2e.engine-mode') !== null) return;
			sessionStorage.setItem('e2e.engine-mode', '1');
			localStorage.setItem('dr.shadow', '1');
		} catch {
			// A frame without storage has nothing to set.
		}
	});
}

/** Collects every `[shadow]` console line any page of `context` prints from now on. */
export function watchShadow(context: BrowserContext): string[] {
	const lines: string[] = [];
	context.on('console', (message) => {
		const text = message.text();
		if (text.startsWith('[shadow]')) lines.push(text);
	});
	return lines;
}

export const test = base.extend<{ shadowWatch: void }>({
	shadowWatch: [
		async ({ context }, use) => {
			const lines = watchShadow(context);
			await engineMode(context);
			await use();
			expect(lines, 'shadow comparison').toEqual([]);
		},
		{ auto: true }
	]
});
