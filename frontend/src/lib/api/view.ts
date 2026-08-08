import { apiFetch, type ClientConfig } from './client';
import { ViewStateResponseSchema, type ViewStateResponse } from './types';

export function getView(cfg?: ClientConfig): Promise<ViewStateResponse> {
	return apiFetch('/view', { method: 'GET', schema: ViewStateResponseSchema }, cfg);
}
