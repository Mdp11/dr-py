import { describe, expect, it } from 'vitest';
import type { Folder, View } from '$lib/api/types';
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
			temp_id: 'tmp_x',
			parent_id: VIEW_ROOT_ID,
			name: 'N'
		});
		expect(v.folders.map((f) => f.id)).toContain('tmp_x');
		v = applyViewOp(v, { kind: 'create_folder', temp_id: 'tmp_y', parent_id: 'tmp_x', name: 'M' });
		expect(findFolderById(v, 'tmp_y')).not.toBeNull();
	});
	it('rejects sibling name clashes like the backend', () => {
		expect(() =>
			applyViewOp(view(), {
				kind: 'create_folder',
				temp_id: 'tmp_x',
				parent_id: VIEW_ROOT_ID,
				name: 'A'
			})
		).toThrow(/already exists/);
	});
	it('place_element refuses placed elements and the root', () => {
		expect(() =>
			applyViewOp(view(), { kind: 'place_element', element_id: 'e1', folder_id: 'fc' })
		).toThrow(/already placed/);
		expect(() =>
			applyViewOp(view(), { kind: 'place_element', element_id: 'ex', folder_id: VIEW_ROOT_ID })
		).toThrow(/root/);
	});
	it('move_element reorders within a folder with post-pop index math', () => {
		// e1 at 0, e2 at 1: moving e1 below e2 means index 1 AFTER the pop.
		const v = applyViewOp(view(), {
			kind: 'move_element',
			element_id: 'e1',
			from_folder_id: 'fa',
			to_folder_id: 'fa',
			index: 1
		});
		expect(findFolderById(v, 'fa')?.elements).toEqual(['e2', 'e1']);
	});
	it('delete_folder drops the whole subtree', () => {
		const v = applyViewOp(view(), { kind: 'delete_folder', id: 'fa' });
		expect(findFolderById(v, 'fb')).toBeNull();
		expect(v.folders.map((f) => f.id)).toEqual(['fc']);
	});
	it('move_folder rejects cycles', () => {
		expect(() => applyViewOp(view(), { kind: 'move_folder', id: 'fa', to_parent_id: 'fb' })).toThrow(
			/descendant/
		);
	});
	it('artifact ops treat root as a real container', () => {
		const v = applyViewOp(view(), {
			kind: 'move_artifact',
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
			artifact_id: 'art3',
			artifact_kind: 'table',
			folder_id: VIEW_ROOT_ID
		});
		expect(v.artifacts.map((a) => a.id)).toEqual(['art2', 'art3']);
		v = applyViewOp(v, {
			kind: 'move_artifact',
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
		applyViewOp(before, { kind: 'rename_folder', id: 'fa', name: 'Z' });
		expect(JSON.stringify(before)).toBe(snapshot);
	});
});
