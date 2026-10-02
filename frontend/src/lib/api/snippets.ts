import { apiFetch, type ClientConfig } from './client';
import {
	SnippetFormatOutSchema,
	SnippetLintOutSchema,
	SnippetDocsOutSchema,
	type SnippetFormatOut,
	type SnippetLintOut,
	type SnippetDocsOut,
	type SnippetError
} from './types';
import type { ModelOp } from '$lib/state/ops';
import type { RunSnippetParams, RunSnippetResult } from '$engine';
import { callEngine } from '$lib/state/replica.svelte';

/** The engine's run result with `ops` typed as the staged-buffer wire format and `error.kind` as the console's kinds.
 * `ModelOp`, not the full `Op` union: the guest facade has no artifact surface and the engine gates a run's ops to model ops. */
export type SnippetRunOut = Omit<RunSnippetResult, 'ops' | 'error'> & {
	ops: ModelOp[];
	error: SnippetError | null;
};

/** One named input for a two-argument `value(elements, inputs)` run — the
 * same wire shape a script column's resolved inputs take server-side
 * (`core/script/runner.py`'s `WireInput`). */
export type SnippetRunInput =
	| { kind: 'elements'; ids: string[] }
	| { kind: 'scalars'; values: unknown[] };

export interface SnippetRunBody {
	code?: string;
	artifact_id?: string;
	entry?: 'script' | 'value' | 'step';
	element_ids?: string[];
	/** Only meaningful for `entry: 'value'`. */
	inputs?: Record<string, SnippetRunInput>;
}

/** One console run over the engine's working copy. `signal` cancels it: the run's script is stopped and the call rejects. */
export function runSnippet(
	body: SnippetRunBody,
	options?: { signal?: AbortSignal }
): Promise<SnippetRunOut> {
	const params: RunSnippetParams = {
		...(body.code !== undefined ? { code: body.code } : {}),
		...(body.artifact_id !== undefined ? { artifact_id: body.artifact_id } : {}),
		entry: body.entry ?? 'script',
		element_ids: body.element_ids ?? [],
		...(body.inputs !== undefined ? { inputs: body.inputs } : {})
	};
	return callEngine<SnippetRunOut>('runSnippet', params, options);
}

export function lintSnippet(code: string, cfg?: ClientConfig): Promise<SnippetLintOut> {
	return apiFetch(
		'/snippets/lint',
		{ method: 'POST', body: { code }, schema: SnippetLintOutSchema },
		cfg
	);
}

export function formatSnippet(code: string, cfg?: ClientConfig): Promise<SnippetFormatOut> {
	return apiFetch(
		'/snippets/format',
		{ method: 'POST', body: { code }, schema: SnippetFormatOutSchema },
		cfg
	);
}

export function getSnippetDocs(cfg?: ClientConfig): Promise<SnippetDocsOut> {
	return apiFetch('/snippets/docs', { schema: SnippetDocsOutSchema }, cfg);
}
