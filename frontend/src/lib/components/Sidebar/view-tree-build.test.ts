import { describe, expect, it } from 'vitest';
import type { Element, View } from '$lib/api/types';
import { buildUnifiedTree, folderKey, isFolderKey } from './view-tree';

function el(id: string, name = id): Element {
	return { id, type_name: 'Block', properties: { name }, rev: 1 };
}
function elements(...ids: string[]): Map<string, Element> {
	return new Map(ids.map((id) => [id, el(id)]));
}
const displayName = (e: Element) => String(e.properties.name ?? e.id);

describe('buildUnifiedTree — curated scope', () => {
	it('with a view, top-level roots are folders only (no unplaced roots)', () => {
		const view: View = { name: 'v', folders: [{ name: 'F', folders: [], elements: ['a'] }] };
		const tree = buildUnifiedTree(
			view,
			['a', 'b', 'c'], // b,c are unplaced model roots
			elements('a', 'b', 'c'),
			new Map(),
			new Set(),
			displayName
		);
		expect(tree.roots.every(isFolderKey)).toBe(true);
		expect(tree.roots).toEqual([folderKey(['F'])]);
		// placed element still appears under its folder
		expect(tree.children.get(folderKey(['F']))).toEqual(['a']);
		expect([...tree.placedElementIds]).toEqual(['a']);
	});

	it('includes placed elements in placement order even when their bodies are NOT cached', () => {
		// Regression: folder contents must NOT be gated on the element body already
		// being in the local cache. Gating on `elementsById.has` made placed rows
		// materialize one-by-one as the global roots page streamed them in (in
		// display-name order), inserting them mid-folder. Rows must be present and
		// in placement order from the first build so bodies fill in place.
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['c', 'a', 'b'] }]
		};
		const tree = buildUnifiedTree(
			view,
			[],
			new Map(), // nothing cached yet
			new Map(),
			new Set(),
			displayName
		);
		expect(tree.children.get(folderKey(['F']))).toEqual(['c', 'a', 'b']);
		expect([...tree.placedElementIds]).toEqual(['c', 'a', 'b']);
	});

	it('drops a placed id the server has confirmed missing (not merely unfetched)', () => {
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['a', 'gone', 'b'] }]
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
		expect(tree.children.get(folderKey(['F']))).toEqual(['a', 'b']);
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
});
