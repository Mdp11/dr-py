import { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';
import type { ModelOp } from '$lib/state/ops';
import {
	IssueCountsSchema,
	IssueListSchema,
	IssueSchema,
	type InlineModel,
	type Issue
} from './types';

export interface ValidateOptions {
	inline?: InlineModel;
	scope?: string[];
	/** Staged (uncommitted) ops to validate against the committed model.
	 * `ModelOp`, not the full `Op` union: CLAUDE.md is explicit that
	 * `POST /model/validate` rejects artifact ops permanently. */
	ops?: ModelOp[];
	/** model_rev the ops were computed against; sent as base_rev (409 on stale). */
	baseRev?: number;
}

export function validateModel(options?: ValidateOptions, cfg?: ClientConfig): Promise<Issue[]> {
	let body: unknown = undefined;
	if (options?.ops !== undefined && options.ops.length > 0) {
		body = { ops: options.ops, base_rev: options.baseRev };
	} else if (options && (options.inline !== undefined || options.scope !== undefined)) {
		body = { inline: options.inline, scope: options.scope };
	}
	return apiFetch('/model/validate', { method: 'POST', body, schema: IssueListSchema }, cfg);
}

/** GET /model/issues — snapshot of the server's maintained issue store.
 * Cheap by contract (never a pipeline run); `counts` is exact even when
 * `issues` is truncated at the server-side cap. */
export const IssueListOutSchema = z.object({
	model_rev: z.number().int(),
	issues: z.array(IssueSchema).default([]),
	counts: IssueCountsSchema.default({}),
	truncated: z.boolean().default(false)
});
export type IssueList = z.infer<typeof IssueListOutSchema>;

export function getModelIssues(cfg?: ClientConfig): Promise<IssueList> {
	return apiFetch('/model/issues', { method: 'GET', schema: IssueListOutSchema }, cfg);
}
