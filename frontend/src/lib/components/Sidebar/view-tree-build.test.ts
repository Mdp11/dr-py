import { describe, expect, it } from 'vitest';
import type { Element, View } from '$lib/api/types';
import { artifactKey, buildUnifiedTree, folderKey, isFolderKey } from './view-tree';

function el(id: string, name = id): Element {
	return { id, type_name: 'Block', properties: { name }, rev: 1 };
}
function elements(...ids: string[]): Map<string, Element> {
	return new Map(ids.map((id) => [id, el(id)]));
}
const displayName = (e: Element) => String(e.properties.name ?? e.id);

describe('buildUnifiedTree — curated scope', () => {
	it('with a view, top-level roots are folders only (no unplaced roots)', () => {
		const view: View = {
			name: 'v',
			folders: [{ id: 'fa', name: 'F', folders: [], elements: ['a'], artifacts: [] }],
			artifacts: []
		};
		const tree = buildUnifiedTree(
			view,
			['a', 'b', 'c'], // b,c are unplaced model roots
			elements('a', 'b', 'c'),
			new Map(),
			new Set(),
			displayName
		);
		expect(tree.roots.every(isFolderKey)).toBe(true);
		expect(tree.roots).toEqual([folderKey('fa')]);
		// placed element still appears under its folder
		expect(tree.children.get(folderKey('fa'))).toEqual(['a']);
		expect([...tree.placedElementIds]).toEqual(['a']);
	});

	it('keys a folder node by its id, NOT its name — the key must not change when the name does (Phase 2 point)', () => {
		// Same folder id, two different names: the resulting node key is
		// identical either way, and the display name (looked up separately via
		// `folderName`) is the only thing that differs. This is the whole point
		// of id-addressing — collapse/expand state, drag hover, and focus are
		// keyed off something that survives a rename.
		const before: View = {
			name: 'v',
			folders: [{ id: 'fa', name: 'Old Name', folders: [], elements: [], artifacts: [] }],
			artifacts: []
		};
		const after: View = {
			name: 'v',
			folders: [{ id: 'fa', name: 'New Name', folders: [], elements: [], artifacts: [] }],
			artifacts: []
		};
		const treeBefore = buildUnifiedTree(before, [], new Map(), new Map(), new Set(), displayName);
		const treeAfter = buildUnifiedTree(after, [], new Map(), new Map(), new Set(), displayName);
		expect(treeBefore.roots).toEqual([folderKey('fa')]);
		expect(treeAfter.roots).toEqual([folderKey('fa')]);
		expect(treeBefore.roots).toEqual(treeAfter.roots);
		expect(treeBefore.folderName.get(folderKey('fa'))).toBe('Old Name');
		expect(treeAfter.folderName.get(folderKey('fa'))).toBe('New Name');
	});

	it('records folderPathNames as ancestor + own display names, for picker labels only', () => {
		const view: View = {
			name: 'v',
			folders: [
				{
					id: 'parent-id',
					name: 'Parent',
					folders: [{ id: 'child-id', name: 'Child', folders: [], elements: [], artifacts: [] }],
					elements: [],
					artifacts: []
				}
			],
			artifacts: []
		};
		const tree = buildUnifiedTree(view, [], new Map(), new Map(), new Set(), displayName);
		expect(tree.folderPathNames.get(folderKey('parent-id'))).toEqual(['Parent']);
		expect(tree.folderPathNames.get(folderKey('child-id'))).toEqual(['Parent', 'Child']);
	});

	it('includes placed elements in placement order even when their bodies are NOT cached', () => {
		// Regression: folder contents must NOT be gated on the element body already
		// being in the local cache. Gating on `elementsById.has` made placed rows
		// materialize one-by-one as the global roots page streamed them in (in
		// display-name order), inserting them mid-folder. Rows must be present and
		// in placement order from the first build so bodies fill in place.
		const view: View = {
			name: 'v',
			folders: [{ id: 'fa', name: 'F', folders: [], elements: ['c', 'a', 'b'], artifacts: [] }],
			artifacts: []
		};
		const tree = buildUnifiedTree(
			view,
			[],
			new Map(), // nothing cached yet
			new Map(),
			new Set(),
			displayName
		);
		expect(tree.children.get(folderKey('fa'))).toEqual(['c', 'a', 'b']);
		expect([...tree.placedElementIds]).toEqual(['c', 'a', 'b']);
	});

	it('drops a placed id the server has confirmed missing (not merely unfetched)', () => {
		const view: View = {
			name: 'v',
			folders: [{ id: 'fa', name: 'F', folders: [], elements: ['a', 'gone', 'b'], artifacts: [] }],
			artifacts: []
		};
		const tree = buildUnifiedTree(
			view,
			[],
			new Map(),
			new Map(),
			new Set(),
			displayName,
			new Set(['gone']) // confirmed missing
		);
		expect(tree.children.get(folderKey('fa'))).toEqual(['a', 'b']);
	});

	it('without a view, roots render in the given (server) order — no client re-sort', () => {
		// The backend emits roots already display-name sorted; the client must NOT
		// re-sort, so an accumulated prefix only ever grows by appending (no jump
		// during scroll auto-load). Input order is therefore preserved verbatim.
		const tree = buildUnifiedTree(
			null,
			['b', 'a'],
			elements('a', 'b'),
			new Map(),
			new Set(),
			displayName
		);
		expect(tree.roots).toEqual(['b', 'a']);
	});

	it('a folder carrying an artifact produces an artifact child node', () => {
		const ref = { id: 'a1', kind: 'navigation' };
		const view: View = {
			name: 'v',
			folders: [{ id: 'fa', name: 'F', folders: [], elements: [], artifacts: [ref] }],
			artifacts: []
		};
		const tree = buildUnifiedTree(view, [], new Map(), new Map(), new Set(), displayName);
		const key = artifactKey('a1');
		expect(tree.children.get(folderKey('fa'))).toEqual([key]);
		expect(tree.kind.get(key)).toBe('artifact');
		expect(tree.artifactRef.get(key)).toEqual(ref);
	});

	it('a root artifact produces a root-level artifact node after the folder keys', () => {
		const ref = { id: 'tbl1', kind: 'table' };
		const view: View = {
			name: 'v',
			folders: [{ id: 'fa', name: 'F', folders: [], elements: [], artifacts: [] }],
			artifacts: [ref]
		};
		const tree = buildUnifiedTree(view, [], new Map(), new Map(), new Set(), displayName);
		const key = artifactKey('tbl1');
		expect(tree.roots).toEqual([folderKey('fa'), key]);
		expect(tree.kind.get(key)).toBe('artifact');
		expect(tree.artifactRef.get(key)).toEqual(ref);
	});
});
