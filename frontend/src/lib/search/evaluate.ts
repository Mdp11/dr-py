import type { Element, Relationship } from '$lib/api/types';
import type { AdvancedQuery, Criterion, Direction, SearchModel, SearchResultItem } from './types';

interface RelIndex {
	outgoing: Map<string, Relationship[]>; // keyed by source_id
	incoming: Map<string, Relationship[]>; // keyed by target_id
}

interface Ctx {
	relIndex: RelIndex;
	elementsById: Map<string, Element>;
}

export function isValidRegex(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

function safeRegexTest(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern).test(value);
	} catch {
		return false;
	}
}

function pushTo(map: Map<string, Relationship[]>, key: string, r: Relationship): void {
	const arr = map.get(key);
	if (arr) arr.push(r);
	else map.set(key, [r]);
}

function buildRelIndex(rels: Relationship[]): RelIndex {
	const outgoing = new Map<string, Relationship[]>();
	const incoming = new Map<string, Relationship[]>();
	for (const r of rels) {
		pushTo(outgoing, r.source_id, r);
		pushTo(incoming, r.target_id, r);
	}
	return { outgoing, incoming };
}

function relationsFor(index: RelIndex, elementId: string, direction: Direction): Relationship[] {
	if (direction === 'outgoing') return index.outgoing.get(elementId) ?? [];
	if (direction === 'incoming') return index.incoming.get(elementId) ?? [];
	return [...(index.outgoing.get(elementId) ?? []), ...(index.incoming.get(elementId) ?? [])];
}

function otherEndpoint(r: Relationship, elementId: string): string {
	return r.source_id === elementId ? r.target_id : r.source_id;
}

function entityName(props: Record<string, unknown>): string {
	const n = props?.name;
	return typeof n === 'string' ? n : '';
}

function matchEntityType(typeName: string, names: string[]): boolean {
	return names.length === 0 ? true : names.includes(typeName);
}

function matchProperty(props: Record<string, unknown>, c: Extract<Criterion, { type: 'property' }>): boolean {
	const raw = props ? props[c.name] : undefined;
	switch (c.op) {
		case 'exists':
			return raw !== undefined && raw !== null && raw !== '';
		case 'is_empty':
			return raw === undefined || raw === null || raw === '';
		case 'equals':
			return String(raw ?? '') === c.value;
		case 'not_equals':
			return String(raw ?? '') !== c.value;
		case 'contains':
			return String(raw ?? '')
				.toLowerCase()
				.includes(c.value.toLowerCase());
		case 'matches':
			return safeRegexTest(c.value, String(raw ?? ''));
		case 'gt':
		case 'lt':
		case 'gte':
		case 'lte': {
			const lhs = Number(raw);
			const rhs = Number(c.value);
			if (Number.isNaN(lhs) || Number.isNaN(rhs)) return false;
			if (c.op === 'gt') return lhs > rhs;
			if (c.op === 'lt') return lhs < rhs;
			if (c.op === 'gte') return lhs >= rhs;
			return lhs <= rhs;
		}
	}
}

function matchNameId(
	subjectName: string,
	subjectId: string,
	c: Extract<Criterion, { type: 'name_id' }>
): boolean {
	const subject = c.field === 'name' ? subjectName : subjectId;
	switch (c.op) {
		case 'contains':
			return subject.toLowerCase().includes(c.value.toLowerCase());
		case 'equals':
			return subject === c.value;
		case 'matches':
			return safeRegexTest(c.value, subject);
	}
}

function matchElement(e: Element, c: Criterion, ctx: Ctx): boolean {
	switch (c.type) {
		case 'entity_type':
			return matchEntityType(e.type_name, c.names);
		case 'property':
			return matchProperty(e.properties, c);
		case 'name_id':
			return matchNameId(entityName(e.properties), e.id, c);
		case 'relation_count': {
			const rels = relationsFor(ctx.relIndex, e.id, c.direction);
			const filtered = c.relTypes.length === 0 ? rels : rels.filter((r) => c.relTypes.includes(r.type_name));
			const n = filtered.length;
			if (c.op === 'at_least') return n >= c.count;
			if (c.op === 'at_most') return n <= c.count;
			return n === c.count;
		}
		case 'orphan':
			return relationsFor(ctx.relIndex, e.id, 'either').length === 0;
		case 'connected_to_type': {
			const rels = relationsFor(ctx.relIndex, e.id, c.direction);
			return rels.some((r) => {
				const other = ctx.elementsById.get(otherEndpoint(r, e.id));
				return other != null && c.names.includes(other.type_name);
			});
		}
		default:
			// relationship-only criterion on an element query: skip (no-op).
			return true;
	}
}

function matchRelationship(r: Relationship, c: Criterion, ctx: Ctx): boolean {
	switch (c.type) {
		case 'entity_type':
			return matchEntityType(r.type_name, c.names);
		case 'property':
			return matchProperty(r.properties, c);
		case 'name_id':
			return matchNameId(entityName(r.properties), r.id, c);
		case 'endpoint_type': {
			const endId = c.endpoint === 'source' ? r.source_id : r.target_id;
			const el = ctx.elementsById.get(endId);
			return el != null && c.names.includes(el.type_name);
		}
		default:
			// element-only criterion on a relationship query: skip (no-op).
			return true;
	}
}

/** Run an advanced query against a working-model snapshot. Pure. */
export function runQuery(query: AdvancedQuery, model: SearchModel): SearchResultItem[] {
	const ctx: Ctx = {
		relIndex: buildRelIndex(model.relationships),
		elementsById: new Map(model.elements.map((e) => [e.id, e]))
	};
	if (query.target === 'element') {
		return model.elements
			.filter((e) => query.criteria.every((c) => matchElement(e, c, ctx)))
			.map((e) => ({ kind: 'element' as const, id: e.id }));
	}
	return model.relationships
		.filter((r) => query.criteria.every((c) => matchRelationship(r, c, ctx)))
		.map((r) => ({ kind: 'relationship' as const, id: r.id }));
}
