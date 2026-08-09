/**
 * Client for the four Phase-3 bundle routes. Export + preview are
 * viewer-allowed reads; plan + confirm are part of the write flow (the
 * backend keeps them out of the read-only allowlist), so the UI must gate
 * their affordances on `canEdit()`.
 */
import { z } from 'zod';
import { apiFetch, apiFetchRaw, type ClientConfig } from './client';
import { ConflictError } from './errors';

export const BUNDLE_FORMAT = 'datarover.artifact-bundle/v1' as const;
/** The filename the export route pins via Content-Disposition. */
export const BUNDLE_FILENAME = 'artifacts.bundle.json';

export const BundleArtifactSchema = z.object({
	id: z.string(),
	kind: z.string(),
	name: z.string(),
	payload: z.record(z.string(), z.unknown()).default({})
});

export const ArtifactBundleSchema = z.object({
	format: z.literal(BUNDLE_FORMAT),
	exported_at: z.string(),
	source_project: z.object({ id: z.string(), name: z.string() }),
	roots: z.array(z.string()).default([]),
	artifacts: z.array(BundleArtifactSchema).default([])
});
export type ArtifactBundle = z.infer<typeof ArtifactBundleSchema>;

export const ExportPreviewSchema = z.object({
	artifacts: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string() })).default([]),
	dangling_refs: z.array(z.string()).default([])
});
export type ExportPreview = z.infer<typeof ExportPreviewSchema>;

export const PlanEntrySchema = z.object({
	bundle_id: z.string(),
	kind: z.string(),
	name: z.string(),
	action: z.enum(['create', 'reuse', 'copy']),
	existing_id: z.string().nullable().default(null),
	copy_name: z.string().nullable().default(null)
});
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

export const SkippedEntrySchema = z.object({ bundle_id: z.string(), reason: z.string() });
export type SkippedEntry = z.infer<typeof SkippedEntrySchema>;

export const ImportPlanSchema = z.object({
	entries: z.array(PlanEntrySchema).default([]),
	skipped: z.array(SkippedEntrySchema).default([])
});
export type ImportPlan = z.infer<typeof ImportPlanSchema>;

export const ImportConfirmResponseSchema = z.object({
	rev: z.number().int().nullable(),
	created: z
		.array(z.object({ bundle_id: z.string(), id: z.string(), name: z.string() }))
		.default([]),
	reused: z.array(z.object({ bundle_id: z.string(), existing_id: z.string() })).default([]),
	skipped: z.array(SkippedEntrySchema).default([])
});
export type ImportConfirmResponse = z.infer<typeof ImportConfirmResponseSchema>;

/**
 * A 409 from POST /artifacts/import that carried a freshly-derived plan.
 * The caller MUST re-render from {@link plan} — the plan it submitted is
 * stale by definition and resubmitting it loops forever.
 */
export class StalePlanImportError extends Error {
	constructor(
		public readonly detail: string,
		public readonly plan: ImportPlan
	) {
		super(detail);
		this.name = 'StalePlanImportError';
	}
}

export function exportPreview(rootIds: string[], cfg?: ClientConfig): Promise<ExportPreview> {
	return apiFetch(
		'/artifacts/export/preview',
		{ method: 'POST', body: { root_ids: rootIds }, schema: ExportPreviewSchema },
		cfg
	);
}

/** Raw Response so the caller can stream it to a file (saveResponseToFile). */
export function exportBundle(rootIds: string[], cfg?: ClientConfig): Promise<Response> {
	return apiFetchRaw('/artifacts/export', { method: 'POST', body: { root_ids: rootIds } }, cfg);
}

export function importPlan(bundle: ArtifactBundle, cfg?: ClientConfig): Promise<ImportPlan> {
	return apiFetch(
		'/artifacts/import/plan',
		{ method: 'POST', body: bundle, schema: ImportPlanSchema },
		cfg
	);
}

export async function importConfirm(
	input: {
		bundle: ArtifactBundle;
		decisions: Record<string, 'create' | 'reuse' | 'copy'>;
		copyNames: Record<string, string>;
		message: string;
	},
	cfg?: ClientConfig
): Promise<ImportConfirmResponse> {
	try {
		return await apiFetch(
			'/artifacts/import',
			{
				method: 'POST',
				body: {
					bundle: input.bundle,
					decisions: input.decisions,
					copy_names: input.copyNames,
					message: input.message
				},
				schema: ImportConfirmResponseSchema
			},
			cfg
		);
	} catch (err) {
		// Two 409 shapes: {detail, plan} (stale plan — recover by re-rendering
		// the fresh plan) vs create_commit's {detail, model_rev} (no plan).
		if (err instanceof ConflictError && err.body !== null && typeof err.body === 'object') {
			const planRaw = (err.body as { plan?: unknown }).plan;
			if (planRaw !== undefined) {
				const parsed = ImportPlanSchema.safeParse(planRaw);
				if (parsed.success) throw new StalePlanImportError(err.message, parsed.data);
			}
		}
		throw err;
	}
}

/** Parse a picked bundle file's text. Throws on bad JSON or a wrong shape —
 * the dialog catches and shows an inline error instead of a server 422.
 *
 * NOTE: `.parse()` returns the zod-STRIPPED object — any key on the file
 * that isn't in `ArtifactBundleSchema` is silently dropped — and it is that
 * stripped object, not the raw file text, that later gets re-posted to
 * `/artifacts/import/plan` and `/artifacts/import`. So an older frontend
 * build talking to a newer backend that has grown an extra bundle field
 * quietly forwards a bundle with that field missing, rather than passing it
 * through untouched. Acceptable for now (the backend tolerates it), but it
 * is why this client can never be a transparent pass-through for a bundle
 * it didn't fully model.
 */
export function parseBundleText(text: string): ArtifactBundle {
	return ArtifactBundleSchema.parse(JSON.parse(text));
}
