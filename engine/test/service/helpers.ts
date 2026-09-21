import type { HostDeps } from '../../src/index.ts';

/**
 * A host with a clock that moves `tick` ms per `now()` call. A yield records
 * the slice it ends — the time from the first `now()` after the previous turn
 * to the last one before it — and resolves on `turn()`, or on the next
 * macrotask when `auto` is set.
 */
export function fakeHost({ tick }: { tick: number }) {
	let clock = 0;
	let start: number | null = null;
	let last = 0;
	const waiting: (() => void)[] = [];
	const host = {
		slices: [] as number[],
		auto: false,
		deps: {
			now: () => {
				const value = clock;
				clock += tick;
				start ??= value;
				last = value;
				return value;
			},
			yieldToHost: () => {
				host.slices.push(last - (start ?? last));
				start = null;
				return new Promise<void>((resolve) => {
					if (host.auto) setImmediate(resolve);
					else waiting.push(resolve);
				});
			}
		} satisfies HostDeps,
		/** Ends the pending host turns. */
		turn: () => {
			for (const resolve of waiting.splice(0)) resolve();
		},
		get waiting(): number {
			return waiting.length;
		}
	};
	return host;
}

/** Lets every pending microtask and macrotask run. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
