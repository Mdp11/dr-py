import type { EvalContext } from '../evaluate/index.ts';
import type { ElementRec, RelRec } from '../model/records.ts';
import { ReadError } from '../read/errors.ts';
import { MAX_PAGE_LIMIT, pageOf, type ReadParams } from '../read/params.ts';
import {
	wireElement,
	wireRelationship,
	type WireElement,
	type WireRelationship
} from '../read/wire.ts';
import type { Steps } from '../steps/steps.ts';
import {
	compileCriteria,
	matchElement,
	matchRelationship,
	readCriteria,
	type Criterion
} from './criteria.ts';

/** `POST /model/search`'s body: the page of the one target, `total` counted before paging. */
export type SearchResultPage = {
	target: 'element' | 'relationship';
	elements: WireElement[];
	relationships: WireRelationship[];
	total: number;
};

// Entities matched per step.
const SCAN_STEP = 512;

/**
 * `POST /model/search` in steps: every entity of the target in state order,
 * matched against every criterion in order, a step every 512; the page is cut
 * after matching. The params are read and every pattern translated before
 * the first step, so a refusal (422, 501) happens before any work.
 */
export function searchModel(ctx: EvalContext, params: ReadParams): Steps<SearchResultPage> {
	const target = params['target'];
	if (target !== 'element' && target !== 'relationship') {
		throw new ReadError(422, "target must be 'element' or 'relationship'");
	}
	const raw = params['criteria'];
	const criteria = raw === undefined ? [] : readCriteria(raw, 'criteria');
	const { limit, offset } = pageOf(params, MAX_PAGE_LIMIT);
	const compiled = compileCriteria(criteria);
	const { model } = ctx;

	function* scan<T extends ElementRec | RelRec>(
		entities: Iterable<T>,
		count: number,
		matches: (entity: T, c: Criterion) => boolean
	): Steps<T[]> {
		const total = count + 1;
		const hits: T[] = [];
		let done = 0;
		for (const entity of entities) {
			if (criteria.every((c) => matches(entity, c))) hits.push(entity);
			if (++done % SCAN_STEP === 0) yield { done, total };
		}
		yield { done: total, total };
		return hits;
	}

	return (function* (): Steps<SearchResultPage> {
		if (target === 'element') {
			const hits = yield* scan(model.elements(), model.elementCount, (element, c) =>
				matchElement(model, element, c, compiled)
			);
			return {
				target,
				elements: hits.slice(offset, offset + limit).map(wireElement),
				relationships: [],
				total: hits.length
			};
		}
		const hits = yield* scan(model.relationships(), model.relationshipCount, (rel, c) =>
			matchRelationship(model, rel, c, compiled)
		);
		return {
			target,
			elements: [],
			relationships: hits.slice(offset, offset + limit).map(wireRelationship),
			total: hits.length
		};
	})();
}
