import { beforeEach, describe, expect, it } from 'vitest';

import { clearSelection, getSelection } from '../selection.svelte';
import {
	backEntries,
	canGoBack,
	canGoForward,
	forwardEntries,
	getVisitCursor,
	getVisitStack,
	goBack,
	goForward,
	goToVisit,
	noteResolved,
	pushVisit,
	remapVisitIds,
	resetInspectionHistory
} from '../inspection-history.svelte';

beforeEach(() => {
	resetInspectionHistory();
	clearSelection();
});

describe('visit stack', () => {
	it('starts empty: neither direction available', () => {
		expect(getVisitStack()).toEqual([]);
		expect(getVisitCursor()).toBe(-1);
		expect(canGoBack()).toBe(false);
		expect(canGoForward()).toBe(false);
	});

	it('pushVisit appends and advances the cursor', () => {
		pushVisit('a');
		pushVisit('b');
		expect(getVisitStack().map((e) => e.id)).toEqual(['a', 'b']);
		expect(getVisitCursor()).toBe(1);
		expect(canGoBack()).toBe(true);
		expect(canGoForward()).toBe(false);
	});

	it('dedupes a consecutive re-visit of the current entry', () => {
		pushVisit('a');
		pushVisit('a');
		expect(getVisitStack()).toHaveLength(1);
	});

	it('a new visit truncates the forward stack (browser semantics)', () => {
		pushVisit('a');
		pushVisit('b');
		pushVisit('c');
		goBack(); // cursor -> b
		goBack(); // cursor -> a
		pushVisit('d');
		expect(getVisitStack().map((e) => e.id)).toEqual(['a', 'd']);
		expect(getVisitCursor()).toBe(1);
		expect(canGoForward()).toBe(false);
	});

	it('caps the stack at 50, dropping the oldest', () => {
		for (let i = 0; i < 55; i++) pushVisit(`e${i}`);
		expect(getVisitStack()).toHaveLength(50);
		expect(getVisitStack()[0].id).toBe('e5');
		expect(getVisitCursor()).toBe(49);
	});
});

describe('navigation', () => {
	it('goBack/goForward move the cursor and select the entry', () => {
		pushVisit('a');
		pushVisit('b');
		goBack();
		expect(getVisitCursor()).toBe(0);
		expect(getSelection()).toEqual({ kind: 'element', id: 'a' });
		expect(canGoForward()).toBe(true);
		goForward();
		expect(getVisitCursor()).toBe(1);
		expect(getSelection()).toEqual({ kind: 'element', id: 'b' });
	});

	it('goToVisit jumps to an absolute index', () => {
		pushVisit('a');
		pushVisit('b');
		pushVisit('c');
		goToVisit(0);
		expect(getVisitCursor()).toBe(0);
		expect(getSelection()).toEqual({ kind: 'element', id: 'a' });
	});

	it('goBack/goForward/goToVisit are no-ops out of range', () => {
		pushVisit('a');
		goBack();
		goForward();
		goToVisit(5);
		goToVisit(-1);
		expect(getVisitCursor()).toBe(0);
		expect(getVisitStack()).toHaveLength(1);
	});
});

describe('dropdown slices', () => {
	it('backEntries/forwardEntries are nearest-first with absolute indices', () => {
		for (const id of ['a', 'b', 'c', 'd', 'e']) pushVisit(id);
		goBack();
		goBack(); // cursor at 'c' (index 2)
		expect(backEntries().map((x) => [x.index, x.entry.id])).toEqual([
			[1, 'b'],
			[0, 'a']
		]);
		expect(forwardEntries().map((x) => [x.index, x.entry.id])).toEqual([
			[3, 'd'],
			[4, 'e']
		]);
	});

	it('slices honor the 10-entry limit', () => {
		for (let i = 0; i < 15; i++) pushVisit(`e${i}`);
		expect(backEntries()).toHaveLength(10);
		expect(backEntries(3)).toHaveLength(3);
	});
});

describe('metadata', () => {
	it('noteResolved stamps last-known display data onto matching entries', () => {
		pushVisit('a');
		pushVisit('b');
		noteResolved('a', 'Pump A', 'Pump');
		expect(getVisitStack()[0]).toEqual({ id: 'a', name: 'Pump A', type_name: 'Pump' });
		expect(getVisitStack()[1]).toEqual({ id: 'b' });
	});

	it('remapVisitIds rewrites mapped ids and leaves the rest', () => {
		pushVisit('tmp1');
		pushVisit('x');
		remapVisitIds({ tmp1: 'real1' });
		expect(getVisitStack().map((e) => e.id)).toEqual(['real1', 'x']);
	});

	it('resetInspectionHistory clears everything', () => {
		pushVisit('a');
		resetInspectionHistory();
		expect(getVisitStack()).toEqual([]);
		expect(getVisitCursor()).toBe(-1);
	});
});
