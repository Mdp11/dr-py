import { select } from './selection.svelte';

// The Inspector's back/forward visit trail. In-memory only (resets on project
// open / page reload). Entries are pushed with only the id — at select() time
// the element may not be fetched yet; display data is stamped on lazily by the
// dropdown via noteResolved(). `history.svelte.ts` is the commit-history
// browser; this module is the INSPECTION history.
export type VisitEntry = { id: string; name?: string; type_name?: string };
export type VisitMenuEntry = { index: number; entry: VisitEntry };

const STACK_MAX = 50;

let _stack: VisitEntry[] = $state([]);
let _cursor = $state(-1); // index of the current entry; -1 = empty

// Re-entrancy guard: goBack/goForward/goToVisit call select(), which calls
// pushVisit() (the selection choke-point hook) — the guard makes that inner
// push a no-op so replaying history never mutates it.
let _navigating = false;

export function getVisitStack(): readonly VisitEntry[] {
	return _stack;
}

export function getVisitCursor(): number {
	return _cursor;
}

export function pushVisit(id: string): void {
	if (_navigating) return;
	// Consecutive dedup. Also absorbs applyDelta's post-commit selection
	// re-point: remapVisitIds() runs first, so the re-selected canonical id
	// already sits at the cursor.
	if (_stack[_cursor]?.id === id) return;
	_stack = [..._stack.slice(0, _cursor + 1), { id }];
	if (_stack.length > STACK_MAX) _stack = _stack.slice(_stack.length - STACK_MAX);
	_cursor = _stack.length - 1;
}

export function canGoBack(): boolean {
	return _cursor > 0;
}

export function canGoForward(): boolean {
	return _cursor >= 0 && _cursor < _stack.length - 1;
}

function navigateTo(index: number): void {
	if (index < 0 || index >= _stack.length) return;
	_cursor = index;
	_navigating = true;
	try {
		select({ kind: 'element', id: _stack[index].id });
	} finally {
		_navigating = false;
	}
}

export function goBack(): void {
	if (canGoBack()) navigateTo(_cursor - 1);
}

export function goForward(): void {
	if (canGoForward()) navigateTo(_cursor + 1);
}

export function goToVisit(index: number): void {
	navigateTo(index);
}

/** Up to `limit` entries strictly behind the cursor, nearest first. */
export function backEntries(limit = 10): VisitMenuEntry[] {
	const out: VisitMenuEntry[] = [];
	for (let i = _cursor - 1; i >= 0 && out.length < limit; i--) {
		out.push({ index: i, entry: _stack[i] });
	}
	return out;
}

/** Up to `limit` entries strictly ahead of the cursor, nearest first. */
export function forwardEntries(limit = 10): VisitMenuEntry[] {
	const out: VisitMenuEntry[] = [];
	for (let i = _cursor + 1; i < _stack.length && out.length < limit; i++) {
		out.push({ index: i, entry: _stack[i] });
	}
	return out;
}

/** Stamp last-known display data onto every entry for `id` (dropdown
 * write-back), so a later-deleted element keeps its last-known label. */
export function noteResolved(id: string, name: string, type_name: string): void {
	for (const e of _stack) {
		if (e.id === id) {
			e.name = name;
			e.type_name = type_name;
		}
	}
}

/** Rewrite entry ids through a commit's temp→canonical id_map. MUST be called
 * BEFORE applyDelta's selection re-point so the re-point's pushVisit dedups
 * instead of appending a duplicate entry. */
export function remapVisitIds(idMap: Record<string, string>): void {
	for (const e of _stack) {
		const mapped = idMap[e.id];
		if (mapped !== undefined) e.id = mapped;
	}
}

export function resetInspectionHistory(): void {
	_stack = [];
	_cursor = -1;
	_navigating = false;
}
