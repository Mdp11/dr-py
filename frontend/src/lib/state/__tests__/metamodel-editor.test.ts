import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { isCheckedOutByMe, resetCheckout, setProjectInfo } from '../checkout.svelte';
import {
	closeMetamodelEditor,
	commitMetamodelRebind,
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
import * as mmApi from '$lib/api/metamodel';
import * as lockApi from '$lib/api/checkout';
import { ApiError, ConflictError } from '$lib/api/errors';
import type { LockResponse, MetamodelDiff, RawMetamodel, Rebind } from '$lib/api/types';

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
const REBIND: Rebind = {
	model_rev: 5,
	metamodel_id: 'mm2',
	validation_error_count: 0,
	issue_counts: {},
	issues: []
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

/** The shared pre-state for the rebind cases: ready, edited, lease granted,
 * and previewed for the CURRENT buffer (which is what unlocks a rebind). */
async function initEditedAndPreviewed(): Promise<void> {
	stubLintOk();
	vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
	vi.spyOn(mmApi, 'diffMetamodel').mockResolvedValue(DIFF);
	await initMetamodelEditor(PROJECT);
	editMetamodelBuffer(`${BASE}candidate: true\n`);
	await previewMetamodelChanges();
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

describe('commitMetamodelRebind', () => {
	it('adopts the buffer as the new baseline, clears the draft and releases the lease', async () => {
		vi.useFakeTimers();
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		const release = vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		vi.spyOn(mmApi, 'diffMetamodel').mockResolvedValue(DIFF);
		const rebind = vi.spyOn(mmApi, 'rebindMetamodel').mockResolvedValue(REBIND);
		await initMetamodelEditor(PROJECT);

		editMetamodelBuffer(`${BASE}candidate: true\n`);
		await vi.advanceTimersByTimeAsync(METAMODEL_DRAFT_DEBOUNCE_MS);
		expect(localStorage.getItem(DRAFT_KEY)).toBe(`${BASE}candidate: true\n`);
		await previewMetamodelChanges();

		const res = await commitMetamodelRebind('swap it');

		expect(res?.model_rev).toBe(5);
		expect(rebind).toHaveBeenCalledWith(`${BASE}candidate: true\n`, {
			baseRev: 0,
			message: 'swap it'
		});
		const v = getMetamodelEditor();
		expect(v.dirty).toBe(false);
		expect(v.buffer).toBe(`${BASE}candidate: true\n`);
		expect(v.preview).toBeNull();
		expect(v.previewCurrent).toBe(false);
		expect(v.rebinding).toBe(false);
		expect(v.rebindError).toBeNull();
		expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
		expect(release).toHaveBeenCalledWith('t-mm', undefined);
	});

	it('upgrades a degraded "serialized" source to "stored" once a rebind stored a blob', async () => {
		vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: BASE, source: 'serialized' });
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		await initEditedAndPreviewed();
		expect(getMetamodelEditor().source).toBe('serialized');
		vi.spyOn(mmApi, 'rebindMetamodel').mockResolvedValue(REBIND);

		await commitMetamodelRebind('swap it');

		// The rebind DID store a blob, so the "re-serialized source" chip must
		// stop claiming otherwise without waiting for the tab to be reopened.
		expect(getMetamodelEditor().source).toBe('stored');
	});

	it('flips the surface readOnly flag for the whole rebind flight', async () => {
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		await initEditedAndPreviewed();
		const slow = deferred<Rebind>();
		vi.spyOn(mmApi, 'rebindMetamodel').mockImplementation(() => slow.promise);
		expect(getMetamodelEditor().readOnly).toBe(false);

		const rebinding = commitMetamodelRebind('m');

		// Read-only for the WHOLE flight: the CodeMirror compartment and the
		// tab's buttons both key off this, so no keystroke and no Discard can
		// be aimed at a document whose adoption is already in flight.
		expect(getMetamodelEditor().readOnly).toBe(true);
		slow.resolve(REBIND);
		await rebinding;

		expect(getMetamodelEditor().readOnly).toBe(false);
	});

	it('keeps a buffer typed DURING the flight dirty instead of adopting it as the baseline', async () => {
		vi.useFakeTimers();
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		await initEditedAndPreviewed();
		const slow = deferred<Rebind>();
		const rebind = vi.spyOn(mmApi, 'rebindMetamodel').mockImplementation(() => slow.promise);
		const SENT = `${BASE}candidate: true\n`;
		const TYPED = `${SENT}typed: mid-flight\n`;

		const rebinding = commitMetamodelRebind('m');
		// A straggler that raced CodeMirror's read-only reconfigure: the state
		// layer keeps it (the editor's document holds it either way) — dropping
		// it would desync the buffer from what the user is looking at.
		editMetamodelBuffer(TYPED);
		slow.resolve(REBIND);
		expect(await rebinding).not.toBeNull();

		// The server bound the PRE-typing text...
		expect(rebind).toHaveBeenCalledWith(SENT, { baseRev: 0, message: 'm' });
		const v = getMetamodelEditor();
		// ...so the typed lines are unreviewed local changes on top of it, not
		// something the rebind saved.
		expect(v.buffer).toBe(TYPED);
		expect(v.dirty).toBe(true);
		// Flushed immediately, not on the debounce: a tab closed before the
		// timer fires must not take the work with it.
		expect(localStorage.getItem(DRAFT_KEY)).toBe(TYPED);
		// Coherent, not merely non-lossy: the spent preview is gone, so Rebind
		// is dead until the user previews what they now have.
		expect(v.preview).toBeNull();
		expect(v.previewCurrent).toBe(false);
		expect(v.draftRestored).toBe(false);
		expect(v.rebindError).toBeNull();
		expect(v.rebinding).toBe(false);
	});

	it('leaves a discard DURING the flight as dirty pre-rebind text, not as the new baseline', async () => {
		vi.useFakeTimers();
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		await initEditedAndPreviewed();
		const slow = deferred<Rebind>();
		vi.spyOn(mmApi, 'rebindMetamodel').mockImplementation(() => slow.promise);

		const rebinding = commitMetamodelRebind('m');
		// The surface disables this button while `rebinding`; if it is reached
		// anyway, the resolving rebind must NOT re-adopt the old text as the
		// baseline — that would present the pre-rebind YAML as current with
		// nothing marking it stale.
		discardMetamodelDraft();
		slow.resolve(REBIND);
		expect(await rebinding).not.toBeNull();

		const v = getMetamodelEditor();
		expect(v.buffer).toBe(BASE);
		expect(v.dirty).toBe(true);
		expect(localStorage.getItem(DRAFT_KEY)).toBe(BASE);
		expect(v.previewCurrent).toBe(false);
	});

	it('maps each 409 refusal shape and a 422 to its own message', async () => {
		await initEditedAndPreviewed();
		const rebind = vi.spyOn(mmApi, 'rebindMetamodel').mockResolvedValue(REBIND);

		rebind.mockRejectedValue(
			new ConflictError(409, { detail: 'metamodel locked', holder_email: 'p@x.com' }, 'conflict')
		);
		expect(await commitMetamodelRebind('m')).toBeNull();
		expect(getMetamodelEditor().rebindError).toContain('p@x.com');

		rebind.mockRejectedValue(
			new ConflictError(
				409,
				{ detail: 'active locks; rebind requires a quiet project' },
				'conflict'
			)
		);
		expect(await commitMetamodelRebind('m')).toBeNull();
		expect(getMetamodelEditor().rebindError).toContain('not quiet');

		rebind.mockRejectedValue(
			new ConflictError(409, { detail: 'stale base_rev', model_rev: 9 }, 'conflict')
		);
		expect(await commitMetamodelRebind('m')).toBeNull();
		expect(getMetamodelEditor().rebindError).toContain('re-run');

		rebind.mockRejectedValue(new ApiError(422, { detail: 'bad yaml' }, 'unprocessable'));
		expect(await commitMetamodelRebind('m')).toBeNull();
		expect(getMetamodelEditor().rebindError).toContain('invalid');

		// Every refusal left the editor rebindable again, not wedged.
		expect(getMetamodelEditor().rebinding).toBe(false);
		expect(getMetamodelEditor().previewCurrent).toBe(true);
	});

	it('refuses without a preview of the CURRENT buffer and sends nothing', async () => {
		stubLintOk();
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		const rebind = vi.spyOn(mmApi, 'rebindMetamodel').mockResolvedValue(REBIND);
		await initMetamodelEditor(PROJECT);
		editMetamodelBuffer(`${BASE}unpreviewed`);

		expect(await commitMetamodelRebind('m')).toBeNull();

		expect(rebind).not.toHaveBeenCalled();
		// A silent refusal: the button is simply not live, it is not an error.
		expect(getMetamodelEditor().rebindError).toBeNull();
		expect(isMetamodelEditorDirty()).toBe(true);
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

	it('clears the in-flight preview and rebind flags so a reopen is not wedged', async () => {
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

		// The reopened editor can actually preview and rebind again.
		diff.mockResolvedValue(DIFF);
		const slowRebind = deferred<Rebind>();
		vi.spyOn(mmApi, 'rebindMetamodel').mockImplementation(() => slowRebind.promise);
		await initMetamodelEditor(PROJECT);
		editMetamodelBuffer(`${BASE}y`);
		await previewMetamodelChanges();
		expect(getMetamodelEditor().previewCurrent).toBe(true);

		const rebinding = commitMetamodelRebind('m');
		expect(getMetamodelEditor().rebinding).toBe(true);
		closeMetamodelEditor();
		slowRebind.resolve(REBIND);

		expect(await rebinding).toBeNull(); // the close discarded the result
		expect(getMetamodelEditor().rebinding).toBe(false);
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
