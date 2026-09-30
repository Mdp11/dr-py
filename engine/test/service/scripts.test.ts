import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBatch, type MetamodelDoc, type ModelOp } from '../../src/index.ts';
import type { Bridge, ScriptHost, ScriptHostFactory, ScriptRun } from '../../src/script/host.ts';
import { nodeScriptHost } from '../../node/script-host.ts';
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

/** The real Node host, with every host and bridge the service made kept for the test to look at. */
function tracked() {
	const hosts: ScriptHost[] = [];
	const bridges: Bridge[] = [];
	const factory: ScriptHostFactory = (bridge) => {
		const host = nodeScriptHost(bridge);
		hosts.push(host);
		bridges.push(bridge);
		return host;
	};
	return { hosts, bridges, factory, dispose: () => hosts.forEach((host) => host.dispose()) };
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

const all: { dispose(): void }[] = [];
afterAll(() => all.forEach((each) => each.dispose()));

describe('scriptCalls on a ready replica', () => {
	let client: Client;
	let tracker: ReturnType<typeof tracked>;

	beforeAll(async () => {
		({ client, tracker } = scripted());
		all.push(tracker);
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
		expect(result.boot_ms).toBeGreaterThan(0);
		expect(result.results[0]!.text).toBe(
			'{"payload": {"kind": "scalar", "value": "two"}, "error": null, "reads": [["el", "n2"]], "stdout": ""}'
		);
	});

	it('reads what a script needs from the working copy through the bridge', async () => {
		const result = await client.call<CallsResult>(
			'scriptCalls',
			batch('def value(els): return len(els[0].outgoing())', [['n1']])
		);
		expect(payloadOf(result.results[0]!)).toBe(5);
		expect(result.trips).toBeGreaterThanOrEqual(1);
	});

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
	});

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
	});

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
	});

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
			{ name: 'entry script', params: { ...good, entry: 'script' } },
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
			(await refusal(client.call('scriptCalls', { ...batch(NAME, [['n1']]), entry: 'script' })))
				.status
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

	it('reads the new replica after a replacement, never the one it was built for', async () => {
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
		expect(name(bridge.dispatch(ELEMENT_REQUEST))).toBe('replaced');
		const run = await client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']]));
		expect(payloadOf(run.results[0]!)).toBe('replaced');
		expect(tracker.hosts).toHaveLength(1);
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
		const factory: ScriptHostFactory = (bridge) => {
			const host = real.factory(bridge);
			return {
				boot: () => host.boot(),
				dispose: () => host.dispose(),
				async run(batch) {
					entered();
					await gate;
					seen.push({ reply: bridge.dispatch(ELEMENT_REQUEST), roots: bridge.roots(['n1']) });
					return host.run(batch);
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

		// With no run in flight the bridge reads the current replica again.
		const reply = JSON.parse(real.bridges[0]!.dispatch(ELEMENT_REQUEST)) as {
			element: { properties: { name: string } };
		};
		expect(reply.element.properties.name).toBe('replaced');
	}, 60_000);

	it('runs calls one at a time, each on the replica it arrived on', async () => {
		const { client, tracker } = scripted();
		all.push(tracker);
		await openReplica(client, bridgeModel(), doc);
		const [a, b] = await Promise.all([
			client.call<CallsResult>('scriptCalls', batch(NAME, [['n1']])),
			client.call<CallsResult>('scriptCalls', batch(NAME, [['n2']]))
		]);
		expect([payloadOf(a.results[0]!), payloadOf(b.results[0]!)]).toEqual(['one', 'two']);
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
		const factory: ScriptHostFactory = (bridge) => {
			const host = real.factory(bridge);
			return {
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
				run: (batch) => host.run(batch),
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
		const factory: ScriptHostFactory = (bridge) => {
			const host = real.factory(bridge);
			return {
				boot: () => host.boot().then(() => ({ ms: generation })),
				async run(batch) {
					if (crashNext) {
						crashNext = false;
						generation++;
						throw new Error('the script worker stopped');
					}
					return host.run(batch);
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
		const factory: ScriptHostFactory = (bridge) => {
			const host = real.factory(bridge);
			return {
				boot: () => host.boot(),
				run: async (call) => {
					const run = await host.run(call);
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
