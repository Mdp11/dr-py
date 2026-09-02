import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { View } from '$lib/api/types';
import * as viewApi from '$lib/api/views';
import * as editGate from '../edit-gate';

// Module-scope commit taps (view.svelte.ts registers one at import time) —
// capture the callback `realtime.svelte`'s `onCommitEvent` was handed so
// tests can fire it directly, mirroring the module-scope-tap idiom this
// store itself follows (table-editor.svelte.ts:1689).
const commitTaps: Array<(info: { scope: string[] }) => void> = [];
const viewTaps: Array<
	(e: { type: 'view'; action: 'created' | 'deleted'; view: { id: string; name: string } }) => void
> = [];
vi.mock('../realtime.svelte', () => ({
	onCommitEvent: (cb: (info: { scope: string[] }) => void) => {
		commitTaps.push(cb);
		return () => {
			const i = commitTaps.indexOf(cb);
			if (i !== -1) commitTaps.splice(i, 1);
		};
	},
	onViewEvent: (cb: (typeof viewTaps)[number]) => {
		viewTaps.push(cb);
		return () => {
			const i = viewTaps.indexOf(cb);
			if (i !== -1) viewTaps.splice(i, 1);
		};
	}
}));

const {
	addView,
	clearViewState,
	discardViewChanges,
	getActiveViewId,
	getView,
	getViews,
	loadViews,
	refreshView,
	removeView,
	selectView,
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
const { getLockNotice, setLockNotice } = await import('../lock-notice.svelte');
const { getViewDiscardNotice, clearViewDiscardNotice } =
	await import('../view-discard-notice.svelte');
const { setActiveViewId, recallActiveViewId, rememberActiveViewId } =
	await import('../active-view.svelte');
const { setActiveProject } = await import('../active-project.svelte');
const { answerConfirm, getPendingConfirm, resetConfirm } = await import('../confirm.svelte');

/** Seed the ACTIVE view (`v1`) the way boot does: an id chosen, then its
 * content fetched. Every staged op the tests below inspect carries this id. */
function seedView(view: View): void {
	setActiveViewId('v1');
	vi.spyOn(viewApi, 'getView').mockResolvedValue({ view, warnings: [], view_rev: 0 });
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
		expect(ops[0]).toMatchObject({
			kind: 'create_folder',
			view_id: 'v1',
			parent_id: 'root',
			name: 'New Folder'
		});
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
		expect(getStagedViewOps()).toEqual([
			{ kind: 'rename_folder', view_id: 'v1', id: 'f1', name: 'Renamed' }
		]);
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
		expect(getStagedViewOps()).toEqual([{ kind: 'delete_folder', view_id: 'v1', id: 'f1' }]);
		expect(getView()!.folders.map((f) => f.id)).toEqual(['f2']);
	});

	// Excluded-pool injection payload: the entry must carry every element that
	// was placed anywhere in the deleted subtree, captured BEFORE the pop (see
	// `subtreeElementIds`'s docstring) — ContainmentTree.svelte mirrors this
	// into the "Not in view" pool client-side, ahead of any commit.
	it("stages the deleted subtree's placed elements as the injection payload", async () => {
		seedView(baseView()); // f1 = ['e1', 'e2'], its nested f1a is empty
		await refreshView();
		vi.spyOn(editGate, 'folderDeleteLock').mockResolvedValue(true);

		await stageDeleteFolder('f1');

		expect(getStagedViewEntries()[0].unplacedElementIds).toEqual(['e1', 'e2']);
	});

	it('collects elements placed in a NESTED descendant folder too', async () => {
		const view: View = {
			name: 'v',
			folders: [
				{
					id: 'f1',
					name: 'F1',
					elements: ['e1'],
					artifacts: [],
					folders: [{ id: 'f1a', name: 'Nested', folders: [], elements: ['e2'], artifacts: [] }]
				}
			],
			artifacts: []
		};
		seedView(view);
		await refreshView();
		vi.spyOn(editGate, 'folderDeleteLock').mockResolvedValue(true);

		await stageDeleteFolder('f1');

		expect(getStagedViewEntries()[0].unplacedElementIds).toEqual(['e1', 'e2']);
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
		expect(getStagedViewOps()).toEqual([
			{ kind: 'move_folder', view_id: 'v1', id: 'f1a', to_parent_id: 'f2' }
		]);
		expect(getView()!.folders[1].folders.map((f) => f.id)).toEqual(['f1a']);
	});
});

describe('stagePlaceElementsAt — index math', () => {
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
				view_id: 'v1',
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
				view_id: 'v1',
				element_id: 'e1',
				from_folder_id: 'f1',
				to_folder_id: 'f2',
				index: 0
			},
			{
				kind: 'move_element',
				view_id: 'v1',
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
			view_id: 'v1',
			element_id: 'e9',
			folder_id: 'f1',
			index: 5
		});

		const removed = await stagePlaceElementsAt(null, ['e1'], 0);
		expect(removed).toBe(true);
		expect(getStagedViewOps().at(-1)).toEqual({
			kind: 'remove_element',
			view_id: 'v1',
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
			{ kind: 'remove_element', view_id: 'v1', element_id: 'e1', folder_id: 'f1' }
		]);
		// Excluded-pool injection payload: a remove_element entry carries its
		// own target id.
		expect(getStagedViewEntries()[0].unplacedElementIds).toEqual(['e1']);
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
				view_id: 'v1',
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
				view_id: 'v1',
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
			{ kind: 'remove_artifact', view_id: 'v1', artifact_id: 'art1', folder_id: 'f1' }
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
			{ kind: 'delete_folder', view_id: 'v1', id: 'f1' },
			{ kind: 'delete_folder', view_id: 'v1', id: 'f2' },
			{ kind: 'remove_artifact', view_id: 'v1', artifact_id: 'root-art', folder_id: 'root' }
		]);
		expect(getView()).toEqual({ name: 'v', folders: [], artifacts: [] });
		// Excluded-pool injection payload: each delete_folder entry carries its
		// own subtree's placed elements; f2 has none.
		const entries = getStagedViewEntries();
		expect(entries[0].unplacedElementIds).toEqual(['e1', 'e2']);
		expect(entries[1].unplacedElementIds).toEqual([]);
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
			warnings: [],
			view_rev: 0
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
			warnings: [],
			view_rev: 0
		});

		await discardViewChanges();

		expect(release).toHaveBeenCalledWith('f1');
		expect(getStagedViewOps()).toHaveLength(0);
		expect(getSpy).toHaveBeenCalled();
		expect(getView()!.folders[0].name).toBe('Folder 1'); // restored from server truth
	});
});

describe('stagePlaceElementsAt — cursor advance on a same-folder multi-select', () => {
	const fourEl = (): View => ({
		name: 'v',
		folders: [{ id: 'f1', name: 'F1', folders: [], elements: ['a', 'b', 'c', 'd'], artifacts: [] }],
		artifacts: []
	});

	// `at` must not advance after an op whose post-pop correction already
	// advanced it, or the second id lands one slot short and, for the last
	// id, does not move at all.
	it('holds the cursor after a pre-cursor pop (the [a,d] → index 2 repro)', async () => {
		seedView(fourEl());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stagePlaceElementsAt('f1', ['a', 'd'], 2);

		expect(ok).toBe(true);
		expect(getStagedViewOps()).toEqual([
			// a sat at 0, BELOW the cursor: post-pop index 1, and the cursor holds…
			{
				kind: 'move_element',
				view_id: 'v1',
				element_id: 'a',
				from_folder_id: 'f1',
				to_folder_id: 'f1',
				index: 1
			},
			// …so d (now at 3, above the cursor) still targets slot 2, not 3.
			{
				kind: 'move_element',
				view_id: 'v1',
				element_id: 'd',
				from_folder_id: 'f1',
				to_folder_id: 'f1',
				index: 2
			}
		]);
		expect(getView()!.folders[0].elements).toEqual(['b', 'a', 'd', 'c']);
	});

	it('advances the cursor when the pop was AFTER it (no correction fired)', async () => {
		seedView(fourEl());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stagePlaceElementsAt('f1', ['c', 'd'], 0);

		expect(ok).toBe(true);
		expect(getStagedViewOps()).toEqual([
			{
				kind: 'move_element',
				view_id: 'v1',
				element_id: 'c',
				from_folder_id: 'f1',
				to_folder_id: 'f1',
				index: 0
			},
			{
				kind: 'move_element',
				view_id: 'v1',
				element_id: 'd',
				from_folder_id: 'f1',
				to_folder_id: 'f1',
				index: 1
			}
		]);
		expect(getView()!.folders[0].elements).toEqual(['c', 'd', 'a', 'b']);
	});

	it('omitting the index appends, and emits no `index` key at all', async () => {
		seedView(fourEl());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);

		const ok = await stagePlaceElementsAt('f1', ['x']);

		expect(ok).toBe(true);
		const op = getStagedViewOps()[0];
		expect(op).toMatchObject({
			kind: 'place_element',
			view_id: 'v1',
			element_id: 'x',
			folder_id: 'f1'
		});
		// the append sentinel is an ABSENT index, never a huge literal
		expect(JSON.parse(JSON.stringify(op))).not.toHaveProperty('index');
		expect(getView()!.folders[0].elements).toEqual(['a', 'b', 'c', 'd', 'x']);
	});
});

describe('refreshView re-applies the staged journal on top of server truth', () => {
	beforeEach(() => {
		setLockNotice(null);
		clearViewDiscardNotice();
		vi.spyOn(checkoutStore, 'releaseFolderLeaseIfUnneeded').mockResolvedValue(undefined);
	});

	it('keeps my staged ops applied when a peer touched a DIFFERENT folder', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
		await stageRenameFolder('f1', 'Mine');
		expect(getStagedViewOps()).toHaveLength(1);

		// peer renamed f2 and committed; our refetch sees their truth
		const peerView = baseView();
		peerView.folders[1].name = 'Theirs';
		seedView(peerView);
		await refreshView();

		expect(getView()!.folders[0].name).toBe('Mine'); // my staged rename survived
		expect(getView()!.folders[1].name).toBe('Theirs'); // their commit landed
		expect(getStagedViewOps()).toHaveLength(1); // journal intact
		expect(getLockNotice()).toBeNull();
	});

	it('drops the WHOLE journal and notices when a staged op no longer applies', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
		await stageRenameFolder('f1', 'Mine1');
		await stageRenameFolder('f2', 'Mine2'); // this one WOULD still apply cleanly
		expect(getStagedViewOps()).toHaveLength(2);

		// peer DELETED f1 out from under us: the first rename can no longer apply
		const peerView = baseView();
		peerView.folders.splice(0, 1);
		seedView(peerView);
		await refreshView();

		expect(getStagedViewOps()).toHaveLength(0); // all-or-nothing, not per-op
		expect(getView()!.folders.map((f) => f.name)).toEqual(['Folder 2']); // server truth
		// The durable discard banner carries the message now...
		expect(getViewDiscardNotice()).toMatch(/view changed/i);
		// ...NOT the transient lock notice: a destructive discard must not ride
		// a channel the next successful lease clears.
		expect(getLockNotice()).toBeNull();
		expect(checkoutStore.releaseFolderLeaseIfUnneeded).toHaveBeenCalledWith('f1');
		expect(checkoutStore.releaseFolderLeaseIfUnneeded).toHaveBeenCalledWith('f2');
	});

	it('the discard banner SURVIVES a subsequent successful lease acquisition — the exact path that clears the transient lock notice', async () => {
		seedView(baseView());
		await refreshView();
		const editLockSpy = vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
		await stageRenameFolder('f1', 'Mine1');

		// peer DELETED f1 out from under us: the staged rename can no longer apply
		const peerView = baseView();
		peerView.folders.splice(0, 1);
		seedView(peerView);
		await refreshView(); // drops the journal, posts the discard banner

		expect(getViewDiscardNotice()).toMatch(/view changed/i);

		// Restore the REAL folder-lock gate (not the spy above) and drive a
		// successful lease acquisition all the way down to edit-gate's own
		// `noticed()` — the exact function that nulls the transient lock notice
		// on ANY successful gate, mocking only the network boundary, exactly
		// like edit-gate.test.ts's own "clears the notice on success" cases.
		editLockSpy.mockRestore();
		checkoutStore.resetCheckout();
		checkoutStore.setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		const checkoutApi = await import('$lib/api/checkout');
		vi.spyOn(checkoutApi, 'acquireLocks').mockResolvedValue({ token: 't2', leases: [] });

		expect(await editGate.folderEditLock(['f2'])).toBe(true);
		expect(getLockNotice()).toBeNull(); // transient channel: cleared, as always
		expect(getViewDiscardNotice()).toMatch(/view changed/i); // durable banner: untouched
	});
});

describe('named views — list, selection, persistence', () => {
	const summaries = () => [
		{ id: 'v2', name: 'Zeta', view_rev: 0 },
		{ id: 'v1', name: 'Alpha', view_rev: 0 }
	];

	beforeEach(() => {
		setActiveProject('p1');
		rememberActiveViewId('p1', null);
		resetConfirm();
		clearViewDiscardNotice();
	});

	it('loadViews sorts by name and, with nothing remembered, activates the first', async () => {
		vi.spyOn(viewApi, 'listViews').mockResolvedValue(summaries());
		expect(await loadViews()).toBe(true);
		expect(getViews().map((v) => v.name)).toEqual(['Alpha', 'Zeta']);
		expect(getActiveViewId()).toBe('v1');
	});

	it('loadViews prefers the id remembered for the project when it still exists', async () => {
		rememberActiveViewId('p1', 'v2');
		vi.spyOn(viewApi, 'listViews').mockResolvedValue(summaries());
		await loadViews();
		expect(getActiveViewId()).toBe('v2');
	});

	it('loadViews falls back to the first when the remembered id is gone, and to null on an empty list', async () => {
		rememberActiveViewId('p1', 'gone');
		vi.spyOn(viewApi, 'listViews').mockResolvedValue(summaries());
		await loadViews();
		expect(getActiveViewId()).toBe('v1');

		vi.spyOn(viewApi, 'listViews').mockResolvedValue([]);
		expect(await loadViews()).toBe(true);
		expect(getActiveViewId()).toBeNull();
	});

	it('loadViews keeps the current active id when it still exists', async () => {
		setActiveViewId('v2');
		vi.spyOn(viewApi, 'listViews').mockResolvedValue(summaries());
		expect(await loadViews()).toBe(false);
		expect(getActiveViewId()).toBe('v2');
	});

	it('refreshView with no active view resolves to "no view" without a fetch', async () => {
		const getSpy = vi.spyOn(viewApi, 'getView');
		setActiveViewId(null);
		await refreshView();
		expect(getSpy).not.toHaveBeenCalled();
		expect(getView()).toBeNull();
	});

	it('selectView remembers the choice per project and refetches that view', async () => {
		seedView(baseView());
		await refreshView();
		const getSpy = vi.spyOn(viewApi, 'getView').mockResolvedValue({
			view: { name: 'Zeta', folders: [], artifacts: [] },
			warnings: [],
			view_rev: 0
		});

		expect(await selectView('v2')).toBe(true);

		expect(getSpy).toHaveBeenCalledWith('v2');
		expect(getActiveViewId()).toBe('v2');
		expect(recallActiveViewId('p1')).toBe('v2');
		expect(getView()?.name).toBe('Zeta');
	});

	it('selectView with staged edits asks first and keeps them on cancel', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
		await stageRenameFolder('f1', 'Renamed');

		const pending = selectView('v2');
		expect(getPendingConfirm()?.title).toMatch(/switch view/i);
		answerConfirm(false);
		expect(await pending).toBe(false);

		expect(getActiveViewId()).toBe('v1');
		expect(getStagedViewOps()).toHaveLength(1);
	});

	it('selectView with staged edits discards them (releasing their leases) on confirm', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
		await stageRenameFolder('f1', 'Renamed');
		const release = vi
			.spyOn(checkoutStore, 'releaseFolderLeaseIfUnneeded')
			.mockResolvedValue(undefined);

		const pending = selectView('v2');
		answerConfirm(true);
		expect(await pending).toBe(true);

		expect(release).toHaveBeenCalledWith('f1');
		expect(getStagedViewOps()).toHaveLength(0);
		expect(getActiveViewId()).toBe('v2');
	});

	it('every staged op carries the active view id', async () => {
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderCreateLock').mockResolvedValue(true);
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
		await stageCreateFolder('root', 'New');
		await stagePlaceElementsAt('f2', ['e9']);
		expect(getStagedViewOps().map((op) => op.view_id)).toEqual(['v1', 'v1']);
	});

	it('addView creates, refreshes the list and activates the new view', async () => {
		const create = vi
			.spyOn(viewApi, 'createView')
			.mockResolvedValue({ id: 'v3', name: 'New', view_rev: 0 });
		vi.spyOn(viewApi, 'listViews').mockResolvedValue([
			...summaries(),
			{ id: 'v3', name: 'New', view_rev: 0 }
		]);
		vi.spyOn(viewApi, 'getView').mockResolvedValue({
			view: { name: 'New', folders: [], artifacts: [] },
			warnings: [],
			view_rev: 0
		});

		await addView('New', { folders: [] });

		expect(create).toHaveBeenCalledWith({ name: 'New', view: { folders: [] } });
		expect(getViews().map((v) => v.id)).toContain('v3');
		expect(getActiveViewId()).toBe('v3');
		expect(getView()?.name).toBe('New');
	});

	it('removeView of the active view falls back to the next one and posts a notice', async () => {
		vi.spyOn(viewApi, 'listViews').mockResolvedValue(summaries());
		await loadViews();
		seedView(baseView());
		await refreshView();
		const del = vi.spyOn(viewApi, 'deleteView').mockResolvedValue(undefined);
		vi.spyOn(viewApi, 'listViews').mockResolvedValue([{ id: 'v2', name: 'Zeta', view_rev: 0 }]);
		vi.spyOn(viewApi, 'getView').mockResolvedValue({
			view: { name: 'Zeta', folders: [], artifacts: [] },
			warnings: [],
			view_rev: 0
		});

		await removeView('v1');

		expect(del).toHaveBeenCalledWith('v1');
		expect(getActiveViewId()).toBe('v2');
		expect(getView()?.name).toBe('Zeta');
		expect(getViewDiscardNotice()).toMatch(/"Alpha" was deleted/);
	});
});

describe('named views — feed reconciliation', () => {
	beforeEach(() => new Promise((r) => setTimeout(r, 0))); // taps register past a macrotask
	beforeEach(() => {
		setActiveProject('p1');
		rememberActiveViewId('p1', null);
		clearViewDiscardNotice();
	});

	async function settle(): Promise<void> {
		for (let i = 0; i < 6; i++) await Promise.resolve();
	}

	it('a peer deleting the active view drops the journal, releases leases and falls back to "no view"', async () => {
		vi.spyOn(viewApi, 'listViews').mockResolvedValue([{ id: 'v1', name: 'Alpha', view_rev: 0 }]);
		await loadViews();
		seedView(baseView());
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
		await stageRenameFolder('f1', 'Renamed');
		const release = vi
			.spyOn(checkoutStore, 'releaseFolderLeaseIfUnneeded')
			.mockResolvedValue(undefined);
		vi.spyOn(viewApi, 'listViews').mockResolvedValue([]);

		expect(viewTaps.length).toBeGreaterThan(0);
		for (const tap of viewTaps)
			tap({ type: 'view', action: 'deleted', view: { id: 'v1', name: 'Alpha' } });
		await settle();

		expect(getActiveViewId()).toBeNull();
		expect(getView()).toBeNull();
		expect(getStagedViewOps()).toHaveLength(0);
		expect(release).toHaveBeenCalledWith('f1');
		expect(getViewDiscardNotice()).toMatch(/"Alpha" was deleted — no view is active/);
	});

	it('a peer adding a view only refreshes the list', async () => {
		vi.spyOn(viewApi, 'listViews').mockResolvedValue([{ id: 'v1', name: 'Alpha', view_rev: 0 }]);
		await loadViews();
		seedView(baseView());
		await refreshView();
		const getSpy = vi.spyOn(viewApi, 'getView');
		vi.spyOn(viewApi, 'listViews').mockResolvedValue([
			{ id: 'v1', name: 'Alpha', view_rev: 0 },
			{ id: 'v9', name: 'Other', view_rev: 0 }
		]);

		for (const tap of viewTaps)
			tap({ type: 'view', action: 'created', view: { id: 'v9', name: 'Other' } });
		await settle();

		expect(getViews().map((v) => v.id)).toEqual(['v1', 'v9']);
		expect(getActiveViewId()).toBe('v1');
		expect(getSpy).not.toHaveBeenCalled();
		expect(getViewDiscardNotice()).toBeNull();
	});
});
