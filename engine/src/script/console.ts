import { ReadError } from '../read/errors.ts';
import { OP_KINDS, toWire } from '../read/wire.ts';
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
	if (hasInputs && !isObject(inputs)) throw new ReadError(422, 'inputs must be an object');
	return {
		...(hasCode ? { code: code as string } : { artifact_id: artifactId as string }),
		entry: entry as ConsoleEntry,
		element_ids: ids as string[],
		...(hasInputs ? { inputs: inputs as Record<string, unknown> } : {})
	};
}

/** Whether every op a run proposed is a model op: nothing else is staged from a console. */
export function gateOps(ops: readonly unknown[]): { ok: true } | { ok: false; kind: string } {
	for (const op of ops) {
		const kind = isObject(op) ? op['kind'] : undefined;
		if (typeof kind !== 'string' || !OP_KINDS.includes(kind)) {
			return { ok: false, kind: typeof kind === 'string' ? kind : String(kind) };
		}
	}
	return { ok: true };
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
		ops: gate.ok ? [...ops] : [],
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
					message: `the script proposed a ${gate.kind} op, which is not a model op`,
					traceback: null
				},
		truncated: body['truncated'] === true,
		duration_ms: durationMs,
		stamp
	};
}
