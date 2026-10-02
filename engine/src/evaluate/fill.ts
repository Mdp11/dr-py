/**
 * Evaluations are synchronous over the model and a script is not, so a script
 * is run in rounds. A pass reads each call through a `ScriptReader`: what a
 * fill or the cache already holds is answered, anything else is recorded and
 * answered as pending. A pass that recorded a miss is discarded; the misses
 * run as batches, one per code and entry, and the pass runs again until none
 * is recorded.
 */
import { DEFAULT_HARNESS_LIMITS } from '../script/guest.ts';
import type { AbortSignalLike, ScriptBatch } from '../script/host.ts';
import { cellKey, type CellCache, type CellKey } from '../script/cell-cache.ts';
import {
	PENDING,
	parseScriptResult,
	type EmbeddedEntry,
	type ScriptResult
} from '../script/result.ts';
import { parseExact } from '../value/parse.ts';

/** One embedded call: the code, the entry, the ids it runs over, and the texts of its resolved inputs and document. */
export type ScriptCall = {
	code: string;
	entry: EmbeddedEntry;
	elementIds: readonly string[];
	inputsText: string | null;
	docText: string | null;
};

/** What a pass reads scripts through: the fill's memo, then the cache, else the miss is recorded and `PENDING` answered. */
export type ScriptReader = { read(call: ScriptCall): ScriptResult };

/** The signal a fill watches; an `AbortSignal` is one. */
export type FillSignal = AbortSignalLike & { readonly reason?: unknown };

/**
 * Runs a batch and answers one result text per call, in order. A call the host
 * fails is a text too (`hostErrorText`); a rejection ends the fill.
 */
export type BatchRunner = (batch: ScriptBatch, signal: FillSignal) => Promise<readonly string[]>;

export type FillOptions = {
	runner: BatchRunner;
	signal: FillSignal;
	cache?: CellCache;
	/**
	 * A counter that moves on every transition of the model the scripts read.
	 * Absent, the model does not move for the length of the fill.
	 */
	transitions?: () => number;
	/** Calls finished and calls asked for so far, over every round, as each batch finishes. */
	onProgress?: (done: number, total: number) => void;
	/** The harness's stdout cap, in characters; a longer output is cut as the oracle cuts it. */
	stdoutChars?: number;
};

/** The rounds the fill ran and the calls it asked the runner for, a round that was dropped included. */
export type FillStats = { rounds: number; calls: number };

function aborted(signal: FillSignal): never {
	throw signal.reason ?? new Error('the fill was aborted');
}

/**
 * A signal that aborts with `parent` or on its own: the runners of one round
 * watch it, so a batch that fails stops its siblings.
 */
function linked(parent: FillSignal): {
	readonly signal: FillSignal;
	abort(reason: unknown): void;
	dispose(): void;
} {
	let done = false;
	let why: unknown;
	const listeners = new Set<() => void>();
	const abort = (reason: unknown) => {
		if (done) return;
		done = true;
		why = reason;
		for (const listener of [...listeners]) listener();
	};
	const onParent = () => abort(parent.reason ?? new Error('the fill was aborted'));
	parent.addEventListener('abort', onParent);
	if (parent.aborted) onParent();
	return {
		signal: {
			get aborted() {
				return done;
			},
			get reason() {
				return why;
			},
			addEventListener: (_type, listener) => void listeners.add(listener),
			removeEventListener: (_type, listener) => void listeners.delete(listener)
		},
		abort,
		dispose: () => parent.removeEventListener('abort', onParent)
	};
}

const MALFORMED: ScriptResult = Object.freeze({
	payload: null,
	error: Object.freeze({ kind: 'runtime', message: 'malformed call result', traceback: null }),
	reads: null,
	stdout: ''
});

// Lengths count code points, as Python's do.
function capStdout(stdout: string, cap: number): string {
	if (stdout.length <= cap) return stdout;
	const points = [...stdout];
	return points.length <= cap ? stdout : `${points.slice(0, cap).join('')}...`;
}

/**
 * A call's result from its answer text. The text crossed the worker boundary,
 * and a script runs in the worker that writes it, so it is not trusted to be
 * the harness's: one that is not an envelope is that call's `runtime` error,
 * which is kept for this evaluation only, and the output is capped here as the
 * oracle's session caps it.
 */
function settle(
	text: string,
	entry: EmbeddedEntry,
	stdoutChars: number
): { result: ScriptResult; sound: boolean } {
	let parsed: ScriptResult;
	try {
		parsed = parseScriptResult(text, entry);
	} catch {
		return { result: MALFORMED, sound: false };
	}
	const stdout = capStdout(parsed.stdout, stdoutChars);
	return { result: stdout === parsed.stdout ? parsed : { ...parsed, stdout }, sound: true };
}

/** The texts of inputs and documents are `json.dumps`'s, which writes a non-finite float as a bare constant. */
const FLOATS = { floatConstants: true };

type Group = { batch: ScriptBatch; entry: EmbeddedEntry; keys: CellKey[] };

/** The misses of one pass as batches: first miss first, a batch per code and entry. */
function batchesOf(missed: ReadonlyMap<CellKey, ScriptCall>): Group[] {
	const groups = new Map<
		string,
		{ code: string; entry: EmbeddedEntry; keys: CellKey[]; calls: ScriptBatch['calls'][number][] }
	>();
	for (const [key, call] of missed) {
		const id = `${call.entry}\u0000${call.code}`;
		let group = groups.get(id);
		if (group === undefined) {
			group = { code: call.code, entry: call.entry, keys: [], calls: [] };
			groups.set(id, group);
		}
		group.keys.push(key);
		group.calls.push({
			elementIds: [...call.elementIds],
			...(call.inputsText !== null && { inputs: parseExact(call.inputsText, FLOATS) }),
			...(call.docText !== null && { doc: parseExact(call.docText, FLOATS) })
		});
	}
	return [...groups.values()].map(({ code, entry, keys, calls }) => ({
		batch: { code, entry, calls },
		entry,
		keys
	}));
}

/**
 * Runs `pass` until a pass records no miss, and answers that pass's value. A
 * pass that throws having recorded a miss may have thrown from a pending
 * answer, so it is discarded like any other; one that throws with none throws.
 *
 * What a round answers is kept, in the memo and the cache, only if no
 * transition moved since the pass that asked for it began: the keys of its
 * calls were read from that state and a transition would have evicted what the
 * cache then held. A pass the model moved under is run again without a round,
 * and a round it moved under is dropped and its calls are asked for again.
 * The batches of a round stop together: one that fails aborts the others, and
 * an abort of `signal` rejects the fill with its reason, whatever the runners
 * rejected with. The memo is the fill's own and a fresh fill starts empty,
 * so a result the cache does not keep (a timeout) runs again in the next one.
 */
export async function evaluateFilled<T>(
	pass: (scripts: ScriptReader) => Promise<T>,
	options: FillOptions
): Promise<{ value: T; stats: FillStats }> {
	const { runner, signal, cache, onProgress } = options;
	const transitions = options.transitions ?? (() => 0);
	const stdoutChars = options.stdoutChars ?? DEFAULT_HARNESS_LIMITS.stdoutChars;
	const memo = new Map<CellKey, ScriptResult>();
	let memoStamp = transitions();
	let missed = new Map<CellKey, ScriptCall>();
	const stats: FillStats = { rounds: 0, calls: 0 };
	let finished = 0;

	const scripts: ScriptReader = {
		read(call) {
			const key = cellKey(call.code, call.entry, call.elementIds, call.inputsText, call.docText);
			const held = memo.get(key) ?? cache?.get(key);
			if (held !== undefined) {
				memo.set(key, held);
				return held;
			}
			if (!missed.has(key)) missed.set(key, call);
			return PENDING;
		}
	};

	/**
	 * Every batch of a round, at once. The first to fail stops the others, and the round
	 * answers once all have ended: an abort is rejected with its reason, any other failure with
	 * the first one.
	 */
	async function runRound(groups: readonly Group[]): Promise<(readonly string[])[]> {
		const round = linked(signal);
		const failures: unknown[] = [];
		const outcomes = await Promise.allSettled(
			groups.map(async ({ batch }) => {
				try {
					const answered = await runner(batch, round.signal);
					if (answered.length !== batch.calls.length) {
						throw new Error(
							`the runner answered ${answered.length} results for ${batch.calls.length} calls`
						);
					}
					finished += batch.calls.length;
					onProgress?.(finished, stats.calls);
					return answered;
				} catch (error) {
					failures.push(error);
					round.abort(error);
					throw error;
				}
			})
		);
		round.dispose();
		if (signal.aborted) aborted(signal);
		if (failures.length > 0) throw failures[0];
		return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<readonly string[]>).value);
	}

	for (;;) {
		if (signal.aborted) aborted(signal);
		const stamp = transitions();
		if (stamp !== memoStamp) {
			memo.clear();
			memoStamp = stamp;
		}
		missed = new Map();
		let value: T | undefined;
		let failure: { error: unknown } | null = null;
		try {
			value = await pass(scripts);
		} catch (error) {
			failure = { error };
		}
		if (signal.aborted) aborted(signal);
		// The pass is one scan where the model cannot move under it; where it can, what it read is
		// read again from the state it ended in.
		if (transitions() !== stamp) continue;
		if (missed.size === 0) {
			if (failure !== null) throw failure.error;
			return { value: value as T, stats };
		}

		const groups = batchesOf(missed);
		stats.rounds++;
		stats.calls += missed.size;
		const texts = await runRound(groups);
		if (signal.aborted) aborted(signal);
		if (transitions() !== stamp) continue;
		groups.forEach(({ entry, keys }, g) => {
			keys.forEach((key, i) => {
				const text = texts[g]![i]!;
				const { result, sound } = settle(text, entry, stdoutChars);
				memo.set(key, result);
				if (sound) cache?.put(key, result, text);
			});
		});
	}
}
