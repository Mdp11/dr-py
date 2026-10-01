import { afterEach, describe, expect, it } from 'vitest';
import { armReply } from '../../src/script/bridge-buffer.ts';
import { hostErrorText } from '../../src/script/host-error.ts';
import type {
	AbortSignalLike,
	Bridge,
	ScriptBatch,
	ScriptHost,
	ScriptRun
} from '../../src/script/host.ts';
import { beginWindow, channelView, endWindow } from '../../src/script/interrupt.ts';
import { createPool, type PoolOptions } from '../../src/script/pool.ts';
import {
	fakeWorkers,
	honest,
	settle,
	until,
	type Behaviour,
	type Fake
} from './fixtures/fake-workers.ts';

// The pool's timers and stops over workers that are scripts: who arms and clears what on which
// message, and what a worker that races, stalls or lies can and cannot change. Real Pyodide over
// the same pool is in `runaway.test.ts`.

const CALL_MS = 80;
const GRACE_MS = 80;
const LIMITS = { callMs: CALL_MS, graceMs: GRACE_MS, batchMs: 5000, bootMs: 30_000 };
const TIMEOUT_MESSAGE = 'execution exceeded the wall timeout of 0.08s';
const CANCELLED_MESSAGE = 'the run was cancelled';

const pools: ScriptHost[] = [];
afterEach(() => pools.splice(0).forEach((pool) => pool.dispose()));

function poolOf(behaviours: Behaviour[], options: Partial<PoolOptions> = {}) {
	const workers = fakeWorkers(...behaviours);
	const pool = createPool(workers.spawn, {
		cap: 1,
		now: () => performance.now(),
		snapshots: false,
		...options,
		limits: { ...LIMITS, ...options.limits }
	});
	pools.push(pool);
	return { pool, ...workers };
}

const bridge: Bridge = { dispatch: (text) => `<${text}>`, roots: () => '[]' };

/** A console run: no module-level window, so the calls are the only windows. */
const batchOf = (n: number, extra: Partial<ScriptBatch> = {}): ScriptBatch => ({
	code: 'def value(els): return 1',
	entry: 'value',
	console: true,
	calls: Array.from({ length: n }, () => ({ elementIds: [] })),
	...extra
});

const timeoutText = (batch: ScriptBatch) => hostErrorText(batch, 'timeout', TIMEOUT_MESSAGE);
const cancelledText = (batch: ScriptBatch) => hostErrorText(batch, 'cancelled', CANCELLED_MESSAGE);
const texts = (run: ScriptRun) => run.results.map((one) => one.text);

const channel = (fake: Fake) => channelView(fake.buffers.interrupt);
const FLAG = 0;
const WINDOW = 1;

/** What a worker does at a window's edges: the marks in the shared word, then the message. */
const start = (fake: Fake, i: number) => {
	beginWindow(channel(fake), i + 1);
	fake.say({ type: 'call-start', i });
};
const finish = (fake: Fake, i: number, text = `t${i}`) => {
	endWindow(channel(fake), i + 1);
	fake.say({ type: 'call-end', i, text });
};
const done = (fake: Fake, n: number, ms = 1) =>
	fake.say({
		type: 'done',
		results: Array.from({ length: n }, (_, i) => ({ text: `d${i}` })),
		trips: 0,
		ms
	});

/** `ready` after `init`, then `onRun` for the run. */
const worker =
	(onRun: (fake: Fake) => void): Behaviour =>
	(fake, message) => {
		if (message.type === 'init') fake.say({ type: 'ready', ms: 5, boot: 'cold' });
		else if (message.type === 'run') onRun(fake);
	};

const after = (ms: number, work: () => void) => void setTimeout(work, ms);

describe('the soft stop', () => {
	it('raises the interrupt for a call at its deadline, answers it timeout, and lets the batch go on', async () => {
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				void (async () => {
					await until(() => Atomics.load(channel(fake), FLAG) === 2);
					// A worker that gets the interrupt ends the call; its answer is not the call's.
					finish(fake, 0, 'interrupted');
					start(fake, 1);
					finish(fake, 1, 'fine');
					done(fake, 2);
				})();
			})
		]);
		const batch = batchOf(2);
		const started = performance.now();
		const run = await pool.run(batch, bridge);
		expect(performance.now() - started).toBeGreaterThanOrEqual(CALL_MS - 10);
		expect(texts(run)).toEqual([timeoutText(batch), 'd1']);
		// Its flag was cleared by the worker's end of the call; the worker was never ended early.
		expect(Atomics.load(channel(fakes[0]!), FLAG)).toBe(0);
	});

	it('raises the interrupt again while the call has not ended, for one that went unseen', async () => {
		const { pool } = poolOf(
			[
				worker((fake) => {
					start(fake, 0);
					void (async () => {
						await until(() => Atomics.load(channel(fake), FLAG) === 2);
						// Python read the flag and nothing came of it.
						Atomics.store(channel(fake), FLAG, 0);
						await until(() => Atomics.load(channel(fake), FLAG) === 2);
						finish(fake, 0, 'ended by the second');
						start(fake, 1);
						finish(fake, 1, 'next');
						done(fake, 2);
					})();
				})
			],
			{ limits: { ...LIMITS, graceMs: 400 } }
		);
		const batch = batchOf(2);
		const started = performance.now();
		const run = await pool.run(batch, bridge);
		expect(texts(run)).toEqual([timeoutText(batch), 'd1']);
		// Well inside the grace: the worker was not ended.
		expect(performance.now() - started).toBeLessThan(CALL_MS + 300);
	});

	it('stops raising when the call ends, so no flag is left for the next', async () => {
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				void (async () => {
					await until(() => Atomics.load(channel(fake), FLAG) === 2);
					finish(fake, 0);
					start(fake, 1);
					// Long enough for a raise left armed (every 20 ms) to fire into call 1.
					await settle(40);
					finish(fake, 1);
					done(fake, 2);
				})();
			})
		]);
		const run = await pool.run(batchOf(2), bridge);
		expect(texts(run)[1]).toBe('d1');
		expect(Atomics.load(channel(fakes[0]!), FLAG)).toBe(0);
	});

	it('uses the deadline min(callMs, what remains of batchMs)', async () => {
		const { pool } = poolOf(
			[
				worker((fake) => {
					start(fake, 0);
					void until(() => Atomics.load(channel(fake), FLAG) === 2).then(() => {
						finish(fake, 0);
						done(fake, 1);
					});
				})
			],
			{ limits: { ...LIMITS, callMs: 5000, batchMs: 100 } }
		);
		const started = performance.now();
		await pool.run(batchOf(1), bridge);
		const took = performance.now() - started;
		expect(took).toBeGreaterThanOrEqual(90);
		expect(took).toBeLessThan(1000);
	});

	it('disarms at `call-end`: a call that ends in time is never stopped, and its worker never ended', async () => {
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				after(10, () => finish(fake, 0));
				// The run is still open long after the deadline and the grace would have fired.
				after(10 + 3 * (CALL_MS + GRACE_MS), () => done(fake, 1));
			})
		]);
		const run = await pool.run(batchOf(1), bridge);
		expect(texts(run)).toEqual(['d0']);
		expect(Atomics.load(channel(fakes[0]!), FLAG)).toBe(0);
		expect(Atomics.load(channel(fakes[0]!), WINDOW)).toBeGreaterThan(0);
	});

	it('never carries a stop into the next call: a worker already in call 1 when the deadline of call 0 fires is not interrupted', async () => {
		let flagAtDeadline = -1;
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				// The worker moves on before the deadline; its messages reach the pool after it.
				after(CALL_MS - 50, () => {
					endWindow(channel(fake), 1);
					beginWindow(channel(fake), 2);
				});
				after(CALL_MS + 40, () => {
					flagAtDeadline = Atomics.load(channel(fake), FLAG);
					fake.say({ type: 'call-end', i: 0, text: 'one' });
					fake.say({ type: 'call-start', i: 1 });
				});
				after(CALL_MS + 50, () => finish(fake, 1, 'two'));
				after(CALL_MS + 60, () => done(fake, 2));
			})
		]);
		const run = await pool.run(batchOf(2), bridge);
		expect(texts(run)).toEqual(['d0', 'd1']);
		expect(flagAtDeadline).toBe(0);
		expect(Atomics.load(channel(fakes[0]!), FLAG)).toBe(0);
		expect(fakes[0]!.terminated).toBe(true);
	});

	it('answers a call the worker ended at the very moment of the stop as timeout, and never leaves the flag raised', async () => {
		// The worker's end and the pool's stop race: here the stop wins the word first.
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				void (async () => {
					await until(() => Atomics.load(channel(fake), WINDOW) % 4 === 3);
					finish(fake, 0, 'won anyway');
					start(fake, 1);
					finish(fake, 1, 'next');
					done(fake, 2);
				})();
			})
		]);
		const batch = batchOf(2);
		const run = await pool.run(batch, bridge);
		expect(texts(run)).toEqual([timeoutText(batch), 'd1']);
		expect(Atomics.load(channel(fakes[0]!), FLAG)).toBe(0);
	});
});

describe('the hard stop', () => {
	it('ends the worker graceMs after the soft stop and answers what has not ended as timeout', async () => {
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				finish(fake, 0, 'kept');
				after(5, () => start(fake, 1));
				// Call 1 never ends.
			})
		]);
		const batch = batchOf(3);
		const started = performance.now();
		const run = await pool.run(batch, bridge);
		const took = performance.now() - started;
		expect(texts(run)).toEqual(['kept', timeoutText(batch), timeoutText(batch)]);
		expect(took).toBeGreaterThanOrEqual(CALL_MS + GRACE_MS - 10);
		expect(took).toBeLessThan(CALL_MS + GRACE_MS + 400);
		expect(fakes[0]!.terminated).toBe(true);
	});

	it('answers every call as timeout when the first never ends, and runs the next batch on a new worker', async () => {
		const { pool, fakes } = poolOf([worker((fake) => start(fake, 0)), honest]);
		const batch = batchOf(2);
		const run = await pool.run(batch, bridge);
		expect(texts(run)).toEqual([timeoutText(batch), timeoutText(batch)]);
		expect(fakes[0]!.terminated).toBe(true);
		const next = await pool.run(batchOf(1), bridge);
		expect(texts(next)).toEqual(['r0']);
		expect(fakes[1]!.posted.filter((m) => m.type === 'run')).toHaveLength(1);
	});

	it('ends a worker that forges its word to ignore the soft stop, one more grace later', async () => {
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				// Not `running`, so the stop cannot win: the flag is never raised.
				Atomics.store(channel(fake), WINDOW, 1_000_000);
			})
		]);
		const batch = batchOf(1);
		const started = performance.now();
		const run = await pool.run(batch, bridge);
		const took = performance.now() - started;
		expect(texts(run)).toEqual([timeoutText(batch)]);
		expect(Atomics.load(channel(fakes[0]!), FLAG)).toBe(0);
		expect(took).toBeGreaterThanOrEqual(CALL_MS + 2 * GRACE_MS - 10);
		expect(took).toBeLessThan(CALL_MS + 2 * GRACE_MS + 400);
	});

	it('gives a worker whose call ended in time, with its `call-end` still queued behind the grace, one more period', async () => {
		// A pool thread busy past the grace runs the timer before the message; the worker's own word
		// says the call ended, so the batch is not ended for it.
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				void (async () => {
					await until(() => Atomics.load(channel(fake), FLAG) === 2);
					endWindow(channel(fake), 1);
					// Its message arrives only after the first grace has run out.
					after(GRACE_MS + 30, () => {
						fake.say({ type: 'call-end', i: 0, text: 'late' });
						start(fake, 1);
						finish(fake, 1, 'next');
						done(fake, 2);
					});
				})();
			})
		]);
		const batch = batchOf(2);
		const run = await pool.run(batch, bridge);
		expect(texts(run)).toEqual([timeoutText(batch), 'd1']);
		expect(fakes[0]!.posted.filter((m) => m.type === 'run')).toHaveLength(1);
	});

	it('ends a run whose worker says nothing after `run`, at the batch budget and one grace', async () => {
		const { pool, fakes } = poolOf([worker(() => {})], {
			limits: { ...LIMITS, callMs: 5000, batchMs: 150 }
		});
		const batch = batchOf(2);
		const started = performance.now();
		const run = await pool.run(batch, bridge);
		const took = performance.now() - started;
		// The call limit of this pool is 5 s; the budget is what ran out.
		const timeout = hostErrorText(batch, 'timeout', 'execution exceeded the wall timeout of 5s');
		expect(texts(run)).toEqual([timeout, timeout]);
		expect(took).toBeGreaterThanOrEqual(150 + GRACE_MS - 10);
		expect(fakes[0]!.terminated).toBe(true);
	});

	it('replaces the ended worker with a spare', async () => {
		const { pool, fakes } = poolOf([worker((fake) => start(fake, 0)), honest]);
		await pool.run(batchOf(1), bridge);
		await until(() => fakes.length === 2);
		expect(fakes[0]!.terminated).toBe(true);
		expect(fakes[1]!.terminated).toBe(false);
	});
});

describe('the module-level window', () => {
	it('stopped, ends the batch at the end of the window and answers every call as timeout', async () => {
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, -1);
				void until(() => Atomics.load(channel(fake), FLAG) === 2).then(() => finish(fake, -1, ''));
			})
		]);
		const batch = batchOf(2, { console: false });
		const started = performance.now();
		const run = await pool.run(batch, bridge);
		expect(texts(run)).toEqual([timeoutText(batch), timeoutText(batch)]);
		// Ended at the soft stop's end, not at the grace.
		expect(performance.now() - started).toBeLessThan(CALL_MS + GRACE_MS);
		expect(fakes[0]!.terminated).toBe(true);
		expect(fakes[0]!.posted.filter((m) => m.type === 'run')).toHaveLength(1);
	});

	it('is expected first for an embedded run: a call may not start before it', async () => {
		const { pool } = poolOf([worker((fake) => start(fake, 0))]);
		const batch = batchOf(1, { console: false });
		expect(texts(await pool.run(batch, bridge))).toEqual([
			hostErrorText(batch, 'runtime', 'the script worker sent a bad "call-start"')
		]);
	});

	it('is never a window of a console run', async () => {
		const { pool } = poolOf([worker((fake) => start(fake, -1))]);
		const batch = batchOf(1);
		expect(texts(await pool.run(batch, bridge))).toEqual([
			hostErrorText(batch, 'runtime', 'the script worker sent a bad "call-start"')
		]);
	});
});

describe('the batch budget', () => {
	it('ends the worker when a call starts with nothing left, and answers it and the rest as timeout', async () => {
		const { pool, fakes } = poolOf(
			[
				worker((fake) => {
					start(fake, 0);
					void until(() => Atomics.load(channel(fake), FLAG) === 2).then(() => {
						// It took longer than the whole budget to give up.
						after(60, () => {
							finish(fake, 0, 'late');
							start(fake, 1);
						});
					});
				})
			],
			{ limits: { ...LIMITS, callMs: 1000, batchMs: 100, graceMs: 500 } }
		);
		const batch = batchOf(3);
		const run = await pool.run(batch, bridge);
		const timeout = hostErrorText(batch, 'timeout', 'execution exceeded the wall timeout of 1s');
		expect(texts(run)).toEqual([timeout, timeout, timeout]);
		expect(fakes[0]!.terminated).toBe(true);
	});
});

describe('cancel', () => {
	/** A signal whose listeners are counted. */
	function signalOf() {
		const listeners = new Set<() => void>();
		const signal: AbortSignalLike & { aborted: boolean } = {
			aborted: false,
			addEventListener: (_, listener) => void listeners.add(listener),
			removeEventListener: (_, listener) => void listeners.delete(listener)
		};
		return {
			signal,
			listeners,
			abort() {
				signal.aborted = true;
				for (const listener of [...listeners]) listener();
			}
		};
	}

	it('soft-stops the running call, ends the worker when it ends, and answers what has not ended as cancelled', async () => {
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				finish(fake, 0, 'kept');
				after(5, () => {
					start(fake, 1);
					void until(() => Atomics.load(channel(fake), FLAG) === 2).then(() => {
						finish(fake, 1, 'interrupted');
						// Whatever follows is never read: the worker is ended.
						start(fake, 2);
					});
				});
			})
		]);
		const one = signalOf();
		const batch = batchOf(3);
		const running = pool.run(batch, bridge, one.signal);
		await until(() => fakes[0]!.posted.some((m) => m.type === 'run'));
		await settle(40);
		one.abort();
		const started = performance.now();
		const run = await running;
		expect(texts(run)).toEqual(['kept', cancelledText(batch), cancelledText(batch)]);
		// Well before the grace or the deadline: the worker ended the call at once.
		expect(performance.now() - started).toBeLessThan(GRACE_MS);
		expect(fakes[0]!.terminated).toBe(true);
		expect(one.listeners.size).toBe(0);
	});

	it('ends the worker of a call that ignores the interrupt at the grace', async () => {
		const { pool, fakes } = poolOf([worker((fake) => start(fake, 0))], {
			limits: { ...LIMITS, callMs: 5000 }
		});
		const one = signalOf();
		const batch = batchOf(2);
		const running = pool.run(batch, bridge, one.signal);
		await until(() => fakes[0]!.posted.some((m) => m.type === 'run'));
		await settle(30);
		one.abort();
		const started = performance.now();
		const run = await running;
		expect(texts(run)).toEqual([cancelledText(batch), cancelledText(batch)]);
		expect(performance.now() - started).toBeGreaterThanOrEqual(GRACE_MS - 10);
		expect(fakes[0]!.terminated).toBe(true);
	});

	it('ends the worker at once when no call is running, for there is nothing to interrupt', async () => {
		const { pool, fakes } = poolOf([worker(() => {})], { limits: { ...LIMITS, batchMs: 60_000 } });
		const one = signalOf();
		const batch = batchOf(1);
		const running = pool.run(batch, bridge, one.signal);
		await until(() => fakes[0]!.posted.some((m) => m.type === 'run'));
		one.abort();
		expect(texts(await running)).toEqual([cancelledText(batch)]);
		expect(fakes[0]!.terminated).toBe(true);
	});

	it('keeps a call the deadline already stopped as timeout, and answers the rest as cancelled', async () => {
		const { pool } = poolOf([worker((fake) => start(fake, 0))], {
			limits: { ...LIMITS, graceMs: 400 }
		});
		const one = signalOf();
		const batch = batchOf(2);
		const running = pool.run(batch, bridge, one.signal);
		await settle(CALL_MS + 60);
		one.abort();
		expect(texts(await running)).toEqual([timeoutText(batch), cancelledText(batch)]);
	});

	it('answers cancelled for a run aborted already, spawning nothing and leaving no listener', async () => {
		const { pool, fakes } = poolOf([honest]);
		const one = signalOf();
		one.abort();
		const batch = batchOf(2);
		const run = await pool.run(batch, bridge, one.signal);
		expect(texts(run)).toEqual([cancelledText(batch), cancelledText(batch)]);
		expect(run).toMatchObject({ trips: 0, ms: 0 });
		expect(fakes).toHaveLength(0);
		expect(one.listeners.size).toBe(0);
	});

	it('takes a run that waits out of the queue: it answers cancelled, no worker is given it, and the next run is served', async () => {
		const { pool, fakes } = poolOf([
			worker((fake) => {
				start(fake, 0);
				after(50, () => {
					finish(fake, 0);
					done(fake, 1);
				});
			}),
			honest
		]);
		const first = pool.run(batchOf(1), bridge);
		await until(() => fakes[0]!.posted.some((m) => m.type === 'run'));
		const one = signalOf();
		const waiting = batchOf(1);
		const second = pool.run(waiting, bridge, one.signal);
		await settle(20);
		expect(one.listeners.size).toBe(1);
		one.abort();
		expect(texts(await second)).toEqual([cancelledText(waiting)]);
		expect(one.listeners.size).toBe(0);
		expect(texts(await first)).toEqual(['d0']);
		const third = await pool.run(batchOf(1), bridge);
		expect(texts(third)).toEqual(['r0']);
		// The aborted run was never sent to a worker: the two that ran got one batch each.
		expect(fakes.flatMap((f) => f.posted.filter((m) => m.type === 'run'))).toHaveLength(2);
	});

	it('does nothing for an abort after the run answered, and removes its listener', async () => {
		const { pool } = poolOf([honest]);
		const one = signalOf();
		const run = await pool.run(batchOf(1), bridge, one.signal);
		expect(texts(run)).toEqual(['r0']);
		expect(one.listeners.size).toBe(0);
		one.abort();
		expect(texts(await pool.run(batchOf(1), bridge))).toEqual(['r0']);
	});

	it('answers a run that fails to boot its worker as the boot error, leaving no listener', async () => {
		const { pool } = poolOf([
			(fake, message) => {
				if (message.type === 'init') fake.say({ type: 'failed', message: 'no boot' });
			}
		]);
		const one = signalOf();
		await expect(pool.run(batchOf(1), bridge, one.signal)).rejects.toThrow('no boot');
		expect(one.listeners.size).toBe(0);
	});
});

describe('what a crash answers', () => {
	const crash = (how: (fake: Fake) => void) =>
		worker((fake) => {
			start(fake, 0);
			finish(fake, 0, 'kept');
			after(5, () => {
				start(fake, 1);
				how(fake);
			});
		});

	it('answers memory for what had not ended when the worker says MemoryError, and keeps what ended', async () => {
		const { pool, fakes } = poolOf([
			crash((fake) => fake.say({ type: 'failed', message: 'Traceback ...\nMemoryError\n' }))
		]);
		const batch = batchOf(3);
		const run = await pool.run(batch, bridge);
		const memory = hostErrorText(batch, 'memory', 'guest exceeded its memory budget');
		expect(texts(run)).toEqual(['kept', memory, memory]);
		expect(fakes[0]!.terminated).toBe(true);
	});

	for (const text of [
		'RangeError: Array buffer allocation failed',
		'Worker terminated due to reaching memory limit: JS heap out of memory',
		'the wasm could not allocate memory'
	]) {
		it(`answers memory for a crash that says “${text}”`, async () => {
			const { pool } = poolOf([crash((fake) => fake.crash(text))]);
			const batch = batchOf(2);
			const run = await pool.run(batch, bridge);
			const memory = hostErrorText(batch, 'memory', 'guest exceeded its memory budget');
			expect(texts(run)).toEqual(['kept', memory]);
		});
	}

	it('answers runtime, with the worker’s text, for any other crash', async () => {
		const { pool } = poolOf([crash((fake) => fake.crash('the thread died'))]);
		const batch = batchOf(2);
		expect(texts(await pool.run(batch, bridge))).toEqual([
			'kept',
			hostErrorText(batch, 'runtime', 'the thread died')
		]);
	});

	it('does not read a bridge failure as a worker out of memory', async () => {
		const { pool } = poolOf([
			crash((fake) => {
				fake.say({ type: 'bridge', text: 'q' });
			})
		]);
		const batch = batchOf(2);
		const run = await pool.run(batch, {
			dispatch: () => {
				throw new Error('MemoryError in the host');
			},
			roots: () => '[]'
		});
		expect(texts(run)).toEqual([
			'kept',
			hostErrorText(batch, 'runtime', 'the bridge failed: MemoryError in the host')
		]);
	});

	it('keeps the timeout of a call the pool stopped when the worker then crashes', async () => {
		const { pool } = poolOf([
			crash((fake) => {
				void until(() => Atomics.load(channel(fake), FLAG) === 2).then(() =>
					fake.crash('the thread died')
				);
			})
		]);
		const batch = batchOf(3);
		const run = await pool.run(batch, bridge);
		expect(texts(run)).toEqual([
			'kept',
			timeoutText(batch),
			hostErrorText(batch, 'runtime', 'the thread died')
		]);
	});

	it('answers cancelled, not the crash, for what a cancelled run had not ended', async () => {
		const { pool, fakes } = poolOf([crash(() => {})], { limits: { ...LIMITS, callMs: 5000 } });
		const batch = batchOf(3);
		const controller = new AbortController();
		const running = pool.run(batch, bridge, controller.signal);
		await until(() => fakes[0]!.posted.some((m) => m.type === 'run'));
		await settle(40);
		controller.abort();
		fakes[0]!.crash('the thread died');
		expect(texts(await running)).toEqual(['kept', cancelledText(batch), cancelledText(batch)]);
	});
});

describe('what `done` answers', () => {
	it('rewrites only the calls the pool stopped: the others are what the worker said', async () => {
		const { pool } = poolOf([
			worker((fake) => {
				start(fake, 0);
				finish(fake, 0);
				start(fake, 1);
				void until(() => Atomics.load(channel(fake), FLAG) === 2).then(() => {
					finish(fake, 1);
					start(fake, 2);
					finish(fake, 2);
					fake.say({
						type: 'done',
						results: [
							{ text: 'a' },
							{ text: 'interrupted: said success' },
							{ text: 'KeyboardInterrupt' }
						],
						trips: 0,
						ms: 1
					});
				});
			})
		]);
		const batch = batchOf(3);
		expect(texts(await pool.run(batch, bridge))).toEqual([
			'a',
			timeoutText(batch),
			'KeyboardInterrupt'
		]);
	});

	it('refuses a done sent inside a call', async () => {
		const { pool } = poolOf([
			worker((fake) => {
				start(fake, 0);
				done(fake, 1);
			})
		]);
		const batch = batchOf(1);
		expect(texts(await pool.run(batch, bridge))).toEqual([
			hostErrorText(batch, 'runtime', 'the script worker ended mid-call')
		]);
	});
});

describe('window messages a worker may not send', () => {
	/** `kept`: what ended before the message is still what the run answers for it. */
	const bad = (name: string, onRun: (fake: Fake) => void, type: string, kept: string[] = []) =>
		it(`fails the batch on ${name}`, async () => {
			const { pool, fakes } = poolOf([worker(onRun)]);
			const batch = batchOf(2);
			const run = await pool.run(batch, bridge);
			const failed = hostErrorText(batch, 'runtime', `the script worker sent a bad "${type}"`);
			expect(texts(run)).toEqual(batch.calls.map((_, i) => kept[i] ?? failed));
			expect(fakes[0]!.terminated).toBe(true);
		});

	bad('a call that starts out of order', (fake) => start(fake, 1), 'call-start');
	bad(
		'a call that starts inside another',
		(fake) => {
			start(fake, 0);
			fake.say({ type: 'call-start', i: 1 });
		},
		'call-start'
	);
	bad(
		'a call that starts twice',
		(fake) => {
			start(fake, 0);
			finish(fake, 0);
			fake.say({ type: 'call-start', i: 0 });
		},
		'call-start',
		['t0']
	);
	bad(
		'a call-end that no call-start opened',
		(fake) => fake.say({ type: 'call-end', i: 0, text: 'x' }),
		'call-end'
	);
	bad(
		'a call-end of another call',
		(fake) => {
			start(fake, 0);
			fake.say({ type: 'call-end', i: 1, text: 'x' });
		},
		'call-end'
	);
	bad(
		'a call-end with no text',
		(fake) => {
			start(fake, 0);
			fake.say({ type: 'call-end', i: 0 });
		},
		'call-end'
	);
});

describe('the reply channel', () => {
	const reason = (batch: ScriptBatch, text: string) => hostErrorText(batch, 'runtime', text);

	it('refuses a request sent while a reply is in flight, and ends the worker', async () => {
		const { pool, fakes } = poolOf([
			worker((fake) => {
				armReply(fake.buffers.reply);
				// Two requests with no read of the first reply between.
				fake.say({ type: 'bridge', text: 'a' });
				fake.say({ type: 'bridge', text: 'b' });
			})
		]);
		const asked: string[] = [];
		const batch = batchOf(1);
		const run = await pool.run(batch, {
			dispatch: (text) => (asked.push(text), 'x'),
			roots: () => '[]'
		});
		expect(texts(run)).toEqual([
			reason(batch, 'the script worker sent a bridge request while a reply was in flight')
		]);
		expect(asked).toEqual(['a']);
		expect(fakes[0]!.terminated).toBe(true);
	});

	it('refuses a request sent while chunks of a reply are still to come', async () => {
		const { pool } = poolOf([
			worker((fake) => {
				armReply(fake.buffers.reply);
				fake.say({ type: 'bridge', text: 'a' });
				// The reader copied the first chunk and reset the state, but asked for no more.
				after(10, () => {
					armReply(fake.buffers.reply);
					fake.say({ type: 'bridge', text: 'b' });
				});
			})
		]);
		const batch = batchOf(1);
		const run = await pool.run(batch, { dispatch: () => 'x'.repeat(3_000_000), roots: () => '[]' });
		expect(texts(run)).toEqual([
			reason(batch, 'the script worker sent a bridge request while a reply was in flight')
		]);
	});

	it('refuses a `more` with nothing pending, and one sent before the chunk was copied', async () => {
		const nothing = poolOf([worker((fake) => fake.say({ type: 'more' }))]);
		const batch = batchOf(1);
		expect(texts(await nothing.pool.run(batch, bridge))).toEqual([
			reason(batch, 'the script worker asked for a chunk that is not pending')
		]);
		const early = poolOf([
			worker((fake) => {
				armReply(fake.buffers.reply);
				fake.say({ type: 'bridge', text: 'a' });
				// The first chunk is in and not copied: the state is 1.
				fake.say({ type: 'more' });
			})
		]);
		expect(
			texts(
				await early.pool.run(batch, { dispatch: () => 'x'.repeat(3_000_000), roots: () => '[]' })
			)
		).toEqual([reason(batch, 'the script worker asked for a chunk that is not pending')]);
	});
});

describe('the boot deadline', () => {
	const slowBoot: Behaviour = () => {};

	it('ends a worker that never says ready, and fails the run that waited for it, without a respawn loop', async () => {
		const { pool, fakes } = poolOf([slowBoot, honest], { limits: { ...LIMITS, bootMs: 60 } });
		await expect(pool.run(batchOf(1), bridge)).rejects.toThrow(
			'the script worker did not boot within 0.06s'
		);
		expect(fakes[0]!.terminated).toBe(true);
		await settle(250);
		expect(fakes).toHaveLength(1);
		// The next run tries one boot again, and gets it.
		expect(texts(await pool.run(batchOf(1), bridge))).toEqual(['r0']);
		expect(fakes[1]!.posted.some((m) => m.type === 'run')).toBe(true);
	});

	it('fails a pending boot() the same way', async () => {
		const { pool, fakes } = poolOf([slowBoot], { limits: { ...LIMITS, bootMs: 60 } });
		await expect(pool.boot()).rejects.toThrow('the script worker did not boot within 0.06s');
		expect(fakes[0]!.terminated).toBe(true);
	});

	it('is disarmed by ready: a worker that booted is not ended for it', async () => {
		const { pool, fakes } = poolOf([honest], { limits: { ...LIMITS, bootMs: 60 } });
		await pool.boot();
		await settle(200);
		expect(fakes[0]!.terminated).toBe(false);
		expect(texts(await pool.run(batchOf(1), bridge))).toEqual(['r0']);
	});

	it('gives up the snapshot when the maker takes longer, and boots cold from then on, warning once', async () => {
		const warnings: string[] = [];
		// The first spawn is a worker, the second the maker, which never answers.
		const { pool, fakes } = poolOf([honest, slowBoot, honest], {
			snapshots: true,
			limits: { ...LIMITS, bootMs: 60 },
			onWarning: (text) => warnings.push(text)
		});
		await pool.run(batchOf(1), bridge);
		await until(() => warnings.length > 0);
		expect(warnings).toEqual([
			'script workers boot cold: the snapshot could not be made: the script worker did not boot within 0.06s'
		]);
		expect(fakes[1]!.terminated).toBe(true);
		const next = await pool.run(batchOf(1), bridge);
		expect(texts(next)).toEqual(['r0']);
		expect(fakes.slice(2).every((fake) => fake.posted[0]?.snapshot === undefined)).toBe(true);
		await settle(40);
		expect(warnings).toHaveLength(1);
	});
});

describe('a worker that cannot be set up', () => {
	it('ends a worker whose handlers cannot be set, and leaves no thread behind', async () => {
		const workers = fakeWorkers(honest);
		const pool = createPool(
			(buffers) => {
				const port = workers.spawn(buffers);
				port.onMessage = () => {
					throw new Error('no handler');
				};
				return port;
			},
			{ cap: 1, now: () => performance.now(), snapshots: false }
		);
		pools.push(pool);
		await expect(pool.run(batchOf(1), bridge)).rejects.toThrow('no handler');
		expect(workers.fakes[0]!.terminated).toBe(true);
	});

	it('spawns nothing when the copy of the image fails, and fails the run that needed a worker', async () => {
		const workers = fakeWorkers((fake, message) => {
			if (message.type === 'init' && message.make === true) {
				// An image whose copy throws.
				const image = {
					byteLength: 10,
					[Symbol.toStringTag]: 'ArrayBuffer',
					slice() {
						throw new Error('no memory for a copy');
					}
				};
				fake.say({ type: 'snapshot', bytes: image });
			} else honest(fake, message);
		});
		const pool = createPool(workers.spawn, { cap: 2, now: () => performance.now() });
		pools.push(pool);
		await pool.run(batchOf(1), bridge);
		await until(() => workers.fakes.length === 2 && workers.fakes.every((fake) => fake.terminated));
		await settle(50);
		// The worker and the maker; no spare was spawned for an image that cannot be copied.
		expect(workers.fakes).toHaveLength(2);
		await expect(pool.run(batchOf(1), bridge)).rejects.toThrow('no memory for a copy');
		expect(workers.fakes).toHaveLength(2);
	});
});
