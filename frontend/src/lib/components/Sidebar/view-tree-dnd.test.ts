import { describe, expect, it } from 'vitest';
import type { View } from '$lib/api/types';
import {
	canDropArtifact,
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
	it('round-trips a single folder id, wrapped in the same JSON-array wire shape as the element payload', () => {
		expect(decodeFolderPayload(encodeFolderPayload('fa'))).toEqual(['fa']);
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
		folderPathNames: new Map(),
		placedElementIds: new Set(),
		artifactRef: new Map(),
		...partial
	};
}

describe('movableElementIds', () => {
	it('is the union of non-folder roots and placed element ids', () => {
		const t = tree({
			roots: [folderKey('fgroup'), 'rootEl'], // a folder key plus an unplaced element
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
	// A -> B (nested); C is a sibling of A unrelated to the A/B subtree.
	const view: View = {
		name: 'v',
		folders: [
			{
				id: 'A',
				name: 'A',
				folders: [{ id: 'B', name: 'B', folders: [], elements: [], artifacts: [] }],
				elements: [],
				artifacts: []
			},
			{ id: 'C', name: 'C', folders: [], elements: [], artifacts: [] }
		],
		artifacts: []
	};

	it('accepts moving a folder under an unrelated folder', () => {
		expect(canDropFolder({ view, sourceId: 'C', destParentId: 'A' }).ok).toBe(true);
	});

	it('accepts moving a folder to the top level (null destParentId)', () => {
		expect(canDropFolder({ view, sourceId: 'B', destParentId: null }).ok).toBe(true);
	});

	it('rejects dropping a folder onto itself', () => {
		expect(canDropFolder({ view, sourceId: 'A', destParentId: 'A' }).ok).toBe(false);
	});

	it('rejects dropping a folder into one of its descendants (cycle)', () => {
		expect(canDropFolder({ view, sourceId: 'A', destParentId: 'B' }).ok).toBe(false);
	});
});

describe('canDropArtifact', () => {
	it('accepts a folder drop target', () => {
		expect(canDropArtifact('folder')).toBe(true);
	});

	it('rejects an element drop target', () => {
		expect(canDropArtifact('element')).toBe(false);
	});

	it('rejects a section drop target (excluded pool / view-root sentinel)', () => {
		expect(canDropArtifact('section')).toBe(false);
	});
});
