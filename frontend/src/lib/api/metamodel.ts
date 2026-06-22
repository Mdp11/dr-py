import { apiFetch, type ApiFetchInit, type ClientConfig } from './client';
import {
	MetamodelSchema,
	MetamodelDiffSchema,
	RebindSchema,
	type Metamodel,
	type MetamodelDiff,
	type Rebind
} from './types';

/**
 * Returns the active metamodel held by the backend session.
 */
export function getMetamodel(cfg?: ClientConfig): Promise<Metamodel> {
	return apiFetch('/metamodel', { method: 'GET', schema: MetamodelSchema }, cfg);
}

/**
 * Upload a metamodel definition. Replaces the active metamodel and clears
 * any active model on the backend.
 *
 * Body forms:
 *  - string => sent as-is, content-type application/x-yaml
 *  - object => JSON-encoded, content-type application/json
 */
export function uploadMetamodel(body: unknown, cfg?: ClientConfig): Promise<Metamodel> {
	const init: ApiFetchInit = { method: 'POST', body, schema: MetamodelSchema };
	if (typeof body === 'string') {
		init.headers = { 'Content-Type': 'application/x-yaml' };
	}
	return apiFetch('/metamodel', init, cfg);
}

export function clearMetamodel(cfg?: ClientConfig): Promise<void> {
	return apiFetch('/metamodel', { method: 'DELETE' }, cfg);
}

/**
 * Run the read-only sandbox conformance diff (Phase 6B). Validates the live
 * model against a CANDIDATE metamodel without mutating anything. Any member.
 * The blob is sent as raw YAML (no JS-side parse), mirroring uploadMetamodel.
 */
export function diffMetamodel(body: string, cfg?: ClientConfig): Promise<MetamodelDiff> {
	const init: ApiFetchInit = {
		method: 'POST',
		body,
		schema: MetamodelDiffSchema,
		headers: { 'Content-Type': 'application/x-yaml' }
	};
	return apiFetch('/metamodel/diff', init, cfg);
}

/**
 * Adopt a candidate metamodel via a non-destructive journaled rebind (owner
 * only). `baseRev`/`message` ride query params; the raw body is the blob.
 */
export function rebindMetamodel(
	body: string,
	opts: { baseRev: number; message: string },
	cfg?: ClientConfig
): Promise<Rebind> {
	const init: ApiFetchInit = {
		method: 'POST',
		body,
		schema: RebindSchema,
		headers: { 'Content-Type': 'application/x-yaml' },
		query: { base_rev: opts.baseRev, message: opts.message }
	};
	return apiFetch('/metamodel/rebind', init, cfg);
}
