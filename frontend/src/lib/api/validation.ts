import { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';
import { route } from './engine-route';
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
	 * `ModelOp`, not the full `Op` union: src/data_rover/api/README.md is explicit that
	 * `POST /model/validate` rejects artifact ops permanently. */
	ops?: ModelOp[];
	/** model_rev the ops were computed against; sent as base_rev (409 on stale). */
	baseRev?: number;
	/** The engine's staged batches `ops` are, in order: the engine validates those. */
	batchIds?: readonly number[];
}

/**
 * The engine over its staged batches (`batchIds`); an inline model or a
 * scope, and ops no batch ids name, are `POST /model/validate`.
 */
export function validateModel(options?: ValidateOptions, cfg?: ClientConfig): Promise<Issue[]> {
	const ops = options?.ops ?? [];
	let body: unknown = undefined;
	if (ops.length > 0) {
		body = { ops, base_rev: options?.baseRev };
	} else if (options && (options.inline !== undefined || options.scope !== undefined)) {
		body = { inline: options.inline, scope: options.scope };
	}
	const batchIds = options?.batchIds;
	if (ops.length > 0 ? batchIds === undefined : body !== undefined) {
		return apiFetch<Issue[]>(
			'/model/validate',
			{ method: 'POST', body, schema: IssueListSchema },
			cfg
		);
	}
	return route<unknown>('validateModel', { batch_ids: [...(batchIds ?? [])] }).then((answer) =>
		IssueListSchema.parse(answer)
	);
}

/** One compiled rule skipped whole at compile time (metamodel drift): the
 * rule references a stereotype/relationship type/property the metamodel
 * doesn't have. `rule === ''` means the whole set failed to parse, not one
 * rule drifting. */
export const RuleSkipSchema = z.object({
	artifact_id: z.string(),
	set_name: z.string(),
	rule: z.string(),
	reason: z.string()
});
export type RuleSkip = z.infer<typeof RuleSkipSchema>;

/** Compiled-rules health, read off the session's cached rule set. Nullable
 * to mirror the backend's `RulesStatusOut | None`. */
export const RulesStatusSchema = z.object({
	total: z.number(),
	skipped: z.array(RuleSkipSchema),
	eval_errors: z.record(z.string(), z.number())
});
export type RulesStatus = z.infer<typeof RulesStatusSchema>;

/** A snapshot of the issue store. Cheap by contract (never a sweep);
 * `counts` is exact even when `issues` is truncated at the cap. */
export const IssueListOutSchema = z.object({
	model_rev: z.number().int(),
	issues: z.array(IssueSchema).default([]),
	counts: IssueCountsSchema.default({}),
	truncated: z.boolean().default(false),
	rules_status: RulesStatusSchema.nullable().default(null)
});
export type IssueList = z.infer<typeof IssueListOutSchema>;

/** The working copy's issues: a staged edit's own are `uncommitted`. */
export function getModelIssues(): Promise<IssueList> {
	return route<unknown>('getModelIssues', {}).then((answer) => IssueListOutSchema.parse(answer));
}
