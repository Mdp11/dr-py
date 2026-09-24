import { apiFetch, type ClientConfig } from './client';
import { comparableWhileStaged, route } from './engine-route';
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
	return apiFetch(
		'/locks/renew',
		{ method: 'POST', body: { token }, schema: RenewResponseSchema },
		cfg
	);
}

const MODEL_OP_KINDS = new Set<string>([
	'create_element',
	'update_element',
	'delete_element',
	'create_relationship',
	'update_relationship',
	'delete_relationship'
]);

/**
 * POST /commits/preview — apply→validate→rollback. Throws ConflictError on
 * stale base_rev (409).
 *
 * With `local` — the engine's staged batches the model ops are, and the
 * strict mode — and the `issues` surface on the engine, the engine previews
 * the model half; the server previews the other ops alone, and the two
 * halves are summed. A rebind, which revalidates everything under a new
 * metamodel, is the server's whole.
 */
export function previewCommit(
	baseRev: number,
	ops: readonly Op[],
	cfg?: ClientConfig,
	local?: { strict: boolean; batchIds: readonly number[] }
): Promise<PreviewResponse> {
	const serverPreview = (sent: readonly Op[]) =>
		apiFetch<PreviewResponse>(
			'/commits/preview',
			{ method: 'POST', body: { base_rev: baseRev, ops: sent }, schema: PreviewResponseSchema },
			cfg
		);
	if (local === undefined || ops.some((op) => op.kind === 'metamodel.rebind')) {
		return serverPreview(ops);
	}
	const rest = ops.filter((op) => !MODEL_OP_KINDS.has(op.kind));
	return route(
		'issues',
		cfg,
		async (call) => {
			const model = PreviewResponseSchema.parse(
				await call<unknown>('previewCommit', {
					base_rev: baseRev,
					batch_ids: [...local.batchIds],
					strict: local.strict
				})
			);
			return rest.length === 0 ? model : mergePreviews(model, await serverPreview(rest));
		},
		() => serverPreview(ops),
		{ shadow: comparableWhileStaged(ops) }
	);
}

/** The engine's model half, then the server's half of the other ops. */
function mergePreviews(model: PreviewResponse, rest: PreviewResponse): PreviewResponse {
	return {
		conformance_error_count: model.conformance_error_count + rest.conformance_error_count,
		structural_blockers: [...model.structural_blockers, ...rest.structural_blockers],
		issues: [...model.issues, ...rest.issues],
		would_block: model.would_block || rest.would_block
	};
}

/** POST /commits — lock-verified, structural-gated commit. Throws
 * ConflictError (409: stale rev or missing lock) / ValidationError (422:
 * structural blocker). */
export function commitChanges(
	req: {
		baseRev: number;
		ops: readonly Op[];
		message: string;
		lockTokens: string[];
		ackErrors: boolean;
	},
	cfg?: ClientConfig,
	onText?: (text: string) => void
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
			schema: CommitResponseSchema,
			onText
		},
		cfg
	);
}
