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
