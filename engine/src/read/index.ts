import type { Model } from '../model/model.ts';
import type { Steps } from '../steps/steps.ts';
import {
	getElement,
	getElementsBatch,
	getModelSummary,
	listElementRelationships,
	listElementsPage,
	searchQuery
} from './elements.ts';
import type { ReadParams } from './params.ts';
import type { ViewPlacements } from './placements.ts';

/**
 * A read surface: the response body of the route it stands for, at once or
 * as steps. It reads the model and nothing else, and changes nothing.
 */
export type Read = (
	model: Model,
	placements: ViewPlacements,
	params: ReadParams
) => unknown | Steps<unknown>;

/** Every read, by the name of the `lib/api` function it answers for. */
export const READS: { readonly [method: string]: Read } = {
	getElement,
	getElementsBatch,
	listElementsPage,
	listElementRelationships,
	getModelSummary
};

/** Whether a read with these params runs in steps: the scheduler holds a scan to other rules. */
export function readScans(method: string, params: ReadParams): boolean {
	if (method !== 'listElementsPage') return false;
	try {
		return searchQuery(params) !== '';
	} catch {
		return false;
	}
}
