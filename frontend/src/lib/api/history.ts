import { apiFetch, type ClientConfig } from './client';
import {
	CommitDiffSchema,
	CommitHistoryResponseSchema,
	CommitResponseSchema,
	ModelOutSchema,
	type CommitDiff,
	type CommitHistoryResponse,
	type CommitResponse,
	type ModelOut
} from './types';

/** GET /commits — durable commit history, newest-first, paged. */
export function getCommitHistory(
	opts?: { limit?: number; beforeRev?: number },
	cfg?: ClientConfig
): Promise<CommitHistoryResponse> {
	return apiFetch(
		'/commits',
		{
			method: 'GET',
			query: { limit: opts?.limit, before_rev: opts?.beforeRev },
			schema: CommitHistoryResponseSchema
		},
		cfg
	);
}

/** GET /commits/{rev}/model — full model as it existed at `rev`. */
export function getModelAtRev(rev: number, cfg?: ClientConfig): Promise<ModelOut> {
	return apiFetch(`/commits/${rev}/model`, { method: 'GET', schema: ModelOutSchema }, cfg);
}

/** GET /commits/{rev}/diff — one commit's changes, rendered by the server
 * from the journal row (no model reconstruction on either side). */
export function getCommitDiff(rev: number, cfg?: ClientConfig): Promise<CommitDiff> {
	return apiFetch(`/commits/${rev}/diff`, { method: 'GET', schema: CommitDiffSchema }, cfg);
}

/** POST /commits/revert — revert-to-commit. Throws ConflictError (409:
 * stale rev / rebind / peer lock) or ValidationError (422: structural). */
export function revertToCommit(
	req: { targetRev: number; baseRev: number; message?: string },
	cfg?: ClientConfig
): Promise<CommitResponse> {
	return apiFetch(
		'/commits/revert',
		{
			method: 'POST',
			body: { target_rev: req.targetRev, base_rev: req.baseRev, message: req.message },
			schema: CommitResponseSchema
		},
		cfg
	);
}
