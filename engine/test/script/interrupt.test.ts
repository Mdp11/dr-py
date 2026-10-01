import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import {
	beginWindow,
	channelView,
	endWindow,
	flagView,
	INTERRUPT_BYTES,
	raiseAgain,
	stopWindow,
	windowEnded
} from '../../src/script/interrupt.ts';

// The stop channel: the transitions on one thread, and the race between a worker that ends windows
// and a pool that stops them on two real threads.

const FLAG = 0;
const WORD = 1;
const make = () => channelView(new SharedArrayBuffer(INTERRUPT_BYTES));

describe('a window on one thread', () => {
	it('ends untouched: no flag, the word done', () => {
		const ch = make();
		beginWindow(ch, 3);
		endWindow(ch, 3);
		expect(Atomics.load(ch, FLAG)).toBe(0);
		expect(windowEnded(ch, 3)).toBe(true);
		expect(windowEnded(ch, 4)).toBe(false);
	});

	it('is stopped once, and the end of a stopped window clears the flag', () => {
		const ch = make();
		beginWindow(ch, 1);
		expect(stopWindow(ch, 1)).toBe(true);
		expect(Atomics.load(ch, FLAG)).toBe(2);
		// Not stopped twice: the second is a raise again.
		expect(stopWindow(ch, 1)).toBe(false);
		endWindow(ch, 1);
		expect(Atomics.load(ch, FLAG)).toBe(0);
		expect(windowEnded(ch, 1)).toBe(true);
	});

	it('is never stopped after it ended, nor before it began, nor for another window', () => {
		const ch = make();
		expect(stopWindow(ch, 1)).toBe(false);
		beginWindow(ch, 1);
		expect(stopWindow(ch, 2)).toBe(false);
		endWindow(ch, 1);
		expect(stopWindow(ch, 1)).toBe(false);
		expect(raiseAgain(ch, 1)).toBe(false);
		expect(Atomics.load(ch, FLAG)).toBe(0);
	});

	it('is raised again only while stopped and not ended', () => {
		const ch = make();
		beginWindow(ch, 1);
		expect(raiseAgain(ch, 1)).toBe(false);
		expect(stopWindow(ch, 1)).toBe(true);
		// Python took the flag and nothing came of it.
		Atomics.store(ch, FLAG, 0);
		expect(raiseAgain(ch, 1)).toBe(true);
		expect(Atomics.load(ch, FLAG)).toBe(2);
		endWindow(ch, 1);
		expect(Atomics.load(ch, FLAG)).toBe(0);
		expect(raiseAgain(ch, 1)).toBe(false);
		expect(Atomics.load(ch, FLAG)).toBe(0);
	});

	it('clears a flag left over when the next window begins', () => {
		const ch = make();
		beginWindow(ch, 1);
		stopWindow(ch, 1);
		beginWindow(ch, 2);
		expect(Atomics.load(ch, FLAG)).toBe(0);
		expect(stopWindow(ch, 1)).toBe(false);
	});

	it('ends twice without harm, and is not fooled by a word that is not the pool’s', () => {
		const ch = make();
		beginWindow(ch, 1);
		endWindow(ch, 1);
		endWindow(ch, 1);
		expect(windowEnded(ch, 1)).toBe(true);
		beginWindow(ch, 2);
		Atomics.store(ch, WORD, 123456);
		Atomics.store(ch, FLAG, 2);
		endWindow(ch, 2);
		expect(Atomics.load(ch, FLAG)).toBe(0);
		expect(windowEnded(ch, 2)).toBe(true);
	});

	it('refuses a buffer too small for the channel, and gives Pyodide the flag alone', () => {
		expect(() => channelView(new SharedArrayBuffer(4))).toThrow('too small');
		expect(flagView(new SharedArrayBuffer(INTERRUPT_BYTES)).length).toBe(1);
	});
});

describe('a worker ending windows while the pool stops them', () => {
	it('never sees a flag after a window ended, and sees one only in a window the pool stopped', async () => {
		const windows = 20_000;
		const buffer = new SharedArrayBuffer(INTERRUPT_BYTES);
		const ch = channelView(buffer);
		const worker = new Worker(new URL('./fixtures/window-worker.ts', import.meta.url), {
			workerData: { buffer, windows }
		});
		const finished = new Promise<{ interrupted: number[]; leaks: number }>((resolve, reject) => {
			worker.once('message', resolve);
			worker.once('error', reject);
		});
		const stops = new Set<number>();
		let over = false;
		void finished.then(() => (over = true));
		let seed = 99;
		const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		for (let spin = 0; !over; spin++) {
			const word = Atomics.load(ch, WORD);
			if (word > 0) {
				const n = Math.floor((word - 1) / 4);
				const phase = (word - 1) % 4;
				if (phase === 0 && random() < 0.4 && stopWindow(ch, n)) stops.add(n);
				else if (phase === 2 && random() < 0.4) raiseAgain(ch, n);
			}
			if (spin % 2000 === 0) await new Promise((resolve) => setImmediate(resolve));
		}
		const result = await finished;
		await worker.terminate();
		expect(result.leaks).toBe(0);
		expect(stops.size).toBeGreaterThan(50);
		expect(result.interrupted.length).toBeGreaterThan(0);
		for (const n of result.interrupted) expect(stops.has(n), `window ${n}`).toBe(true);
		expect(Atomics.load(ch, WORD)).toBeGreaterThanOrEqual(4 * windows);
	}, 60_000);
});
