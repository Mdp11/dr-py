import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	commitStaged,
	discardAll,
	emit,
	ensureCheckout,
	getHeldTokens,
	getStagedArtifactOps,
	isCheckedOutByMe,
	onArtifactCommit,
	openArtifactTab,
	previewStaged,
	reacquireOpenArtifactLeases,
	releaseArtifactIfUnneeded,
	resetArtifactEdits,
	resetCheckout,
	resetModelStore,
	resetWorkspaceTabs,
	seedElements,
	setProjectInfo,
	stageArtifactUpdate
} from '../index';
import type { ArtifactCommitInfo } from '../index';
import * as api from '$lib/api/checkout';
import type { CommitResponse } from '$lib/api/types';

/**
 * Artifact half of the checkout store: canonical registry keys, mixed
 * model+artifact commit batches, and the commit-time token partition that lets
 * a still-open artifact editor keep its lease across a commit.
 */

/** Mirror of the backend's lock canonicalization: targets are SENT with the
 * bare id + type:"artifact", leases come back keyed `art:<id>`. */
function mockAcquire() {
	return vi.spyOn(api, 'acquireLocks').mockImplementation(async (req) => {
		const first = req.targets[0];
		const token =
			first.type === 'artifact' ? `t_art_${first.resource_id}` : `t_el_${first.resource_id}`;
		return {
			token,
			leases: req.targets.map((t) => ({
				resource_id: t.type === 'artifact' ? `art:${t.resource_id}` : t.resource_id,
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

/** Check out artifact `id` (token t_art_<id>). */
function checkoutArtifact(id: string) {
	return ensureCheckout([{ resource_id: id, mode: 'exclusive', type: 'artifact' }], 'edit');
}

beforeEach(() => {
	vi.useFakeTimers();
	resetModelStore();
	resetCheckout();
	resetArtifactEdits();
	resetWorkspaceTabs();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 100 }); // renew @ 50s
});
afterEach(() => vi.useRealTimers());

describe('artifact leases in the checkout registry', () => {
	it('keys granted artifact leases canonically and does not re-acquire on re-open', async () => {
		const acquire = mockAcquire();
		await checkoutArtifact('a9');
		expect(isCheckedOutByMe('art:a9')).toBe(true);
		// Re-opening the same artifact editor must be idempotent: alreadyHeld has
		// to canonicalize the bare target id to compare against the registry.
		await checkoutArtifact('a9');
		expect(acquire).toHaveBeenCalledTimes(1);
	});

	it('leaves element resource ids bare', async () => {
		mockAcquire();
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		expect(isCheckedOutByMe('e1')).toBe(true);
		expect(isCheckedOutByMe('art:e1')).toBe(false);
	});
});

describe('mixed model + artifact batches', () => {
	it('previewStaged and commitStaged append staged artifact ops after model ops', async () => {
		mockAcquire();
		await checkoutAndEditElement();
		stageArtifactUpdate('a9', { name: 'renamed' });

		const preview = vi.spyOn(api, 'previewCommit').mockResolvedValue({
			conformance_error_count: 0,
			structural_blockers: [],
			issues: [],
			would_block: false
		});
		await previewStaged();
		expect(preview.mock.calls[0][1]).toEqual([
			expect.objectContaining({ kind: 'update_element', id: 'e1' }),
			expect.objectContaining({ kind: 'update_artifact', id: 'a9', name: 'renamed' })
		]);

		const commit = vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());
		await commitStaged('m', false);
		expect(commit.mock.calls[0][0].ops).toEqual([
			expect.objectContaining({ kind: 'update_element', id: 'e1' }),
			expect.objectContaining({ kind: 'update_artifact', id: 'a9', name: 'renamed' })
		]);
	});

	it('commitStaged refuses an empty batch without calling the API', async () => {
		const commit = vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());
		await expect(commitStaged('msg', false)).rejects.toThrow(/nothing staged/i);
		expect(commit).not.toHaveBeenCalled();
	});
});

describe('commit-time token partition', () => {
	it('withholds an artifact-only token the batch does not need', async () => {
		mockAcquire();
		await checkoutAndEditElement(); // token t_el_e1, staged update_element e1
		await checkoutArtifact('a9'); // token t_art_a9, nothing staged for it
		const renew = vi.spyOn(api, 'renewLock').mockResolvedValue({ ok: true });
		const commit = vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());

		await commitStaged('m', false);

		// only the element token is surrendered; the open editor's lease survives
		expect(commit.mock.calls[0][0].lockTokens).toEqual(['t_el_e1']);
		expect(getHeldTokens()).toEqual(['t_art_a9']);
		expect(isCheckedOutByMe('art:a9')).toBe(true);
		expect(isCheckedOutByMe('e1')).toBe(false);

		// the heartbeat must keep renewing the withheld lease
		await vi.advanceTimersByTimeAsync(50_000);
		expect(renew).toHaveBeenCalledWith('t_art_a9', undefined);
	});

	it('sends and clears an artifact token whose artifact is in the batch', async () => {
		mockAcquire();
		await checkoutArtifact('a9');
		stageArtifactUpdate('a9', { name: 'renamed' });
		const renew = vi.spyOn(api, 'renewLock').mockResolvedValue({ ok: true });
		const commit = vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());

		await commitStaged('m', false);

		expect(commit.mock.calls[0][0].lockTokens).toEqual(['t_art_a9']);
		expect(getHeldTokens()).toEqual([]);
		expect(isCheckedOutByMe('art:a9')).toBe(false);

		// registry emptied -> heartbeat stopped
		await vi.advanceTimersByTimeAsync(200_000);
		expect(renew).not.toHaveBeenCalled();
	});

	it('sends a mixed token that covers even one needed resource', async () => {
		// One token co-acquires an element and an artifact (not something the UI
		// does today, but the partition rule is "artifact-only AND unneeded").
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 'tMix',
			leases: [
				{
					resource_id: 'e1',
					mode: 'exclusive',
					holder: 'default-user',
					token: 'tMix',
					intent: 'edit',
					expires_at: 1
				},
				{
					resource_id: 'art:a9',
					mode: 'exclusive',
					holder: 'default-user',
					token: 'tMix',
					intent: 'edit',
					expires_at: 1
				}
			]
		});
		await ensureCheckout(
			[
				{ resource_id: 'e1', mode: 'exclusive' },
				{ resource_id: 'a9', mode: 'exclusive', type: 'artifact' }
			],
			'edit'
		);
		stageArtifactUpdate('a9', { name: 'renamed' });
		const commit = vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());

		await commitStaged('m', false);

		expect(commit.mock.calls[0][0].lockTokens).toEqual(['tMix']);
		expect(getHeldTokens()).toEqual([]);
	});
});

describe('artifact delta', () => {
	it('clears the artifact stage and notifies listeners with id_map + headers', async () => {
		mockAcquire();
		stageArtifactUpdate('a9', { name: 'renamed' });
		const header = {
			id: 'a9',
			kind: 'table',
			name: 'renamed',
			artifact_rev: 3,
			updated_at: 'now',
			updated_by: null,
			entry_points: null
		};
		vi.spyOn(api, 'commitChanges').mockResolvedValue(
			commitResponse({
				id_map: { tmp_x: 'a10' },
				changed_artifacts: [header],
				deleted_artifact_ids: ['a7']
			})
		);
		const seen: ArtifactCommitInfo[] = [];
		const off = onArtifactCommit((info) => seen.push(info));

		await commitStaged('m', false);
		off();

		expect(getStagedArtifactOps()).toEqual([]);
		expect(seen).toEqual([{ idMap: { tmp_x: 'a10' }, changed: [header], deletedIds: ['a7'] }]);
	});
});

describe('releaseArtifactIfUnneeded', () => {
	it('releases the lease when nothing staged needs it', async () => {
		mockAcquire();
		await checkoutArtifact('a9');
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await releaseArtifactIfUnneeded('a9');

		expect(release).toHaveBeenCalledWith('t_art_a9', undefined);
		expect(isCheckedOutByMe('art:a9')).toBe(false);
	});

	it('keeps the lease while a staged artifact op still needs it', async () => {
		mockAcquire();
		await checkoutArtifact('a9');
		stageArtifactUpdate('a9', { name: 'renamed' });
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await releaseArtifactIfUnneeded('a9');

		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('art:a9')).toBe(true);
	});

	it('is a no-op for an artifact I hold no lease on', async () => {
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);
		await releaseArtifactIfUnneeded('nope');
		expect(release).not.toHaveBeenCalled();
	});
});

describe('discardAll', () => {
	it('keeps the lease of an artifact still open in an editor tab', async () => {
		mockAcquire();
		await checkoutAndEditElement();
		await checkoutArtifact('a9');
		stageArtifactUpdate('a9', { name: 'renamed' });
		openArtifactTab('table', { artifactId: 'a9', title: 'T' });
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await discardAll();

		expect(getStagedArtifactOps()).toEqual([]);
		expect(release).toHaveBeenCalledWith('t_el_e1', undefined);
		expect(release).not.toHaveBeenCalledWith('t_art_a9', undefined);
		expect(getHeldTokens()).toEqual(['t_art_a9']);
	});

	it('releases an artifact lease whose editor tab is closed', async () => {
		mockAcquire();
		await checkoutArtifact('a9');
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		await discardAll();

		expect(release).toHaveBeenCalledWith('t_art_a9', undefined);
		expect(getHeldTokens()).toEqual([]);
	});
});

describe('reacquireOpenArtifactLeases', () => {
	it('re-checks-out open tabs, skipping drafts and already-held artifacts', async () => {
		const acquire = mockAcquire();
		await checkoutArtifact('held');
		openArtifactTab('table', { artifactId: 'held', title: 'held' });
		openArtifactTab('navigation', { artifactId: 'a9', title: 'a9' });
		openArtifactTab('snippet', { artifactId: null, title: 'draft' });
		acquire.mockClear();

		const denied: [string, string][] = [];
		await reacquireOpenArtifactLeases((tabId, holder) => denied.push([tabId, holder]));

		expect(acquire).toHaveBeenCalledTimes(1);
		expect(acquire.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'a9', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
		expect(denied).toEqual([]);
		expect(isCheckedOutByMe('art:a9')).toBe(true);
	});

	it('reports the holder of an artifact someone else took', async () => {
		const { ConflictError } = await import('$lib/api/errors');
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(
			new ConflictError(
				409,
				{
					conflicts: [
						{
							resource_id: 'art:a9',
							held_by: 'bob-uuid',
							held_by_email: 'bob@x.io',
							held_mode: 'exclusive'
						}
					]
				},
				'lock conflict'
			)
		);
		const tabId = openArtifactTab('table', { artifactId: 'a9', title: 'a9' });

		const denied: [string, string][] = [];
		await reacquireOpenArtifactLeases((t, holder) => denied.push([t, holder]));

		expect(denied).toEqual([[tabId, 'bob@x.io']]);
	});

	it('does nothing for a viewer', async () => {
		setProjectInfo({ role: 'viewer', lockTtlSeconds: 100 });
		const acquire = mockAcquire();
		openArtifactTab('table', { artifactId: 'a9', title: 'a9' });
		await reacquireOpenArtifactLeases(() => {});
		expect(acquire).not.toHaveBeenCalled();
	});
});
