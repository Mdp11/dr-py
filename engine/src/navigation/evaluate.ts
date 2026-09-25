/**
 * The navigation evaluator of `core/navigation/evaluate.py`, line for line,
 * in steps. Chains are enumerated depth first over ids sorted by code point,
 * parallel edges giving one continuation, so the order is the core's and a
 * page can be cut by re-evaluating. Two caps bound the work: `maxVisited`
 * counts every edge and property value examined, `maxChains` the chains
 * collected; either stops the walk and marks the result truncated.
 */
import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Model } from '../model/model.ts';
import { getProp, type ElementRec, type RelRec } from '../model/records.ts';
import {
	compileCriteria,
	matchElement,
	type CompiledCriteria,
	type Criterion
} from '../search/criteria.ts';
import { drain, sortedInSlices, type Progress, type Steps } from '../steps/steps.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { PyFloat, type Value } from '../value/types.ts';
import type {
	FilterStep,
	NavigationDefinition,
	NavigationStep,
	PathNavigation,
	PropertyStep,
	RelationshipStep,
	Scope,
	SetExpression
} from './schema.ts';

export type EvalLimits = { maxVisited: number; maxChains: number };

export const DEFAULT_LIMITS: EvalLimits = { maxVisited: 100_000, maxChains: 5_000 };

/** A value a scalar property step ends its chain at. */
export type ScalarValue = string | number | bigint | PyFloat | boolean;

/**
 * A chain's terminal value, never mistaken for an element id. Its `key` is
 * `(type, value)`: `true`, `1` and `1.0` are three values, as they are three
 * cells.
 */
export class PropertyValue {
	readonly value: ScalarValue;

	constructor(value: ScalarValue) {
		this.value = value;
	}

	get key(): string {
		const { value } = this;
		if (value instanceof PyFloat) return `float:${String(value.value)}`;
		if (typeof value === 'boolean') return `bool:${String(value)}`;
		if (typeof value === 'string') return `str:${value}`;
		return `int:${String(value)}`;
	}
}

/** One position of a chain: an element id, or a terminal value. */
export type ChainNode = string | PropertyValue;

/** Every chain holds its start at index 0; only the last node may be a value. */
export type ChainResult = { stepTypes: string[]; chains: ChainNode[][]; truncated: boolean };

/** The core's `KeyError`: `model.elements[id]` of an id no element has. */
export class NavKeyError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(id);
		this.name = 'NavKeyError';
		this.id = id;
	}
}

/** The core's `ValueError`, its text the core's. */
export class NavValueError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NavValueError';
	}
}

// Units of work per step: an edge or a property value examined, an element
// gathered or matched, a set member combined, a chain collected, an id sorted.
const STEP_UNITS = 1024;

/** Counts the units of one call, shared by everything it evaluates, and cuts them into steps. */
export class Meter {
	readonly total: number;
	done = 0;
	private stepStart = 0;

	constructor(total: number) {
		this.total = total;
	}

	/** Counts one unit; true when the step is full and must end. */
	tick(): boolean {
		return ++this.done - this.stepStart >= STEP_UNITS;
	}

	/** Ends the step: what to yield. */
	end(): Progress {
		this.stepStart = this.done;
		return { done: this.done, total: this.total };
	}

	/** Sorts `items` in place or into a new array; use the result. */
	*sort<T>(items: T[], compare: (a: T, b: T) => number): Steps<T[]> {
		if (items.length <= STEP_UNITS) {
			for (let i = 0; i < items.length; i++) if (this.tick()) yield this.end();
			return items.sort(compare);
		}
		if (this.done > this.stepStart) yield this.end();
		const steps = sortedInSlices(items, compare, STEP_UNITS);
		let sorted = 0;
		for (;;) {
			const next = steps.next();
			if (next.done === true) return next.value;
			this.done += next.value.done - sorted;
			sorted = next.value.done;
			yield this.end();
		}
	}
}

/** The edge budget of one path: every operand of a set gets its own. */
class Budget {
	private readonly maxVisited: number;
	private visited = 0;
	exhausted = false;

	constructor(maxVisited: number) {
		this.maxVisited = maxVisited;
	}

	/** Charges `n` examinations; false once the budget is gone. */
	spend(n: number): boolean {
		this.visited += n;
		if (this.visited > this.maxVisited) this.exhausted = true;
		return !this.exhausted;
	}
}

type Context = {
	mm: Metamodel;
	model: Model;
	limits: EvalLimits;
	rowElements: readonly string[] | null;
	meter: Meter;
	compiled: CompiledCriteria;
};

type Walk = Generator<Progress, boolean, void>;

const sortIds = (ctx: Context, ids: string[]) => ctx.meter.sort(ids, cmpCodePoint);

// -- criteria ------------------------------------------------------------------

/**
 * A property criterion needs the property present, bar `exists` and
 * `is_empty`; a group's members are gated one by one, and an empty group
 * matches.
 */
function matchNav(ctx: Context, element: ElementRec, c: Criterion): boolean {
	if (c.type === 'any_of') {
		return c.criteria.length === 0 || c.criteria.some((member) => matchNav(ctx, element, member));
	}
	if (c.type === 'property' && c.op !== 'exists' && c.op !== 'is_empty') {
		if (!Object.hasOwn(element.props, c.name)) return false;
	}
	return matchElement(ctx.model, element, c, ctx.compiled);
}

const matchesAll = (ctx: Context, element: ElementRec, criteria: readonly Criterion[]) =>
	criteria.every((c) => matchNav(ctx, element, c));

/** Every criterion of a definition, set operands included. */
function criteriaOf(defn: NavigationDefinition, into: Criterion[]): Criterion[] {
	const ofSet = (expr: SetExpression) => {
		for (const operand of expr.operands) {
			if (operand.definition !== null) criteriaOf(operand.definition, into);
		}
	};
	if (defn.kind === 'set_op') {
		ofSet(defn);
		return into;
	}
	if (defn.start.kind === 'scope') into.push(...defn.start.criteria);
	else if (defn.start.kind === 'set_op') ofSet(defn.start);
	for (const step of defn.steps) if (step.kind === 'filter') into.push(...step.criteria);
	return into;
}

// -- starts --------------------------------------------------------------------

function* scopeIds(ctx: Context, scope: Scope): Steps<string[]> {
	const { mm, model, meter } = ctx;
	if (scope.types.length > 0) {
		const typed = new Set<string>();
		for (const typeName of scope.types) {
			for (const concrete of mm.elementDescendants(typeName)) {
				for (const element of model.indexes.byType.get(concrete) ?? []) {
					typed.add(element.id);
					if (meter.tick()) yield meter.end();
				}
			}
		}
		if (scope.criteria.length === 0) return yield* sortIds(ctx, [...typed]);
		const matched: string[] = [];
		for (const id of typed) {
			if (matchesAll(ctx, model.getElement(id), scope.criteria)) matched.push(id);
			if (meter.tick()) yield meter.end();
		}
		return yield* sortIds(ctx, matched);
	}
	const ids: string[] = [];
	for (const element of model.elements()) {
		if (scope.criteria.length === 0 || matchesAll(ctx, element, scope.criteria)) {
			ids.push(element.id);
		}
		if (meter.tick()) yield meter.end();
	}
	return yield* sortIds(ctx, ids);
}

function* startIds(ctx: Context, defn: PathNavigation, budget: Budget): Steps<string[]> {
	const { start } = defn;
	if (start.kind === 'row') {
		if (ctx.rowElements === null) {
			throw new NavValueError('navigation is row-rooted; no row element bound');
		}
		return yield* sortIds(ctx, [...new Set(ctx.rowElements)]);
	}
	if (start.kind === 'set_op') {
		const [members, truncated] = yield* evaluateSet(ctx, start, budget);
		if (truncated) budget.exhausted = true;
		return yield* sortIds(ctx, [...members]);
	}
	return yield* scopeIds(ctx, start);
}

// -- hops ----------------------------------------------------------------------

function* hop(
	ctx: Context,
	elementId: string,
	step: RelationshipStep,
	budget: Budget
): Steps<string[]> {
	const { mm, meter } = ctx;
	const element = ctx.model.findElement(elementId);
	// `either` is out plus in, a self-loop, in both, once.
	const out: readonly RelRec[] =
		element === undefined || step.direction === 'in' ? [] : element.out;
	const inward: readonly RelRec[] =
		element === undefined || step.direction === 'out' ? [] : element.in;
	const either = step.direction === 'either';
	let count = out.length;
	for (const rel of inward) if (!either || rel.source !== element) count++;
	if (!budget.spend(count)) return [];
	const next = new Set<string>();
	const visit = (rel: RelRec) => {
		if (!mm.isRelationshipSubtype(rel.typeName, step.relationship_type)) return;
		const other = rel.source.id === elementId ? rel.target : rel.source;
		if (
			step.target_types.length === 0 ||
			step.target_types.some((t) => mm.isElementSubtype(other.typeName, t))
		) {
			next.add(other.id);
		}
	};
	for (const rel of out) {
		visit(rel);
		if (meter.tick()) yield meter.end();
	}
	for (const rel of inward) {
		if (either && rel.source === element) continue;
		visit(rel);
		if (meter.tick()) yield meter.end();
	}
	return yield* sortIds(ctx, [...next]);
}

const isScalar = (item: Value): item is ScalarValue =>
	typeof item === 'string' ||
	typeof item === 'number' ||
	typeof item === 'bigint' ||
	typeof item === 'boolean' ||
	item instanceof PyFloat;

/**
 * Through an element-typed property to the elements its string values name
 * (dangling ones skipped, any other value too); a scalar property ends the
 * chain at each of its values, in list order. A missing definition or value
 * prunes.
 */
function* hopProperty(
	ctx: Context,
	elementId: string,
	step: PropertyStep,
	budget: Budget
): Steps<ChainNode[]> {
	const { mm, model, meter } = ctx;
	const element = model.findElement(elementId);
	if (element === undefined) throw new NavKeyError(elementId);
	const prop = mm
		.effectiveElementProperties(element.typeName)
		.find((p) => p.name === step.property_name);
	if (prop === undefined) return [];
	const value = getProp(element.props, step.property_name);
	if (value === undefined || value === null) return [];
	const candidates = Array.isArray(value) ? value : [value];
	if (!budget.spend(candidates.length)) return [];
	if (!mm.isElementType(prop.datatype)) {
		const values: ChainNode[] = [];
		for (const item of candidates) {
			if (isScalar(item)) values.push(new PropertyValue(item));
			if (meter.tick()) yield meter.end();
		}
		return values;
	}
	const ids = new Set<string>();
	for (const item of candidates) {
		if (typeof item === 'string' && model.findElement(item) !== undefined) ids.add(item);
		if (meter.tick()) yield meter.end();
	}
	return yield* sortIds(ctx, [...ids]);
}

// -- paths ---------------------------------------------------------------------

function stepType(step: Exclude<NavigationStep, FilterStep>): string {
	if (step.kind === 'relationship') return step.relationship_type;
	if (step.kind === 'property') return step.property_name;
	return step.comment || 'script';
}

/**
 * Depth first over the steps from `itemIdx`: true when the walk stopped
 * early, at the chain cap or the budget. A value is terminal, and a script
 * step never runs here — one that reaches a snippet was refused before —
 * so it prunes.
 */
function* walk(
	ctx: Context,
	steps: readonly NavigationStep[],
	itemIdx: number,
	chain: ChainNode[],
	chains: ChainNode[][],
	budget: Budget,
	excludeVisited: boolean
): Walk {
	const { meter } = ctx;
	if (itemIdx === steps.length) {
		if (chains.length >= ctx.limits.maxChains) return true;
		chains.push(chain);
		if (meter.tick()) yield meter.end();
		return false;
	}
	const step = steps[itemIdx]!;
	const current = chain[chain.length - 1]!;
	if (typeof current !== 'string') return false;
	if (step.kind === 'filter') {
		const element = ctx.model.findElement(current);
		if (element === undefined) throw new NavKeyError(current);
		const matched = matchesAll(ctx, element, step.criteria);
		if (meter.tick()) yield meter.end();
		if (!matched) return false;
		return yield* walk(ctx, steps, itemIdx + 1, chain, chains, budget, excludeVisited);
	}
	// The element expanded is a unit too: one with no edges costs a visit.
	if (meter.tick()) yield meter.end();
	let next: readonly ChainNode[] = [];
	if (step.kind === 'relationship') next = yield* hop(ctx, current, step, budget);
	else if (step.kind === 'property') next = yield* hopProperty(ctx, current, step, budget);
	if (budget.exhausted) return true;
	for (const other of next) {
		// A value is never in a chain's prefix: only an id can repeat.
		if (excludeVisited && chain.includes(other)) continue;
		if (yield* walk(ctx, steps, itemIdx + 1, [...chain, other], chains, budget, excludeVisited)) {
			return true;
		}
	}
	return false;
}

// -- sets ----------------------------------------------------------------------

/** The operand's elements at `stepIndex`, and whether its evaluation was cut short. */
function* operandMembers(
	ctx: Context,
	defn: NavigationDefinition,
	stepIndex: number | null,
	budget: Budget
): Steps<[Set<string>, boolean]> {
	if (defn.kind === 'set_op') {
		if (stepIndex !== null && stepIndex !== 0) {
			throw new NavValueError(`step_index ${stepIndex} out of range for a set operand`);
		}
		return yield* evaluateSet(ctx, defn, budget);
	}
	const inner = yield* evaluate(ctx, defn);
	const nSteps = inner.stepTypes.length;
	const index = stepIndex ?? nSteps;
	if (index > nSteps) {
		throw new NavValueError(`step_index ${stepIndex} out of range: path has ${nSteps} steps`);
	}
	const members = new Set<string>();
	for (const chain of inner.chains) {
		const node = chain[index]!;
		if (typeof node === 'string') members.add(node);
		if (ctx.meter.tick()) yield ctx.meter.end();
	}
	return [members, inner.truncated];
}

/** `difference` folds left over the operands; every operand's path has its own budget. */
function* evaluateSet(
	ctx: Context,
	expr: SetExpression,
	budget: Budget
): Steps<[Set<string>, boolean]> {
	const { meter } = ctx;
	let truncated = false;
	let result: Set<string> | null = null;
	for (const operand of expr.operands) {
		const [members, cut] = yield* operandMembers(
			ctx,
			operand.definition!,
			operand.step_index,
			budget
		);
		truncated ||= cut;
		if (result === null) {
			result = members;
			continue;
		}
		if (expr.op === 'intersection') {
			for (const id of result) {
				if (!members.has(id)) result.delete(id);
				if (meter.tick()) yield meter.end();
			}
			continue;
		}
		for (const id of members) {
			if (expr.op === 'union') result.add(id);
			else if (expr.op === 'difference') result.delete(id);
			else if (!result.delete(id)) result.add(id);
			if (meter.tick()) yield meter.end();
		}
	}
	return [result ?? new Set(), truncated];
}

// -- the evaluator ---------------------------------------------------------------

function* evaluate(ctx: Context, defn: NavigationDefinition): Steps<ChainResult> {
	const budget = new Budget(ctx.limits.maxVisited);
	if (defn.kind === 'set_op') {
		const [members, truncated] = yield* evaluateSet(ctx, defn, budget);
		const ids = yield* sortIds(ctx, [...members]);
		return {
			stepTypes: [],
			chains: ids.map((id) => [id]),
			truncated: truncated || budget.exhausted
		};
	}
	const starts = yield* startIds(ctx, defn, budget);
	const chains: ChainNode[][] = [];
	let truncated = false;
	for (const startId of starts) {
		if (yield* walk(ctx, defn.steps, 0, [startId], chains, budget, defn.exclude_visited)) {
			truncated = true;
			break;
		}
	}
	return {
		stepTypes: defn.steps.filter((step) => step.kind !== 'filter').map(stepType),
		chains,
		truncated: truncated || budget.exhausted
	};
}

/**
 * A ref-free definition (see `resolveRefs`) evaluated in steps. `rowElements`
 * binds every row start, nested ones included; a row start with none throws
 * `NavValueError`. Every pattern of the definition is translated before the
 * generator exists, so an unsupported one refuses (501) before any step.
 * `meter` counts the units of the whole call when the caller shares it.
 */
export function evaluateSteps(
	mm: Metamodel,
	model: Model,
	defn: NavigationDefinition,
	limits: EvalLimits = DEFAULT_LIMITS,
	rowElements: readonly string[] | null = null,
	meter: Meter = new Meter(limits.maxVisited)
): Steps<ChainResult> {
	const compiled = compileCriteria(criteriaOf(defn, []));
	return evaluate({ mm, model, limits, rowElements, meter, compiled }, defn);
}

/**
 * The ids `scope` selects in code point order, with no edge budget and no
 * chain cap: a table's scope rows. Its patterns are translated at the first
 * step.
 */
export function* scopeSteps(
	mm: Metamodel,
	model: Model,
	scope: Scope,
	meter: Meter
): Steps<string[]> {
	const compiled = compileCriteria(scope.criteria);
	return yield* scopeIds(
		{ mm, model, limits: DEFAULT_LIMITS, rowElements: null, meter, compiled },
		scope
	);
}

/** `evaluateSteps`, drained. */
export function evaluateNavigationCore(
	mm: Metamodel,
	model: Model,
	defn: NavigationDefinition,
	limits: EvalLimits = DEFAULT_LIMITS,
	rowElements: readonly string[] | null = null
): ChainResult {
	return drain(evaluateSteps(mm, model, defn, limits, rowElements));
}
