import type { z } from 'zod';
import { asSent, route } from './engine-route';
import {
	CompareOutSchema,
	EngineCompareSchema,
	EngineProposeSchema,
	ProposeCrConflictSchema,
	ProposeCrOutSchema,
	type ChangesDoc,
	type Conflict
} from './types';
import type { ChangeRequest } from '$lib/state/cr';
import type { ModelOp } from '$lib/state/ops';

/** `workingCopy` says the answer holds the staged edits: the engine reads the working copy. */
export type CompareOut = z.infer<typeof CompareOutSchema> & { workingCopy: boolean };

/** Mirrors `MAX_CRS_PER_REQUEST` in `api/schemas.py`: the server rejects a
 * longer `crs` list at request-parse time. Mirrored so the dialog can say so
 * in its own words — the server bound stays the authority. */
export const MAX_CRS_PER_REQUEST = 20;

export type ProposeCrResult =
	| { ok: true; modelRev: number; cr: ChangesDoc; ops: ModelOp[]; workingCopy: boolean }
	| { ok: false; modelRev: number; crIndex: number; conflicts: Conflict[]; workingCopy: boolean };

/**
 * Diff the working copy, staged edits included, against a model file
 * (direction model → file; invert client-side with `invertChangeRequest`),
 * the file's bytes moved to the engine. A file the engine cannot read is a
 * 422. Read-only.
 */
export async function compareModel(file: Blob): Promise<CompareOut> {
	const bytes = await file.arrayBuffer();
	const params = { file: bytes, created_at: new Date().toISOString() };
	const answer = EngineCompareSchema.parse(
		await route<unknown>('compareModel', params, { transfer: [bytes] })
	);
	return { ...answer, workingCopy: true };
}

function proposed(body: z.infer<typeof ProposeCrOutSchema>, workingCopy: boolean): ProposeCrResult {
	return {
		ok: true,
		modelRev: body.model_rev,
		cr: body.cr,
		ops: body.ops as unknown as ModelOp[],
		workingCopy
	};
}

function conflicted(
	body: z.infer<typeof ProposeCrConflictSchema>,
	workingCopy: boolean
): ProposeCrResult {
	return {
		ok: false,
		modelRev: body.model_rev,
		crIndex: body.cr_index,
		conflicts: body.conflicts,
		workingCopy
	};
}

/**
 * Dry-run proposal: the CRs are applied in order transiently over the working
 * copy and come back as the combined `cr` (for preview) plus the `ops` batch
 * to stage. Nothing is applied. The first conflicting CR, by index, answers
 * `ok: false`: the engine's `conflict`. Change requests the engine does not
 * read are a 422.
 */
export async function proposeCr(crs: ChangeRequest[]): Promise<ProposeCrResult> {
	const params = { crs: asSent(crs), created_at: new Date().toISOString() };
	const answer = EngineProposeSchema.parse(await route<unknown>('proposeCr', params));
	return 'conflict' in answer ? conflicted(answer.conflict, true) : proposed(answer, true);
}
