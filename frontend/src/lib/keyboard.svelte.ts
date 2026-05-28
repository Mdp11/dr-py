/**
 * Global keyboard shortcut wiring.
 *
 * Call `installKeyboardShortcuts()` from a top-level component's `$effect`
 * (or `onMount`) so the listener is attached on mount and cleaned up on
 * destroy.
 *
 * Shortcuts:
 *   Cmd/Ctrl+K      open the command palette
 *   Cmd/Ctrl+S      open the diff drawer (save)
 *   Cmd/Ctrl+E      run validation
 *   Cmd/Ctrl+1/2/3  switch to Detail / Graph / Issues tabs
 *
 * When focus is inside an <input>, <textarea>, or [contenteditable], most
 * shortcuts are suppressed so they don't interfere with typing. Cmd+K and
 * Cmd+S are kept active everywhere (per task spec).
 *
 * Pure matching helpers live in `./keyboard.ts` so they can be unit-tested
 * without dragging the Svelte rune compiler into vitest.
 */

import { setActiveTab, setCommandPaletteOpen, setDiffDrawerOpen } from './state';
import { isEditableTarget, matchShortcut, shortcutWorksInInputs } from './keyboard';
import { runValidation } from './state/validate-action';

function handle(e: KeyboardEvent): void {
	const action = matchShortcut(e);
	if (action === null) return;

	const inInput = isEditableTarget(document.activeElement);
	if (inInput && !shortcutWorksInInputs(action)) return;

	// Always prevent the browser default for matched shortcuts (e.g. Cmd+S
	// triggering the browser "save page as" dialog).
	e.preventDefault();

	switch (action.kind) {
		case 'palette':
			setCommandPaletteOpen(true);
			return;
		case 'save':
			setDiffDrawerOpen(true);
			return;
		case 'validate':
			void runValidation();
			return;
		case 'tab':
			setActiveTab(action.tab);
			return;
	}
}

/**
 * Attach the global keydown listener. Returns a teardown function for use
 * inside a Svelte `$effect`.
 */
export function installKeyboardShortcuts(): () => void {
	if (typeof window === 'undefined') return () => {};
	window.addEventListener('keydown', handle);
	return () => window.removeEventListener('keydown', handle);
}
