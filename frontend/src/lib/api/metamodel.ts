import { apiFetch, type ApiFetchInit, type ClientConfig } from './client';
import {
	MetamodelSchema,
	MetamodelDiffSchema,
	RawMetamodelSchema,
	MetamodelLintSchema,
	MetamodelLayoutSchema,
	type Metamodel,
	type MetamodelDiff,
	type RawMetamodel,
	type MetamodelLint,
	type MetamodelLayout
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
 * Run the read-only sandbox conformance diff. Validates the live
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

// A rebind is a `metamodel.rebind` op staged into the next `POST /commits`
// batch (`state/metamodel-stage.svelte.ts` → `commitStaged`), not a direct
// `POST /metamodel/rebind` call.

export function getMetamodelRaw(cfg?: ClientConfig): Promise<RawMetamodel> {
	return apiFetch('/metamodel/raw', { method: 'GET', schema: RawMetamodelSchema }, cfg);
}

export function lintMetamodel(body: string, cfg?: ClientConfig): Promise<MetamodelLint> {
	const init: ApiFetchInit = {
		method: 'POST',
		body,
		schema: MetamodelLintSchema,
		headers: { 'Content-Type': 'application/x-yaml' }
	};
	return apiFetch('/metamodel/lint', init, cfg);
}

/** Shared canvas positions (presentation-only; last-write-wins, no lease). */
export function getMetamodelLayout(cfg?: ClientConfig): Promise<MetamodelLayout> {
	return apiFetch('/metamodel/layout', { method: 'GET', schema: MetamodelLayoutSchema }, cfg);
}
