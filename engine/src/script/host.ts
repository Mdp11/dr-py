import type { Value } from '../value/types.ts';

/** `script` is a console run: one call, answered as a run (`stdout`, `result_repr`, `truncated`, `error`?). */
export type ScriptEntry = 'value' | 'step' | 'transform' | 'script';

export type ScriptCall = {
	readonly elementIds: readonly string[];
	readonly inputs?: Value;
	readonly doc?: Value;
};

export type ScriptBatch = {
	readonly code: string;
	readonly entry: ScriptEntry;
	/** Runs each call on a namespace of its own, answered as a console run; the `script` entry always does. */
	readonly console?: boolean;
	readonly calls: readonly ScriptCall[];
};

/**
 * One per call: the harness's result dict as the JSON text Python's default `json.dumps` wrote,
 * `{payload, error, reads, stdout}` for an embedded call and `{stdout, result_repr, truncated,
 * error?}` for a console run. A host that fails a call writes the same shape.
 */
export type RawScriptResult = { readonly text: string };

export type ScriptRun = {
	readonly results: readonly RawScriptResult[];
	readonly trips: number;
	readonly ms: number;
};

/** What a host reaches the model through: `dispatch` answers one bridge request, `roots` the projections of elements. Both carry text. */
export type Bridge = {
	dispatch(requestText: string): string;
	roots(ids: readonly string[]): string;
};

export type ScriptHost = {
	boot(): Promise<{ ms: number }>;
	run(batch: ScriptBatch): Promise<ScriptRun>;
	dispose(): void;
};

export type ScriptHostFactory = (bridge: Bridge) => ScriptHost;
