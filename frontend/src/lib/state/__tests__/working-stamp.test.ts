import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '$lib/api/__tests__/server';
import type { FeedEvent } from '$lib/api/feed';
import { emit, ensureElement } from '../model.svelte';
import {
	adoptWorkingStamp,
	getLinkGeneration,
	getWorkingStamp,
	handReplicaFeed,
	resetReplica,
	scriptsNeedEngine
} from '../replica.svelte';
import {
	engineStore,
	forceFailed,
	rename,
	settled,
	type EngineStore
} from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let store: EngineStore | null = null;
afterEach(() => {
	store?.dispose();
	store = null;
	vi.restoreAllMocks();
});

describe('the working stamp', () => {
	it('is unknown until the engine reports a change, then follows every one', async () => {
		const s = (store = await engineStore());
		expect(getWorkingStamp()).toBeNull();
		await ensureElement('e_000002');

		emit(rename('e_000002', 'Quartz'));
		await settled(s);
		const first = getWorkingStamp();
		expect(first).toEqual({ rev: s.project.rev, staged: expect.any(Number) });

		emit(rename('e_000002', 'Quartzite'));
		await settled(s);
		const second = getWorkingStamp();
		expect(second?.rev).toBe(first?.rev);
		expect(second?.staged).not.toBe(first?.staged);

		const committed = s.project.commit([
			{ kind: 'update_element', id: 'e_000003', properties_patch: { name: 'peer' } }
		]);
		handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, committed.eventText);
		await settled(s);
		expect(getWorkingStamp()?.rev).toBe(s.project.rev);
	});

	it('is adopted from a run only while unknown', async () => {
		store = await engineStore();
		adoptWorkingStamp({ rev: 4, staged: 2 });
		expect(getWorkingStamp()).toEqual({ rev: 4, staged: 2 });
		adoptWorkingStamp({ rev: 9, staged: 9 });
		expect(getWorkingStamp()).toEqual({ rev: 4, staged: 2 });
	});

	it('is not adopted from a run that began on a link since lost', async () => {
		const s = (store = await engineStore());
		const began = getLinkGeneration();
		await forceFailed(s, { waitForReady: false });
		expect(getLinkGeneration()).not.toBe(began);
		adoptWorkingStamp({ rev: 4, staged: 2 }, began);
		expect(getWorkingStamp()).toBeNull();
	});

	it('is forgotten when the link is lost', async () => {
		const s = (store = await engineStore());
		adoptWorkingStamp({ rev: 4, staged: 2 });
		await forceFailed(s, { waitForReady: false });
		expect(getWorkingStamp()).toBeNull();
	});

	it('is forgotten when the replica stops serving, and scripts then need the engine', async () => {
		store = await engineStore();
		expect(scriptsNeedEngine()).toBe(false);
		adoptWorkingStamp({ rev: 4, staged: 2 });
		resetReplica();
		expect(getWorkingStamp()).toBeNull();
		expect(scriptsNeedEngine()).toBe(true);
	});
});
