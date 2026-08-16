import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { isCheckedOutByMe, resetCheckout, setProjectInfo } from '../checkout.svelte';
import {
	closeMetamodelEditor,
	discardMetamodelDraft,
	editMetamodelBuffer,
	getMetamodelEditor,
	initMetamodelEditor,
	isMetamodelEditorDirty,
	METAMODEL_DRAFT_DEBOUNCE_MS,
	METAMODEL_LINT_DEBOUNCE_MS,
	previewMetamodelChanges,
	resetMetamodelEditor,
	retryMetamodelLease
} from '../metamodel-editor.svelte';
import { getStagedMetamodelOps, notifyMetamodelDiscardAll } from '../metamodel-stage.svelte';
import * as mmApi from '$lib/api/metamodel';
import * as lockApi from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import type { LockResponse, MetamodelDiff, RawMetamodel } from '$lib/api/types';

/**
 * The live metamodel editor's state module (Phase 5). Mirrors
 * checkout.metamodel.test.ts's style: spy on the api modules
 * (`$lib/api/metamodel`, `$lib/api/checkout`) rather than mocking whole
 * modules, so the real lease module runs underneath.
 */

const PROJECT = 'p1';
const DRAFT_KEY = `ui.metamodel.draft.${PROJECT}`;
const BASE = '# base\nelements: []\n';
// NOTE (deviation from the task brief's skeleton): each lease carries its OWN
// `token` and an `expires_at` — that is what `LeaseOut` declares and what
// `checkout.svelte`'s `_recordLeases` stores. Without the per-lease token,
// `releaseMetamodelLease` finds `undefined` in the registry and returns
// without ever calling `releaseLock`, so cases 7 and 10 could not observe the
// release at all.
const LEASE: LockResponse = {
	token: 't-mm',
	leases: [
		{
			resource_id: 'mm',
			mode: 'exclusive',
			holder: 'default-user',
			holder_email: 'default@example.com',
			token: 't-mm',
			intent: 'edit',
			expires_at: 1
		}
	]
};
const CONFLICT = new ConflictError(
	409,
	{
		detail: 'lock conflict',
		conflicts: [{ resource_id: 'mm', held_by: 'u2', held_by_email: 'peer@example.com' }]
	},
	'conflict'
);
const DIFF: MetamodelDiff = {
	now_failing: [],
	now_passing: [],
	unchanged_count: 0,
	current_error_count: 0,
	candidate_error_count: 0,
	structural: {
		enums: { added: [], removed: [], changed: [] },
		element_types: { added: [], removed: [], changed: [] },
		relationship_types: { added: [], removed: [], changed: [] }
	}
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

/** Every edit schedules a debounced lint; stub it so no test reaches the
 * network when a timer happens to fire. */
function stubLintOk(): void {
	vi.spyOn(mmApi, 'lintMetamodel').mockResolvedValue({ ok: true, errors: [] });
}

beforeEach(() => {
	localStorage.clear();
	resetCheckout();
	resetMetamodelEditor();
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: BASE, source: 'stored' });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('initMetamodelEditor', () => {
	it('loads the baseline blob into a clean ready buffer', async () => {
		await initMetamodelEditor(PROJECT);

		const v = getMetamodelEditor();
		expect(v.phase).toBe('ready');
		expect(v.buffer).toBe(BASE);
		expect(v.source).toBe('stored');
		expect(v.dirty).toBe(false);
		expect(v.draftRestored).toBe(false);
		expect(v.loadError).toBeNull();
		expect(v.readOnly).toBe(false);
	});

	it('reports a failed load as the error phase instead of an empty buffer', async () => {
		vi.spyOn(mmApi, 'getMetamodelRaw').mockRejectedValue(new Error('metamodel unavailable'));

		await initMetamodelEditor(PROJECT);

		const v = getMetamodelEditor();
		expect(v.phase).toBe('error');
		expect(v.loadError).toBe('metamodel unavailable');
		expect(v.readOnly).toBe(true);
	});
});

describe('editMetamodelBuffer + the mm lease', () => {
	it('marks the buffer dirty and acquires the mm lease exactly once for a burst of edits', async () => {
		stubLintOk();
		const acquire = vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		await initMetamodelEditor(PROJECT);

		editMetamodelBuffer(`${BASE}x`);
		editMetamodelBuffer(`${BASE}xy`);
		await Promise.resolve();
		await Promise.resolve();

		expect(acquire).toHaveBeenCalledOnce();
		expect(isMetamodelEditorDirty()).toBe(true);
		const v = getMetamodelEditor();
		expect(v.buffer).toBe(`${BASE}xy`);
		expect(v.readOnly).toBe(false);
		expect(v.lockedBy).toBeNull();

		// A further edit under a HELD lease acquires nothing more.
		editMetamodelBuffer(`${BASE}xyz`);
		await Promise.resolve();
		await Promise.resolve();
		expect(acquire).toHaveBeenCalledOnce();
	});

	it('turns read-only under the peer holder on a lease conflict, keeping the typed characters', async () => {
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockRejectedValue(CONFLICT);
		await initMetamodelEditor(PROJECT);

		editMetamodelBuffer(`${BASE}typed`);
		await vi.waitFor(() => expect(getMetamodelEditor().lockedBy).toBe('peer@example.com'));

		expect(getMetamodelEditor().readOnly).toBe(true);
		// The refusal never rolls the user's keystrokes back...
		expect(getMetamodelEditor().buffer).toBe(`${BASE}typed`);
		// ...but no further keystroke lands while a peer holds the lease.
		editMetamodelBuffer(`${BASE}more`);
		expect(getMetamodelEditor().buffer).toBe(`${BASE}typed`);
	});

	it('re-attempts the lease on retry and clears the read-only state on a grant', async () => {
		stubLintOk();
		const acquire = vi.spyOn(lockApi, 'acquireLocks').mockRejectedValue(CONFLICT);
		await initMetamodelEditor(PROJECT);

		editMetamodelBuffer(`${BASE}typed`);
		await vi.waitFor(() => expect(getMetamodelEditor().lockedBy).toBe('peer@example.com'));

		acquire.mockResolvedValue(LEASE);
		retryMetamodelLease();
		await vi.waitFor(() => expect(getMetamodelEditor().readOnly).toBe(false));

		expect(getMetamodelEditor().lockedBy).toBeNull();
		expect(acquire).toHaveBeenCalledTimes(2);
		// The lease is now held, so the editor accepts keystrokes again.
		editMetamodelBuffer(`${BASE}again`);
		expect(getMetamodelEditor().buffer).toBe(`${BASE}again`);
	});
});

describe('draft persistence', () => {
	it('mirrors the dirty buffer to localStorage after the debounce and restores it on re-init', async () => {
		vi.useFakeTimers();
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		await initMetamodelEditor(PROJECT);

		editMetamodelBuffer(`${BASE}draft`);
		expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
		await vi.advanceTimersByTimeAsync(METAMODEL_DRAFT_DEBOUNCE_MS);
		expect(localStorage.getItem(DRAFT_KEY)).toBe(`${BASE}draft`);

		// A refresh: the module resets, the draft in storage does not.
		resetMetamodelEditor();
		await initMetamodelEditor(PROJECT);

		const v = getMetamodelEditor();
		expect(v.draftRestored).toBe(true);
		expect(v.buffer).toBe(`${BASE}draft`);
		expect(v.dirty).toBe(true);
	});

	it('discard restores the baseline, clears the stored draft and releases the lease', async () => {
		vi.useFakeTimers();
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		const release = vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		await initMetamodelEditor(PROJECT);

		editMetamodelBuffer(`${BASE}oops`);
		await vi.advanceTimersByTimeAsync(METAMODEL_DRAFT_DEBOUNCE_MS);
		expect(localStorage.getItem(DRAFT_KEY)).toBe(`${BASE}oops`);

		discardMetamodelDraft();

		expect(getMetamodelEditor().buffer).toBe(BASE);
		expect(isMetamodelEditorDirty()).toBe(false);
		expect(getMetamodelEditor().draftRestored).toBe(false);
		expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
		expect(release).toHaveBeenCalledWith('t-mm', undefined);
	});
});

describe('lint', () => {
	it('debounces a burst of edits into one lint call and stores its errors', async () => {
		vi.useFakeTimers();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		const lint = vi
			.spyOn(mmApi, 'lintMetamodel')
			.mockResolvedValue({ ok: false, errors: [{ message: 'bad', line: 2, column: 1 }] });
		await initMetamodelEditor(PROJECT);

		editMetamodelBuffer(`${BASE}a`);
		editMetamodelBuffer(`${BASE}ab`);
		await vi.advanceTimersByTimeAsync(METAMODEL_LINT_DEBOUNCE_MS);

		expect(lint).toHaveBeenCalledOnce();
		expect(lint).toHaveBeenCalledWith(`${BASE}ab`);
		expect(getMetamodelEditor().lintErrors).toEqual([{ message: 'bad', line: 2, column: 1 }]);

		// Lint is advisory: a failed call clears the gutter and never throws.
		lint.mockRejectedValue(new Error('lint offline'));
		editMetamodelBuffer(`${BASE}abc`);
		await vi.advanceTimersByTimeAsync(METAMODEL_LINT_DEBOUNCE_MS);

		expect(getMetamodelEditor().lintErrors).toEqual([]);
	});
});

describe('previewMetamodelChanges', () => {
	it('records the diff for the previewed buffer and invalidates it on the next edit', async () => {
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		const diff = vi.spyOn(mmApi, 'diffMetamodel').mockResolvedValue(DIFF);
		await initMetamodelEditor(PROJECT);
		editMetamodelBuffer(`${BASE}p`);

		await previewMetamodelChanges();

		let v = getMetamodelEditor();
		expect(diff).toHaveBeenCalledWith(`${BASE}p`);
		expect(v.preview).toEqual(DIFF);
		expect(v.previewCurrent).toBe(true);
		expect(v.previewing).toBe(false);
		expect(v.previewError).toBeNull();

		editMetamodelBuffer(`${BASE}pq`);

		v = getMetamodelEditor();
		expect(v.previewCurrent).toBe(false);
		// The stale diff is kept on screen, just no longer current.
		expect(v.preview).toEqual(DIFF);
	});
});

describe('the commit-flow seam (spec 2026-08-16)', () => {
	it('stages the dirty buffer as the rebind blob through the registered provider', async () => {
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		await initMetamodelEditor(PROJECT);
		expect(getStagedMetamodelOps()).toEqual([]);

		editMetamodelBuffer(`${BASE}candidate: true\n`);

		expect(getStagedMetamodelOps()).toEqual([
			{ kind: 'metamodel.rebind', blob: `${BASE}candidate: true\n` }
		]);
	});

	it('discards the draft when checkout announces a discard-all', async () => {
		// The DISCARD half of the seam: `checkout.svelte.ts`'s `discardAll` can
		// only reach this module through the listener registered at the bottom of
		// it (a direct import would close checkout → stage → editor → checkout),
		// so the registration itself is the thing under test.
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		await initMetamodelEditor(PROJECT);
		editMetamodelBuffer(`${BASE}candidate: true\n`);
		expect(isMetamodelEditorDirty()).toBe(true);

		notifyMetamodelDiscardAll();

		expect(isMetamodelEditorDirty()).toBe(false);
		expect(getMetamodelEditor().buffer).toBe(BASE);
		expect(getStagedMetamodelOps()).toEqual([]);
	});
});

describe('closeMetamodelEditor', () => {
	it('generation-guards a load that lands after the editor closed', async () => {
		const d = deferred<RawMetamodel>();
		vi.spyOn(mmApi, 'getMetamodelRaw').mockImplementation(() => d.promise);

		const inflight = initMetamodelEditor(PROJECT);
		expect(getMetamodelEditor().phase).toBe('loading');

		closeMetamodelEditor();
		d.resolve({ blob: BASE, source: 'stored' });
		await inflight;

		const v = getMetamodelEditor();
		expect(v.phase).toBe('idle');
		expect(v.buffer).toBe('');
		expect(v.loadError).toBeNull();
	});

	it('releases a HELD lease', async () => {
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		const release = vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		await initMetamodelEditor(PROJECT);
		editMetamodelBuffer(`${BASE}x`);
		await vi.waitFor(() => expect(isCheckedOutByMe('mm')).toBe(true));

		closeMetamodelEditor();

		expect(release).toHaveBeenCalledWith('t-mm', undefined);
		expect(isCheckedOutByMe('mm')).toBe(false);
	});

	it('releases a lease granted AFTER the close, instead of leaking it forever', async () => {
		stubLintOk();
		const grant = deferred<LockResponse>();
		vi.spyOn(lockApi, 'acquireLocks').mockImplementation(() => grant.promise);
		const release = vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		await initMetamodelEditor(PROJECT);

		editMetamodelBuffer(`${BASE}x`); // starts the acquire...
		closeMetamodelEditor(); // ...which is still in flight here.
		grant.resolve(LEASE);

		// The lease module's generation guard hands the late grant back — but
		// ONLY because the close dropped it unconditionally. A leak here is
		// not TTL-bounded: the registry entry keeps the checkout heartbeat
		// renewing it for the rest of the session.
		await vi.waitFor(() => expect(release).toHaveBeenCalledWith('t-mm', undefined));
		expect(isCheckedOutByMe('mm')).toBe(false);
	});

	it('clears the in-flight preview flag so a reopen is not wedged', async () => {
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		const slowDiff = deferred<MetamodelDiff>();
		const diff = vi.spyOn(mmApi, 'diffMetamodel').mockImplementation(() => slowDiff.promise);
		await initMetamodelEditor(PROJECT);
		editMetamodelBuffer(`${BASE}x`);

		const previewing = previewMetamodelChanges();
		expect(getMetamodelEditor().previewing).toBe(true);
		closeMetamodelEditor();
		slowDiff.resolve(DIFF);
		await previewing;

		expect(getMetamodelEditor().previewing).toBe(false);

		// The reopened editor can actually preview again — the latched flag was
		// the whole failure mode, since every async `finally` here is
		// generation-guarded and a close mid-flight skips it.
		diff.mockResolvedValue(DIFF);
		await initMetamodelEditor(PROJECT);
		editMetamodelBuffer(`${BASE}y`);
		await previewMetamodelChanges();
		expect(getMetamodelEditor().previewCurrent).toBe(true);
	});

	it('keeps the stored draft when the editor closes before the baseline loaded', async () => {
		const DRAFT = `${BASE}unsaved work\n`;
		localStorage.setItem(DRAFT_KEY, DRAFT);
		const slow = deferred<RawMetamodel>();
		vi.spyOn(mmApi, 'getMetamodelRaw').mockImplementation(() => slow.promise);

		const inflight = initMetamodelEditor(PROJECT);
		expect(getMetamodelEditor().phase).toBe('loading');
		closeMetamodelEditor();

		// Neither a successful rebind nor an explicit discard happened, so the
		// draft is still the user's only copy of that work.
		expect(localStorage.getItem(DRAFT_KEY)).toBe(DRAFT);
		slow.resolve({ blob: BASE, source: 'stored' });
		await inflight;
		expect(localStorage.getItem(DRAFT_KEY)).toBe(DRAFT);

		// Same for a load that FAILED outright.
		vi.spyOn(mmApi, 'getMetamodelRaw').mockRejectedValue(new Error('offline'));
		await initMetamodelEditor(PROJECT);
		expect(getMetamodelEditor().phase).toBe('error');

		closeMetamodelEditor();

		expect(localStorage.getItem(DRAFT_KEY)).toBe(DRAFT);
		// The stale load error does not survive into the next open either.
		expect(getMetamodelEditor().loadError).toBeNull();
	});
});
