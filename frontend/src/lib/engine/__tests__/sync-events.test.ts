import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ModelOp, ServiceEvent, StageResult } from '$engine';
import { server } from '$lib/api/__tests__/server';
import type { EngineLink } from '../client';
import type { ChangedEvent } from '../sync';
import { connectInProcess } from '../testing';
import {
	fakeProject,
	hold,
	syncOver,
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
