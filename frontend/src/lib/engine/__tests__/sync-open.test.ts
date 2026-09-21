import { IDBFactory } from 'fake-indexeddb';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ModelOp } from '$engine';
import { server } from '$lib/api/__tests__/server';
import { createSnapshotCache } from '../cache';
import { EngineGoneError, type EngineLink } from '../client';
import { FrameError } from '../frame';
import type { ReplicaStatus } from '../sync';
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

const createOrganization = (tempId: string, name: string): ModelOp[] => [
	{ kind: 'create_element', temp_id: tempId, type_name: 'Organization', properties: { name } }
];

const rename = (id: string, name: string): ModelOp[] => [
	{ kind: 'update_element', id, properties_patch: { name } }
];

const last = (statuses: ReplicaStatus[]) => statuses.at(-1)!;

/** The distinct values, in order, of consecutive runs. */
const runs = <T>(values: T[]): T[] =>
	values.filter((value, i) => i === 0 || values[i - 1] !== value);

const bytesOf = (buffer: ArrayBuffer | null) =>
	buffer === null ? null : [...new Uint8Array(buffer)];

describe('opening a replica', () => {
	it('a project opens from the network', async () => {
		const project = fakeProject();
		const size = project.snapshot().bytes.byteLength;
		server.use(...project.handlers());
		const over = open(project);
		await over.sync.settled();

		const status = last(over.statuses);
		expect(status).toMatchObject({
			phase: 'ready',
			rev: project.rev,
			source: 'network',
			attempt: 0,
			reason: null
		});
		expect(status.progress === null || status.progress.task === 'verify').toBe(true);
		expect(over.sync.status()).toBe(status);

		const opening = over.statuses.filter((s) => s.phase === 'opening');
		const downloads = opening.flatMap((s) => (s.progress?.task === 'download' ? [s.progress] : []));
		expect(downloads.length).toBeGreaterThan(1);
		for (let i = 1; i < downloads.length; i++) {
			expect(downloads[i]!.done).toBeGreaterThanOrEqual(downloads[i - 1]!.done);
		}
		expect(downloads.every((p) => p.total === size)).toBe(true);
		expect(downloads.at(-1)!.done).toBe(size);
		const tasks = opening.map((s) => s.progress?.task ?? null);
		const firstDownload = tasks.indexOf('download');
		const lastDownload = tasks.lastIndexOf('download');
		expect(tasks.lastIndexOf('parse')).toBeGreaterThan(firstDownload);
		expect(tasks.indexOf('index')).toBeGreaterThan(lastDownload);

		const summary = await over.link!.client.call('getModelSummary');
		expect(summary).toMatchObject({
			model_rev: project.rev,
			element_count: project.model.elementCount,
			relationship_count: project.model.relationshipCount
		});
		expect(project.requests).toEqual({ descriptor: 1, metamodel: 1, snapshot: 1, tail: 1 });
	});

	it('the tail brings a snapshot to head', async () => {
		const project = fakeProject({ rev: 7 });
		project.commit(createOrganization('tmp_a', 'A'));
		project.commit(createOrganization('tmp_b', 'B'));
		project.commit(createOrganization('tmp_c', 'C'));
		server.use(...project.handlers());
		const over = open(project);
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 10 });
		await expect(over.link!.client.call('getElement', { id: 'srv-3' })).resolves.toMatchObject({
			id: 'srv-3',
			properties: { name: 'C' }
		});
	});

	it('the second open is a cache hit', async () => {
		const project = fakeProject();
		const cache = createSnapshotCache({ factory: new IDBFactory() });
		server.use(...project.handlers());

		const first = open(project, { cache });
		await first.sync.settled();
		expect(last(first.statuses)).toMatchObject({ phase: 'ready', source: 'network' });
		first.sync.stop();

		const second = open(project, { cache });
		await second.sync.settled();
		expect(last(second.statuses)).toMatchObject({ phase: 'ready', source: 'cache', rev: 0 });
		expect(project.requests.snapshot).toBe(1);
		second.sync.stop();

		project.commit(rename('e_000001', 'moved on'));
		const moved = project.snapshot();
		const third = open(project, { cache });
		await third.sync.settled();
		expect(last(third.statuses)).toMatchObject({ phase: 'ready', source: 'network', rev: 1 });
		expect(project.requests.snapshot).toBe(2);
		expect(bytesOf(await cache.get(project.projectId, moved.rev))).toEqual(bytesOf(moved.bytes));
		expect(await cache.get(project.projectId, 0)).toBeNull();
	});

	it('bytes the engine refuses are not cached', async () => {
		const project = fakeProject();
		const cache = createSnapshotCache({ factory: new IDBFactory() });
		const sleeps: number[] = [];
		const cachedAtSleep: (ArrayBuffer | null)[] = [];
		project.corruptNextSnapshot();
		server.use(...project.handlers());
		const over = open(project, {
			cache,
			sleep: async (ms) => {
				sleeps.push(ms);
				cachedAtSleep.push(await cache.get(project.projectId, project.rev));
			}
		});
		await over.sync.settled();

		expect(sleeps).toEqual([1000]);
		expect(cachedAtSleep).toEqual([null]);
		expect(runs(over.statuses.map((s) => s.attempt))).toEqual([1, 2, 0]);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', source: 'network' });
		const good = project.snapshot();
		expect(bytesOf(await cache.get(project.projectId, 0))).toEqual(bytesOf(good.bytes));
	});

	it('a bad cache row is dropped, at no charge', async () => {
		const project = fakeProject();
		const cache = createSnapshotCache({ factory: new IDBFactory() });
		await cache.put(project.projectId, project.rev, new Uint8Array([1, 2, 3, 4]).buffer);
		server.use(...project.handlers());
		const over = open(project, { cache });
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', source: 'network', rev: 0 });
		expect(over.statuses.some((s) => s.source === 'cache')).toBe(true);
		expect(over.sleeps).toEqual([]);
		expect(over.statuses.every((s) => s.attempt <= 1)).toBe(true);
		const good = project.snapshot();
		expect(bytesOf(await cache.get(project.projectId, 0))).toEqual(bytesOf(good.bytes));
	});

	it('what is transferred is exactly the chunk', async () => {
		const project = fakeProject();
		const bytes = new Uint8Array(project.snapshot().bytes);
		const big = new Uint8Array(bytes.length + 100);
		big.set(bytes, 50);
		const views: Uint8Array[] = [];
		for (let at = 0; at < bytes.length; at += 3000) {
			views.push(new Uint8Array(big.buffer, 50 + at, Math.min(3000, bytes.length - at)));
		}
		server.use(...project.handlers());
		const over = open(project, {
			api: {
				snapshot: () =>
					Promise.resolve({
						headers: new Headers({ 'Content-Length': String(bytes.length) }),
						body: new ReadableStream<Uint8Array>({
							start(controller) {
								for (const view of views) controller.enqueue(view);
								controller.close();
							}
						})
					} as unknown as Response)
			}
		});
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 0 });
		const chunks = over.calls.filter((call) => call.method === 'chunk');
		expect(chunks.map((call) => call.byteLength)).toEqual(views.map((view) => view.byteLength));
		expect(big.buffer.byteLength).toBe(bytes.length + 100);
	});

	it('a metamodel that does not match restarts for free', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		// Registered last, so it is asked first.
		server.use(
			http.get(
				`${project.baseUrl}/metamodel`,
				() => HttpResponse.json(project.doc, { headers: { 'X-Metamodel-Id': 'mm-other' } }),
				{ once: true }
			)
		);
		const over = open(project);
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 0 });
		expect(project.requests.descriptor).toBe(2);
		expect(over.sleeps).toEqual([]);
	});

	it('a metamodel that never matches uses up the attempts after three free restarts', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		// Registered last, so it is asked first.
		server.use(
			http.get(`${project.baseUrl}/metamodel`, () =>
				HttpResponse.json(project.doc, { headers: { 'X-Metamodel-Id': 'mm-other' } })
			)
		);
		const over = open(project);
		await over.sync.settled();

		expect(project.requests.descriptor).toBe(4 + 1 + 1);
		expect(over.sleeps).toEqual([1000, 3000]);
		expect(last(over.statuses)).toMatchObject({
			phase: 'server',
			reason: "the metamodel served is mm-other, the snapshot's mm-1"
		});
	});

	it("a header that is not the descriptor's fails the attempt", async () => {
		const project = fakeProject({ rev: 6 });
		project.commit(createOrganization('tmp_a', 'A'));
		server.use(...project.handlers());
		// Registered last, so it is asked first.
		server.use(
			http.get(
				`${project.baseUrl}/replica/snapshot`,
				() =>
					HttpResponse.json({
						rev: 7,
						metamodel_id: 'mm-1',
						state_digest: '0000000000000000',
						elements: project.model.elementCount,
						relationships: project.model.relationshipCount,
						url: `/api/v1/projects/${project.projectId}/replica/snapshots/6`
					}),
				{ once: true }
			)
		);
		const cache = createSnapshotCache({ factory: new IDBFactory() });
		const over = open(project, { cache });
		await over.sync.settled();

		expect(over.sleeps).toEqual([1000]);
		expect(runs(over.statuses.map((s) => s.attempt))).toEqual([1, 2, 0]);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 7 });
		// Nothing was cached by the refused attempt: the second one downloads again.
		expect(over.statuses.some((s) => s.source === 'cache')).toBe(false);
		expect(project.requests.snapshot).toBe(2);
	});

	it('a project without a model is off', async () => {
		const project = fakeProject();
		project.fail('descriptor', 404, 1);
		server.use(...project.handlers());
		const over = open(project);
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'off', reason: 'no model', attempt: 0 });
		expect(project.requests).toEqual({ descriptor: 1, metamodel: 0, snapshot: 0, tail: 0 });
		expect(over.connects).toBe(0);
	});

	it('three failed opens are the boot fallback', async () => {
		const project = fakeProject();
		project.fail('snapshot', 503, 99);
		server.use(...project.handlers());
		const over = open(project);
		await over.sync.settled();

		expect(over.sleeps).toEqual([1000, 3000]);
		const attempts = runs(over.statuses.filter((s) => s.phase === 'opening').map((s) => s.attempt));
		expect(attempts).toEqual([1, 2, 3]);
		expect(last(over.statuses)).toMatchObject({
			phase: 'server',
			attempt: 0,
			reason: 'snapshot failed'
		});
		const methods = over.methods();
		expect(methods.filter((method) => method === 'close')).toHaveLength(3);
		// Told `close` between the attempts: each failed one ends before the next opens.
		expect(methods.filter((method) => method === 'open' || method === 'close')).toEqual([
			'open',
			'close',
			'open',
			'close',
			'open',
			'close'
		]);
		await expect(over.link!.client.call('staged')).rejects.toBeInstanceOf(EngineGoneError);
	});

	it('a failed tail is retried', async () => {
		const project = fakeProject();
		project.fail('tail', 500, 1);
		server.use(...project.handlers());
		const over = open(project);
		await over.sync.settled();

		expect(over.sleeps).toEqual([1000]);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 0 });
		expect(runs(over.statuses.map((s) => s.attempt))).toEqual([1, 2, 0]);
	});

	it('a frame that does not connect is the boot fallback at once', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const over = open(project, {
			connect: () =>
				Promise.reject(new FrameError('timeout', 'the sandbox did not answer within 10000 ms'))
		});
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({
			phase: 'server',
			reason: 'the sandbox did not answer within 10000 ms'
		});
		expect(over.sleeps).toEqual([]);
		expect(project.requests).toEqual({ descriptor: 1, metamodel: 0, snapshot: 0, tail: 0 });
	});

	it('an incomplete tail right after the descriptor is a failed attempt, not a loop', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		// Registered last, so it is asked first.
		server.use(
			http.get(
				`${project.baseUrl}/replica/tail`,
				() => HttpResponse.json({ from_rev: 0, head_rev: 1, complete: false, deltas: [] }),
				{ once: true }
			)
		);
		const over = open(project);
		await over.sync.settled();

		expect(over.sleeps).toEqual([1000]);
		expect(runs(over.statuses.map((s) => s.attempt))).toEqual([1, 2, 0]);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 0 });
	});
});

describe('while opening', () => {
	it('feed frames that arrive while opening wait', async () => {
		// The twin lands the same commits past the server's head, so the tail
		// cannot hold them and only the feed can bring them.
		const project = fakeProject();
		const twin = fakeProject();
		const covered = project.commit(rename('e_000001', 'covered'));
		twin.commit(rename('e_000001', 'covered'));
		const first = twin.commit(createOrganization('tmp_a', 'first'));
		const second = twin.commit(createOrganization('tmp_b', 'second'));
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = open(project);
		await held.reached;
		over.sync.feedCommit(covered.eventText, 1);
		over.sync.feedCommit(first.eventText, 2);
		over.sync.feedCommit(second.eventText, 3);
		expect(over.methods()).not.toContain('applyDelta');
		held.release();
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 3 });
		const applied = over.calls.filter((call) => call.method === 'applyDelta');
		expect(applied.map((call) => call.params)).toEqual([
			{ text: first.eventText },
			{ text: second.eventText }
		]);
		await expect(over.link!.client.call('getElement', { id: 'srv-2' })).resolves.toMatchObject({
			properties: { name: 'second' }
		});
	});

	it('more than 1,000 waiting frames become a catch-up', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = open(project);
		await held.reached;
		for (let i = 1; i <= 1001; i++) over.sync.feedCommit('{"not": "applied"}', i);
		held.release();
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 0 });
		expect(project.requests.tail).toBe(2);
		expect(over.methods()).not.toContain('applyDelta');

		// Nothing is left waiting: the next frame is the next one applied.
		const next = project.commit(rename('e_000001', 'next'));
		over.sync.feedCommit(next.eventText, next.delta['rev'] as number);
		await over.sync.settled();
		expect(over.methods().filter((method) => method === 'applyDelta')).toHaveLength(1);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
	});

	it('stop in the middle leaves nothing', async () => {
		const project = fakeProject({ projectId: 'p' });
		const other = fakeProject({ projectId: 'q' });
		const held = hold();
		const signals: AbortSignal[] = [];
		const urls: string[] = [];
		server.events.on('request:start', ({ request }) => void urls.push(request.url));
		server.use(...project.handlers({ hold: held }), ...other.handlers());
		const over = syncOver(project, {
			api: {
				snapshot: async (url, signal) => {
					signals.push(signal);
					const { fetchSnapshot } = await import('$lib/api/replica');
					return fetchSnapshot(url, signal);
				}
			}
		});
		made.push(over);
		over.sync.open(project.projectId);
		await held.reached;
		const firstLink = over.link!;
		const requested = { ...project.requests };

		over.sync.stop();
		expect(signals).toHaveLength(1);
		expect(signals[0]!.aborted).toBe(true);
		expect(over.sync.status()).toMatchObject({ phase: 'off', rev: null, reason: null });
		await expect(firstLink.client.call('staged')).rejects.toBeInstanceOf(EngineGoneError);
		const seen = over.statuses.length;
		held.release();
		await over.sync.settled();
		expect(over.statuses).toHaveLength(seen);
		expect(project.requests).toEqual(requested);

		const switchedAt = urls.length;
		over.sync.open(other.projectId);
		await over.sync.settled();
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 0 });
		expect(over.links).toHaveLength(2);
		expect(project.requests).toEqual(requested);
		const later = urls.slice(switchedAt);
		expect(later.length).toBeGreaterThan(0);
		expect(later.every((url) => url.includes('/projects/q/'))).toBe(true);
	});

	it('a link that arrives after stop is disposed', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		let asked!: () => void;
		const connecting = new Promise<void>((resolve) => (asked = resolve));
		let deliver!: (link: EngineLink) => void;
		const over = open(project, {
			connect: () => {
				asked();
				return new Promise<EngineLink>((resolve) => (deliver = resolve));
			}
		});
		await connecting;
		over.sync.stop();
		await over.sync.settled();
		const late = connectInProcess();
		const disposed = new Promise<void>((resolve) =>
			deliver({
				...late,
				dispose() {
					late.dispose();
					resolve();
				}
			})
		);
		await disposed;
		expect(over.sync.status()).toMatchObject({ phase: 'off', reason: null });
		expect(project.requests).toEqual({ descriptor: 1, metamodel: 0, snapshot: 0, tail: 0 });
	});

	it("the frame's isolation and violations show in the status", async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const violation = { directive: 'script-src', blocked: 'inline' };
		const over = open(project, {
			connect: () => {
				const inner = connectInProcess();
				const link: EngineLink = {
					...inner,
					isolated: false,
					onViolation(listener) {
						listener(violation);
						queueMicrotask(() => listener(violation));
						return () => {};
					}
				};
				return Promise.resolve(link);
			}
		});
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({
			phase: 'ready',
			isolated: false,
			cspViolations: 2
		});
	});
});
