// A thread that runs windows against an interrupt channel the way a script worker does: it polls
// the flag like Python's eval loop, and between windows runs code that must never see a flag.
import { parentPort, workerData } from 'node:worker_threads';
import { beginWindow, channelView, endWindow } from '../../../src/script/interrupt.ts';

const { buffer, windows } = workerData as { buffer: SharedArrayBuffer; windows: number };
const channel = channelView(buffer);

/** The windows in which the flag was seen, and the flags seen after a window ended. */
const interrupted: number[] = [];
let leaks = 0;
let seed = 12345;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

for (let n = 1; n <= windows; n++) {
	beginWindow(channel, n);
	const work = Math.floor(random() * 400);
	for (let step = 0; step < work; step++) {
		if (Atomics.load(channel, 0) === 2) {
			// What Python does: read the flag, reset it, and raise in the code that runs.
			Atomics.store(channel, 0, 0);
			interrupted.push(n);
			break;
		}
	}
	endWindow(channel, n);
	for (let step = 0; step < 300; step++) if (Atomics.load(channel, 0) === 2) leaks++;
}
parentPort?.postMessage({ interrupted, leaks });
