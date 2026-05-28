// Sidebar filter state: type-name filter set and free-text search.
//
// `_typeFilter` is an explicit allowlist: only stereotypes whose names are
// in the set are shown in the tree. It is initialised from the metamodel's
// concrete element types on first load via `ensureTypeFilterInitialized`,
// so the default UX is "everything checked = everything visible".

let _typeFilter: Set<string> = $state(new Set());
let _typeFilterInitialized = false;
let _searchText: string = $state('');

export function getTypeFilter(): ReadonlySet<string> {
	return _typeFilter;
}

export function setTypeFilter(types: Set<string>): void {
	_typeFilter = new Set(types);
	_typeFilterInitialized = true;
}

export function toggleType(name: string): void {
	const next = new Set(_typeFilter);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	_typeFilter = next;
	_typeFilterInitialized = true;
}

/** Seed the filter with the full set of names on first metamodel load.
 *  No-op once the user (or a prior call) has touched the filter. */
export function ensureTypeFilterInitialized(allNames: Iterable<string>): void {
	if (_typeFilterInitialized) return;
	_typeFilter = new Set(allNames);
	_typeFilterInitialized = true;
}

export function getSearchText(): string {
	return _searchText;
}

export function setSearchText(s: string): void {
	_searchText = s;
}

export function clearFilters(): void {
	_typeFilter = new Set();
	_searchText = '';
}
