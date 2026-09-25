import { parseExact } from '../value/parse.ts';
import { pyDumps } from '../value/serialize.ts';
import { PyFloat, type Value } from '../value/types.ts';

export const MAX_RULES_PER_SET = 200;
export const MAX_CONDITION_DEPTH = 8;

/** A rule operand as the exact parser gives it: floats always `PyFloat`, big integers `bigint`. */
export type Scalar = string | boolean | number | bigint | PyFloat;

export type PropertyTest =
	| { op: 'exists'; value: boolean }
	| { op: 'equals' | 'not_equals'; value: Scalar | null }
	| { op: 'in'; values: readonly Scalar[] }
	| { op: 'gt' | 'gte' | 'lt' | 'lte'; bound: PyFloat }
	| { op: 'contains'; value: Scalar };

export type PropertyAtom = { property: string; test: PropertyTest };

export type Count = number | bigint;

export type CountSpec = { eq: Count | null; gte: Count | null; lte: Count | null };

export type RelationshipAtom = {
	type: string;
	direction: 'outgoing' | 'incoming';
	to: string | null;
	where: Condition | null;
	exists: boolean | null;
	count: CountSpec | null;
};

export type Condition =
	| { all: readonly Condition[] }
	| { any: readonly Condition[] }
	| { not: Condition }
	| PropertyAtom
	| RelationshipAtom;

/** One rule, its defaults filled; `identity` is its entry as the document wrote it. */
export type Rule = {
	name: string;
	description: string;
	appliesTo: string;
	severity: 'error' | 'warning';
	disabled: boolean;
	when: Condition | null;
	then: Condition;
	message: string | null;
	identity: string;
};

export type RuleSetDoc = { schemaVersion: 1; rules: readonly Rule[] };

/** A rule-set document the reader does not take: the one way out, never a guess. */
export class RulesUnreadable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RulesUnreadable';
	}
}

type Doc = { [key: string]: Value };

const PROPERTY_TESTS = [
	'exists',
	'equals',
	'not_equals',
	'in',
	'gt',
	'gte',
	'lt',
	'lte',
	'contains'
] as const;
const PROPERTY_KEYS = new Set<string>(['property', ...PROPERTY_TESTS]);
const RELATIONSHIP_KEYS = new Set(['type', 'direction', 'to', 'where', 'exists', 'count']);
const COUNT_KEYS = new Set(['eq', 'gte', 'lte']);
const RULE_KEYS = new Set([
	'name',
	'description',
	'applies_to',
	'severity',
	'disabled',
	'when',
	'then',
	'message'
]);
const SET_KEYS = new Set(['schema_version', 'rules']);

function refuse(where: string, message: string): never {
	throw new RulesUnreadable(`${where}: ${message}`);
}

const isDoc = (value: Value | undefined): value is Doc =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

const field = (doc: Doc, key: string): Value | undefined =>
	Object.hasOwn(doc, key) ? doc[key] : undefined;

function object(value: Value | undefined, keys: ReadonlySet<string>, where: string): Doc {
	if (!isDoc(value)) refuse(where, 'must be an object');
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) refuse(where, `unknown key ${JSON.stringify(key)}`);
	}
	return value;
}

function text(value: Value | undefined, where: string, nonEmpty = false): string {
	if (typeof value !== 'string') refuse(where, 'must be a string');
	if (nonEmpty && value === '') refuse(where, 'must not be empty');
	return value;
}

/** An absent key and an explicit `null` both read as `null`, as a pydantic `is None` check does. */
function optional<T>(doc: Doc, key: string, read: (value: Value) => T): T | null {
	const value = field(doc, key);
	return value === undefined || value === null ? null : read(value);
}

function scalar(value: Value | undefined, where: string): Scalar {
	if (
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		typeof value === 'number' ||
		typeof value === 'bigint' ||
		value instanceof PyFloat
	) {
		return value;
	}
	return refuse(where, 'must be a string, a number or a boolean');
}

function count(value: Value, where: string): Count {
	if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
	if (typeof value === 'bigint' && value >= 0n) return value;
	return refuse(where, 'must be an integer of at least 0');
}

function propertyAtom(doc: Doc, where: string): PropertyAtom {
	const property = text(field(doc, 'property'), `${where}.property`, true);
	// The test is chosen by the key being there: `equals: null` is a test.
	const given = PROPERTY_TESTS.filter((key) => Object.hasOwn(doc, key));
	if (given.length !== 1) refuse(where, `needs exactly one test, got ${given.length}`);
	const op = given[0]!;
	const value = doc[op]!;
	const at = `${where}.${op}`;
	if (value === null && op !== 'equals' && op !== 'not_equals') refuse(at, 'needs a value');
	switch (op) {
		case 'exists':
			if (typeof value !== 'boolean') refuse(at, 'must be a boolean');
			return { property, test: { op, value } };
		case 'equals':
		case 'not_equals':
			return { property, test: { op, value: value === null ? null : scalar(value, at) } };
		case 'in':
			if (!Array.isArray(value)) refuse(at, 'must be a list');
			return {
				property,
				test: { op, values: value.map((item, i) => scalar(item, `${at}[${i}]`)) }
			};
		case 'gt':
		case 'gte':
		case 'lt':
		case 'lte':
			if (!(value instanceof PyFloat)) refuse(at, 'must be a float');
			return { property, test: { op, bound: value } };
		case 'contains':
			return { property, test: { op, value: scalar(value, at) } };
	}
}

function relationshipAtom(
	value: Value | undefined,
	where: string,
	level: number
): RelationshipAtom {
	const doc = object(value, RELATIONSHIP_KEYS, where);
	const type = text(field(doc, 'type'), `${where}.type`, true);
	const direction = field(doc, 'direction');
	if (direction !== 'outgoing' && direction !== 'incoming') {
		refuse(`${where}.direction`, 'must be outgoing or incoming');
	}
	const to = optional(doc, 'to', (v) => text(v, `${where}.to`));
	const where_ = optional(doc, 'where', (v) => condition(v, `${where}.where`, level + 1));
	const exists = optional(doc, 'exists', (v) => {
		if (typeof v !== 'boolean') refuse(`${where}.exists`, 'must be a boolean');
		return v;
	});
	const countSpec = optional(doc, 'count', (v): CountSpec => {
		const spec = object(v, COUNT_KEYS, `${where}.count`);
		const bound = (key: string) => optional(spec, key, (b) => count(b, `${where}.count.${key}`));
		const out = { eq: bound('eq'), gte: bound('gte'), lte: bound('lte') };
		if (out.eq === null && out.gte === null && out.lte === null) {
			refuse(`${where}.count`, 'needs at least one of eq, gte, lte');
		}
		return out;
	});
	if ((exists === null) === (countSpec === null)) {
		refuse(where, 'needs exactly one of exists, count');
	}
	return { type, direction, to, where: where_, exists, count: countSpec };
}

/**
 * A condition, told apart by its keys as pydantic's union is. `level` counts
 * the nesting, a `where` one level, so a document past the depth cap is
 * refused before its nesting is walked.
 */
function condition(value: Value | undefined, where: string, level: number): Condition {
	if (level > MAX_CONDITION_DEPTH) refuse(where, `nests deeper than ${MAX_CONDITION_DEPTH} levels`);
	if (!isDoc(value)) return refuse(where, 'must be an object');
	const list = (key: 'all' | 'any'): readonly Condition[] => {
		const items = object(value, new Set([key]), where)[key];
		if (!Array.isArray(items) || items.length === 0)
			refuse(`${where}.${key}`, 'must be a non-empty list');
		return items.map((item, i) => condition(item, `${where}.${key}[${i}]`, level + 1));
	};
	if (Object.hasOwn(value, 'all')) return { all: list('all') };
	if (Object.hasOwn(value, 'any')) return { any: list('any') };
	if (Object.hasOwn(value, 'not')) {
		const doc = object(value, new Set(['not']), where);
		return { not: condition(doc['not'], `${where}.not`, level + 1) };
	}
	if (Object.hasOwn(value, 'relationship')) {
		const doc = object(value, new Set(['relationship']), where);
		return relationshipAtom(doc['relationship'], `${where}.relationship`, level);
	}
	if (Object.hasOwn(value, 'property')) {
		return propertyAtom(object(value, PROPERTY_KEYS, where), where);
	}
	return refuse(where, 'is no condition');
}

function rule(value: Value | undefined, where: string): Rule {
	const doc = object(value, RULE_KEYS, where);
	// A default fills an absent key only: these fields take no `null`.
	const description = field(doc, 'description');
	const severity = Object.hasOwn(doc, 'severity') ? doc['severity'] : 'error';
	if (severity !== 'error' && severity !== 'warning') {
		refuse(`${where}.severity`, 'must be error or warning');
	}
	const disabled = Object.hasOwn(doc, 'disabled') ? doc['disabled'] : false;
	if (typeof disabled !== 'boolean') refuse(`${where}.disabled`, 'must be a boolean');
	return {
		name: text(field(doc, 'name'), `${where}.name`, true),
		description: description === undefined ? '' : text(description, `${where}.description`),
		appliesTo: text(field(doc, 'applies_to'), `${where}.applies_to`, true),
		severity,
		disabled,
		when: optional(doc, 'when', (v) => condition(v, `${where}.when`, 1)),
		then: condition(field(doc, 'then'), `${where}.then`, 1),
		message: optional(doc, 'message', (v) => text(v, `${where}.message`)),
		identity: pyDumps(doc, undefined, { allowNan: true })
	};
}

/**
 * A rule set from the document `POST /rules/parse` writes: JSON text, read
 * exactly (a bare `NaN` or `Infinity` is a float) and then strictly, against
 * the grammar pydantic enforces. Anything else throws `RulesUnreadable`.
 */
export function readRuleSet(documentText: string): RuleSetDoc {
	let value: Value;
	try {
		value = parseExact(documentText, { floatConstants: true });
	} catch (caught) {
		return refuse('document', `not JSON: ${(caught as Error).message}`);
	}
	const doc = object(value, SET_KEYS, 'document');
	const version = field(doc, 'schema_version');
	if (version !== undefined && version !== 1) refuse('schema_version', 'must be 1');
	const list = Object.hasOwn(doc, 'rules') ? doc['rules'] : [];
	if (!Array.isArray(list)) return refuse('rules', 'must be a list');
	if (list.length > MAX_RULES_PER_SET)
		refuse('rules', `holds more than ${MAX_RULES_PER_SET} rules`);
	const rules = list.map((item, i) => rule(item, `rules[${i}]`));
	const names = new Set<string>();
	for (const { name } of rules) {
		if (names.has(name)) refuse('rules', `duplicate rule name ${JSON.stringify(name)}`);
		names.add(name);
	}
	return { schemaVersion: 1, rules };
}
