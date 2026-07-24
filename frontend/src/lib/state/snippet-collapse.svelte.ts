/**
 * Collapse state for EMBEDDED `SnippetSourceEditor`s (a table script column's
 * snippet, a navigation script step's snippet), keyed by a caller-built
 * stable key (`{tabId}::col:{i}` / `{tabId}::{pathKey}::step:{i}`).
 *
 * Store-backed for the same reason PathCard's disclosure is (see
 * `_cardCollapsed` in navigation-editor.svelte.ts): component-local $state
 * silently resets to the default whenever the editor remounts — a dialog
 * reopen, a card re-render. The default is COLLAPSED: a settings dialog full
 * of open code editors is unreadable.
 *
 * Keys embed the column/step index. A reorder or mid-list insert can
 * therefore re-associate a choice with a neighbouring editor; that is a
 * cosmetic, self-healing miss (the next toggle fixes it), accepted instead of
 * replicating navigation-editor's structural remapping for a disclosure flag.
 */
import { SvelteMap } from 'svelte/reactivity';

const _expanded = new SvelteMap<string, boolean>();

export function isSnippetExpanded(key: string): boolean {
	return _expanded.get(key) ?? false;
}

export function setSnippetExpanded(key: string, expanded: boolean): void {
	_expanded.set(key, expanded);
}

/** Test isolation. */
export function resetSnippetCollapse(): void {
	_expanded.clear();
}
