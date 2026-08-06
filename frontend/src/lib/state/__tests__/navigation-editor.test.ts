import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import type { ArtifactHeader } from '$lib/api/types';
import {
	closeDraft,
	ensureDraft,
	ensureEmbeddedDraft,
	getDraft,
	getEvalError,
	getNavLockHolder,
	getPreview,
	getSelectedPath,
	isCardCollapsed,
	isNodeVisible,
	isRunnable,
	loadMorePreview,
	registerVisibleNode,
	resetNavigationEditors,
	retryNavLock,
	runPreview,
	saveAsDraft,
	saveDraft,
	selectNode,
	setCardCollapsed,
	setDraftName,
	setEmbeddedRowElement,
	unregisterVisibleNode,
	updateDefinition
} from '../navigation-editor.svelte';
import { applyStructuralEdit } from '../navigation-editor.svelte';
import {
	emptyCombine,
	emptyRowPath,
	insertNavigationEdit,
	moveOperandEdit,
	pathKey,
	removeOperandEdit
} from '$lib/navigation/tree';
import { resetWorkspaceTabs, openNavigationTab, getDynamicTabs } from '../workspace.svelte';
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

const CHAIN_PAGE = {
	step_types: ['Owns'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 1,
	truncated: false,
	warnings: []
};

/** Two-page result set for pagination tests (PAGE-sized slices are irrelevant:
 * the store trusts the server's `total`, not the page length). */
const PAGE_1 = {
	step_types: ['Owns'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 2,
	truncated: false,
	warnings: []
};
const PAGE_2 = {
	step_types: ['Owns'],
	chains: [[{ id: 'b2', type_name: 'B', display_name: 'b2', child_count: 0 }]],
	total: 2,
	truncated: false,
	warnings: []
};

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
} {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A runnable path node: a start type plus one complete relationship step.
 * Used by the node-scoped preview tests (new NavStepItem shape). */
function runnablePath(startType = 'Component') {
	return {
		kind: 'path' as const,
		schema_version: 1,
		start: { kind: 'scope' as const, types: [startType], criteria: [] },
		steps: [
			{
				kind: 'relationship' as const,
				relationship_type: 'Uses',
				direction: 'out' as const,
				target_types: [],
				children: []
			}
		],
		exclude_visited: true
	};
}

/** Flush the microtask/macrotask that a fire-and-forget preview run (via
 * `registerVisibleNode`) needs to settle its mocked (immediately-resolved) evaluate. */
const flushEvaluate = () => new Promise<void>((r) => setTimeout(r, 0));

function header(id: string, name: string, rev = 1, kind = 'navigation'): ArtifactHeader {
	return {
		id,
		kind,
		name,
		artifact_rev: rev,
		updated_at: '',
		updated_by: null,
		entry_points: null
	};
}

/** The saved artifact every `nav:a1` test opens: a runnable one-scope path. */
function mockGetArtifact(payload?: Record<string, unknown>) {
	return vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
		...header('a1', 'Sensors', 4),
		payload: payload ?? {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['Building'], criteria: [] },
			steps: []
		}
	});
}

/** Mirror of the backend's lock canonicalization (see checkout.artifact.test.ts):
 * targets go out with the bare id + `type: "artifact"`, leases come back keyed
 * `art:<id>` under one token per call. */
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
				{ resource_id: 'art:a1', held_by: 'u2', held_by_email: email, held_mode: 'exclusive' }
			]
		},
		'lock conflict'
	);
}

/** The temp id of the one staged `create_artifact` op in the buffer. */
function stagedTempId(): string {
	const op = getStagedArtifactOps().find((o) => o.kind === 'create_artifact');
	if (op?.kind !== 'create_artifact') throw new Error('no staged create in the buffer');
	return op.temp_id;
}

/** Role + lease mocks for the checked-out-editor path (the default role after
 * `resetCheckout` is viewer, which fails the lease open with no banner). */
function asEditor() {
	setProjectInfo({ role: 'editor', lockTtlSeconds: 100 });
}

beforeEach(() => {
	resetNavigationEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetArtifactEdits();
	resetCheckout();
});
afterEach(() => {
	// Belt-and-suspenders: a debounce timer left pending by a test (real or
	// fake) must never fire into the NEXT test's store state. Real time in a
	// unit test always advances far slower than 400ms between tests, but this
	// makes the guarantee explicit rather than incidental.
	resetNavigationEditors();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('navigation editor store', () => {
	it('creates an empty path draft for draft tabs', async () => {
		const draft = await ensureDraft('nav:draft:1');
		expect(draft.definition).toEqual({
			kind: 'path',
			schema_version: 2,
			start: { kind: 'scope', types: [], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		expect(draft.artifactId).toBeNull();
		expect(draft.dirty).toBe(false);
	});

	it('stamps a brand-new draft schema_version 2 (no v1 seed)', async () => {
		await ensureDraft('nav:draft:vtest');
		const definition = getDraft('nav:draft:vtest')?.definition;
		expect(definition?.schema_version).toBe(2);
		expect(definition?.kind).toBe('path');
	});

	it('loads the artifact payload for saved tabs', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			entry_points: null,
			payload: {
				kind: 'path',
				schema_version: 1,
				start: { kind: 'scope', types: ['Building'], criteria: [] },
				steps: []
			}
		});
		// This payload is runnable (a start type is set), so ensureDraft's
		// load-a-saved-artifact auto-run fires; without a mock this would hit
		// the real fetch layer.
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		const draft = await ensureDraft('nav:a1');
		expect(draft.name).toBe('Sensors');
		expect(draft.artifactRev).toBe(4);
		// Legacy payload predates exclude_visited: defaulted on load.
		expect(draft.definition).toMatchObject({ exclude_visited: true });
	});

	it('updateDefinition marks dirty and clears the preview', async () => {
		await ensureDraft('nav:draft:1');
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await runPreview('nav:draft:1');
		expect(getPreview('nav:draft:1')?.total).toBe(1);
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		expect(getDraft('nav:draft:1')?.dirty).toBe(true);
		expect(getPreview('nav:draft:1')).toBeUndefined();
	});

	it('saveDraft on an unsaved draft stages a create and binds the draft to the temp id', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		setDraftName(tabId, 'Mine');
		const definition = getDraft(tabId)!.definition;

		await saveDraft(tabId);

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'create_artifact',
				temp_id: expect.stringMatching(/^tmp_/),
				artifact_kind: 'navigation',
				name: 'Mine',
				payload: definition
			}
		]);
		const draft = getDraft(tabId)!;
		expect(isTempId(draft.artifactId!)).toBe(true);
		expect(draft.dirty).toBe(false);
		// The tab KEY is NOT re-keyed at stage time: it keeps living under
		// nav:draft:N until the commit's id_map supplies a canonical id. The tab
		// RECORD does follow the draft onto the temp id.
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBe(draft.artifactId);
	});

	it('re-saving a staged create folds back into the create op', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		setDraftName(tabId, 'Mine');
		await saveDraft(tabId);
		const tempId = getDraft(tabId)!.artifactId!;
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnablePath('Edited'));
		setDraftName(tabId, 'Renamed');

		await saveDraft(tabId);

		// Still ONE op, still a create: the backend resolves update_artifact ids
		// literally, so a create+update pair for the same temp id would 422.
		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'create_artifact',
				temp_id: tempId,
				artifact_kind: 'navigation',
				name: 'Renamed',
				payload: runnablePath('Edited')
			}
		]);
		expect(getDraft(tabId)?.artifactId).toBe(tempId); // no second temp id minted
		expect(getDraft(tabId)?.dirty).toBe(false);
	});

	it('saveDraft on a saved artifact stages a full-payload update', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await ensureDraft('nav:a1');
		updateDefinition('nav:a1', runnablePath('Edited'));

		await saveDraft('nav:a1');

		expect(getStagedArtifactOps()).toEqual([
			{ kind: 'update_artifact', id: 'a1', name: 'Sensors', payload: runnablePath('Edited') }
		]);
		expect(getDraft('nav:a1')?.dirty).toBe(false);
		expect(getDraft('nav:a1')?.artifactId).toBe('a1');
	});

	it('re-saving coalesces into one staged op carrying the latest payload', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await ensureDraft('nav:a1');
		updateDefinition('nav:a1', runnablePath('First'));
		await saveDraft('nav:a1');
		updateDefinition('nav:a1', runnablePath('Second'));
		await saveDraft('nav:a1');

		expect(getStagedArtifactOps()).toEqual([
			{ kind: 'update_artifact', id: 'a1', name: 'Sensors', payload: runnablePath('Second') }
		]);
	});

	it('saveDraft refuses a name another artifact of the same kind already uses', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [header('a2', 'Taken')]
		});
		await loadArtifacts();
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		setDraftName(tabId, 'Taken');

		await expect(saveDraft(tabId)).rejects.toThrow(/named "Taken" already exists/);
		// Nothing staged, and the draft is untouched (still unsaved + dirty).
		expect(getStagedArtifactOps()).toEqual([]);
		expect(getDraft(tabId)?.artifactId).toBeNull();
		expect(getDraft(tabId)?.dirty).toBe(true);
	});
});

describe('artifact lease on open', () => {
	it('acquires the art: lease before fetching the payload', async () => {
		asEditor();
		const acquire = mockAcquire();
		const get = mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);

		await ensureDraft('nav:a1');

		expect(acquire.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'a1', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
		// The lease is taken FIRST: showing an editable surface we may not own is
		// the failure mode the check-out is there to prevent.
		expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
		expect(get).toHaveBeenCalledWith('a1');
		expect(isCheckedOutByMe('art:a1')).toBe(true);
		expect(getNavLockHolder('nav:a1')).toBeNull();
	});

	it('marks the tab lock-denied (unsaveable) when the lease is refused, but still loads it', async () => {
		asEditor();
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(lockConflict('peer@x'));
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);

		const draft = await ensureDraft('nav:a1');

		expect(getNavLockHolder('nav:a1')).toBe('peer@x');
		// A denial must not refuse the tab — it opens unsaveable with the banner.
		expect(draft.name).toBe('Sensors');
		expect(getPreview('nav:a1')?.total).toBe(1);
	});

	it('fails OPEN when POST /locks errors for a non-conflict reason', async () => {
		asEditor();
		// ensureCheckout rethrows anything that is not a ConflictError; if that
		// escaped ensureDraft the tab would sit on "Loading…" forever (its caller
		// is a fire-and-forget $effect).
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(new Error('boom'));
		const get = mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);

		const draft = await ensureDraft('nav:a1');

		expect(get).toHaveBeenCalledWith('a1');
		expect(draft.name).toBe('Sensors');
		// No banner: an infrastructure error is not a peer holding the artifact.
		expect(getNavLockHolder('nav:a1')).toBeNull();
	});

	it('shows no banner to a viewer (the whole workspace is already read-only)', async () => {
		const acquire = mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);

		await ensureDraft('nav:a1'); // role is viewer (resetCheckout default)

		expect(acquire).not.toHaveBeenCalled();
		expect(getNavLockHolder('nav:a1')).toBeNull();
		expect(getDraft('nav:a1')).toBeDefined();
	});

	it('retryNavLock clears the banner once the peer releases', async () => {
		asEditor();
		const acquire = mockAcquire();
		acquire.mockRejectedValueOnce(lockConflict('peer@x'));
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await ensureDraft('nav:a1');
		expect(getNavLockHolder('nav:a1')).toBe('peer@x');

		await retryNavLock('nav:a1');

		expect(getNavLockHolder('nav:a1')).toBeNull();
		expect(isCheckedOutByMe('art:a1')).toBe(true);
	});

	it('retryNavLock is a no-op for an unsaved (temp-id) draft', async () => {
		asEditor();
		const acquire = mockAcquire();
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		await saveDraft(tabId); // draft.artifactId is now a temp id

		await retryNavLock(tabId);

		expect(acquire).not.toHaveBeenCalled();
	});

	it('closeDraft releases the lease when nothing staged needs it', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		await ensureDraft('nav:a1');

		closeDraft('nav:a1');
		await Promise.resolve();

		expect(release).toHaveBeenCalledWith('t_a1', undefined);
		expect(isCheckedOutByMe('art:a1')).toBe(false);
		expect(getNavLockHolder('nav:a1')).toBeNull();
	});

	it('closeDraft keeps the lease while a staged op still needs it', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await ensureDraft('nav:a1');
		await saveDraft('nav:a1'); // stages update_artifact a1 — the commit needs the lease
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);

		closeDraft('nav:a1');
		await Promise.resolve();

		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('art:a1')).toBe(true);
	});
});

describe('saveAsDraft', () => {
	it('stages a fresh create, retitles the tab, and leaves the original untouched', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		const draft = await ensureDraft('nav:a1');
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);

		await saveAsDraft('nav:a1', 'Copy');

		// The original artifact is never touched: the staged batch holds the
		// fork's create and nothing else — no update op against `a1`.
		const ops = getStagedArtifactOps();
		expect(ops).toEqual([
			{
				kind: 'create_artifact',
				temp_id: expect.stringMatching(/^tmp_/),
				artifact_kind: 'navigation',
				name: 'Copy',
				payload: draft.definition
			}
		]);
		// The fork tab is re-keyed to nav:<tempId> AT STAGE TIME (unlike a create
		// staged from a nav:draft:N tab): a bound tab's key must always be
		// `nav:<its own artifactId>`, or reopening the original would mint a
		// SECOND record with the id this tab still holds.
		const tempId = (ops[0] as { temp_id: string }).temp_id;
		expect(getDynamicTabs()).toHaveLength(1);
		expect(getDynamicTabs()[0].id).toBe(`nav:${tempId}`);
		expect(getDynamicTabs()[0].title).toBe('Copy');
		expect(getDynamicTabs()[0].artifactId).toBe(tempId);
		expect(getDraft('nav:a1')).toBeUndefined();
		const forked = getDraft(`nav:${tempId}`)!;
		expect(forked.name).toBe('Copy');
		expect(forked.artifactId).toBe(tempId);
		expect(forked.artifactRev).toBeNull();
		expect(forked.dirty).toBe(false);
		// The original's lease is no longer needed by anything staged: released.
		expect(release).toHaveBeenCalledWith('t_a1', undefined);
		expect(isCheckedOutByMe('art:a1')).toBe(false);
	});

	it('frees the original artifact to reopen in its OWN tab with its own draft', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		await ensureDraft('nav:a1');

		await saveAsDraft('nav:a1', 'Copy');
		const reopened = openNavigationTab({ artifactId: 'a1', title: 'Sensors' }); // sidebar click

		// Two tabs with DISTINCT ids — a duplicate id would blow up Workspace's
		// keyed {#each} over tab.id (each_key_duplicate), and there is no
		// <svelte:boundary> to catch it.
		const tabs = getDynamicTabs();
		expect(tabs).toHaveLength(2);
		expect(new Set(tabs.map((t) => t.id)).size).toBe(2);
		expect(reopened).toBe('nav:a1');
		expect(tabs[1].artifactId).toBe('a1');
		expect(tabs[1].title).toBe('Sensors');
		// …and the reopened tab really serves the ORIGINAL, not the fork's draft
		// (ensureDraft early-returns an existing draft under the same key).
		const original = await ensureDraft(reopened);
		expect(original.artifactId).toBe('a1');
		expect(original.name).toBe('Sensors');
	});

	it('carries the tab’s per-node preview state onto the fork’s new tab key', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		await ensureDraft('nav:a1'); // root expanded by default + auto-runs
		expect(getPreview('nav:a1', [])?.total).toBe(1);

		await saveAsDraft('nav:a1', 'Copy');

		const forkTab = `nav:${stagedTempId()}`;
		expect(getPreview(forkTab, [])?.total).toBe(1);
		expect(isNodeVisible(forkTab, [])).toBe(true);
		// The retired key keeps nothing (or a reopened original would inherit it).
		expect(getPreview('nav:a1', [])).toBeUndefined();
		expect(isNodeVisible('nav:a1', [])).toBe(false);
	});

	it('refuses a name another navigation already uses', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [header('a2', 'Taken')] });
		await loadArtifacts();
		await ensureDraft('nav:a1');

		await expect(saveAsDraft('nav:a1', 'Taken')).rejects.toThrow(/named "Taken" already exists/);
		expect(getStagedArtifactOps()).toEqual([]);
		// The original tab/draft is left exactly as it was (untouched).
		expect(getDraft('nav:a1')?.artifactId).toBe('a1');
		expect(getDraft('nav:a1')?.name).toBe('Sensors');
	});
});

describe('staged-artifact listeners', () => {
	/** Stage a create from a fresh draft tab; returns [tabId, tempId]. */
	async function stageCreate(name = 'Mine'): Promise<[string, string]> {
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		setDraftName(tabId, name);
		await saveDraft(tabId);
		return [tabId, getDraft(tabId)!.artifactId!];
	}

	it('a commit rebinds a temp draft to its canonical id, carrying per-node state', async () => {
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		updateDefinition(tabId, runnablePath('A'));
		await runPreview(tabId, []);
		setCardCollapsed(tabId, [], true);
		selectNode(tabId, []);
		setDraftName(tabId, 'Mine');
		await saveDraft(tabId);
		const tempId = getDraft(tabId)!.artifactId!;

		notifyArtifactCommit({
			idMap: { [tempId]: 'a9' },
			changed: [header('a9', 'Mine', 7)],
			deletedIds: []
		});

		expect(getDraft(tabId)).toBeUndefined();
		const bound = getDraft('nav:a9')!;
		expect(bound.artifactId).toBe('a9');
		expect(bound.artifactRev).toBe(7);
		expect(getDynamicTabs()[0].id).toBe('nav:a9');
		expect(getDynamicTabs()[0].artifactId).toBe('a9');
		// Per-node state follows the rebind, as it used to on first save.
		expect(getPreview('nav:a9', [])?.total).toBe(1);
		expect(getPreview(tabId, [])).toBeUndefined();
		expect(isNodeVisible('nav:a9', [])).toBe(true);
		expect(isCardCollapsed('nav:a9', [])).toBe(true);
		expect(getSelectedPath('nav:a9')).toEqual([]);
	});

	it('a commit adopts the new artifact_rev on an already-saved draft', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await ensureDraft('nav:a1');
		expect(getDraft('nav:a1')?.artifactRev).toBe(4);

		notifyArtifactCommit({ idMap: {}, changed: [header('a1', 'Sensors', 9)], deletedIds: [] });

		expect(getDraft('nav:a1')?.artifactRev).toBe(9);
		expect(getDraft('nav:a1')?.artifactId).toBe('a1');
	});

	it('a committed delete closes the artifact’s open tab', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		await ensureDraft('nav:a1');

		notifyArtifactCommit({ idMap: {}, changed: [], deletedIds: ['a1'] });

		expect(getDraft('nav:a1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('a staged delete closes the artifact’s open tab immediately', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		await ensureDraft('nav:a1');

		stageArtifactDelete('a1', header('a1', 'Sensors', 4));

		expect(getDraft('nav:a1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('discarding a staged update re-dirties the draft', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await ensureDraft('nav:a1');
		await saveDraft('nav:a1');
		expect(getDraft('nav:a1')?.dirty).toBe(false);

		revertStagedArtifact('a1');

		expect(getDraft('nav:a1')?.dirty).toBe(true);
		expect(getDraft('nav:a1')?.artifactId).toBe('a1');
	});

	it('discarding a staged create unbinds the draft back to unsaved', async () => {
		const [tabId, tempId] = await stageCreate();

		revertStagedArtifact(tempId);

		const draft = getDraft(tabId)!;
		expect(draft.artifactId).toBeNull();
		expect(draft.artifactRev).toBeNull();
		expect(draft.dirty).toBe(true);
		// The tab was never re-keyed, so it is still the draft tab it started as —
		// and its record unbinds with the draft (the temp id will never exist).
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBeNull();
	});

	it('discarding a save-as fork leaves an unbound tab that cannot collide', async () => {
		asEditor();
		mockAcquire();
		mockGetArtifact();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		await ensureDraft('nav:a1');
		await saveAsDraft('nav:a1', 'Copy');
		const tempId = stagedTempId();

		revertStagedArtifact(tempId);

		// The fork stays where it is, as an unbound (unsaved) draft named Copy.
		const forkTab = `nav:${tempId}`;
		expect(getDraft(forkTab)?.artifactId).toBeNull();
		expect(getDraft(forkTab)?.name).toBe('Copy');
		expect(getDraft(forkTab)?.dirty).toBe(true);
		expect(getDynamicTabs()[0].id).toBe(forkTab);
		expect(getDynamicTabs()[0].artifactId).toBeNull();
		// Its key holds a client-minted `tmp_` id, which no artifact id can ever
		// equal — so reopening the original still gets a DISTINCT tab.
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		const tabs = getDynamicTabs();
		expect(tabs).toHaveLength(2);
		expect(new Set(tabs.map((t) => t.id)).size).toBe(2);
	});
});

describe('navigation preview staleness + pagination', () => {
	it('discards an in-flight runPreview response after updateDefinition', async () => {
		await ensureDraft('nav:draft:1');
		const d = deferred<typeof CHAIN_PAGE>();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockImplementation(() => d.promise);
		const inflight = runPreview('nav:draft:1');
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		expect(getPreview('nav:draft:1')).toBeUndefined();
		d.resolve(CHAIN_PAGE);
		await inflight;
		// The stale response must not revive a preview next to a dirty draft.
		expect(getPreview('nav:draft:1')).toBeUndefined();
		expect(getDraft('nav:draft:1')?.dirty).toBe(true);
	});

	it('discards an in-flight runPreview response after closeDraft', async () => {
		await ensureDraft('nav:draft:1');
		const d = deferred<typeof CHAIN_PAGE>();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockImplementation(() => d.promise);
		const inflight = runPreview('nav:draft:1');
		closeDraft('nav:draft:1');
		d.resolve(CHAIN_PAGE);
		await inflight;
		expect(getPreview('nav:draft:1')).toBeUndefined();
	});

	it('discards a stale loadMorePreview response after updateDefinition', async () => {
		await ensureDraft('nav:draft:1');
		const d = deferred<typeof PAGE_2>();
		vi.spyOn(artifactsApi, 'evaluateNavigation')
			.mockResolvedValueOnce(PAGE_1)
			.mockImplementationOnce(() => d.promise);
		await runPreview('nav:draft:1');
		const inflight = loadMorePreview('nav:draft:1');
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		d.resolve(PAGE_2);
		await inflight;
		expect(getPreview('nav:draft:1')).toBeUndefined();
	});

	it('loadMorePreview appends the next page at offset = chains.length', async () => {
		await ensureDraft('nav:draft:1');
		const evaluate = vi
			.spyOn(artifactsApi, 'evaluateNavigation')
			.mockResolvedValueOnce(PAGE_1)
			.mockResolvedValueOnce(PAGE_2);
		await runPreview('nav:draft:1');
		expect(getPreview('nav:draft:1')?.chains).toHaveLength(1);
		await loadMorePreview('nav:draft:1');
		expect(evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100, offset: 1 }));
		const preview = getPreview('nav:draft:1')!;
		expect(preview.chains.map((c) => ('kind' in c[0] ? undefined : c[0].id))).toEqual(['b1', 'b2']);
		expect(preview.total).toBe(2);
		expect(preview.loading).toBe(false);
		// Fully paged: a further call must not fetch again.
		await loadMorePreview('nav:draft:1');
		expect(evaluate).toHaveBeenCalledTimes(2);
	});

	it('runPreview stores warnings from the evaluate response', async () => {
		await ensureDraft('nav:draft:1');
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({
			...CHAIN_PAGE,
			warnings: [{ code: 'nav_step_failed', occurrences: 1, total: 0, detail: 'divide by zero' }]
		});
		await runPreview('nav:draft:1');
		expect(getPreview('nav:draft:1')?.warnings).toEqual([
			{ code: 'nav_step_failed', occurrences: 1, total: 0, detail: 'divide by zero' }
		]);
	});

	it('loadMorePreview keeps the first page’s warnings even when the second page carries none', async () => {
		await ensureDraft('nav:draft:1');
		vi.spyOn(artifactsApi, 'evaluateNavigation')
			.mockResolvedValueOnce({
				...PAGE_1,
				warnings: [{ code: 'nav_unknown_ids', occurrences: 1, total: 1, detail: null }]
			})
			.mockResolvedValueOnce({ ...PAGE_2, warnings: [] });
		await runPreview('nav:draft:1');
		expect(getPreview('nav:draft:1')?.warnings).toEqual([
			{ code: 'nav_unknown_ids', occurrences: 1, total: 1, detail: null }
		]);
		await loadMorePreview('nav:draft:1');
		// Second page's (empty) warnings must NOT clobber the first page's.
		expect(getPreview('nav:draft:1')?.warnings).toEqual([
			{ code: 'nav_unknown_ids', occurrences: 1, total: 1, detail: null }
		]);
	});

	it('a failed loadMorePreview restores loading and keeps existing chains', async () => {
		await ensureDraft('nav:draft:1');
		vi.spyOn(artifactsApi, 'evaluateNavigation')
			.mockResolvedValueOnce(PAGE_1)
			.mockRejectedValueOnce(new Error('boom'));
		await runPreview('nav:draft:1');
		// Must resolve (not reject): the caller fires it with `void`.
		await loadMorePreview('nav:draft:1');
		const preview = getPreview('nav:draft:1')!;
		expect(preview.loading).toBe(false);
		expect(preview.chains).toHaveLength(1);
	});
});

describe('node-scoped previews', () => {
	it('runs a preview for the root node and stores it under the root key', async () => {
		const tabId = 'nav:draft:1';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnablePath());
		expect(isNodeVisible(tabId, [])).toBe(true); // root pinned by ensureDraft
		unregisterVisibleNode(tabId, []); // release the pin
		registerVisibleNode(tabId, []); // re-register → immediate run
		await flushEvaluate();
		expect(getPreview(tabId, [])).toBeDefined();
		expect(getPreview(tabId, [])?.total).toBe(1);
	});

	it('unregistering the last reference to a node drops its preview', async () => {
		const tabId = 'nav:draft:2';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnablePath());
		await runPreview(tabId, []);
		expect(getPreview(tabId, [])).toBeDefined();
		unregisterVisibleNode(tabId, []); // release the last reference to the root
		expect(getPreview(tabId, [])).toBeUndefined();
		expect(isNodeVisible(tabId, [])).toBe(false);
	});

	it('a stale evaluate response for an edited node is dropped', async () => {
		const tabId = 'nav:draft:3';
		await ensureDraft(tabId);
		updateDefinition(tabId, runnablePath()); // root is expanded + runnable
		const d = deferred<typeof CHAIN_PAGE>();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockImplementation(() => d.promise);
		const inflight = runPreview(tabId, []);
		// Edit the same node: bumps the root key's generation, clears its preview.
		updateDefinition(tabId, runnablePath('Service'));
		expect(getPreview(tabId, [])).toBeUndefined();
		d.resolve(CHAIN_PAGE); // the old, now-stale response arrives
		await inflight;
		// The stale payload must NOT revive the preview for the edited node.
		expect(getPreview(tabId, [])).toBeUndefined();
	});
});

describe('isRunnable', () => {
	it('a pristine empty path draft is not runnable', () => {
		expect(
			isRunnable({
				kind: 'path',
				schema_version: 1,
				start: { kind: 'scope', types: [], criteria: [] },
				steps: [],
				exclude_visited: true
			})
		).toBe(false);
	});

	it('a path with a start type but no steps is runnable', () => {
		expect(
			isRunnable({
				kind: 'path',
				schema_version: 1,
				start: { kind: 'scope', types: ['B'], criteria: [] },
				steps: [],
				exclude_visited: true
			})
		).toBe(true);
	});

	it('a path with an incomplete step (empty relationship_type) is not runnable', () => {
		expect(
			isRunnable({
				kind: 'path',
				schema_version: 1,
				start: { kind: 'scope', types: [], criteria: [] },
				steps: [
					{
						kind: 'relationship',
						relationship_type: '',
						direction: 'out',
						target_types: [],
						children: []
					}
				],
				exclude_visited: true
			})
		).toBe(false);
	});

	it('a set expression with no operands is not runnable', () => {
		expect(isRunnable({ kind: 'set_op', schema_version: 1, op: 'union', operands: [] })).toBe(
			false
		);
	});

	it('a set expression with at least one operand is runnable', () => {
		expect(
			isRunnable({
				kind: 'set_op',
				schema_version: 1,
				op: 'union',
				operands: [{ ref: 'a1' }]
			})
		).toBe(true);
	});
});

describe('debounced auto-run', () => {
	it('schedules a run 400ms after an edit', async () => {
		vi.useFakeTimers();
		await ensureDraft('nav:draft:1');
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		expect(evaluate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(399);
		expect(evaluate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(getPreview('nav:draft:1')?.total).toBe(1);
	});

	it('collapses two edits within the debounce window into one run with the latest definition', async () => {
		vi.useFakeTimers();
		await ensureDraft('nav:draft:1');
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		await vi.advanceTimersByTimeAsync(200); // still within the window
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['C'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		await vi.advanceTimersByTimeAsync(200); // 400ms since edit 1, but the timer was reset
		expect(evaluate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(200); // 400ms since edit 2
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledWith(
			expect.objectContaining({
				definition: expect.objectContaining({
					start: { kind: 'scope', types: ['C'], criteria: [] }
				})
			})
		);
	});

	it('does not run when a step has an empty relationship_type', async () => {
		vi.useFakeTimers();
		await ensureDraft('nav:draft:1');
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] },
			steps: [
				{
					kind: 'relationship',
					relationship_type: '',
					direction: 'out',
					target_types: [],
					children: []
				}
			],
			exclude_visited: true
		});
		await vi.advanceTimersByTimeAsync(400);
		expect(evaluate).not.toHaveBeenCalled();
		expect(getPreview('nav:draft:1')).toBeUndefined();
	});

	it('does not run for a pristine empty draft', async () => {
		vi.useFakeTimers();
		await ensureDraft('nav:draft:1');
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		// An edit that leaves the definition pristine (e.g. a no-op re-set).
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: [], criteria: [] },
			steps: [],
			exclude_visited: false // toggling only the flag doesn't make it non-pristine
		});
		await vi.advanceTimersByTimeAsync(400);
		expect(evaluate).not.toHaveBeenCalled();
		expect(getPreview('nav:draft:1')).toBeUndefined();
	});

	it('closeDraft cancels a pending debounce timer', async () => {
		vi.useFakeTimers();
		await ensureDraft('nav:draft:1');
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		closeDraft('nav:draft:1');
		await vi.advanceTimersByTimeAsync(1000);
		expect(evaluate).not.toHaveBeenCalled();
	});

	it('resetNavigationEditors cancels a pending debounce timer', async () => {
		vi.useFakeTimers();
		await ensureDraft('nav:draft:1');
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		resetNavigationEditors();
		await vi.advanceTimersByTimeAsync(1000);
		expect(evaluate).not.toHaveBeenCalled();
	});

	it('a debounce fired after a later edit uses the CURRENT definition, not the one at schedule time', async () => {
		vi.useFakeTimers();
		await ensureDraft('nav:draft:1');
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['B'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		// Advance almost to firing, then edit again right before it fires. The
		// second edit resets the timer AND is the definition that must be sent.
		await vi.advanceTimersByTimeAsync(399);
		updateDefinition('nav:draft:1', {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: ['D'], criteria: [] },
			steps: [],
			exclude_visited: true
		});
		await vi.advanceTimersByTimeAsync(400);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledWith(
			expect.objectContaining({
				definition: expect.objectContaining({
					start: { kind: 'scope', types: ['D'], criteria: [] }
				})
			})
		);
	});

	it('ensureDraft on a saved artifact triggers an immediate run (no debounce)', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			entry_points: null,
			payload: {
				kind: 'path',
				schema_version: 1,
				start: { kind: 'scope', types: ['B'], criteria: [] },
				steps: [],
				exclude_visited: true
			}
		});
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await ensureDraft('nav:a1');
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(getPreview('nav:a1')?.total).toBe(1);
	});

	it('ensureDraft on a saved artifact with a pristine definition does not auto-run', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			entry_points: null,
			payload: {
				kind: 'path',
				schema_version: 1,
				start: { kind: 'scope', types: [], criteria: [] },
				steps: [],
				exclude_visited: true
			}
		});
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		await ensureDraft('nav:a1');
		expect(evaluate).not.toHaveBeenCalled();
	});
});

describe('exclude_visited', () => {
	it('the empty path draft defaults exclude_visited to true', async () => {
		const draft = await ensureDraft('nav:draft:1');
		expect((draft.definition as { exclude_visited: boolean }).exclude_visited).toBe(true);
	});

	it('is togglable via updateDefinition, marking the draft dirty', async () => {
		const draft = await ensureDraft('nav:draft:1');
		updateDefinition('nav:draft:1', { ...draft.definition, exclude_visited: false } as never);
		const updated = getDraft('nav:draft:1')!;
		expect((updated.definition as { exclude_visited: boolean }).exclude_visited).toBe(false);
		expect(updated.dirty).toBe(true);
	});
});

describe('evaluation error surfacing', () => {
	function runnableDef(types: string[] = ['B']) {
		return {
			kind: 'path' as const,
			schema_version: 1,
			start: { kind: 'scope' as const, types, criteria: [] },
			steps: [],
			exclude_visited: true
		};
	}

	it('a failed auto-run sets the eval-error state', async () => {
		vi.useFakeTimers();
		await ensureDraft('nav:draft:1');
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockRejectedValue(new Error('boom'));
		updateDefinition('nav:draft:1', runnableDef());
		expect(getEvalError('nav:draft:1')).toBe(false); // not before the run fires
		await vi.advanceTimersByTimeAsync(400);
		expect(getEvalError('nav:draft:1')).toBe(true);
		expect(getPreview('nav:draft:1')).toBeUndefined();
	});

	it('a subsequent successful edit + run clears the eval-error state', async () => {
		vi.useFakeTimers();
		await ensureDraft('nav:draft:1');
		vi.spyOn(artifactsApi, 'evaluateNavigation')
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce(CHAIN_PAGE);
		updateDefinition('nav:draft:1', runnableDef());
		await vi.advanceTimersByTimeAsync(400);
		expect(getEvalError('nav:draft:1')).toBe(true);
		updateDefinition('nav:draft:1', runnableDef(['C']));
		// The edit itself clears the stale error immediately (the preview slot
		// must always match what's on screen — same rule as the preview).
		expect(getEvalError('nav:draft:1')).toBe(false);
		await vi.advanceTimersByTimeAsync(400);
		expect(getEvalError('nav:draft:1')).toBe(false);
		expect(getPreview('nav:draft:1')?.total).toBe(1);
	});

	it('an error response arriving after a newer edit does NOT set the eval-error state', async () => {
		await ensureDraft('nav:draft:1');
		const d = deferred<typeof CHAIN_PAGE>();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockImplementation(() => d.promise);
		const inflight = runPreview('nav:draft:1').catch(() => {});
		updateDefinition('nav:draft:1', runnableDef()); // bumps the generation
		d.reject(new Error('boom'));
		await inflight;
		// Stale failure: it belongs to a definition that is no longer on screen.
		expect(getEvalError('nav:draft:1')).toBe(false);
	});

	it('closeDraft clears the eval-error state', async () => {
		await ensureDraft('nav:draft:1');
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockRejectedValue(new Error('boom'));
		await runPreview('nav:draft:1').catch(() => {});
		expect(getEvalError('nav:draft:1')).toBe(true);
		closeDraft('nav:draft:1');
		expect(getEvalError('nav:draft:1')).toBe(false);
	});
});

describe('structural edits keep per-node state attached to nodes', () => {
	/** union of `paths` as a runnable root combine. */
	function combineOf(...types: string[]) {
		return {
			kind: 'set_op' as const,
			schema_version: 2,
			op: 'union' as const,
			operands: types.map((t) => ({ definition: runnablePath(t), step_index: null }))
		};
	}

	it('an expanded operand keeps auto-running after an earlier sibling is removed', async () => {
		vi.useFakeTimers();
		const tabId = 'nav:draft:1';
		await ensureDraft(tabId);
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, combineOf('A', 'B', 'C'));
		await vi.advanceTimersByTimeAsync(400);
		registerVisibleNode(tabId, [2]); // expand operand C → immediate run
		await vi.advanceTimersByTimeAsync(0);
		expect(getPreview(tabId, [2])).toBeDefined();
		evaluate.mockClear();

		// Remove operand 0 (A): C moves from index 2 to index 1. Its expansion —
		// and thus its auto-run — must follow the NODE, not the position.
		const draft = getDraft(tabId)!;
		applyStructuralEdit(tabId, removeOperandEdit(draft.definition, [], 0));
		expect(isNodeVisible(tabId, [1])).toBe(true);
		expect(isNodeVisible(tabId, [2])).toBe(false);
		await vi.advanceTimersByTimeAsync(400);
		// Root (still expanded) + moved operand C both re-ran.
		expect(
			evaluate.mock.calls.some(
				([req]) =>
					(req as { definition: { kind: string; start?: { types?: string[] } } }).definition.start
						?.types?.[0] === 'C'
			)
		).toBe(true);
		expect(getPreview(tabId, [1])).toBeDefined();
	});

	it('expansion follows the moved operand on reorder', async () => {
		vi.useFakeTimers();
		const tabId = 'nav:draft:1';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, combineOf('A', 'B'));
		await vi.advanceTimersByTimeAsync(400);
		registerVisibleNode(tabId, [0]); // expand operand A
		await vi.advanceTimersByTimeAsync(0);

		const draft = getDraft(tabId)!;
		applyStructuralEdit(tabId, moveOperandEdit(draft.definition, [], 0, 'down'));
		expect(isNodeVisible(tabId, [1])).toBe(true); // A moved down — expansion followed
		expect(isNodeVisible(tabId, [0])).toBe(false);
	});

	it('auto-wrap moves the root expansion (and its preview) to operand 0', async () => {
		vi.useFakeTimers();
		const tabId = 'nav:draft:1';
		await ensureDraft(tabId); // root expanded by default
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnablePath('A'));
		await vi.advanceTimersByTimeAsync(400);
		expect(getPreview(tabId, [])).toBeDefined();
		evaluate.mockClear();

		const draft = getDraft(tabId)!;
		applyStructuralEdit(tabId, insertNavigationEdit(draft.definition, []));
		// The built path travelled to operand 0 — its visibility + selection follow it.
		expect(isNodeVisible(tabId, [0])).toBe(true);
		expect(pathKey(getSelectedPath(tabId))).toBe('0');
		expect(getPreview(tabId, [])).toBeUndefined(); // invalidated by the edit
		await vi.advanceTimersByTimeAsync(400);
		// Operand 0 (the moved path) re-ran with its own definition…
		expect(getPreview(tabId, [0])).toBeDefined();
		expect(evaluate).toHaveBeenCalledWith(
			expect.objectContaining({ definition: expect.objectContaining({ kind: 'path' }) })
		);
		// …and the pinned root (now the Combine) re-ran too — accepted cost of
		// every VISIBLE node keeping a live status chip.
		expect(evaluate).toHaveBeenCalledWith(
			expect.objectContaining({ definition: expect.objectContaining({ kind: 'set_op' }) })
		);
	});

	it('unwrap lifts the surviving operand’s expansion onto the parent', async () => {
		vi.useFakeTimers();
		const tabId = 'nav:draft:1';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, combineOf('A', 'B'));
		await vi.advanceTimersByTimeAsync(400);
		registerVisibleNode(tabId, [1]); // expand operand B only
		await vi.advanceTimersByTimeAsync(0);

		// Remove operand A: the combine unwraps and B becomes the root. B was
		// visible, and the root pin keeps the root visible regardless, so the
		// root must stay visible and keep auto-running.
		const draft = getDraft(tabId)!;
		applyStructuralEdit(tabId, removeOperandEdit(draft.definition, [], 0));
		expect(isNodeVisible(tabId, [])).toBe(true);
		await vi.advanceTimersByTimeAsync(400);
		expect(getPreview(tabId, [])).toBeDefined();
	});
});

describe('auto-run survives the commit tab rebind', () => {
	function runnableDef() {
		return {
			kind: 'path' as const,
			schema_version: 2,
			start: { kind: 'scope' as const, types: ['B'], criteria: [] },
			steps: [],
			exclude_visited: true
		};
	}

	/** Land the commit that turns this tab's staged create into artifact `a9`. */
	function commitCreate(tabId: string): void {
		const tempId = getDraft(tabId)!.artifactId!;
		notifyArtifactCommit({
			idMap: { [tempId]: 'a9' },
			changed: [header('a9', 'Mine')],
			deletedIds: []
		});
	}

	it('a pending debounced run is rescheduled under the rebound tab id', async () => {
		vi.useFakeTimers();
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnableDef());
		// The commit lands INSIDE the debounce window: the run must not be lost.
		await saveDraft(tabId);
		commitCreate(tabId);
		expect(getPreview('nav:a9')).toBeUndefined(); // not yet — still debounced
		await vi.advanceTimersByTimeAsync(400);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(getPreview('nav:a9')?.total).toBe(1);
		expect(getPreview('nav:a9')?.loading).toBe(false);
	});

	it('an in-flight run is re-issued under the rebound tab id (no stuck loading)', async () => {
		vi.useFakeTimers();
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		const first = deferred<typeof CHAIN_PAGE>();
		const evaluate = vi
			.spyOn(artifactsApi, 'evaluateNavigation')
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnableDef());
		await vi.advanceTimersByTimeAsync(400); // debounce fires → run in flight
		expect(getPreview(tabId)?.loading).toBe(true);
		await saveDraft(tabId);
		commitCreate(tabId); // rebind while the evaluate is still in flight
		first.resolve(CHAIN_PAGE); // the old response is orphaned by the rebind
		await vi.advanceTimersByTimeAsync(0);
		// The preview must settle via a re-issued run, not hang on loading.
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(getPreview('nav:a9')?.loading).toBe(false);
		expect(getPreview('nav:a9')?.total).toBe(1);
	});
});

describe('visible-node registration', () => {
	it('registering a runnable node runs it immediately (fire-and-forget)', async () => {
		const tabId = 'nav:draft:vis1';
		await ensureDraft(tabId);
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [{ definition: runnablePath('A'), step_index: null }]
		});
		evaluate.mockClear();
		registerVisibleNode(tabId, [0]);
		await flushEvaluate();
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(getPreview(tabId, [0])?.total).toBe(1);
	});

	it('registering does NOT double-fire a run that is already scheduled', async () => {
		vi.useFakeTimers();
		const tabId = 'nav:draft:vis2';
		await ensureDraft(tabId);
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		registerVisibleNode(tabId, []); // count 2 (root pinned by ensureDraft)
		updateDefinition(tabId, runnablePath('A')); // schedules the debounced run
		registerVisibleNode(tabId, []); // count 3 — must not fire immediately
		expect(evaluate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(400);
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	it('is refcounted: a node stays live while another reference holds it', async () => {
		vi.useFakeTimers();
		const tabId = 'nav:draft:vis3';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnablePath('A'));
		await vi.advanceTimersByTimeAsync(400);
		registerVisibleNode(tabId, []); // a second holder (the card component)
		unregisterVisibleNode(tabId, []); // that holder goes away…
		expect(isNodeVisible(tabId, [])).toBe(true); // …the pin keeps it live
		expect(getPreview(tabId, [])).toBeDefined();
		unregisterVisibleNode(tabId, []); // release the pin too
		expect(isNodeVisible(tabId, [])).toBe(false);
		expect(getPreview(tabId, [])).toBeUndefined();
	});

	it('unregistering the last reference orphans an in-flight evaluate', async () => {
		const tabId = 'nav:draft:vis4';
		await ensureDraft(tabId);
		const d = deferred<typeof CHAIN_PAGE>();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockImplementation(() => d.promise);
		updateDefinition(tabId, runnablePath('A'));
		const inflight = runPreview(tabId, []);
		unregisterVisibleNode(tabId, []); // releases the root pin
		d.resolve(CHAIN_PAGE);
		await inflight;
		expect(getPreview(tabId, [])).toBeUndefined();
	});
});

describe('node selection', () => {
	function combine2() {
		return {
			kind: 'set_op' as const,
			schema_version: 2,
			op: 'union' as const,
			operands: [
				{ definition: runnablePath('A'), step_index: null },
				{ definition: runnablePath('B'), step_index: null }
			]
		};
	}

	it('defaults to the root node', async () => {
		await ensureDraft('nav:draft:sel1');
		expect(getSelectedPath('nav:draft:sel1')).toEqual([]);
	});

	it('selectNode stores the node path', async () => {
		const tabId = 'nav:draft:sel2';
		await ensureDraft(tabId);
		updateDefinition(tabId, combine2());
		selectNode(tabId, [1]);
		expect(getSelectedPath(tabId)).toEqual([1]);
	});

	it('a structural edit remaps the selection through remapPath', async () => {
		const tabId = 'nav:draft:sel3';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: runnablePath('A'), step_index: null },
				{ definition: runnablePath('B'), step_index: null },
				{ definition: runnablePath('C'), step_index: null }
			]
		});
		selectNode(tabId, [2]); // C
		applyStructuralEdit(tabId, removeOperandEdit(getDraft(tabId)!.definition, [], 0));
		expect(getSelectedPath(tabId)).toEqual([1]); // C followed its node
	});

	it('a removed selected node falls back to the root', async () => {
		const tabId = 'nav:draft:sel4';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, combine2());
		selectNode(tabId, [0]);
		applyStructuralEdit(tabId, removeOperandEdit(getDraft(tabId)!.definition, [], 0));
		expect(getSelectedPath(tabId)).toEqual([]);
	});

	it('auto-wrap carries the selection onto operand 0', async () => {
		const tabId = 'nav:draft:sel5';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnablePath('A'));
		applyStructuralEdit(tabId, insertNavigationEdit(getDraft(tabId)!.definition, []));
		expect(getSelectedPath(tabId)).toEqual([0]);
	});

	it('a field edit that deletes the selected node falls back to the root', async () => {
		const tabId = 'nav:draft:sel6';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		// A path whose START is a combination; select the start's operand 0…
		updateDefinition(tabId, { ...runnablePath('A'), start: emptyCombine() });
		selectNode(tabId, ['start', 0]);
		// …then replace the start with a plain scope: the selected node is gone.
		updateDefinition(tabId, runnablePath('A'));
		expect(getSelectedPath(tabId)).toEqual([]);
	});

	it('rekeyTab carries the selection across the commit rebind', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, combine2());
		selectNode(tabId, [1]);
		await saveDraft(tabId);
		const tempId = getDraft(tabId)!.artifactId!;
		// Staging alone must not move anything — the tab is re-keyed on commit.
		expect(getSelectedPath(tabId)).toEqual([1]);
		notifyArtifactCommit({
			idMap: { [tempId]: 'a9' },
			changed: [header('a9', 'Mine')],
			deletedIds: []
		});
		expect(getSelectedPath('nav:a9')).toEqual([1]);
		expect(getSelectedPath(tabId)).toEqual([]); // the retired tab keeps nothing
	});

	it('closeDraft clears the selection', async () => {
		const tabId = 'nav:draft:sel8';
		await ensureDraft(tabId);
		updateDefinition(tabId, combine2());
		selectNode(tabId, [1]);
		closeDraft(tabId);
		expect(getSelectedPath(tabId)).toEqual([]);
	});
});

describe('embedded drafts', () => {
	it('creates a pinned draft and runs the root preview with the row binding', async () => {
		const evalSpy = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		const draft = ensureEmbeddedDraft('navemb:t1', emptyRowPath(), {
			rowContext: true,
			rowElementId: 'e1'
		});
		expect(draft.embedded).toEqual({ rowContext: true, rowElementId: 'e1' });
		await vi.waitFor(() => expect(getPreview('navemb:t1')?.loading).toBe(false));
		expect(evalSpy).toHaveBeenCalledWith(expect.objectContaining({ row_element_id: 'e1' }));
	});

	it('skips previews for a row-rooted draft with no bound row (no 422 surfacing)', async () => {
		const evalSpy = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		ensureEmbeddedDraft('navemb:t2', emptyRowPath(), { rowContext: true, rowElementId: null });
		await Promise.resolve();
		expect(evalSpy).not.toHaveBeenCalled();
		expect(getPreview('navemb:t2')).toBeUndefined();
		expect(getEvalError('navemb:t2')).toBe(false);
	});

	it('setEmbeddedRowElement re-runs expanded previews under the new binding', async () => {
		const evalSpy = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		ensureEmbeddedDraft('navemb:t3', emptyRowPath(), { rowContext: true, rowElementId: null });
		setEmbeddedRowElement('navemb:t3', 'e9');
		await vi.waitFor(
			() => expect(evalSpy).toHaveBeenCalledWith(expect.objectContaining({ row_element_id: 'e9' })),
			{ timeout: 2000 } // updateDefinition's sweep debounces (AUTO_RUN_DEBOUNCE_MS)
		);
		expect(getDraft('navemb:t3')?.embedded?.rowElementId).toBe('e9');
	});

	it('rejects saveDraft/saveAsDraft on an embedded draft', async () => {
		ensureEmbeddedDraft('navemb:t4', emptyRowPath(), { rowContext: true, rowElementId: null });
		await expect(saveDraft('navemb:t4')).rejects.toThrow(/cannot be saved/);
		await expect(saveAsDraft('navemb:t4', 'x')).rejects.toThrow(/cannot be saved/);
	});

	it('rejects a non-navemb id', () => {
		expect(() =>
			ensureEmbeddedDraft('nav:draft:x', emptyRowPath(), { rowContext: true, rowElementId: null })
		).toThrow(/navemb/);
	});
});

describe('card collapse state', () => {
	it('defaults collapsed for embedded drafts, expanded for standalone', async () => {
		ensureEmbeddedDraft('navemb:t', emptyRowPath(), { rowContext: true, rowElementId: null });
		expect(isCardCollapsed('navemb:t', [])).toBe(true);
		await ensureDraft('nav:draft:standalone');
		expect(isCardCollapsed('nav:draft:standalone', [])).toBe(false);
	});

	it('an explicit toggle survives definition updates and structural edits', () => {
		ensureEmbeddedDraft('navemb:t2', emptyRowPath(), { rowContext: true, rowElementId: null });
		setCardCollapsed('navemb:t2', [], false);
		expect(isCardCollapsed('navemb:t2', [])).toBe(false);
		updateDefinition('navemb:t2', emptyRowPath());
		expect(isCardCollapsed('navemb:t2', [])).toBe(false);
	});

	it('an explicit per-node toggle follows the node through a structural edit remap', async () => {
		const tabId = 'nav:draft:collapse-remap';
		await ensureDraft(tabId);
		updateDefinition(tabId, {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: runnablePath('A'), step_index: null },
				{ definition: runnablePath('B'), step_index: null },
				{ definition: runnablePath('C'), step_index: null }
			]
		});
		// C starts collapsed (standalone default is expanded — flip it explicitly
		// so the override, not the default, is what must travel).
		setCardCollapsed(tabId, [2], true);
		applyStructuralEdit(tabId, removeOperandEdit(getDraft(tabId)!.definition, [], 0));
		// C moved from index 2 to index 1 — its explicit collapse choice follows.
		expect(isCardCollapsed(tabId, [1])).toBe(true);
	});

	it('a structural edit drops the collapse override for a removed node', async () => {
		const tabId = 'nav:draft:collapse-drop';
		await ensureDraft(tabId);
		updateDefinition(tabId, {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: runnablePath('A'), step_index: null },
				{ definition: runnablePath('B'), step_index: null }
			]
		});
		setCardCollapsed(tabId, [0], true);
		applyStructuralEdit(tabId, removeOperandEdit(getDraft(tabId)!.definition, [], 0));
		// Operand A (and its override) is gone; the surviving node at [0] (B, a
		// standalone default) must not inherit A's stale override.
		expect(isCardCollapsed(tabId, [0])).toBe(false);
	});

	it('rekeyTab (commit rebind) carries the collapse override to the new tab id', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		setCardCollapsed(tabId, [], true);
		await saveDraft(tabId);
		notifyArtifactCommit({
			idMap: { [getDraft(tabId)!.artifactId!]: 'a9' },
			changed: [header('a9', 'Mine')],
			deletedIds: []
		});
		expect(isCardCollapsed('nav:a9', [])).toBe(true);
	});

	it('closeDraft drops the collapse override', async () => {
		const tabId = 'nav:draft:collapse-close';
		await ensureDraft(tabId);
		setCardCollapsed(tabId, [], true);
		closeDraft(tabId);
		// Re-fetching a fresh draft under the same id must not inherit the old
		// override — the standalone default (expanded) applies again.
		await ensureDraft(tabId);
		expect(isCardCollapsed(tabId, [])).toBe(false);
	});

	it('resetNavigationEditors drops every collapse override', async () => {
		const tabId = 'nav:draft:collapse-reset';
		await ensureDraft(tabId);
		setCardCollapsed(tabId, [], true);
		resetNavigationEditors();
		await ensureDraft(tabId);
		expect(isCardCollapsed(tabId, [])).toBe(false);
	});
});
