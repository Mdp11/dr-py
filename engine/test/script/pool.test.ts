import { afterAll, describe, expect, it } from 'vitest';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../../src/script/bridge.ts';
import type { Bridge, ScriptBatch, ScriptHost } from '../../src/script/host.ts';
import { hostErrorText } from '../../src/script/host-error.ts';
import { createPool, type WorkerPort, type WorkerSpawner } from '../../src/script/pool.ts';
import { nodeScriptHost, poolCap, spawnNodeWorker } from '../../node/script-host.ts';
import { expectParity, loadParity, parityBatch, parityModel } from './parity.ts';

// The pool over real Pyodide in real worker threads: what it runs, and that no batch ever shares a
// worker with another. The protocol handling over scripted workers is in `pool-protocol.test.ts`.

type Seen = {
	runs: number;
	terminated: boolean;
	/** It was told to make the snapshot: it serves no batch and holds no slot of the cap. */
	maker: boolean;
	messages: { type?: unknown; i?: unknown }[];
};

/** `spawnNodeWorker`, counting what each worker is asked and says, and when it is ended. */
function instrumented(inner: WorkerSpawner = spawnNodeWorker) {
	const seen: Seen[] = [];
	let peak = 0;
	const alive = () => seen.filter((one) => !one.terminated && !one.maker).length;
	const spawn: WorkerSpawner = (buffers) => {
		const port = inner(buffers);
		const here: Seen = { runs: 0, terminated: false, maker: false, messages: [] };
		seen.push(here);
		const wrapped: WorkerPort = {
			post(message, transfer) {
				const { type, make } = message as { type?: unknown; make?: unknown };
				if (type === 'run') here.runs++;
				if (type === 'init') {
					here.maker = make === true;
					peak = Math.max(peak, alive());
				}
				port.post(message, transfer);
			},
			onMessage: (handler) =>
				port.onMessage((message) => {
					here.messages.push(message as Seen['messages'][number]);
					handler(message);
				}),
			onError: (handler) => port.onError(handler),
			terminate() {
				here.terminated = true;
				port.terminate();
			}
		};
		return wrapped;
	};
	return { spawn, seen, alive, peak: () => peak };
}

function recording(readOnlyRun: boolean) {
	const dispatcher = new BridgeDispatcher(parityModel(), !readOnlyRun);
	const requests: string[] = [];
	const bridge: Bridge = {
		dispatch: (text) => (requests.push(text), dispatcher.dispatch(text)),
		roots: (ids) => dumpDefault(projectRoots(parityModel(), ids))
	};
	return { bridge, dispatcher, requests };
}

const transform = (code: string): ScriptBatch => ({
	code,
	entry: 'transform',
	calls: [{ elementIds: [] }]
});

const HONEST_42 =
	'{"payload": {"kind": "json", "value": 42}, "error": null, "reads": [], "stdout": ""}';

const pools: ScriptHost[] = [];
const pool = (host: ScriptHost) => (pools.push(host), host);
afterAll(() => pools.forEach((host) => host.dispose()));

describe('the pool size of the Node host', () => {
	it('is the cores less two, between one and four', () => {
		expect([1, 2, 3, 4, 5, 6, 7, 64].map(poolCap)).toEqual([1, 1, 1, 2, 3, 4, 4, 4]);
	});
});

describe('a script cannot reach another batch (K-105)', () => {
	// What a script on the Node port reaches: Pyodide's `js` module gives it the worker's `process`,
	// and through it the real `parentPort`, the harness's entry points in `__main__` and `json`.
	const prelude = `
import __main__, json, js
from pyodide.ffi import create_proxy, to_js
pp = js.process.getBuiltinModule('node:worker_threads').parentPort
real = pp.postMessage.bind(pp)
def say(**message):
    real(to_js(message, dict_converter=js.Object.fromEntries))
`;
	const answer42 = 'def transform(doc):\n    return 42\n';
	const rebind = `${prelude}
pp.postMessage = create_proxy(lambda *a: None)
__main__._dr_batch = None
__main__._dr_call = lambda *a, **k: {"payload": "FORGED"}
json.loads = lambda s: {"payload": "FORGED"}
${answer42}`;
	const breakReply = `
import json
json.dumps = lambda *a, **k: '"FORGED"'
${answer42}`;
	const forge = (line: string) => `${prelude}\n${line}\n${answer42}`;
	const forgeReady = forge("say(type='ready', ms=1, boot='cold')");
	const forgeDone = forge("say(type='done', results=[{'text': 'FORGED'}], trips=0, ms=1)");
	const forgeFailed = forge("say(type='failed', message='FORGED')");
	const slowHonest = `import time\ntime.sleep(2)\n${answer42}`;

	it('answers later batches honestly after ones that rebind the harness, json and the port', async () => {
		const ported = instrumented();
		const host = pool(createPool(ported.spawn, { cap: 2, now: () => performance.now() }));
		const first = await host.run(transform(rebind), recording(true).bridge);
		// The hijack took hold inside its own worker; rebinding the port's method did not silence it.
		expect(first.results.map((r) => r.text)).toEqual(['{"payload": "FORGED"}']);
		const second = await host.run(transform(answer42), recording(true).bridge);
		expect(second.results.map((r) => r.text)).toEqual([HONEST_42]);
		const broken = await host.run(transform(breakReply), recording(true).bridge);
		expect(JSON.parse(broken.results[0]!.text).error.kind).toBe('runtime');
		const third = await host.run(transform(answer42), recording(true).bridge);
		expect(third.results.map((r) => r.text)).toEqual([HONEST_42]);
		const used = ported.seen.filter((one) => one.runs > 0);
		expect(used).toHaveLength(4);
		expect(ported.seen.every((one) => one.runs <= 1)).toBe(true);
		expect(used.every((one) => one.terminated)).toBe(true);
	}, 60_000);

	it('keeps a batch honest while others post forged ready, done and failed through the real port', async () => {
		const ported = instrumented();
		const host = pool(createPool(ported.spawn, { cap: 5, now: () => performance.now() }));
		const go = (code: string) => host.run(transform(code), recording(true).bridge);
		// The honest batch sleeps, so the forgers run on other workers while it is in flight.
		const honest = go(slowHonest);
		const [ready, done, failed] = await Promise.all([
			go(forgeReady),
			go(forgeDone),
			go(forgeFailed)
		]);
		const text = (run: { results: readonly { text: string }[] }) => run.results[0]!.text;
		const batch = transform('');
		// Each forger changed only its own batch's answer.
		expect(text(ready)).toBe(
			hostErrorText(batch, 'runtime', 'the script worker sent a bad "ready"')
		);
		expect(text(done)).toBe('FORGED');
		expect(text(failed)).toBe(hostErrorText(batch, 'runtime', 'FORGED'));
		expect(text(await honest)).toBe(HONEST_42);
		expect(ported.seen.filter((one) => one.runs > 0)).toHaveLength(4);
		expect(ported.seen.every((one) => one.runs <= 1)).toBe(true);
	}, 60_000);

	it('reports each call of a batch as it starts and ends, before its done', async () => {
		const here = instrumented();
		const own = pool(createPool(here.spawn, { cap: 1, now: () => performance.now() }));
		await own.run(
			{
				code: 'def value(els): return 1',
				entry: 'value',
				calls: [{ elementIds: ['n1'] }, { elementIds: ['n2'] }]
			},
			recording(true).bridge
		);
		const events = here.seen
			.find((one) => one.runs > 0)!
			.messages.filter((m) => ['call-start', 'call-end', 'done'].includes(m.type as string))
			.map((m) => (m.type === 'done' ? 'done' : `${m.type as string} ${m.i as number}`));
		expect(events).toEqual(['call-start 0', 'call-end 0', 'call-start 1', 'call-end 1', 'done']);
	}, 60_000);
});

describe('concurrent runs on a cap of two', () => {
	const ported = instrumented();
	const host = pool(createPool(ported.spawn, { cap: 2, now: () => performance.now() }));

	it('keeps at most two workers alive, answers all four rightly, and counts each run’s trips', async () => {
		const ids = ['n2', 'l1', 'o1', 'é1'];
		const runs = ids.map((_, k) => {
			const mine = recording(true);
			const code = `def value(els):\n    return [dr.element(i).id for i in ${JSON.stringify(ids.slice(0, k + 1))}]\n`;
			const batch: ScriptBatch = { code, entry: 'value', calls: [{ elementIds: ['n1'] }] };
			return host.run(batch, mine.bridge).then((run) => ({ run, mine, k }));
		});
		for (const { run, mine, k } of await Promise.all(runs)) {
			const answer = JSON.parse(run.results[0]!.text) as {
				payload: { values: string[] };
				error: null;
			};
			expect(answer.error).toBeNull();
			expect(answer.payload.values).toEqual(ids.slice(0, k + 1));
			expect(run.trips).toBe(mine.requests.length);
			expect(run.trips).toBeGreaterThanOrEqual(k + 1);
			expect(run.boot).toBe('cold');
			expect(run.bootMs).toBeGreaterThan(0);
		}
		expect(ported.peak()).toBeLessThanOrEqual(2);
		expect(ported.seen.filter((one) => one.runs > 0)).toHaveLength(4);
		expect(ported.seen.every((one) => one.runs <= 1)).toBe(true);
	}, 60_000);

	it('keeps each run’s trips its own', async () => {
		const [a, b] = await Promise.all(
			[1, 3].map((n) => {
				const mine = recording(true);
				const ids = ['n2', 'l1', 'o1'].slice(0, n);
				const code = `def value(els):\n    return [dr.element(i).id for i in ${JSON.stringify(ids)}]\n`;
				return host
					.run({ code, entry: 'value', calls: [{ elementIds: ['n1'] }] }, mine.bridge)
					.then((run) => ({ run, mine }));
			})
		);
		expect(a!.run.trips).toBe(a!.mine.requests.length);
		expect(b!.run.trips).toBe(b!.mine.requests.length);
		expect(b!.run.trips).toBeGreaterThan(a!.run.trips);
	}, 60_000);
});

describe('the harness limits reach the worker', () => {
	const host = pool(
		createPool(spawnNodeWorker, {
			cap: 1,
			limits: { stdoutChars: 5, reprChars: 4 },
			now: () => performance.now()
		})
	);

	it('caps stdout and the result’s repr as the pool was told', async () => {
		const run = await host.run(
			{
				code: 'print("abcdefghij")\nresult = "wxyz012345"\n',
				entry: 'script',
				calls: [{ elementIds: [] }]
			},
			recording(false).bridge
		);
		expect(JSON.parse(run.results[0]!.text)).toEqual({
			stdout: 'abcde...',
			result_repr: "'wxy...",
			truncated: true
		});
	}, 60_000);
});

describe('dispose() over real workers', () => {
	it('rejects a boot and a run that wait on Pyodide, and ends every worker', async () => {
		const ported = instrumented();
		const host = createPool(ported.spawn, { cap: 2, now: () => performance.now() });
		const booting = host.boot();
		const running = host.run(transform('def transform(doc): return 1'), recording(true).bridge);
		const settled = Promise.allSettled([booting, running]);
		host.dispose();
		const [a, b] = await settled;
		expect([a.status, b.status]).toEqual(['rejected', 'rejected']);
		expect(ported.alive()).toBe(0);
	}, 60_000);

	it('rejects a run in flight in Python and ends its worker', async () => {
		const ported = instrumented();
		const host = createPool(ported.spawn, { cap: 1, now: () => performance.now() });
		const running = host.run(
			{
				code: 'import time\ndef value(els):\n    time.sleep(30)\n',
				entry: 'value',
				calls: [{ elementIds: ['n1'] }]
			},
			recording(true).bridge
		);
		const settled = running.then(
			() => 'resolved',
			(error: Error) => error.message
		);
		const started = () =>
			ported.seen.some((one) => one.messages.some((m) => m.type === 'call-start'));
		while (!started()) await new Promise((resolve) => setTimeout(resolve, 20));
		host.dispose();
		expect(await settled).toBe('script host is disposed');
		expect(ported.alive()).toBe(0);
	}, 60_000);
});

describe('the parity corpus through the Node host', () => {
	// The determinism group too: the pool's workers pin the clock, the entropy and the hash seed.
	const cases = loadParity();
	const host = pool(nodeScriptHost());
	const answers = new Map<string, Promise<void>>();

	it('has cases to run', () => {
		expect(cases.length).toBeGreaterThan(30);
	});

	// All cases are in flight at once, so the pool runs them its cap at a time.
	for (const c of cases) {
		it(`${c.group}/${c.name}`, async () => {
			if (answers.size === 0) {
				for (const each of cases) {
					answers.set(
						each.name,
						(async () => {
							const mine = recording(each.mode !== 'console');
							const run = await host.run(parityBatch(each), mine.bridge);
							expectParity(each, run.results, dumpDefault(mine.dispatcher.ops));
						})()
					);
				}
			}
			await answers.get(c.name);
		}, 120_000);
	}
});
