/**
 * Global long-operation progress store (spec §4).
 *
 * A stack of active operations; the OLDEST entry drives the ProgressOverlay
 * (an outer operation like "opening project" is not hidden by a nested one).
 * `done`/`total` null = indeterminate spinner; set = determinate radial with
 * a centered percentage.
 */

export interface ProgressEntry {
	id: number;
	label: string;
	done: number | null;
	total: number | null;
}

let _entries = $state<ProgressEntry[]>([]);
let _nextId = 1;

export function startProgress(label: string): number {
	const id = _nextId++;
	_entries = [..._entries, { id, label, done: null, total: null }];
	return id;
}

export function updateProgress(id: number, done: number, total: number): void {
	_entries = _entries.map((e) => (e.id === id ? { ...e, done, total } : e));
}

export function setProgressLabel(id: number, label: string): void {
	_entries = _entries.map((e) => (e.id === id ? { ...e, label } : e));
}

export function endProgress(id: number): void {
	_entries = _entries.filter((e) => e.id !== id);
}

export function getActiveProgress(): ProgressEntry | null {
	return _entries[0] ?? null;
}

/** Test isolation. */
export function resetProgress(): void {
	_entries = [];
	_nextId = 1;
}
