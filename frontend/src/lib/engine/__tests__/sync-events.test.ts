import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ModelOp, ServiceEvent, StageResult } from '$engine';
import { server } from '$lib/api/__tests__/server';
import { EngineGoneError, type EngineLink } from '../client';
import type { ChangedEvent } from '../sync';
import { connectInProcess } from '../testing';
import {
	fakeProject,
	hold,
	syncOver,
	type Committed,
	type FakeProject,
	type SyncOverrides
} from './support/project-server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const made: ReturnType<typeof syncOver>[] = [];

afterEach(() => {
	for (const over of made.splice(0)) over.dispose();
	server.resetHandlers();
	server.events.removeAllListeners();
});

function open(project: FakeProject, overrides: SyncOverrides = {}) {
	const over = syncOver(project, overrides);
	made.push(over);
	over.sync.open(project.projectId);
	return over;
}

/** A sync of `project`, opened and `ready`. */
async function ready(project: FakeProject, overrides: SyncOverrides = {}) {
	server.use(...project.handlers());
	const over = open(project, overrides);
	await over.sync.settled();
	expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
	return over;
}

const rename = (id: string, name: string): ModelOp[] => [
	{ kind: 'update_element', id, properties_patch: { name } }
];

/** The feed frame of `committed`, its state digest flipped: the replica diverges on it. */
function withWrongDigest(committed: Committed): string {
	const digest = committed.delta['state_digest'] as string;
	const wrong = (BigInt('0x' + digest) ^ 1n).toString(16).padStart(16, '0');
	return committed.eventText.replace(`"state_digest":"${digest}"`, `"state_digest":"${wrong}"`);
}

/** Stages a rename through the sync's current link, as the engine store's transitions will. */
const stage = (over: ReturnType<typeof syncOver>, id: string, name: string) =>
	over.link!.client.call<StageResult>('stage', { ops: rename(id, name) });

describe('the changed event', () => {
	it('a changed event reaches a listener', async () => {
		const project = fakeProject({ rev: 3 });
		const over = await ready(project);
		const heard: ChangedEvent[] = [];
		over.sync.on('changed', (event) => heard.push(event));

		await stage(over, 'e_000001', 'staged');

		expect(heard).toHaveLength(1);
		expect(heard[0]).toMatchObject({
			event: 'changed',
			rev: 3,
			staged_version: 1,
			element_ids: ['e_000001'],
			structural: false
		});
	});

	it('a listener added before the link exists gets the events', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const over = syncOver(project);
		made.push(over);
		over.sync.open(project.projectId);
		const heard: ChangedEvent[] = [];
		over.sync.on('changed', (event) => heard.push(event));
		expect(over.link).toBeUndefined();

		await over.sync.settled();
		expect(over.sync.status().phase).toBe('ready');
		await stage(over, 'e_000001', 'staged');

		expect(heard.map((event) => event.staged_version)).toEqual([1]);
	});

	it('a link replaced mid-life still forwards', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = open(project);
		const heard: ChangedEvent[] = [];
		over.sync.on('changed', (event) => heard.push(event));
		await held.reached;
		over.links[0]!.dispose();
		held.release();
		await over.sync.settled();
		expect(over.connects).toBe(2);
		expect(over.sync.status().phase).toBe('ready');

		await stage(over, 'e_000001', 'staged');

		expect(heard.map((event) => event.element_ids)).toEqual([['e_000001']]);
	});

	it('an unsubscribed listener hears nothing', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const kept: ChangedEvent[] = [];
		const dropped: ChangedEvent[] = [];
		over.sync.on('changed', (event) => kept.push(event));
		const off = over.sync.on('changed', (event) => dropped.push(event));

		await stage(over, 'e_000001', 'first');
		off();
		off();
		await stage(over, 'e_000002', 'second');

		expect(kept.map((event) => event.staged_version)).toEqual([1, 2]);
		expect(dropped.map((event) => event.staged_version)).toEqual([1]);
	});

	it('stop() forwards nothing more', async () => {
		const project = fakeProject();
		// Every event listener the sync ever registers on a link, kept past its unsubscribe.
		const registered: ((event: ServiceEvent) => void)[] = [];
		const connect = (): Promise<EngineLink> => {
			const link = connectInProcess();
			const on = (listener: (event: ServiceEvent) => void) => {
				registered.push(listener);
				return link.client.on(listener);
			};
			return Promise.resolve({ ...link, client: { ...link.client, on } });
		};
		const over = await ready(project, { connect });
		const heard: ChangedEvent[] = [];
		over.sync.on('changed', (event) => heard.push(event));
		const { rev } = over.sync.status();
		const late: ChangedEvent = {
			event: 'changed',
			rev: rev!,
			staged_version: 9,
			issues_version: 0,
			artifacts_version: 0,
			element_ids: ['e_000001'],
			relationship_ids: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			structural: false
		};

		over.sync.stop();
		for (const listener of registered) listener(late);

		expect(heard).toEqual([]);

		// The listeners are the sync's: the next open's link forwards to them.
		over.sync.open(project.projectId);
		await over.sync.settled();
		expect(over.sync.status().phase).toBe('ready');
		await stage(over, 'e_000001', 'reopened');
		expect(heard.map((event) => event.staged_version)).toEqual([1]);
	});
});

describe('the sweep seeds the replica', () => {
	/** Every `sweep` progress event the link's engine posts from now on. */
	const sweepsOf = (link: EngineLink) => {
		const seen: { done: number; total: number }[] = [];
		link.client.on((event) => {
			if (event.event === 'progress' && event.task === 'sweep') {
				seen.push({ done: event.done, total: event.total });
			}
		});
		return seen;
	};

	it('the end of the first sweep after ready sets seeded; the sweep is no progress the UI shows', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const over = open(project);
		expect(over.sync.status().seeded).toBe(false);
		await over.until((status) => status.seeded);

		const first = over.statuses.findIndex((status) => status.seeded);
		expect(over.statuses[first]!.phase).toBe('ready');
		expect(over.statuses.slice(0, first).every((status) => !status.seeded)).toBe(true);
		expect(over.statuses.some((status) => status.progress?.task === 'sweep')).toBe(false);
		expect(over.sync.status()).toMatchObject({ phase: 'ready', seeded: true });
	});

	it('a sweep started again keeps the replica seeded through its done: 0', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const over = open(project);
		await over.until((status) => status.seeded);
		const sweeps = sweepsOf(over.link!);
		const from = over.statuses.length;

		await over.link!.client.call('validateModel', { batch_ids: [] });

		expect(sweeps[0]).toMatchObject({ done: 0 });
		expect(sweeps.at(-1)!.done).toBe(sweeps.at(-1)!.total);
		expect(over.statuses.slice(from).every((status) => status.seeded)).toBe(true);
		expect(over.sync.status().seeded).toBe(true);
	});

	it('a new link starts unseeded, and its own sweep seeds it', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const over = open(project);
		await over.until((status) => status.seeded);
		const from = over.statuses.length;

		over.links[0]!.dispose();
		await expect(over.sync.call('getModelSummary', {})).rejects.toBeInstanceOf(EngineGoneError);
		expect(over.sync.status()).toMatchObject({ phase: 'resyncing', seeded: false });
		await over.until((status) => status.seeded, from);

		expect(over.connects).toBe(2);
		const later = over.statuses.slice(from);
		const reseeded = later.findIndex((status) => status.seeded);
		expect(later.slice(0, reseeded).every((status) => !status.seeded)).toBe(true);
		expect(later.slice(0, reseeded).some((status) => status.phase === 'ready')).toBe(true);
		expect(later[reseeded]!.phase).toBe('ready');
	});

	it('a re-bootstrap on the same worker starts unseeded', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const over = open(project);
		await over.until((status) => status.seeded);
		const from = over.statuses.length;

		const committed = project.commit(rename('e_000002', 'diverges'));
		over.sync.feedCommit(withWrongDigest(committed), project.rev);
		await over.until((status) => status.phase === 'resyncing', from);
		expect(over.sync.status().seeded).toBe(false);
		await over.until((status) => status.seeded, from);

		expect(over.connects).toBe(1);
		expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev, seeded: true });
	});

	it('stop() leaves it unseeded', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const over = open(project);
		await over.until((status) => status.seeded);
		over.sync.stop();
		expect(over.sync.status().seeded).toBe(false);
	});
});
