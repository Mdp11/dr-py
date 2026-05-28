// Sidebar filter state: type-name filter set and free-text search.
//
// `_typeFilter` empty means "all types shown"; non-empty narrows to those
// names. `_searchText` is a case-insensitive substring used by the search
// section of the sidebar.

let _typeFilter: Set<string> = $state(new Set());
let _searchText: string = $state('');

export function getTypeFilter(): ReadonlySet<string> {
	return _typeFilter;
}

export function setTypeFilter(types: Set<string>): void {
	_typeFilter = new Set(types);
}

export function toggleType(name: string): void {
	const next = new Set(_typeFilter);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	_typeFilter = next;
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
