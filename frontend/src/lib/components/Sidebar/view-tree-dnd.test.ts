import { describe, expect, it } from 'vitest';
import {
	canDropElement,
	canDropFolder,
	decodeElementPayload,
	decodeFolderPayload,
	encodeElementPayload,
	encodeFolderPayload,
	folderKey,
	movableElementIds,
	type UnifiedTree
} from './view-tree';

describe('element payload', () => {
	it('round-trips an id array', () => {
		expect(decodeElementPayload(encodeElementPayload(['a', 'b']))).toEqual(['a', 'b']);
	});

	it('returns null for malformed json', () => {
		expect(decodeElementPayload('not json')).toBeNull();
	});

	it('returns null when the payload is not a string array', () => {
		expect(decodeElementPayload(JSON.stringify({ id: 'a' }))).toBeNull();
		expect(decodeElementPayload(JSON.stringify([1, 2]))).toBeNull();
	});
});

describe('folder payload', () => {
	it('round-trips a path array (including names with the join char)', () => {
		expect(decodeFolderPayload(encodeFolderPayload(['a b', 'c']))).toEqual(['a b', 'c']);
	});

	it('round-trips the empty (root) path', () => {
		expect(decodeFolderPayload(encodeFolderPayload([]))).toEqual([]);
	});

	it('returns null for malformed json', () => {
		expect(decodeFolderPayload('{')).toBeNull();
	});

	it('returns null when the payload is not a string array', () => {
		expect(decodeFolderPayload(JSON.stringify('a'))).toBeNull();
	});
});

function tree(partial: Partial<UnifiedTree>): UnifiedTree {
	return {
		roots: [],
		excludedRoots: [],
		children: new Map(),
		kind: new Map(),
		folderName: new Map(),
		placedElementIds: new Set(),
		...partial
	};
}

describe('movableElementIds', () => {
	it('is the union of non-folder roots and placed element ids', () => {
		const t = tree({
			roots: [folderKey(['Group']), 'rootEl'], // a folder key plus an unplaced element
			placedElementIds: new Set(['placed1', 'placed2'])
		});
		expect(movableElementIds(t)).toEqual(new Set(['rootEl', 'placed1', 'placed2']));
	});
});

describe('canDropElement', () => {
	const movableIds = new Set(['m1', 'm2']);
	const knownIds = new Set(['m1', 'm2', 'contained']);

	it('accepts a movable, known element', () => {
		expect(canDropElement({ elementIds: ['m1'], movableIds, knownIds }).ok).toBe(true);
	});

	it('rejects an empty selection', () => {
		expect(canDropElement({ elementIds: [], movableIds, knownIds }).ok).toBe(false);
	});

	it('rejects an element with a containment parent (not movable)', () => {
		expect(canDropElement({ elementIds: ['contained'], movableIds, knownIds }).ok).toBe(false);
	});

	it('rejects an element from outside the view (unknown id)', () => {
		expect(canDropElement({ elementIds: ['ghost'], movableIds, knownIds }).ok).toBe(false);
	});

	it('rejects the whole batch if any id is illegal', () => {
		expect(canDropElement({ elementIds: ['m1', 'contained'], movableIds, knownIds }).ok).toBe(
			false
		);
	});
});

describe('canDropFolder', () => {
	it('accepts moving a folder under an unrelated folder', () => {
		expect(canDropFolder({ sourcePath: ['A'], destParentPath: ['B'] }).ok).toBe(true);
	});

	it('accepts moving a folder to the top level', () => {
		expect(canDropFolder({ sourcePath: ['A', 'B'], destParentPath: [] }).ok).toBe(true);
	});

	it('rejects dropping a folder onto itself', () => {
		expect(canDropFolder({ sourcePath: ['A'], destParentPath: ['A'] }).ok).toBe(false);
	});

	it('rejects dropping a folder into one of its descendants (cycle)', () => {
		expect(canDropFolder({ sourcePath: ['A'], destParentPath: ['A', 'B'] }).ok).toBe(false);
	});

	it('rejects moving the view root', () => {
		expect(canDropFolder({ sourcePath: [], destParentPath: ['A'] }).ok).toBe(false);
	});
});
