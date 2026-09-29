import { apiFetch, type ClientConfig } from './client';
import { comparableWhileStaged, route, type EngineCall } from './engine-route';
import { lintMetamodel } from './metamodel';
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
 * halves are summed. A rebind revalidates the whole model under the new
 * metamodel: with `local` and the `metamodel` surface on the engine, its
 * blob is linted, the engine previews the working copy under the parsed
 * document, and the server previews the ops that are neither model ops nor
 * the rebind; a blob the lint refuses is the server's whole request, which
 * answers its 422.
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
	if (local === undefined) return serverPreview(ops);
	const rebind = ops.find(
		(op): op is Extract<Op, { kind: 'metamodel.rebind' }> => op.kind === 'metamodel.rebind'
	);
	const rest = ops.filter((op) => !MODEL_OP_KINDS.has(op.kind) && op !== rebind);
	const localPreview = async (call: EngineCall, params: object) => {
		const model = PreviewResponseSchema.parse(
			await call<unknown>('previewCommit', {
				base_rev: baseRev,
				batch_ids: [...local.batchIds],
				strict: local.strict,
				...params
			})
		);
		return rest.length === 0 ? model : mergePreviews(model, await serverPreview(rest));
	};
	if (rebind !== undefined) {
		return route(
			'metamodel',
			cfg,
			async (call) => {
				const lint = await lintMetamodel(rebind.blob, cfg);
				if (!lint.ok || lint.document == null) return serverPreview(ops);
				return localPreview(call, { rebind: { metamodel: lint.document } });
			},
			() => serverPreview(ops),
			{ shadow: comparableWhileStaged(ops) }
		);
	}
	return route(
		'issues',
		cfg,
		(call) => localPreview(call, {}),
		() => serverPreview(ops),
		{
			shadow: comparableWhileStaged(ops)
		}
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
