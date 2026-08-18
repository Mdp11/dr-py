/**
 * Pure helpers for keyboard shortcut matching. Kept in a non-`.svelte.ts`
 * module so they can be unit-tested without the Svelte compiler.
 *
 * The wiring + side-effects (state mutations, `window` listeners) live in
 * `keyboard.svelte.ts` next to this file.
 */

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

export type ShortcutAction = { kind: 'save' } | { kind: 'validate' };

/**
 * Decide what shortcut (if any) the given event maps to.
 * Returns `null` if the event is not a known shortcut.
 */
export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
	const mod = e.metaKey || e.ctrlKey;
	if (!mod) return null;
	if (e.altKey) return null;
	const k = e.key.toLowerCase();
	if (k === 's') return { kind: 'save' };
	if (k === 'e') return { kind: 'validate' };
	return null;
}

/**
 * True if the given shortcut should still fire when focus is in an editable
 * element. Cmd+S (save) is the only one.
 */
export function shortcutWorksInInputs(action: ShortcutAction): boolean {
	return action.kind === 'save';
}
