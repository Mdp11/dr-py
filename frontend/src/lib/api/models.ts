import { apiFetch, type ClientConfig } from './client';
import {
	ModelOutSchema,
	ModelRefListSchema,
	SnapshotOutSchema,
	type CreateModelRequest,
	type ModelOut,
	type ModelRef,
	type SnapshotIn,
	type SnapshotOut
} from './types';

export function listModels(cfg?: ClientConfig): Promise<ModelRef[]> {
	return apiFetch('/models', { method: 'GET', schema: ModelRefListSchema }, cfg);
}

export function createModel(
	payload: CreateModelRequest,
	cfg?: ClientConfig
): Promise<ModelOut> {
	return apiFetch(
		'/models',
		{ method: 'POST', body: payload as unknown as BodyInit, schema: ModelOutSchema },
		cfg
	);
}

export function getModel(name: string, cfg?: ClientConfig): Promise<ModelOut> {
	return apiFetch(
		`/models/${encodeURIComponent(name)}`,
		{ method: 'GET', schema: ModelOutSchema },
		cfg
	);
}

export function deleteModel(name: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch(`/models/${encodeURIComponent(name)}`, { method: 'DELETE' }, cfg);
}

/**
 * PUT a complete model snapshot under optimistic concurrency.
 * Throws `ConflictError` on 409 with the server's `{error: ...}` envelope.
 */
export function snapshotModel(
	name: string,
	payload: SnapshotIn,
	cfg?: ClientConfig
): Promise<SnapshotOut> {
	return apiFetch(
		`/models/${encodeURIComponent(name)}/snapshot`,
		{ method: 'PUT', body: payload as unknown as BodyInit, schema: SnapshotOutSchema },
		cfg
	);
}
