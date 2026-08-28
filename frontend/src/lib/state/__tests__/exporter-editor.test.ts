import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import type { ArtifactHeader, TableDefinition } from '$lib/api/types';
import {
	addExporterEntry,
	closeExporterDraft,
	ensureExporterDraft,
	getExporterDraft,
	getExporterLockHolder,
	hasDirtyExporterDrafts,
	moveExporterEntryInList,
	removeExporterEntry,
	resetExporterEditors,
	retryExporterLock,
	saveExporterDraft,
	setExporterName,
	updateExporterEntry,
	updateExporterOutput
} from '../exporter-editor.svelte';
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

const EXPORTER_ARTIFACT = {
	id: 'e1',
	kind: 'exporter',
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
		kind: 'exporter',
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
	resetExporterEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetArtifactEdits();
	resetCheckout();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
});
afterEach(() => {
	resetExporterEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	vi.restoreAllMocks();
});

describe('exporter drafts', () => {
	it('a draft tab starts empty and add copies the table settings', async () => {
		const tabId = openArtifactTab('exporter', { artifactId: null, title: 'New export' });
		await ensureExporterDraft(tabId);
		expect(getExporterDraft(tabId)?.entries).toEqual([]);
		expect(hasDirtyExporterDrafts()).toBe(false);

		addExporterEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);

		const d = getExporterDraft(tabId)!;
		expect(d.entries).toHaveLength(1);
		expect(d.entries[0].name).toBe('Alpha');
		expect(d.entries[0].source.ref).toBe('tbl-1');
		expect(d.dirty).toBe(true);
	});

	it('add copies the table definition — later edits to either do not follow the other', async () => {
		const tabId = 'exp:draft:1';
		await ensureExporterDraft(tabId);
		const defn = { ...TABLE_DEFN };
		addExporterEntry(tabId, 'tbl-1', 'Alpha', defn);
		defn.show_row_numbers = true; // mutate the source AFTER the copy-at-add moment

		const entry = getExporterDraft(tabId)!.entries[0];
		expect(entry.show_row_numbers).toBe(false); // unaffected by the later mutation
	});

	it('add copies a column export object — mutating the source column IN PLACE after add does not leak into the entry', async () => {
		// Defends copy-at-add at the OBJECT level, not just the scalar/array
		// level the test above covers: entryForTable's entry is STAGED and
		// PERSISTED, so overridesFromDefinition ($lib/table/exporter.ts)
		// must clone col.export/col.json_export rather than alias them.
		const tabId = 'exp:draft:1';
		await ensureExporterDraft(tabId);
		const defn: TableDefinition = {
			...TABLE_DEFN,
			columns: [
				{
					...TABLE_DEFN.columns[0],
					export: { include: true, header: 'Original' }
				}
			]
		};

		addExporterEntry(tabId, 'tbl-1', 'Alpha', defn);
		defn.columns[0].export!.header = 'Mutated'; // in-place mutation, not a replace

		const entry = getExporterDraft(tabId)!.entries[0];
		expect(entry.columns[0].export?.header).toBe('Original'); // unaffected
	});

	it('add copies the definition-level json_split object — mutating it IN PLACE after add does not leak into the entry', async () => {
		// Same invariant as the column export-object test above, at the
		// definition level: export_row_number and json_split are flat option
		// objects too, and overridesFromDefinition must clone them for the same
		// reason (the entry is staged and persisted).
		const tabId = 'exp:draft:1';
		await ensureExporterDraft(tabId);
		const defn: TableDefinition = {
			...TABLE_DEFN,
			json_split: { enabled: true, filename_template: 'original-${name}' }
		};

		addExporterEntry(tabId, 'tbl-1', 'Alpha', defn);
		defn.json_split!.filename_template = 'mutated-${name}'; // in-place, not a replace

		const entry = getExporterDraft(tabId)!.entries[0];
		expect(entry.json_split?.filename_template).toBe('original-${name}'); // unaffected
	});

	it('removeExporterEntry drops the entry at the given index and dirties the draft', async () => {
		const tabId = 'exp:draft:1';
		await ensureExporterDraft(tabId);
		addExporterEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);
		addExporterEntry(tabId, 'tbl-2', 'Beta', TABLE_DEFN);

		removeExporterEntry(tabId, 0);

		const d = getExporterDraft(tabId)!;
		expect(d.entries).toHaveLength(1);
		expect(d.entries[0].name).toBe('Beta');
	});

	it('moveExporterEntryInList reorders entries', async () => {
		const tabId = 'exp:draft:1';
		await ensureExporterDraft(tabId);
		addExporterEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);
		addExporterEntry(tabId, 'tbl-2', 'Beta', TABLE_DEFN);

		moveExporterEntryInList(tabId, 0, 1);

		const names = getExporterDraft(tabId)!.entries.map((e) => e.name);
		expect(names).toEqual(['Beta', 'Alpha']);
	});

	it('updateExporterEntry patches the entry at the given index', async () => {
		const tabId = 'exp:draft:1';
		await ensureExporterDraft(tabId);
		addExporterEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);

		updateExporterEntry(tabId, 0, { format: 'json' });

		expect(getExporterDraft(tabId)!.entries[0].format).toBe('json');
	});

	it('a fresh never-saved draft does not count as dirty until edited', async () => {
		const tabId = 'exp:draft:9';
		await ensureExporterDraft(tabId);
		expect(hasDirtyExporterDrafts()).toBe(false);
		setExporterName(tabId, 'Named');
		expect(hasDirtyExporterDrafts()).toBe(true);
	});

	it('loads a saved artifact draft and parses its payload through the schema', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);
		const tabId = openArtifactTab('exporter', { artifactId: 'e1', title: 'My export' });

		await ensureExporterDraft(tabId);

		const d = getExporterDraft(tabId)!;
		expect(d.artifactId).toBe('e1');
		expect(d.artifactRev).toBe(3);
		expect(d.entries).toHaveLength(1);
		expect(d.entries[0].source.ref).toBe('tbl-1');
		expect(d.dirty).toBe(false);
	});

	it('a malformed payload fails OPEN with an empty entry list instead of throwing', async () => {
		// The wire payload is parsed through ExporterDefinitionSchema, but
		// the parse must never THROW: this module's only caller is a
		// fire-and-forget `$effect` (see ensureExporterDraft's comment), so
		// an unhandled rejection here would strand the tab on "Loading…" forever
		// exactly like an unguarded lease/fetch rejection would.
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			...EXPORTER_ARTIFACT,
			payload: { schema_version: 1, entries: 'not-an-array' } // malformed
		});
		const tabId = openArtifactTab('exporter', { artifactId: 'e1', title: 'My export' });

		await expect(ensureExporterDraft(tabId)).resolves.toBeUndefined();

		const d = getExporterDraft(tabId)!;
		expect(d.artifactId).toBe('e1'); // the tab still opens, name/rev intact
		expect(d.entries).toEqual([]); // degrades to empty rather than refusing
		expect(d.dirty).toBe(false);
	});

	it('close drops the draft', async () => {
		const tabId = openArtifactTab('exporter', { artifactId: null, title: 'New export' });
		await ensureExporterDraft(tabId);
		closeExporterDraft(tabId);
		expect(getExporterDraft(tabId)).toBeUndefined();
	});
});

describe('saving an exporter draft', () => {
	it('saving a new draft stages a create and repoints the tab', async () => {
		const tabId = openArtifactTab('exporter', { artifactId: null, title: 'New export' });
		await ensureExporterDraft(tabId);
		addExporterEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);
		setExporterName(tabId, 'Release drop');

		saveExporterDraft(tabId);

		const ops = getStagedArtifactOps();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			kind: 'create_artifact',
			artifact_kind: 'exporter',
			name: 'Release drop'
		});
		const draft = getExporterDraft(tabId)!;
		expect(draft.dirty).toBe(false);
		expect(isTempId(draft.artifactId!)).toBe(true);
		// The tab KEY is NOT re-keyed at stage time.
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBe(draft.artifactId);
	});

	it('saving a saved artifact draft stages a full-payload update', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);
		const tabId = openArtifactTab('exporter', { artifactId: 'e1', title: 'My export' });
		await ensureExporterDraft(tabId);
		setExporterName(tabId, 'Renamed');

		saveExporterDraft(tabId);

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'update_artifact',
				id: 'e1',
				name: 'Renamed',
				payload: {
					schema_version: 1,
					output: { mode: 'zip', filename: '', manifest: true },
					entries: EXPORTER_ARTIFACT.payload.entries.map((e) => ({
						...e,
						folder: '',
						split_folder: true
					}))
				}
			}
		]);
		expect(getExporterDraft(tabId)?.dirty).toBe(false);
	});

	it('saveExporterDraft refuses a name another exporter already uses', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [header('e2', 'Taken')]
		});
		await loadArtifacts();
		const tabId = openArtifactTab('exporter', { artifactId: null, title: 'New export' });
		await ensureExporterDraft(tabId);
		setExporterName(tabId, 'Taken');

		expect(() => saveExporterDraft(tabId)).toThrow(/exporter named "Taken" already exists/);
		expect(getStagedArtifactOps()).toEqual([]);
		expect(getExporterDraft(tabId)?.artifactId).toBeNull();
		expect(getExporterDraft(tabId)?.dirty).toBe(true);
	});
});

describe('exporter output settings', () => {
	it('seeds output from the payload and defaults it when absent', async () => {
		asEditor();
		mockAcquire();
		const get = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValueOnce({
			...EXPORTER_ARTIFACT,
			payload: {
				...EXPORTER_ARTIFACT.payload,
				output: { mode: 'bare', filename: 'drop-${date}', manifest: false }
			}
		});
		const tabWithOutput = openArtifactTab('exporter', { artifactId: 'e1', title: 'My export' });
		await ensureExporterDraft(tabWithOutput);
		expect(getExporterDraft(tabWithOutput)?.output).toEqual({
			mode: 'bare',
			filename: 'drop-${date}',
			manifest: false
		});

		get.mockResolvedValueOnce(EXPORTER_ARTIFACT); // payload has no `output` key at all
		const tabWithout = openArtifactTab('exporter', { artifactId: 'e2', title: 'Other' });
		await ensureExporterDraft(tabWithout);
		expect(getExporterDraft(tabWithout)?.output).toEqual({
			mode: 'zip',
			filename: '',
			manifest: true
		});
	});

	it('updateExporterOutput patches and dirties', async () => {
		const tabId = 'exp:draft:1';
		await ensureExporterDraft(tabId);
		expect(getExporterDraft(tabId)?.dirty).toBe(false);

		updateExporterOutput(tabId, { mode: 'bare' });

		const d = getExporterDraft(tabId)!;
		expect(d.output.mode).toBe('bare');
		expect(d.dirty).toBe(true);
	});

	it('saveExporterDraft stages output alongside entries', async () => {
		const tabId = openArtifactTab('exporter', { artifactId: null, title: 'New export' });
		await ensureExporterDraft(tabId);
		setExporterName(tabId, 'Release drop');
		updateExporterOutput(tabId, { mode: 'bare', filename: 'x', manifest: false });

		saveExporterDraft(tabId);

		const ops = getStagedArtifactOps();
		expect(ops[0]).toMatchObject({
			kind: 'create_artifact',
			payload: { output: { mode: 'bare', filename: 'x', manifest: false }, entries: [] }
		});
	});
});

describe('artifact lease on open', () => {
	it('acquires the art: lease before fetching the payload', async () => {
		asEditor();
		const acquire = mockAcquire();
		const get = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);

		await ensureExporterDraft('exp:e1');

		expect(acquire.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'e1', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
		expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
		expect(get).toHaveBeenCalledWith('e1');
		expect(isCheckedOutByMe('art:e1')).toBe(true);
		expect(getExporterLockHolder('exp:e1')).toBeUndefined();
	});

	it('opening a saved artifact acquires the lease and hydrates entries', async () => {
		asEditor();
		const acquireSpy = mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);

		await ensureExporterDraft('exp:e1');

		expect(acquireSpy).toHaveBeenCalled();
		const d = getExporterDraft('exp:e1')!;
		expect(d.artifactId).toBe('e1');
		expect(d.entries[0].source.ref).toBe('tbl-1');
		expect(d.dirty).toBe(false);
	});

	it('a lease conflict marks the tab read-only', async () => {
		asEditor();
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(lockConflict('ada@example.com'));
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);

		await ensureExporterDraft('exp:e1');

		expect(getExporterLockHolder('exp:e1')).toBe('ada@example.com');
		// A denial must not refuse the tab — it opens unsaveable with the banner.
		expect(getExporterDraft('exp:e1')?.name).toBe('My export');
	});

	it('fails OPEN when POST /locks errors for a non-conflict reason', async () => {
		asEditor();
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(new Error('boom'));
		const get = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);

		await ensureExporterDraft('exp:e1');

		expect(get).toHaveBeenCalledWith('e1');
		expect(getExporterLockHolder('exp:e1')).toBeUndefined();
	});

	it('retryExporterLock clears the banner once the peer releases', async () => {
		asEditor();
		const acquire = mockAcquire();
		acquire.mockRejectedValueOnce(lockConflict('peer@x'));
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);
		await ensureExporterDraft('exp:e1');
		expect(getExporterLockHolder('exp:e1')).toBe('peer@x');

		await retryExporterLock('exp:e1');

		expect(getExporterLockHolder('exp:e1')).toBeUndefined();
		expect(isCheckedOutByMe('art:e1')).toBe(true);
	});

	it('retryExporterLock keeps the banner and does not reject on a non-conflict error', async () => {
		// The banner's onclick is `void retryExporterLock(tabId)`: an
		// unguarded rethrow from ensureCheckout would surface as an unhandled
		// rejection.
		asEditor();
		const acquire = mockAcquire();
		acquire.mockRejectedValueOnce(lockConflict('peer@x'));
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);
		await ensureExporterDraft('exp:e1');
		acquire.mockRejectedValueOnce(new Error('boom'));

		await expect(retryExporterLock('exp:e1')).resolves.toBeUndefined();

		expect(getExporterLockHolder('exp:e1')).toBe('peer@x'); // still refused
	});

	it('retryExporterLock is a no-op for an unsaved (temp-id) draft', async () => {
		asEditor();
		const acquire = mockAcquire();
		const tabId = openArtifactTab('exporter', { artifactId: null, title: 'New export' });
		await ensureExporterDraft(tabId);
		saveExporterDraft(tabId); // draft.artifactId is now a temp id

		await retryExporterLock(tabId);

		expect(acquire).not.toHaveBeenCalled();
	});

	it('closeExporterDraft releases the lease when nothing staged needs it', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		await ensureExporterDraft('exp:e1');

		closeExporterDraft('exp:e1');
		await Promise.resolve();

		expect(release).toHaveBeenCalledWith('t_e1', undefined);
		expect(isCheckedOutByMe('art:e1')).toBe(false);
	});
});

describe('staged-artifact listeners', () => {
	it('a commit rebinds a temp draft to its canonical id', async () => {
		const tabId = openArtifactTab('exporter', { artifactId: null, title: 'New export' });
		await ensureExporterDraft(tabId);
		addExporterEntry(tabId, 'tbl-1', 'Alpha', TABLE_DEFN);
		setExporterName(tabId, 'Mine');
		saveExporterDraft(tabId);
		const tempId = getExporterDraft(tabId)!.artifactId!;

		notifyArtifactCommit({
			idMap: { [tempId]: 'e9' },
			changed: [header('e9', 'Mine', 7)],
			deletedIds: []
		});

		expect(getExporterDraft(tabId)).toBeUndefined();
		const bound = getExporterDraft('exp:e9')!;
		expect(bound.artifactId).toBe('e9');
		expect(bound.artifactRev).toBe(7);
		expect(bound.entries).toHaveLength(1);
		expect(getDynamicTabs()[0].id).toBe('exp:e9');
	});

	it('a committed delete closes the artifact’s open tab', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('exporter', { artifactId: 'e1', title: 'My export' });
		await ensureExporterDraft('exp:e1');

		notifyArtifactCommit({ idMap: {}, changed: [], deletedIds: ['e1'] });

		expect(getExporterDraft('exp:e1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('a staged delete closes the artifact’s open tab immediately', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('exporter', { artifactId: 'e1', title: 'My export' });
		await ensureExporterDraft('exp:e1');

		stageArtifactDelete('e1', header('e1', 'My export', 3));

		expect(getExporterDraft('exp:e1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('discarding a staged update re-dirties the draft', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORTER_ARTIFACT);
		await ensureExporterDraft('exp:e1');
		saveExporterDraft('exp:e1');
		expect(getExporterDraft('exp:e1')?.dirty).toBe(false);

		revertStagedArtifact('e1');

		expect(getExporterDraft('exp:e1')?.dirty).toBe(true);
		expect(getExporterDraft('exp:e1')?.artifactId).toBe('e1');
	});

	it('discarding a staged create unbinds the draft back to unsaved', async () => {
		const tabId = openArtifactTab('exporter', { artifactId: null, title: 'New export' });
		await ensureExporterDraft(tabId);
		setExporterName(tabId, 'Mine');
		saveExporterDraft(tabId);
		const tempId = getExporterDraft(tabId)!.artifactId!;

		revertStagedArtifact(tempId);

		const draft = getExporterDraft(tabId)!;
		expect(draft.artifactId).toBeNull();
		expect(draft.dirty).toBe(true);
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBeNull();
	});
});
