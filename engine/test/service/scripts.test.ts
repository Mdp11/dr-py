import { availableParallelism } from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyBatch, type MetamodelDoc, type ModelOp } from '../../src/index.ts';
import type { Bridge, ScriptHost, ScriptHostFactory, ScriptRun } from '../../src/script/host.ts';
import { createPool, type WorkerSpawner } from '../../src/script/pool.ts';
import { poolCap, spawnNodeWorker } from '../../node/script-host.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';
import { clone, Server } from '../working/helpers.ts';
import {
	autoHost,
	connect,
	deltaText,
	fakeHost,
	openReplica,
	portPair,
	refusal,
	type Client
} from './helpers.ts';

type Fixture = { metamodel: MetamodelDoc; elements: string[]; relationships: string[] };
type CallsResult = {
	results: { text: string }[];
	trips: number;
	ms: number;
	boot_ms: number;
	dispatch_ms: number;
	boot: 'snapshot' | 'cold';
	ops?: string;
};

const fixture = loadFixture<Fixture>('script_bridge');
const doc = fixture.metamodel;
const bridgeModel = () => loadLines(doc, fixture.elements, fixture.relationships);

const rename = (id: string, name: string | null): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

const NOT_READY = '{"id": 7, "error": "BridgeError: replica is not ready"}';
const ELEMENT_REQUEST = '{"id": 7, "op": "element", "element_id": "n1"}';
const NAME = 'def value(els): return els[0].name';
const CONSOLE = 'result = 1';

/**
 * The real Node pool over `worker_threads`, `cap` workers at most, with everything the service
 * handed it kept for the test to look at: the hosts it made, the bridge of every run, a log of
 * each run's start, bridge trips and end (tagged by its first element), and the workers alive.
 */
function tracked({ cap = poolCap(availableParallelism()) }: { cap?: number } = {}) {
	const hosts: ScriptHost[] = [];
	const bridges: Bridge[] = [];
	const log: string[] = [];
	const spawned = new Set<unknown>();
	const ended = new Set<unknown>();
	const spawn: WorkerSpawner = (buffers) => {
		const port = spawnNodeWorker(buffers);
		spawned.add(port);
		return {
			...port,
			terminate() {
				ended.add(port);
				port.terminate();
			}
		};
	};
	const factory: ScriptHostFactory = () => {
		const host = createPool(spawn, { cap, now: () => performance.now() });
		hosts.push(host);
		return {
			boot: () => host.boot(),
			prewarm: () => host.prewarm(),
			warmed: () => host.warmed(),
			async run(batch, bridge, signal) {
				if (!bridges.includes(bridge)) bridges.push(bridge);
				const tag = batch.calls[0]?.elementIds[0] ?? batch.entry;
				log.push(`${tag}:start`);
				const watched: Bridge = {
					roots: (ids) => bridge.roots(ids),
					dispatch(text) {
						log.push(`${tag}:trip`);
						return bridge.dispatch(text);
					}
				};
				try {
					return await host.run(batch, watched, signal);
				} finally {
					log.push(`${tag}:end`);
				}
			},
			dispose: () => host.dispose()
		};
	};
	return {
		hosts,
		bridges,
		log,
		factory,
		/** Workers spawned and not yet ended by the pool. */
		alive: () => spawned.size - ended.size,
		dispose: () => hosts.forEach((host) => host.dispose())
	};
}

/** Resolves when `ready()` holds, polling in real time. */
async function until(ready: () => boolean, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (!ready()) {
		if (Date.now() > end) throw new Error('timed out waiting');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function scripted(tracker = tracked(), host = autoHost()) {
	const client = connect(host, portPair(), { scripts: tracker.factory });
	return { client, tracker, host };
}

const batch = (code: string, ids: string[][], entry = 'value') => ({
	code,
	entry,
	calls: ids.map((element_ids) => ({ element_ids }))
});

const answer = (result: { text: string }) =>
	JSON.parse(result.text) as { payload: { value: unknown }; error: { message: string } | null };
const payloadOf = (result: { text: string }) => answer(result).payload.value;

// A pool keeps `cap` interpreters hot, so a test's pool ends with the test; a describe that shares
// one disposes it in its own `afterAll`.
const all: { dispose(): void }[] = [];
afterEach(() => all.splice(0).forEach((each) => each.dispose()));

describe('scriptCalls on a ready replica', () => {
	let client: Client;
	let tracker: ReturnType<typeof tracked>;

	afterAll(() => tracker.dispose());
	beforeAll(async () => {
		({ client, tracker } = scripted());
		await openReplica(client, bridgeModel(), doc);
		// Boots the interpreter once, for the tests below.
		await client.call('scriptCalls', batch(NAME, [['n1']]));
	}, 60_000);

	it('answers one result per call, in call order', async () => {
		const result = await client.call<CallsResult>(
			'scriptCalls',
			batch(NAME, [['n2'], ['n1'], ['n3'], ['n1']])
		);
		expect(result.results.map((r) => answer(r).error)).toEqual([null, null, null, null]);
		expect(result.results.map(payloadOf)).toEqual(['two', 'one', 'three', 'one']);
		expect(result.trips).toBe(0);
		expect(result.ms).toBeGreaterThanOrEqual(0);
		expect(result.dispatch_ms).toBe(0);
		expect(result.boot_ms).toBeGreaterThan(0);
		expect(['snapshot', 'cold']).toContain(result.boot);
		expect(result).not.toHaveProperty('ops');
		expect(result.results[0]!.text).toBe(
			'{"payload": {"kind": "scalar", "value": "two"}, "error": null, "reads": [["el", "n2"]], "stdout": ""}'
		);
	}, 60_000);

	it('reads what a script needs from the working copy through the bridge', async () => {
		const result = await client.call<CallsResult>(
			'scriptCalls',
			batch('def value(els): return len(els[0].outgoing())', [['n1']])
		);
		expect(payloadOf(result.results[0]!)).toBe(5);
		expect(result.trips).toBeGreaterThanOrEqual(1);
		expect(result.dispatch_ms).toBeGreaterThan(0);
	}, 60_000);

	it('reads the staged name after stage, and the committed one after unstage', async () => {
		await client.call('stage', { ops: [rename('n1', 'uno')] });
		const staged = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(staged.results[0]!)).toBe('uno');
		const through = await client.call<CallsResult>(
			'scriptCalls',
			batch('def value(els): return [r.destination().name for r in els[0].outgoing()][0]', [['n2']])
		);
		expect(answer(through.results[0]!).error).toBeNull();
		await client.call('unstage', { what: 'all' });
		const committed = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(committed.results[0]!)).toBe('one');
	}, 60_000);

	it('sends inputs and a document as their text says', async () => {
		const result = await client.call<CallsResult>('scriptCalls', {
			code: 'def value(els, inputs): return [els[0].name, inputs["x"][1]]',
			entry: 'value',
			calls: [
				{
					element_ids: ['n1'],
					inputs_text: '{"x": {"kind": "values", "values": [1, 2.50]}}'
				}
			]
		});
		expect(answer(result.results[0]!).error).toBeNull();
		expect(result.results[0]!.text).toContain('2.5');
		const transform = await client.call<CallsResult>('scriptCalls', {
			code: 'def transform(doc): return doc',
			entry: 'transform',
			calls: [{ element_ids: [], doc_text: '{"f": 1.0, "i": 1, "big": 1152921504606846976}' }]
		});
		expect(transform.results[0]!.text).toBe(
			'{"payload": {"kind": "json", "value": {"f": 1.0, "i": 1, "big": 1152921504606846976}}, "error": null, "reads": [], "stdout": ""}'
		);
	}, 60_000);

	it('reports a raising call beside one that returned', async () => {
		const result = await client.call<CallsResult>(
			'scriptCalls',
			batch('def value(els):\n    if els[0].name == "one": raise ValueError("x")\n    return 1', [
				['n1'],
				['n2']
			])
		);
		expect(answer(result.results[0]!).error?.message).toBe('ValueError: x');
		expect(answer(result.results[1]!).error).toBeNull();
	}, 60_000);

	it('answers a bridge request inside the message handler, with no scheduler job', async () => {
		const host = fakeHost({ tick: 1 });
		host.auto = true;
		const here = scripted(undefined, host);
		all.push(here.tracker);
		await openReplica(here.client, bridgeModel(), doc);
		await here.client.call('scriptCalls', batch(NAME, [['n1']]));
		host.auto = false;
		const slices = host.slices.length;
		const reply = here.tracker.bridges[0]!.dispatch(ELEMENT_REQUEST);
		expect(JSON.parse(reply).element.id).toBe('n1');
		expect(here.tracker.bridges[0]!.roots(['n1'])).toContain('"n1"');
		expect(host.waiting).toBe(0);
		expect(host.slices.length).toBe(slices);
		here.tracker.dispose();
	}, 60_000);
});

describe('scriptCalls refusals', () => {
	it('refuses 501 without a script host in the deps', async () => {
		const client = connect();
		await openReplica(client, bridgeModel(), doc);
		expect(await refusal(client.call('scriptCalls', batch(NAME, [['n1']])))).toEqual({
			status: 501,
			detail: 'scripts are not available'
		});
	});

	it('refuses 409 before a replica is ready', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		const refused = { status: 409, detail: 'replica is not ready' };
		expect(await refusal(client.call('scriptCalls', batch(NAME, [['n1']])))).toEqual(refused);
		await client.call('open', { project_id: 'demo', metamodel: doc });
		expect(await refusal(client.call('scriptCalls', batch(NAME, [['n1']])))).toEqual(refused);
		expect(tracker.hosts).toHaveLength(0);
	});

	it('refuses a malformed request 422 at arrival, before any host is made', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		const call = (params: object) => refusal(client.call('scriptCalls', params));
		const good = batch(NAME, [['n1']]);
		const bad: { name: string; params: object }[] = [
			{ name: 'entry script with two calls', params: { ...batch(CONSOLE, [[], []], 'script') } },
			{ name: 'entry script with no call', params: { ...batch(CONSOLE, [], 'script') } },
			{ name: 'console not a boolean', params: { ...good, console: 1 } },
			{ name: 'unknown entry', params: { ...good, entry: 'other' } },
			{ name: 'no entry', params: { code: NAME, calls: good.calls } },
			{ name: 'code a number', params: { ...good, code: 1 } },
			{ name: 'no code', params: { entry: 'value', calls: good.calls } },
			{ name: 'calls an object', params: { ...good, calls: {} } },
			{ name: 'no calls', params: { code: NAME, entry: 'value' } },
			{ name: 'a call a string', params: { ...good, calls: ['n1'] } },
			{ name: 'ids not a list', params: { ...good, calls: [{ element_ids: 'n1' }] } },
			{ name: 'ids not strings', params: { ...good, calls: [{ element_ids: ['n1', 2] }] } },
			{ name: 'no ids', params: { ...good, calls: [{}] } },
			{
				name: 'inputs not text',
				params: { ...good, calls: [{ element_ids: ['n1'], inputs_text: { a: 1 } }] }
			},
			{
				name: 'doc not JSON',
				params: { ...good, calls: [{ element_ids: ['n1'], doc_text: '{"a": ' }] }
			}
		];
		for (const { name, params } of bad) {
			expect((await call(params)).status, name).toBe(422);
		}
		expect(tracker.hosts).toHaveLength(0);
	});

	it('refuses a malformed request 422 even before a replica is ready', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		expect(
			(await refusal(client.call('scriptCalls', batch(CONSOLE, [[], []], 'script')))).status
		).toBe(422);
	});
});

describe('the bridge when the replica is not there', () => {
	it('answers the not-ready reply, echoing the id, before an open and after a close', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		const bridge = tracker.bridges[0]!;
		expect(JSON.parse(bridge.dispatch(ELEMENT_REQUEST)).element.id).toBe('n1');
		await client.call('close');
		expect(bridge.dispatch(ELEMENT_REQUEST)).toBe(NOT_READY);
		expect(bridge.roots(['n1'])).toBe('[]');
		expect(bridge.dispatch('{"id": "a\\u00e9", "op": "element", "element_id": "n1"}')).toBe(
			'{"id": "a\\u00e9", "error": "BridgeError: replica is not ready"}'
		);
		expect(bridge.dispatch('[1]')).toBe(
			'{"id": null, "error": "BridgeError: replica is not ready"}'
		);
		expect(bridge.dispatch('{"id": ')).toBe(
			'{"id": null, "error": "BridgeError: replica is not ready"}'
		);
		expect(bridge.dispatch('{"op": "element"}')).toBe(
			'{"id": null, "error": "BridgeError: replica is not ready"}'
		);
	}, 60_000);

	it('answers it while the replica opens', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		await client.call('open', { project_id: 'demo', metamodel: doc });
		expect(tracker.bridges[0]!.dispatch(ELEMENT_REQUEST)).toBe(NOT_READY);
	}, 60_000);

	it("keeps a run's bridge on its own replica: a replacement never lets it read the new one", async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		const bridge = tracker.bridges[0]!;
		const name = (reply: string) =>
			(JSON.parse(reply) as { element: { properties: { name: string } } }).element.properties.name;
		expect(name(bridge.dispatch(ELEMENT_REQUEST))).toBe('one');

		// Nothing asks the bridge between the old replica and the new one.
		const other = bridgeModel();
		applyBatch(other, [rename('n1', 'replaced')]);
		await openReplica(client, other, doc);
		expect(bridge.dispatch(ELEMENT_REQUEST)).toBe(NOT_READY);
		expect(bridge.roots(['n1'])).toBe('[]');
		const run = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(run.results[0]!)).toBe('replaced');
		expect(tracker.hosts).toHaveLength(1);
		expect(tracker.bridges).toHaveLength(2);
		expect(name(tracker.bridges[1]!.dispatch(ELEMENT_REQUEST))).toBe('replaced');
		expect(bridge.dispatch(ELEMENT_REQUEST)).toBe(NOT_READY);
	}, 60_000);

	it('answers it once the replica has diverged, and scriptCalls is refused 409', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		const committed = bridgeModel();
		const server = new Server(clone(committed));
		await openReplica(client, committed, doc);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		const bridge = tracker.bridges[0]!;
		const { delta } = server.commit([rename('n1', 'x')]);
		await client.call('applyDelta', {
			text: deltaText({ ...delta, state_digest: '0'.repeat(16) })
		});
		expect(bridge.dispatch(ELEMENT_REQUEST)).toBe(NOT_READY);
		expect(await refusal(client.call('scriptCalls', batch(NAME, [['n1']])))).toEqual({
			status: 409,
			detail: 'replica is not ready'
		});
	}, 60_000);
});

describe('a replica that goes while a script call is in flight', () => {
	it('refuses a call after a close 409, the first having succeeded', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		const first = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(answer(first.results[0]!).error).toBeNull();
		await client.call('close');
		expect(await refusal(client.call('scriptCalls', batch(NAME, [['n1']])))).toEqual({
			status: 409,
			detail: 'replica is not ready'
		});
	}, 60_000);

	it('refuses a call whose replica was closed while its host booted', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		const calling = client.call('scriptCalls', batch(NAME, [['n1']]));
		const closed = client.call('close');
		expect(await refusal(calling)).toEqual({ status: 409, detail: 'replica closed' });
		await closed;
		// The service still answers, and boots a host of its own for the next replica.
		await openReplica(client, bridgeModel(), doc);
		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n2']]));
		expect(payloadOf(next.results[0]!)).toBe('two');
		expect(tracker.hosts).toHaveLength(2);
	}, 60_000);

	it('refuses a call whose replica was replaced while the host booted', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		const calling = client.call<CallsResult>('scriptCalls', batch(NAME, [['n1'], ['n2']]));
		await client.call('open', { project_id: 'demo', metamodel: doc });
		expect(await refusal(calling)).toEqual({ status: 409, detail: 'replica closed' });
		// Nothing is stuck: the new replica opens and is read.
		await openReplica(client, bridgeModel(), doc);
		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n2']]));
		expect(payloadOf(next.results[0]!)).toBe('two');
		expect(tracker.hosts).toHaveLength(1);
	}, 60_000);

	it('refuses a call whose replica was replaced and became ready while the host booted', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		// The element ids belong to the replica the call arrived on; the new one holds another n1.
		const calling = client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		const other = bridgeModel();
		applyBatch(other, [rename('n1', 'replaced')]);
		await openReplica(client, other, doc);
		expect(await refusal(calling)).toEqual({ status: 409, detail: 'replica closed' });
		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(next.results[0]!)).toBe('replaced');
	}, 60_000);

	it('pins a run to its replica: the bridge answers not-ready once it was replaced', async () => {
		// The real Node host runs to its end in one turn, so a gate holds its `run` while the replica changes.
		const seen: { reply: string; roots: string }[] = [];
		let entered = () => {};
		let gate: Promise<void> = Promise.resolve();
		const real = tracked();
		all.push(real);
		const factory: ScriptHostFactory = () => {
			const host = real.factory();
			return {
				boot: () => host.boot(),
				prewarm: () => host.prewarm(),
				warmed: () => host.warmed(),
				dispose: () => host.dispose(),
				async run(batch, bridge, signal) {
					entered();
					await gate;
					seen.push({ reply: bridge.dispatch(ELEMENT_REQUEST), roots: bridge.roots(['n1']) });
					return host.run(batch, bridge, signal);
				}
			};
		};
		const client = connect(autoHost(), portPair(), { scripts: factory });
		await openReplica(client, bridgeModel(), doc);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		seen.length = 0;
		const inside = new Promise<void>((resolve) => (entered = resolve));

		let release!: () => void;
		gate = new Promise<void>((resolve) => (release = resolve));
		const calling = client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		await inside;
		const other = bridgeModel();
		applyBatch(other, [rename('n1', 'replaced')]);
		await openReplica(client, other, doc);
		release();
		expect(await refusal(calling)).toEqual({ status: 409, detail: 'replica closed' });
		expect(seen).toEqual([{ reply: NOT_READY, roots: '[]' }]);

		// The run's bridge stays on its replica; the next run's bridge reads the new one.
		expect(real.bridges[0]!.dispatch(ELEMENT_REQUEST)).toBe(NOT_READY);
		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(next.results[0]!)).toBe('replaced');
		expect(real.bridges[0]!.dispatch(ELEMENT_REQUEST)).toBe(NOT_READY);
		expect(real.bridges.at(-1)!.dispatch(ELEMENT_REQUEST)).toContain('"replaced"');
	}, 60_000);
});

/** Reads, then waits a second: a run that stays in flight, and shows it by its trip. */
const SLOW =
	'import time\ndef value(els):\n    els[0].outgoing()\n    time.sleep(1)\n    return els[0].name';
/** Reads once, then never ends. */
const FOREVER = 'def value(els):\n    els[0].outgoing()\n    while True:\n        pass';

describe('script calls at once', () => {
	let client: Client;
	let tracker: ReturnType<typeof tracked>;

	afterAll(() => tracker.dispose());
	beforeAll(async () => {
		({ client, tracker } = scripted(tracked({ cap: 2 })));
		await openReplica(client, bridgeModel(), doc);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		// The cold first boot and the image are behind it: both calls below find a spare up.
		await client.call('scriptWarm');
	}, 60_000);

	it('runs two calls in parallel, each on the replica it arrived on', async () => {
		tracker.log.length = 0;
		const [a, b] = await Promise.all([
			client.call<CallsResult>('scriptCalls', batch(SLOW, [['n1']])),
			client.call<CallsResult>('scriptCalls', batch(SLOW, [['n2']]))
		]);
		expect([payloadOf(a.results[0]!), payloadOf(b.results[0]!)]).toEqual(['one', 'two']);
		expect(Math.min(a.trips, b.trips)).toBeGreaterThanOrEqual(1);
		const at = (entry: string) => tracker.log.indexOf(entry);
		// Each starts reading before the other ends: they overlap.
		expect(at('n2:trip')).toBeGreaterThan(-1);
		expect(at('n2:trip')).toBeLessThan(at('n1:end'));
		expect(at('n1:trip')).toBeLessThan(at('n2:end'));
	}, 60_000);

	it('gives each `script` run ops of its own', async () => {
		const create = (name: string) =>
			client.call<CallsResult>(
				'scriptCalls',
				batch(`dr.create("Node", {"name": "${name}"})\nresult = "${name}"`, [[]], 'script')
			);
		const [a, b] = await Promise.all([create('a'), create('b')]);
		const ops = (name: string) =>
			`[{"kind": "create_element", "temp_id": "tmp_1", "type_name": "Node", "properties": {"name": "${name}"}}]`;
		expect(a.ops).toBe(ops('a'));
		expect(b.ops).toBe(ops('b'));
		expect(a.results).toEqual([
			{ text: '{"stdout": "", "result_repr": "\'a\'", "truncated": false}' }
		]);
		const quiet = await client.call<CallsResult>('scriptCalls', batch(CONSOLE, [[]], 'script'));
		expect(quiet.ops).toBe('[]');
	}, 60_000);

	it('runs an embedded entry as a console run when asked, on the shared read-only dispatcher', async () => {
		const result = await client.call<CallsResult>('scriptCalls', {
			...batch('def value(els):\n    return [e.id for e in els]', [['n1', 'n2'], ['n3']]),
			console: true
		});
		expect(result.results.map((r) => r.text)).toEqual([
			'{"stdout": "", "result_repr": "[\'n1\', \'n2\']", "truncated": false}',
			'{"stdout": "", "result_repr": "[\'n3\']", "truncated": false}'
		]);
		expect(result).not.toHaveProperty('ops');
	}, 60_000);

	it("lets one run's trips reach only its own bridge", async () => {
		const before = tracker.bridges.length;
		await Promise.all([
			client.call('scriptCalls', batch(SLOW, [['n1']])),
			client.call('scriptCalls', batch(SLOW, [['n2']]))
		]);
		const mine = tracker.bridges.slice(before);
		expect(mine).toHaveLength(2);
		expect(mine[0]).not.toBe(mine[1]);
	}, 60_000);
});

describe('a replica replaced under runs in flight', () => {
	it('answers both runs 409, ends their workers and serves the new replica', async () => {
		const tracker = tracked({ cap: 2 });
		all.push(tracker);
		const { client } = scripted(tracker);
		await openReplica(client, bridgeModel(), doc);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		tracker.log.length = 0;

		const first = refusal(client.call('scriptCalls', batch(FOREVER, [['n1']])));
		const second = refusal(client.call('scriptCalls', batch(FOREVER, [['n2']])));
		await until(() => tracker.log.includes('n1:trip') && tracker.log.includes('n2:trip'));
		const bridges = tracker.bridges.slice(-2);

		const other = bridgeModel();
		applyBatch(other, [rename('n1', 'replaced')]);
		await openReplica(client, other, doc);
		expect(await first).toEqual({ status: 409, detail: 'replica closed' });
		expect(await second).toEqual({ status: 409, detail: 'replica closed' });
		for (const bridge of bridges) expect(bridge.dispatch(ELEMENT_REQUEST)).toBe(NOT_READY);

		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(next.results[0]!)).toBe('replaced');
		// Every worker that ran a batch is gone; at most the cap's worth of spares lives.
		await until(() => tracker.alive() <= 2);
		expect(tracker.hosts).toHaveLength(1);
	}, 90_000);

	it("does not hold the new replica's calls behind a runaway of the old one", async () => {
		const tracker = tracked({ cap: 1 });
		all.push(tracker);
		const { client } = scripted(tracker);
		await openReplica(client, bridgeModel(), doc);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		tracker.log.length = 0;

		const stuck = refusal(client.call('scriptCalls', batch(FOREVER, [['n1']])));
		await until(() => tracker.log.includes('n1:trip'));
		await openReplica(client, bridgeModel(), doc);
		const started = Date.now();
		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n2']]));
		expect(payloadOf(next.results[0]!)).toBe('two');
		// Left alone the runaway would run to its 10 s limit.
		expect(Date.now() - started).toBeLessThan(8_000);
		expect(await stuck).toEqual({ status: 409, detail: 'replica closed' });
	}, 90_000);
});

describe('cancelling a script call', () => {
	it("stops the run's worker, so the next call is not held until the loop ends", async () => {
		const tracker = tracked({ cap: 1 });
		all.push(tracker);
		const { client } = scripted(tracker);
		await openReplica(client, bridgeModel(), doc);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		tracker.log.length = 0;

		const calls = batch(FOREVER, [['n1']]);
		const running = client.callAs('cancel-me', 'scriptCalls', calls);
		const answered = vi.fn();
		running.then(answered, answered);
		await until(() => tracker.log.includes('n1:trip'));
		const started = Date.now();
		client.cancel('cancel-me');
		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n2']]));
		expect(payloadOf(next.results[0]!)).toBe('two');
		// A soft stop ends the loop at once: far inside the 10 s the call would have run.
		expect(Date.now() - started).toBeLessThan(8_000);
		expect(tracker.log).toContain('n1:end');
		// The cancelled call is never answered.
		expect(answered).not.toHaveBeenCalled();
	}, 90_000);

	it('answers a cancel before any boot as no answer, and the next call still runs', async () => {
		const { client, tracker } = scripted(tracked({ cap: 1 }));
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		const answered = vi.fn();
		const calling = client.callAs('early', 'scriptCalls', batch(NAME, [['n1']]));
		calling.then(answered, answered);
		client.cancel('early');
		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n2']]));
		expect(payloadOf(next.results[0]!)).toBe('two');
		expect(answered).not.toHaveBeenCalled();
	}, 60_000);
});

describe('prewarming the script host', () => {
	const artifact = (id: string, kind: string) => ({
		id,
		kind,
		name: id,
		artifact_rev: 1,
		payload: {}
	});

	/** A factory that counts what the service asks of a real pool. */
	function counting() {
		const real = tracked();
		const counts = { prewarm: 0, made: 0 };
		const factory: ScriptHostFactory = () => {
			counts.made++;
			const host = real.factory();
			return {
				boot: () => host.boot(),
				prewarm() {
					counts.prewarm++;
					host.prewarm();
				},
				warmed: () => host.warmed(),
				run: (call, bridge, signal) => host.run(call, bridge, signal),
				dispose: () => host.dispose()
			};
		};
		all.push(real);
		return { counts, factory, real };
	}

	it('starts a boot when the artifacts hold a snippet, before any call', async () => {
		const { counts, factory, real } = counting();
		const client = connect(autoHost(), portPair(), { scripts: factory, prewarmScripts: true });
		await openReplica(client, bridgeModel(), doc);
		await client.call('setArtifacts', { artifacts: [artifact('t1', 'table')] });
		expect(counts).toEqual({ prewarm: 0, made: 0 });

		await client.call('setArtifacts', {
			artifacts: [artifact('t1', 'table'), artifact('s1', 'code_snippet')]
		});
		expect(counts).toEqual({ prewarm: 1, made: 1 });
		// The boot is on its way: a worker exists before the first call.
		await until(() => real.alive() > 0);
		const run = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(run.results[0]!)).toBe('one');
		expect(counts.made).toBe(1);
	}, 60_000);

	it('prewarms once for a replica, and again for the next', async () => {
		const { counts, factory } = counting();
		const client = connect(autoHost(), portPair(), { scripts: factory, prewarmScripts: true });
		const artifacts = [artifact('s1', 'code_snippet')];
		await openReplica(client, bridgeModel(), doc);
		await client.call('setArtifacts', { artifacts });
		await client.call('putArtifacts', {
			changed: [artifact('s2', 'code_snippet')],
			deleted_ids: []
		});
		expect(counts.prewarm).toBe(1);
		await openReplica(client, bridgeModel(), doc);
		expect(counts.prewarm).toBe(2);
		await client.call('putArtifacts', {
			changed: [artifact('s3', 'code_snippet')],
			deleted_ids: []
		});
		expect(counts.prewarm).toBe(2);
	}, 60_000);

	it('prewarms when a replica becomes ready over artifacts that were already there', async () => {
		const { counts, factory } = counting();
		const client = connect(autoHost(), portPair(), { scripts: factory, prewarmScripts: true });
		await client.call('setArtifacts', { artifacts: [artifact('s1', 'code_snippet')] });
		expect(counts).toEqual({ prewarm: 0, made: 0 });
		await openReplica(client, bridgeModel(), doc);
		expect(counts).toEqual({ prewarm: 1, made: 1 });

		// `close` disposes the host but the artifacts stay: the next replica prewarms a new one.
		await client.call('close');
		await openReplica(client, bridgeModel(), doc);
		expect(counts).toEqual({ prewarm: 2, made: 2 });
	}, 60_000);

	it('creates no host for a snippet move with no ready replica', async () => {
		const { counts, factory } = counting();
		const client = connect(autoHost(), portPair(), { scripts: factory, prewarmScripts: true });
		await client.call('setArtifacts', { artifacts: [artifact('s1', 'code_snippet')] });
		await openReplica(client, bridgeModel(), doc);
		await client.call('close');
		expect(counts).toEqual({ prewarm: 1, made: 1 });
		await client.call('putArtifacts', {
			changed: [artifact('s2', 'code_snippet')],
			deleted_ids: []
		});
		expect(counts).toEqual({ prewarm: 1, made: 1 });

		// An open that is not ready yet does not prewarm either.
		await client.call('open', { project_id: 'demo', metamodel: doc });
		await client.call('putArtifacts', {
			changed: [artifact('s3', 'code_snippet')],
			deleted_ids: []
		});
		expect(counts).toEqual({ prewarm: 1, made: 1 });
	}, 60_000);

	it('does not prewarm for a replica that has diverged', async () => {
		const { counts, factory } = counting();
		const client = connect(autoHost(), portPair(), { scripts: factory, prewarmScripts: true });
		const committed = bridgeModel();
		const server = new Server(clone(committed));
		await openReplica(client, committed, doc);
		const { delta } = server.commit([rename('n1', 'x')]);
		await client.call('applyDelta', {
			text: deltaText({ ...delta, state_digest: '0'.repeat(16) })
		});
		await client.call('setArtifacts', { artifacts: [artifact('s1', 'code_snippet')] });
		expect(counts).toEqual({ prewarm: 0, made: 0 });
	}, 60_000);

	it('prewarms for a staged snippet, and not for a snippet whose delete is staged', async () => {
		const { counts, factory } = counting();
		const client = connect(autoHost(), portPair(), { scripts: factory, prewarmScripts: true });
		await openReplica(client, bridgeModel(), doc);
		await client.call('putArtifacts', {
			changed: [artifact('s1', 'code_snippet')],
			deleted_ids: [],
			staged: [{ op: 'delete', id: 's1' }]
		});
		expect(counts.prewarm).toBe(0);
		await client.call('setStagedArtifacts', {
			entries: [{ op: 'create', id: 'tmp', kind: 'code_snippet', name: 'n', payload: {} }]
		});
		expect(counts.prewarm).toBe(1);
	}, 60_000);

	it('does not prewarm unless the deps opt in', async () => {
		const { counts, factory } = counting();
		const client = connect(autoHost(), portPair(), { scripts: factory });
		await openReplica(client, bridgeModel(), doc);
		await client.call('setArtifacts', { artifacts: [artifact('s1', 'code_snippet')] });
		await client.call('setStagedArtifacts', {
			entries: [{ op: 'create', id: 'tmp', kind: 'code_snippet', name: 'n', payload: {} }]
		});
		expect(counts).toEqual({ prewarm: 0, made: 0 });
		// The host is still made on first use.
		const run = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(run.results[0]!)).toBe('one');
		expect(counts).toEqual({ prewarm: 0, made: 1 });
	}, 60_000);

	it('does nothing without a script host in the deps', async () => {
		const client = connect();
		await openReplica(client, bridgeModel(), doc);
		await client.call('setArtifacts', { artifacts: [artifact('s1', 'code_snippet')] });
	});
});

describe('scriptWarm', () => {
	it('answers once the pool holds cap spares, and a run then starts on one', async () => {
		const { client, tracker } = scripted(tracked({ cap: 2 }));
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		const warm = await client.call<{ spares: number }>('scriptWarm');
		expect(warm).toEqual({ spares: 2 });
		const run = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(run.results[0]!)).toBe('one');
	}, 120_000);

	it('is refused 501 where no script host is supplied, and 409 when a close ends the host under it', async () => {
		expect(await refusal(connect().call('scriptWarm'))).toMatchObject({ status: 501 });
		const { client, tracker } = scripted(tracked({ cap: 1 }));
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		const waiting = refusal(client.call('scriptWarm'));
		await client.call('close');
		expect(await waiting).toEqual({ status: 409, detail: 'replica closed' });
	}, 60_000);
});

describe('the host across close and open', () => {
	it('makes the host on first use, disposes it on close and boots another after', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		expect(tracker.hosts).toHaveLength(0);
		await client.call('scriptCalls', batch(NAME, [['n1']]));
		await client.call('scriptCalls', batch(NAME, [['n2']]));
		expect(tracker.hosts).toHaveLength(1);

		await client.call('close');
		await expect(tracker.hosts[0]!.boot()).rejects.toThrow(/disposed/);

		await openReplica(client, bridgeModel(), doc);
		const result = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n3']]));
		expect(payloadOf(result.results[0]!)).toBe('three');
		expect(tracker.hosts).toHaveLength(2);
		expect(tracker.hosts[1]).not.toBe(tracker.hosts[0]);
	}, 60_000);
});

describe('the host boots again where it can', () => {
	/** The real Node host, whose first boot attempt fails after `delay` ms, as a fetch of the interpreter's files may. */
	function failingFirstBoot(delay: number) {
		const real = tracked();
		all.push(real);
		let attempts = 0;
		let failing: Promise<never> | null = null;
		const factory: ScriptHostFactory = () => {
			const host = real.factory();
			return {
				prewarm: () => host.prewarm(),
				warmed: () => host.warmed(),
				boot() {
					if (failing !== null) return failing;
					if (attempts++ > 0) return host.boot();
					failing = new Promise<never>((_, reject) =>
						setTimeout(() => {
							failing = null;
							reject(new Error('pyodide fetch failed'));
						}, delay)
					);
					return failing;
				},
				run: (batch, bridge) => host.run(batch, bridge),
				dispose: () => host.dispose()
			};
		};
		return { real, factory };
	}

	it('does not keep a failed boot: the next call boots again on the same host', async () => {
		const { real, factory } = failingFirstBoot(10);
		const client = connect(autoHost(), portPair(), { scripts: factory });
		await openReplica(client, bridgeModel(), doc);
		expect(await refusal(client.call('scriptCalls', batch(NAME, [['n1']])))).toEqual({
			status: 500,
			detail: 'pyodide fetch failed'
		});
		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n2']]));
		expect(payloadOf(next.results[0]!)).toBe('two');
		expect(next.boot_ms).toBeGreaterThan(0);
		expect(real.hosts).toHaveLength(1);
	}, 60_000);

	it('answers every call waiting on the same failed boot 500, none as a closed replica', async () => {
		const { factory } = failingFirstBoot(50);
		const client = connect(autoHost(), portPair(), { scripts: factory });
		await openReplica(client, bridgeModel(), doc);
		const refused = await Promise.all(
			[['n1'], ['n2'], ['n3']].map((ids) => refusal(client.call('scriptCalls', batch(NAME, [ids]))))
		);
		for (const each of refused) {
			expect(each).toEqual({ status: 500, detail: 'pyodide fetch failed' });
		}
		const next = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n3']]));
		expect(payloadOf(next.results[0]!)).toBe('three');
	}, 60_000);

	it('goes through boot() for every call and reports the boot that serves it', async () => {
		// A host that reboots after a crash, as the browser host does: `boot()` is idempotent while it lives.
		const real = tracked();
		all.push(real);
		let generation = 1;
		let crashNext = false;
		const factory: ScriptHostFactory = () => {
			const host = real.factory();
			return {
				boot: () => host.boot().then(() => ({ ms: generation })),
				prewarm: () => host.prewarm(),
				warmed: () => host.warmed(),
				async run(batch, bridge) {
					if (crashNext) {
						crashNext = false;
						generation++;
						throw new Error('the script worker stopped');
					}
					return { ...(await host.run(batch, bridge)), bootMs: generation };
				},
				dispose: () => host.dispose()
			};
		};
		const client = connect(autoHost(), portPair(), { scripts: factory });
		await openReplica(client, bridgeModel(), doc);
		expect((await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]))).boot_ms).toBe(1);
		crashNext = true;
		expect(await refusal(client.call('scriptCalls', batch(NAME, [['n1']])))).toEqual({
			status: 500,
			detail: 'the script worker stopped'
		});
		const after = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n2']]));
		expect(after.boot_ms).toBe(2);
		expect(payloadOf(after.results[0]!)).toBe('two');
		expect(real.hosts).toHaveLength(1);
	}, 60_000);
});

describe('a host answer the service cannot trust', () => {
	/** The real Node host, whose run answers through `shape`. */
	function shaped(shape: (results: ScriptRun['results']) => unknown) {
		const real = tracked();
		all.push(real);
		const factory: ScriptHostFactory = () => {
			const host = real.factory();
			return {
				boot: () => host.boot(),
				prewarm: () => host.prewarm(),
				warmed: () => host.warmed(),
				run: async (call, bridge) => {
					const run = await host.run(call, bridge);
					return { ...run, results: shape(run.results) } as ScriptRun;
				},
				dispose: () => host.dispose()
			};
		};
		return factory;
	}

	const refused = async (factory: ScriptHostFactory) => {
		const client = connect(autoHost(), portPair(), { scripts: factory });
		await openReplica(client, bridgeModel(), doc);
		return refusal(client.call('scriptCalls', batch(NAME, [['n1'], ['n2']])));
	};

	it('refuses 500 a host that answers fewer results than calls', async () => {
		const answer = await refused(shaped((results) => results.slice(1)));
		expect(answer.status).toBe(500);
		expect(answer.detail).toMatch(/1 result.*2 calls/);
	}, 60_000);

	it('refuses 500 a host whose result has no text', async () => {
		for (const bad of [null, {}, { text: null }, { text: 3 }]) {
			const answer = await refused(shaped((results) => [results[0], bad]));
			expect(answer.status).toBe(500);
			expect(answer.detail).toMatch(/without text/);
		}
	}, 60_000);
});
