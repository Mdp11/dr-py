import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { View } from '$lib/api/types';
import * as viewApi from '$lib/api/view';
import * as editGate from '../edit-gate';

// Module-scope commit taps (view.svelte.ts registers one at import time) —
// capture the callback `realtime.svelte`'s `onCommitEvent` was handed so
// tests can fire it directly, mirroring the module-scope-tap idiom this
// store itself follows (table-editor.svelte.ts:1689).
const commitTaps: Array<(info: { scope: string[] }) => void> = [];
vi.mock('../realtime.svelte', () => ({
	onCommitEvent: (cb: (info: { scope: string[] }) => void) => {
		commitTaps.push(cb);
		return () => {
			const i = commitTaps.indexOf(cb);
			if (i !== -1) commitTaps.splice(i, 1);
		};
	}
}));

const {
	clearViewState,
	discardViewChanges,
	getView,
	refreshView,
	stageClearView,
	stageCreateFolder,
	stageDeleteFolder,
	stageMoveArtifact,
	stageMoveFolder,
	stagePlaceArtifact,
	stagePlaceElementsAt,
	stageRemoveArtifactRef,
	stageRemoveElement,
	stageRenameFolder
} = await import('../view.svelte');
const { getStagedViewEntries, getStagedViewOps } = await import('../view-edits.svelte');
const checkoutStore = await import('../checkout.svelte');

function seedView(view: View): void {
	vi.spyOn(viewApi, 'getView').mockResolvedValue({ view, warnings: [] });
}

const baseView = (): View => ({
	name: 'v',
	folders: [
		{
			id: 'f1',
			name: 'Folder 1',
			folders: [{ id: 'f1a', name: 'Nested', folders: [], elements: [], artifacts: [] }],
			elements: ['e1', 'e2'],
			artifacts: [{ id: 'art1', kind: 'navigation' }]
		},
		{ id: 'f2', name: 'Folder 2', folders: [], elements: [], artifacts: [] }
	],
	artifacts: [{ id: 'root-art', kind: 'table' }]
});

// `commitTaps` is populated ONCE, when view.svelte.ts's module-scope
// `queueMicrotask` registration fires (real module load, not per test) — it
// is never cleared between tests, only read.
beforeEach(() => {
	clearViewState();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('stageCreateFolder', () => {
	it('stages op + applies optimistically on lease grant', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderCreateLock').mockResolvedValue(true);

		const ok = await stageCreateFolder('root', 'New Folder');

		expect(ok).toBe(true);
		const ops = getStagedViewOps();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ kind: 'create_folder', parent_id: 'root', name: 'New Folder' });
		expect(ops[0].kind === 'create_folder' && ops[0].temp_id.startsWith('tmp_')).toBe(true);
		expect(getView()!.folders.map((f) => f.name)).toContain('New Folder');
	});

	it('throws on a sibling name clash before acquiring any lease', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderCreateLock').mockResolvedValue(true);

		await expect(stageCreateFolder('root', 'Folder 1')).rejects.toThrow(/already exists/);
		expect(lock).not.toHaveBeenCalled();
		expect(getStagedViewOps()).toHaveLength(0);
	});
});

describe('stageRenameFolder', () => {
	it('refuses without staging when the lease is denied', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(false);

		const ok = await stageRenameFolder('f1', 'Renamed');

		expect(ok).toBe(false);
		expect(getStagedViewOps()).toHaveLength(0);
		expect(getView()!.folders[0].name).toBe('Folder 1');
	});

	it('is a no-op when the name is unchanged, staging nothing', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stageRenameFolder('f1', 'Folder 1');

		expect(ok).toBe(true);
		expect(lock).not.toHaveBeenCalled();
		expect(getStagedViewOps()).toHaveLength(0);
	});

	it('stages + applies on grant', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stageRenameFolder('f1', 'Renamed');

		expect(ok).toBe(true);
		expect(getStagedViewOps()).toEqual([{ kind: 'rename_folder', id: 'f1', name: 'Renamed' }]);
		expect(getView()!.folders[0].name).toBe('Renamed');
		expect(getStagedViewEntries()[0].label).toBe('Renamed folder "Folder 1" → "Renamed"');
	});
});

describe('stageDeleteFolder', () => {
	it('locks the whole subtree and stages one delete_folder op', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderDeleteLock').mockResolvedValue(true);

		const ok = await stageDeleteFolder('f1');

		expect(ok).toBe(true);
		expect(lock).toHaveBeenCalledWith(['f1', 'f1a']);
		expect(getStagedViewOps()).toEqual([{ kind: 'delete_folder', id: 'f1' }]);
		expect(getView()!.folders.map((f) => f.id)).toEqual(['f2']);
	});
});

describe('stageMoveFolder', () => {
	it('rejects a cycle before acquiring a lease', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		await expect(stageMoveFolder('f1', 'f1a')).rejects.toThrow(/itself or a descendant/);
		expect(lock).not.toHaveBeenCalled();
	});

	it('is a same-parent no-op, staging nothing', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stageMoveFolder('f1', 'root');

		expect(ok).toBe(true);
		expect(lock).not.toHaveBeenCalled();
		expect(getStagedViewOps()).toHaveLength(0);
	});

	it('locks source container + destination and stages a move_folder op', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stageMoveFolder('f1a', 'f2');

		expect(ok).toBe(true);
		expect(lock).toHaveBeenCalledWith(['f1', 'f2']);
		expect(getStagedViewOps()).toEqual([{ kind: 'move_folder', id: 'f1a', to_parent_id: 'f2' }]);
		expect(getView()!.folders[1].folders.map((f) => f.id)).toEqual(['f1a']);
	});
});

describe('stagePlaceElementsAt — Decision 11 index math', () => {
	it('same-folder reorder emits post-pop index', async () => {
		const view: View = {
			name: 'v',
			folders: [{ id: 'f1', name: 'F1', folders: [], elements: ['e1', 'e2'], artifacts: [] }],
			artifacts: []
		};
		seedView(view);
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stagePlaceElementsAt('f1', ['e1'], 2);

		expect(ok).toBe(true);
		expect(getStagedViewOps()).toEqual([
			{
				kind: 'move_element',
				element_id: 'e1',
				from_folder_id: 'f1',
				to_folder_id: 'f1',
				index: 1
			}
		]);
		expect(getView()!.folders[0].elements).toEqual(['e2', 'e1']);
	});

	it('multi-select cross-folder move emits sequential move_element ops with stepped indices', async () => {
		const view: View = {
			name: 'v',
			folders: [
				{ id: 'f1', name: 'F1', folders: [], elements: ['e1', 'e2'], artifacts: [] },
				{ id: 'f2', name: 'F2', folders: [], elements: [], artifacts: [] }
			],
			artifacts: []
		};
		seedView(view);
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stagePlaceElementsAt('f2', ['e1', 'e2'], 0);

		expect(ok).toBe(true);
		expect(lock).toHaveBeenCalledWith(['f2', 'f1']);
		expect(getStagedViewOps()).toEqual([
			{
				kind: 'move_element',
				element_id: 'e1',
				from_folder_id: 'f1',
				to_folder_id: 'f2',
				index: 0
			},
			{
				kind: 'move_element',
				element_id: 'e2',
				from_folder_id: 'f1',
				to_folder_id: 'f2',
				index: 1
			}
		]);
		expect(getView()!.folders[1].elements).toEqual(['e1', 'e2']);
	});

	it('unplaced ids emit place_element; excluded ids emit remove_element per home', async () => {
		const view: View = {
			name: 'v',
			folders: [{ id: 'f1', name: 'F1', folders: [], elements: ['e1'], artifacts: [] }],
			artifacts: []
		};
		seedView(view);
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const placed = await stagePlaceElementsAt('f1', ['e9'], 5);
		expect(placed).toBe(true);
		expect(getStagedViewOps().at(-1)).toEqual({
			kind: 'place_element',
			element_id: 'e9',
			folder_id: 'f1',
			index: 5
		});

		const removed = await stagePlaceElementsAt(null, ['e1'], 0);
		expect(removed).toBe(true);
		expect(getStagedViewOps().at(-1)).toEqual({
			kind: 'remove_element',
			element_id: 'e1',
			folder_id: 'f1'
		});
	});

	it('skips an already-unplaced id on exclude, staging nothing for it', async () => {
		const view: View = {
			name: 'v',
			folders: [{ id: 'f1', name: 'F1', folders: [], elements: [], artifacts: [] }],
			artifacts: []
		};
		seedView(view);
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock');

		const ok = await stagePlaceElementsAt(null, ['ghost'], 0);

		expect(ok).toBe(true);
		expect(lock).not.toHaveBeenCalled();
		expect(getStagedViewOps()).toHaveLength(0);
	});
});

describe('stageRemoveElement', () => {
	it('is sugar for excluding one element', async () => {
		const view: View = {
			name: 'v',
			folders: [{ id: 'f1', name: 'F1', folders: [], elements: ['e1'], artifacts: [] }],
			artifacts: []
		};
		seedView(view);
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stageRemoveElement('e1');

		expect(ok).toBe(true);
		expect(getStagedViewOps()).toEqual([
			{ kind: 'remove_element', element_id: 'e1', folder_id: 'f1' }
		]);
	});
});

describe('artifact placement mutators', () => {
	it('stagePlaceArtifact is a no-op when the folder already holds the ref', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stagePlaceArtifact('f1', { id: 'art1', kind: 'navigation' });

		expect(ok).toBe(true);
		expect(lock).not.toHaveBeenCalled();
		expect(getStagedViewOps()).toHaveLength(0);
	});

	it('stagePlaceArtifact stages place_artifact with the artifact kind', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stagePlaceArtifact('f2', { id: 'art1', kind: 'navigation' });

		expect(ok).toBe(true);
		expect(getStagedViewOps()).toEqual([
			{
				kind: 'place_artifact',
				artifact_id: 'art1',
				artifact_kind: 'navigation',
				folder_id: 'f2'
			}
		]);
	});

	it('stageMoveArtifact is a same-container no-op', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stageMoveArtifact('f1', 'f1', { id: 'art1', kind: 'navigation' });

		expect(ok).toBe(true);
		expect(lock).not.toHaveBeenCalled();
		expect(getStagedViewOps()).toHaveLength(0);
	});

	it('stageMoveArtifact locks both containers and stages move_artifact', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stageMoveArtifact('f1', 'f2', { id: 'art1', kind: 'navigation' });

		expect(ok).toBe(true);
		expect(lock).toHaveBeenCalledWith(['f1', 'f2']);
		expect(getStagedViewOps()).toEqual([
			{
				kind: 'move_artifact',
				artifact_id: 'art1',
				from_folder_id: 'f1',
				to_folder_id: 'f2'
			}
		]);
	});

	it('stageRemoveArtifactRef stages remove_artifact', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stageRemoveArtifactRef('f1', 'art1');

		expect(ok).toBe(true);
		expect(getStagedViewOps()).toEqual([
			{ kind: 'remove_artifact', artifact_id: 'art1', folder_id: 'f1' }
		]);
	});

	it('stageRemoveArtifactRef throws (no lock) when the ref is not actually there', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		await expect(stageRemoveArtifactRef('f2', 'art1')).rejects.toThrow(/not placed/);
		expect(lock).not.toHaveBeenCalled();
	});
});

describe('stageClearView', () => {
	it('stages delete_folder per top folder + remove_artifact per root ref', async () => {
		seedView(baseView());
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderDeleteLock').mockResolvedValue(true);

		const ok = await stageClearView();

		expect(ok).toBe(true);
		expect(lock).toHaveBeenCalledWith(['root', 'f1', 'f1a', 'f2']);
		expect(getStagedViewOps()).toEqual([
			{ kind: 'delete_folder', id: 'f1' },
			{ kind: 'delete_folder', id: 'f2' },
			{ kind: 'remove_artifact', artifact_id: 'root-art', folder_id: 'root' }
		]);
		expect(getView()).toEqual({ name: 'v', folders: [], artifacts: [] });
	});

	it('is a no-op on an already-empty view', async () => {
		seedView({ name: 'v', folders: [], artifacts: [] });
		await refreshView();
		const lock = vi.spyOn(editGate, 'folderDeleteLock');

		const ok = await stageClearView();

		expect(ok).toBe(true);
		expect(lock).not.toHaveBeenCalled();
		expect(getStagedViewOps()).toHaveLength(0);
	});
});

describe('post-commit / peer-commit refetch', () => {
	// The module-scope subscriptions register via `queueMicrotask` (see
	// view.svelte.ts's docstring on the registration site for why: a real
	// three-hop import cycle through realtime.svelte.ts/artifacts.svelte.ts
	// makes a SYNCHRONOUS registration order-dependent on TDZ). A macrotask
	// flush guarantees they have landed before these tests fire a tap.
	beforeEach(() => new Promise((r) => setTimeout(r, 0)));

	it('a view-scoped peer commit refetches GET /view', async () => {
		seedView(baseView());
		await refreshView();
		const getSpy = vi.spyOn(viewApi, 'getView').mockResolvedValue({
			view: { name: 'v', folders: [], artifacts: [] },
			warnings: []
		});

		expect(commitTaps.length).toBeGreaterThan(0);
		for (const tap of commitTaps) tap({ scope: ['model', 'view'] });
		await Promise.resolve();
		await Promise.resolve();

		expect(getSpy).toHaveBeenCalled();
	});

	it('a model-only peer commit does not refetch', async () => {
		seedView(baseView());
		await refreshView();
		const getSpy = vi.spyOn(viewApi, 'getView');

		for (const tap of commitTaps) tap({ scope: ['model'] });
		await Promise.resolve();

		expect(getSpy).not.toHaveBeenCalled();
	});
});

describe('discardViewChanges', () => {
	it('wipes the journal, releases folder leases, refetches', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
		await stageRenameFolder('f1', 'Renamed');
		expect(getStagedViewOps()).toHaveLength(1);

		const release = vi
			.spyOn(checkoutStore, 'releaseFolderLeaseIfUnneeded')
			.mockResolvedValue(undefined);
		const getSpy = vi.spyOn(viewApi, 'getView').mockResolvedValue({
			view: baseView(),
			warnings: []
		});

		await discardViewChanges();

		expect(release).toHaveBeenCalledWith('f1');
		expect(getStagedViewOps()).toHaveLength(0);
		expect(getSpy).toHaveBeenCalled();
		expect(getView()!.folders[0].name).toBe('Folder 1'); // restored from server truth
	});
});
