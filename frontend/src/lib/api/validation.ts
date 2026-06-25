import { apiFetch, type ClientConfig } from './client';
import type { Op } from '$lib/state/ops';
import { IssueListSchema, type InlineModel, type Issue } from './types';

export interface ValidateOptions {
	inline?: InlineModel;
	scope?: string[];
	/** Staged (uncommitted) ops to validate against the committed model. */
	ops?: Op[];
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
