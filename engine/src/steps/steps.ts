/** Where a long operation stands. */
export type Progress = { done: number; total: number };

/**
 * A long operation cut into steps: each `yield` ends one, about a millisecond
 * of work, and says where the operation stands. It publishes nothing before
 * its last step, so a caller may abandon it at any yield and leave no trace.
 */
export type Steps<T> = Generator<Progress, T, void>;

/** Runs every step and returns the operation's value. */
export function drain<T>(steps: Steps<T>): T {
	for (;;) {
		const next = steps.next();
		if (next.done === true) return next.value;
	}
}

/**
 * A stable bottom-up merge sort in steps: runs of `run` items sorted natively,
 * one step each, then passes that merge neighbouring runs into a second
 * buffer, a step every `run` items written. The order is the one
 * `Array.prototype.sort` gives with the same comparator. The result is the
 * input or the buffer: use it and drop the input.
 */
export function* sortedInSlices<T>(
	items: T[],
	compare: (a: T, b: T) => number,
	run = 2048
): Steps<T[]> {
	const n = items.length;
	let passes = 0;
	for (let width = run; width < n; width *= 2) passes++;
	const total = n * (1 + passes);
	let done = 0;
	for (let start = 0; start < n; start += run) {
		const sorted = items.slice(start, start + run).sort(compare);
		for (let i = 0; i < sorted.length; i++) items[start + i] = sorted[i]!;
		done += sorted.length;
		yield { done, total };
	}
	let source = items;
	let target: T[] = new Array<T>(n);
	for (let width = run; width < n; width *= 2) {
		let written = 0;
		for (let lo = 0; lo < n; lo += 2 * width) {
			const mid = Math.min(lo + width, n);
			const hi = Math.min(lo + 2 * width, n);
			let i = lo;
			let j = mid;
			for (let k = lo; k < hi; k++) {
				// On a tie the left run's item goes first: the sort is stable.
				if (i < mid && (j >= hi || compare(source[j]!, source[i]!) >= 0)) target[k] = source[i++]!;
				else target[k] = source[j++]!;
				if (++written === run) {
					done += written;
					written = 0;
					yield { done, total };
				}
			}
		}
		if (written > 0) {
			done += written;
			yield { done, total };
		}
		[source, target] = [target, source];
	}
	return source;
}
