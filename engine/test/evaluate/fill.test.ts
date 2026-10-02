import { afterAll, describe, expect, it, vi } from 'vitest';
import {
	CellCache,
	evaluateFilled,
	parseExact,
	PENDING,
	ReadError,
	type BatchRunner,
	type FillOptions,
	type FillSignal,
	type ReaderCall,
	type ScriptBatch,
	type ScriptHost,
	type ScriptReader,
	type ScriptResult
} from '../../src/index.ts';
import { SETTLE_STEP } from '../../src/evaluate/fill.ts';
import { drain } from '../../src/steps/steps.ts';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../../src/script/bridge.ts';
import type { Bridge } from '../../src/script/host.ts';
import { createPool } from '../../src/script/pool.ts';
import { nodeScriptHost, spawnNodeWorker } from '../../node/script-host.ts';
import { instrumented } from '../script/fixtures/instrumented.ts';
import { parityModel } from '../script/parity.ts';

// The fill loop over real Pyodide in real worker threads: what it asks the runner, what it keeps,
// and when it stops. The scripts read the parity corpus's model.

const hosts: ScriptHost[] = [];
const own = (host: ScriptHost) => (hosts.push(host), host);
afterAll(() => hosts.forEach((host) => host.dispose()));

const host = own(nodeScriptHost());

/** A read-only bridge over the corpus's model. */
function readOnlyBridge(): Bridge {
	const dispatcher = new BridgeDispatcher(parityModel(), false);
	return {
		dispatch: (text) => dispatcher.dispatch(text),
		roots: (ids) => dumpDefault(projectRoots(parityModel(), ids))
	};
}

/** A runner over `over`, remembering the batches it was asked for. */
function runnerOver(over: ScriptHost, seen: ScriptBatch[] = []): BatchRunner {
	return async (batch, signal) => {
		seen.push(batch);
		const run = await over.run(batch, readOnlyBridge(), signal);
		return run.results.map((one) => one.text);
	};
}

const call = (code: string, elementIds: string[], extra: Partial<ReaderCall> = {}): ReaderCall => ({
	code,
	entry: 'value',
	elementIds,
	inputsText: null,
	docText: null,
	...extra
});

/** What a call answered, as one string: the scalar it returned, or the kind of its error. */
function shown(result: ScriptResult): string {
	if (result.error !== null) return `${result.error.kind}: ${result.error.message}`;
	const payload = result.payload;
	return payload !== null && 'kind' in payload && payload.kind === 'scalar'
		? String(payload.value)
		: 'other';
}

const LEN = 'def value(els):\n    return len(els)\n';
const TIMES_TEN = 'def value(els):\n    return len(els) * 10\n';

const options = (runner: BatchRunner, more: Partial<FillOptions> = {}): FillOptions => ({
	runner,
	signal: new AbortController().signal,
	...more
});

describe('collect, fill, run again', () => {
	/** A pass that asks `LEN` over one id, then `TIMES_TEN` over as many ids plus one as that answered. */
	function chained(passes: { n: number }) {
		return async (scripts: ScriptReader) => {
			passes.n++;
			const first = scripts.read(call(LEN, ['n1']));
			if (first.error !== null) return [shown(first)];
			const width = Number(shown(first));
			const ids = ['n1', 'n2', 'l1'].slice(0, width + 1);
			return [shown(first), shown(scripts.read(call(TIMES_TEN, ids)))];
		};
	}

	it('takes three passes and two rounds for a chain of two levels', async () => {
		const passes = { n: 0 };
		const seen: ScriptBatch[] = [];
		const { value, stats } = await evaluateFilled(chained(passes), options(runnerOver(host, seen)));
		expect(value).toEqual(['1', '20']);
		expect(passes.n).toBe(3);
		expect(stats).toEqual({ rounds: 2, calls: 2 });
		expect(seen.map((batch) => batch.code)).toEqual([LEN, TIMES_TEN]);
	}, 60_000);

	it('runs a call asked for twice once, and one batch per code with each call in first-asked order', async () => {
		const seen: ScriptBatch[] = [];
		const { value, stats } = await evaluateFilled(
			async (scripts) => {
				return [
					scripts.read(call(LEN, ['n1'])),
					scripts.read(call(TIMES_TEN, ['n1'])),
					scripts.read(call(LEN, ['n1'])),
					scripts.read(call(LEN, ['n1', 'n2'])),
					scripts.read(call(LEN, ['n1'])),
					scripts.read(call(LEN, ['n1'], { entry: 'step' }))
				].map(shown);
			},
			options(runnerOver(host, seen))
		);
		expect(value.slice(0, 5)).toEqual(['1', '10', '1', '2', '1']);
		expect(stats).toEqual({ rounds: 1, calls: 4 });
		expect(
			seen.map((batch) => [batch.entry, batch.code, batch.calls.map((one) => one.elementIds)])
		).toEqual([
			['value', LEN, [['n1'], ['n1', 'n2']]],
			['value', TIMES_TEN, [['n1']]],
			['step', LEN, [['n1']]]
		]);
	}, 60_000);

	it('hands a call its inputs parsed exactly and its document as written', async () => {
		const inputsText = '{"x": {"kind": "scalars", "values": [1.0, 12345678901234567890]}}';
		const docText = '{"10": 1, "2": 2.0, "a": 3}';
		const seen: ScriptBatch[] = [];
		await evaluateFilled(
			async (scripts) => scripts.read(call(TIMES_TEN, ['n1'], { inputsText, docText })),
			options(runnerOver(host, seen))
		);
		const [one] = seen[0]!.calls;
		expect(one!.inputs).toEqual(parseExact(inputsText));
		// A parsed document would hold `2` before `10`.
		expect(one!.docText).toBe(docText);
		expect(one!.doc).toBeUndefined();
	}, 60_000);

	it('omits an input and a document it has no text for', async () => {
		const seen: ScriptBatch[] = [];
		await evaluateFilled(
			async (scripts) => scripts.read(call(LEN, ['n1'])),
			options(runnerOver(host, seen))
		);
		expect(Object.keys(seen[0]!.calls[0]!)).toEqual(['elementIds']);
	}, 60_000);

	it('runs no round the second time over the same cache', async () => {
		const cache = new CellCache();
		const first: ScriptBatch[] = [];
		const a = await evaluateFilled(chained({ n: 0 }), options(runnerOver(host, first), { cache }));
		expect(cache.size).toBe(2);
		const second: ScriptBatch[] = [];
		const b = await evaluateFilled(chained({ n: 0 }), options(runnerOver(host, second), { cache }));
		expect(b.value).toEqual(a.value);
		expect(b.stats).toEqual({ rounds: 0, calls: 0 });
		expect(second).toEqual([]);
	}, 60_000);

	it('reports calls done against calls asked for as each batch finishes', async () => {
		const reports: [number, number][] = [];
		await evaluateFilled(
			chained({ n: 0 }),
			options(runnerOver(host), { onProgress: (done, total) => reports.push([done, total]) })
		);
		expect(reports).toEqual([
			[1, 1],
			[2, 2]
		]);
	}, 60_000);

	it('answers a pass that records no miss at once, with no round', async () => {
		let runs = 0;
		const { value, stats } = await evaluateFilled(async () => 7, {
			...options(async () => (runs++, [])),
			transitions: () => 0
		});
		expect(value).toBe(7);
		expect(stats).toEqual({ rounds: 0, calls: 0 });
		expect(runs).toBe(0);
	});
});

describe('a pass that throws', () => {
	it('is discarded when it recorded a miss, as it may have thrown from a pending answer', async () => {
		let passes = 0;
		const { value } = await evaluateFilled(
			async (scripts) => {
				passes++;
				const answer = scripts.read(call(LEN, ['n1']));
				if (answer === PENDING || answer.error !== null) throw new Error('read a pending answer');
				return shown(answer);
			},
			options(runnerOver(host))
		);
		expect(value).toBe('1');
		expect(passes).toBe(2);
	}, 60_000);

	it('rejects with its own error when it recorded none', async () => {
		const failure = new ReadError(422, 'no');
		const seen: ScriptBatch[] = [];
		const rejected = await evaluateFilled(
			async () => {
				throw failure;
			},
			options(runnerOver(host, seen))
		).catch((error: unknown) => error);
		expect(rejected).toBe(failure);
		expect(seen).toEqual([]);
	});
});

describe('what a fill keeps', () => {
	it('publishes a call that ran out of time as a timeout, keeps none of it, and runs it again', async () => {
		const quick = own(
			createPool(spawnNodeWorker, {
				cap: 2,
				limits: { callMs: 300, graceMs: 500 },
				now: () => performance.now()
			})
		);
		const cache = new CellCache();
		const spin = 'def value(els):\n    while True:\n        pass\n';
		const pass = async (scripts: ScriptReader) => [
			shown(scripts.read(call(spin, ['n1']))),
			shown(scripts.read(call(LEN, ['n1'])))
		];
		const seen: ScriptBatch[] = [];
		const first = await evaluateFilled(pass, options(runnerOver(quick, seen), { cache }));
		expect(first.value[0]).toMatch(/^timeout: /);
		expect(first.value[1]).toBe('1');
		// The value is kept; the timeout is not.
		expect(cache.size).toBe(1);
		const second = await evaluateFilled(pass, options(runnerOver(quick, seen), { cache }));
		expect(second.value).toEqual(first.value);
		expect(second.stats).toEqual({ rounds: 1, calls: 1 });
		expect(seen.filter((batch) => batch.code === spin)).toHaveLength(2);
		expect(seen.filter((batch) => batch.code === LEN)).toHaveLength(1);
	}, 60_000);

	it('keeps an error the same code raises again', async () => {
		const cache = new CellCache();
		const boom = 'def value(els):\n    raise ValueError("x")\n';
		const pass = async (scripts: ScriptReader) => shown(scripts.read(call(boom, ['n1'])));
		const first = await evaluateFilled(pass, options(runnerOver(host), { cache }));
		expect(first.value).toBe('runtime: ValueError: x');
		expect(cache.size).toBe(1);
		expect((await evaluateFilled(pass, options(runnerOver(host), { cache }))).stats.rounds).toBe(0);
	}, 60_000);

	it('drops a round the model moved under, runs it again, and keeps the second', async () => {
		const cache = new CellCache();
		let moved = 0;
		let rounds = 0;
		const inner = runnerOver(host);
		const sizes: number[] = [];
		const runner: BatchRunner = async (batch, signal) => {
			sizes.push(cache.size);
			const texts = await inner(batch, signal);
			if (rounds++ === 0) moved++;
			return texts;
		};
		const { value, stats } = await evaluateFilled(
			async (scripts) => shown(scripts.read(call(LEN, ['n1']))),
			options(runner, { cache, transitions: () => moved })
		);
		expect(value).toBe('1');
		// One extra round, and the dropped one left nothing for the second to find.
		expect(stats).toEqual({ rounds: 2, calls: 2 });
		expect(sizes).toEqual([0, 0]);
		expect(cache.size).toBe(1);
	}, 60_000);

	it('runs a pass again, with no round, when a transition landed during it', async () => {
		const cache = new CellCache();
		let moved = 0;
		const seen: ScriptBatch[] = [];
		const { stats } = await evaluateFilled(
			async (scripts) => {
				const answer = scripts.read(call(LEN, ['n1']));
				if (answer.error !== null && moved === 0) moved++;
				return shown(answer);
			},
			options(runnerOver(host, seen), { cache, transitions: () => moved })
		);
		// The first pass ended in another state than it began in: its misses are not run.
		expect(stats).toEqual({ rounds: 1, calls: 1 });
		expect(seen).toHaveLength(1);
		expect(cache.size).toBe(1);
	}, 60_000);

	it('runs a pass that recorded no miss again when a transition landed during it', async () => {
		let moved = 0;
		let passes = 0;
		const { value, stats } = await evaluateFilled(
			async () => {
				passes++;
				if (passes === 1) moved++;
				return passes;
			},
			{ ...options(async () => []), transitions: () => moved }
		);
		expect(value).toBe(2);
		expect(stats).toEqual({ rounds: 0, calls: 0 });
	});

	describe('a pass that begins its scan', () => {
		it('is answered when a transition landed after its scan, with no second pass', async () => {
			let moved = 0;
			let passes = 0;
			const { value, stats } = await evaluateFilled(
				async (scripts) => {
					passes++;
					scripts.begin();
					// What lands behind the scan before the fill hears of its end.
					moved++;
					return passes;
				},
				{ ...options(async () => []), transitions: () => moved }
			);
			expect(value).toBe(1);
			expect(stats).toEqual({ rounds: 0, calls: 0 });
		});

		it('is answered when it threw with no miss, whatever landed after its scan', async () => {
			let moved = 0;
			await expect(
				evaluateFilled(
					async (scripts) => {
						scripts.begin();
						moved++;
						throw new Error('the scan failed');
					},
					{ ...options(async () => []), transitions: () => moved }
				)
			).rejects.toThrow('the scan failed');
		});

		it('keeps its round when the counter moved before the scan began, not after', async () => {
			const cache = new CellCache();
			let moved = 0;
			let passes = 0;
			const { value, stats } = await evaluateFilled(
				async (scripts) => {
					passes++;
					// A transition queued ahead of the scan moves the counter before it starts.
					if (passes === 1) moved++;
					scripts.begin();
					return shown(scripts.read(call(LEN, ['n1'])));
				},
				options(runnerOver(host), { cache, transitions: () => moved })
			);
			expect(value).toBe('1');
			expect(stats).toEqual({ rounds: 1, calls: 1 });
			expect(passes).toBe(2);
			expect(cache.size).toBe(1);
		}, 60_000);

		it('drops its round and runs again, with no round, when a transition landed after its scan', async () => {
			const cache = new CellCache();
			let moved = 0;
			let passes = 0;
			const seen: ScriptBatch[] = [];
			const { stats } = await evaluateFilled(
				async (scripts) => {
					passes++;
					scripts.begin();
					const answer = scripts.read(call(LEN, ['n1']));
					if (passes === 1) moved++;
					return shown(answer);
				},
				options(runnerOver(host, seen), { cache, transitions: () => moved })
			);
			expect(passes).toBe(3);
			expect(stats).toEqual({ rounds: 1, calls: 1 });
			expect(seen).toHaveLength(1);
		}, 60_000);

		it('does not answer a pass in another state from the memo of the state before', async () => {
			let moved = 0;
			let passes = 0;
			const seen: ScriptBatch[] = [];
			const { value } = await evaluateFilled(
				async (scripts) => {
					passes++;
					// The second scan starts after a transition: what the first round answered is of the state before.
					if (passes === 2) moved++;
					scripts.begin();
					const first = scripts.read(call(LEN, ['n1']));
					if (first.error !== null) return shown(first);
					return `${shown(first)} ${shown(scripts.read(call(TIMES_TEN, ['n1'])))}`;
				},
				options(runnerOver(host, seen), { transitions: () => moved })
			);
			expect(value).toBe('1 10');
			expect(seen.map((batch) => batch.code)).toEqual([LEN, LEN, TIMES_TEN]);
		}, 60_000);

		it('forgets what a scan that starts over had missed', async () => {
			const seen: ScriptBatch[] = [];
			const { stats } = await evaluateFilled(
				async (scripts) => {
					scripts.begin();
					scripts.read(call(TIMES_TEN, ['n1']));
					// The scan starts over and no longer asks for it.
					scripts.begin();
					return shown(scripts.read(call(LEN, ['n1'])));
				},
				options(runnerOver(host, seen))
			);
			expect(seen.map((batch) => batch.code)).toEqual([LEN]);
			expect(stats.calls).toBe(1);
		}, 60_000);
	});

	it('forgets the memo of a state the model has left', async () => {
		let moved = 0;
		let passes = 0;
		const seen: ScriptBatch[] = [];
		const { value } = await evaluateFilled(
			async (scripts) => {
				passes++;
				const first = scripts.read(call(LEN, ['n1']));
				if (first.error !== null) return [shown(first)];
				const second = scripts.read(call(TIMES_TEN, ['n1']));
				// The model moves under the second pass, which asks for a call it has no answer to.
				if (passes === 2) moved++;
				return [shown(first), shown(second)];
			},
			options(runnerOver(host, seen), { transitions: () => moved })
		);
		expect(value).toEqual(['1', '10']);
		// The second pass was run again in the new state, and had to ask for `LEN` again.
		expect(passes).toBe(5);
		expect(seen.map((batch) => batch.code)).toEqual([LEN, LEN, TIMES_TEN]);
	}, 60_000);

	it('caps an output as the oracle’s session does', async () => {
		const cache = new CellCache();
		const loud = 'def value(els):\n    print("abcdefghij")\n    return 1\n';
		const pass = async (scripts: ScriptReader) => scripts.read(call(loud, ['n1']));
		const { value } = await evaluateFilled(
			pass,
			options(runnerOver(host), { cache, stdoutChars: 5 })
		);
		expect(value.stdout).toBe('abcde...');
		expect(
			(await evaluateFilled(pass, options(runnerOver(host), { cache, stdoutChars: 5 }))).value
				.stdout
		).toBe('abcde...');
	}, 60_000);
});

describe('a round settled through `slices`', () => {
	// More calls than one settle step, so a settle can stop part of the way.
	const CALLS = SETTLE_STEP + 44;

	/** A pass over `CALLS` distinct calls, each its own key by its document. */
	const wide = async (scripts: ScriptReader) =>
		Array.from({ length: CALLS }, (_, i) =>
			shown(scripts.read(call(LEN, ['n1'], { docText: `{"i": ${i}}` })))
		);
	const ones = Array.from({ length: CALLS }, () => '1');

	it('settles through `slices` when given', async () => {
		const cache = new CellCache();
		let slicedRounds = 0;
		const { value, stats } = await evaluateFilled(
			wide,
			options(runnerOver(host), {
				cache,
				slices: async (run) => {
					slicedRounds++;
					drain(run());
				}
			})
		);
		expect(value).toEqual(ones);
		expect(slicedRounds).toBe(1);
		expect(stats).toEqual({ rounds: 1, calls: CALLS });
		expect(cache.size).toBe(CALLS);
	}, 60_000);

	it('keeps nothing of a settle that starts after a transition, and runs another round', async () => {
		const cache = new CellCache();
		let moved = 0;
		const sizes: number[] = [];
		const { value, stats } = await evaluateFilled(
			wide,
			options(runnerOver(host), {
				cache,
				transitions: () => moved,
				slices: async (run) => {
					if (sizes.length === 0) moved++;
					drain(run());
					sizes.push(cache.size);
				}
			})
		);
		expect(value).toEqual(ones);
		expect(sizes).toEqual([0, CALLS]);
		expect(stats).toEqual({ rounds: 2, calls: 2 * CALLS });
	}, 60_000);

	it('stops a settle restarted after a transition where the transition fell', async () => {
		const cache = new CellCache();
		let moved = 0;
		const sizes: number[] = [];
		const { value, stats } = await evaluateFilled(
			wide,
			options(runnerOver(host), {
				cache,
				transitions: () => moved,
				slices: async (run) => {
					if (sizes.length > 0) return void drain(run());
					// One step in, a transition lands, and the job starts over.
					run().next();
					moved++;
					drain(run());
					sizes.push(cache.size);
					// What a transition does to what the cache held.
					cache.clear();
				}
			})
		);
		expect(value).toEqual(ones);
		expect(sizes).toEqual([SETTLE_STEP]);
		expect(stats).toEqual({ rounds: 2, calls: 2 * CALLS });
		expect(cache.size).toBe(CALLS);
	}, 60_000);

	it('stops a settle that resumes after a transition, with no restart', async () => {
		const cache = new CellCache();
		let moved = 0;
		const sizes: number[] = [];
		const { stats } = await evaluateFilled(
			wide,
			options(runnerOver(host), {
				cache,
				transitions: () => moved,
				slices: async (run) => {
					if (sizes.length > 0) return void drain(run());
					const steps = run();
					steps.next();
					moved++;
					drain(steps);
					sizes.push(cache.size);
					cache.clear();
				}
			})
		);
		expect(sizes).toEqual([SETTLE_STEP]);
		expect(stats.rounds).toBe(2);
		expect(cache.size).toBe(CALLS);
	}, 60_000);

	it('settles a call once when the job restarts with nothing moved', async () => {
		const cache = new CellCache();
		const put = vi.spyOn(cache, 'put');
		const { value, stats } = await evaluateFilled(
			wide,
			options(runnerOver(host), {
				cache,
				slices: async (run) => {
					run().next();
					drain(run());
				}
			})
		);
		expect(value).toEqual(ones);
		expect(stats).toEqual({ rounds: 1, calls: CALLS });
		expect(put).toHaveBeenCalledTimes(CALLS);
	}, 60_000);

	it('rejects with the abort reason when `slices` does', async () => {
		const controller = new AbortController();
		const reason = new Error('stop');
		const cache = new CellCache();
		const rejected = await evaluateFilled(
			wide,
			options(runnerOver(host), {
				cache,
				signal: controller.signal,
				slices: async (run) => {
					run().next();
					controller.abort(reason);
					throw reason;
				}
			})
		).catch((error: unknown) => error);
		expect(rejected).toBe(reason);
	}, 60_000);
});

describe('a round that fails', () => {
	const slow = (signal: FillSignal) =>
		new Promise<never>((_resolve, reject) => {
			const stop = () => reject(new Error('stopped'));
			if (signal.aborted) stop();
			else signal.addEventListener('abort', stop);
		});

	it('stops its other batches and rejects with the first failure', async () => {
		const failure = new Error('boot failed');
		const signals: FillSignal[] = [];
		const runner: BatchRunner = async (batch, signal) => {
			if (batch.code === LEN) throw failure;
			signals.push(signal);
			return slow(signal);
		};
		const rejected = await evaluateFilled(
			async (scripts) => [
				shown(scripts.read(call(LEN, ['n1']))),
				shown(scripts.read(call(TIMES_TEN, ['n1'])))
			],
			options(runner)
		).catch((error: unknown) => error);
		expect(rejected).toBe(failure);
		expect(signals.map((signal) => signal.aborted)).toEqual([true]);
	});

	it('rejects with the abort reason, not the runner’s error, and stops the other batches', async () => {
		const controller = new AbortController();
		const reason = new Error('stopped by the test');
		const signals: FillSignal[] = [];
		const runner: BatchRunner = async (batch, signal) => {
			signals.push(signal);
			if (signals.length === 2) controller.abort(reason);
			return slow(signal);
		};
		const rejected = await evaluateFilled(
			async (scripts) => [
				shown(scripts.read(call(LEN, ['n1']))),
				shown(scripts.read(call(TIMES_TEN, ['n1'])))
			],
			options(runner, { signal: controller.signal })
		).catch((error: unknown) => error);
		expect(rejected).toBe(reason);
		expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
	});
});

describe('a call text that is not the harness’s', () => {
	// What a script that rebinds `json.dumps` writes for itself.
	const forger =
		'import json\njson.dumps = lambda *a, **k: \'"FORGED"\'\ndef value(els):\n    return 1\n';

	it('is that call’s runtime error for this evaluation only, and the others are unharmed', async () => {
		const cache = new CellCache();
		const pass = async (scripts: ScriptReader) => [
			shown(scripts.read(call(forger, ['n1']))),
			shown(scripts.read(call(LEN, ['n1'])))
		];
		const first = await evaluateFilled(pass, options(runnerOver(host), { cache }));
		expect(first.value).toEqual(['runtime: malformed call result', '1']);
		expect(first.stats).toEqual({ rounds: 1, calls: 2 });
		expect(cache.size).toBe(1);
		const second = await evaluateFilled(pass, options(runnerOver(host), { cache }));
		expect(second.stats).toEqual({ rounds: 1, calls: 1 });
	}, 60_000);

	it('rejects the fill when a runner answers the wrong number of texts', async () => {
		const rejected = await evaluateFilled(
			async (scripts) => scripts.read(call(LEN, ['n1'])),
			options(async () => [])
		).catch((error: unknown) => error);
		expect(rejected).toBeInstanceOf(Error);
		expect((rejected as Error).message).toBe('the runner answered 0 results for 1 calls');
	});
});

describe('an abort', () => {
	it('rejects with its reason mid-batch, runs no further pass, keeps nothing and ends the worker', async () => {
		const ported = instrumented();
		const pool = own(createPool(ported.spawn, { cap: 2, now: () => performance.now() }));
		const controller = new AbortController();
		const cache = new CellCache();
		const reason = new Error('stopped by the test');
		let passes = 0;
		const spin = 'def value(els):\n    while True:\n        pass\n';
		const filling = evaluateFilled(
			async (scripts) => {
				passes++;
				return scripts.read(call(spin, ['n1']));
			},
			{ runner: runnerOver(pool), signal: controller.signal, cache }
		).catch((error: unknown) => error);
		await vi.waitFor(
			() =>
				expect(
					ported.seen.some((one) => one.messages.some((m) => m.type === 'call-start' && m.i === 0))
				).toBe(true),
			{ timeout: 30_000, interval: 20 }
		);
		controller.abort(reason);
		expect(await filling).toBe(reason);
		expect(passes).toBe(1);
		expect(cache.size).toBe(0);
		// The worker that ran the batch is ended; a spare the pool booted ahead is not its business.
		const ran = ported.seen.filter((one) => one.runs > 0);
		expect(ran).toHaveLength(1);
		await vi.waitFor(() => expect(ran[0]!.terminated).toBe(true), {
			timeout: 10_000,
			interval: 20
		});
	}, 60_000);

	it('rejects before any pass when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		let passes = 0;
		const rejected = await evaluateFilled(
			async () => (passes++, 1),
			options(runnerOver(host), { signal: controller.signal })
		).catch((error: unknown) => error);
		expect(rejected).toBe(controller.signal.reason);
		expect(passes).toBe(0);
	});

	it('rejects after a pass that an abort overtook, without running its misses', async () => {
		const controller = new AbortController();
		const seen: ScriptBatch[] = [];
		const rejected = await evaluateFilled(
			async (scripts) => {
				scripts.read(call(LEN, ['n1']));
				controller.abort();
				return 1;
			},
			options(runnerOver(host, seen), { signal: controller.signal })
		).catch((error: unknown) => error);
		expect(rejected).toBe(controller.signal.reason);
		expect(seen).toEqual([]);
	});
});
