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
	/** Bridge requests the run made, counted by the host. */
	readonly trips: number;
	readonly ms: number;
	/** Time the pool spent answering the run's bridge requests: dispatch, encode and reply write. */
	readonly dispatchMs: number;
	/** How long the worker that ran it took to boot, and how it booted. */
	readonly bootMs: number;
	readonly boot: 'snapshot' | 'cold';
};

/** What a host reaches the model through: `dispatch` answers one bridge request, `roots` the projections of elements. Both carry text. */
export type Bridge = {
	dispatch(requestText: string): string;
	roots(ids: readonly string[]): string;
};

/** What a run watches to be cancelled: an `AbortSignal` is one, and the engine's sources have no DOM to name it. */
export type AbortSignalLike = {
	readonly aborted: boolean;
	addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: 'abort', listener: () => void): void;
};

/**
 * `boot()` is idempotent on a live host and retried after a rejection, never memoized;
 * `dispose()` ends every worker and rejects every pending boot and run. A run takes the
 * `bridge` it is given for its own requests and nothing else.
 */
export type ScriptHost = {
	boot(): Promise<{ ms: number }>;
	/** Starts the workers ahead of the first run; a host that cannot does nothing. */
	prewarm(): void;
	/**
	 * Prewarms, and answers once the host holds its full complement of ready spares: a run now
	 * starts at once, on a spare. Rejects when a boot fails with none under way, when the pool shrinks
	 * first, when `signal` aborts, or when the host is disposed.
	 */
	warmed(signal?: AbortSignalLike): Promise<{ spares: number }>;
	run(batch: ScriptBatch, bridge: Bridge, signal?: AbortSignalLike): Promise<ScriptRun>;
	dispose(): void;
};

export type ScriptHostFactory = () => ScriptHost;
