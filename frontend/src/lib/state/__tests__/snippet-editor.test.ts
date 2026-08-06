import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import * as snippetsApi from '$lib/api/snippets';
import { ApiError, ConflictError } from '$lib/api/errors';
import type { ArtifactHeader } from '$lib/api/types';
import {
	addSnippetElement,
	clearSnippetElements,
	closeSnippetDraft,
	ensureSnippetDraft,
	getSnippetDraft,
	getSnippetLint,
	getSnippetLockHolder,
	getSnippetRun,
	hasDirtySnippetDrafts,
	LINT_DEBOUNCE_MS,
	markRunStaged,
	removeSnippetElement,
	resetSnippetEditors,
	retrySnippetLock,
	runSnippetTab,
	saveSnippetDraft,
	setSnippetEntry,
	setSnippetName,
	stopSnippetTab,
	updateSnippetCode
} from '../snippet-editor.svelte';
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

const SNIPPET_ARTIFACT = {
	id: 's1',
	kind: 'code_snippet',
	name: 'My snippet',
	artifact_rev: 3,
	updated_at: '2026-07-17T00:00:00Z',
	updated_by: 'u1',
	entry_points: ['script', 'value'],
	payload: {
		schema_version: 1,
		language: 'python',
		code: 'print(1)\n',
		entry_points: ['script', 'value']
	}
};

function header(
	id: string,
	name: string,
	rev = 1,
	entryPoints: string[] | null = null
): ArtifactHeader {
	return {
		id,
		kind: 'code_snippet',
		name,
		artifact_rev: rev,
		updated_at: '',
		updated_by: null,
		entry_points: entryPoints
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
				{ resource_id: 'art:s1', held_by: 'u2', held_by_email: email, held_mode: 'exclusive' }
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
	resetSnippetEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetArtifactEdits();
	resetCheckout();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	// ensureSnippetDraft() fires `void lintNow()` unconditionally, so EVERY test
	// here triggers a lint whether or not it cares about one. Without a default
	// stub that escapes to a real fetch against happy-dom's origin and the run
	// fills with ECONNREFUSED noise (lintNow swallows the rejection, so it stays
	// green and silent-ish). Tests asserting on lint re-spy with their own value.
	vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
		diagnostics: [],
		entry_points: ['script']
	});
});
afterEach(() => {
	resetSnippetEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	vi.restoreAllMocks();
});

describe('snippet drafts', () => {
	it('creates a fresh draft for a snip:draft:* tab', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		expect(tabId).toMatch(/^snip:draft:/);
		const draft = await ensureSnippetDraft(tabId);
		expect(draft.artifactId).toBeNull();
		expect(draft.dirty).toBe(false);
		expect(draft.code).toBe('');
	});

	it('a fresh never-saved draft does not count as dirty until edited', async () => {
		const tabId = 'snip:draft:9';
		await ensureSnippetDraft(tabId);
		expect(hasDirtySnippetDrafts()).toBe(false);
		updateSnippetCode(tabId, 'print(1)\n');
		expect(hasDirtySnippetDrafts()).toBe(true);
	});

	it('loads a saved artifact draft and adopts server entry points', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		const tabId = openArtifactTab('snippet', { artifactId: 's1', title: 'My snippet' });
		const draft = await ensureSnippetDraft(tabId);
		expect(draft.code).toBe('print(1)\n');
		expect(draft.artifactRev).toBe(3);
		expect(draft.entryPoints).toEqual(['script', 'value']);
	});

	it('treats a TEMP-id tab as an unsaved draft rather than fetching it', async () => {
		// A temp id names nothing server-side: `getArtifact('tmp_…')` would 404
		// and, since our only caller is a fire-and-forget `$effect`, the rejection
		// would strand the tab on "Loading…" forever. The `snip:draft:` prefix
		// alone does not catch this shape (the sibling editors' save-as forks are
		// keyed `<prefix>:<tempId>`), so the temp id itself is the test.
		asEditor();
		const acquire = mockAcquire();
		const get = vi.spyOn(artifactsApi, 'getArtifact');

		const draft = await ensureSnippetDraft('snip:tmp_abc');

		expect(get).not.toHaveBeenCalled();
		expect(acquire).not.toHaveBeenCalled();
		expect(draft.artifactId).toBeNull();
		expect(draft.code).toBe('');
	});

	it('saveSnippetDraft on an unsaved draft stages a create and binds the draft to the temp id', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'print(2)\n');
		setSnippetName(tabId, 'My snippet');
		expect(getSnippetDraft(tabId)?.dirty).toBe(true);

		await saveSnippetDraft(tabId);

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'create_artifact',
				temp_id: expect.stringMatching(/^tmp_/),
				artifact_kind: 'code_snippet',
				name: 'My snippet',
				payload: { schema_version: 1, language: 'python', code: 'print(2)\n' }
			}
		]);
		const draft = getSnippetDraft(tabId)!;
		expect(isTempId(draft.artifactId!)).toBe(true);
		expect(draft.dirty).toBe(false);
		// A staged snippet has NO server-derived entry points yet.
		expect(draft.entryPoints).toEqual([]);
		// The tab KEY is NOT re-keyed at stage time: it keeps living under
		// snip:draft:N until the commit's id_map supplies a canonical id. The tab
		// RECORD does follow the draft onto the temp id.
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBe(draft.artifactId);
	});

	it('re-saving a staged create folds back into the create op', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetName(tabId, 'Mine');
		await saveSnippetDraft(tabId);
		const tempId = getSnippetDraft(tabId)!.artifactId!;
		updateSnippetCode(tabId, 'print(42)\n');
		setSnippetName(tabId, 'Renamed');

		await saveSnippetDraft(tabId);

		// Still ONE op, still a create: the backend resolves update_artifact ids
		// literally, so a create+update pair for the same temp id would 422.
		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'create_artifact',
				temp_id: tempId,
				artifact_kind: 'code_snippet',
				name: 'Renamed',
				payload: { schema_version: 1, language: 'python', code: 'print(42)\n' }
			}
		]);
		expect(getSnippetDraft(tabId)?.artifactId).toBe(tempId); // no second temp id
		expect(getSnippetDraft(tabId)?.dirty).toBe(false);
	});

	it('saveSnippetDraft on a saved artifact stages a full-payload update', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		await ensureSnippetDraft('snip:s1');
		updateSnippetCode('snip:s1', 'print(3)\n');

		await saveSnippetDraft('snip:s1');

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'update_artifact',
				id: 's1',
				name: 'My snippet',
				payload: { schema_version: 1, language: 'python', code: 'print(3)\n' }
			}
		]);
		expect(getSnippetDraft('snip:s1')?.dirty).toBe(false);
		expect(getSnippetDraft('snip:s1')?.artifactId).toBe('s1');
	});

	it('re-saving coalesces into one staged op carrying the latest code', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		await ensureSnippetDraft('snip:s1');
		updateSnippetCode('snip:s1', 'print(3)\n');
		await saveSnippetDraft('snip:s1');
		updateSnippetCode('snip:s1', 'print(4)\n');
		await saveSnippetDraft('snip:s1');

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'update_artifact',
				id: 's1',
				name: 'My snippet',
				payload: { schema_version: 1, language: 'python', code: 'print(4)\n' }
			}
		]);
	});

	it('saveSnippetDraft refuses a name another snippet already uses', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [header('s2', 'Taken')]
		});
		await loadArtifacts();
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetName(tabId, 'Taken');

		await expect(saveSnippetDraft(tabId)).rejects.toThrow(
			/code snippet named "Taken" already exists/
		);
		// Nothing staged, and the draft is untouched (still unsaved + dirty).
		expect(getStagedArtifactOps()).toEqual([]);
		expect(getSnippetDraft(tabId)?.artifactId).toBeNull();
		expect(getSnippetDraft(tabId)?.dirty).toBe(true);
	});

	it('close drops the draft', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		closeSnippetDraft(tabId);
		expect(getSnippetDraft(tabId)).toBeUndefined();
	});
});

describe('artifact lease on open', () => {
	it('acquires the art: lease before fetching the payload', async () => {
		asEditor();
		const acquire = mockAcquire();
		const get = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);

		await ensureSnippetDraft('snip:s1');

		expect(acquire.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 's1', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
		// The lease is taken FIRST: showing an editable surface we may not own is
		// the failure mode the check-out is there to prevent.
		expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
		expect(get).toHaveBeenCalledWith('s1');
		expect(isCheckedOutByMe('art:s1')).toBe(true);
		expect(getSnippetLockHolder('snip:s1')).toBeNull();
	});

	it('marks the tab lock-denied (unsaveable) when the lease is refused, but still loads it', async () => {
		asEditor();
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(lockConflict('peer@x'));
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);

		const draft = await ensureSnippetDraft('snip:s1');

		expect(getSnippetLockHolder('snip:s1')).toBe('peer@x');
		// A denial must not refuse the tab — it opens unsaveable with the banner.
		expect(draft.name).toBe('My snippet');
		expect(draft.code).toBe('print(1)\n');
	});

	it('fails OPEN when POST /locks errors for a non-conflict reason', async () => {
		asEditor();
		// ensureCheckout rethrows anything that is not a ConflictError; if that
		// escaped ensureSnippetDraft the tab would sit on "Loading…" forever (its
		// caller is a fire-and-forget $effect).
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(new Error('boom'));
		const get = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);

		const draft = await ensureSnippetDraft('snip:s1');

		expect(get).toHaveBeenCalledWith('s1');
		expect(draft.name).toBe('My snippet');
		// No banner: an infrastructure error is not a peer holding the artifact.
		expect(getSnippetLockHolder('snip:s1')).toBeNull();
	});

	it('shows no banner to a viewer (the whole workspace is already read-only)', async () => {
		const acquire = mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);

		await ensureSnippetDraft('snip:s1'); // role is viewer (resetCheckout default)

		expect(acquire).not.toHaveBeenCalled();
		expect(getSnippetLockHolder('snip:s1')).toBeNull();
		expect(getSnippetDraft('snip:s1')).toBeDefined();
	});

	it('retrySnippetLock clears the banner once the peer releases', async () => {
		asEditor();
		const acquire = mockAcquire();
		acquire.mockRejectedValueOnce(lockConflict('peer@x'));
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		await ensureSnippetDraft('snip:s1');
		expect(getSnippetLockHolder('snip:s1')).toBe('peer@x');

		await retrySnippetLock('snip:s1');

		expect(getSnippetLockHolder('snip:s1')).toBeNull();
		expect(isCheckedOutByMe('art:s1')).toBe(true);
	});

	it('retrySnippetLock keeps the banner and does not reject on a non-conflict error', async () => {
		// The banner's onclick is `void retrySnippetLock(tabId)`: an unguarded
		// rethrow from ensureCheckout would surface as an unhandled rejection.
		asEditor();
		const acquire = mockAcquire();
		acquire.mockRejectedValueOnce(lockConflict('peer@x'));
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		await ensureSnippetDraft('snip:s1');
		acquire.mockRejectedValueOnce(new Error('boom'));

		await expect(retrySnippetLock('snip:s1')).resolves.toBeUndefined();

		expect(getSnippetLockHolder('snip:s1')).toBe('peer@x'); // still refused
	});

	it('retrySnippetLock is a no-op for an unsaved (temp-id) draft', async () => {
		asEditor();
		const acquire = mockAcquire();
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		await saveSnippetDraft(tabId); // draft.artifactId is now a temp id

		await retrySnippetLock(tabId);

		expect(acquire).not.toHaveBeenCalled();
	});

	it('closeSnippetDraft releases the lease when nothing staged needs it', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		await ensureSnippetDraft('snip:s1');

		closeSnippetDraft('snip:s1');
		await Promise.resolve();

		expect(release).toHaveBeenCalledWith('t_s1', undefined);
		expect(isCheckedOutByMe('art:s1')).toBe(false);
		expect(getSnippetLockHolder('snip:s1')).toBeNull();
	});

	it('closeSnippetDraft keeps the lease while a staged op still needs it', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		await ensureSnippetDraft('snip:s1');
		await saveSnippetDraft('snip:s1'); // stages update_artifact s1 — the commit needs it
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);

		closeSnippetDraft('snip:s1');
		await Promise.resolve();

		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('art:s1')).toBe(true);
	});
});

describe('staged-artifact listeners', () => {
	it('a commit rebinds a temp draft to its canonical id and adopts the header', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'def value(elements):\n    return 1\n');
		setSnippetName(tabId, 'Mine');
		await saveSnippetDraft(tabId);
		const tempId = getSnippetDraft(tabId)!.artifactId!;

		notifyArtifactCommit({
			idMap: { [tempId]: 's9' },
			changed: [header('s9', 'Mine', 7, ['script', 'value'])],
			deletedIds: []
		});

		expect(getSnippetDraft(tabId)).toBeUndefined();
		const bound = getSnippetDraft('snip:s9')!;
		expect(bound.artifactId).toBe('s9');
		expect(bound.artifactRev).toBe(7);
		expect(bound.code).toBe('def value(elements):\n    return 1\n');
		expect(getDynamicTabs()[0].id).toBe('snip:s9');
		expect(getDynamicTabs()[0].artifactId).toBe('s9');
	});

	it('adopts server-derived entry_points from the commit header', async () => {
		// `entry_points` is derived by the backend from the code's AST, so a
		// staged (uncommitted) snippet has none — the commit response is the first
		// time the client learns them.
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'def value(elements):\n    return 1\n');
		await saveSnippetDraft(tabId);
		expect(getSnippetDraft(tabId)?.entryPoints).toEqual([]);
		const tempId = getSnippetDraft(tabId)!.artifactId!;

		notifyArtifactCommit({
			idMap: { [tempId]: 's9' },
			changed: [header('s9', 'New snippet', 1, ['script', 'value'])],
			deletedIds: []
		});

		expect(getSnippetDraft('snip:s9')?.entryPoints).toEqual(['script', 'value']);
	});

	it('a commit adopts the new rev and entry points on an already-saved draft', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		await ensureSnippetDraft('snip:s1');
		expect(getSnippetDraft('snip:s1')?.artifactRev).toBe(3);

		notifyArtifactCommit({
			idMap: {},
			changed: [header('s1', 'My snippet', 9, ['script', 'step'])],
			deletedIds: []
		});

		expect(getSnippetDraft('snip:s1')?.artifactRev).toBe(9);
		expect(getSnippetDraft('snip:s1')?.entryPoints).toEqual(['script', 'step']);
	});

	it('keeps the draft entry points when the commit header carries none', async () => {
		// A header with `entry_points: null` (a non-snippet-aware response shape)
		// must not blank what the tab already knows.
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		await ensureSnippetDraft('snip:s1');

		notifyArtifactCommit({
			idMap: {},
			changed: [header('s1', 'My snippet', 9)],
			deletedIds: []
		});

		expect(getSnippetDraft('snip:s1')?.entryPoints).toEqual(['script', 'value']);
	});

	it('a committed delete closes the artifact’s open tab', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('snippet', { artifactId: 's1', title: 'My snippet' });
		await ensureSnippetDraft('snip:s1');

		notifyArtifactCommit({ idMap: {}, changed: [], deletedIds: ['s1'] });

		expect(getSnippetDraft('snip:s1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('a staged delete closes the artifact’s open tab immediately', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('snippet', { artifactId: 's1', title: 'My snippet' });
		await ensureSnippetDraft('snip:s1');

		stageArtifactDelete('s1', header('s1', 'My snippet', 3));

		expect(getSnippetDraft('snip:s1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('discarding a staged update re-dirties the draft', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		await ensureSnippetDraft('snip:s1');
		await saveSnippetDraft('snip:s1');
		expect(getSnippetDraft('snip:s1')?.dirty).toBe(false);

		revertStagedArtifact('s1');

		expect(getSnippetDraft('snip:s1')?.dirty).toBe(true);
		expect(getSnippetDraft('snip:s1')?.artifactId).toBe('s1');
	});

	it('discarding a staged create unbinds the draft back to unsaved', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetName(tabId, 'Mine');
		await saveSnippetDraft(tabId);
		const tempId = getSnippetDraft(tabId)!.artifactId!;

		revertStagedArtifact(tempId);

		const draft = getSnippetDraft(tabId)!;
		expect(draft.artifactId).toBeNull();
		expect(draft.artifactRev).toBeNull();
		expect(draft.dirty).toBe(true);
		// The tab was never re-keyed, so it is still the draft tab it started as —
		// and its record unbinds with the draft (the temp id will never exist).
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBeNull();
	});
});

const RUN_OUT = {
	run_id: 'r-1',
	stdout: 'hello\n',
	result_repr: null,
	ops: [],
	error: null,
	duration_ms: 5,
	model_rev: 0,
	stale: false,
	truncated: false
};

describe('snippet lint + run', () => {
	it('debounces lint and applies the latest response', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [{ line: 1, col: 0, severity: 'warning', message: 'w' }],
			entry_points: ['script']
		});
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		lint.mockClear(); // drop the open-time immediate lint
		updateSnippetCode(tabId, 'import os\n');
		updateSnippetCode(tabId, 'import os  #\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		expect(lint).toHaveBeenCalledTimes(1);
		expect(lint).toHaveBeenCalledWith('import os  #\n');
		expect(getSnippetLint(tabId)?.diagnostics).toHaveLength(1);
		vi.useRealTimers();
	});

	it('runs and installs the result', async () => {
		vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'print("hello")\n');
		await runSnippetTab(tabId);
		const rs = getSnippetRun(tabId);
		expect(rs.phase).toBe('idle');
		expect(rs.result?.stdout).toBe('hello\n');
	});

	it('sends entry + element_ids (bound order, deduped) for a value run', async () => {
		// runSnippetTab refuses to send an entry lint hasn't unlocked (see the
		// entryAvailable guard), so 'value' must be in the lint response —
		// drive that via the debounced lint (fake timers), not the fire-and-
		// forget immediate lint ensureSnippetDraft kicks off.
		vi.useFakeTimers();
		vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [],
			entry_points: ['script', 'value']
		});
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'def value(elements):\n    return len(elements)\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e2', 'Building e2');
		addSnippetElement(tabId, 'e1', 'Building e1');
		addSnippetElement(tabId, 'e2', 'Building e2'); // duplicate — ignored
		await runSnippetTab(tabId);
		expect(run.mock.calls[0][0]).toMatchObject({ entry: 'value', element_ids: ['e2', 'e1'] });
		vi.useRealTimers();
	});

	it('element binding: remove, clear, step-mode replace and truncate-on-switch', () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e1', 'One');
		addSnippetElement(tabId, 'e2', 'Two');
		addSnippetElement(tabId, 'e3', 'Three');
		removeSnippetElement(tabId, 'e2');
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e1', 'e3']);
		// switching to step keeps only the first chip (single-element contract)
		setSnippetEntry(tabId, 'step');
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e1']);
		// step: picking replaces instead of appending
		addSnippetElement(tabId, 'e9', 'Nine');
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e9']);
		clearSnippetElements(tabId);
		expect(getSnippetRun(tabId).elements).toEqual([]);
	});

	it('refuses to run a value entry with no bound elements', async () => {
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');
		await runSnippetTab(tabId);
		expect(run).not.toHaveBeenCalled();
	});

	it('stop discards the eventual response', async () => {
		let resolveRun!: (v: typeof RUN_OUT) => void;
		vi.spyOn(snippetsApi, 'runSnippet').mockReturnValue(new Promise((r) => (resolveRun = r)));
		vi.spyOn(snippetsApi, 'cancelSnippet').mockResolvedValue(undefined);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		const running = runSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('running');
		await stopSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('idle');
		expect(getSnippetRun(tabId).notice).toContain('wall timeout');
		resolveRun(RUN_OUT);
		await running;
		expect(getSnippetRun(tabId).result).toBeNull(); // discarded
	});

	it('maps 429 and 503 to notices', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		vi.spyOn(snippetsApi, 'runSnippet').mockRejectedValue(new ApiError(429, null, 'busy'));
		await runSnippetTab(tabId);
		expect(getSnippetRun(tabId).notice).toContain('already in progress');
		vi.spyOn(snippetsApi, 'runSnippet').mockRejectedValue(new ApiError(503, null, 'no runner'));
		await runSnippetTab(tabId);
		expect(getSnippetRun(tabId).notice).toContain('unavailable');
	});

	it('leaves the entry selected even when a new lint drops it — the hint bar needs it', async () => {
		// Superseded contract (was "resets a stale entry to script..."): the
		// select is always selectable now (SnippetTab hint bar + insert-stub),
		// so a lint response that doesn't (yet) include the chosen entry must
		// NOT yank the selection back to 'script' out from under the user
		// while they're still writing def value(elements):/step(el). The stale-send
		// guarantee this reset used to provide now lives in runSnippetTab.
		vi.useFakeTimers();
		const lint = vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [],
			entry_points: ['script', 'value']
		});
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');
		expect(getSnippetRun(tabId).entry).toBe('value');

		lint.mockResolvedValue({ diagnostics: [], entry_points: ['script'] }); // 'value' dropped
		updateSnippetCode(tabId, 'print(1)\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		expect(getSnippetRun(tabId).entry).toBe('value'); // NOT reset to 'script'
		vi.useRealTimers();
	});

	it('leaves the entry untouched when the new lint still contains it', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [],
			entry_points: ['script', 'value']
		});
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');

		lint.mockResolvedValue({ diagnostics: [], entry_points: ['script', 'value'] });
		updateSnippetCode(tabId, 'print(1)\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		expect(getSnippetRun(tabId).entry).toBe('value');
		vi.useRealTimers();
	});

	it('runSnippetTab is a no-op when the selected entry is not (yet) lint-available', async () => {
		// The stale-send guarantee moved here from lintNow's old auto-reset:
		// Mod-Enter (CodeEditor keymap) calls runSnippetTab directly, bypassing
		// the disabled Run button, so the store itself must refuse to send.
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId); // immediate lint -> entry_points: [] (empty draft)
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e1', 'Building e1');

		await runSnippetTab(tabId);

		expect(run).not.toHaveBeenCalled();
		expect(getSnippetRun(tabId).phase).toBe('idle');
	});

	it('runSnippetTab sends once the lint response includes the selected entry', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [],
			entry_points: ['script']
		});
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e1', 'Building e1');

		lint.mockResolvedValue({ diagnostics: [], entry_points: ['script', 'value'] });
		updateSnippetCode(tabId, 'def value(el):\n    return el.name\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);

		await runSnippetTab(tabId);

		expect(run).toHaveBeenCalledTimes(1);
		expect(getSnippetRun(tabId).phase).toBe('idle');
		vi.useRealTimers();
	});

	it('markRunStaged pins the staged run id', async () => {
		vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		await runSnippetTab(tabId);
		markRunStaged(tabId);
		expect(getSnippetRun(tabId).stagedRunId).toBe('r-1');
	});

	it('rekey on COMMIT normalizes an in-flight run to idle with a discard notice', async () => {
		// The rekey moved from first-save to the commit rebind (staging no longer
		// re-keys the tab), but the hazard is the same: the in-flight run's
		// closure is bound to the OLD tab id, so a running phase must never be
		// carried to the new one.
		let resolveRun!: (v: typeof RUN_OUT) => void;
		vi.spyOn(snippetsApi, 'runSnippet').mockReturnValue(new Promise((r) => (resolveRun = r)));
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		await saveSnippetDraft(tabId);
		const tempId = getSnippetDraft(tabId)!.artifactId!;
		const running = runSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('running');

		notifyArtifactCommit({
			idMap: { [tempId]: 's1' },
			changed: [header('s1', 'New snippet', 1)],
			deletedIds: []
		});

		const newTab = 'snip:s1';
		expect(getSnippetRun(newTab)).toMatchObject({
			phase: 'idle',
			runId: null,
			notice: expect.stringContaining('discarded')
		});
		resolveRun(RUN_OUT); // the orphaned response must never land anywhere
		await running;
		expect(getSnippetRun(newTab).result).toBeNull();
		expect(getSnippetRun(tabId).result).toBeNull();
	});

	it('stop drops its post-cancel write if the draft closed mid-cancel', async () => {
		vi.spyOn(snippetsApi, 'runSnippet').mockReturnValue(new Promise(() => {})); // never resolves
		let resolveCancel!: () => void;
		vi.spyOn(snippetsApi, 'cancelSnippet').mockReturnValue(new Promise((r) => (resolveCancel = r)));
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		void runSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('running');
		const stopping = stopSnippetTab(tabId);
		closeSnippetDraft(tabId); // draft (and its _runs entry) gone before cancel settles
		resolveCancel();
		await stopping;
		expect(getSnippetRun(tabId)).toEqual({
			phase: 'idle',
			runId: null,
			result: null,
			stagedRunId: null,
			notice: null,
			entry: 'script',
			elements: []
		});
	});
});
