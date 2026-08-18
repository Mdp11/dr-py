import { SvelteSet } from 'svelte/reactivity';

import { pushVisit } from './inspection-history.svelte';

export type SelectionKind = 'element' | 'relationship';
export type Selection = { kind: SelectionKind; id: string } | null;

let _selection: Selection = $state(null);

// Shared multi-selection element-id set. The containment tree owns the
// ctrl/shift multi-select gestures and writes here; `_selection` stays pointed
// at the last-touched (primary) element for the Inspector, while consumers that
// want the whole set (e.g. the snippet "Use current selection") read this.
// SvelteSet is reactive across modules — mutate the shared instance in place.
const _multiSelected = new SvelteSet<string>();

export function getSelection(): Selection {
	return _selection;
}

export function select(s: Selection): void {
	_selection = s;
	// Every element selection is an inspection "visit", recorded at this one
	// choke point so all navigation paths (tree, search, issues panel,
	// endpoint links, table cells) feed the Inspector's back/forward history.
	// Replays from goBack/goForward are guarded inside pushVisit.
	if (s !== null && s.kind === 'element') pushVisit(s.id);
}

export function clearSelection(): void {
	_selection = null;
}

/** The live shared multi-selection set (element ids). */
export function getMultiSelectedIds(): SvelteSet<string> {
	return _multiSelected;
}
