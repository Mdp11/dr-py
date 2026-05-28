import { describe, expect, it } from 'vitest';
import { TEMP_ID_PREFIX, createTempId, isTempId } from '../ops';

describe('createTempId', () => {
	it('returns a string that starts with the temp prefix', () => {
		const id = createTempId();
		expect(typeof id).toBe('string');
		expect(id.startsWith(TEMP_ID_PREFIX)).toBe(true);
	});

	it('returns a non-trivial id beyond the prefix', () => {
		const id = createTempId();
		expect(id.length).toBeGreaterThan(TEMP_ID_PREFIX.length + 4);
	});

	it('produces different ids on successive calls', () => {
		const a = createTempId();
		const b = createTempId();
		expect(a).not.toBe(b);
	});
});

describe('isTempId', () => {
	it('returns true for ids with the temp prefix', () => {
		expect(isTempId('tmp_abc')).toBe(true);
		expect(isTempId(createTempId())).toBe(true);
	});

	it('returns false for ids without the temp prefix', () => {
		expect(isTempId('e-1')).toBe(false);
		expect(isTempId('elem-123')).toBe(false);
		expect(isTempId('')).toBe(false);
	});
});
