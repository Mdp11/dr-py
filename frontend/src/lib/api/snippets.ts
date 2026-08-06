import { apiFetch, type ClientConfig } from './client';
import {
	SnippetFormatOutSchema,
	SnippetLintOutSchema,
	SnippetRunOutSchema,
	SnippetDocsOutSchema,
	type SnippetFormatOut,
	type SnippetLintOut,
	type SnippetDocsOut
} from './types';
import type { ModelOp } from '$lib/state/ops';
import type { z } from 'zod';

/** SnippetRunOut with `ops` typed as the staged-buffer wire format — the
 * backend records ops in exactly the `state/ops.ts` shape (validated through
 * OPS_ADAPTER server-side), so the cast is the contract, not a guess.
 * `ModelOp`, not the full `Op` union: the guest facade has no artifact
 * surface, and `POST /snippets/run` refuses a guest-proposed artifact op
 * outright (CLAUDE.md), so a dry-run batch can only ever hold model ops. */
export type SnippetRunOut = Omit<z.infer<typeof SnippetRunOutSchema>, 'ops'> & { ops: ModelOp[] };

export interface SnippetRunBody {
	run_id: string;
	code?: string;
	artifact_id?: string;
	entry?: 'script' | 'value' | 'step';
	element_ids?: string[];
}

export function runSnippet(body: SnippetRunBody, cfg?: ClientConfig): Promise<SnippetRunOut> {
	return apiFetch(
		'/snippets/run',
		{ method: 'POST', body, schema: SnippetRunOutSchema },
		cfg
	) as Promise<SnippetRunOut>;
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

export function cancelSnippet(runId: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch('/snippets/cancel', { method: 'POST', body: { run_id: runId } }, cfg);
}

export function getSnippetDocs(cfg?: ClientConfig): Promise<SnippetDocsOut> {
	return apiFetch('/snippets/docs', { schema: SnippetDocsOutSchema }, cfg);
}
