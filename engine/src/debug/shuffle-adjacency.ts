import type { Model } from '../model/model.ts';
import type { RelRec } from '../model/records.ts';

function shuffle(list: RelRec[], at: 'outAt' | 'inAt', random: () => number): void {
	for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const swapped = list[i]!;
		list[i] = list[j]!;
		list[j] = swapped;
	}
	list.forEach((rel, i) => (rel[at] = i));
}

/**
 * Reorders every element's `out` and `in` arrays. Their order is unspecified,
 * so nothing observable may change: a test that shuffles between steps exposes
 * code that leans on it. `random` returns a number in [0, 1).
 */
export function shuffleAdjacency(model: Model, random: () => number): void {
	for (const element of model.elements()) {
		shuffle(element.out, 'outAt', random);
		shuffle(element.in, 'inAt', random);
	}
}
