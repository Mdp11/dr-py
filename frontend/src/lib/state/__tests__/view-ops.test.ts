import { describe, expect, it } from 'vitest';
import type { Folder, View } from '$lib/api/types';
import { isFolderPathAncestor, moveFolderInView, placeElementsInView } from '../view-ops';

function folder(name: string, elements: string[] = [], folders: Folder[] = []): Folder {
	return { name, folders, elements };
}

function view(...folders: Folder[]): View {
	return { name: 'v', folders };
}

describe('isFolderPathAncestor', () => {
	it('treats a path as its own ancestor', () => {
		expect(isFolderPathAncestor(['A'], ['A'])).toBe(true);
	});

	it('matches a direct child', () => {
		expect(isFolderPathAncestor(['A'], ['A', 'B'])).toBe(true);
	});

	it('matches a deep descendant', () => {
		expect(isFolderPathAncestor(['A'], ['A', 'B', 'C'])).toBe(true);
	});

	it('does not match a sibling', () => {
		expect(isFolderPathAncestor(['A'], ['B'])).toBe(false);
	});

	it('treats the empty (root) path as ancestor of everything', () => {
		expect(isFolderPathAncestor([], ['A'])).toBe(true);
		expect(isFolderPathAncestor([], [])).toBe(true);
	});

	it('is not an ancestor when it is longer than the candidate descendant', () => {
		expect(isFolderPathAncestor(['A', 'B'], ['A'])).toBe(false);
	});
});

describe('placeElementsInView', () => {
	it('places multiple ids into the target folder', () => {
		const v = view(folder('Group'));
		const next = placeElementsInView(v, ['Group'], ['e1', 'e2']);
		expect(next.folders[0].elements).toEqual(['e1', 'e2']);
	});

	it('strips ids from any folder that previously held them (single-folder rule)', () => {
		const v = view(folder('Old', ['e1']), folder('New'));
		const next = placeElementsInView(v, ['New'], ['e1']);
		expect(next.folders[0].elements).toEqual([]);
		expect(next.folders[1].elements).toEqual(['e1']);
	});

	it('removes ids from all folders when path is empty (unplaced)', () => {
		const v = view(folder('Group', ['e1', 'e2', 'keep']));
		const next = placeElementsInView(v, [], ['e1', 'e2']);
		expect(next.folders[0].elements).toEqual(['keep']);
	});

	it('does not duplicate an id already present in the target', () => {
		const v = view(folder('Group', ['e1']));
		const next = placeElementsInView(v, ['Group'], ['e1']);
		expect(next.folders[0].elements).toEqual(['e1']);
	});

	it('throws when the target folder does not exist', () => {
		const v = view(folder('Group'));
		expect(() => placeElementsInView(v, ['Missing'], ['e1'])).toThrow();
	});

	it('does not mutate the input view', () => {
		const v = view(folder('Group'));
		placeElementsInView(v, ['Group'], ['e1']);
		expect(v.folders[0].elements).toEqual([]);
	});
});

describe('moveFolderInView', () => {
	it('reparents a folder, preserving its subtree and elements', () => {
		const v = view(folder('Src', ['e1'], [folder('Child', ['e2'])]), folder('Dest'));
		const next = moveFolderInView(v, ['Src'], ['Dest']);
		expect(next.folders.map((f) => f.name)).toEqual(['Dest']);
		const moved = next.folders[0].folders[0];
		expect(moved.name).toBe('Src');
		expect(moved.elements).toEqual(['e1']);
		expect(moved.folders[0].name).toBe('Child');
		expect(moved.folders[0].elements).toEqual(['e2']);
	});

	it('moves a nested folder up to the top level', () => {
		const v = view(folder('Parent', [], [folder('Inner')]));
		const next = moveFolderInView(v, ['Parent', 'Inner'], []);
		expect(next.folders.map((f) => f.name).sort()).toEqual(['Inner', 'Parent']);
		expect(next.folders.find((f) => f.name === 'Parent')!.folders).toEqual([]);
	});

	it('throws when moving a folder into itself', () => {
		const v = view(folder('A'));
		expect(() => moveFolderInView(v, ['A'], ['A'])).toThrow();
	});

	it('throws when moving a folder into one of its descendants', () => {
		const v = view(folder('A', [], [folder('B')]));
		expect(() => moveFolderInView(v, ['A'], ['A', 'B'])).toThrow();
	});

	it('throws when moving the view root', () => {
		const v = view(folder('A'));
		expect(() => moveFolderInView(v, [], ['A'])).toThrow();
	});

	it('throws when a sibling with the same name already exists at the destination', () => {
		const v = view(folder('A'), folder('Dest', [], [folder('A')]));
		expect(() => moveFolderInView(v, ['A'], ['Dest'])).toThrow();
	});

	it('throws when the source folder does not exist', () => {
		const v = view(folder('Dest'));
		expect(() => moveFolderInView(v, ['Missing'], ['Dest'])).toThrow();
	});

	it('is a no-op when the folder is already a direct child of the destination', () => {
		const v = view(folder('Parent', [], [folder('Inner')]));
		const next = moveFolderInView(v, ['Parent', 'Inner'], ['Parent']);
		expect(next.folders[0].folders.map((f) => f.name)).toEqual(['Inner']);
	});

	it('does not mutate the input view', () => {
		const v = view(folder('Src'), folder('Dest'));
		moveFolderInView(v, ['Src'], ['Dest']);
		expect(v.folders.map((f) => f.name)).toEqual(['Src', 'Dest']);
	});
});
