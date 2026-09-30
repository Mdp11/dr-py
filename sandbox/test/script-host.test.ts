import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { Bridge, ScriptBatch } from '../../engine/src/script/host.ts';
import { PyFloat } from '../../engine/src/value/types.ts';
import type { CspViolation } from '../src/handshake.ts';
import { createScriptHost, type Spawn } from '../src/script-host.ts';

// The real host over real worker threads running `fixtures/script-stub.ts`,
// which speaks the script worker's protocol over the real reply buffer.

const hosts: { dispose(): void }[] = [];
const spawned: Worker[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) host.dispose();
	await Promise.all(spawned.splice(0).map((worker) => worker.terminate()));
});

function setup(modes: string[] = ['ok'], reply: (text: string) => string = (text) => `<${text}>`) {
	const violations: CspViolation[] = [];
	const dispatched: string[] = [];
	const bridge: Bridge = {
		dispatch: (text) => {
			dispatched.push(text);
			return reply(text);
		},
		roots: (ids) => JSON.stringify(ids)
	};
	let n = 0;
	const spawn: Spawn = (on) => {
		const worker = new Worker(new URL('./fixtures/script-stub.ts', import.meta.url), {
			workerData: { mode: modes[Math.min(n++, modes.length - 1)] }
		});
		spawned.push(worker);
		worker.on('message', (data) => on.message(data));
		worker.on('error', (error) => on.error(error.message));
		return {
			postMessage: (message) => worker.postMessage(message),
			terminate: () => void worker.terminate()
		};
	};
	const host = createScriptHost(bridge, spawn, (violation) => violations.push(violation));
	hosts.push(host);
	return { host, violations, dispatched, spawnCount: () => n };
}

const batch = (
	code: string,
	calls: ScriptBatch['calls'] = [{ elementIds: ['a'] }]
): ScriptBatch => ({
	code,
	entry: 'value',
	calls
});

const settled = (promise: Promise<unknown>) =>
	promise.then(
		() => 'resolved',
		(error: Error) => error.message
	);

describe('boot', () => {
	it('resolves with the worker’s time, and boots one worker however often it is asked', async () => {
		const { host, spawnCount } = setup();
		const [a, b] = await Promise.all([host.boot(), host.boot()]);
		expect(a).toEqual({ ms: 7 });
		expect(b).toEqual({ ms: 7 });
		expect(spawnCount()).toBe(1);
	});

	it('rejects with what a failed worker said, and the next boot starts a new worker', async () => {
		const { host, spawnCount } = setup(['failed', 'ok']);
		await expect(host.boot()).rejects.toThrow('pyodide did not boot');
		expect(await host.boot()).toEqual({ ms: 7 });
		expect(spawnCount()).toBe(2);
	});

	it('rejects when the worker dies while booting', async () => {
		const { host } = setup(['crash']);
		await expect(host.boot()).rejects.toThrow('crashed at boot');
	});

	it('rejects a boot still pending when the host is disposed', async () => {
		const { host } = setup(['silent']);
		const booting = settled(host.boot());
		host.dispose();
		expect(await booting).toBe('script host is disposed');
		await expect(host.boot()).rejects.toThrow('script host is disposed');
	});
});

describe('run', () => {
	it('answers each bridge request and hands back results, trips and time', async () => {
		const { host, dispatched } = setup();
		const run = await host.run(batch('echo', [{ elementIds: ['a', 'b'] }, { elementIds: ['c'] }]));
		expect(run.results).toEqual([{ text: '<req:a,b>|["a","b"]' }, { text: '<req:c>|["c"]' }]);
		expect(run.trips).toBe(2);
		expect(run.ms).toBe(3);
		expect(dispatched).toEqual(['req:a,b', 'req:c']);
	});

	it('sends no roots for a transform', async () => {
		const { host } = setup();
		const run = await host.run({
			code: 'echo',
			entry: 'transform',
			calls: [{ elementIds: ['a'] }]
		});
		expect(run.results[0]?.text).toBe('<req:a>|[]');
	});

	it('crosses a reply of 3.5 MiB of multi-byte text exactly, decoded once', async () => {
		const text = 'a' + '😀é'.repeat(Math.ceil((3.5 * (1 << 20)) / 6));
		const { host } = setup(['ok'], () => text);
		const run = await host.run(batch('big'));
		expect(run.trips).toBe(1);
		expect(run.results[0]?.text === text).toBe(true);
	});

	it('keeps a float a float across the worker boundary', async () => {
		const { host } = setup();
		const run = await host.run(
			batch('floats', [{ elementIds: [], inputs: { x: new PyFloat(1), n: 1, big: 2n ** 60n } }])
		);
		expect(run.results[0]?.text).toBe('[[{"x": 1.0, "n": 1, "big": 1152921504606846976}, null]]');
	});

	it('runs one batch at a time, in order', async () => {
		const { host } = setup();
		const runs = await Promise.all([
			host.run(batch('slow')),
			host.run(batch('slow')),
			host.run(batch('echo'))
		]);
		const span = (i: number) => (runs[i]?.results[0]?.text ?? '').split(',').map(Number);
		expect(span(1)[0]).toBeGreaterThanOrEqual(span(0)[1]!);
		expect(runs[2]?.results[0]?.text).toBe('<req:a>|["a"]');
	});

	it('relays a worker’s CSP violation and drops a malformed one', async () => {
		const { host, violations } = setup();
		await host.run(batch('violation'));
		// The worker posts violations before `done`, and messages keep their order.
		expect(violations).toEqual([
			{ type: 'csp-violation', directive: 'script-src', blocked: 'eval' }
		]);
	});
});

describe('a run that cannot finish', () => {
	it('is rejected, not left waiting, when the host is disposed under a blocked worker', async () => {
		const { host, spawnCount } = setup();
		await host.boot();
		const worker = spawned[0]!;
		const running = settled(host.run(batch('hang')));
		const queued = settled(host.run(batch('echo')));
		await new Promise((done) => setTimeout(done, 100));
		host.dispose();
		expect(await running).toBe('script host is disposed');
		expect(await queued).toBe('script host is disposed');
		await once(worker, 'exit');
		expect(spawnCount()).toBe(1);
		await expect(host.run(batch('echo'))).rejects.toThrow('script host is disposed');
	});

	it('is rejected when the worker crashes, and the next run starts a new worker', async () => {
		const { host, spawnCount } = setup();
		await host.boot();
		await expect(host.run(batch('crash'))).rejects.toThrow('boom');
		const run = await host.run(batch('echo'));
		expect(run.results[0]?.text).toBe('<req:a>|["a"]');
		expect(spawnCount()).toBe(2);
	});

	it('is rejected when the worker reports it failed mid-run, and the worker is ended', async () => {
		const { host } = setup();
		await host.boot();
		const worker = spawned[0]!;
		await expect(host.run(batch('fail'))).rejects.toThrow('the guest broke');
		await once(worker, 'exit');
	});

	it('does not answer a request from a worker it has ended', async () => {
		const { host, dispatched } = setup();
		await host.boot();
		const worker = spawned[0]!;
		const running = settled(host.run(batch('hang')));
		await new Promise((done) => setTimeout(done, 50));
		expect(dispatched).toEqual(['about to hang']);
		host.dispose();
		expect(await running).toBe('script host is disposed');
		worker.emit('message', { type: 'bridge', text: 'late' });
		expect(dispatched).toEqual(['about to hang']);
	});

	it('refuses a batch that cannot be posted, and stays usable', async () => {
		const { host } = setup();
		await host.boot();
		const bad = {
			code: 'echo',
			entry: 'value',
			calls: [{ elementIds: [() => 1] }]
		} as unknown as ScriptBatch;
		await expect(host.run(bad)).rejects.toThrow();
		const run = await host.run(batch('echo'));
		expect(run.trips).toBe(1);
	});
});
