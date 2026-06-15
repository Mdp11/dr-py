import { describe, expect, it } from 'vitest';
import type { Element, View } from '$lib/api/types';
import {
	buildUnifiedTree,
	computeVisibility,
	flattenVisibleRows,
	folderKey
} from './view-tree';

function el(id: string, type = 'Block', name = id): Element {
	return { id, type_name: type, properties: { name }, rev: 0 } as Element;
}
const displayName = (e: Element): string => String(e.properties.name ?? e.id);

describe('in-folder order follows folder.elements (no name-sort)', () => {
	it('keeps placement order even when names sort the other way', () => {
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['z', 'a'] }]
		};
		const byId = new Map([
			['z', el('z', 'Block', 'Zebra')],
			['a', el('a', 'Block', 'Apple')]
		]);
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		expect(tree.children.get(folderKey(['F']))).toEqual(['z', 'a']);
	});
});

describe('flattenVisibleRows', () => {
	it('emits a depth-carrying pre-order walk, skipping hidden and not descending stubs/collapsed', () => {
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['a'] }]
		};
		const byId = new Map([['a', el('a')]]);
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		const vis = computeVisibility(tree, byId, new Set(['Block']));
		const rows = flattenVisibleRows(tree, vis, new Set());
		expect(rows.map((r) => r.depth)).toEqual([0, 1]);
		expect(rows[0].key).toBe(folderKey(['F']));
		expect(rows[0].parent).toBeNull();
		expect(rows[1].key).toBe('a');
		expect(rows[1].parent).toBe(folderKey(['F']));
	});

	it('does not descend into a collapsed folder', () => {
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['a'] }]
		};
		const byId = new Map([['a', el('a')]]);
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		const vis = computeVisibility(tree, byId, new Set(['Block']));
		const rows = flattenVisibleRows(tree, vis, new Set([folderKey(['F'])]));
		expect(rows.map((r) => r.key)).toEqual([folderKey(['F'])]);
	});
});

describe('computeVisibility treats unloaded element bodies as tentatively visible', () => {
	it('keeps a folder with only an unknown placed id as a (visible) stub', () => {
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['ghost'] }]
		};
		const byId = new Map<string, Element>();
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		const vis = computeVisibility(tree, byId, new Set(['Block']));
		expect(vis.get(folderKey(['F']))).toBe('stub');
	});
});
