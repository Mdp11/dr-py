/**
 * Pure helpers for keyboard shortcut matching. Kept in a non-`.svelte.ts`
 * module so they can be unit-tested without the Svelte compiler.
 *
 * The wiring + side-effects (state mutations, `window` listeners) live in
 * `keyboard.svelte.ts` next to this file.
 */

import type { WorkspaceTab } from './state';

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Return true when `el` is an editable element where most shortcuts should
 * be suppressed.
 */
export function isEditableTarget(el: Element | null): boolean {
	if (el === null) return false;
	if (EDITABLE_TAGS.has(el.tagName)) return true;
	if (el instanceof HTMLElement && el.isContentEditable) return true;
	return false;
}

export type ShortcutAction =
	| { kind: 'palette' }
	| { kind: 'save' }
	| { kind: 'validate' }
	| { kind: 'tab'; tab: WorkspaceTab };

/**
 * Decide what shortcut (if any) the given event maps to.
 * Returns `null` if the event is not a known shortcut.
 */
export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
	const mod = e.metaKey || e.ctrlKey;
	if (!mod) return null;
	if (e.altKey) return null;
	const k = e.key.toLowerCase();
	if (k === 'k') return { kind: 'palette' };
	if (k === 's') return { kind: 'save' };
	if (k === 'e') return { kind: 'validate' };
	if (k === '1') return { kind: 'tab', tab: 'detail' };
	if (k === '2') return { kind: 'tab', tab: 'graph' };
	if (k === '3') return { kind: 'tab', tab: 'issues' };
	return null;
}

/**
 * True if the given shortcut should still fire when focus is in an editable
 * element. Cmd+S (save) and Cmd+K (palette) are the only two.
 */
export function shortcutWorksInInputs(action: ShortcutAction): boolean {
	return action.kind === 'palette' || action.kind === 'save';
}
