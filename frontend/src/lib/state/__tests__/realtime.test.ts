import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedConfig } from '$lib/api/feed';

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
	resetRealtime,
	startRealtime
} from '../realtime.svelte';
import { getCachedElements, resetModelStore, seedElements } from '../model.svelte';
import { setActiveProject } from '../active-project.svelte';

beforeEach(() => {
	resetRealtime();
	resetModelStore();
});

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
		startRealtime();
		// The store must own onTerminal even if a caller tries to pass one.
		expect(lastConfig?.onTerminal).toBeTypeOf('function');
		lastConfig?.onTerminal?.(4403);
		expect(getFeedTermination()).toEqual({ code: 4403 });
	});

	it('resetRealtime clears termination', () => {
		startRealtime();
		lastConfig?.onTerminal?.(4404);
		expect(getFeedTermination()).toEqual({ code: 4404 });
		resetRealtime();
		expect(getFeedTermination()).toBeNull();
	});
});
