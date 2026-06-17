import { beforeEach, describe, expect, it } from 'vitest';
import {
	getLockFor,
	getLockState,
	getPresence,
	handleFeedEvent,
	resetRealtime
} from '../realtime.svelte';
import { getCachedElements, resetModelStore, seedElements } from '../model.svelte';

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
