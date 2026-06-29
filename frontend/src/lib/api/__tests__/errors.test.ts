import { describe, expect, it } from 'vitest';
import { ApiError } from '../errors';
import { isForbidden, isUnauthorized } from '../errors';

describe('isForbidden', () => {
	it('is true only for an ApiError with status 403', () => {
		expect(isForbidden(new ApiError(403, null, 'Not a member'))).toBe(true);
	});
	it('is false for other statuses and non-ApiError values', () => {
		expect(isForbidden(new ApiError(404, null, 'gone'))).toBe(false);
		expect(isForbidden(new ApiError(401, null, 'nope'))).toBe(false);
		expect(isForbidden(new Error('plain'))).toBe(false);
		expect(isForbidden(null)).toBe(false);
	});
	it('does not overlap with isUnauthorized', () => {
		const forbidden = new ApiError(403, null, 'x');
		expect(isForbidden(forbidden)).toBe(true);
		expect(isUnauthorized(forbidden)).toBe(false);
	});
});
