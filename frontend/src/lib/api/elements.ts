import { apiFetch, type ClientConfig } from './client';
import {
	ElementListSchema,
	ElementSchema,
	type CreateElementRequest,
	type Element,
	type UpdateElementRequest
} from './types';

export function listElements(
	filters?: { type?: string },
	cfg?: ClientConfig
): Promise<Element[]> {
	return apiFetch(
		'/model/elements',
		{ method: 'GET', schema: ElementListSchema, query: { type: filters?.type } },
		cfg
	);
}

export function createElement(
	payload: CreateElementRequest,
	cfg?: ClientConfig
): Promise<Element> {
	return apiFetch(
		'/model/elements',
		{ method: 'POST', body: payload, schema: ElementSchema },
		cfg
	);
}

export function getElement(elementId: string, cfg?: ClientConfig): Promise<Element> {
	return apiFetch(
		`/model/elements/${encodeURIComponent(elementId)}`,
		{ method: 'GET', schema: ElementSchema },
		cfg
	);
}

export function patchElement(
	elementId: string,
	payload: UpdateElementRequest,
	cfg?: ClientConfig
): Promise<Element> {
	return apiFetch(
		`/model/elements/${encodeURIComponent(elementId)}`,
		{ method: 'PATCH', body: payload, schema: ElementSchema },
		cfg
	);
}

export function deleteElement(elementId: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch(
		`/model/elements/${encodeURIComponent(elementId)}`,
		{ method: 'DELETE' },
		cfg
	);
}
