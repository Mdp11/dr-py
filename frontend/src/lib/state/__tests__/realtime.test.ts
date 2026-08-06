import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedConfig } from '$lib/api/feed';
import * as modelReadApi from '$lib/api/model-read';

// Capture the config startRealtime hands connectFeed so a test can drive the
// onTerminal callback the way the transport would on a permanent close. The rest
// of the real feed module (defaultFeedUrl, types) is preserved.
let lastConfig: FeedConfig | null = null;
vi.mock('$lib/api/feed', async (orig) => {
	const real = (await orig()) as typeof import('$lib/api/feed');
	return {
		...real,
		connectFeed: (cfg: FeedConfig) => {
			lastConfig = cfg;
			return { close: () => {} };
		}
	};
});

import {
	clearPendingRebind,
	getFeedTermination,
	getLockFor,
	getLockState,
	getPresence,
	getPendingRebind,
	handleFeedEvent,
	onCommitEvent,
	resetRealtime,
	startRealtime
} from '../realtime.svelte';
import { getCachedElements, getModelRev, resetModelStore, seedElements } from '../model.svelte';
import { setActiveProject } from '../active-project.svelte';

beforeEach(() => {
	resetRealtime();
	resetModelStore();
	// A 'snapshot' event whose model_rev is ahead of the cached rev fires
	// refreshSummary() (fire-and-forget, .catch()-swallowed). Stub the read so it
	// doesn't escape to a real fetch — these tests assert on reducer state, not
	// on the summary refresh.
	vi.spyOn(modelReadApi, 'getModelSummary').mockResolvedValue({
		model_rev: 1,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: null,
		undo_depth: 0
	});
});
afterEach(() => vi.restoreAllMocks());

describe('realtime store reducers', () => {
	it('tracks presence from snapshot + presence events', () => {
		handleFeedEvent({ type: 'snapshot', model_rev: 1, locks: [], connected: ['a'] });
		expect(getPresence()).toEqual(['a']);
		handleFeedEvent({ type: 'presence', action: 'join', user_id: 'b', connected: ['a', 'b'] });
		expect(getPresence()).toEqual(['a', 'b']);
	});

	it('reduces lock acquired/released into lockState', () => {
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'a' }]
		});
		expect(getLockFor('e1')?.holder_id).toBe('a');
		handleFeedEvent({
			type: 'lock',
			action: 'released',
			leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'a' }]
		});
		expect(getLockState().has('e1')).toBe(false);
	});

	it('applies a commit delta into the model cache', () => {
		seedElements([{ id: 'e1', type_name: 'Node', properties: { name: 'old' }, rev: 0 }]);
		handleFeedEvent({
			type: 'commit',
			rev: 5,
			commit_id: 'c1',
			author_id: 'a',
			message: 'rename',
			validation_error_count: 0,
			changed_elements: [{ id: 'e1', type_name: 'Node', properties: { name: 'new' }, rev: 1 }],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: []
		});
		expect(getCachedElements().get('e1')?.properties.name).toBe('new');
	});
});

describe('commit event scope', () => {
	/** A commit feed event with the artifact-op fields defaulted away. */
	function commitEvent(rev: number, scope?: string[]) {
		return {
			type: 'commit' as const,
			rev,
			commit_id: `c${rev}`,
			author_id: 'peer',
			message: 'm',
			validation_error_count: 0,
			changed_elements: [],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			...(scope === undefined ? {} : { scope })
		};
	}

	it('an artifact-only commit still adopts the rev but tags the tap artifact-scoped', () => {
		const tap = vi.fn();
		onCommitEvent(tap);

		handleFeedEvent(commitEvent(5, ['artifact']));

		// Rev adoption is UNCONDITIONAL: previewStaged/commitStaged send base_rev
		// and the backend's preview path compares it with strict equality, so a
		// peer that ignored artifact-only revs would 409 on its next preview.
		expect(getModelRev()).toBe(5);
		expect(tap).toHaveBeenCalledWith({ scope: ['artifact'] });
	});

	it('a commit event without scope is treated as model-scoped', () => {
		const tap = vi.fn();
		onCommitEvent(tap);

		handleFeedEvent(commitEvent(6));

		expect(getModelRev()).toBe(6);
		expect(tap).toHaveBeenCalledWith({ scope: ['model'] });
	});

	it('a mixed-scope commit passes both scopes through', () => {
		const tap = vi.fn();
		onCommitEvent(tap);

		handleFeedEvent(commitEvent(7, ['model', 'artifact']));

		expect(tap).toHaveBeenCalledWith({ scope: ['model', 'artifact'] });
	});

	it('a rebind fires the commit taps as model-scoped', () => {
		const tap = vi.fn();
		onCommitEvent(tap);

		handleFeedEvent({
			type: 'rebind',
			rev: 9,
			from_metamodel_id: 'mm-1',
			to_metamodel_id: 'mm-2',
			validation_error_count: 0
		});

		expect(tap).toHaveBeenCalledWith({ scope: ['model'] });
	});
});

describe('rebind event', () => {
	afterEach(() => resetRealtime());

	it('a rebind event sets pending reload state', () => {
		expect(getPendingRebind()).toBeNull();
		handleFeedEvent({
			type: 'rebind',
			rev: 12,
			from_metamodel_id: 'mm-1',
			to_metamodel_id: 'mm-2',
			validation_error_count: 4
		});
		expect(getPendingRebind()).toEqual({ rev: 12, count: 4 });
	});

	it('clearPendingRebind resets it', () => {
		handleFeedEvent({
			type: 'rebind',
			rev: 12,
			from_metamodel_id: null,
			to_metamodel_id: 'mm-2',
			validation_error_count: 0
		});
		clearPendingRebind();
		expect(getPendingRebind()).toBeNull();
	});
});

describe('feed termination state', () => {
	beforeEach(() => {
		lastConfig = null;
		setActiveProject('proj-x');
	});
	afterEach(() => resetRealtime());

	it('is null initially and set via the onTerminal callback startRealtime wires (after the spread)', () => {
		expect(getFeedTermination()).toBeNull();
		const callerOnTerminal = vi.fn();
		// Pass a caller-supplied onTerminal in the config — the store must override it.
		startRealtime({ onTerminal: callerOnTerminal });
		// Handlers are set after the spread, so the store's version overwrites the caller's.
		expect(lastConfig?.onTerminal).toBeTypeOf('function');
		expect(lastConfig?.onTerminal).not.toBe(callerOnTerminal);
		lastConfig?.onTerminal?.(4403);
		expect(getFeedTermination()).toEqual({ code: 4403 });
		expect(callerOnTerminal).not.toHaveBeenCalled();
	});

	it('resetRealtime clears termination', () => {
		startRealtime();
		lastConfig?.onTerminal?.(4404);
		expect(getFeedTermination()).toEqual({ code: 4404 });
		resetRealtime();
		expect(getFeedTermination()).toBeNull();
	});
});
