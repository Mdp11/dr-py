import { apiFetch, type ClientConfig } from './client';
import {
	ElementListSchema,
	ElementSchema,
	type CreateElementRequest,
	type Element,
	type UpdateElementRequest
} from './types';

export function listElements(
	modelName: string,
	filters?: { type?: string },
	cfg?: ClientConfig
): Promise<Element[]> {
	return apiFetch(
		`/models/${encodeURIComponent(modelName)}/elements`,
		{ method: 'GET', schema: ElementListSchema, query: { type: filters?.type } },
		cfg
	);
}

export function createElement(
	modelName: string,
	payload: CreateElementRequest,
	cfg?: ClientConfig
): Promise<Element> {
	return apiFetch(
		`/models/${encodeURIComponent(modelName)}/elements`,
		{ method: 'POST', body: payload as unknown as BodyInit, schema: ElementSchema },
		cfg
	);
}

export function getElement(
	modelName: string,
	elementId: string,
	cfg?: ClientConfig
): Promise<Element> {
	return apiFetch(
		`/models/${encodeURIComponent(modelName)}/elements/${encodeURIComponent(elementId)}`,
		{ method: 'GET', schema: ElementSchema },
		cfg
	);
}

export function patchElement(
	modelName: string,
	elementId: string,
	payload: UpdateElementRequest,
	cfg?: ClientConfig
): Promise<Element> {
	return apiFetch(
		`/models/${encodeURIComponent(modelName)}/elements/${encodeURIComponent(elementId)}`,
		{ method: 'PATCH', body: payload as unknown as BodyInit, schema: ElementSchema },
		cfg
	);
}

export function deleteElement(
	modelName: string,
	elementId: string,
	cfg?: ClientConfig
): Promise<void> {
	return apiFetch(
		`/models/${encodeURIComponent(modelName)}/elements/${encodeURIComponent(elementId)}`,
		{ method: 'DELETE' },
		cfg
	);
}
