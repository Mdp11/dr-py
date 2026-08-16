import { apiFetch, type ApiFetchInit, type ClientConfig } from './client';
import {
	MetamodelSchema,
	MetamodelDiffSchema,
	RebindSchema,
	RawMetamodelSchema,
	MetamodelLintSchema,
	MetamodelLayoutSchema,
	type Metamodel,
	type MetamodelDiff,
	type Rebind,
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
 *
 * DEAD ROUTE (spec 2026-08-16): `POST /metamodel/rebind` no longer exists —
 * a rebind is a `metamodel.rebind` op on `POST /commits`. Its ONE remaining
 * caller is `commitMetamodelRebind`, behind MetamodelTab's Rebind button,
 * which Task 12 deletes; this function goes with it. Nothing new may call it.
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

/** PUT replaces the whole positions map; the backend answers 204 with no
 * body, so `apiFetch` returns `undefined` here without attempting a parse.
 *
 * DEAD ROUTE (spec 2026-08-16): `PUT /metamodel/layout` no longer exists — a
 * node position is a `metamodel.move_node` op on `POST /commits`, staged
 * through `metamodel-stage.svelte.ts`. Its ONE remaining caller is
 * `metamodel-diagram.svelte.ts`'s debounced save, which Task 11 deletes; this
 * function goes with it. `getMetamodelLayout` above stays — the baseline read
 * is untouched. Nothing new may call this. */
export function putMetamodelLayout(body: MetamodelLayout, cfg?: ClientConfig): Promise<void> {
	return apiFetch('/metamodel/layout', { method: 'PUT', body }, cfg);
}
