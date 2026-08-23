import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	commitStaged,
	discardAll,
	discardArtifact,
	ensureCheckout,
	emit,
	getHeldTokens,
	getStagedViewOps,
	getView,
	isCheckedOutByMe,
	onViewCommitted,
	openArtifactTab,
	previewStaged,
	releaseArtifactIfUnneeded,
	releaseFolderLeaseIfUnneeded,
	resetArtifactEdits,
	resetCheckout,
	resetModelStore,
	resetViewEdits,
	refreshView,
	resetWorkspaceTabs,
	seedElements,
	setProjectInfo,
	stageArtifactUpdate,
	stageRenameFolder,
	stageViewOp
} from '../index';
import * as api from '$lib/api/checkout';
import * as viewApi from '$lib/api/view';
import * as editGate from '../edit-gate';
import type { CommitResponse, View } from '$lib/api/types';
import type { ViewOp } from '../ops';

/**
 * View half of the checkout store: the `folder:` lock namespace, the
 * three-buffer (model + artifact + view) commit batch, and the folder
 * lease release rule that mirrors {@link releaseArtifactIfUnneeded}.
 */

/** Mirror of the backend's lock canonicalization: folder targets are SENT
 * with the bare id + type:"folder", leases come back keyed `folder:<id>`. */
function mockAcquire() {
	return vi.spyOn(api, 'acquireLocks').mockImplementation(async (req) => {
		const first = req.targets[0];
		const token =
			first.type === 'folder'
				? `t_folder_${first.resource_id}`
				: first.type === 'artifact'
					? `t_art_${first.resource_id}`
					: `t_el_${first.resource_id}`;
		return {
			token,
			leases: req.targets.map((t) => ({
				resource_id:
					t.type === 'folder'
						? `folder:${t.resource_id}`
						: t.type === 'artifact'
							? `art:${t.resource_id}`
							: t.resource_id,
				mode: t.mode,
				holder: 'default-user',
				token,
				intent: req.intent,
				expires_at: 1
			}))
		};
	});
}

function commitResponse(over: Partial<CommitResponse> = {}): CommitResponse {
	return {
		model_rev: 1,
		id_map: {},
		changed_elements: [],
		changed_relationships: [],
		deleted_element_ids: [],
		deleted_relationship_ids: [],
		issues_removed_owner_ids: [],
		issues_added: [],
		issue_counts: {},
		commit_id: 'c1',
		message: 'm',
		validation_error_count: 0,
		changed_artifacts: [],
		deleted_artifact_ids: [],
		...over
	};
}

/** Check out `e1` exclusively (token t_el_e1) and stage a property edit on it. */
async function checkoutAndEditElement() {
	seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
	await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
	emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
}

/** Check out folder `id` (token t_folder_<id>). */
function checkoutFolder(id: string) {
	return ensureCheckout([{ resource_id: id, mode: 'exclusive', type: 'folder' }], 'edit');
}

beforeEach(() => {
	resetModelStore();
	resetCheckout();
	resetArtifactEdits();
	resetWorkspaceTabs();
	resetViewEdits();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 100 });
});

describe('folder leases in the checkout registry', () => {
	it('keys granted folder leases canonically', async () => {
		mockAcquire();
		await checkoutFolder('f1');
		expect(isCheckedOutByMe('folder:f1')).toBe(true);
	});
});

describe('three-buffer commit ordering', () => {
	it('commitStaged sends model+artifact+view ops in that order', async () => {
		mockAcquire();
		await checkoutAndEditElement();
		stageArtifactUpdate('a9', { name: 'renamed' });
		await checkoutFolder('f1');
		const viewOp: ViewOp = { kind: 'rename_folder', id: 'f1', name: 'New name' };
		stageViewOp(viewOp, 'Rename folder');

		const preview = vi.spyOn(api, 'previewCommit').mockResolvedValue({
			conformance_error_count: 0,
			structural_blockers: [],
			issues: [],
			would_block: false
		});
		await previewStaged();
		expect(preview.mock.calls[0][1]).toEqual([
			expect.objectContaining({ kind: 'update_element', id: 'e1' }),
			expect.objectContaining({ kind: 'update_artifact', id: 'a9', name: 'renamed' }),
			expect.objectContaining({ kind: 'rename_folder', id: 'f1', name: 'New name' })
		]);

		const commit = vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());
		const viewCommitted = vi.fn();
		const off = onViewCommitted(viewCommitted);

		await commitStaged('m', false);
		off();

		expect(commit.mock.calls[0][0].ops).toEqual([
			expect.objectContaining({ kind: 'update_element', id: 'e1' }),
			expect.objectContaining({ kind: 'update_artifact', id: 'a9', name: 'renamed' }),
			expect.objectContaining({ kind: 'rename_folder', id: 'f1', name: 'New name' })
		]);
		// clearStagedView ran: the journal is empty post-commit.
		expect(getStagedViewOps()).toEqual([]);
		// the batch carried view ops -> notifyViewCommitted fired.
		expect(viewCommitted).toHaveBeenCalledOnce();
	});

	it('does not fire notifyViewCommitted for a model-only commit', async () => {
		mockAcquire();
		await checkoutAndEditElement();
		vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());
		const viewCommitted = vi.fn();
		const off = onViewCommitted(viewCommitted);

		await commitStaged('m', false);
		off();

		expect(viewCommitted).not.toHaveBeenCalled();
	});
});

describe('commit-time token partition: folder tokens ride the element rule', () => {
	it('sends a folder token the batch does not need; keeps an unneeded artifact-only token', async () => {
		mockAcquire();
		await checkoutAndEditElement(); // token t_el_e1, staged update_element e1 (keeps ops non-empty)
		await checkoutFolder('f1'); // token t_folder_f1, nothing staged that needs f1
		await ensureCheckout([{ resource_id: 'a9', mode: 'exclusive', type: 'artifact' }], 'edit'); // token t_art_a9
		openArtifactTab('table', { artifactId: 'a9', title: 'T' }); // keeps the artifact editor "open"
		const commit = vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());

		await commitStaged('m', false);

		// Folder tokens are not artifact-only, so the token partition's
		// `artifactOnly && unneeded` keep clause never matches them: they are
		// always sent, deliberately, even when the batch does not name their
		// folder — folders follow the element rule, not the artifact
		// keep-open rule.
		expect(commit.mock.calls[0][0].lockTokens.sort()).toEqual(['t_el_e1', 't_folder_f1']);
		// the still-open artifact editor's lease survives, exactly as before.
		expect(getHeldTokens()).toEqual(['t_art_a9']);
		expect(isCheckedOutByMe('folder:f1')).toBe(false);
		expect(isCheckedOutByMe('art:a9')).toBe(true);
	});
});

describe('releaseFolderLeaseIfUnneeded', () => {
	it('keeps the lease while a staged view op still needs it, releases once the journal clears', async () => {
		mockAcquire();
		await checkoutFolder('f1');
		stageViewOp({ kind: 'rename_folder', id: 'f1', name: 'New' }, 'Rename folder');
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await releaseFolderLeaseIfUnneeded('f1');
		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('folder:f1')).toBe(true);

		resetViewEdits(); // journal cleared (discard path)
		await releaseFolderLeaseIfUnneeded('f1');
		expect(release).toHaveBeenCalledWith('t_folder_f1', undefined);
		expect(isCheckedOutByMe('folder:f1')).toBe(false);
	});

	it('is a no-op for a folder I hold no lease on', async () => {
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);
		await releaseFolderLeaseIfUnneeded('nope');
		expect(release).not.toHaveBeenCalled();
	});
});

describe('lockedResourcesNeededBy covers the view op family', () => {
	const cases: [string, ViewOp][] = [
		[
			'create_folder names its parent',
			{ kind: 'create_folder', temp_id: 'tmp_f2', parent_id: 'f1', name: 'x' }
		],
		['rename_folder names itself', { kind: 'rename_folder', id: 'f1', name: 'x' }],
		['delete_folder names itself', { kind: 'delete_folder', id: 'f1' }],
		['move_folder names its destination', { kind: 'move_folder', id: 'f9', to_parent_id: 'f1' }],
		[
			'place_element names its folder',
			{ kind: 'place_element', element_id: 'e1', folder_id: 'f1' }
		],
		[
			'remove_element names its folder',
			{ kind: 'remove_element', element_id: 'e1', folder_id: 'f1' }
		],
		[
			'move_element names its destination folder',
			{ kind: 'move_element', element_id: 'e1', from_folder_id: 'f9', to_folder_id: 'f1' }
		],
		[
			'place_artifact names its folder',
			{ kind: 'place_artifact', artifact_id: 'a1', artifact_kind: 'table', folder_id: 'f1' }
		],
		[
			'remove_artifact names its folder',
			{ kind: 'remove_artifact', artifact_id: 'a1', folder_id: 'f1' }
		],
		[
			'move_artifact names its destination folder',
			{ kind: 'move_artifact', artifact_id: 'a1', from_folder_id: 'f9', to_folder_id: 'f1' }
		]
	];

	it.each(cases)('%s -> f1 stays locked', async (_label, op) => {
		mockAcquire();
		await checkoutFolder('f1');
		stageViewOp(op, 'op');
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await releaseFolderLeaseIfUnneeded('f1');

		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('folder:f1')).toBe(true);
	});

	it("move_folder's SOURCE container is not named by the op (token-granularity covers it)", async () => {
		mockAcquire();
		await checkoutFolder('f9'); // the source container of the move below
		stageViewOp({ kind: 'move_folder', id: 'f1', to_parent_id: 'f2' }, 'move');
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		// f9 (the source) is not named by lockedResourcesNeededBy for this op, so
		// releaseFolderLeaseIfUnneeded('f9') releases it -- the source's lease
		// rides the same gesture token as the destination, not this op's needed set.
		await releaseFolderLeaseIfUnneeded('f9');
		expect(release).toHaveBeenCalledWith('t_folder_f9', undefined);
	});
});

describe('discardAll wipes the view journal', () => {
	it('clears staged view ops', async () => {
		mockAcquire();
		await checkoutFolder('f1');
		stageViewOp({ kind: 'rename_folder', id: 'f1', name: 'x' }, 'Rename folder');
		vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await discardAll();

		expect(getStagedViewOps()).toEqual([]);
	});

	it('folder leases are never kept open (dialogs are transient)', async () => {
		mockAcquire();
		await checkoutFolder('f1');
		stageViewOp({ kind: 'rename_folder', id: 'f1', name: 'x' }, 'Rename folder');
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await discardAll();

		expect(release).toHaveBeenCalledWith('t_folder_f1', undefined);
		expect(getHeldTokens()).toEqual([]);
	});

	// `discardAll` must not just wipe the journal and stop there. The view
	// store's optimistic applies are BAKED INTO its `_view`, so without a
	// refetch the sidebar would keep showing folders/renames/placements that
	// are no longer staged and do not exist on the server — and the next
	// gesture would stage against that phantom tree, 422ing at commit.
	// `discardStagedView` owns the refetch (it fires the view store's discard
	// listener), so every discard surface gets it.
	it('refetches GET /view so `_view` stops showing the discarded ops', async () => {
		mockAcquire();
		vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);
		const server: View = {
			name: 'v',
			folders: [{ id: 'f1', name: 'Original', folders: [], elements: [], artifacts: [] }],
			artifacts: []
		};
		const getSpy = vi.spyOn(viewApi, 'getView').mockResolvedValue({ view: server, warnings: [] });
		await refreshView();
		vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
		await stageRenameFolder('f1', 'Optimistic');
		expect(getView()!.folders[0].name).toBe('Optimistic'); // baked in
		getSpy.mockClear();

		await discardAll();

		expect(getSpy).toHaveBeenCalled();
		expect(getStagedViewOps()).toEqual([]);
		expect(getView()!.folders[0].name).toBe('Original'); // reconciled to server truth
	});
});

describe('releaseArtifactIfUnneeded / discardArtifact honor the three-buffer union', () => {
	/** A single mixed token covering both `art:a9` and `folder:f1` — not
	 * something the UI produces today (see `checkout.artifact.test.ts`'s
	 * "sends a mixed token" test for the model+artifact analogue), but the
	 * stillNeeded computation must union in the view buffer to see it. */
	function mockMixedTokenAcquire() {
		return vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 'tMix',
			leases: [
				{
					resource_id: 'art:a9',
					mode: 'exclusive',
					holder: 'default-user',
					token: 'tMix',
					intent: 'edit',
					expires_at: 1
				},
				{
					resource_id: 'folder:f1',
					mode: 'exclusive',
					holder: 'default-user',
					token: 'tMix',
					intent: 'edit',
					expires_at: 1
				}
			]
		});
	}

	it('releaseArtifactIfUnneeded keeps a mixed token a staged view op still needs', async () => {
		mockMixedTokenAcquire();
		await ensureCheckout(
			[
				{ resource_id: 'a9', mode: 'exclusive', type: 'artifact' },
				{ resource_id: 'f1', mode: 'exclusive', type: 'folder' }
			],
			'edit'
		);
		stageViewOp({ kind: 'rename_folder', id: 'f1', name: 'x' }, 'Rename folder');
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await releaseArtifactIfUnneeded('a9');

		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('art:a9')).toBe(true);
		expect(isCheckedOutByMe('folder:f1')).toBe(true);
	});

	it('discardArtifact keeps a mixed token a staged view op still needs', async () => {
		mockMixedTokenAcquire();
		await ensureCheckout(
			[
				{ resource_id: 'a9', mode: 'exclusive', type: 'artifact' },
				{ resource_id: 'f1', mode: 'exclusive', type: 'folder' }
			],
			'edit'
		);
		stageArtifactUpdate('a9', { name: 'renamed' });
		stageViewOp({ kind: 'rename_folder', id: 'f1', name: 'x' }, 'Rename folder');
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await discardArtifact('a9');

		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('folder:f1')).toBe(true);
	});
});
