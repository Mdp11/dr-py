import { loadPyodide } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import { createReplyBuffer } from '../../src/script/bridge-buffer.ts';
import { batchToWire } from '../../src/script/wire.ts';
import { runWorker } from '../../src/script/worker-main.ts';
import { INDEX_URL } from '../../node/pyodide.ts';
import { settle, until } from './fixtures/fake-workers.ts';

// The worker body driven in this thread, through a scope that is a list: what it answers to init and
// run, and what it refuses. Its run through a real `worker_threads` worker is in `pool.test.ts`.

type Posted = { type: string; [key: string]: unknown };

function worker() {
	const posted: Posted[] = [];
	let handler: (message: unknown) => void = () => {};
	runWorker(
		{
			post: (message) => void posted.push(message as Posted),
			onMessage: (h) => void (handler = h),
			globals: globalThis
		},
		(options) => loadPyodide({ indexURL: INDEX_URL, ...options })
	);
	const init = () =>
		handler({ type: 'init', reply: createReplyBuffer(), interrupt: new SharedArrayBuffer(4) });
	const run = (n = 2) =>
		handler({
			type: 'run',
			batch: batchToWire({
				code: 'def transform(doc):\n    return 42\n',
				entry: 'transform',
				calls: Array.from({ length: n }, () => ({ elementIds: [] }))
			}),
			roots: Array.from({ length: n }, () => '[]')
		});
	return { posted, init, run, types: () => posted.map((m) => m.type) };
}

describe('the worker body', () => {
	let booted: ReturnType<typeof worker>;

	beforeAll(async () => {
		booted = worker();
		booted.init();
		await until(() => booted.types().includes('ready'), 60_000);
	}, 60_000);

	it('answers init with ready: its boot time and how it booted', () => {
		expect(booted.posted).toEqual([{ type: 'ready', ms: expect.any(Number), boot: 'cold' }]);
		expect((booted.posted[0]!.ms as number) > 0).toBe(true);
	});

	it('runs its one batch, reporting each call, then done with a text per call', () => {
		booted.posted.length = 0;
		booted.run(2);
		expect(booted.types()).toEqual(['call-start', 'call-end', 'call-start', 'call-end', 'done']);
		expect(booted.posted.filter((m) => m.type === 'call-start').map((m) => m.i)).toEqual([0, 1]);
		const done = booted.posted.at(-1)!;
		expect((done.results as { text: string }[]).map((r) => r.text)).toEqual(
			Array(2).fill(
				'{"payload": {"kind": "json", "value": 42}, "error": null, "reads": [], "stdout": ""}'
			)
		);
		expect(done).toMatchObject({ trips: 0, ms: expect.any(Number) });
	});

	it('refuses a second batch, and answers nothing else for it', async () => {
		booted.posted.length = 0;
		booted.run(1);
		await settle();
		expect(booted.posted).toEqual([
			{ type: 'failed', message: 'the script worker already ran its batch' }
		]);
	});

	it('refuses a second init', async () => {
		booted.posted.length = 0;
		booted.init();
		await settle();
		expect(booted.posted).toEqual([
			{ type: 'failed', message: 'the script worker was initialised twice' }
		]);
	});
});

describe('a worker that is not booted', () => {
	it('refuses a run before init', () => {
		const fresh = worker();
		fresh.run(1);
		expect(fresh.posted).toEqual([{ type: 'failed', message: 'the script worker is not booted' }]);
	});

	it('says why a boot failed', async () => {
		const posted: Posted[] = [];
		let handler: (message: unknown) => void = () => {};
		runWorker(
			{
				post: (message) => void posted.push(message as Posted),
				onMessage: (h) => void (handler = h),
				globals: globalThis
			},
			() => Promise.reject(new Error('no pyodide here'))
		);
		handler({ type: 'init', reply: createReplyBuffer(), interrupt: new SharedArrayBuffer(4) });
		await until(() => posted.length > 0);
		expect(posted).toEqual([{ type: 'failed', message: 'no pyodide here' }]);
	});
});
