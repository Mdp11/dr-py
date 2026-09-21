import { describe, expect, it } from 'vitest';
import { Scheduler, SLICE_TARGET_MS, type Job, type Steps } from '../../src/index.ts';
import { fakeHost, settle } from './helpers.ts';

/** A scan of `steps` steps that logs where it stands. */
function scan(log: string[], name: string, steps: number, started?: () => void): Job<string> {
	return {
		kind: 'scan',
		*run(): Steps<string> {
			started?.();
			for (let i = 1; i <= steps; i++) yield { done: i, total: steps };
			return name;
		}
	};
}

const read = (log: string[], name: string): Job<string> => ({
	kind: 'read',
	run: () => {
		log.push(`run ${name}`);
		return name;
	}
});

const transition = (log: string[], name: string, run?: () => void): Job<string> => ({
	kind: 'transition',
	run: () => {
		log.push(`run ${name}`);
		run?.();
		return name;
	}
});

function setup(tick = 3) {
	const host = fakeHost({ tick });
	const scheduler = new Scheduler(host.deps);
	const log: string[] = [];
	const answer = (name: string) => (outcome: { ok: boolean; value?: unknown; error?: unknown }) =>
		log.push(outcome.ok ? `answer ${name}` : `error ${name}: ${(outcome.error as Error).message}`);
	return { host, scheduler, log, answer };
}

describe('the queue', () => {
	it('runs jobs in arrival order', async () => {
		const { host, scheduler, log, answer } = setup();
		host.auto = true;
		scheduler.setOpen(true);
		for (const name of ['a', 'b', 'c'])
			scheduler.submit(name, 'model', read(log, name), answer(name));
		scheduler.submit('t', 'model', transition(log, 't'), answer('t'));
		scheduler.submit('d', 'model', read(log, 'd'), answer('d'));
		await scheduler.whenIdle();
		expect(log.filter((entry) => entry.startsWith('answer'))).toEqual([
			'answer a',
			'answer b',
			'answer c',
			'answer t',
			'answer d'
		]);
	});

	it('runs a control job before model jobs, and while closed', async () => {
		const { host, scheduler, log, answer } = setup();
		host.auto = true;
		scheduler.submit('m', 'model', read(log, 'm'), answer('m'));
		scheduler.submit('c', 'control', transition(log, 'c'), answer('c'));
		await scheduler.whenIdle();
		expect(log).toEqual(['run c', 'answer c']);
		scheduler.submit('c2', 'control', read(log, 'c2'), answer('c2'));
		scheduler.setOpen(true);
		await scheduler.whenIdle();
		expect(log).toEqual(['run c', 'answer c', 'run c2', 'answer c2', 'run m', 'answer m']);
	});

	it('refuses a scan on the control lane', () => {
		const { scheduler, log, answer } = setup();
		expect(() => scheduler.submit('s', 'control', scan(log, 's', 3), answer('s'))).toThrow();
	});

	it('holds model jobs while closed and runs them on setOpen(true)', async () => {
		const { host, scheduler, log, answer } = setup();
		host.auto = true;
		scheduler.submit('a', 'model', read(log, 'a'), answer('a'));
		await scheduler.whenIdle();
		await settle();
		expect(log).toEqual([]);
		scheduler.setOpen(true);
		await scheduler.whenIdle();
		expect(log).toEqual(['run a', 'answer a']);
	});

	it('makes a transition wait for the scan before it, and hold the reads behind it', async () => {
		const { host, scheduler, log, answer } = setup(3);
		host.auto = true;
		scheduler.setOpen(true);
		scheduler.submit('S', 'model', scan(log, 'S', 20), answer('S'));
		await settle();
		scheduler.submit('R1', 'model', read(log, 'R1'), answer('R1'));
		scheduler.submit('T', 'model', transition(log, 'T'), answer('T'));
		scheduler.submit('R2', 'model', read(log, 'R2'), answer('R2'));
		await scheduler.whenIdle();
		expect(log).toEqual([
			'run R1',
			'answer R1',
			'answer S',
			'run T',
			'answer T',
			'run R2',
			'answer R2'
		]);
	});

	it('makes a second scan wait for the first, while reads pass both', async () => {
		const { host, scheduler, log, answer } = setup(3);
		host.auto = true;
		scheduler.setOpen(true);
		scheduler.submit(
			'S1',
			'model',
			scan(log, 'S1', 20, () => log.push('start S1')),
			answer('S1')
		);
		scheduler.submit(
			'S2',
			'model',
			scan(log, 'S2', 20, () => log.push('start S2')),
			answer('S2')
		);
		await settle();
		scheduler.submit('R', 'model', read(log, 'R'), answer('R'));
		await scheduler.whenIdle();
		expect(log).toEqual(['start S1', 'run R', 'answer R', 'answer S1', 'start S2', 'answer S2']);
	});
});

describe('cancel', () => {
	it('removes a queued job, which is never run nor answered', async () => {
		const { host, scheduler, log, answer } = setup();
		host.auto = true;
		scheduler.submit('a', 'model', read(log, 'a'), answer('a'));
		scheduler.submit('b', 'model', transition(log, 'b'), answer('b'));
		scheduler.cancel('a');
		scheduler.cancel('b');
		scheduler.cancel('nobody');
		scheduler.setOpen(true);
		await scheduler.whenIdle();
		expect(log).toEqual([]);
	});

	it('stops a running scan at its next step, and the next job runs', async () => {
		const { host, scheduler, log, answer } = setup();
		scheduler.setOpen(true);
		let steps = 0;
		const counting: Job<string> = {
			kind: 'scan',
			*run() {
				for (;;) {
					steps++;
					yield { done: steps, total: 0 };
				}
			}
		};
		scheduler.submit('s', 'model', counting, answer('s'));
		scheduler.submit('r', 'model', read(log, 'r'), answer('r'));
		await settle();
		expect(host.waiting).toBe(1);
		scheduler.cancel('s');
		const seen = steps;
		host.auto = true;
		host.turn();
		await scheduler.whenIdle();
		expect(steps).toBe(seen);
		expect(log).toEqual(['run r', 'answer r']);
	});

	it('lets a started transition complete', async () => {
		const { host, scheduler, log, answer } = setup();
		host.auto = true;
		scheduler.setOpen(true);
		scheduler.submit(
			't',
			'model',
			transition(log, 't', () => scheduler.cancel('t')),
			answer('t')
		);
		await scheduler.whenIdle();
		expect(log).toEqual(['run t', 'answer t']);
	});
});

describe('failures and closing', () => {
	it('answers a job that throws with its error, and goes on', async () => {
		const { host, scheduler, log, answer } = setup();
		host.auto = true;
		scheduler.setOpen(true);
		const failing: Job<string> = {
			kind: 'read',
			run: () => {
				throw new Error('boom');
			}
		};
		const failingScan: Job<string> = {
			kind: 'scan',
			*run() {
				yield { done: 0, total: 1 };
				throw new Error('bang');
			}
		};
		scheduler.submit('f', 'model', failing, answer('f'));
		scheduler.submit('s', 'model', failingScan, answer('s'));
		scheduler.submit('r', 'model', read(log, 'r'), answer('r'));
		await scheduler.whenIdle();
		expect(log).toEqual(['error f: boom', 'error s: bang', 'run r', 'answer r']);
	});

	it('restarts a scan that was mid-flight when it closed, once it opens again', async () => {
		const { host, scheduler, log, answer } = setup(3);
		scheduler.setOpen(true);
		let runs = 0;
		scheduler.submit(
			's',
			'model',
			scan(log, 's', 10, () => runs++),
			answer('s')
		);
		await settle();
		expect([runs, host.waiting]).toEqual([1, 1]);
		scheduler.setOpen(false);
		host.turn();
		await scheduler.whenIdle();
		expect(log).toEqual([]);
		host.auto = true;
		scheduler.setOpen(true);
		await scheduler.whenIdle();
		expect(runs).toBe(2);
		expect(log).toEqual(['answer s']);
	});
});

describe('the background task', () => {
	function background(log: string[], steps: number, result = true) {
		let starts = 0;
		const progress: number[] = [];
		const task = {
			*start(): Steps<boolean> {
				starts++;
				for (let i = 1; i <= steps; i++) yield { done: i, total: steps };
				return result;
			},
			progress: (p: { done: number }) => progress.push(p.done),
			done: (ok: boolean) => log.push(`background ${ok}`)
		};
		return { task, progress, starts: () => starts };
	}

	it('runs only when idle, one slice at a time', async () => {
		const { host, scheduler, log, answer } = setup(3);
		scheduler.setOpen(true);
		const bg = background(log, 40);
		scheduler.setBackground(bg.task);
		await settle();
		// One slice: three steps at 3 ms a unit, then the host's turn.
		expect(bg.progress).toEqual([1, 2, 3]);
		scheduler.submit('r', 'model', read(log, 'r'), answer('r'));
		host.turn();
		await settle();
		expect(log).toEqual(['run r', 'answer r']);
		expect(bg.progress).toEqual([1, 2, 3, 4, 5]);
		host.auto = true;
		host.turn();
		await scheduler.whenIdle();
		expect(bg.progress).toHaveLength(40);
		expect(log.at(-1)).toBe('background true');
		expect(bg.starts()).toBe(1);
	});

	it('drops the generator in flight on restart and starts a new one', async () => {
		const { host, scheduler, log } = setup(3);
		scheduler.setOpen(true);
		const bg = background(log, 10);
		scheduler.setBackground(bg.task);
		await settle();
		expect(bg.progress).toEqual([1, 2, 3]);
		scheduler.restartBackground();
		host.auto = true;
		host.turn();
		await scheduler.whenIdle();
		expect(bg.progress).toEqual([1, 2, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(bg.starts()).toBe(2);
		expect(log).toEqual(['background true']);
	});

	it('delivers false, and is not started again once finished', async () => {
		const { host, scheduler, log, answer } = setup(3);
		host.auto = true;
		scheduler.setOpen(true);
		const bg = background(log, 2, false);
		scheduler.setBackground(bg.task);
		await scheduler.whenIdle();
		expect(log).toEqual(['background false']);
		scheduler.restartBackground();
		scheduler.submit('r', 'model', read(log, 'r'), answer('r'));
		await scheduler.whenIdle();
		expect(bg.starts()).toBe(1);
		expect(log).toEqual(['background false', 'run r', 'answer r']);
	});
});

describe('slices', () => {
	async function busy(tick: number): Promise<number[]> {
		const { host, scheduler, log, answer } = setup(tick);
		host.auto = true;
		scheduler.setOpen(true);
		scheduler.submit('s', 'model', scan(log, 's', 100), answer('s'));
		for (let i = 0; i < 50; i++) scheduler.submit(i, 'model', read(log, `r${i}`), answer(`r${i}`));
		scheduler.setBackground({
			*start() {
				for (let i = 0; i < 40; i++) yield { done: i, total: 40 };
				return true;
			},
			done: () => undefined
		});
		await scheduler.whenIdle();
		return host.slices;
	}

	it(`none exceeds 16 ms, and none but the last is under ${SLICE_TARGET_MS}`, async () => {
		const at3 = await busy(3);
		expect(at3.length).toBeGreaterThan(40);
		expect(new Set(at3)).toEqual(new Set([9]));
		const at1 = await busy(1);
		expect(new Set(at1)).toEqual(new Set([8]));
	});

	it('never splits a transition', async () => {
		const { host, scheduler, log, answer } = setup(3);
		host.auto = true;
		scheduler.setOpen(true);
		scheduler.submit(
			't',
			'model',
			transition(log, 't', () => {
				for (let i = 0; i < 6; i++) host.deps.now();
				log.push(`slices ${host.slices.length}`);
			}),
			answer('t')
		);
		await scheduler.whenIdle();
		expect(log).toEqual(['run t', 'slices 0', 'answer t']);
	});

	it('pause answers undefined inside a slice and a turn once the target has passed', async () => {
		const { host, scheduler } = setup(3);
		expect([scheduler.pause(), scheduler.pause(), scheduler.pause()]).toEqual([
			undefined,
			undefined,
			undefined
		]);
		const wait = scheduler.pause();
		expect(wait).toBeInstanceOf(Promise);
		expect(host.slices).toEqual([9]);
		host.turn();
		await wait;
		expect(scheduler.pause()).toBeUndefined();
	});
});
