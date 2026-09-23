import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '$lib/api/__tests__/server';
import type { FeedEvent } from '$lib/api/feed';
import {
	emit,
	ensureElement,
	getStagedBatchIds,
	getStagedDepth,
	getStagedOps,
	stagedSettled
} from '../model.svelte';
import { beginReplicaCommit, handReplicaFeed } from '../replica.svelte';
import { engineStore, type EngineStore } from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let store: EngineStore | null = null;

afterEach(() => {
	store?.dispose();
	store = null;
	vi.restoreAllMocks();
});

describe('the provisional mirror', () => {
	it('an edit is never counted twice', async () => {
		const s = (store = await engineStore());
		await ensureElement('e_000002');
		await ensureElement('e_000003');

		// Every state the readers pass through, as an effect sees them.
		const depths: number[] = [];
		const cleanup = $effect.root(() => {
			$effect(() => {
				depths.push(getStagedDepth());
			});
		});
		try {
			emit({ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'one' } });
			emit({ kind: 'update_element', id: 'e_000003', properties_patch: { name: 'two' } });
			await s.sync.settled();
			await stagedSettled();
			await Promise.resolve();

			expect(getStagedBatchIds()).toEqual([1, 2]);
			expect(depths.at(-1)).toBe(2);
			expect(Math.max(...depths)).toBe(2);
		} finally {
			cleanup();
		}
	});

	it('a mirror read is never overtaken by a later edit while a peer delta waits', async () => {
		const s = (store = await engineStore());
		await ensureElement('e_000002');
		await ensureElement('e_000003');
		// The stages the engine has answered, in order.
		const answered: unknown[] = [];
		const call = s.sync.call.bind(s.sync);
		vi.spyOn(s.sync, 'call').mockImplementation(((
			method: string,
			params?: unknown,
			options?: never
		) => {
			const result = call(method, params, options);
			if (method === 'stage') void result.then((r) => answered.push(r));
			return result;
		}) as typeof s.sync.call);

		const depths: number[] = [];
		const cleanup = $effect.root(() => {
			$effect(() => {
				depths.push(getStagedDepth());
			});
		});
		try {
			// A peer's delta the replica knows of and cannot apply yet: a commit is in flight.
			const flight = beginReplicaCommit();
			const committed = s.project.commit([
				{ kind: 'update_element', id: 'e_000004', properties_patch: { name: 'peer' } }
			]);
			handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, committed.eventText);

			emit({ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'one' } });
			await vi.waitFor(() => expect(answered).toHaveLength(1));
			emit({ kind: 'update_element', id: 'e_000003', properties_patch: { name: 'two' } });
			await vi.waitFor(() => expect(answered).toHaveLength(2));

			flight.abandon();
			await s.sync.settled();
			await stagedSettled();
			await Promise.resolve();

			expect(getStagedOps()).toHaveLength(2);
			expect(getStagedBatchIds()).toEqual([1, 2]);
			expect(Math.max(...depths)).toBe(2);
		} finally {
			cleanup();
		}
	});
});
