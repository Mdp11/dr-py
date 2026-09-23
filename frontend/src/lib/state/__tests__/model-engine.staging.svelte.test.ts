import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from '$lib/api/__tests__/server';
import {
	emit,
	ensureElement,
	getStagedBatchIds,
	getStagedDepth,
	stagedSettled
} from '../model.svelte';
import { engineStore, type EngineStore } from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let store: EngineStore | null = null;

afterEach(() => {
	store?.dispose();
	store = null;
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
});
