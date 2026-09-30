import { afterEach, describe, expect, it } from 'vitest';
import { armReply, HEADER_BYTES } from '../../src/script/bridge-buffer.ts';
import { hostErrorText } from '../../src/script/host-error.ts';
import type { Bridge, ScriptBatch, ScriptHost } from '../../src/script/host.ts';
import { createPool, type PoolOptions } from '../../src/script/pool.ts';
import { PyFloat } from '../../src/value/types.ts';
import {
	fakeWorkers,
	honest,
	settle,
	until,
	type Behaviour,
	type Message
} from './fixtures/fake-workers.ts';

// The pool's protocol handling over workers that are scripts: what it validates, when it spawns and
// what it ends. The same pool over real Pyodide is in `pool.test.ts`.

const pools: ScriptHost[] = [];
afterEach(() => pools.splice(0).forEach((pool) => pool.dispose()));

function poolOf(behaviours: Behaviour[] = [honest], options: Partial<PoolOptions> = {}) {
	const workers = fakeWorkers(...behaviours);
	const pool = createPool(workers.spawn, {
		cap: 1,
		now: () => performance.now(),
		snapshots: false,
		...options
	});
	pools.push(pool);
	return { pool, ...workers };
}

const bridge: Bridge = { dispatch: (text) => `<${text}>`, roots: (ids) => JSON.stringify(ids) };

const batchOf = (n = 1, extra: Partial<ScriptBatch> = {}): ScriptBatch => ({
	code: 'def value(els): return 1',
	entry: 'value',
	calls: Array.from({ length: n }, (_, i) => ({ elementIds: [`e${i}`] })),
	...extra
});

const runtimeError = (batch: ScriptBatch, message: string) =>
	batch.calls.map(() => ({ text: hostErrorText(batch, 'runtime', message) }));

const failBoot: Behaviour = (fake, message) => {
	if (message.type === 'init') fake.say({ type: 'failed', message: 'pyodide did not boot' });
};

/** A worker that boots and then answers `run` with `reply`. */
const answers =
	(reply: (fake: Parameters<Behaviour>[0], message: Message) => void): Behaviour =>
	(fake, message) => {
		if (message.type === 'init') fake.say({ type: 'ready', ms: 5, boot: 'cold' });
		else if (message.type === 'run') reply(fake, message);
	};

describe('what the pool sends a worker', () => {
	it('inits it with the two buffers and the harness limits, then runs its one batch', async () => {
		const { pool, fakes } = poolOf([honest], {
			limits: { stdoutChars: 7, reprChars: 8, readMemoMax: 9 }
		});
		const batch = batchOf(2, { console: true });
		await pool.run(batch, bridge);
		const [init, run] = fakes[0]!.posted;
		expect(init).toMatchObject({
			type: 'init',
			limits: { stdoutChars: 7, reprChars: 8, readMemoMax: 9 }
		});
		expect(init!.reply).toBe(fakes[0]!.buffers.reply);
		expect(init!.interrupt).toBe(fakes[0]!.buffers.interrupt);
		expect(fakes[0]!.buffers.reply).toBeInstanceOf(SharedArrayBuffer);
		expect(fakes[0]!.buffers.interrupt).toBeInstanceOf(SharedArrayBuffer);
		expect(run).toMatchObject({
			type: 'run',
			batch: { code: batch.code, entry: 'value', console: true }
		});
		expect(fakes[0]!.posted.filter((m) => m.type === 'run')).toHaveLength(1);
	});

	it('gives each worker buffers of its own', async () => {
		const { pool, fakes } = poolOf([honest], { cap: 2 });
		await Promise.all([pool.run(batchOf(), bridge), pool.run(batchOf(), bridge)]);
		expect(fakes[0]!.buffers.reply).not.toBe(fakes[1]!.buffers.reply);
		expect(fakes[0]!.buffers.interrupt).not.toBe(fakes[1]!.buffers.interrupt);
	});

	it('reports the worker’s boot and its run, and counts trips itself', async () => {
		const { pool } = poolOf([
			answers((fake) => {
				fake.say({ type: 'bridge', text: 'a' });
				fake.say({ type: 'done', results: [{ text: 'x' }], trips: 99, ms: 4 });
			})
		]);
		const run = await pool.run(batchOf(), bridge);
		expect(run).toEqual({ results: [{ text: 'x' }], trips: 1, ms: 4, bootMs: 5, boot: 'cold' });
	});
});

describe('the roots a run is primed with', () => {
	it('projects each call’s elements and its input elements once, through that run’s bridge', async () => {
		const asked: (readonly string[])[] = [];
		const { pool, fakes } = poolOf();
		const mine: Bridge = {
			dispatch: bridge.dispatch,
			roots: (ids) => (asked.push(ids), `[${ids.join('+')}]`)
		};
		await pool.run(
			{
				code: '',
				entry: 'value',
				calls: [
					{
						elementIds: ['a', 'b'],
						inputs: {
							xs: { kind: 'elements', ids: ['b', 'c'] },
							k: { kind: 'scalars', values: [1] },
							ys: { kind: 'elements', ids: ['d'] }
						}
					},
					{ elementIds: [] }
				]
			},
			mine
		);
		expect(asked).toEqual([['a', 'b', 'c', 'd']]);
		expect(fakes[0]!.posted[1]!.roots).toEqual(['[a+b+c+d]', '[]']);
	});

	it('sends [] for a transform, a console run and a call with nothing to project', async () => {
		const asked: (readonly string[])[] = [];
		const mine: Bridge = { dispatch: bridge.dispatch, roots: (ids) => (asked.push(ids), 'R') };
		for (const batch of [
			batchOf(1, { entry: 'transform' }),
			batchOf(1, { entry: 'script' }),
			batchOf(1, { console: true }),
			{ code: '', entry: 'value' as const, calls: [{ elementIds: [] }] }
		]) {
			const { pool, fakes } = poolOf();
			await pool.run(batch, mine);
			expect(fakes[0]!.posted[1]!.roots).toEqual(['[]']);
		}
		expect(asked).toEqual([]);
	});

	it('rejects a run whose roots fail, and keeps the worker for the next', async () => {
		const { pool, fakes } = poolOf();
		const broken: Bridge = {
			dispatch: bridge.dispatch,
			roots: () => {
				throw new Error('no roots');
			}
		};
		await expect(pool.run(batchOf(), broken)).rejects.toThrow('no roots');
		const run = await pool.run(batchOf(), bridge);
		expect(run.results).toEqual([{ text: 'r0' }]);
		expect(fakes.filter((f) => f.posted.some((m) => m.type === 'run'))).toHaveLength(1);
	});

	it('crosses floats and big ints in the batch as the wire writes them', async () => {
		const { pool, fakes } = poolOf();
		await pool.run(
			{
				code: '',
				entry: 'value',
				calls: [{ elementIds: [], inputs: { f: new PyFloat(1), big: 2n ** 60n } }]
			},
			bridge
		);
		const wired = (fakes[0]!.posted[1]!.batch as { calls: { inputs: Record<string, unknown> }[] })
			.calls[0]!.inputs;
		expect(wired.f).toBeInstanceOf(Float64Array);
		expect(wired.big).toBe(2n ** 60n);
	});
});

describe('bridge requests', () => {
	it('answers each through the bridge of the run its worker holds, and counts them per run', async () => {
		const seen: Record<string, string[]> = { a: [], b: [] };
		const bridgeFor = (name: string): Bridge => ({
			dispatch: (text) => (seen[name]!.push(text), `${name}:${text}`),
			roots: () => '[]'
		});
		const talk = (name: string, n: number): Behaviour =>
			answers((fake) => {
				for (let i = 0; i < n; i++) fake.say({ type: 'bridge', text: `${name}${i}` });
				setTimeout(
					() => fake.say({ type: 'done', results: [{ text: name }], trips: 0, ms: 1 }),
					10
				);
			});
		const { pool } = poolOf([talk('a', 3), talk('b', 1)], { cap: 2 });
		const [a, b] = await Promise.all([
			pool.run(batchOf(), bridgeFor('a')),
			pool.run(batchOf(), bridgeFor('b'))
		]);
		expect([a.trips, b.trips]).toEqual([3, 1]);
		expect(seen).toEqual({ a: ['a0', 'a1', 'a2'], b: ['b0'] });
	});

	it('writes the reply into the worker’s reply buffer, in chunks for a long one', async () => {
		const long = 'é😀'.repeat(400_000);
		let read = '';
		const { pool } = poolOf([
			answers((fake) => {
				// The reader of `readReply`, without its blocking wait: the writer is this thread.
				const header = new Int32Array(fake.buffers.reply, 0, 4);
				const payload = new Uint8Array(fake.buffers.reply, HEADER_BYTES);
				const chunks: Uint8Array[] = [];
				const poll = () => {
					if (Atomics.load(header, 0) === 0) return void setTimeout(poll, 1);
					chunks.push(payload.slice(0, Atomics.load(header, 1)));
					if (Atomics.load(header, 2) > 0) {
						Atomics.store(header, 0, 0);
						fake.say({ type: 'more' });
						return void setTimeout(poll, 1);
					}
					read = new TextDecoder().decode(Buffer.concat(chunks));
					fake.say({ type: 'done', results: [{ text: 'x' }], trips: 0, ms: 1 });
				};
				armReply(fake.buffers.reply);
				fake.say({ type: 'bridge', text: 'q' });
				poll();
			})
		]);
		await pool.run(batchOf(), { dispatch: () => long, roots: () => '[]' });
		expect(read === long).toBe(true);
	});

	it('ends a worker whose bridge throws, and answers its calls as failed', async () => {
		const { pool, fakes } = poolOf([answers((fake) => fake.say({ type: 'bridge', text: 'q' }))]);
		const batch = batchOf(2);
		const run = await pool.run(batch, {
			dispatch: () => {
				throw new Error('boom');
			},
			roots: () => '[]'
		});
		expect(run.results).toEqual(runtimeError(batch, 'the bridge failed: boom'));
		expect(fakes[0]!.terminated).toBe(true);
	});
});

describe('a forged or broken message', () => {
	const forged: [string, Behaviour, string][] = [
		[
			'a done with the wrong count',
			answers((fake) => fake.say({ type: 'done', results: [{ text: 'x' }], trips: 0, ms: 1 })),
			'the script worker answered 1 results for 2 calls'
		],
		[
			'a done with no results',
			answers((fake) => fake.say({ type: 'done', trips: 0, ms: 1 })),
			'the script worker answered no results for 2 calls'
		],
		[
			'a done whose result has no text',
			answers((fake) =>
				fake.say({ type: 'done', results: [{ text: 'x' }, { text: 3 }], trips: 0, ms: 1 })
			),
			'the script worker answered a result without text'
		],
		[
			'a done whose run time is not a number',
			answers((fake) =>
				fake.say({ type: 'done', results: [{ text: 'x' }, { text: 'y' }], trips: 0, ms: 'soon' })
			),
			'the script worker sent a bad run time'
		],
		[
			'a message of an unknown type',
			answers((fake) => fake.say({ type: 'nope' })),
			'the script worker sent a bad "nope"'
		],
		[
			'a message with no type',
			answers((fake) => fake.say({ results: [] })),
			'the script worker sent a bad untyped'
		],
		[
			'a message that is not an object',
			answers((fake) => fake.say('done')),
			'the script worker sent a bad untyped'
		],
		[
			'a second ready',
			answers((fake) => fake.say({ type: 'ready', ms: 1, boot: 'cold' })),
			'the script worker sent a bad "ready"'
		],
		[
			'a bridge request without text',
			answers((fake) => fake.say({ type: 'bridge', text: 4 })),
			'the script worker sent a bad "bridge"'
		],
		[
			'a call that starts outside the batch',
			answers((fake) => fake.say({ type: 'call-start', i: 2 })),
			'the script worker sent a bad "call-start"'
		],
		[
			'a call that ends at a non-integer',
			answers((fake) => fake.say({ type: 'call-end', i: 0.5 })),
			'the script worker sent a bad "call-end"'
		],
		[
			'a failed',
			answers((fake) => fake.say({ type: 'failed', message: 'MemoryError: out' })),
			'MemoryError: out'
		],
		[
			'a failed with no message',
			answers((fake) => fake.say({ type: 'failed' })),
			'the script worker failed'
		],
		['an error event', answers((fake) => fake.crash('the thread died')), 'the thread died']
	];

	for (const [name, worker, message] of forged) {
		it(`fails that batch on ${name}, ends the worker, and the next run is right`, async () => {
			const { pool, fakes, alive } = poolOf([worker, honest]);
			const batch = batchOf(2);
			const run = await pool.run(batch, bridge);
			expect(run.results).toEqual(runtimeError(batch, message));
			expect(fakes[0]!.terminated).toBe(true);
			const next = await pool.run(batchOf(2), bridge);
			expect(next.results).toEqual([{ text: 'r0' }, { text: 'r1' }]);
			expect(fakes[1]!.posted.filter((m) => m.type === 'run')).toHaveLength(1);
			expect(fakes[0]!.posted.filter((m) => m.type === 'run')).toHaveLength(1);
			expect(alive()).toBeLessThanOrEqual(1);
		});
	}

	it('refuses a done sent before a run, from a worker that holds none', async () => {
		const { pool, fakes } = poolOf([
			(fake, message) => {
				if (message.type !== 'init') return;
				fake.say({ type: 'ready', ms: 5, boot: 'cold' });
				fake.say({ type: 'done', results: [{ text: 'FORGED' }], trips: 0, ms: 1 });
			},
			honest
		]);
		pool.prewarm();
		await until(() => fakes[0]!.terminated);
		const run = await pool.run(batchOf(), bridge);
		expect(run.results).toEqual([{ text: 'r0' }]);
		expect(fakes[0]!.posted.some((m) => m.type === 'run')).toBe(false);
	});

	it('takes the first done of a batch and nothing a worker says after it', async () => {
		const { pool, fakes } = poolOf([
			answers((fake) => {
				fake.say({ type: 'done', results: [{ text: 'first' }], trips: 0, ms: 1 });
				fake.say({ type: 'done', results: [{ text: 'second' }], trips: 0, ms: 1 });
			}),
			honest
		]);
		const first = await pool.run(batchOf(), bridge);
		expect(first.results).toEqual([{ text: 'first' }]);
		expect(fakes[0]!.terminated).toBe(true);
		await settle();
		const next = await pool.run(batchOf(), bridge);
		expect(next.results).toEqual([{ text: 'r0' }]);
	});

	it('never lets an ended worker’s late message reach the run that follows it', async () => {
		const { pool, fakes } = poolOf([
			answers((fake) => fake.say({ type: 'done', results: [{ text: 'mine' }], trips: 0, ms: 1 })),
			(fake, message) => {
				if (message.type === 'init') fake.say({ type: 'ready', ms: 5, boot: 'cold' });
				// Never answers: the run it holds stays open while the old worker speaks.
			}
		]);
		await pool.run(batchOf(), bridge);
		const held = pool.run(batchOf(), bridge);
		await until(() => fakes[1]?.posted.some((m) => m.type === 'run') ?? false);
		for (const late of [
			{ type: 'done', results: [{ text: 'FORGED' }], trips: 0, ms: 1 },
			{ type: 'failed', message: 'FORGED' },
			{ type: 'bridge', text: 'FORGED' }
		]) {
			fakes[0]!.say(late);
		}
		await settle();
		expect(fakes[1]!.terminated).toBe(false);
		pools[0]!.dispose();
		await expect(held).rejects.toThrow('disposed');
	});

	it('ignores a CSP violation with the wrong shape and reports a right one', async () => {
		const seen: unknown[] = [];
		const { pool } = poolOf(
			[
				answers((fake) => {
					fake.say({ type: 'csp-violation', directive: 'script-src', blocked: 'eval' });
					fake.say({ type: 'csp-violation', directive: 7 });
					fake.say({ type: 'done', results: [{ text: 'x' }], trips: 0, ms: 1 });
				})
			],
			{ onViolation: (v) => seen.push(v) }
		);
		await pool.run(batchOf(), bridge);
		expect(seen).toEqual([{ directive: 'script-src', blocked: 'eval' }]);
	});
});

describe('a worker that fails to boot', () => {
	it('fails the first run with the boot error, and the next run boots again and succeeds', async () => {
		const { pool, fakes } = poolOf([failBoot, honest]);
		await expect(pool.run(batchOf(), bridge)).rejects.toThrow('pyodide did not boot');
		expect(fakes).toHaveLength(1);
		expect(fakes[0]!.terminated).toBe(true);
		const run = await pool.run(batchOf(), bridge);
		expect(run.results).toEqual([{ text: 'r0' }]);
		expect(fakes).toHaveLength(3);
	});

	it('does not spawn between runs when every boot fails, and each run rejects', async () => {
		for (const cap of [1, 3]) {
			const { pool, fakes } = poolOf([failBoot], { cap });
			await expect(pool.run(batchOf(), bridge)).rejects.toThrow('pyodide did not boot');
			await settle(60);
			const first = fakes.length;
			expect(first).toBeLessThanOrEqual(cap);
			await settle(100);
			expect(fakes.length).toBe(first);
			await expect(pool.run(batchOf(), bridge)).rejects.toThrow('pyodide did not boot');
			await settle(60);
			expect(fakes.length).toBeLessThanOrEqual(first + 1);
			expect(fakes.every((fake) => fake.terminated)).toBe(true);
		}
	});

	it('answers each run waiting at the cap with its own attempt, and stops', async () => {
		const { pool, fakes } = poolOf([failBoot], { cap: 1 });
		const runs = [1, 2, 3].map(() =>
			pool.run(batchOf(), bridge).then(
				() => 'ok',
				(e: Error) => e.message
			)
		);
		expect(await Promise.all(runs)).toEqual(Array(3).fill('pyodide did not boot'));
		await settle(60);
		expect(fakes).toHaveLength(3);
	});

	it('takes a spawn that throws as a boot failure', async () => {
		let spawned = 0;
		const pool = createPool(
			() => {
				spawned++;
				throw new Error('no threads');
			},
			{ cap: 2, now: () => performance.now(), snapshots: false }
		);
		pools.push(pool);
		await expect(pool.run(batchOf(), bridge)).rejects.toThrow('no threads');
		await expect(pool.boot()).rejects.toThrow('no threads');
		await settle(30);
		expect(spawned).toBe(2);
	});

	it('serves a run from the worker that boots when another failed', async () => {
		const { pool } = poolOf([failBoot, honest], { cap: 2 });
		const run = await pool.run(batchOf(), bridge);
		expect(run.results).toEqual([{ text: 'r0' }]);
	});

	it('keeps a spare that died from coming back until something asks', async () => {
		const { pool, fakes } = poolOf([
			(fake, message) => {
				if (message.type !== 'init') return;
				fake.say({ type: 'ready', ms: 5, boot: 'cold' });
				setTimeout(() => fake.crash('the spare died'), 10);
			},
			honest
		]);
		pool.prewarm();
		await until(() => fakes[0]?.terminated ?? false);
		await settle(80);
		expect(fakes).toHaveLength(1);
		pool.prewarm();
		expect(fakes).toHaveLength(2);
		await pool.boot();
	});
});

describe('boot()', () => {
	it('resolves with the boot time once a worker is ready, and at once after', async () => {
		const { pool, fakes } = poolOf();
		expect(await Promise.all([pool.boot(), pool.boot()])).toEqual([{ ms: 5 }, { ms: 5 }]);
		expect(fakes).toHaveLength(1);
		let done = false;
		void pool.boot().then(() => (done = true));
		await Promise.resolve();
		await Promise.resolve();
		expect(done).toBe(true);
		expect(fakes).toHaveLength(1);
	});

	it('is retried after a rejection, never memoized', async () => {
		const { pool, fakes } = poolOf([failBoot, honest]);
		await expect(pool.boot()).rejects.toThrow('pyodide did not boot');
		await expect(pool.boot()).resolves.toEqual({ ms: 5 });
		expect(fakes).toHaveLength(2);
	});

	it('rejects every pending boot with the boot error', async () => {
		const { pool } = poolOf([failBoot]);
		const all = await Promise.all(
			[pool.boot(), pool.boot()].map((p) =>
				p.then(
					() => 'ok',
					(e: Error) => e.message
				)
			)
		);
		expect(all).toEqual(['pyodide did not boot', 'pyodide did not boot']);
	});
});

describe('dispose()', () => {
	const never: Behaviour = (fake, message) => {
		if (message.type === 'init') fake.say({ type: 'ready', ms: 5, boot: 'cold' });
	};
	const neverReady: Behaviour = () => {};

	it('rejects a run in flight and ends its worker, and every spare', async () => {
		const { pool, fakes, alive } = poolOf([never], { cap: 3 });
		const running = pool.run(batchOf(), bridge);
		await until(() => fakes.some((f) => f.posted.some((m) => m.type === 'run')));
		pool.dispose();
		await expect(running).rejects.toThrow('script host is disposed');
		expect(alive()).toBe(0);
		expect(fakes.every((f) => f.terminated)).toBe(true);
	});

	it('rejects a run and a boot that wait on a boot, and ends the booting worker', async () => {
		const { pool, fakes, alive } = poolOf([neverReady]);
		const booting = pool.boot();
		const running = pool.run(batchOf(), bridge);
		const settled = Promise.allSettled([booting, running]);
		await settle();
		pool.dispose();
		const [a, b] = await settled;
		expect([a.status, b.status]).toEqual(['rejected', 'rejected']);
		expect((a as PromiseRejectedResult).reason.message).toBe('script host is disposed');
		expect((b as PromiseRejectedResult).reason.message).toBe('script host is disposed');
		expect(alive()).toBe(0);
		expect(fakes).toHaveLength(1);
	});

	it('rejects the runs queued behind the cap, and refuses every call after', async () => {
		const { pool, fakes } = poolOf([never]);
		const first = pool.run(batchOf(), bridge);
		const second = pool.run(batchOf(), bridge);
		await until(() => fakes.length > 0 && fakes[0]!.posted.length > 1);
		pool.dispose();
		await expect(first).rejects.toThrow('disposed');
		await expect(second).rejects.toThrow('disposed');
		await expect(pool.run(batchOf(), bridge)).rejects.toThrow('disposed');
		await expect(pool.boot()).rejects.toThrow('disposed');
		pool.prewarm();
		expect(fakes).toHaveLength(1);
	});

	it('is safe to call twice, and spawns nothing after a late message', async () => {
		const { pool, fakes } = poolOf();
		await pool.boot();
		pool.dispose();
		pool.dispose();
		fakes[0]!.say({ type: 'ready', ms: 1, boot: 'cold' });
		await settle();
		expect(fakes).toHaveLength(1);
	});
});

describe('concurrency and order', () => {
	it('runs waiting runs first come first served, on at most cap workers', async () => {
		const order: string[] = [];
		const { pool, peak, fakes } = poolOf(
			[
				answers((fake, message) => {
					order.push((message.batch as { code: string }).code);
					setTimeout(
						() => fake.say({ type: 'done', results: [{ text: 'x' }], trips: 0, ms: 1 }),
						10
					);
				})
			],
			{ cap: 2 }
		);
		const runs = ['a', 'b', 'c', 'd', 'e'].map((code) => pool.run({ ...batchOf(), code }, bridge));
		await Promise.all(runs);
		expect(order.slice(0, 2).sort()).toEqual(['a', 'b']);
		expect(order).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(peak()).toBeLessThanOrEqual(2);
		expect(fakes.filter((f) => f.posted.some((m) => m.type === 'run')).length).toBe(5);
		for (const fake of fakes) {
			expect(fake.posted.filter((m) => m.type === 'run').length).toBeLessThanOrEqual(1);
		}
	});
});

describe('spares', () => {
	it('keeps one spare once a run is done, and starts no more', async () => {
		const { pool, fakes, alive } = poolOf([honest], { cap: 1 });
		await pool.run(batchOf(), bridge);
		await until(() => alive() === 1);
		await settle(40);
		expect(alive()).toBe(1);
		expect(fakes).toHaveLength(2);
		// That spare serves the next run, and is replaced.
		await pool.run(batchOf(), bridge);
		await until(() => alive() === 1 && fakes.length === 3);
	});

	it('starts one boot for prewarm() on an empty pool, and no second', async () => {
		const { pool, fakes } = poolOf([honest], { cap: 3 });
		pool.prewarm();
		pool.prewarm();
		expect(fakes).toHaveLength(1);
		await pool.boot();
		pool.prewarm();
		expect(fakes).toHaveLength(1);
		const run = await pool.run(batchOf(), bridge);
		expect(run.results).toEqual([{ text: 'r0' }]);
	});

	it('boots one worker for a lone run and one spare, and no more', async () => {
		const { pool, fakes, alive } = poolOf([honest], { cap: 4 });
		await pool.run(batchOf(), bridge);
		await settle(40);
		expect(fakes).toHaveLength(2);
		expect(alive()).toBe(1);
	});

	it('keeps min(cap, running + waiting + 1) workers alive', async () => {
		const slow: Behaviour = answers((fake) =>
			setTimeout(() => fake.say({ type: 'done', results: [{ text: 'x' }], trips: 0, ms: 1 }), 40)
		);
		const { pool, fakes, peak } = poolOf([slow], { cap: 4 });
		await Promise.all([pool.run(batchOf(), bridge), pool.run(batchOf(), bridge)]);
		expect(peak()).toBe(3);
		expect(fakes.length).toBe(3);
		const { pool: small, peak: smallPeak } = poolOf([slow], { cap: 2 });
		await Promise.all([1, 2, 3].map(() => small.run(batchOf(), bridge)));
		expect(smallPeak()).toBe(2);
	});

	it('serves a run from a spare that is already up, and replaces it', async () => {
		const { pool, fakes } = poolOf([honest], { cap: 3, spareIdleMs: 10_000 });
		await pool.run(batchOf(), bridge);
		await settle(30);
		expect(fakes).toHaveLength(2);
		const spare = fakes.find((f) => !f.terminated)!;
		await pool.run(batchOf(), bridge);
		expect(spare.posted.some((m) => m.type === 'run')).toBe(true);
		await settle(30);
		expect(fakes).toHaveLength(3);
	});

	it('drops the spares beyond one after spareIdleMs, once no run waits', async () => {
		// A run whose roots fail never starts, so both workers booted for it stay spares.
		const { pool, fakes, alive } = poolOf([honest], { cap: 2, spareIdleMs: 50 });
		await expect(
			pool.run(batchOf(), {
				dispatch: bridge.dispatch,
				roots: () => {
					throw new Error('no roots');
				}
			})
		).rejects.toThrow('no roots');
		await until(() => fakes.length === 2 && alive() === 2);
		await until(() => alive() === 1, 2000);
		await settle(120);
		expect(alive()).toBe(1);
		expect(fakes).toHaveLength(2);
	});
});

describe('the snapshot maker and the image', () => {
	const image = () => new Uint8Array([1, 2, 3, 4]).buffer;
	const imageOf = (message: Message) => message.snapshot as ArrayBuffer | undefined;

	/** `make` posts an image, an `init` with one reports `snapshot`, one without reports `cold`. */
	const imager: Behaviour = (fake, message) => {
		if (message.type === 'init' && message.make === true)
			fake.say({ type: 'snapshot', bytes: image() });
		else if (message.type === 'init') {
			fake.say({
				type: 'ready',
				ms: 5,
				boot: message.snapshot === undefined ? 'cold' : 'snapshot'
			});
		} else honest(fake, message);
	};
	/** A maker that never answers. */
	const silentMaker: Behaviour = (fake, message) => {
		if (message.type === 'init' && message.make === true) return;
		honest(fake, message);
	};
	const inits = (fakes: { posted: Message[] }[]) =>
		fakes.flatMap((fake) => fake.posted.filter((m) => m.type === 'init'));
	const warnings = () => {
		const seen: string[] = [];
		return { seen, onWarning: (message: string) => void seen.push(message) };
	};
	const withImages = (extra: Partial<PoolOptions> = {}) => ({ snapshots: true, cap: 2, ...extra });

	it('spawns a maker with the first worker, sends it no batch and ends it once it has the image', async () => {
		const { pool, fakes } = poolOf([imager], withImages());
		await pool.run(batchOf(), bridge);
		await until(() => fakes.some((fake) => fake.posted[0]?.make === true && fake.terminated));
		const makers = fakes.filter((fake) => fake.posted.some((m) => m.make === true));
		expect(makers).toHaveLength(1);
		expect(makers[0]!.posted.map((m) => m.type)).toEqual(['init']);
		expect(
			makers.length + fakes.filter((fake) => fake.posted.some((m) => m.type === 'run')).length
		).toBe(2);
		// The first worker was not held up for it: it booted cold.
		expect(imageOf(fakes[0]!.posted[0]!)).toBeUndefined();
	});

	it('does not count the maker against the cap', async () => {
		const { pool, fakes, alive } = poolOf([silentMaker], withImages({ cap: 1 }));
		const run = pool.run(batchOf(), bridge);
		await until(() => fakes.length === 2);
		expect(alive()).toBe(2);
		expect((await run).results).toEqual([{ text: 'r0' }]);
	});

	it('keeps no spare ahead while the maker works, and one from the image once it has it', async () => {
		const { pool, fakes } = poolOf([silentMaker], withImages({ cap: 3 }));
		await pool.run(batchOf(), bridge);
		await settle(60);
		expect(fakes).toHaveLength(2);
		const maker = fakes.find((fake) => fake.posted[0]?.make === true)!;
		maker.say({ type: 'snapshot', bytes: image() });
		await until(() => fakes.length === 3);
		expect(Array.from(new Uint8Array(imageOf(fakes[2]!.posted[0]!)!))).toEqual([1, 2, 3, 4]);
		expect(maker.terminated).toBe(true);
	});

	it('does not start a spare for boot() ahead of the image while a worker is alive', async () => {
		// The first worker holds its run, so a spare would be a second cold boot.
		const held: Behaviour = (fake, message) => {
			if (message.type === 'run') return;
			silentMaker(fake, message);
		};
		const { pool, fakes } = poolOf([held], withImages({ cap: 3 }));
		await pool.boot();
		void pool.run(batchOf(), bridge).catch(() => {});
		await settle(30);
		expect(fakes).toHaveLength(2);
		let resolved = false;
		const second = pool.boot().then(() => (resolved = true));
		await settle(60);
		expect(resolved).toBe(false);
		expect(fakes).toHaveLength(2);
		fakes.find((fake) => fake.posted[0]?.make === true)!.say({ type: 'snapshot', bytes: image() });
		await second;
		expect(imageOf(fakes.at(-1)!.posted[0]!)).toBeDefined();
	});

	it('gives each worker a copy of its own, transferred, and keeps its own bytes whole', async () => {
		const { pool, fakes } = poolOf([imager], withImages({ cap: 3 }));
		await pool.run(batchOf(), bridge);
		await until(() => inits(fakes).some((m) => imageOf(m) !== undefined));
		const [first] = inits(fakes).filter((m) => imageOf(m) !== undefined);
		const holder = fakes.find((fake) => fake.posted[0] === first)!;
		expect(holder.transfers[0]).toEqual([imageOf(first!)]);
		// A worker that scribbles over the bytes it was booted from...
		new Uint8Array(imageOf(first!)!).fill(9);
		// ...changes nothing for the workers after it.
		await pool.run(batchOf(), bridge);
		await pool.run(batchOf(), bridge);
		await settle(40);
		const later = inits(fakes)
			.filter((m) => imageOf(m) !== undefined)
			.slice(1);
		expect(later.length).toBeGreaterThanOrEqual(2);
		for (const m of later) {
			expect(imageOf(m)).not.toBe(imageOf(first!));
			expect(Array.from(new Uint8Array(imageOf(m)!))).toEqual([1, 2, 3, 4]);
		}
		expect(new Set(later.map(imageOf)).size).toBe(later.length);
	});

	it('reports boot as the worker says, and never sends a run to the maker', async () => {
		const { pool, fakes } = poolOf([imager], withImages({ cap: 3 }));
		const first = await pool.run(batchOf(), bridge);
		await until(() => inits(fakes).some((m) => imageOf(m) !== undefined));
		await settle(30);
		const second = await pool.run(batchOf(), bridge);
		expect([first.boot, second.boot]).toEqual(['cold', 'snapshot']);
		for (const fake of fakes.filter((one) => one.posted[0]?.make === true)) {
			expect(fake.posted.some((m) => m.type === 'run')).toBe(false);
		}
	});

	describe('gives up on images, warns once, and boots cold', () => {
		const coldAfter = async (
			pool: ReturnType<typeof poolOf>['pool'],
			fakes: ReturnType<typeof poolOf>['fakes']
		) => {
			await settle(40);
			const before = fakes.length;
			const run = await pool.run(batchOf(), bridge);
			await pool.run(batchOf(), bridge);
			await settle(40);
			expect(run.results).toEqual([{ text: 'r0' }]);
			expect(fakes.length).toBeGreaterThan(before);
			for (const m of inits(fakes.slice(before))) expect(imageOf(m)).toBeUndefined();
		};

		it('when the maker says failed', async () => {
			const w = warnings();
			const maker: Behaviour = (fake, message) => {
				if (message.type === 'init' && message.make === true)
					fake.say({ type: 'failed', message: 'no makeMemorySnapshot' });
				else honest(fake, message);
			};
			const { pool, fakes } = poolOf([maker], withImages({ onWarning: w.onWarning }));
			await coldAfter(pool, fakes);
			expect(w.seen).toEqual([
				'script workers boot cold: the snapshot could not be made: no makeMemorySnapshot'
			]);
			expect(fakes.filter((fake) => fake.posted[0]?.make === true).every((f) => f.terminated)).toBe(
				true
			);
		});

		it('when the maker crashes', async () => {
			const w = warnings();
			const maker: Behaviour = (fake, message) => {
				if (message.type === 'init' && message.make === true) fake.crash('out of memory');
				else honest(fake, message);
			};
			const { pool, fakes } = poolOf([maker], withImages({ onWarning: w.onWarning }));
			await coldAfter(pool, fakes);
			expect(w.seen).toEqual([
				'script workers boot cold: the snapshot could not be made: out of memory'
			]);
		});

		it('when the maker cannot be spawned', async () => {
			const w = warnings();
			const workers = fakeWorkers(honest);
			let spawns = 0;
			const pool = createPool(
				(buffers) => {
					if (++spawns === 2) throw new Error('no more threads');
					return workers.spawn(buffers);
				},
				{ cap: 2, now: () => performance.now(), onWarning: w.onWarning }
			);
			pools.push(pool);
			await coldAfter(pool, workers.fakes);
			expect(w.seen).toEqual([
				'script workers boot cold: the snapshot could not be made: no more threads'
			]);
		});

		it.each([
			['a ready', { type: 'ready', ms: 1, boot: 'cold' }],
			['an empty image', { type: 'snapshot', bytes: new ArrayBuffer(0) }],
			['an image that is not an ArrayBuffer', { type: 'snapshot', bytes: new Uint8Array(4) }],
			['an image that is text', { type: 'snapshot', bytes: 'abcd' }],
			['a message that is not an object', 'snapshot']
		])('when the maker sends %s', async (_name, bad) => {
			const w = warnings();
			const maker: Behaviour = (fake, message) => {
				if (message.type === 'init' && message.make === true) fake.say(bad);
				else honest(fake, message);
			};
			const { pool, fakes } = poolOf([maker], withImages({ onWarning: w.onWarning }));
			await coldAfter(pool, fakes);
			expect(w.seen).toHaveLength(1);
			expect(w.seen[0]).toMatch(/^script workers boot cold: the snapshot maker sent /);
			expect(fakes.filter((fake) => fake.posted[0]?.make === true).every((f) => f.terminated)).toBe(
				true
			);
		});

		it('when a worker given the image boots cold instead', async () => {
			const w = warnings();
			const refuser: Behaviour = (fake, message) => {
				if (message.type === 'init' && message.make === true)
					fake.say({ type: 'snapshot', bytes: image() });
				else if (message.type === 'init') fake.say({ type: 'ready', ms: 5, boot: 'cold' });
				else honest(fake, message);
			};
			const { pool, fakes } = poolOf([refuser], withImages({ onWarning: w.onWarning }));
			await pool.run(batchOf(), bridge);
			await until(() => inits(fakes).some((m) => imageOf(m) !== undefined));
			await settle(40);
			const given = inits(fakes).filter((m) => imageOf(m) !== undefined).length;
			await pool.run(batchOf(), bridge);
			await pool.run(batchOf(), bridge);
			await settle(40);
			expect(w.seen).toEqual([
				'script workers boot cold: a worker could not boot from the snapshot'
			]);
			expect(inits(fakes).filter((m) => imageOf(m) !== undefined)).toHaveLength(given);
		});

		it.each([
			['crashes', (fake: Parameters<Behaviour>[0]) => fake.crash('wasm abort')],
			[
				'says failed',
				(fake: Parameters<Behaviour>[0]) => fake.say({ type: 'failed', message: 'wasm abort' })
			]
		])(
			'when a worker given the image %s, and the run that waited is still answered',
			async (_name, die) => {
				const w = warnings();
				const dying: Behaviour = (fake, message) => {
					if (message.type === 'init' && message.make === true)
						fake.say({ type: 'snapshot', bytes: image() });
					else if (message.type === 'init' && message.snapshot !== undefined) die(fake);
					else imager(fake, message);
				};
				const { pool, fakes } = poolOf([dying], withImages({ onWarning: w.onWarning }));
				await pool.run(batchOf(), bridge);
				await until(() => inits(fakes).some((m) => imageOf(m) !== undefined));
				await settle(40);
				const run = await pool.run(batchOf(), bridge);
				expect(run.results).toEqual([{ text: 'r0' }]);
				expect(w.seen).toEqual([
					'script workers boot cold: a worker could not boot from the snapshot: wasm abort'
				]);
				expect(run.boot).toBe('cold');
			}
		);

		it('and goes on when the warning handler throws', async () => {
			const maker: Behaviour = (fake, message) => {
				if (message.type === 'init' && message.make === true)
					fake.say({ type: 'failed', message: 'x' });
				else honest(fake, message);
			};
			const { pool, fakes } = poolOf(
				[maker],
				withImages({
					onWarning: () => {
						throw new Error('handler');
					}
				})
			);
			await coldAfter(pool, fakes);
		});
	});

	it('ends the maker on dispose, with the rest', async () => {
		const { pool, fakes, alive } = poolOf([silentMaker], withImages());
		const run = pool.run(batchOf(), bridge).catch((error: Error) => error.message);
		await until(() => fakes.length === 2);
		pool.dispose();
		expect(await run).toBe('script host is disposed');
		expect(alive()).toBe(0);
	});

	it('takes a snapshot message from a worker that is not the maker as a failed boot', async () => {
		const forger: Behaviour = (fake, message) => {
			if (message.type === 'init') fake.say({ type: 'snapshot', bytes: image() });
		};
		const { pool } = poolOf([forger], withImages({ cap: 1 }));
		const run = await pool.run(batchOf(), bridge).catch((error: Error) => error.message);
		expect(run).toBe('the script worker sent "snapshot" while booting');
	});
});
