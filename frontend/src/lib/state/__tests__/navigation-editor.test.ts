import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import {
	closeDraft,
	ensureDraft,
	getDraft,
	getPreview,
	getSaveConflict,
	loadMorePreview,
	resetNavigationEditors,
	runPreview,
	saveDraft,
	updateDefinition
} from '../navigation-editor.svelte';
import { resetWorkspaceTabs, openNavigationTab, getDynamicTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';

const CHAIN_PAGE = {
	step_types: ['Owns'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 1,
	truncated: false
};

/** Two-page result set for pagination tests (PAGE-sized slices are irrelevant:
 * the store trusts the server's `total`, not the page length). */
const PAGE_1 = {
	step_types: ['Owns'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 2,
	truncated: false
};
const PAGE_2 = {
	step_types: ['Owns'],
	chains: [[{ id: 'b2', type_name: 'B', display_name: 'b2', child_count: 0 }]],
	total: 2,
	truncated: false
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

beforeEach(() => {
	resetNavigationEditors();
	resetWorkspaceTabs();
	resetArtifacts();
});
afterEach(() => vi.restoreAllMocks());

describe('navigation editor store', () => {
	it('creates an empty path draft for draft tabs', async () => {
		const draft = await ensureDraft('nav:draft:1');
		expect(draft.definition).toEqual({
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: [], criteria: [] },
			steps: []
		});
		expect(draft.artifactId).toBeNull();
		expect(draft.dirty).toBe(false);
	});

	it('loads the artifact payload for saved tabs', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			payload: {
				kind: 'path',
				schema_version: 1,
				start: { kind: 'scope', types: ['Building'], criteria: [] },
				steps: []
			}
		});
		const draft = await ensureDraft('nav:a1');
		expect(draft.name).toBe('Sensors');
		expect(draft.artifactRev).toBe(4);
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
			steps: []
		});
		expect(getDraft('nav:draft:1')?.dirty).toBe(true);
		expect(getPreview('nav:draft:1')).toBeUndefined();
	});

	it('first save creates the artifact and binds the tab', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		const create = vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue({
			id: 'a9',
			kind: 'navigation',
			name: 'Mine',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: {}
		});
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
		const draft = getDraft(tabId)!;
		draft.name = 'Mine';
		await saveDraft(tabId);
		expect(create).toHaveBeenCalled();
		expect(getDynamicTabs()[0].artifactId).toBe('a9');
		expect(getDraft('nav:a9')?.artifactRev).toBe(1);
	});

	it('save conflict records the server rev from the 409 detail body', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			payload: {
				kind: 'path',
				schema_version: 1,
				start: { kind: 'scope', types: [], criteria: [] },
				steps: []
			}
		});
		await ensureDraft('nav:a1');
		// Mirror what the real client throws: apiFetchRaw parses the FastAPI
		// HTTPException body — {"detail": {"message": ..., "current_rev": N}} —
		// and passes the WHOLE parsed body to errorForStatus (see client.ts).
		vi.spyOn(artifactsApi, 'updateArtifact').mockRejectedValue(
			new ConflictError(
				409,
				{ detail: { message: 'artifact was modified by someone else', current_rev: 7 } },
				'HTTP 409'
			)
		);
		await expect(saveDraft('nav:a1')).rejects.toBeInstanceOf(ConflictError);
		expect(getSaveConflict('nav:a1')).toBe(7);
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
			steps: []
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
			steps: []
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
		expect(preview.chains.map((c) => c[0].id)).toEqual(['b1', 'b2']);
		expect(preview.total).toBe(2);
		expect(preview.loading).toBe(false);
		// Fully paged: a further call must not fetch again.
		await loadMorePreview('nav:draft:1');
		expect(evaluate).toHaveBeenCalledTimes(2);
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
