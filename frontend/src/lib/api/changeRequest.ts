import { apiFetch, type ClientConfig } from './client';
import { ConflictError } from './errors';
import {
	IssueListSchema,
	ModelOutSchema,
	type Conflict,
	type InlineModel,
	type Issue,
	type ModelOut
} from './types';
import type { ChangeRequest } from '$lib/state/cr';

export type ApplyCrResult =
	| { ok: true; model: ModelOut; issues: Issue[] }
	| { ok: false; conflicts: Conflict[] };

export async function applyCr(
	model: InlineModel,
	cr: ChangeRequest,
	cfg?: ClientConfig
): Promise<ApplyCrResult> {
	try {
		const res = await apiFetch<{ model: unknown; issues: unknown }>(
			'/model/apply-cr',
			{ method: 'POST', body: { model, cr } },
			cfg
		);
		return {
			ok: true,
			model: ModelOutSchema.parse(res.model),
			issues: IssueListSchema.parse(res.issues)
		};
	} catch (err) {
		if (err instanceof ConflictError) {
			const body = err.body as { conflicts?: Conflict[] } | undefined;
			const conflicts = body?.conflicts ?? [];
			return { ok: false, conflicts };
		}
		throw err;
	}
}
