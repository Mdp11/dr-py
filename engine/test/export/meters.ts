/** Meters at the two extremes of a step's budget, and a drain that counts steps. */
import { Meter, type Steps } from '../../src/index.ts';

/** Ends a step at every unit. */
export class EveryUnit extends Meter {
	override tick(): boolean {
		super.tick();
		return true;
	}
}

/** Never ends a step: the whole operation is one. */
export class NoEnd extends Meter {
	override tick(): boolean {
		super.tick();
		return false;
	}
}

/** Runs every step: the operation's value and how many steps ended before it. */
export function counted<T>(steps: Steps<T>): { value: T; yields: number } {
	let yields = 0;
	for (;;) {
		const next = steps.next();
		if (next.done === true) return { value: next.value, yields };
		yields++;
	}
}
