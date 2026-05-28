import { apiFetch, type ClientConfig } from './client';
import {
	ViewSnapshotResponseSchema,
	ViewStateResponseSchema,
	type View,
	type ViewSnapshotResponse,
	type ViewStateResponse
} from './types';

/**
 * Upload a view snapshot. Requires an active model on the backend; otherwise
 * the request returns 404. Warnings (missing element ids, duplicate folders,
 * etc.) are returned alongside the stored view rather than rejecting it.
 */
export function putViewSnapshot(view: View, cfg?: ClientConfig): Promise<ViewSnapshotResponse> {
	return apiFetch(
		'/view/snapshot',
		{ method: 'PUT', body: view, schema: ViewSnapshotResponseSchema },
		cfg
	);
}

export function getView(cfg?: ClientConfig): Promise<ViewStateResponse> {
	return apiFetch('/view', { method: 'GET', schema: ViewStateResponseSchema }, cfg);
}

export function clearView(cfg?: ClientConfig): Promise<void> {
	return apiFetch('/view', { method: 'DELETE' }, cfg);
}
