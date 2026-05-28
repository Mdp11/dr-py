import { apiFetch, type ApiFetchInit, type ClientConfig } from './client';
import { MetamodelNameListSchema } from './types';

export function listMetamodels(cfg?: ClientConfig): Promise<string[]> {
	return apiFetch('/metamodels', { method: 'GET', schema: MetamodelNameListSchema }, cfg);
}

/**
 * Returns the raw metamodel JSON (server-side structure may vary; typed as
 * `unknown` here — a dedicated helper module will mirror the shape later).
 */
export function getMetamodel(name: string, cfg?: ClientConfig): Promise<unknown> {
	return apiFetch(`/metamodels/${encodeURIComponent(name)}`, { method: 'GET' }, cfg);
}

/**
 * Upload or replace a metamodel definition.
 *
 * Backend accepts either:
 *  - YAML text (default content-type — pass a string)
 *  - JSON object (content-type application/json — pass any plain object)
 *
 * Callers control the wire format by what they pass:
 *  - string body => sent as-is (YAML) without overriding Content-Type
 *  - object body => JSON-encoded with application/json
 */
export function putMetamodel(
	name: string,
	body: unknown,
	cfg?: ClientConfig
): Promise<unknown> {
	const init: ApiFetchInit = { method: 'PUT', body };
	if (typeof body === 'string') {
		init.headers = { 'Content-Type': 'application/x-yaml' };
	}
	return apiFetch(`/metamodels/${encodeURIComponent(name)}`, init, cfg);
}

export function deleteMetamodel(name: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch(`/metamodels/${encodeURIComponent(name)}`, { method: 'DELETE' }, cfg);
}
