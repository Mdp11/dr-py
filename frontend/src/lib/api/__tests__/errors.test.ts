import { describe, expect, it } from 'vitest';
import { ApiError } from '../errors';
import { isForbidden, isUnauthorized, messageFromBody } from '../errors';

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

describe('messageFromBody', () => {
	it('returns a string detail as-is', () => {
		expect(messageFromBody({ detail: 'sort column 2 out of range' }, 422)).toBe(
			'sort column 2 out of range'
		);
	});

	it('summarizes a FastAPI list detail (loc + msg, body prefix stripped)', () => {
		const body = {
			detail: [
				{
					loc: ['body', 'definition', 'columns', 1, 'navigation'],
					msg: 'Value error, provide at most one of `ref` / `definition`',
					type: 'value_error'
				}
			]
		};
		expect(messageFromBody(body, 422)).toBe(
			'definition.columns.1.navigation: Value error, provide at most one of `ref` / `definition`'
		);
	});

	it('caps a long list detail at three items', () => {
		const item = (i: number) => ({ loc: ['body', `f${i}`], msg: `bad ${i}` });
		const body = { detail: [item(0), item(1), item(2), item(3)] };
		expect(messageFromBody(body, 422)).toBe('f0: bad 0; f1: bad 1; f2: bad 2');
	});

	it('falls back to HTTP <status> for unusable bodies', () => {
		expect(messageFromBody(null, 422)).toBe('HTTP 422');
		expect(messageFromBody({ detail: [] }, 422)).toBe('HTTP 422');
		expect(messageFromBody({ detail: [{ nope: 1 }] }, 422)).toBe('HTTP 422');
	});
});
