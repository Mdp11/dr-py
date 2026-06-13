import { describe, expect, it } from 'vitest';

import { elementDisplayName, nameProp } from '../element-name';

describe('nameProp', () => {
	it('returns the exact lowercase `name` property', () => {
		expect(nameProp({ name: 'Engine' })).toBe('Engine');
	});

	it('detects `name` case-insensitively (Name, NAME, nAmE)', () => {
		expect(nameProp({ Name: 'Engine' })).toBe('Engine');
		expect(nameProp({ NAME: 'Engine' })).toBe('Engine');
		expect(nameProp({ nAmE: 'Engine' })).toBe('Engine');
	});

	it('prefers the exact `name` over other casings', () => {
		expect(nameProp({ Name: 'Upper', name: 'lower' })).toBe('lower');
	});

	it('ignores empty-string and non-string name values', () => {
		expect(nameProp({ name: '' })).toBeUndefined();
		expect(nameProp({ name: 42 })).toBeUndefined();
		expect(nameProp({ Name: null })).toBeUndefined();
	});

	it('falls back to a differently-cased name when exact is empty', () => {
		expect(nameProp({ name: '', Name: 'Engine' })).toBe('Engine');
	});

	it('returns undefined when no name-like property exists', () => {
		expect(nameProp({ title: 'Engine' })).toBeUndefined();
		expect(nameProp({})).toBeUndefined();
		expect(nameProp(undefined)).toBeUndefined();
		expect(nameProp(null)).toBeUndefined();
	});
});

describe('elementDisplayName', () => {
	it('uses the case-insensitive name property', () => {
		expect(elementDisplayName({ id: 'e1', properties: { Name: 'Engine' } })).toBe('Engine');
	});

	it('falls back to the id when no name property exists', () => {
		expect(elementDisplayName({ id: 'e1', properties: { title: 'x' } })).toBe('e1');
	});
});
