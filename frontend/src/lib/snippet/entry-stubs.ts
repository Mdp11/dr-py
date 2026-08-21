// Pure helpers for the value/step entry-point UX — kept Svelte-free so the
// hint/stub logic is unit-testable (mirrors docs-view.ts / console-view.ts).
//
// Backend contract (core/script/lint.derive_entry_points +
// routes/snippets.py): an entry unlocks when the code defines a TOP-LEVEL
// one-argument function of that name; value/step runs are read-only — the
// server calls `value` with the list of bound elements and `step` with its
// single element and shows repr(return).

export type BoundEntry = 'value' | 'step' | 'transform';

/** The subset of `BoundEntry` a console/embedded run (`POST /snippets/run`,
 * `SnippetSourceEditor`'s Test panel) can actually execute — mirrors
 * `RunRequest.entry: Literal["script", "value", "step"]`
 * (core/script/runner.py). `transform` is TableRef-only and runs only
 * server-side during an export (never through the console), so it is
 * deliberately excluded here rather than threaded through `SnippetRunBody`,
 * `SnippetSourceEditor`, `ElementContextRow` and `SnippetTestPanel`. */
export type ConsoleEntry = Exclude<BoundEntry, 'transform'>;

export const ENTRY_HINTS: Record<BoundEntry, string> = {
	value:
		'value runs a top-level function def value(elements): against the bound elements (a list, read-only) and shows its return value. Your snippet doesn’t define one yet.',
	step: 'step runs a top-level function def step(el): — one tick of a step-wise evaluation for the bound element (read-only). Your snippet doesn’t define one yet.',
	transform:
		'transform runs a top-level function def transform(doc): against the rendered export document (read-only reads allowed) and ships its return value instead. Your snippet doesn’t define one yet.'
};

const STUBS: Record<BoundEntry, string> = {
	value:
		'def value(elements):\n' +
		'    # Read-only: compute and return a value for the bound elements.\n' +
		'    return [el.name for el in elements]\n',
	step:
		'def step(el):\n' +
		'    # Read-only: one tick of a step-wise evaluation for the bound element.\n' +
		'    return el.name\n',
	transform:
		'def transform(doc):\n' +
		'    # Post-process the rendered export document (any JSON value) and\n' +
		'    # return the replacement to ship. jsonl entries must return a list.\n' +
		'    return doc\n'
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
