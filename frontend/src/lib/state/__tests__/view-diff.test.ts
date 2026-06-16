import { describe, it, expect } from 'vitest';
import { diffViews } from '../view-diff';
import type { View } from '$lib/api/types';

const v = (folders: View['folders']): View => ({ name: 'V', folders });
const f = (name: string, elements: string[] = [], folders: View['folders'] = []) => ({
	name,
	elements,
	folders
});

describe('diffViews', () => {
	it('returns no changes for identical trees', () => {
		const a = v([f('A', ['e1'])]);
		expect(diffViews(a, structuredClone(a))).toEqual([]);
	});

	it('detects an element added to a folder', () => {
		const before = v([f('A')]);
		const after = v([f('A', ['e1'])]);
		expect(diffViews(before, after)).toEqual([{ kind: 'element-added', id: 'e1', to: ['A'] }]);
	});

	it('detects an element removed from the view', () => {
		const before = v([f('A', ['e1'])]);
		const after = v([f('A')]);
		expect(diffViews(before, after)).toEqual([{ kind: 'element-removed', id: 'e1', from: ['A'] }]);
	});

	it('detects an element moved between folders (nested paths)', () => {
		const before = v([f('A', ['e1']), f('B', [], [f('C')])]);
		const after = v([f('A'), f('B', [], [f('C', ['e1'])])]);
		expect(diffViews(before, after)).toEqual([
			{ kind: 'element-moved', id: 'e1', from: ['A'], to: ['B', 'C'] }
		]);
	});

	it('detects folder added and removed', () => {
		const before = v([f('A')]);
		const after = v([f('B')]);
		expect(diffViews(before, after)).toEqual([
			{ kind: 'folder-removed', path: ['A'] },
			{ kind: 'folder-added', path: ['B'] }
		]);
	});

	it('collapses a populated-folder rename to one removed + one added (shallowest)', () => {
		const before = v([f('A', [], [f('B')])]);
		const after = v([f('A2', [], [f('B')])]);
		expect(diffViews(before, after)).toEqual([
			{ kind: 'folder-removed', path: ['A'] },
			{ kind: 'folder-added', path: ['A2'] }
		]);
	});

	it('treats null baseline/current as empty trees', () => {
		expect(diffViews(null, null)).toEqual([]);
		expect(diffViews(null, v([f('A', ['e1'])]))).toEqual([
			{ kind: 'folder-added', path: ['A'] },
			{ kind: 'element-added', id: 'e1', to: ['A'] }
		]);
	});
});
