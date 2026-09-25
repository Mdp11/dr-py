import { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';
import { comparableWhileStaged, route } from './engine-route';
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
	/** A rule set is staged: the engine validates with it, the server knows none. */
	rulesStaged?: boolean;
}

/**
 * POST /model/validate, or the engine over its staged batches (`batchIds`)
 * when the `issues` surface is on it. An inline model or a scope, and ops
 * no batch ids name, are the server's.
 */
export function validateModel(options?: ValidateOptions, cfg?: ClientConfig): Promise<Issue[]> {
	const ops = options?.ops ?? [];
	let body: unknown = undefined;
	if (ops.length > 0) {
		body = { ops, base_rev: options?.baseRev };
	} else if (options && (options.inline !== undefined || options.scope !== undefined)) {
		body = { inline: options.inline, scope: options.scope };
	}
	const server = () =>
		apiFetch<Issue[]>('/model/validate', { method: 'POST', body, schema: IssueListSchema }, cfg);
	const batchIds = options?.batchIds;
	if (ops.length > 0 ? batchIds === undefined : body !== undefined) return server();
	return route(
		'issues',
		cfg,
		(call) =>
			call<unknown>('validateModel', { batch_ids: [...(batchIds ?? [])] }).then((answer) =>
				IssueListSchema.parse(answer)
			),
		server,
		// With nothing staged the server makes a full run, which names one
		// member of a containment cycle where the engine names every element
		// on it; `getModelIssues` compares the unstaged state instead.
		{
			shadow:
				ops.length === 0 || options?.rulesStaged === true ? 'never' : comparableWhileStaged(ops)
		}
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

/** GET /model/issues — snapshot of the server's maintained issue store.
 * Cheap by contract (never a pipeline run); `counts` is exact even when
 * `issues` is truncated at the server-side cap. */
export const IssueListOutSchema = z.object({
	model_rev: z.number().int(),
	issues: z.array(IssueSchema).default([]),
	counts: IssueCountsSchema.default({}),
	truncated: z.boolean().default(false),
	rules_status: RulesStatusSchema.nullable().default(null)
});
export type IssueList = z.infer<typeof IssueListOutSchema>;

/**
 * On the engine, the working copy's issues: a staged edit's own are
 * `uncommitted`. An answer from a replica the surface no longer routes to —
 * one whose store may not be swept whole yet — is replaced by the server's.
 */
export function getModelIssues(cfg?: ClientConfig): Promise<IssueList> {
	return route(
		'issues',
		cfg,
		(call) =>
			call<unknown>('getModelIssues', {}).then((answer) => IssueListOutSchema.parse(answer)),
		() => apiFetch<IssueList>('/model/issues', { method: 'GET', schema: IssueListOutSchema }, cfg),
		{ recheck: true }
	);
}
