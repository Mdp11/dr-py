// Sidebar filter state: type-name filter set and free-text search.
//
// `_typeFilter` is an explicit allowlist: only stereotypes whose names are
// in the set are shown in the tree. It is initialised from the metamodel's
// concrete element types on first load via `ensureTypeFilterInitialized`,
// so the default UX is "everything checked = everything visible".

import { SvelteSet } from 'svelte/reactivity';

// SvelteSet is itself reactive, so it needs no `$state` wrapper; we keep a
// single instance and mutate it in place rather than reassigning.
const _typeFilter = new SvelteSet<string>();
let _typeFilterInitialized = false;
let _searchText: string = $state('');

export function getTypeFilter(): ReadonlySet<string> {
	return _typeFilter;
}

function replaceTypeFilter(types: Iterable<string>): void {
	_typeFilter.clear();
	for (const t of types) _typeFilter.add(t);
}

export function setTypeFilter(types: Set<string>): void {
	replaceTypeFilter(types);
	_typeFilterInitialized = true;
}

export function toggleType(name: string): void {
	if (_typeFilter.has(name)) _typeFilter.delete(name);
	else _typeFilter.add(name);
	_typeFilterInitialized = true;
}

/** Seed the filter with the full set of names on first metamodel load.
 *  No-op once the user (or a prior call) has touched the filter. */
export function ensureTypeFilterInitialized(allNames: Iterable<string>): void {
	if (_typeFilterInitialized) return;
	replaceTypeFilter(allNames);
	_typeFilterInitialized = true;
}

export function getSearchText(): string {
	return _searchText;
}

export function setSearchText(s: string): void {
	_searchText = s;
}

export function clearFilters(): void {
	_typeFilter.clear();
	_searchText = '';
}
