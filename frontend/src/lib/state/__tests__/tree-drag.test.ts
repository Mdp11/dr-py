import { describe, expect, it } from 'vitest';
import {
	beginDrag,
	endDrag,
	getDragPayload,
	isDragActive,
	isMovableBypassed
} from '../tree-drag.svelte';

describe('tree-drag controller', () => {
	it('begins and ends an element drag', () => {
		expect(isDragActive()).toBe(false);
		beginDrag({ kind: 'element', ids: ['a', 'b'] });
		expect(isDragActive()).toBe(true);
		expect(getDragPayload()).toEqual({ kind: 'element', ids: ['a', 'b'] });
		endDrag();
		expect(isDragActive()).toBe(false);
		expect(getDragPayload()).toBeNull();
	});

	it('defaults the movable-bypass flag to false', () => {
		beginDrag({ kind: 'element', ids: ['a'] });
		expect(isMovableBypassed()).toBe(false);
		endDrag();
	});

	it('carries and clears the movable-bypass flag for search-originated drags', () => {
		beginDrag({ kind: 'element', ids: ['s1'] }, true);
		expect(isMovableBypassed()).toBe(true);
		endDrag();
		expect(isMovableBypassed()).toBe(false);
	});
});
