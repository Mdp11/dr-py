import { apiFetch, type ApiFetchInit, type ClientConfig } from './client';
import { MetamodelNameListSchema, MetamodelSchema, type Metamodel } from './types';

export function listMetamodels(cfg?: ClientConfig): Promise<string[]> {
	return apiFetch('/metamodels', { method: 'GET', schema: MetamodelNameListSchema }, cfg);
}

/**
 * Returns the parsed metamodel matching the backend Pydantic Metamodel shape
 * (see `src/data_rover/core/metamodel/schema.py`).
 */
export function getMetamodel(name: string, cfg?: ClientConfig): Promise<Metamodel> {
	return apiFetch(
		`/metamodels/${encodeURIComponent(name)}`,
		{ method: 'GET', schema: MetamodelSchema },
		cfg
	);
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
