import { apiFetch, type ClientConfig } from './client';
import { ModelOutSchema, type ModelOut, type SnapshotIn } from './types';

/**
 * Upload a model body. Requires an active metamodel on the backend; otherwise
 * the request returns 404.
 */
export function uploadModel(payload: SnapshotIn, cfg?: ClientConfig): Promise<ModelOut> {
	return apiFetch(
		'/model',
		{ method: 'POST', body: payload, schema: ModelOutSchema },
		cfg
	);
}

export function getModel(cfg?: ClientConfig): Promise<ModelOut> {
	return apiFetch('/model', { method: 'GET', schema: ModelOutSchema }, cfg);
}

export function clearModel(cfg?: ClientConfig): Promise<void> {
	return apiFetch('/model', { method: 'DELETE' }, cfg);
}

/**
 * Replace the active model with a full snapshot.
 */
export function snapshotModel(payload: SnapshotIn, cfg?: ClientConfig): Promise<ModelOut> {
	return apiFetch(
		'/model/snapshot',
		{ method: 'PUT', body: payload, schema: ModelOutSchema },
		cfg
	);
}
