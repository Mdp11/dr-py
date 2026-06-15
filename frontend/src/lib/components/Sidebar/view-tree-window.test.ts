import { describe, expect, it } from 'vitest';
import type { Element, View } from '$lib/api/types';
import {
	appendExcludedSection,
	buildUnifiedTree,
	computeVisibility,
	EXCLUDED_SECTION_KEY,
	flattenVisibleRows,
	folderKey,
	isExcludedSectionKey,
	resolveElementDrop
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

describe('appendExcludedSection', () => {
	it('adds a section root whose children are the excluded ids, registering unloaded ids as element nodes', () => {
		const view: View = { name: 'v', folders: [{ name: 'F', folders: [], elements: ['placed'] }] };
		const byId = new Map([['placed', el('placed')]]); // excluded ids NOT loaded yet
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		appendExcludedSection(tree, ['x1', 'x2']);

		expect(tree.roots.at(-1)).toBe(EXCLUDED_SECTION_KEY);
		expect(isExcludedSectionKey(EXCLUDED_SECTION_KEY)).toBe(true);
		expect(tree.kind.get(EXCLUDED_SECTION_KEY)).toBe('folder');
		expect(tree.children.get(EXCLUDED_SECTION_KEY)).toEqual(['x1', 'x2']);
		expect(tree.kind.get('x1')).toBe('element');
		expect(tree.children.get('x1')).toEqual([]);
	});

	it('does not include an id that is already placed in a folder (defensive complement)', () => {
		const view: View = { name: 'v', folders: [{ name: 'F', folders: [], elements: ['placed'] }] };
		const byId = new Map([['placed', el('placed')]]);
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		appendExcludedSection(tree, ['placed', 'x1']);
		expect(tree.children.get(EXCLUDED_SECTION_KEY)).toEqual(['x1']);
	});

	it('renders folder-like (never hidden) with skeleton children visible under the type filter', () => {
		const view: View = { name: 'v', folders: [] };
		const byId = new Map<string, Element>(); // nothing loaded
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		appendExcludedSection(tree, ['x1']);
		const vis = computeVisibility(tree, byId, new Set(['Block']));
		expect(vis.get(EXCLUDED_SECTION_KEY)).toBe('full'); // child tentatively visible
		expect(vis.get('x1')).toBe('full'); // unloaded body -> tentatively visible
		const rows = flattenVisibleRows(tree, vis, new Set());
		expect(rows.map((r) => r.key)).toEqual([EXCLUDED_SECTION_KEY, 'x1']);
	});
});

describe('resolveElementDrop', () => {
	it('folder header drop -> append into that folder (index at end)', () => {
		const r = resolveElementDrop({ targetKind: 'folder', folderPath: ['F'], folderLen: 3 });
		expect(r).toEqual({ path: ['F'], index: 3 });
	});
	it('excluded-section drop -> exclude (empty path)', () => {
		const r = resolveElementDrop({ targetKind: 'section' });
		expect(r).toEqual({ path: [], index: 0 });
	});
	it('element-row drop, top half -> insert before the sibling', () => {
		const r = resolveElementDrop({ targetKind: 'element', folderPath: ['F'], siblingIndex: 2, half: 'top' });
		expect(r).toEqual({ path: ['F'], index: 2 });
	});
	it('element-row drop, bottom half -> insert after the sibling', () => {
		const r = resolveElementDrop({ targetKind: 'element', folderPath: ['F'], siblingIndex: 2, half: 'bottom' });
		expect(r).toEqual({ path: ['F'], index: 3 });
	});
	it('element-row drop in the excluded pool -> exclude (no reorder in the pool)', () => {
		const r = resolveElementDrop({ targetKind: 'element', folderPath: null, siblingIndex: 0, half: 'top' });
		expect(r).toEqual({ path: [], index: 0 });
	});
});
