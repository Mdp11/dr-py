import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import {
	closeDraft,
	ensureDraft,
	getDraft,
	getEvalError,
	getPreview,
	getSaveConflict,
	isRunnable,
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
			schema_version: 1,
			start: { kind: 'scope', types: [], criteria: [] },
			steps: [],
			exclude_visited: true
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

	it('a name-clash 409 on create does NOT enter rev-conflict state', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		const draft = await ensureDraft(tabId);
		draft.name = 'Taken';
		// Mirror what the real client throws for the create-path 409:
		// routes/artifacts.py raises HTTPException(409, detail=f"a navigation
		// named {name!r} already exists") — a plain STRING detail, unlike the
		// update-path's {message, current_rev} object. err.body is the whole
		// parsed body: {"detail": "..."}.
		vi.spyOn(artifactsApi, 'createArtifact').mockRejectedValue(
			new ConflictError(
				409,
				{ detail: "a navigation named 'Taken' already exists" },
				"a navigation named 'Taken' already exists"
			)
		);
		await expect(saveDraft(tabId)).rejects.toBeInstanceOf(ConflictError);
		// No numeric current_rev in the body -> must NOT set a conflict, or the
		// UI's "Reload their version" recovery would wipe this brand-new draft.
		expect(getSaveConflict(tabId)).toBeUndefined();
		// The draft itself must be untouched (name-clash isn't a rev conflict).
		expect(getDraft(tabId)?.name).toBe('Taken');
		expect(getDraft(tabId)?.artifactId).toBeNull();
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
						relationship_type: '',
						direction: 'out',
						target: { kind: 'scope', types: [], criteria: [] },
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
					relationship_type: '',
					direction: 'out',
					target: { kind: 'scope', types: [], criteria: [] },
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
