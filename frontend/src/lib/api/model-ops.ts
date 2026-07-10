import { apiFetch, apiUpload, type ClientConfig } from './client';
import {
	ModelSummarySchema,
	OpsResponseSchema,
	SaveModelResponseSchema,
	type ModelSummary,
	type OpsResponse,
	type SaveModelResponse
} from './types';
import type { Op } from '$lib/state/ops';
import type { ChangeRequest } from '$lib/state/cr';

/**
 * Mutation side of the delta protocol (Phase D1): op batches, undo,
 * session-mode change requests, and the streaming load/save lifecycle.
 * The session model on the backend is the source of truth; every mutation
 * here returns either a delta ({@link OpsResponse}) or a fresh summary.
 */

/**
 * POST /model/ops — apply an atomic op batch against `baseRev`.
 *
 * The op shapes are the `$lib/state/ops` union verbatim (the backend was
 * built from that file). Raises `ConflictError` (409, body carries the
 * current `model_rev`) on a rev mismatch and `ValidationError` (422) when an
 * op is invalid — in both cases the server model is unchanged.
 */
export function applyOps(
	baseRev: number,
	ops: readonly Op[],
	cfg?: ClientConfig
): Promise<OpsResponse> {
	return apiFetch(
		'/model/ops',
		{ method: 'POST', body: { base_rev: baseRev, ops }, schema: OpsResponseSchema },
		cfg
	);
}

/**
 * POST /model/undo — revert the most recent op batch. Raises `ConflictError`
 * (409) when there is no history to undo.
 */
export function undoOps(cfg?: ClientConfig): Promise<OpsResponse> {
	return apiFetch('/model/undo', { method: 'POST', schema: OpsResponseSchema }, cfg);
}

/**
 * POST /model/apply-cr in SESSION mode (no `model` field): the change request
 * is applied to the session model and an OpsResponse-shaped delta comes back
 * (`id_map` is always empty — CRs carry final ids). Applying a CR resets the
 * server-side undo history. The legacy inline mode lives in
 * `./changeRequest.ts`.
 */
export function applyCrSession(cr: ChangeRequest, cfg?: ClientConfig): Promise<OpsResponse> {
	return apiFetch(
		'/model/apply-cr',
		{ method: 'POST', body: { cr }, schema: OpsResponseSchema },
		cfg
	);
}

/**
 * POST /model/load — load a model JSON file from the SERVER's local
 * filesystem (localhost single-user trust model). Returns the summary of the
 * freshly installed model (validation already seeded server-side).
 */
export function loadModelFromPath(path: string, cfg?: ClientConfig): Promise<ModelSummary> {
	return apiFetch(
		'/model/load',
		{ method: 'POST', body: { path }, schema: ModelSummarySchema },
		cfg
	);
}

/**
 * POST /model/upload — stream a model file as the raw request body (no
 * client-side JSON.parse). Pass the picked `File`/`Blob` straight through.
 * Uploaded via XHR (apiUpload) so callers can drive a progress overlay off
 * upload byte counts.
 */
export function uploadModelBody(
	body: Blob | ArrayBuffer | string,
	cfg?: ClientConfig,
	onProgress?: (loaded: number, total: number | null) => void
): Promise<ModelSummary> {
	return apiUpload('/model/upload', { body, schema: ModelSummarySchema, onProgress }, cfg);
}

/**
 * POST /model/save — write the session model to a server-local path
 * (atomic temp-file + rename server-side).
 */
export function saveModelToPath(path: string, cfg?: ClientConfig): Promise<SaveModelResponse> {
	return apiFetch(
		'/model/save',
		{ method: 'POST', body: { path }, schema: SaveModelResponseSchema },
		cfg
	);
}
