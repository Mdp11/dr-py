import type { Model } from '../model/model.ts';
import { cmpCodePoint } from '../value/compare.ts';
import type { Steps } from '../steps/steps.ts';
import { pyLower, pyStrip } from '../value/lower.ts';
import { directionOf, idOf, idsOf, optionalString, pageOf, type ReadParams } from './params.ts';
import type { ViewPlacements } from './placements.ts';
import { searchSteps } from './search.ts';
import { wireElement, wireRelationship, type WireElement, type WireRelationship } from './wire.ts';

export type ElementPage = { items: WireElement[]; total: number };
export type RelationshipPage = { items: WireRelationship[]; total: number };

export type ModelSummary = {
	model_rev: number;
	element_count: number;
	relationship_count: number;
	elements_by_type: { [typeName: string]: number };
	issue_counts: null;
	undo_depth: number;
};

/** `GET /model/elements/{id}`; an unknown id is the model's `KeyError`. */
export function getElement(model: Model, _: ViewPlacements, params: ReadParams): WireElement {
	return wireElement(model.getElement(idOf(params)));
}

/** `POST /model/elements/batch`: request order, duplicates kept, unknown ids left out. */
export function getElementsBatch(
	model: Model,
	_: ViewPlacements,
	params: ReadParams
): { items: WireElement[] } {
	const items: WireElement[] = [];
	for (const id of idsOf(params)) {
		const element = model.findElement(id);
		if (element !== undefined) items.push(wireElement(element));
	}
	return { items };
}

/** The query a listing searches by; `''` when there is none. */
export function searchQuery(params: ReadParams): string {
	return pyStrip(optionalString(params, 'q') ?? '');
}

/**
 * `GET /model/elements`: state order, an exact-type filter, `total` counted
 * before the page. With a query that is not blank, a search in steps.
 */
export function listElementsPage(
	model: Model,
	_: ViewPlacements,
	params: ReadParams
): ElementPage | Steps<ElementPage> {
	const type = optionalString(params, 'type');
	const { limit, offset } = pageOf(params);
	const query = pyLower(searchQuery(params));
	if (query !== '') return searchSteps(model, { type, query, limit, offset });
	const total = type === null ? model.elementCount : (model.indexes.byType.get(type)?.size ?? 0);
	const items: WireElement[] = [];
	if (offset >= total) return { items, total };
	let skipped = 0;
	for (const element of model.elements()) {
		if (type !== null && element.typeName !== type) continue;
		if (skipped < offset) {
			skipped++;
			continue;
		}
		items.push(wireElement(element));
		if (items.length >= limit) break;
	}
	return { items, total };
}

/**
 * `GET /model/elements/{id}/relationships`: sorted by id, a self-loop once
 * in `both`, `total` counted before the page.
 */
export function listElementRelationships(
	model: Model,
	_: ViewPlacements,
	params: ReadParams
): RelationshipPage {
	const direction = directionOf(params);
	const { limit, offset } = pageOf(params);
	const element = model.getElement(idOf(params));
	const rels = new Set(
		direction === 'out'
			? element.out
			: direction === 'in'
				? element.in
				: [...element.out, ...element.in]
	);
	const sorted = [...rels].sort((a, b) => cmpCodePoint(a.id, b.id));
	return { items: sorted.slice(offset, offset + limit).map(wireRelationship), total: rels.size };
}

/** `GET /model/summary`; `model_rev` is the caller's, the issue counts are the server's to give. */
export function getModelSummary(model: Model, _: ViewPlacements, params: ReadParams): ModelSummary {
	const byType: { [typeName: string]: number } = {};
	const names = [...model.indexes.byType.keys()].sort(cmpCodePoint);
	for (const name of names) {
		Object.defineProperty(byType, name, {
			value: model.indexes.byType.get(name)!.size,
			writable: true,
			enumerable: true,
			configurable: true
		});
	}
	const rev = params['model_rev'];
	return {
		model_rev: typeof rev === 'number' ? rev : 0,
		element_count: model.elementCount,
		relationship_count: model.relationshipCount,
		elements_by_type: byType,
		issue_counts: null,
		undo_depth: 0
	};
}
