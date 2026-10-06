import { z } from 'zod';
import { route } from './engine-route';
import { IssueCountsSchema, IssueListSchema, IssueSchema, type Issue } from './types';

export interface ValidateOptions {
	/** The engine's staged batches to validate, in order; none validates the committed model. */
	batchIds?: readonly number[];
}

/** The engine's issues over its staged batches (`batchIds`). */
export function validateModel(options?: ValidateOptions): Promise<Issue[]> {
	return route<unknown>('validateModel', { batch_ids: [...(options?.batchIds ?? [])] }).then(
		(answer) => IssueListSchema.parse(answer)
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
