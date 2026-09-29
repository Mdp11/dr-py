import type { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';
import { asSent, route } from './engine-route';
import { ConflictError } from './errors';
import {
	CompareOutSchema,
	EngineCompareSchema,
	EngineProposeSchema,
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

/** `value` without its `cr.createdAt`, which each side reads off its own clock. */
function maskCreatedAt(value: CompareOut | ProposeCrResult): Promise<unknown> {
	if (!('cr' in value)) return Promise.resolve(value);
	const cr: Partial<ChangesDoc> = { ...value.cr };
	delete cr.createdAt;
	return Promise.resolve({ ...value, cr });
}

/**
 * POST /model/compare — diff the model against a model file (direction
 * model → file; invert client-side with `invertChangeRequest`). The server
 * diffs the committed model, the picked File streaming as the raw body with
 * no JS-side parse; the engine diffs the working copy, staged edits
 * included, the file's bytes moved to it. A file the engine cannot read is
 * the server's. Read-only.
 */
export function compareModel(file: Blob, cfg?: ClientConfig): Promise<CompareOut> {
	return route<CompareOut>(
		'compare',
		cfg,
		async (call) => {
			const bytes = await file.arrayBuffer();
			const params = { file: bytes, created_at: new Date().toISOString() };
			return EngineCompareSchema.parse(await call('compareModel', params, undefined, [bytes]));
		},
		() => apiFetch('/model/compare', { method: 'POST', body: file, schema: CompareOutSchema }, cfg),
		{ shadow: 'unstaged', digest: maskCreatedAt }
	);
}

function proposed(body: z.infer<typeof ProposeCrOutSchema>): ProposeCrResult {
	return { ok: true, modelRev: body.model_rev, cr: body.cr, ops: body.ops as unknown as ModelOp[] };
}

function conflicted(body: z.infer<typeof ProposeCrConflictSchema>): ProposeCrResult {
	return {
		ok: false,
		modelRev: body.model_rev,
		crIndex: body.cr_index,
		conflicts: body.conflicts
	};
}

/**
 * POST /model/apply-cr — dry-run proposal: the CRs are applied in order
 * transiently, over the committed model on the server or the working copy
 * on the engine, and come back as the combined `cr` (for preview) plus the
 * `ops` batch to stage. Nothing is applied. The first conflicting CR, by
 * index, answers `ok: false` whichever side answered: the server's 409, the
 * engine's `conflict`. Change requests the engine does not read as the
 * server does are the server's.
 */
export function proposeCr(crs: ChangeRequest[], cfg?: ClientConfig): Promise<ProposeCrResult> {
	return route<ProposeCrResult>(
		'compare',
		cfg,
		async (call) => {
			const params = { crs: asSent(crs), created_at: new Date().toISOString() };
			const answer = EngineProposeSchema.parse(await call('proposeCr', params));
			return 'conflict' in answer ? conflicted(answer.conflict) : proposed(answer);
		},
		() => serverProposal(crs, cfg),
		{ shadow: 'unstaged', digest: maskCreatedAt }
	);
}

async function serverProposal(crs: ChangeRequest[], cfg?: ClientConfig): Promise<ProposeCrResult> {
	try {
		return proposed(
			await apiFetch<z.infer<typeof ProposeCrOutSchema>>(
				'/model/apply-cr',
				{ method: 'POST', body: { crs }, schema: ProposeCrOutSchema },
				cfg
			)
		);
	} catch (err) {
		if (err instanceof ConflictError) {
			const parsed = ProposeCrConflictSchema.safeParse(err.body);
			// an unrecognized 409 body still stops the flow — the report is then
			// empty rather than invented, and modelRev -1 can never match a rev
			if (!parsed.success) return { ok: false, modelRev: -1, crIndex: 0, conflicts: [] };
			return conflicted(parsed.data);
		}
		throw err;
	}
}
