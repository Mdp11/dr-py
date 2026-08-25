import type { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';
import { ConflictError } from './errors';
import {
	CompareOutSchema,
	ProposeCrOutSchema,
	type ChangesDoc,
	type CompareOut,
	type Conflict
} from './types';
import type { ChangeRequest } from '$lib/state/cr';
import type { ModelOp } from '$lib/state/ops';

export type { CompareOut };

export type ProposeCrResult =
	| { ok: true; modelRev: number; cr: ChangesDoc; ops: ModelOp[] }
	| { ok: false; modelRev: number; crIndex: number; conflicts: Conflict[] };

/**
 * POST /model/compare — diff the SESSION model against a model file
 * (direction session → file; invert client-side with `invertChangeRequest`).
 * The picked File streams as the raw body: no JS-side parse. Read-only.
 */
export function compareModel(file: Blob, cfg?: ClientConfig): Promise<CompareOut> {
	return apiFetch('/model/compare', { method: 'POST', body: file, schema: CompareOutSchema }, cfg);
}

/**
 * POST /model/apply-cr — dry-run proposal: the CRs are applied in order
 * transiently server-side and come back as the combined `cr` (for preview)
 * plus the `ops` batch to stage. Nothing is applied. A 409 names the first
 * conflicting CR by index.
 */
export async function proposeCr(
	crs: ChangeRequest[],
	cfg?: ClientConfig
): Promise<ProposeCrResult> {
	try {
		const res = await apiFetch<z.infer<typeof ProposeCrOutSchema>>(
			'/model/apply-cr',
			{ method: 'POST', body: { crs }, schema: ProposeCrOutSchema },
			cfg
		);
		return { ok: true, modelRev: res.model_rev, cr: res.cr, ops: res.ops as unknown as ModelOp[] };
	} catch (err) {
		if (err instanceof ConflictError) {
			const body = (err.body ?? {}) as {
				cr_index?: number;
				conflicts?: Conflict[];
				model_rev?: number;
			};
			return {
				ok: false,
				modelRev: body.model_rev ?? -1,
				crIndex: body.cr_index ?? 0,
				conflicts: body.conflicts ?? []
			};
		}
		throw err;
	}
}
