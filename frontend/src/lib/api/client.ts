import type { z } from 'zod';
import { errorForStatus, messageFromBody } from './errors';
import { getCurrentUserId } from './identity';

// Re-exported so existing `import { getCurrentUserId } from '$lib/api/client'`
// call sites keep working; the value now comes from the authenticated user
// (set by the auth store after GET /auth/me — see api/identity.ts).
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

// Project-scoped base URL, set once per workspace from the [projectId] route
// param (see state/active-project.svelte.ts). Non-project-scoped calls
// (auth/admin/projects-list) pass an explicit { baseUrl: '/api/v1' }. Under the
// auth flow the active project is always selected (via the picker →
// /p/[projectId]) before any project-scoped call fires. The fallback is the
// non-project API root, NOT a hardcoded "default" project: if a project-scoped
// call ever fires before a project is active it 404s loudly instead of being
// silently routed at a phantom default project (no dev-identity coupling).
const FALLBACK_BASE_URL = '/api/v1';
let _activeBaseUrl: string | null = null;

/** Set the project-scoped base URL used by calls that pass no per-call baseUrl. */
export function setActiveBaseUrl(url: string | null): void {
	_activeBaseUrl = url;
}

// Global 401 hook. The api layer must NOT import lib/state (no upward
// dependency), so a mid-session-expiry bounce is injected as a callback: the
// app registers a handler once on load (see lib/state/session-recovery). It is
// invoked on EVERY 401 right before the ApiError is thrown — the handler itself
// decides whether to act (it no-ops when no user is logged in, so login/boot
// 401s keep their local handling). The ApiError is always still thrown so local
// catch blocks (LoginForm, fetchMe) work unchanged.
let _unauthorizedHandler: (() => void) | null = null;

/** Register (or clear, with null) the global 401 handler. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
	_unauthorizedHandler = fn;
}

const _SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
const CSRF_HEADER = 'X-Requested-With';
const CSRF_VALUE = 'data-rover';

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
	const baseUrl = config?.baseUrl ?? _activeBaseUrl ?? FALLBACK_BASE_URL;
	const doFetch = config?.fetch ?? fetch;
	const url = buildUrl(baseUrl, path, init.query);
	const { body, headers } = prepareBody(init);
	const method = (init.method ?? 'GET').toUpperCase();
	if (!_SAFE_METHODS.has(method) && !headers.has(CSRF_HEADER)) {
		headers.set(CSRF_HEADER, CSRF_VALUE);
	}

	const response = await doFetch(url, { ...init, body, headers, credentials: 'include' });

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
		// Fire the global 401 hook before throwing (the handler self-gates on a
		// logged-in user, so this is a no-op during login/boot). The error is still
		// thrown so local catch blocks keep working.
		if (response.status === 401) _unauthorizedHandler?.();
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
