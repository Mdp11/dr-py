import type { z } from 'zod';
import { errorForStatus, messageFromBody } from './errors';
import { DEV_IDENTITY_HEADERS, getCurrentUserId } from './identity';

// Re-exported so existing `import { getCurrentUserId } from '$lib/api/client'`
// call sites keep working; the value now comes from the dev identity seam
// (overridable per browser session via `?user=` — see api/identity.ts).
export { getCurrentUserId };

export interface ClientConfig {
	baseUrl?: string;
	fetch?: typeof fetch;
}

export interface ApiFetchInit extends Omit<RequestInit, 'body'> {
	body?: unknown;
	schema?: z.ZodType<unknown>;
	query?: Record<string, string | number | boolean | undefined | null>;
}

// Single-user dev/default routing. A real project picker + auth (later phase)
// will make the project id dynamic and drop the dev identity headers (a
// gateway will inject the real identity in production).
const DEFAULT_BASE_URL = '/api/v1/projects/default';

function buildUrl(baseUrl: string, path: string, query?: ApiFetchInit['query']): string {
	const normalizedBase = baseUrl.replace(/\/$/, '');
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	let url = `${normalizedBase}${normalizedPath}`;
	if (query) {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) {
			if (v === undefined || v === null) continue;
			params.set(k, String(v));
		}
		const qs = params.toString();
		if (qs) url += `?${qs}`;
	}
	return url;
}

function prepareBody(init: ApiFetchInit): { body: BodyInit | null | undefined; headers: Headers } {
	const headers = new Headers(init.headers ?? {});
	let body = init.body;
	const isObjectBody =
		body !== undefined &&
		body !== null &&
		typeof body === 'object' &&
		!(body instanceof FormData) &&
		!(body instanceof URLSearchParams) &&
		!(body instanceof Blob) &&
		!(body instanceof ArrayBuffer) &&
		!(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);
	if (isObjectBody) {
		body = JSON.stringify(body);
		if (!headers.has('Content-Type')) {
			headers.set('Content-Type', 'application/json');
		}
	}
	return { body: body as BodyInit | null | undefined, headers };
}

/**
 * Like {@link apiFetch} but returns the raw `Response` instead of parsing the
 * body — for streaming endpoints (e.g. GET /model/download). Non-2xx
 * responses still raise the same typed `ApiError`s as `apiFetch`.
 */
export async function apiFetchRaw(
	path: string,
	init: ApiFetchInit = {},
	config?: ClientConfig
): Promise<Response> {
	const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
	const doFetch = config?.fetch ?? fetch;
	const url = buildUrl(baseUrl, path, init.query);
	const { body, headers } = prepareBody(init);
	for (const [k, v] of Object.entries(DEV_IDENTITY_HEADERS)) {
		if (!headers.has(k)) headers.set(k, v);
	}

	const response = await doFetch(url, { ...init, body, headers });

	if (!response.ok) {
		let parsed: unknown = undefined;
		const text = await response.text();
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}
		const message = messageFromBody(parsed, response.status);
		throw errorForStatus(response.status, parsed, message);
	}

	return response;
}

export async function apiFetch<T>(
	path: string,
	init: ApiFetchInit = {},
	config?: ClientConfig
): Promise<T> {
	const response = await apiFetchRaw(path, init, config);

	if (response.status === 204) {
		return undefined as T;
	}

	const text = await response.text();
	if (!text) {
		return undefined as T;
	}
	const json = JSON.parse(text);
	if (init.schema) {
		return init.schema.parse(json) as T;
	}
	return json as T;
}
