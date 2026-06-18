import { apiFetch, type ClientConfig } from './client';
import type { Op } from '$lib/state/ops';
import {
	CommitResponseSchema,
	LockResponseSchema,
	OpenResponseSchema,
	PreviewResponseSchema,
	RenewResponseSchema,
	type CommitResponse,
	type LockRequest,
	type LockResponse,
	type OpenResponse,
	type PreviewResponse,
	type RenewResponse
} from './types';

/** GET /open — model_rev, role, counts, and lock_ttl_seconds. */
export function openProject(cfg?: ClientConfig): Promise<OpenResponse> {
	return apiFetch('/open', { method: 'GET', schema: OpenResponseSchema }, cfg);
}

/** POST /locks — all-or-nothing acquire. Throws ConflictError (409) on
 * conflict (body carries `conflicts`). */
export function acquireLocks(req: LockRequest, cfg?: ClientConfig): Promise<LockResponse> {
	return apiFetch('/locks', { method: 'POST', body: req, schema: LockResponseSchema }, cfg);
}

/** POST /locks/release — release every lease under `token`. */
export function releaseLock(token: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch('/locks/release', { method: 'POST', body: { token } }, cfg);
}

/** POST /locks/renew — heartbeat-extend all leases under `token`. */
export function renewLock(token: string, cfg?: ClientConfig): Promise<RenewResponse> {
	return apiFetch('/locks/renew', { method: 'POST', body: { token }, schema: RenewResponseSchema }, cfg);
}

/** POST /commits/preview — apply→validate→rollback. Throws ConflictError on
 * stale base_rev (409). */
export function previewCommit(
	baseRev: number,
	ops: readonly Op[],
	cfg?: ClientConfig
): Promise<PreviewResponse> {
	return apiFetch(
		'/commits/preview',
		{ method: 'POST', body: { base_rev: baseRev, ops }, schema: PreviewResponseSchema },
		cfg
	);
}

/** POST /commits — lock-verified, structural-gated commit. Throws
 * ConflictError (409: stale rev or missing lock) / ValidationError (422:
 * structural blocker). */
export function commitChanges(
	req: { baseRev: number; ops: readonly Op[]; message: string; lockTokens: string[]; ackErrors: boolean },
	cfg?: ClientConfig
): Promise<CommitResponse> {
	return apiFetch(
		'/commits',
		{
			method: 'POST',
			body: {
				base_rev: req.baseRev,
				ops: req.ops,
				message: req.message,
				lock_tokens: req.lockTokens,
				ack_errors: req.ackErrors
			},
			schema: CommitResponseSchema
		},
		cfg
	);
}
