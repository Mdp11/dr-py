/**
 * The entity-filter vocabulary of `core/search/criteria.py`: the criterion
 * shapes, their reader, and the matchers, line for line. Type names compare
 * exactly — a subtype is not its parent — and values coerce through Python's
 * `str()` and `float()` (`jsStr`, `toNumber`).
 */
import type { Model } from '../model/model.ts';
import { getProp, type ElementRec, type Props, type RelRec } from '../model/records.ts';
import { ReadError } from '../read/errors.ts';
import { jsStr, toNumber } from '../value/coerce.ts';
import { pyLower } from '../value/lower.ts';
import { translatePyRegex } from '../value/regex.ts';
import type { Value } from '../value/types.ts';

export type CriterionDirection = 'outgoing' | 'incoming' | 'either';

export type PropertyOp =
	| 'equals'
	| 'not_equals'
	| 'contains'
	| 'matches'
	| 'gt'
	| 'lt'
	| 'gte'
	| 'lte'
	| 'exists'
	| 'is_empty';

export type EntityTypeCriterion = { type: 'entity_type'; names: string[] };
export type PropertyCriterion = {
	type: 'property';
	name: string;
	datatype: string | null;
	op: PropertyOp;
	value: string;
};
export type NameIdCriterion = {
	type: 'name_id';
	field: 'name' | 'id';
	op: 'contains' | 'equals' | 'matches';
	value: string;
};
export type RelationCountCriterion = {
	type: 'relation_count';
	op: 'at_least' | 'at_most' | 'exactly';
	count: number;
	direction: CriterionDirection;
	rel_types: string[];
};
export type OrphanCriterion = { type: 'orphan' };
export type ConnectedToTypeCriterion = {
	type: 'connected_to_type';
	direction: CriterionDirection;
	names: string[];
};
export type EndpointTypeCriterion = {
	type: 'endpoint_type';
	endpoint: 'source' | 'target';
	names: string[];
};

/** Every criterion but the group: the only members a group may hold. */
export type LeafCriterion =
	| EntityTypeCriterion
	| PropertyCriterion
	| NameIdCriterion
	| RelationCountCriterion
	| OrphanCriterion
	| ConnectedToTypeCriterion
	| EndpointTypeCriterion;

/** OR over leaves. An empty group matches everything: it is a transient editing state. */
export type AnyOfCriterion = { type: 'any_of'; criteria: LeafCriterion[] };

export type Criterion = LeafCriterion | AnyOfCriterion;

// -- reading -------------------------------------------------------------------

const LEAF_TYPES = [
	'entity_type',
	'property',
	'name_id',
	'relation_count',
	'orphan',
	'connected_to_type',
	'endpoint_type'
] as const;
const PROPERTY_OPS: readonly PropertyOp[] = [
	'equals',
	'not_equals',
	'contains',
	'matches',
	'gt',
	'lt',
	'gte',
	'lte',
	'exists',
	'is_empty'
];
const DIRECTIONS: readonly CriterionDirection[] = ['outgoing', 'incoming', 'either'];

type Doc = { readonly [key: string]: unknown };

const isDoc = (value: unknown): value is Doc =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function refuse(where: string, message: string): never {
	throw new ReadError(422, `${where}: ${message}`);
}

// An absent key takes the default; a `null` does not, as pydantic has it.
const field = (doc: Doc, key: string, fallback?: unknown): unknown =>
	Object.hasOwn(doc, key) && doc[key] !== undefined ? doc[key] : fallback;

function str(doc: Doc, key: string, where: string, fallback?: string): string {
	const value = field(doc, key, fallback);
	if (typeof value !== 'string') refuse(`${where}.${key}`, 'must be a string');
	return value;
}

function oneOf<T extends string>(doc: Doc, key: string, where: string, options: readonly T[]): T {
	const value = field(doc, key);
	if (!options.includes(value as T)) {
		refuse(`${where}.${key}`, `must be one of ${options.join(', ')}`);
	}
	return value as T;
}

function names(doc: Doc, key: string, where: string): string[] {
	const value = field(doc, key, []);
	if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
		refuse(`${where}.${key}`, 'must be a list of strings');
	}
	return [...(value as string[])];
}

function readLeaf(doc: Doc, type: LeafCriterion['type'], where: string): LeafCriterion {
	switch (type) {
		case 'entity_type':
			return { type, names: names(doc, 'names', where) };
		case 'property': {
			const name = str(doc, 'name', where);
			const datatype = field(doc, 'datatype', null);
			if (datatype !== null && typeof datatype !== 'string') {
				refuse(`${where}.datatype`, 'must be a string or null');
			}
			const op = oneOf(doc, 'op', where, PROPERTY_OPS);
			return { type, name, datatype, op, value: str(doc, 'value', where, '') };
		}
		case 'name_id': {
			const which = oneOf(doc, 'field', where, ['name', 'id'] as const);
			const op = oneOf(doc, 'op', where, ['contains', 'equals', 'matches'] as const);
			return { type, field: which, op, value: str(doc, 'value', where, '') };
		}
		case 'relation_count': {
			const op = oneOf(doc, 'op', where, ['at_least', 'at_most', 'exactly'] as const);
			const count = field(doc, 'count');
			if (typeof count !== 'number' || !Number.isInteger(count)) {
				refuse(`${where}.count`, 'must be an integer');
			}
			const direction = oneOf(doc, 'direction', where, DIRECTIONS);
			// pydantic's `populate_by_name`: the alias wins when both are given.
			const key = field(doc, 'relTypes') === undefined ? 'rel_types' : 'relTypes';
			return { type, op, count, direction, rel_types: names(doc, key, where) };
		}
		case 'orphan':
			return { type };
		case 'connected_to_type':
			return {
				type,
				direction: oneOf(doc, 'direction', where, DIRECTIONS),
				names: names(doc, 'names', where)
			};
		case 'endpoint_type':
			return {
				type,
				endpoint: oneOf(doc, 'endpoint', where, ['source', 'target'] as const),
				names: names(doc, 'names', where)
			};
	}
}

function readCriterion(raw: unknown, where: string): Criterion {
	if (!isDoc(raw)) refuse(where, 'must be an object');
	const type = oneOf(raw, 'type', where, [...LEAF_TYPES, 'any_of'] as const);
	if (type !== 'any_of') return readLeaf(raw, type, where);
	const members = field(raw, 'criteria', []);
	if (!Array.isArray(members)) refuse(`${where}.criteria`, 'must be a list');
	return {
		type,
		criteria: members.map((member: unknown, i) => {
			const at = `${where}.criteria[${i}]`;
			if (!isDoc(member)) refuse(at, 'must be an object');
			if (field(member, 'type') === 'any_of') {
				refuse(`${at}.type`, 'an any_of group holds no other group');
			}
			return readLeaf(member, oneOf(member, 'type', at, LEAF_TYPES), at);
		})
	};
}

/**
 * Criteria as a client sends them, read as pydantic reads them in canonical
 * JSON: the discriminating `type` required, the defaults filled, unknown keys
 * ignored. What pydantic would coerce (`"3"` for a count) is refused here.
 */
export function readCriteria(raw: unknown, path: string): Criterion[] {
	if (!Array.isArray(raw)) refuse(path, 'must be a list');
	return raw.map((criterion: unknown, i) => readCriterion(criterion, `${path}[${i}]`));
}

// -- patterns ------------------------------------------------------------------

const UNSUPPORTED = 'reaches an unsupported pattern';

/** Every `matches` pattern of a call, by its text: a test, or `null` where `re` refuses it. */
export type CompiledCriteria = ReadonlyMap<string, ((subject: string) => boolean) | null>;

/**
 * What the host cannot run although Python can: a pattern nested past the
 * translator's stack or a subject past the translated `RegExp`'s backtracking
 * stack (a `RangeError`), and a translation V8 will not compile (a
 * `SyntaxError`, thrown on first run, since V8 compiles lazily and apart for
 * one-byte and two-byte subjects). Nothing else: any other error is a bug.
 */
function beyondHost(error: unknown): boolean {
	return (
		error instanceof RangeError ||
		(error instanceof SyntaxError && error.message.endsWith('Regular expression too large'))
	);
}

/** Runs `work`, turning what the host cannot run into the 501 that sends the call to the server. */
function onHost<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (beyondHost(error)) throw new ReadError(501, UNSUPPORTED);
		throw error;
	}
}

/**
 * Translates every `matches` pattern, group members included, before any
 * entity is matched, and runs each once on a one-byte and a two-byte subject
 * so that a translation V8 will not compile refuses here rather than
 * mid-scan. A pattern the translator cannot vouch for refuses the whole call
 * with 501, so that it goes to the server.
 */
export function compileCriteria(criteria: readonly Criterion[]): CompiledCriteria {
	const patterns = new Map<string, ((subject: string) => boolean) | null>();
	const compile = (c: LeafCriterion) => {
		if ((c.type !== 'property' && c.type !== 'name_id') || c.op !== 'matches') return;
		if (patterns.has(c.value)) return;
		const regex = onHost(() => translatePyRegex(c.value, 'search'));
		if (regex.kind === 'unsupported') throw new ReadError(501, UNSUPPORTED);
		if (regex.kind === 'ok') {
			onHost(() => regex.test(''));
			onHost(() => regex.test('\u0100'));
		}
		patterns.set(c.value, regex.kind === 'ok' ? regex.test : null);
	};
	for (const c of criteria) {
		if (c.type === 'any_of') c.criteria.forEach(compile);
		else compile(c);
	}
	return patterns;
}

/** `re.search(pattern, subject)`; a pattern `re` refuses never matches. */
function search(compiled: CompiledCriteria, pattern: string, subject: string): boolean {
	const test = compiled.get(pattern);
	if (test === undefined) throw new Error(`pattern ${JSON.stringify(pattern)} was not compiled`);
	if (test === null) return false;
	return onHost(() => test(subject));
}

// -- matching ------------------------------------------------------------------

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
const splitsPair = (text: string, at: number) =>
	at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));

/** Python's `needle in haystack`, over code points: a match never splits a surrogate pair. */
function pyContains(haystack: string, needle: string): boolean {
	for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
		if (!splitsPair(haystack, at) && !splitsPair(haystack, at + needle.length)) return true;
	}
	return false;
}

/** `String(raw ?? '')`: missing and `null` are the empty string. */
const nullishStr = (raw: Value | undefined): string =>
	raw === undefined || raw === null ? '' : jsStr(raw);

/**
 * The entity's `name`: a non-empty string only, never a list's first entry.
 * An exact `name` wins over any other casing, which are tried in property order.
 */
export function nameProp(props: Props): string | null {
	const exact = getProp(props, 'name');
	if (typeof exact === 'string' && exact !== '') return exact;
	for (const key of Object.keys(props)) {
		if (key === 'name' || pyLower(key) !== 'name') continue;
		const value = props[key];
		if (typeof value === 'string' && value !== '') return value;
	}
	return null;
}

const matchEntityType = (typeName: string, names: readonly string[]) =>
	names.length === 0 || names.includes(typeName);

function matchProperty(props: Props, c: PropertyCriterion, compiled: CompiledCriteria): boolean {
	const raw = getProp(props, c.name);
	switch (c.op) {
		case 'exists':
			return raw !== undefined && raw !== null && raw !== '';
		case 'is_empty':
			return raw === undefined || raw === null || raw === '';
		case 'equals':
			return nullishStr(raw) === c.value;
		case 'not_equals':
			return nullishStr(raw) !== c.value;
		case 'contains':
			return pyContains(pyLower(nullishStr(raw)), pyLower(c.value));
		case 'matches':
			return search(compiled, c.value, nullishStr(raw));
	}
	const lhs = toNumber(raw);
	const rhs = toNumber(c.value);
	if (Number.isNaN(lhs) || Number.isNaN(rhs)) return false;
	switch (c.op) {
		case 'gt':
			return lhs > rhs;
		case 'lt':
			return lhs < rhs;
		case 'gte':
			return lhs >= rhs;
		case 'lte':
			return lhs <= rhs;
	}
}

function matchNameId(
	props: Props,
	id: string,
	c: NameIdCriterion,
	compiled: CompiledCriteria
): boolean {
	const subject = c.field === 'name' ? (nameProp(props) ?? '') : id;
	if (c.op === 'contains') return pyContains(pyLower(subject), pyLower(c.value));
	if (c.op === 'equals') return subject === c.value;
	return search(compiled, c.value, subject);
}

/** The element's relationships in a direction, each once: a self-loop is in both lists. */
function relsFor(element: ElementRec, direction: CriterionDirection): readonly RelRec[] {
	if (direction === 'outgoing') return element.out;
	if (direction === 'incoming') return element.in;
	return [...element.out, ...element.in.filter((rel) => rel.source !== element)];
}

/** Whether `element` matches `c`; a relationship-only criterion matches every element. */
export function matchElement(
	model: Model,
	element: ElementRec,
	c: Criterion,
	compiled: CompiledCriteria
): boolean {
	switch (c.type) {
		case 'any_of':
			return (
				c.criteria.length === 0 ||
				c.criteria.some((member) => matchElement(model, element, member, compiled))
			);
		case 'entity_type':
			return matchEntityType(element.typeName, c.names);
		case 'property':
			return matchProperty(element.props, c, compiled);
		case 'name_id':
			return matchNameId(element.props, element.id, c, compiled);
		case 'relation_count': {
			let n = 0;
			for (const rel of relsFor(element, c.direction)) {
				if (c.rel_types.length === 0 || c.rel_types.includes(rel.typeName)) n++;
			}
			if (c.op === 'at_least') return n >= c.count;
			if (c.op === 'at_most') return n <= c.count;
			return n === c.count;
		}
		case 'orphan':
			return element.out.length === 0 && element.in.length === 0;
		case 'connected_to_type':
			return relsFor(element, c.direction).some((rel) => {
				const other = rel.source.id === element.id ? rel.target : rel.source;
				return c.names.includes(other.typeName);
			});
		case 'endpoint_type':
			return true;
	}
}

/** Whether `rel` matches `c`; an element-only criterion matches every relationship. */
export function matchRelationship(
	model: Model,
	rel: RelRec,
	c: Criterion,
	compiled: CompiledCriteria
): boolean {
	switch (c.type) {
		case 'any_of':
			return (
				c.criteria.length === 0 ||
				c.criteria.some((member) => matchRelationship(model, rel, member, compiled))
			);
		case 'entity_type':
			return matchEntityType(rel.typeName, c.names);
		case 'property':
			return matchProperty(rel.props, c, compiled);
		case 'name_id':
			return matchNameId(rel.props, rel.id, c, compiled);
		case 'endpoint_type':
			return c.names.includes((c.endpoint === 'source' ? rel.source : rel.target).typeName);
		case 'relation_count':
		case 'orphan':
		case 'connected_to_type':
			return true;
	}
}
