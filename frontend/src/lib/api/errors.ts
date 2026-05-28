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

export function errorForStatus(
	status: number,
	body: unknown,
	message: string
): ApiError {
	if (status === 404) return new NotFoundError(status, body, message);
	if (status === 409) return new ConflictError(status, body, message);
	if (status === 422) return new ValidationError(status, body, message);
	return new ApiError(status, body, message);
}

export function messageFromBody(body: unknown, status: number): string {
	if (body && typeof body === 'object') {
		const b = body as Record<string, unknown>;
		if (typeof b.detail === 'string') return b.detail;
		if (typeof b.error === 'string') return b.error;
		if (typeof b.message === 'string') return b.message;
	}
	return `HTTP ${status}`;
}
