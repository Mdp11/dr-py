import { apiFetch, type ApiFetchInit, type ClientConfig } from './client';
import { MetamodelSchema, type Metamodel } from './types';

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
