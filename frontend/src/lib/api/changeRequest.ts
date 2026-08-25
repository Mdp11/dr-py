import type { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';
import { ConflictError } from './errors';
import {
	CompareOutSchema,
	ProposeCrConflictSchema,
	ProposeCrOutSchema,
	type ChangesDoc,
	type CompareOut,
	type Conflict
} from './types';
import type { ChangeRequest } from '$lib/state/cr';
import type { ModelOp } from '$lib/state/ops';

export type { CompareOut };

/** Mirrors `MAX_CRS_PER_REQUEST` in `api/schemas.py`: the server rejects a
 * longer `crs` list at request-parse time. Mirrored so the dialog can say so
 * in its own words — the server bound stays the authority. */
export const MAX_CRS_PER_REQUEST = 20;

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
			const parsed = ProposeCrConflictSchema.safeParse(err.body);
			// an unrecognized 409 body still stops the flow — the report is then
			// empty rather than invented, and modelRev -1 can never match a rev
			if (!parsed.success) return { ok: false, modelRev: -1, crIndex: 0, conflicts: [] };
			return {
				ok: false,
				modelRev: parsed.data.model_rev,
				crIndex: parsed.data.cr_index,
				conflicts: parsed.data.conflicts
			};
		}
		throw err;
	}
}
