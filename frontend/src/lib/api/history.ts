import { apiFetch, type ClientConfig } from './client';
import {
	CommitDiffSchema,
	CommitHistoryResponseSchema,
	CommitResponseSchema,
	RangeDiffSchema,
	type CommitDiff,
	type CommitHistoryResponse,
	type CommitResponse,
	type RangeDiff
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

/** GET /commits/{rev}/diff — one commit's changes, rendered by the server
 * from the journal row (no model reconstruction on either side). */
export function getCommitDiff(rev: number, cfg?: ClientConfig): Promise<CommitDiff> {
	return apiFetch(`/commits/${rev}/diff`, { method: 'GET', schema: CommitDiffSchema }, cfg);
}

/** GET /commits/diff — the net change between two revisions; the server
 * folds the journal over the range or reconstructs both sides itself. */
export function getCommitsDiff(
	fromRev: number,
	toRev: number,
	cfg?: ClientConfig
): Promise<RangeDiff> {
	return apiFetch(
		'/commits/diff',
		{ method: 'GET', query: { from: fromRev, to: toRev }, schema: RangeDiffSchema },
		cfg
	);
}

/** POST /commits/revert — revert-to-commit. Throws ConflictError (409:
 * stale rev / rebind / peer lock) or ValidationError (422: structural). */
export function revertToCommit(
	req: { targetRev: number; baseRev: number; message?: string },
	cfg?: ClientConfig,
	onText?: (text: string) => void
): Promise<CommitResponse> {
	return apiFetch(
		'/commits/revert',
		{
			method: 'POST',
			body: { target_rev: req.targetRev, base_rev: req.baseRev, message: req.message },
			schema: CommitResponseSchema,
			onText
		},
		cfg
	);
}
