import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import * as viewApi from '$lib/api/view';
import type { ArtifactHeader, View } from '$lib/api/types';
import {
	getArtifactHeaders,
	getCommittedArtifactHeaders,
	artifactHeaderById,
	loadArtifacts,
	referenceableArtifactHeaders,
	removeArtifact,
	renameArtifact,
	resetArtifacts
} from '../artifacts.svelte';
import {
	getStagedArtifactEntries,
	notifyArtifactCommit,
	stageArtifactCreate,
	stageArtifactUpdate,
	stagedArtifactState
} from '../artifact-edits.svelte';
import { resetCheckout, setProjectInfo } from '../checkout.svelte';
import { clearViewState, getView, pushView } from '../view.svelte';

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 2,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: null,
	entry_points: null
};

const TABLE_HEADER = {
	id: 't1',
	kind: 'table',
	name: 'Buildings table',
	artifact_rev: 1,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: null,
	entry_points: null
};

/** Mirror of the backend's lock canonicalization: targets go out with the bare
 * id + `type: "artifact"`, leases come back keyed `art:<id>`. */
function mockAcquire() {
	return vi.spyOn(checkoutApi, 'acquireLocks').mockImplementation(async (req) => {
		const token = `t_${req.targets[0].resource_id}`;
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

function mockAcquireConflict() {
	return vi.spyOn(checkoutApi, 'acquireLocks').mockImplementation(async () => {
		const { ConflictError } = await import('$lib/api/errors');
		throw new ConflictError(
			409,
			{ conflicts: [{ resource_id: 'art:a1', held_by: 'bob', held_mode: 'exclusive' }] },
			'lock conflict'
		);
	});
}

/** A view that places `a1` twice (nested folder + parent folder). */
function viewPlacing(id: string): View {
	return {
		name: 'v',
		folders: [
			{
				name: 'F',
				folders: [
					{ name: 'G', folders: [], elements: [], artifacts: [{ id, kind: 'navigation' }] }
				],
				elements: [],
				artifacts: [{ id, kind: 'navigation' }]
			}
		],
		artifacts: []
	};
}

beforeEach(() => {
	resetArtifacts();
	resetCheckout();
	clearViewState();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});
afterEach(() => {
	resetCheckout(); // stops the heartbeat interval a granted lease starts
	vi.restoreAllMocks();
});

describe('artifacts store', () => {
	it('loads headers', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		expect(getArtifactHeaders()).toEqual([HEADER]);
	});

	it('getArtifactHeaders separates table headers from navigation headers by kind', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER, TABLE_HEADER] });
		await loadArtifacts();
		const navigations = getArtifactHeaders().filter((a) => a.kind === 'navigation');
		const tables = getArtifactHeaders().filter((a) => a.kind === 'table');
		expect(navigations).toEqual([HEADER]);
		expect(tables).toEqual([TABLE_HEADER]);
	});
});

describe('staged overlay', () => {
	it('getArtifactHeaders applies the staged overlay', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER, TABLE_HEADER] });
		await loadArtifacts();
		stageArtifactUpdate('a1', { name: 'Sensors v2' });
		stageArtifactCreate('table', 'Draft table', { schema_version: 1 }, 'tbl:draft:1');

		const shown = getArtifactHeaders();
		expect(shown.map((h) => h.name)).toEqual(['Sensors v2', 'Buildings table', 'Draft table']);
		// server truth is untouched — the overlay is a display projection
		expect(getCommittedArtifactHeaders()).toEqual([HEADER, TABLE_HEADER]);
	});

	it('hides a staged-deleted artifact from getArtifactHeaders', async () => {
		mockAcquire();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER, TABLE_HEADER] });
		await loadArtifacts();
		await removeArtifact('a1');
		expect(getArtifactHeaders().map((h) => h.id)).toEqual(['t1']);
		expect(getCommittedArtifactHeaders().map((h) => h.id)).toEqual(['a1', 't1']);
	});

	it('artifactHeaderById resolves staged creates and staged renames', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		stageArtifactUpdate('a1', { name: 'Sensors v2' });
		const tempId = stageArtifactCreate('navigation', 'Draft nav', {}, 'nav:draft:1');
		expect(artifactHeaderById('a1')?.name).toBe('Sensors v2');
		expect(artifactHeaderById(tempId)?.name).toBe('Draft nav');
		expect(artifactHeaderById(tempId)?.kind).toBe('navigation');
	});
});

describe('referenceableArtifactHeaders', () => {
	it('omits staged creates — a temp id can never be persisted inside a payload', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		const tempId = stageArtifactCreate('navigation', 'Draft nav', {}, 'nav:draft:1');

		// The overlay (what the sidebar renders) shows it...
		expect(getArtifactHeaders().map((h) => h.id)).toEqual(['a1', tempId]);
		// ...but a ref picker must not offer an id that could commit as a
		// dangling string. The backend resolves temp ids inside payloads only
		// against creates ALREADY applied in the same batch, and the create may
		// also be reverted before commit — see `referenceableArtifactHeaders`.
		expect(referenceableArtifactHeaders('navigation').map((h) => h.id)).toEqual(['a1']);
	});

	it('keeps staged renames, under the staged name', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		stageArtifactUpdate('a1', { name: 'Sensors v2' });
		// The id is real and persistable — only the label changed.
		expect(referenceableArtifactHeaders('navigation')).toEqual([{ ...HEADER, name: 'Sensors v2' }]);
	});

	it('omits staged deletes and filters by kind', async () => {
		mockAcquire();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER, TABLE_HEADER] });
		await loadArtifacts();
		expect(referenceableArtifactHeaders('table')).toEqual([TABLE_HEADER]);
		await removeArtifact('t1');
		expect(referenceableArtifactHeaders('table')).toEqual([]);
	});
});

describe('renameArtifact', () => {
	it('stages a name-only update after acquiring the edit lease', async () => {
		const acquire = mockAcquire();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();

		await renameArtifact('a1', 'N2');

		expect(acquire.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'a1', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
		expect(getStagedArtifactEntries()).toEqual([
			{ kind: 'update', id: 'a1', name: 'N2', payload: undefined, header: null }
		]);
		expect(stagedArtifactState('a1')).toBe('edited');
		expect(getArtifactHeaders()[0].name).toBe('N2');
	});

	it('refuses without staging when the lease is denied', async () => {
		mockAcquireConflict();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();

		await renameArtifact('a1', 'N2');

		expect(getStagedArtifactEntries()).toEqual([]);
		expect(getArtifactHeaders()[0].name).toBe('Sensors');
	});

	it('folds into a staged create without any lock call', async () => {
		const acquire = mockAcquire();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [] });
		await loadArtifacts();
		const tempId = stageArtifactCreate('navigation', 'Draft nav', { a: 1 }, 'nav:draft:1');

		await renameArtifact(tempId, 'Renamed draft');

		expect(acquire).not.toHaveBeenCalled();
		expect(getStagedArtifactEntries()).toEqual([
			{
				kind: 'create',
				tempId,
				artifactKind: 'navigation',
				name: 'Renamed draft',
				payload: { a: 1 },
				sourceTabId: 'nav:draft:1'
			}
		]);
	});

	it('throws on an unknown artifact without acquiring anything', async () => {
		const acquire = mockAcquire();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		await expect(renameArtifact('nope', 'X')).rejects.toThrow('Unknown artifact nope');
		expect(acquire).not.toHaveBeenCalled();
	});
});

describe('removeArtifact', () => {
	it('reverts a staged create without any lock call', async () => {
		const acquire = mockAcquire();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [] });
		await loadArtifacts();
		const tempId = stageArtifactCreate('table', 'Draft table', {}, 'tbl:draft:1');

		await removeArtifact(tempId);

		expect(acquire).not.toHaveBeenCalled();
		expect(getStagedArtifactEntries()).toEqual([]);
		expect(getArtifactHeaders()).toEqual([]);
	});

	it('stages a delete under a delete-intent lease and leaves the view unscrubbed', async () => {
		const acquire = mockAcquire();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		const put = vi
			.spyOn(viewApi, 'putViewSnapshot')
			.mockImplementation(async (v) => ({ view: v, warnings: [] }));
		await pushView(viewPlacing('a1'));
		put.mockClear();

		await removeArtifact('a1');

		expect(acquire.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'a1', mode: 'exclusive', type: 'artifact' }],
			intent: 'delete'
		});
		expect(getStagedArtifactEntries()).toEqual([{ kind: 'delete', id: 'a1', header: HEADER }]);
		// The artifact still exists server-side until the commit lands, so its
		// view placements must survive a discard — no scrub push here.
		expect(put).not.toHaveBeenCalled();
		expect(getView()!.folders[0].artifacts).toEqual([{ id: 'a1', kind: 'navigation' }]);
	});

	it('records the COMMITTED header on the delete entry, not a staged rename', async () => {
		mockAcquire();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		await renameArtifact('a1', 'Never committed');

		await removeArtifact('a1');

		// The delete entry's `header` is the DiffDrawer's display source; showing
		// the uncommitted rename there would name the artifact something the
		// server never saw.
		expect(getStagedArtifactEntries()).toEqual([{ kind: 'delete', id: 'a1', header: HEADER }]);
	});

	it('refuses without staging when the delete lease is denied', async () => {
		mockAcquireConflict();
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();

		await removeArtifact('a1');

		expect(getStagedArtifactEntries()).toEqual([]);
		expect(getArtifactHeaders()).toEqual([HEADER]);
	});

	it('releases the delete lease when the artifact vanished before it could be staged', async () => {
		mockAcquire();
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();

		// A stale sidebar row (a peer's delete landed between render and click):
		// the DELETE-intent exclusive conflicts with ANY peer lease, so stranding
		// it would block every other user for the full TTL.
		await removeArtifact('ghost');

		expect(getStagedArtifactEntries()).toEqual([]);
		expect(release).toHaveBeenCalledWith('t_ghost', undefined);
	});
});

describe('commit listener', () => {
	it('upserts changed headers, drops deleted ids and scrubs the view', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER, TABLE_HEADER] });
		await loadArtifacts();
		const put = vi
			.spyOn(viewApi, 'putViewSnapshot')
			.mockImplementation(async (v) => ({ view: v, warnings: [] }));
		await pushView(viewPlacing('t1'));
		put.mockClear();

		const renamed: ArtifactHeader = { ...HEADER, name: 'Sensors v2', artifact_rev: 3 };
		const created: ArtifactHeader = {
			id: 'n9',
			kind: 'navigation',
			name: 'Fresh',
			artifact_rev: 1,
			updated_at: '2026-08-06T00:00:00Z',
			updated_by: null,
			entry_points: null
		};
		notifyArtifactCommit({
			idMap: { tmp_x: 'n9' },
			changed: [renamed, created],
			deletedIds: ['t1']
		});

		expect(getCommittedArtifactHeaders()).toEqual([renamed, created]);
		// scrub is async (fire-and-forget); let the microtask queue drain
		await Promise.resolve();
		await Promise.resolve();
		expect(put).toHaveBeenCalledTimes(1);
		expect(getView()!.folders[0].artifacts).toEqual([]);
		expect(getView()!.folders[0].folders[0].artifacts).toEqual([]);
	});

	it('upserts a changed header IN PLACE and appends only genuinely new ids', async () => {
		const third = { ...TABLE_HEADER, id: 't2', name: 'Rooms table' };
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER, TABLE_HEADER, third] });
		await loadArtifacts();

		const renamed: ArtifactHeader = { ...HEADER, name: 'Sensors v2', artifact_rev: 3 };
		const created: ArtifactHeader = { ...TABLE_HEADER, id: 'n9', name: 'Fresh' };
		notifyArtifactCommit({ idMap: {}, changed: [renamed, created], deletedIds: [] });

		// A committed rename must keep its slot: appending would make the row jump
		// to the bottom of its sidebar section until the next feed refetch
		// happened to reorder it.
		expect(getCommittedArtifactHeaders()).toEqual([renamed, TABLE_HEADER, third, created]);
	});

	it('does not push the view when the commit deleted nothing this view placed', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		vi.spyOn(viewApi, 'putViewSnapshot').mockImplementation(async (v) => ({
			view: v,
			warnings: []
		}));
		await pushView(viewPlacing('a1'));
		const put = vi.spyOn(viewApi, 'putViewSnapshot');

		notifyArtifactCommit({ idMap: {}, changed: [], deletedIds: ['t1'] });
		await Promise.resolve();
		await Promise.resolve();
		expect(put).not.toHaveBeenCalled();
	});
});

describe('resetArtifacts', () => {
	it('clears the staged artifact buffer too', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		stageArtifactUpdate('a1', { name: 'N2' });
		resetArtifacts();
		expect(getStagedArtifactEntries()).toEqual([]);
		expect(getArtifactHeaders()).toEqual([]);
	});
});
