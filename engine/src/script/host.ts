import type { Value } from '../value/types.ts';

export type ScriptEntry = 'value' | 'step' | 'transform';

export type ScriptCall = {
	readonly elementIds: readonly string[];
	readonly inputs?: Value;
	readonly doc?: Value;
};

export type ScriptBatch = {
	readonly code: string;
	readonly entry: ScriptEntry;
	readonly calls: readonly ScriptCall[];
};

/** One per call: `_dr_call_entry`'s `{payload, reads}` as JSON text, or the error. Exactly one is non-null. */
export type RawScriptResult = { readonly text: string | null; readonly error: string | null };

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
