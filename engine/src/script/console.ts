import { ReadError } from '../read/errors.ts';
import { OP_KINDS, readOps, toWire, wireOps } from '../read/wire.ts';
import { parseExact } from '../value/parse.ts';
import type { Value } from '../value/types.ts';

export type ConsoleEntry = 'script' | 'value' | 'step';

/** `runSnippet`'s params: one of `code` / `artifact_id`, the entry and what it runs on. */
export type RunSnippetParams = {
	code?: string;
	artifact_id?: string;
	entry: ConsoleEntry;
	element_ids: string[];
	/** `value` only, in the harness's wire shape. */
	inputs?: Record<string, unknown>;
};

/** Where the replica stood when a run began. */
export type RunStamp = { rev: number; staged: number };

export type RunSnippetResult = {
	stdout: string;
	result_repr: string | null;
	/** The model ops the run proposed. */
	ops: unknown[];
	error: { kind: string; message: string; traceback: string | null } | null;
	truncated: boolean;
	duration_ms: number;
	stamp: RunStamp;
};

const ENTRIES: readonly string[] = ['script', 'value', 'step'];

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Each input is `{kind: 'elements', ids?: string[]}` or `{kind: 'scalars', values?: any[]}`. */
function readInputs(inputs: unknown): void {
	if (!isObject(inputs)) throw new ReadError(422, 'inputs must be an object');
	for (const [name, spec] of Object.entries(inputs)) {
		const where = `inputs.${name}`;
		if (!isObject(spec)) throw new ReadError(422, `${where} must be an object`);
		const { kind } = spec;
		if (kind === 'elements') {
			const ids = spec['ids'] ?? [];
			if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
				throw new ReadError(422, `${where}.ids must be a list of strings`);
			}
		} else if (kind === 'scalars') {
			if (!Array.isArray(spec['values'] ?? [])) {
				throw new ReadError(422, `${where}.values must be a list`);
			}
		} else {
			throw new ReadError(422, `${where}.kind must be 'elements' or 'scalars'`);
		}
	}
}

/** `runSnippet`'s params, read whole before anything runs. */
export function readRunSnippet(params: unknown): RunSnippetParams {
	if (!isObject(params)) throw new ReadError(422, 'params must be an object');
	const { code, artifact_id: artifactId, inputs } = params;
	const hasCode = code !== undefined && code !== null;
	const hasArtifact = artifactId !== undefined && artifactId !== null;
	if (hasCode === hasArtifact)
		throw new ReadError(422, 'provide exactly one of `code` / `artifact_id`');
	if (hasCode && typeof code !== 'string') throw new ReadError(422, 'code must be a string');
	if (hasArtifact && typeof artifactId !== 'string') {
		throw new ReadError(422, 'artifact_id must be a string');
	}
	const entry = params['entry'] ?? 'script';
	if (typeof entry !== 'string' || !ENTRIES.includes(entry)) {
		throw new ReadError(422, "entry must be 'script', 'value' or 'step'");
	}
	const ids = params['element_ids'] ?? [];
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
		throw new ReadError(422, 'element_ids must be a list of strings');
	}
	if (entry === 'value' && ids.length < 1) {
		throw new ReadError(422, "entry 'value' requires at least one element id");
	}
	if (entry === 'step' && ids.length !== 1) {
		throw new ReadError(422, "entry 'step' requires exactly one element id");
	}
	const hasInputs = inputs !== undefined && inputs !== null;
	if (hasInputs && entry !== 'value') {
		throw new ReadError(422, "`inputs` is only meaningful for entry 'value'");
	}
	if (hasInputs) readInputs(inputs);
	return {
		...(hasCode ? { code: code as string } : { artifact_id: artifactId as string }),
		entry: entry as ConsoleEntry,
		element_ids: ids as string[],
		...(hasInputs ? { inputs: inputs as Record<string, unknown> } : {})
	};
}

/**
 * Reads the ops a run proposed as the stage would: only model ops, each well formed. The ops are
 * answered as `readOps` normalises them.
 */
export function gateOps(
	ops: readonly unknown[]
): { ok: true; ops: unknown[] } | { ok: false; message: string } {
	for (const op of ops) {
		const kind = isObject(op) ? op['kind'] : undefined;
		if (typeof kind !== 'string' || !OP_KINDS.includes(kind)) {
			const named = typeof kind === 'string' ? kind : String(kind);
			return { ok: false, message: `the script proposed a ${named} op, which is not a model op` };
		}
	}
	try {
		return { ok: true, ops: wireOps(readOps([...ops])) };
	} catch (error) {
		if (!(error instanceof ReadError)) throw error;
		return { ok: false, message: `the script proposed a malformed op: ${error.detail}` };
	}
}

/** A harness answer (`{stdout, result_repr, truncated, error?}`) and the ops its run proposed. */
export function consoleAnswer(
	text: string,
	ops: readonly unknown[],
	durationMs: number,
	stamp: RunStamp
): RunSnippetResult {
	const body = toWire(
		parseExact(text, { floatConstants: true, controlCharacters: false }) as Value
	);
	if (!isObject(body))
		throw new ReadError(500, 'the script host answered a console run that is no object');
	const error = isObject(body['error']) ? body['error'] : null;
	const gate = gateOps(ops);
	return {
		stdout: typeof body['stdout'] === 'string' ? body['stdout'] : '',
		result_repr: typeof body['result_repr'] === 'string' ? body['result_repr'] : null,
		ops: gate.ok ? gate.ops : [],
		error: gate.ok
			? error === null
				? null
				: {
						kind: String(error['kind'] ?? 'runtime'),
						message: String(error['message'] ?? ''),
						traceback: typeof error['traceback'] === 'string' ? error['traceback'] : null
					}
			: {
					kind: 'runtime',
					message: gate.message,
					traceback: null
				},
		truncated: body['truncated'] === true,
		duration_ms: durationMs,
		stamp
	};
}
