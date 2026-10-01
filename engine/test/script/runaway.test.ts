import { afterAll, describe, expect, it } from 'vitest';
import { createPool, type PoolOptions } from '../../src/script/pool.ts';
import { hostErrorText } from '../../src/script/host-error.ts';
import type { Bridge, ScriptBatch, ScriptHost, ScriptRun } from '../../src/script/host.ts';
import type { Value } from '../../src/value/types.ts';
import { spawnNodeWorker } from '../../node/script-host.ts';
import { instrumented } from './fixtures/instrumented.ts';

// Runaway scripts over real Pyodide in real worker threads: each ends by the soft stop or, when the
// interrupt cannot reach it, by ending its worker; the call answers as the server would and the
// next batch on the same pool is right. The protocol and its races over scripted workers are in
// `pool-stops.test.ts`.

const CALL_MS = 500;
const GRACE_MS = 1000;
const LIMITS = { callMs: CALL_MS, batchMs: 10_000, graceMs: GRACE_MS };
const TIMEOUT_MESSAGE = 'execution exceeded the wall timeout of 0.5s';
const CANCELLED_MESSAGE = 'the run was cancelled';
const TEST_MS = 60_000;

const HONEST_42 =
	'{"payload": {"kind": "json", "value": 42}, "error": null, "reads": [], "stdout": ""}';

/** No script of these tests reads the model. */
const bridge: Bridge = {
	dispatch: () => {
		throw new Error('no script of these tests asks the bridge');
	},
	roots: () => '[]'
};

/**
 * A transform that answers 42 for every doc but `'spin'`, for which it runs `body`. A call per doc,
 * so the batch's calls are told apart by what they do.
 */
function batchOf(body: string, docs: Value[], prelude = ''): ScriptBatch {
	const indented = body
		.split('\n')
		.map((line) => `        ${line}`)
		.join('\n');
	return {
		code: `${prelude}\ndef transform(doc):\n    if doc == 'spin':\n${indented}\n    return 42\n`,
		entry: 'transform',
		calls: docs.map((doc) => ({ elementIds: [], doc }))
	};
}

type Answer = { payload: unknown; error: { kind: string; message: string } | null };

const timeoutText = (batch: ScriptBatch) => hostErrorText(batch, 'timeout', TIMEOUT_MESSAGE);
const cancelledText = (batch: ScriptBatch) => hostErrorText(batch, 'cancelled', CANCELLED_MESSAGE);
const texts = (run: ScriptRun) => run.results.map((one) => one.text);

const hosts: ScriptHost[] = [];

function poolOf(options: Partial<PoolOptions> = {}) {
	const ported = instrumented(spawnNodeWorker);
	const host = createPool(ported.spawn, {
		cap: 2,
		now: () => performance.now(),
		...options,
		limits: { ...LIMITS, ...options.limits }
	});
	hosts.push(host);
	return { host, ...ported };
}

afterAll(() => hosts.forEach((host) => host.dispose()));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a pool that was just started is asked: one worker ready, and so the timing starts at the run. */
async function ready(host: ScriptHost): Promise<void> {
	await host.boot();
}

/**
 * A pool whose next worker boots from the snapshot, which is what `boot` of a later run says. A run
 * that reported `'snapshot'` is not enough: a spare spawned before the image was ready may still be
 * booting cold and become the next run's worker, so passes go on until every live worker was handed
 * the image, and `boot()` then waits for one of them.
 */
async function warmed(options: Partial<PoolOptions> = {}) {
	const pooled = poolOf(options);
	for (let tries = 0; tries < 40; tries++) {
		await pooled.host.run(batchOf('pass', [null]), bridge);
		const live = pooled.seen.filter((one) => !one.terminated && !one.maker);
		if (live.length > 0 && live.every((one) => one.snapshot)) break;
		await sleep(250);
	}
	await ready(pooled.host);
	return pooled;
}

/** A batch after a runaway on the same pool: an honest answer, from a worker that is not the runaway's. */
async function expectHealthy(host: ScriptHost): Promise<void> {
	const run = await host.run(batchOf('pass', [null]), bridge);
	expect(texts(run)).toEqual([HONEST_42]);
}

async function timed<T>(work: Promise<T>): Promise<[T, number]> {
	const start = performance.now();
	const result = await work;
	return [result, performance.now() - start];
}

describe('the soft stop', () => {
	for (const boot of ['cold', 'snapshot'] as const) {
		it(
			`ends a runaway loop at the call's deadline on a ${boot} worker, and the batch goes on in the same worker`,
			async () => {
				const { host, seen } = boot === 'cold' ? poolOf() : await warmed();
				await ready(host);
				const batch = batchOf('while True:\n    pass', ['spin', null, null]);
				const used = () => seen.filter((one) => one.runs > 0).length;
				const before = used();
				const ranBefore = new Set(seen.filter((one) => one.runs > 0));
				const [run, ms] = await timed(host.run(batch, bridge));
				expect(run.boot).toBe(boot);
				expect(texts(run)).toEqual([timeoutText(batch), HONEST_42, HONEST_42]);
				// At the deadline and well before a hard stop would have ended it.
				expect(ms).toBeGreaterThanOrEqual(CALL_MS - 50);
				expect(ms).toBeLessThan(CALL_MS + GRACE_MS);
				// One worker ran the batch, and reached `done` itself: nothing ended it early.
				expect(used()).toBe(before + 1);
				// The oldest ready spare takes a batch, which need not be the newest worker spawned.
				const worker = seen.find((one) => one.runs > 0 && !ranBefore.has(one))!;
				expect(worker.messages.filter((m) => m.type === 'call-end')).toHaveLength(4);
				expect(worker.messages.at(-1)?.type).toBe('done');
				await expectHealthy(host);
			},
			TEST_MS
		);
	}

	it(
		'answers a loop at module level, and every call of the batch, as timeout',
		async () => {
			const { host } = poolOf();
			await ready(host);
			const batch = batchOf('pass', [null, null], 'while True:\n    pass');
			const [run, ms] = await timed(host.run(batch, bridge));
			expect(texts(run)).toEqual([timeoutText(batch), timeoutText(batch)]);
			// The soft stop ended the module-level code, and the pool ended the worker at once.
			expect(ms).toBeLessThan(CALL_MS + GRACE_MS / 2);
			await expectHealthy(host);
		},
		TEST_MS
	);

	it(
		'keeps what a call raised and what ended before it, and stops only the call that ran on',
		async () => {
			const { host } = poolOf();
			await ready(host);
			const batch = batchOf('while True:\n    pass', [null, 'spin', null]);
			const run = await host.run(batch, bridge);
			expect(texts(run)).toEqual([HONEST_42, timeoutText(batch), HONEST_42]);
		},
		TEST_MS
	);

	it(
		'leaves a KeyboardInterrupt the script raises itself as the harness’s runtime error',
		async () => {
			const { host } = poolOf();
			await ready(host);
			const batch = batchOf('raise KeyboardInterrupt("mine")', ['spin', null]);
			const run = await host.run(batch, bridge);
			const [first, second] = texts(run).map((text) => JSON.parse(text) as Answer);
			expect(first!.error).toMatchObject({ kind: 'runtime' });
			expect(first!.error?.message).toContain('mine');
			expect(second!.payload).toEqual({ kind: 'json', value: 42 });
			await expectHealthy(host);
		},
		TEST_MS
	);

	it(
		'does not carry a stop into the next call when the call had just ended',
		async () => {
			// A call that ends close to its deadline: the stop and the end race, over and over. Whichever
			// wins, a call that ends is never interrupted by the stop of the one before it.
			const { host } = poolOf({ limits: { callMs: 30, batchMs: 60_000, graceMs: GRACE_MS } });
			await ready(host);
			const calls: Value[] = Array.from({ length: 60 }, (_, i) => i);
			const code = `
import time
def transform(doc):
    t = time.perf_counter() + 0.03
    while time.perf_counter() < t:
        pass
    return doc
`;
			const batch: ScriptBatch = {
				code,
				entry: 'transform',
				calls: calls.map((doc) => ({ elementIds: [], doc }))
			};
			const run = await host.run(batch, bridge);
			const timeout = hostErrorText(
				batch,
				'timeout',
				'execution exceeded the wall timeout of 0.03s'
			);
			run.results.forEach((one, i) => {
				if (one.text === timeout) return;
				// Not stopped by the pool, so exactly what the call returned: never a runtime error.
				expect(one.text).toBe(
					`{"payload": {"kind": "json", "value": ${i}}, "error": null, "reads": [], "stdout": ""}`
				);
			});
			await expectHealthy(host);
		},
		TEST_MS
	);
});

describe('the hard stop', () => {
	const hangs: [string, string, string][] = [
		[
			'an except BaseException loop',
			'while True:\n    try:\n        while True:\n            pass\n    except BaseException:\n        pass',
			''
		],
		[
			'SIGINT ignored',
			'while True:\n    pass',
			'import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)'
		],
		['a long C loop', 'sum(range(10**10))', ''],
		['time.sleep', 'time.sleep(60)', 'import time']
	];
	for (const [name, body, prelude] of hangs) {
		it(
			`ends the worker of ${name} at callMs plus graceMs, and answers the rest as timeout`,
			async () => {
				const { host, seen } = poolOf();
				await ready(host);
				const batch = batchOf(body, [null, 'spin', null, null], prelude);
				const [run, ms] = await timed(host.run(batch, bridge));
				// What ended before the stop keeps its answer; the call that ran on and the rest time out.
				expect(texts(run)).toEqual([
					HONEST_42,
					timeoutText(batch),
					timeoutText(batch),
					timeoutText(batch)
				]);
				expect(ms).toBeGreaterThanOrEqual(CALL_MS + GRACE_MS - 50);
				expect(ms).toBeLessThan(CALL_MS + GRACE_MS + 1500);
				const ran = seen.filter((one) => one.runs > 0);
				expect(ran).toHaveLength(1);
				expect(ran[0]!.terminated).toBe(true);
				expect(ran[0]!.messages.some((m) => m.type === 'done')).toBe(false);
				await expectHealthy(host);
				expect(seen.filter((one) => one.runs > 0)).toHaveLength(2);
			},
			TEST_MS
		);
	}
});

describe('the batch budget', () => {
	it(
		'answers timeout for the call that crosses it, and the worker goes on',
		async () => {
			const { host, seen } = poolOf({ limits: { callMs: 1000, batchMs: 2200, graceMs: GRACE_MS } });
			await ready(host);
			// Each call sleeps 0.8 s: the third starts with about 0.6 s of the budget left.
			const batch = batchOf('time.sleep(0.8)', ['spin', 'spin', 'spin'], 'import time');
			const run = await host.run(batch, bridge);
			const timeout = hostErrorText(batch, 'timeout', 'execution exceeded the wall timeout of 1s');
			expect(texts(run).map((text) => (text === timeout ? 'timeout' : 'answered'))).toEqual([
				'answered',
				'answered',
				'timeout'
			]);
			expect(seen.find((one) => one.runs > 0)!.messages.some((m) => m.type === 'done')).toBe(true);
		},
		TEST_MS
	);

	it(
		'ends the worker when a call starts with the budget spent, and answers it and the rest as timeout',
		async () => {
			const { host, seen } = poolOf({ limits: { callMs: 1000, batchMs: 1500, graceMs: GRACE_MS } });
			await ready(host);
			const batch = batchOf('time.sleep(0.8)', ['spin', 'spin', 'spin'], 'import time');
			const run = await host.run(batch, bridge);
			const timeout = hostErrorText(batch, 'timeout', 'execution exceeded the wall timeout of 1s');
			expect(texts(run)[1]).toBe(timeout);
			expect(texts(run)[2]).toBe(timeout);
			expect(seen.find((one) => one.runs > 0)!.terminated).toBe(true);
		},
		TEST_MS
	);
});

describe('cancel', () => {
	it(
		'soft-stops a running call and ends the worker at once, answering every call not ended as cancelled',
		async () => {
			const { host, seen } = poolOf({
				limits: { callMs: 10_000, batchMs: 30_000, graceMs: GRACE_MS }
			});
			await ready(host);
			const batch = batchOf('while True:\n    pass', [null, 'spin', null]);
			const controller = new AbortController();
			const running = host.run(batch, bridge, controller.signal);
			await waitFor(() => seen.some((one) => callStarts(one) >= 2));
			const [run, ms] = await timed(
				(async () => {
					controller.abort();
					return running;
				})()
			);
			expect(texts(run)).toEqual([HONEST_42, cancelledText(batch), cancelledText(batch)]);
			// A soft stop reaches a loop at once, and the pool ends the worker when the call ends.
			expect(ms).toBeLessThan(GRACE_MS);
			expect(seen.find((one) => one.runs > 0)!.terminated).toBe(true);
			await expectHealthy(host);
		},
		TEST_MS
	);

	it(
		'ends by the hard stop the worker of a call the interrupt cannot reach',
		async () => {
			const { host } = poolOf({ limits: { callMs: 10_000, batchMs: 30_000, graceMs: GRACE_MS } });
			await ready(host);
			const batch = batchOf('time.sleep(60)', ['spin', null], 'import time');
			const controller = new AbortController();
			const running = host.run(batch, bridge, controller.signal);
			await sleep(400);
			const [run, ms] = await timed(
				(async () => {
					controller.abort();
					return running;
				})()
			);
			expect(texts(run)).toEqual([cancelledText(batch), cancelledText(batch)]);
			expect(ms).toBeGreaterThanOrEqual(GRACE_MS - 50);
			expect(ms).toBeLessThan(GRACE_MS + 1500);
			await expectHealthy(host);
		},
		TEST_MS
	);

	it(
		'answers cancelled at once, with no worker used, for a run that was aborted already',
		async () => {
			const { host, seen } = poolOf();
			const controller = new AbortController();
			controller.abort();
			const batch = batchOf('pass', [null, null]);
			const run = await host.run(batch, bridge, controller.signal);
			expect(texts(run)).toEqual([cancelledText(batch), cancelledText(batch)]);
			expect(seen).toHaveLength(0);
			await expectHealthy(host);
		},
		TEST_MS
	);

	it(
		'takes a run that waits behind the cap out of the queue: it answers cancelled and gets no worker',
		async () => {
			const { host, seen } = poolOf({ cap: 1, limits: { callMs: 10_000 } });
			await ready(host);
			const slow = batchOf('time.sleep(1.5)', ['spin'], 'import time');
			const first = host.run(slow, bridge);
			await waitFor(() => seen.some((one) => one.runs > 0));
			const controller = new AbortController();
			const queued = batchOf('pass', [null]);
			const second = host.run(queued, bridge, controller.signal);
			await sleep(50);
			controller.abort();
			expect(texts(await second)).toEqual([cancelledText(queued)]);
			expect(texts(await first)).toEqual([HONEST_42]);
			// Only the first run was ever given to a worker, and it finished untouched.
			expect(seen.reduce((sum, one) => sum + one.runs, 0)).toBe(1);
			await expectHealthy(host);
		},
		TEST_MS
	);

	it(
		'does nothing for an abort after the run has answered',
		async () => {
			const { host } = poolOf();
			const controller = new AbortController();
			const run = await host.run(batchOf('pass', [null]), bridge, controller.signal);
			expect(texts(run)).toEqual([HONEST_42]);
			controller.abort();
			await expectHealthy(host);
		},
		TEST_MS
	);
});

describe('memory', () => {
	const exhaust: [string, string][] = [
		['one allocation too large', 'b = bytearray(2**31 - 1)'],
		['allocations added up', 'xs = []\nwhile True:\n    xs.append(bytearray(50_000_000))']
	];
	for (const [name, body] of exhaust) {
		it(
			`answers memory for the call that exhausts it (${name}) and the calls after it, then runs the next batch`,
			async () => {
				const { host } = poolOf({ limits: { callMs: 30_000, batchMs: 30_000, graceMs: GRACE_MS } });
				await ready(host);
				const batch = batchOf(body, [null, 'spin', null]);
				const run = await host.run(batch, bridge);
				const memory = hostErrorText(batch, 'memory', 'guest exceeded its memory budget');
				expect(texts(run)).toEqual([HONEST_42, memory, memory]);
				await expectHealthy(host);
			},
			TEST_MS
		);
	}
});

async function waitFor(check: () => boolean, limitMs = 20_000): Promise<void> {
	const end = performance.now() + limitMs;
	while (!check()) {
		if (performance.now() > end) throw new Error('the condition did not hold in time');
		await sleep(10);
	}
}

/** How many calls the worker has started, from what it posted. */
const callStarts = (worker: { messages: { type?: unknown; i?: unknown }[] }) =>
	worker.messages.filter((m) => m.type === 'call-start' && (m.i as number) >= 0).length;
