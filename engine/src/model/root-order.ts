import { drain, sortedInSlices, type Steps } from '../steps/steps.ts';
import { cmpCodePoint } from '../value/compare.ts';
import type { ElementRec } from './records.ts';

/**
 * Containment roots sorted by `(display name, id)`, both by code point. Each
 * root carries the name it is filed under (`rootName`): after a rename the
 * old name is gone from its properties, and it is what finds the old slot.
 */
export class RootOrder {
	private recs: ElementRec[] = [];

	get size(): number {
		return this.recs.length;
	}

	/** The roots in order. Live — do not mutate. */
	list(): readonly ElementRec[] {
		return this.recs;
	}

	/** The first slot whose root does not sort before `(name, id)`. */
	private slot(name: string, id: string): number {
		let lo = 0;
		let hi = this.recs.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const other = this.recs[mid]!;
			const order = cmpCodePoint(other.rootName!, name) || cmpCodePoint(other.id, id);
			if (order < 0) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	add(element: ElementRec, name: string): void {
		element.rootName = name;
		this.recs.splice(this.slot(name, element.id), 0, element);
	}

	/** No-op for an element that is not filed as a root. */
	remove(element: ElementRec): void {
		if (element.rootName === null) return;
		const at = this.slot(element.rootName, element.id);
		if (this.recs[at] !== element) throw new Error(`root order lost ${element.id}`);
		this.recs.splice(at, 1);
		element.rootName = null;
	}

	/** Replaces the content with `roots`, whose `rootName`s are already set. */
	reset(roots: ElementRec[]): void {
		drain(this.resetSteps(roots));
	}

	/** `reset` in steps; the order changes at the last one. */
	*resetSteps(roots: ElementRec[]): Steps<void> {
		this.recs = yield* sortedInSlices(
			roots,
			(a, b) => cmpCodePoint(a.rootName!, b.rootName!) || cmpCodePoint(a.id, b.id)
		);
	}
}
