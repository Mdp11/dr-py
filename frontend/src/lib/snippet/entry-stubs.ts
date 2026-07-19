// Pure helpers for the value/step entry-point UX — kept Svelte-free so the
// hint/stub logic is unit-testable (mirrors docs-view.ts / console-view.ts).
//
// Backend contract (core/script/lint.derive_entry_points +
// routes/snippets.py): an entry unlocks when the code defines a TOP-LEVEL
// one-argument function of that name; value/step runs are read-only — the
// server calls the function with the bound element and shows repr(return).

export type BoundEntry = 'value' | 'step';

export const ENTRY_HINTS: Record<BoundEntry, string> = {
	value:
		'value runs a top-level function def value(el): against the bound element (read-only) and shows its return value. Your snippet doesn’t define one yet.',
	step: 'step runs a top-level function def step(el): — one tick of a step-wise evaluation for the bound element (read-only). Your snippet doesn’t define one yet.'
};

const STUBS: Record<BoundEntry, string> = {
	value:
		'def value(el):\n' +
		'    # Read-only: compute and return a value for the bound element.\n' +
		'    return el.name\n',
	step:
		'def step(el):\n' +
		'    # Read-only: one tick of a step-wise evaluation for the bound element.\n' +
		'    return el.name\n'
};

export function entryAvailable(
	entry: 'script' | BoundEntry,
	entryPoints: string[] | undefined
): boolean {
	return entry === 'script' || (entryPoints?.includes(entry) ?? false);
}

/** Append the entry's stub, PEP8-separated (two blank lines) from existing
 * top-level code; an empty document gets the stub alone. */
export function withStub(code: string, entry: BoundEntry): string {
	const stub = STUBS[entry];
	return code.trim() === '' ? stub : `${code.trimEnd()}\n\n\n${stub}`;
}
