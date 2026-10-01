// The stop channel between the pool and a script worker: one SharedArrayBuffer of two Int32.
//
//   [0] Pyodide's interrupt flag: Python raises `KeyboardInterrupt` where it runs bytecode once it
//       reads 2, and resets the flag itself.
//   [1] the window the worker is in, and whether the pool stopped it.
//
// A window is the stretch of a batch in which a script's code runs: the module-level code of an
// embedded run (window 0) and each call (window i + 1). The worker marks a window's start and end
// and the pool stops a window; both move the word by compare-and-swap, so exactly one of "the
// worker ended it" and "the pool stopped it" happens, and a flag is never stored after its window
// ended (it would hit the next call). The word for window n:
//
//   4n + 1 running   4n + 2 stopping (the pool holds the word and is storing its flag)
//   4n + 3 stopped   4n + 4 done
//
// The pool moves running -> stopping -> stopped, storing the flag between, with no wait; it may
// raise again, stopped -> stopping -> stopped, for an interrupt that was not taken. A worker ends a window by moving running -> done, or, for a stopped one, stopped -> done and then clearing
// the flag (no raise can start once it is done, and one that finished before left its flag to be
// cleared); when the word is `stopping` it waits for `stopped` and tries again. So a flag is never
// left for the next call, and the pool knows which calls it stopped. What a script does to this
// buffer changes only its own batch: the pool arms its hard stop whether or not a soft stop won.

const FLAG = 0;
const WINDOW = 1;
const INTERRUPT = 2;
// A worker waits at most this long for the pool's flag store, which takes microseconds, and gives
// up on a pool that keeps raising after this many rounds.
const WAIT_SLICE_MS = 100;
const WAIT_SLICES = 10;
const ROUNDS = 64;

/** Bytes of the interrupt buffer. */
export const INTERRUPT_BYTES = 8;

const running = (n: number) => 4 * n + 1;
const stopping = (n: number) => 4 * n + 2;
const stopped = (n: number) => 4 * n + 3;
const done = (n: number) => 4 * n + 4;

/** The view Pyodide reads: its flag only. */
export const flagView = (buffer: SharedArrayBuffer) => new Int32Array(buffer, 0, 1);

/** The whole channel. */
export function channelView(buffer: SharedArrayBuffer): Int32Array {
	if (buffer.byteLength < INTERRUPT_BYTES) throw new Error('the interrupt buffer is too small');
	return new Int32Array(buffer, 0, INTERRUPT_BYTES / 4);
}

/** Worker side: window `n` starts. A flag left over from before is cleared first. */
export function beginWindow(channel: Int32Array, n: number): void {
	Atomics.store(channel, FLAG, 0);
	Atomics.store(channel, WINDOW, running(n));
}

/**
 * Worker side: window `n` ends. When the pool stopped it, clears the flag once the pool is not
 * raising it, so nothing is left to hit the next window. Safe to call twice.
 */
export function endWindow(channel: Int32Array, n: number): void {
	for (let round = 0; round < ROUNDS; round++) {
		const was = Atomics.compareExchange(channel, WINDOW, running(n), done(n));
		if (was === running(n) || was === done(n)) return;
		if (was === stopping(n)) {
			// No clock: a worker's `Date.now` is pinned.
			for (
				let slice = 0;
				slice < WAIT_SLICES && Atomics.load(channel, WINDOW) === stopping(n);
				slice++
			) {
				Atomics.wait(channel, WINDOW, stopping(n), WAIT_SLICE_MS);
			}
		} else if (was === stopped(n)) {
			// Once done, no raise can start, so the flag a finished raise left is cleared for good.
			if (Atomics.compareExchange(channel, WINDOW, stopped(n), done(n)) === stopped(n)) {
				Atomics.store(channel, FLAG, 0);
				return;
			}
		} else break;
	}
	// A word that is none of these is not the pool's.
	Atomics.store(channel, FLAG, 0);
	Atomics.store(channel, WINDOW, done(n));
}

/**
 * Pool side: raises the interrupt for window `n` if the worker is still in it. `false` means the
 * window already ended (or never began), and nothing was raised.
 */
export function stopWindow(channel: Int32Array, n: number): boolean {
	return raise(channel, n, running(n));
}

/**
 * Pool side: raises the interrupt again for window `n`, which the pool stopped and the worker has
 * not ended; the first one can go unseen. `false` when the window ended: nothing was raised.
 */
export function raiseAgain(channel: Int32Array, n: number): boolean {
	return raise(channel, n, stopped(n));
}

function raise(channel: Int32Array, n: number, from: number): boolean {
	if (Atomics.compareExchange(channel, WINDOW, from, stopping(n)) !== from) return false;
	Atomics.store(channel, FLAG, INTERRUPT);
	Atomics.store(channel, WINDOW, stopped(n));
	Atomics.notify(channel, WINDOW);
	return true;
}

/**
 * Pool side: the worker has ended window `n` (and may have begun the next) and its `call-end` is on
 * its way. A script can forge this, so it buys at most one more grace period.
 */
export function windowEnded(channel: Int32Array, n: number): boolean {
	// Words grow with the window, so a later window's state says `n` ended too.
	return Atomics.load(channel, WINDOW) >= done(n);
}
