import type { ModelOut } from '$lib/api/types';

export interface ComparePair {
	from: ModelOut;
	to: ModelOut;
	fromFilename: string | null;
}

export function comparePair(
	loaded: ModelOut,
	loadedFilename: string | null,
	other: ModelOut,
	otherFilename: string | null,
	swapped: boolean
): ComparePair {
	if (swapped) {
		return { from: other, to: loaded, fromFilename: otherFilename };
	}
	return { from: loaded, to: other, fromFilename: loadedFilename };
}
