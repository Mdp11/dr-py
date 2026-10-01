import { afterAll, describe, expect, it } from 'vitest';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../../src/script/bridge.ts';
import type { Bridge, ScriptBatch, ScriptHost, ScriptRun } from '../../src/script/host.ts';
import { createPool, type PoolOptions, type WorkerSpawner } from '../../src/script/pool.ts';
import { nodeWorkerSpawner, spawnNodeWorker } from '../../node/script-host.ts';
import { until } from './fixtures/fake-workers.ts';
import { expectParity, loadParity, parityBatch, parityModel, type ParityCase } from './parity.ts';

// Workers that boot from Pyodide's memory image of the loaded guest, over real Pyodide in real
// threads: the pool makes the image once, hands every later worker a copy, and answers exactly what
// a cold boot answers. The pool's handling of the image over scripted workers is in
// `pool-protocol.test.ts`.

type Init = { snapshot: boolean; make: boolean; runs: number; terminated: boolean };

/** `inner`, recording how each worker was initialised and whether it was sent a batch. */
function watched(inner: WorkerSpawner) {
	const workers: Init[] = [];
	const spawn: WorkerSpawner = (buffers) => {
		const port = inner(buffers);
		const here: Init = { snapshot: false, make: false, runs: 0, terminated: false };
		workers.push(here);
		return {
			...port,
			post(message, transfer) {
				const m = message as { type?: unknown; snapshot?: unknown; make?: unknown };
				if (m.type === 'init') {
					here.snapshot = m.snapshot instanceof ArrayBuffer;
					here.make = m.make === true;
				}
				if (m.type === 'run') here.runs++;
				port.post(message, transfer);
			},
			terminate() {
				here.terminated = true;
				port.terminate();
			}
		};
	};
	return { spawn, workers };
}

const pools: ScriptHost[] = [];

function poolOf(spawn: WorkerSpawner, options: Partial<PoolOptions> = {}) {
	const warnings: string[] = [];
	const host = createPool(spawn, {
		cap: 2,
		now: () => performance.now(),
		onWarning: (message) => warnings.push(message),
		...options
	});
	pools.push(host);
	return { host, warnings };
}

afterAll(() => pools.forEach((host) => host.dispose()));

function recording(c: ParityCase) {
	const dispatcher = new BridgeDispatcher(parityModel(), c.mode === 'console');
	const bridge: Bridge = {
		dispatch: (text) => dispatcher.dispatch(text),
		roots: (ids) => dumpDefault(projectRoots(parityModel(), ids))
	};
	return { dispatcher, bridge };
}

/** Runs `c` on a worker of `host` and holds its answer to the oracle's bytes. */
async function runCase(host: ScriptHost, c: ParityCase): Promise<ScriptRun> {
	const mine = recording(c);
	const run = await host.run(parityBatch(c), mine.bridge);
	expectParity(c, run.results, dumpDefault(mine.dispatcher.ops));
	return run;
}

const trivial: ScriptBatch = {
	code: 'def transform(doc): return 1',
	entry: 'transform',
	calls: [{ elementIds: [] }]
};
const trivialBridge: Bridge = { dispatch: () => '{}', roots: () => '[]' };

/** Runs one batch on a cold worker, then waits until the pool has the image and boots from it. */
async function withSnapshot(spawn: WorkerSpawner, options: Partial<PoolOptions> = {}) {
	const seen = watched(spawn);
	const own = poolOf(seen.spawn, options);
	const first = await own.host.run(trivial, trivialBridge);
	await until(() => seen.workers.some((one) => one.snapshot), 60_000);
	return { ...own, first, seen };
}

const determinism = loadParity().filter((c) => c.group === 'determinism');
// A few of each kind of case, for runs that are about the boot and not the corpus.
const sample = [
	...loadParity()
		.filter((c) => c.group !== 'determinism')
		.slice(0, 6),
	...determinism
];

describe('workers booted from the snapshot', () => {
	it('report boot: snapshot from the second run on, and boot in well under a cold one', async () => {
		const { host, warnings, first, seen } = await withSnapshot(spawnNodeWorker);
		const later: ScriptRun[] = [];
		for (let i = 0; i < 3; i++) later.push(await host.run(trivial, trivialBridge));
		expect(first.boot).toBe('cold');
		expect(later.map((run) => run.boot)).toEqual(['snapshot', 'snapshot', 'snapshot']);
		for (const run of later) expect(run.bootMs).toBeLessThan(1000);
		expect(warnings).toEqual([]);
		// The maker never ran a batch, and was ended once it had posted the image.
		const makers = seen.workers.filter((one) => one.make);
		expect(makers).toHaveLength(1);
		expect(makers[0]).toMatchObject({ runs: 0, terminated: true });
		expect(seen.workers.every((one) => one.runs <= 1)).toBe(true);
		if (process.env.DR_BOOT_LOG)
			console.info(
				`boot ms: cold ${first.bootMs.toFixed(0)}, snapshot ${later.map((run) => run.bootMs.toFixed(0)).join(', ')}`
			);
	}, 120_000);

	it('answer the determinism group with the oracle’s texts, on snapshot and on cold boots', async () => {
		const warm = await withSnapshot(spawnNodeWorker);
		for (const c of determinism)
			expect((await runCase(warm.host, c)).boot, c.name).toBe('snapshot');
		const cold = poolOf(spawnNodeWorker, { snapshots: false });
		for (const c of determinism) expect((await runCase(cold.host, c)).boot, c.name).toBe('cold');
	}, 120_000);

	it('answer a run the same as a cold boot does, calls with a bridge included', async () => {
		const { host } = await withSnapshot(spawnNodeWorker);
		const cases = loadParity().filter((c) => c.group !== 'determinism');
		for (const c of cases.slice(0, 12))
			expect((await runCase(host, c)).boot, c.name).toBe('snapshot');
	}, 120_000);
});

describe('when the snapshot cannot be made or restored', () => {
	const failing = (mode: 'make' | 'load') =>
		nodeWorkerSpawner(new URL('./fixtures/failing-worker.ts', import.meta.url), mode);

	it('boots cold when it cannot be made: same answers, boot: cold, one warning', async () => {
		const seen = watched(failing('make'));
		const { host, warnings } = poolOf(seen.spawn);
		for (const c of sample) expect((await runCase(host, c)).boot, c.name).toBe('cold');
		await until(() => warnings.length > 0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/boot cold: the snapshot could not be made: .*_makeSnapshot/);
		// No worker was ever given an image, and the maker was ended.
		expect(seen.workers.some((one) => one.snapshot)).toBe(false);
		expect(seen.workers.filter((one) => one.make).every((one) => one.terminated)).toBe(true);
	}, 120_000);

	it('boots cold when it cannot be restored: same answers, boot: cold, one warning', async () => {
		const seen = watched(failing('load'));
		const { host, warnings } = poolOf(seen.spawn);
		await host.run(trivial, trivialBridge);
		await until(() => seen.workers.some((one) => one.snapshot), 60_000);
		for (const c of sample) expect((await runCase(host, c)).boot, c.name).toBe('cold');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/boot cold: a worker could not boot from the snapshot/);
		// Once given up, no later worker is handed an image.
		const given = seen.workers.filter((one) => one.snapshot).length;
		await runCase(host, determinism[0]!);
		await runCase(host, determinism[0]!);
		expect(seen.workers.filter((one) => one.snapshot).length).toBe(given);
		expect(warnings).toHaveLength(1);
	}, 120_000);

	it('boots cold, without a maker, when told not to use snapshots', async () => {
		const seen = watched(spawnNodeWorker);
		const { host, warnings } = poolOf(seen.spawn, { snapshots: false });
		for (const c of determinism.slice(0, 2)) expect((await runCase(host, c)).boot).toBe('cold');
		expect(seen.workers.some((one) => one.make || one.snapshot)).toBe(false);
		expect(warnings).toEqual([]);
	}, 120_000);
});

describe('a script cannot poison the snapshot a later worker boots from', () => {
	// What a script can reach in its worker: every ArrayBuffer near the global scope and the modules of
	// the thread (through `js`), Node's Buffer pool among them, and
	// the bytes Pyodide was booted from, which Pyodide's own config keeps. Writing 0xff over all of
	// them must change nothing for the next batch: its worker has a copy of the pool's image of its own.
	const poison = `
import pyodide_js
from pyodide.code import run_js

fill = run_js("""(target) => {
  const bytes = target instanceof ArrayBuffer
    ? new Uint8Array(target)
    : new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
  bytes.fill(0xff);
  return bytes.length;
}""")
snapshot = pyodide_js._api.config._loadSnapshot
print("snapshot", fill(snapshot))

reached = run_js("""(() => {
  const seen = new Set();
  let count = 0;
  const visit = (value, depth) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    if (seen.has(value) || depth > 3) return;
    seen.add(value);
    try {
      if (value instanceof ArrayBuffer) {
        new Uint8Array(value).fill(0xff);
        count++;
      } else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0xff);
        count++;
      } else {
        for (const key of Reflect.ownKeys(value)) {
          const d = Object.getOwnPropertyDescriptor(value, key);
          if (d && 'value' in d) visit(d.value, depth + 1);
        }
      }
    } catch {}
  };
  visit(globalThis, 0);
  for (const name of ['node:worker_threads', 'node:buffer']) visit(process.getBuiltinModule(name), 0);
  visit(Buffer.allocUnsafe(16).buffer, 0);
  return count;
})()""")
print("global buffers", reached)
`;

	it('answers the corpus on the next workers as on a fresh pool', async () => {
		const { host, seen } = await withSnapshot(spawnNodeWorker);
		const c = loadParity()[0]!;
		const mine = recording(c);
		const batch: ScriptBatch = { code: poison, entry: 'script', calls: [{ elementIds: [] }] };
		const hit = await host.run(batch, mine.bridge);
		expect(hit.boot).toBe('snapshot');
		const out = JSON.parse(hit.results[0]!.text) as { stdout: string; error: unknown };
		expect(out.error ?? null).toBeNull();
		// It reached the bytes its own worker booted from, and all of them were the image's size.
		if (process.env.DR_BOOT_LOG) console.info(out.stdout);
		const reachedBytes = Number(/^snapshot (\d+)$/m.exec(out.stdout)?.[1]);
		expect(reachedBytes).toBeGreaterThan(10_000_000);
		for (const each of sample) expect((await runCase(host, each)).boot, each.name).toBe('snapshot');
		expect(seen.workers.filter((one) => one.snapshot).length).toBeGreaterThan(sample.length);
	}, 180_000);
});
