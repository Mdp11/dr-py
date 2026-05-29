import { describe, expect, it } from 'vitest';
import type { ModelOut } from '$lib/api/types';
import { comparePair } from '../compare';

function model(tag: string): ModelOut {
	return {
		elements: [{ id: tag, type_name: 'Thing', properties: { tag }, rev: 0 }],
		relationships: []
	};
}

const loaded = model('loaded');
const other = model('other');

describe('comparePair', () => {
	it('default (swapped=false): from=loaded, to=other, fromFilename=loadedFilename', () => {
		const pair = comparePair(loaded, 'loaded.json', other, 'other.json', false);
		expect(pair.from).toBe(loaded);
		expect(pair.to).toBe(other);
		expect(pair.fromFilename).toBe('loaded.json');
	});

	it('swapped=true: from=other, to=loaded, fromFilename=otherFilename', () => {
		const pair = comparePair(loaded, 'loaded.json', other, 'other.json', true);
		expect(pair.from).toBe(other);
		expect(pair.to).toBe(loaded);
		expect(pair.fromFilename).toBe('other.json');
	});

	it('works with null filenames (default direction)', () => {
		const pair = comparePair(loaded, null, other, null, false);
		expect(pair.from).toBe(loaded);
		expect(pair.to).toBe(other);
		expect(pair.fromFilename).toBeNull();
	});

	it('works with null filenames (swapped)', () => {
		const pair = comparePair(loaded, null, other, null, true);
		expect(pair.from).toBe(other);
		expect(pair.to).toBe(loaded);
		expect(pair.fromFilename).toBeNull();
	});

	it('returns different pairs for swapped vs not swapped', () => {
		const normal = comparePair(loaded, 'l.json', other, 'o.json', false);
		const swapped = comparePair(loaded, 'l.json', other, 'o.json', true);
		expect(normal.from).not.toBe(swapped.from);
		expect(normal.fromFilename).not.toBe(swapped.fromFilename);
	});
});
