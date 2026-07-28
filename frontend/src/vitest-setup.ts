import { afterAll } from 'vitest';

// bits-ui's BodyScrollLock schedules a ~24ms cleanup timeout when the last
// Dialog unmounts (at test cleanup). Give it time to fire while the
// happy-dom environment is still alive, or vitest intermittently reports an
// unhandled teardown error in any dialog-mounting test file.
afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, 100));
});

// ---------------------------------------------------------------------------
// Third-party `derived_inert` suppression
// ---------------------------------------------------------------------------
// Sibling of the scroll-lock hook above, same root cause: bits-ui's
// dismissible-layer schedules a setTimeout that reads a svelte-toolbelt
// `box.current` derived AFTER the component was unmounted at test teardown.
// Svelte 5 then warns `derived_inert`, ~250 lines per full run, entirely from
// node_modules — no repo code appears in the stack and nothing here can
// prevent it.
//
// Suppress it ONLY when the stack is purely third-party. If one of OUR
// components ever reads a destroyed derived, an app frame is present and the
// warning still prints — this quiets a known library artifact, it does not
// blanket-mute the diagnostic.
// NB: the `node_modules` exclusion is load-bearing, not belt-and-braces. Svelte
// ships its own sources, so its frames read `node_modules/svelte/src/internal/…`
// — a bare `/src/` test matches EVERY stack and suppresses nothing.
const APP_FRAME = /\/src\//;
const THIS_FILE = 'vitest-setup.ts';
const isAppFrame = (f: string): boolean =>
	APP_FRAME.test(f) && !f.includes('node_modules') && !f.includes(THIS_FILE);

const originalWarn = console.warn;
console.warn = (...args: unknown[]): void => {
	if (typeof args[0] === 'string' && args[0].includes('derived_inert')) {
		const frames = (new Error().stack ?? '').split('\n').slice(1);
		if (!frames.some(isAppFrame)) return; // library-internal read after unmount
	}
	originalWarn(...args);
};
