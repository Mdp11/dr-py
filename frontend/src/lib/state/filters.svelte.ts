// Sidebar filter state: type-name filter set and free-text search.
//
// `_typeFilter` is an explicit allowlist: only stereotypes whose names are
// in the set are shown in the tree. It is seeded from the active metamodel's
// concrete element types via `ensureTypeFilterInitialized`, so the default UX
// is "everything checked = everything visible".
//
// Seeding is keyed to the metamodel's concrete-type SET (`_seededSignature`),
// not a one-time boolean: re-rendering or reloading the SAME metamodel is a
// no-op (preserving the user's manual toggles), but loading a DIFFERENT
// metamodel re-seeds the allowlist to its full type set. Without that, a
// swapped-in metamodel's elements would be hidden by a stale allowlist that
// names only the previous metamodel's types.

import { SvelteSet } from 'svelte/reactivity';

// SvelteSet is itself reactive, so it needs no `$state` wrapper; we keep a
// single instance and mutate it in place rather than reassigning.
const _typeFilter = new SvelteSet<string>();
// Signature of the concrete-type set the filter was last seeded from, or null
// when unseeded. Order-independent so a reordered name list reads as the same
// metamodel.
let _seededSignature: string | null = null;
let _searchText: string = $state('');

function signatureOf(names: Iterable<string>): string {
	return [...names].sort().join('\n');
}

export function getTypeFilter(): ReadonlySet<string> {
	return _typeFilter;
}

function replaceTypeFilter(types: Iterable<string>): void {
	_typeFilter.clear();
	for (const t of types) _typeFilter.add(t);
}

export function setTypeFilter(types: Set<string>): void {
	replaceTypeFilter(types);
}

export function toggleType(name: string): void {
	if (_typeFilter.has(name)) _typeFilter.delete(name);
	else _typeFilter.add(name);
}

/** Seed the filter with the active metamodel's full set of concrete type names.
 *  Re-seeds whenever that set changes (a different metamodel was loaded) so the
 *  new metamodel's elements are visible; a no-op when the same metamodel is
 *  re-rendered/reloaded, preserving the user's manual toggles. */
export function ensureTypeFilterInitialized(allNames: Iterable<string>): void {
	const sig = signatureOf(allNames);
	if (sig === _seededSignature) return;
	replaceTypeFilter(allNames);
	_seededSignature = sig;
}

export function getSearchText(): string {
	return _searchText;
}

export function setSearchText(s: string): void {
	_searchText = s;
}

export function clearFilters(): void {
	_typeFilter.clear();
	_seededSignature = null;
	_searchText = '';
}
