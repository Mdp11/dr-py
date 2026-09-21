import type { Model } from '../model/model.ts';
import { nameOf } from '../model/naming.ts';
import type { ElementRec } from '../model/records.ts';
import { sortedInSlices, type Steps } from '../steps/steps.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyLower } from '../value/lower.ts';
import type { ElementPage } from './elements.ts';
import { wireElement } from './wire.ts';

// Elements scored per step.
const SCAN_STEP = 512;

/** Python's `len`: a string's length in code points. */
function cpLength(text: string): number {
	let n = text.length;
	for (let i = 0; i < text.length - 1; i++) {
		const unit = text.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				n--;
				i++;
			}
		}
	}
	return n;
}

function isWordChar(unit: number): boolean {
	return (unit >= 0x61 && unit <= 0x7a) || (unit >= 0x30 && unit <= 0x39);
}

/**
 * The tier of a lowered name against the query: exact 1000, prefix 100, an
 * occurrence with no `[a-z0-9]` on either side 30, any occurrence 10, else 0.
 * Every occurrence is tried, overlapping ones included, as the route's
 * `re.search` tries every start.
 */
export function nameScore(lowered: string, query: string): number {
	if (lowered === query) return 1000;
	if (lowered.startsWith(query)) return 100;
	let at = lowered.indexOf(query);
	if (at < 0) return 0;
	for (; at >= 0; at = lowered.indexOf(query, at + 1)) {
		const end = at + query.length;
		const before = at === 0 || !isWordChar(lowered.charCodeAt(at - 1));
		const after = end === lowered.length || !isWordChar(lowered.charCodeAt(end));
		if (before && after) return 30;
	}
	return 10;
}

/**
 * The relevance of one element to a stripped, lowered, non-empty query, the
 * route's additions in the route's order so that equal scores are equal
 * doubles: the name tier with its length bias, then the id, the type, and
 * every other string property.
 */
export function searchScore(element: ElementRec, query: string, typeMatches: boolean): number {
	let score = 0;
	const name = nameOf(element);
	if (name !== null) {
		const lowered = pyLower(name);
		const tier = nameScore(lowered, query);
		if (tier > 0) score += tier + cpLength(query) / cpLength(lowered);
	}
	const idLower = pyLower(element.id);
	if (idLower === query) score += 5;
	else if (idLower.includes(query)) score += 2;
	if (typeMatches) score += 1;
	const props = element.props;
	for (const key of Object.keys(props)) {
		if (pyLower(key) === 'name') continue;
		const value = props[key];
		if (typeof value === 'string' && pyLower(value).includes(query)) score += 0.5;
	}
	return score;
}

type Hit = { score: number; element: ElementRec };

const byRank = (a: Hit, b: Hit) =>
	a.score > b.score ? -1 : a.score < b.score ? 1 : cmpCodePoint(a.element.id, b.element.id);

/**
 * `GET /model/elements?q=` in steps: every element in state order scored, a
 * step every 512, then the hits sorted by `(-score, id)` in steps of their
 * own and the page cut. `total` counts every hit. Nothing is kept between
 * pages.
 */
export function* searchSteps(
	model: Model,
	{
		type,
		query,
		limit,
		offset
	}: { type: string | null; query: string; limit: number; offset: number }
): Steps<ElementPage> {
	const total = model.elementCount + 1;
	const typeMatches = new Map<string, boolean>();
	const hits: Hit[] = [];
	let done = 0;
	for (const element of model.elements()) {
		if (type === null || element.typeName === type) {
			let matches = typeMatches.get(element.typeName);
			if (matches === undefined) {
				matches = pyLower(element.typeName).includes(query);
				typeMatches.set(element.typeName, matches);
			}
			const score = searchScore(element, query, matches);
			if (score > 0) hits.push({ score, element });
		}
		if (++done % SCAN_STEP === 0) yield { done, total };
	}
	const sort = sortedInSlices(hits, byRank);
	let next = sort.next();
	for (; next.done !== true; next = sort.next()) yield { done: total - 1, total };
	yield { done: total, total };
	const page = next.value.slice(offset, offset + limit);
	return { items: page.map(({ element }) => wireElement(element)), total: hits.length };
}
