import { describe, expect, it } from 'vitest';

import { floatInputText, parseFloatInput } from '../float-input';

describe('parseFloatInput', () => {
	it('reads finite numbers', () => {
		expect(parseFloatInput('1.5')).toBe(1.5);
		expect(parseFloatInput(' -2 ')).toBe(-2);
		expect(parseFloatInput('1e3')).toBe(1000);
		expect(parseFloatInput('0')).toBe(0);
	});

	it('reads every infinity spelling as the canonical token', () => {
		for (const raw of ['Infinity', 'infinity', 'INF', 'inf', '+inf', '∞', '+∞']) {
			expect(parseFloatInput(raw)).toBe('Infinity');
		}
		for (const raw of ['-Infinity', '-infinity', '-inf', '-∞']) {
			expect(parseFloatInput(raw)).toBe('-Infinity');
		}
	});

	it('maps blank to null (clear) and anything else to undefined (invalid)', () => {
		expect(parseFloatInput('')).toBeNull();
		expect(parseFloatInput('   ')).toBeNull();
		expect(parseFloatInput('abc')).toBeUndefined();
		expect(parseFloatInput('1.5x')).toBeUndefined();
		expect(parseFloatInput('NaN')).toBeUndefined();
		expect(parseFloatInput('-')).toBeUndefined();
	});
});

describe('floatInputText', () => {
	it('renders numbers and tokens, and blanks everything else', () => {
		expect(floatInputText(2.5)).toBe('2.5');
		expect(floatInputText('Infinity')).toBe('Infinity');
		expect(floatInputText('-Infinity')).toBe('-Infinity');
		expect(floatInputText(null)).toBe('');
		expect(floatInputText(undefined)).toBe('');
		expect(floatInputText('abc')).toBe('');
	});
});
