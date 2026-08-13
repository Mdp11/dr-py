import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import type { ArtifactHeader, TableDefinition } from '$lib/api/types';
import {
	addExportEntry,
	closeCustomExportDraft,
	ensureCustomExportDraft,
	getCustomExportDraft,
	getCustomExportLockHolder,
	hasDirtyCustomExportDrafts,
	moveExportEntryInList,
	removeExportEntry,
	resetCustomExportEditors,
	saveCustomExportDraft,
	setCustomExportName,
	updateExportEntry
} from '../custom-export-editor.svelte';
import { getDynamicTabs, openArtifactTab, resetWorkspaceTabs } from '../workspace.svelte';
import { loadArtifacts, resetArtifacts } from '../artifacts.svelte';
import {
	getStagedArtifactOps,
	notifyArtifactCommit,
	resetArtifactEdits,
	revertStagedArtifact,
	stageArtifactDelete
} from '../artifact-edits.svelte';
import { isCheckedOutByMe, resetCheckout, setProjectInfo } from '../checkout.svelte';
import { isTempId } from '../ops';

const CUSTOM_EXPORT_ARTIFACT = {
	id: 'e1',
	kind: 'custom_export',
	name: 'My export',
	artifact_rev: 3,
	updated_at: '2026-07-17T00:00:00Z',
	updated_by: 'u1',
	entry_points: null,
	payload: {
		schema_version: 1,
		entries: [
			{
				source: { ref: 'tbl-1' },
				name: 'Alpha',
				format: 'xlsx',
				columns: [],
				export_order: [],
				show_row_numbers: false,
				export_row_number: null,
				json_split: null
			}
		]
	}
};

const TABLE_DEFN: TableDefinition = {
	schema_version: 1,
	row_source: { kind: 'scope', types: ['Sensor'], criteria: [] },
	columns: [
		{
			kind: 'element',
			source: { kind: 'row', chain_index: 0 },
			header: '',
			width_px: null,
			hidden: false,
			json_export: null,
			export: null
		}
	],
	default_cell_mode: 'collapse',
	show_row_numbers: false,
	export_order: [],
	export_row_number: null,
	json_split: null
};

function header(id: string, name: string, rev = 1): ArtifactHeader {
	return {
		id,
		kind: 'custom_export',
		name,
		artifact_rev: rev,
		updated_at: '',
		updated_by: null,
		entry_points: null
	};
}

/** Mirror of the backend's lock canonicalization: targets go out with the bare
 * id + `type: "artifact"`, leases come back keyed `art:<id>` under one token. */
function mockAcquire() {
	return vi.spyOn(checkoutApi, 'acquireLocks').mockImplementation(async (req) => {
		const token = `t_${req.targets[0].resource_id}`;
		return {
			token,
			leases: req.targets.map((t) => ({
				resource_id: t.type === 'artifact' ? `art:${t.resource_id}` : t.resource_id,
				mode: t.mode,
				holder: 'me',
				token,
				intent: req.intent,
				expires_at: 1
			}))
		};
	});
}

/** What POST /locks throws when a peer holds the artifact. */
function lockConflict(email: string): ConflictError {
	return new ConflictError(
		409,
		{
			conflicts: [
				{ resource_id: 'art:e1', held_by: 'u2', held_by_email: email, held_mode: 'exclusive' }
			]
		},
		'lock conflict'
	);
}

/** The checked-out-editor path: the default role after `resetCheckout` is
 * viewer, which short-circuits the lease open before any network call. */
function asEditor() {
	setProjectInfo({ role: 'editor', lockTtlSeconds: 100 });
}

beforeEach(() => {
	resetCustomExportEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetArtifactEdits();
	resetCheckout();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
});
afterEach(() => {
	resetCustomExportEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	vi.restoreAllMocks();
});

describe('custom export drafts', () => {
	it('a draft tab starts empty and add copies the table settings', async () => {
		const tabId = openArtifactTab('custom_export', { artifactId: null, title: 'New export' });
		await ensureCustomExportDraft(tabId);
		expect(getCustomExportDraft(tabId)?.entries).toEqual([]);
		expect(hasDirtyCustomExportDrafts()).toBe(false);

		addExportEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);

		const d = getCustomExportDraft(tabId)!;
		expect(d.entries).toHaveLength(1);
		expect(d.entries[0].name).toBe('Alpha');
		expect(d.entries[0].source.ref).toBe('tbl-1');
		expect(d.dirty).toBe(true);
	});

	it('add copies the table definition — later edits to either do not follow the other', async () => {
		const tabId = 'exp:draft:1';
		await ensureCustomExportDraft(tabId);
		const defn = { ...TABLE_DEFN };
		addExportEntry(tabId, 'tbl-1', 'Alpha', defn);
		defn.show_row_numbers = true; // mutate the source AFTER the copy-at-add moment

		const entry = getCustomExportDraft(tabId)!.entries[0];
		expect(entry.show_row_numbers).toBe(false); // unaffected by the later mutation
	});

	it('add copies a column export object — mutating the source column IN PLACE after add does not leak into the entry', async () => {
		// Defends copy-at-add at the OBJECT level, not just the scalar/array
		// level the test above covers: entryForTable's entry is STAGED and
		// PERSISTED, so overridesFromDefinition ($lib/table/custom-export.ts)
		// must clone col.export/col.json_export rather than alias them.
		const tabId = 'exp:draft:1';
		await ensureCustomExportDraft(tabId);
		const defn: TableDefinition = {
			...TABLE_DEFN,
			columns: [
				{
					...TABLE_DEFN.columns[0],
					export: { include: true, header: 'Original' }
				}
			]
		};

		addExportEntry(tabId, 'tbl-1', 'Alpha', defn);
		defn.columns[0].export!.header = 'Mutated'; // in-place mutation, not a replace

		const entry = getCustomExportDraft(tabId)!.entries[0];
		expect(entry.columns[0].export?.header).toBe('Original'); // unaffected
	});

	it('removeExportEntry drops the entry at the given index and dirties the draft', async () => {
		const tabId = 'exp:draft:1';
		await ensureCustomExportDraft(tabId);
		addExportEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);
		addExportEntry(tabId, 'tbl-2', 'Beta', TABLE_DEFN);

		removeExportEntry(tabId, 0);

		const d = getCustomExportDraft(tabId)!;
		expect(d.entries).toHaveLength(1);
		expect(d.entries[0].name).toBe('Beta');
	});

	it('moveExportEntryInList reorders entries', async () => {
		const tabId = 'exp:draft:1';
		await ensureCustomExportDraft(tabId);
		addExportEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);
		addExportEntry(tabId, 'tbl-2', 'Beta', TABLE_DEFN);

		moveExportEntryInList(tabId, 0, 1);

		const names = getCustomExportDraft(tabId)!.entries.map((e) => e.name);
		expect(names).toEqual(['Beta', 'Alpha']);
	});

	it('updateExportEntry patches the entry at the given index', async () => {
		const tabId = 'exp:draft:1';
		await ensureCustomExportDraft(tabId);
		addExportEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);

		updateExportEntry(tabId, 0, { format: 'json' });

		expect(getCustomExportDraft(tabId)!.entries[0].format).toBe('json');
	});

	it('a fresh never-saved draft does not count as dirty until edited', async () => {
		const tabId = 'exp:draft:9';
		await ensureCustomExportDraft(tabId);
		expect(hasDirtyCustomExportDrafts()).toBe(false);
		setCustomExportName(tabId, 'Named');
		expect(hasDirtyCustomExportDrafts()).toBe(true);
	});

	it('loads a saved artifact draft and parses its payload through the schema', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);
		const tabId = openArtifactTab('custom_export', { artifactId: 'e1', title: 'My export' });

		await ensureCustomExportDraft(tabId);

		const d = getCustomExportDraft(tabId)!;
		expect(d.artifactId).toBe('e1');
		expect(d.artifactRev).toBe(3);
		expect(d.entries).toHaveLength(1);
		expect(d.entries[0].source.ref).toBe('tbl-1');
		expect(d.dirty).toBe(false);
	});

	it('a malformed payload fails OPEN with an empty entry list instead of throwing', async () => {
		// The wire payload is parsed through CustomExportDefinitionSchema, but
		// the parse must never THROW: this module's only caller is a
		// fire-and-forget `$effect` (see ensureCustomExportDraft's comment), so
		// an unhandled rejection here would strand the tab on "Loading…" forever
		// exactly like an unguarded lease/fetch rejection would.
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			...CUSTOM_EXPORT_ARTIFACT,
			payload: { schema_version: 1, entries: 'not-an-array' } // malformed
		});
		const tabId = openArtifactTab('custom_export', { artifactId: 'e1', title: 'My export' });

		await expect(ensureCustomExportDraft(tabId)).resolves.toBeUndefined();

		const d = getCustomExportDraft(tabId)!;
		expect(d.artifactId).toBe('e1'); // the tab still opens, name/rev intact
		expect(d.entries).toEqual([]); // degrades to empty rather than refusing
		expect(d.dirty).toBe(false);
	});

	it('close drops the draft', async () => {
		const tabId = openArtifactTab('custom_export', { artifactId: null, title: 'New export' });
		await ensureCustomExportDraft(tabId);
		closeCustomExportDraft(tabId);
		expect(getCustomExportDraft(tabId)).toBeUndefined();
	});
});

describe('saving a custom export draft', () => {
	it('saving a new draft stages a create and repoints the tab', async () => {
		const tabId = openArtifactTab('custom_export', { artifactId: null, title: 'New export' });
		await ensureCustomExportDraft(tabId);
		addExportEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);
		setCustomExportName(tabId, 'Release drop');

		saveCustomExportDraft(tabId);

		const ops = getStagedArtifactOps();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			kind: 'create_artifact',
			artifact_kind: 'custom_export',
			name: 'Release drop'
		});
		const draft = getCustomExportDraft(tabId)!;
		expect(draft.dirty).toBe(false);
		expect(isTempId(draft.artifactId!)).toBe(true);
		// The tab KEY is NOT re-keyed at stage time.
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBe(draft.artifactId);
	});

	it('saving a saved artifact draft stages a full-payload update', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);
		const tabId = openArtifactTab('custom_export', { artifactId: 'e1', title: 'My export' });
		await ensureCustomExportDraft(tabId);
		setCustomExportName(tabId, 'Renamed');

		saveCustomExportDraft(tabId);

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'update_artifact',
				id: 'e1',
				name: 'Renamed',
				payload: { schema_version: 1, entries: CUSTOM_EXPORT_ARTIFACT.payload.entries }
			}
		]);
		expect(getCustomExportDraft(tabId)?.dirty).toBe(false);
	});

	it('saveCustomExportDraft refuses a name another custom export already uses', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [header('e2', 'Taken')]
		});
		await loadArtifacts();
		const tabId = openArtifactTab('custom_export', { artifactId: null, title: 'New export' });
		await ensureCustomExportDraft(tabId);
		setCustomExportName(tabId, 'Taken');

		expect(() => saveCustomExportDraft(tabId)).toThrow(
			/custom export named "Taken" already exists/
		);
		expect(getStagedArtifactOps()).toEqual([]);
		expect(getCustomExportDraft(tabId)?.artifactId).toBeNull();
		expect(getCustomExportDraft(tabId)?.dirty).toBe(true);
	});
});

describe('artifact lease on open', () => {
	it('acquires the art: lease before fetching the payload', async () => {
		asEditor();
		const acquire = mockAcquire();
		const get = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);

		await ensureCustomExportDraft('exp:e1');

		expect(acquire.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'e1', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
		expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
		expect(get).toHaveBeenCalledWith('e1');
		expect(isCheckedOutByMe('art:e1')).toBe(true);
		expect(getCustomExportLockHolder('exp:e1')).toBeUndefined();
	});

	it('opening a saved artifact acquires the lease and hydrates entries', async () => {
		asEditor();
		const acquireSpy = mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);

		await ensureCustomExportDraft('exp:e1');

		expect(acquireSpy).toHaveBeenCalled();
		const d = getCustomExportDraft('exp:e1')!;
		expect(d.artifactId).toBe('e1');
		expect(d.entries[0].source.ref).toBe('tbl-1');
		expect(d.dirty).toBe(false);
	});

	it('a lease conflict marks the tab read-only', async () => {
		asEditor();
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(lockConflict('ada@example.com'));
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);

		await ensureCustomExportDraft('exp:e1');

		expect(getCustomExportLockHolder('exp:e1')).toBe('ada@example.com');
		// A denial must not refuse the tab — it opens unsaveable with the banner.
		expect(getCustomExportDraft('exp:e1')?.name).toBe('My export');
	});

	it('fails OPEN when POST /locks errors for a non-conflict reason', async () => {
		asEditor();
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(new Error('boom'));
		const get = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);

		await ensureCustomExportDraft('exp:e1');

		expect(get).toHaveBeenCalledWith('e1');
		expect(getCustomExportLockHolder('exp:e1')).toBeUndefined();
	});

	it('closeCustomExportDraft releases the lease when nothing staged needs it', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		await ensureCustomExportDraft('exp:e1');

		closeCustomExportDraft('exp:e1');
		await Promise.resolve();

		expect(release).toHaveBeenCalledWith('t_e1', undefined);
		expect(isCheckedOutByMe('art:e1')).toBe(false);
	});
});

describe('staged-artifact listeners', () => {
	it('a commit rebinds a temp draft to its canonical id', async () => {
		const tabId = openArtifactTab('custom_export', { artifactId: null, title: 'New export' });
		await ensureCustomExportDraft(tabId);
		addExportEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);
		setCustomExportName(tabId, 'Mine');
		saveCustomExportDraft(tabId);
		const tempId = getCustomExportDraft(tabId)!.artifactId!;

		notifyArtifactCommit({
			idMap: { [tempId]: 'e9' },
			changed: [header('e9', 'Mine', 7)],
			deletedIds: []
		});

		expect(getCustomExportDraft(tabId)).toBeUndefined();
		const bound = getCustomExportDraft('exp:e9')!;
		expect(bound.artifactId).toBe('e9');
		expect(bound.artifactRev).toBe(7);
		expect(bound.entries).toHaveLength(1);
		expect(getDynamicTabs()[0].id).toBe('exp:e9');
	});

	it('a committed delete closes the artifact’s open tab', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('custom_export', { artifactId: 'e1', title: 'My export' });
		await ensureCustomExportDraft('exp:e1');

		notifyArtifactCommit({ idMap: {}, changed: [], deletedIds: ['e1'] });

		expect(getCustomExportDraft('exp:e1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('a staged delete closes the artifact’s open tab immediately', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('custom_export', { artifactId: 'e1', title: 'My export' });
		await ensureCustomExportDraft('exp:e1');

		stageArtifactDelete('e1', header('e1', 'My export', 3));

		expect(getCustomExportDraft('exp:e1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('discarding a staged update re-dirties the draft', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(CUSTOM_EXPORT_ARTIFACT);
		await ensureCustomExportDraft('exp:e1');
		saveCustomExportDraft('exp:e1');
		expect(getCustomExportDraft('exp:e1')?.dirty).toBe(false);

		revertStagedArtifact('e1');

		expect(getCustomExportDraft('exp:e1')?.dirty).toBe(true);
		expect(getCustomExportDraft('exp:e1')?.artifactId).toBe('e1');
	});

	it('discarding a staged create unbinds the draft back to unsaved', async () => {
		const tabId = openArtifactTab('custom_export', { artifactId: null, title: 'New export' });
		await ensureCustomExportDraft(tabId);
		setCustomExportName(tabId, 'Mine');
		saveCustomExportDraft(tabId);
		const tempId = getCustomExportDraft(tabId)!.artifactId!;

		revertStagedArtifact(tempId);

		const draft = getCustomExportDraft(tabId)!;
		expect(draft.artifactId).toBeNull();
		expect(draft.dirty).toBe(true);
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBeNull();
	});
});
