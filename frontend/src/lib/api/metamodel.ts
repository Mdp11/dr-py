import { apiFetch, type ApiFetchInit, type ClientConfig } from './client';
import { route } from './engine-route';
import { ValidationError } from './errors';
import {
	MetamodelSchema,
	MetamodelDiffSchema,
	MetamodelStructuralDiffSchema,
	RawMetamodelSchema,
	MetamodelLintSchema,
	MetamodelLayoutSchema,
	type Metamodel,
	type MetamodelDiff,
	type MetamodelStructuralDiff,
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
 * Run the read-only sandbox conformance diff: which model issues a
 * CANDIDATE metamodel would start and stop failing, and how its document
 * differs, without mutating anything. With the `metamodel` surface on the
 * engine, the candidate is linted and its parsed document validated over the
 * replica's working copy, staged edits and rules included, beside the
 * server's structural half; a candidate the lint refuses is a 422, and one
 * the engine cannot run is the server's. Otherwise `POST /metamodel/diff`
 * (any member) validates the committed model. The blob is sent as raw YAML
 * (no JS-side parse), mirroring uploadMetamodel.
 */
export function diffMetamodel(body: string, cfg?: ClientConfig): Promise<MetamodelDiff> {
	const server = () => {
		const init: ApiFetchInit = {
			method: 'POST',
			body,
			schema: MetamodelDiffSchema,
			headers: { 'Content-Type': 'application/x-yaml' }
		};
		return apiFetch<MetamodelDiff>('/metamodel/diff', init, cfg);
	};
	return route(
		'metamodel',
		cfg,
		async (call) => {
			const lint = await lintMetamodel(body, cfg);
			if (!lint.ok) throw new ValidationError(422, lint, 'Invalid metamodel');
			if (lint.document == null) return server();
			const [model, structural] = await Promise.all([
				call<object>('candidateIssues', { metamodel: lint.document }),
				structuralDiff(body, cfg)
			]);
			return MetamodelDiffSchema.parse({ ...model, structural });
		},
		server,
		{ shadow: 'unstaged' }
	);
}

/** The document half of the diff alone: no model is read. Editors and owners. */
export function structuralDiff(body: string, cfg?: ClientConfig): Promise<MetamodelStructuralDiff> {
	const init: ApiFetchInit = {
		method: 'POST',
		body,
		schema: MetamodelStructuralDiffSchema,
		headers: { 'Content-Type': 'application/x-yaml' }
	};
	return apiFetch('/metamodel/structural-diff', init, cfg);
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
