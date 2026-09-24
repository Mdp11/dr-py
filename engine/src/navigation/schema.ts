/**
 * The navigation definitions of `core/navigation/schema.py`: a path walks
 * steps from a start set; a set expression combines the element sets of its
 * operands. Every chain holds its start at index 0 and one column per
 * relationship, property or script step; a filter adds none.
 */
import { ReadError } from '../read/errors.ts';
import { readCriteria, type Criterion } from '../search/criteria.ts';
import { PyFloat } from '../value/types.ts';

/** The most steps a path may hold. */
export const MAX_STEPS = 10;

/** Elements of any of `types` (subtype-inclusive; none is every type) matching every criterion. */
export type Scope = { kind: 'scope'; types: string[]; criteria: Criterion[] };

/** The element(s) the caller binds, a table row's. */
export type RowStart = { kind: 'row' };

export type RelationshipStep = {
	kind: 'relationship';
	relationship_type: string;
	direction: 'out' | 'in' | 'either';
	target_types: string[];
};

/** Keeps a chain whose last element matches every criterion; adds no column. */
export type FilterStep = { kind: 'filter'; criteria: Criterion[] };

export type PropertyStep = { kind: 'property'; property_name: string };

/** A snippet's source: neither set is an unconfigured step. The definition is not read further. */
export type SnippetSource = { ref: string | null; definition: object | null };

/** `comment` labels the step's column. */
export type ScriptStep = { kind: 'script'; snippet: SnippetSource; comment: string | null };

export type NavigationStep = RelationshipStep | FilterStep | PropertyStep | ScriptStep;

export type SetOp = 'union' | 'intersection' | 'difference' | 'symmetric_difference';

/** A saved navigation (`ref`) or an inline one, contributing its elements at `step_index` (none: the last). */
export type Operand = {
	ref: string | null;
	definition: NavigationDefinition | null;
	step_index: number | null;
};

export type SetExpression = { kind: 'set_op'; op: SetOp; operands: Operand[] };

export type PathNavigation = {
	kind: 'path';
	start: Scope | SetExpression | RowStart;
	steps: NavigationStep[];
	exclude_visited: boolean;
};

export type NavigationDefinition = PathNavigation | SetExpression;

// -- reading -------------------------------------------------------------------

type Doc = { readonly [key: string]: unknown };

const isDoc = (value: unknown): value is Doc =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

function refuse(where: string, message: string): never {
	throw new ReadError(422, `${where}: ${message}`);
}

// An absent key takes the default; a `null` does not, as pydantic has it.
const field = (doc: Doc, key: string, fallback?: unknown): unknown =>
	Object.hasOwn(doc, key) && doc[key] !== undefined ? doc[key] : fallback;

function doc(raw: unknown, where: string): Doc {
	if (!isDoc(raw)) refuse(where, 'must be an object');
	return raw;
}

function str(d: Doc, key: string, where: string): string {
	const value = field(d, key);
	if (typeof value !== 'string') refuse(`${where}.${key}`, 'must be a string');
	return value;
}

function optionalStr(d: Doc, key: string, where: string): string | null {
	const value = field(d, key, null);
	if (value !== null && typeof value !== 'string')
		refuse(`${where}.${key}`, 'must be a string or null');
	return value;
}

function oneOf<T extends string>(
	d: Doc,
	key: string,
	where: string,
	options: readonly T[],
	fallback?: T
): T {
	const value = field(d, key, fallback);
	if (!options.includes(value as T)) {
		refuse(`${where}.${key}`, `must be one of ${options.join(', ')}`);
	}
	return value as T;
}

function names(d: Doc, key: string, where: string): string[] {
	const value = field(d, key, []);
	if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
		refuse(`${where}.${key}`, 'must be a list of strings');
	}
	return [...(value as string[])];
}

function list(d: Doc, key: string, where: string): readonly unknown[] {
	const value = field(d, key, []);
	if (!Array.isArray(value)) refuse(`${where}.${key}`, 'must be a list');
	return value;
}

/** Checked, not kept: an int when present. */
function checkSchemaVersion(d: Doc, where: string): void {
	const value = field(d, 'schema_version', 0);
	if (!((typeof value === 'number' && Number.isInteger(value)) || typeof value === 'bigint')) {
		refuse(`${where}.schema_version`, 'must be an integer');
	}
}

const criteriaOf = (d: Doc, where: string): Criterion[] =>
	readCriteria(field(d, 'criteria', []), `${where}.criteria`);

function readStep(raw: unknown, where: string): NavigationStep {
	const d = doc(raw, where);
	const kind = oneOf(d, 'kind', where, ['relationship', 'filter', 'property', 'script'] as const);
	// Every step's comment is checked; only a script step's labels its column.
	const comment = optionalStr(d, 'comment', where);
	switch (kind) {
		case 'relationship': {
			const step: RelationshipStep = {
				kind,
				relationship_type: str(d, 'relationship_type', where),
				direction: oneOf(d, 'direction', where, ['out', 'in', 'either'] as const, 'out'),
				target_types: names(d, 'target_types', where)
			};
			if (list(d, 'children', where).length > 0) {
				refuse(`${where}.children`, 'branching steps (`children`) are not supported in schema v2');
			}
			return step;
		}
		case 'filter':
			return { kind, criteria: criteriaOf(d, where) };
		case 'property':
			return { kind, property_name: str(d, 'property_name', where) };
		case 'script': {
			const at = `${where}.snippet`;
			const snippet = doc(field(d, 'snippet', {}), at);
			const ref = optionalStr(snippet, 'ref', at);
			const definition = field(snippet, 'definition', null);
			if (definition !== null && !isDoc(definition)) {
				refuse(`${at}.definition`, 'must be an object or null');
			}
			if (ref !== null && definition !== null) {
				refuse(at, 'provide at most one of `ref` / `definition`');
			}
			return { kind, snippet: { ref, definition }, comment };
		}
	}
}

function readOperand(raw: unknown, where: string): Operand {
	const d = doc(raw, where);
	const ref = optionalStr(d, 'ref', where);
	const inline = field(d, 'definition', null);
	const definition = inline === null ? null : readDefinition(inline, `${where}.definition`);
	const stepIndex = field(d, 'step_index', null);
	if (
		stepIndex !== null &&
		!(typeof stepIndex === 'number' && Number.isInteger(stepIndex) && stepIndex >= 0)
	) {
		refuse(`${where}.step_index`, 'must be an integer of at least 0 or null');
	}
	if ((ref === null) === (definition === null)) {
		refuse(where, 'an operand needs exactly one of `ref` / `definition`');
	}
	return { ref, definition, step_index: stepIndex };
}

const SET_OPS: readonly SetOp[] = ['union', 'intersection', 'difference', 'symmetric_difference'];

function readSet(d: Doc, where: string): SetExpression {
	checkSchemaVersion(d, where);
	const op = oneOf(d, 'op', where, SET_OPS);
	const raw = field(d, 'operands');
	if (!Array.isArray(raw)) refuse(`${where}.operands`, 'must be a list');
	if (raw.length === 0) refuse(`${where}.operands`, 'must hold at least one operand');
	return {
		kind: 'set_op',
		op,
		operands: raw.map((operand: unknown, i) => readOperand(operand, `${where}.operands[${i}]`))
	};
}

function readStart(raw: unknown, where: string): PathNavigation['start'] {
	const d = doc(raw, where);
	const kind = oneOf(d, 'kind', where, ['scope', 'set_op', 'row'] as const);
	if (kind === 'row') return { kind };
	if (kind === 'set_op') return readSet(d, where);
	return { kind, types: names(d, 'types', where), criteria: criteriaOf(d, where) };
}

function readDefinition(raw: unknown, where: string): NavigationDefinition {
	const d = doc(raw, where);
	const kind = oneOf(d, 'kind', where, ['path', 'set_op'] as const);
	if (kind === 'set_op') return readSet(d, where);
	checkSchemaVersion(d, where);
	optionalStr(d, 'name', where);
	const start = readStart(field(d, 'start'), `${where}.start`);
	const steps = list(d, 'steps', where).map((step, i) => readStep(step, `${where}.steps[${i}]`));
	if (steps.length > MAX_STEPS) {
		refuse(`${where}.steps`, `a navigation may have at most ${MAX_STEPS} steps`);
	}
	const excludeVisited = field(d, 'exclude_visited', true);
	if (typeof excludeVisited !== 'boolean') refuse(`${where}.exclude_visited`, 'must be a boolean');
	return { kind, start, steps, exclude_visited: excludeVisited };
}

/**
 * A definition as a client sends it or an artifact holds it, read as pydantic
 * reads it in canonical JSON: every `kind`, `op` and criterion `type`
 * required, the defaults filled, unknown keys ignored. `schema_version`, a
 * path's `name` and a step's `comment` are checked, never kept, bar a script
 * step's comment. What pydantic would
 * coerce is refused, in the engine's words where the core has none.
 */
export function readNavigation(raw: unknown, path: string): NavigationDefinition {
	return readDefinition(raw, path);
}
