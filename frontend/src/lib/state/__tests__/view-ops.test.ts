import { describe, expect, it } from 'vitest';
import type { View } from '$lib/api/types';
import { VIEW_ROOT_ID } from '../ops';
import {
	applyViewOp,
	artifactPlacementFolderIds,
	elementHomeFolderId,
	findFolderById,
	findFolderContainer,
	folderSubtreeIds,
	isFolderIdAncestor
} from '../view-ops';

const view = (): View => ({
	name: 'v',
	folders: [
		{
			id: 'fa',
			name: 'A',
			elements: ['e1', 'e2'],
			artifacts: [{ id: 'art1', kind: 'table' }],
			folders: [{ id: 'fb', name: 'B', elements: ['e3'], artifacts: [], folders: [] }]
		},
		{ id: 'fc', name: 'C', elements: [], artifacts: [], folders: [] }
	],
	artifacts: [{ id: 'art2', kind: 'navigation' }]
});

describe('id addressing', () => {
	it('finds folders and containers by id', () => {
		expect(findFolderById(view(), 'fb')?.name).toBe('B');
		expect(findFolderContainer(view(), 'fb')?.parentId).toBe('fa');
		expect(findFolderContainer(view(), 'fa')?.parentId).toBe(VIEW_ROOT_ID);
		expect(findFolderById(view(), 'nope')).toBeNull();
	});
	it('walks subtrees and ancestry', () => {
		expect(folderSubtreeIds(view(), 'fa')).toEqual(['fa', 'fb']);
		expect(isFolderIdAncestor(view(), 'fa', 'fb')).toBe(true);
		expect(isFolderIdAncestor(view(), 'fa', 'fa')).toBe(true);
		expect(isFolderIdAncestor(view(), 'fb', 'fa')).toBe(false);
	});
	it('locates element homes and artifact placements', () => {
		expect(elementHomeFolderId(view(), 'e3')).toBe('fb');
		expect(elementHomeFolderId(view(), 'unplaced')).toBeNull();
		expect(artifactPlacementFolderIds(view(), 'art1')).toEqual(['fa']);
		expect(artifactPlacementFolderIds(view(), 'art2')).toEqual([VIEW_ROOT_ID]);
	});
});

describe('applyViewOp', () => {
	it('creates a folder under root and under a parent', () => {
		let v = applyViewOp(view(), {
			kind: 'create_folder',
			view_id: 'v1',
			temp_id: 'tmp_x',
			parent_id: VIEW_ROOT_ID,
			name: 'N'
		});
		expect(v.folders.map((f) => f.id)).toContain('tmp_x');
		v = applyViewOp(v, {
			kind: 'create_folder',
			view_id: 'v1',
			temp_id: 'tmp_y',
			parent_id: 'tmp_x',
			name: 'M'
		});
		expect(findFolderById(v, 'tmp_y')).not.toBeNull();
	});
	it('rejects sibling name clashes like the backend', () => {
		expect(() =>
			applyViewOp(view(), {
				kind: 'create_folder',
				view_id: 'v1',
				temp_id: 'tmp_x',
				parent_id: VIEW_ROOT_ID,
				name: 'A'
			})
		).toThrow(/already exists/);
	});
	it('place_element refuses placed elements and the root', () => {
		expect(() =>
			applyViewOp(view(), {
				kind: 'place_element',
				view_id: 'v1',
				element_id: 'e1',
				folder_id: 'fc'
			})
		).toThrow(/already placed/);
		expect(() =>
			applyViewOp(view(), {
				kind: 'place_element',
				view_id: 'v1',
				element_id: 'ex',
				folder_id: VIEW_ROOT_ID
			})
		).toThrow(/root/);
	});
	it('move_element reorders within a folder with post-pop index math', () => {
		// e1 at 0, e2 at 1: moving e1 below e2 means index 1 AFTER the pop.
		const v = applyViewOp(view(), {
			kind: 'move_element',
			view_id: 'v1',
			element_id: 'e1',
			from_folder_id: 'fa',
			to_folder_id: 'fa',
			index: 1
		});
		expect(findFolderById(v, 'fa')?.elements).toEqual(['e2', 'e1']);
	});
	it('delete_folder drops the whole subtree', () => {
		const v = applyViewOp(view(), { kind: 'delete_folder', view_id: 'v1', id: 'fa' });
		expect(findFolderById(v, 'fb')).toBeNull();
		expect(v.folders.map((f) => f.id)).toEqual(['fc']);
	});
	it('move_folder rejects cycles', () => {
		expect(() =>
			applyViewOp(view(), { kind: 'move_folder', view_id: 'v1', id: 'fa', to_parent_id: 'fb' })
		).toThrow(/descendant/);
	});
	it('move_folder reparents and preserves subtree/elements', () => {
		// Reparent 'fa' (which contains 'fb') under 'fc'
		const v = applyViewOp(view(), {
			kind: 'move_folder',
			view_id: 'v1',
			id: 'fa',
			to_parent_id: 'fc'
		});
		const movedFolder = findFolderById(v, 'fa');
		expect(movedFolder).not.toBeNull();
		expect(movedFolder?.elements).toEqual(['e1', 'e2']);
		const child = findFolderById(v, 'fb');
		expect(child).not.toBeNull();
		expect(child?.elements).toEqual(['e3']);
		// Verify it's under fc
		expect(findFolderContainer(v, 'fa')?.parentId).toBe('fc');
	});
	it('move_folder moves nested folder to top level (VIEW_ROOT_ID)', () => {
		const v = applyViewOp(view(), {
			kind: 'move_folder',
			view_id: 'v1',
			id: 'fb',
			to_parent_id: VIEW_ROOT_ID
		});
		expect(v.folders.map((f) => f.id)).toContain('fb');
		expect(findFolderContainer(v, 'fb')?.parentId).toBe(VIEW_ROOT_ID);
		// Original parent should no longer contain it
		expect(findFolderById(v, 'fa')?.folders.map((f) => f.id)).not.toContain('fb');
	});
	it('move_folder rejects destination name clash', () => {
		// Try to move 'fb' to root, but 'fc' already exists at root with the same structure
		const v = applyViewOp(view(), {
			kind: 'create_folder',
			view_id: 'v1',
			temp_id: 'tmp_fb',
			parent_id: VIEW_ROOT_ID,
			name: 'B'
		});
		expect(() =>
			applyViewOp(v, { kind: 'move_folder', view_id: 'v1', id: 'fb', to_parent_id: VIEW_ROOT_ID })
		).toThrow(/already exists/);
	});
	it('move_folder rejects source not found', () => {
		expect(() =>
			applyViewOp(view(), { kind: 'move_folder', view_id: 'v1', id: 'nope', to_parent_id: 'fc' })
		).toThrow(/Folder not found/);
	});
	it('artifact ops treat root as a real container', () => {
		const v = applyViewOp(view(), {
			kind: 'move_artifact',
			view_id: 'v1',
			artifact_id: 'art2',
			from_folder_id: VIEW_ROOT_ID,
			to_folder_id: 'fc'
		});
		expect(v.artifacts.some((a) => a.id === 'art2')).toBe(false);
		expect(findFolderById(v, 'fc')?.artifacts.map((a) => a.id)).toEqual(['art2']);
	});
	it('move_artifact reorders within the root without a false "already placed"', () => {
		// Root resolves through `containerOf` twice (once for `from`, once for
		// `to`) — each call allocates a fresh wrapper object, so this exercises
		// same-container detection that must NOT rely on wrapper identity (see
		// `applyViewOp`'s `move_artifact` branch comment).
		let v = view();
		v = applyViewOp(v, {
			kind: 'place_artifact',
			view_id: 'v1',
			artifact_id: 'art3',
			artifact_kind: 'table',
			folder_id: VIEW_ROOT_ID
		});
		expect(v.artifacts.map((a) => a.id)).toEqual(['art2', 'art3']);
		v = applyViewOp(v, {
			kind: 'move_artifact',
			view_id: 'v1',
			artifact_id: 'art2',
			from_folder_id: VIEW_ROOT_ID,
			to_folder_id: VIEW_ROOT_ID,
			index: 1
		});
		expect(v.artifacts.map((a) => a.id)).toEqual(['art3', 'art2']);
	});
	it('does not mutate its input', () => {
		const before = view();
		const snapshot = JSON.stringify(before);
		applyViewOp(before, { kind: 'rename_folder', view_id: 'v1', id: 'fa', name: 'Z' });
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	describe('artifact multi-placement', () => {
		it('places same artifact in two separate containers (root + folder)', () => {
			let v = view();
			// Place art1 (currently in fa) into the root too
			v = applyViewOp(v, {
				kind: 'place_artifact',
				view_id: 'v1',
				artifact_id: 'art1',
				artifact_kind: 'table',
				folder_id: VIEW_ROOT_ID
			});
			// art1 should now be in both root AND fa
			expect(v.artifacts.map((a) => a.id)).toContain('art1');
			expect(findFolderById(v, 'fa')?.artifacts.map((a) => a.id)).toContain('art1');
		});

		it('move_artifact from one container leaves other placement intact', () => {
			// Start with art1 in fa, add it to root too
			let v = applyViewOp(view(), {
				kind: 'place_artifact',
				view_id: 'v1',
				artifact_id: 'art1',
				artifact_kind: 'table',
				folder_id: VIEW_ROOT_ID
			});
			expect(v.artifacts.map((a) => a.id)).toContain('art1');
			expect(findFolderById(v, 'fa')?.artifacts.map((a) => a.id)).toContain('art1');

			// Move art1 from root to fc
			v = applyViewOp(v, {
				kind: 'move_artifact',
				view_id: 'v1',
				artifact_id: 'art1',
				from_folder_id: VIEW_ROOT_ID,
				to_folder_id: 'fc'
			});

			// art1 should no longer be in root, but still in fa
			expect(v.artifacts.map((a) => a.id)).not.toContain('art1');
			expect(findFolderById(v, 'fa')?.artifacts.map((a) => a.id)).toContain('art1');
			expect(findFolderById(v, 'fc')?.artifacts.map((a) => a.id)).toContain('art1');
		});

		it('remove_artifact from one container leaves other placements intact', () => {
			// Start with art1 in fa, add it to root too
			let v = applyViewOp(view(), {
				kind: 'place_artifact',
				view_id: 'v1',
				artifact_id: 'art1',
				artifact_kind: 'table',
				folder_id: VIEW_ROOT_ID
			});

			// Remove art1 from root only
			v = applyViewOp(v, {
				kind: 'remove_artifact',
				view_id: 'v1',
				artifact_id: 'art1',
				folder_id: VIEW_ROOT_ID
			});

			// art1 should still be in fa
			expect(v.artifacts.map((a) => a.id)).not.toContain('art1');
			expect(findFolderById(v, 'fa')?.artifacts.map((a) => a.id)).toContain('art1');
		});

		it('place_artifact into container that already holds it throws (per-container idempotence)', () => {
			const v = view();
			// art1 is already in fa, trying to place it there again should throw
			expect(() =>
				applyViewOp(v, {
					kind: 'place_artifact',
					view_id: 'v1',
					artifact_id: 'art1',
					artifact_kind: 'table',
					folder_id: 'fa'
				})
			).toThrow(/already placed/);
		});
	});
});
