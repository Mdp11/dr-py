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

/**
 * A scope of its own for the worker to pin: a worker pins the `Date` and `crypto` it is given, which
 * in a real worker are the thread's and here must not be this test process's.
 */
function scopeGlobals() {
	class ScopeDate extends Date {}
	const crypto = { getRandomValues: <T>(array: T) => array };
	return { Date: ScopeDate, crypto, performance } as unknown as typeof globalThis & {
		Date: typeof ScopeDate;
		crypto: typeof crypto;
	};
}

const coldPyodide = (options: object) => loadPyodide({ indexURL: INDEX_URL, ...options });

function worker(load: (options: object) => Promise<unknown> = coldPyodide) {
	const posted: Posted[] = [];
	const transfers: (ArrayBuffer[] | undefined)[] = [];
	let handler: (message: unknown) => void = () => {};
	const globals = scopeGlobals();
	runWorker(
		{
			post: (message, transfer) => {
				posted.push(message as Posted);
				transfers.push(transfer);
			},
			onMessage: (h) => void (handler = h),
			globals
		},
		load
	);
	const init = (extra: object = {}) =>
		handler({
			type: 'init',
			reply: createReplyBuffer(),
			interrupt: new SharedArrayBuffer(4),
			...extra
		});
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
	return { posted, transfers, globals, init, run, types: () => posted.map((m) => m.type) };
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
				globals: scopeGlobals()
			},
			() => Promise.reject(new Error('no pyodide here'))
		);
		handler({ type: 'init', reply: createReplyBuffer(), interrupt: new SharedArrayBuffer(4) });
		await until(() => posted.length > 0);
		expect(posted).toEqual([{ type: 'failed', message: 'no pyodide here' }]);
	});
});

describe('the pins', () => {
	it('fix the clock, the zone and the entropy of the scope the worker is given, and of no other', async () => {
		const realNow = Date.now;
		const realOffset = new Date(1750000000000).getTimezoneOffset();
		const pinned = worker();
		pinned.init();
		await until(() => pinned.types().includes('ready'), 60_000);
		const { Date: ScopeDate, crypto } = pinned.globals;
		expect(ScopeDate.now()).toBe(1750000000000);
		const at = new ScopeDate(1750000000000);
		expect([at.getHours(), at.getMinutes(), at.getSeconds(), at.getDate(), at.getMonth()]).toEqual([
			15, 6, 40, 15, 5
		]);
		expect([at.getFullYear(), at.getDay(), at.getTimezoneOffset()]).toEqual([2025, 0, 0]);
		const buffer = new ArrayBuffer(12);
		const view = new Uint32Array(buffer, 4, 2);
		expect(crypto.getRandomValues(view)).toBe(view);
		expect(Array.from(new Uint8Array(buffer))).toEqual([0, 0, 0, 0, ...Array(8).fill(0x42)]);
		// This process's own clock and zone are untouched.
		expect(Date.now).toBe(realNow);
		expect(Date.now()).not.toBe(1750000000000);
		expect(new Date(1750000000000).getTimezoneOffset()).toBe(realOffset);
	}, 60_000);

	it('are in place before Pyodide loads', async () => {
		let seen: number | undefined;
		const w = worker((options) => {
			seen = w.globals.Date.now();
			return coldPyodide(options);
		});
		w.init();
		await until(() => w.types().includes('ready'), 60_000);
		expect(seen).toBe(1750000000000);
	}, 60_000);
});

describe('the snapshot', () => {
	let image: ArrayBuffer;

	it('is made by an init with make: a posted, transferred image, and no batch ever', async () => {
		const maker = worker();
		maker.init({ make: true });
		await until(() => maker.types().includes('snapshot'), 60_000);
		expect(maker.types()).toEqual(['snapshot']);
		image = maker.posted[0]!.bytes as ArrayBuffer;
		expect(image).toBeInstanceOf(ArrayBuffer);
		expect(image.byteLength).toBeGreaterThan(1_000_000);
		expect(maker.transfers[0]).toEqual([image]);
		maker.run(1);
		expect(maker.posted.at(-1)).toEqual({
			type: 'failed',
			message: 'the script worker is not booted'
		});
	}, 60_000);

	it('boots a worker that binds its transport after the restore and runs a batch', async () => {
		const options: object[] = [];
		const w = worker((o) => (options.push(o), coldPyodide(o)));
		w.init({ snapshot: image.slice(0) });
		await until(() => w.types().includes('ready'), 60_000);
		expect(w.posted).toEqual([{ type: 'ready', ms: expect.any(Number), boot: 'snapshot' }]);
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({ env: { PYTHONHASHSEED: '0' } });
		expect(options[0]).toHaveProperty('_loadSnapshot');
		w.posted.length = 0;
		w.run(2);
		expect(w.types()).toEqual(['call-start', 'call-end', 'call-start', 'call-end', 'done']);
	}, 60_000);

	it('falls back to a cold boot, and says so, when the image cannot be loaded', async () => {
		const options: object[] = [];
		const w = worker((o) => {
			options.push(o);
			return '_loadSnapshot' in o ? Promise.reject(new Error('no snapshots')) : coldPyodide(o);
		});
		w.init({ snapshot: image.slice(0) });
		await until(() => w.types().length > 0, 60_000);
		expect(w.posted).toEqual([{ type: 'ready', ms: expect.any(Number), boot: 'cold' }]);
		expect(options.map((o) => '_loadSnapshot' in o)).toEqual([true, false]);
		w.posted.length = 0;
		w.run(1);
		expect(w.types()).toEqual(['call-start', 'call-end', 'done']);
	}, 60_000);

	it('falls back to a cold boot when the image is not one', async () => {
		const w = worker();
		w.init({ snapshot: new ArrayBuffer(64) });
		await until(() => w.types().length > 0, 60_000);
		expect(w.posted).toEqual([{ type: 'ready', ms: expect.any(Number), boot: 'cold' }]);
	}, 60_000);

	it('does not hold a worker that could not make one: a make that fails says failed', async () => {
		const w = worker((o) =>
			'_makeSnapshot' in o ? Promise.reject(new Error('no make')) : coldPyodide(o)
		);
		w.init({ make: true });
		await until(() => w.types().length > 0);
		expect(w.posted).toEqual([{ type: 'failed', message: 'no make' }]);
	});
});
