export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: unknown,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

export class NotFoundError extends ApiError {
	constructor(status: number, body: unknown, message: string) {
		super(status, body, message);
		this.name = 'NotFoundError';
	}
}

export class ConflictError extends ApiError {
	constructor(status: number, body: unknown, message: string) {
		super(status, body, message);
		this.name = 'ConflictError';
	}
}

export class ValidationError extends ApiError {
	constructor(status: number, body: unknown, message: string) {
		super(status, body, message);
		this.name = 'ValidationError';
	}
}

export function errorForStatus(status: number, body: unknown, message: string): ApiError {
	if (status === 404) return new NotFoundError(status, body, message);
	if (status === 409) return new ConflictError(status, body, message);
	if (status === 422) return new ValidationError(status, body, message);
	return new ApiError(status, body, message);
}

export function isUnauthorized(err: unknown): boolean {
	return err instanceof ApiError && err.status === 401;
}

/** True for a 403 — the backend's `require_membership` returns 403 for an
 * authenticated NON-member of a project (404 is reserved for unknown projects,
 * but also for "no metamodel loaded" in an empty-but-mine project, so 403 is the
 * only status that reliably means "you are not a member"). Callers use this to
 * distinguish a denied-access bounce from a legitimately empty project. */
export function isForbidden(err: unknown): boolean {
	return err instanceof ApiError && err.status === 403;
}

export function messageFromBody(body: unknown, status: number): string {
	if (body && typeof body === 'object') {
		const b = body as Record<string, unknown>;
		if (typeof b.detail === 'string') return b.detail;
		// FastAPI request-parse failures carry `detail` as a LIST of
		// {loc, msg, ...} items — surface the first few instead of a bare
		// "HTTP 422" the user can do nothing with.
		if (Array.isArray(b.detail)) {
			const parts = b.detail
				.filter(
					(d): d is { msg: string; loc?: unknown[] } =>
						!!d && typeof d === 'object' && typeof (d as { msg?: unknown }).msg === 'string'
				)
				.slice(0, 3)
				.map((d) => {
					const loc = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : '';
					return loc ? `${loc}: ${d.msg}` : d.msg;
				});
			if (parts.length > 0) return parts.join('; ');
		}
		if (typeof b.error === 'string') return b.error;
		if (typeof b.message === 'string') return b.message;
	}
	return `HTTP ${status}`;
}
