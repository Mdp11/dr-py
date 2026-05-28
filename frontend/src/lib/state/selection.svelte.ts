export type SelectionKind = 'element' | 'relationship';
export type Selection = { kind: SelectionKind; id: string } | null;

let _selection: Selection = $state(null);

export function getSelection(): Selection {
	return _selection;
}

export function select(s: Selection): void {
	_selection = s;
}

export function clearSelection(): void {
	_selection = null;
}
