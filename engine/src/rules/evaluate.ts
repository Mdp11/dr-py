import type { Model } from '../model/model.ts';
import { getProp, type ElementRec } from '../model/records.ts';
import type { Issue } from '../validation/issue.ts';
import type { Run, Validator } from '../validation/pipeline.ts';
import { pyContains } from '../value/compare.ts';
import { PyFloat, type Value } from '../value/types.ts';
import type { CompiledRule, CompiledRules } from './compile.ts';
import type {
	Condition,
	Count,
	PropertyAtom,
	PropertyTest,
	RelationshipAtom,
	Scalar
} from './document.ts';

type Num = number | bigint;

function numeric(value: Value): Num | null {
	if (typeof value === 'number' || typeof value === 'bigint') return value;
	return value instanceof PyFloat ? value.value : null;
}

/** Mathematical equality of an `int` or a `float` with another. */
function numEq(a: Num, b: Num): boolean {
	if (typeof a === 'number' && typeof b === 'number') return a === b;
	if (typeof a === 'bigint' && typeof b === 'bigint') return a === b;
	const [n, big] = typeof a === 'number' ? [a, b as bigint] : [b as number, a];
	return Number.isInteger(n) && BigInt(n) === big;
}

/**
 * Python's `value == operand`, except that a `bool` equals only a `bool`:
 * numbers compare as the numbers they are (`1 == 1.0`, `NaN` never), a
 * string only a string, `None` only `None`, and a list or a dict nothing.
 */
export function pyRuleEq(value: Value, operand: Scalar | null): boolean {
	if (typeof value === 'boolean' || typeof operand === 'boolean') return value === operand;
	if (operand === null) return value === null;
	if (typeof operand === 'string') return value === operand;
	const a = numeric(value);
	return a !== null && numEq(a, operand instanceof PyFloat ? operand.value : operand);
}

/** One stored value against a test other than `exists`; a mismatch of kinds is `false`. */
function testScalar(test: Exclude<PropertyTest, { op: 'exists' }>, value: Value): boolean {
	switch (test.op) {
		case 'equals':
			return pyRuleEq(value, test.value);
		case 'not_equals':
			return !pyRuleEq(value, test.value);
		case 'in':
			return test.values.some((operand) => pyRuleEq(value, operand));
		case 'contains':
			return (
				typeof value === 'string' && typeof test.value === 'string' && pyContains(value, test.value)
			);
	}
	// A `bool` is no number here.
	const a = numeric(value);
	if (a === null) return false;
	const bound = test.bound.value;
	switch (test.op) {
		case 'gt':
			return a > bound;
		case 'gte':
			return a >= bound;
		case 'lt':
			return a < bound;
		case 'lte':
			return a <= bound;
	}
}

function evaluateProperty(el: ElementRec, atom: PropertyAtom): boolean {
	const value = getProp(el.props, atom.property);
	const present =
		value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
	const { test } = atom;
	if (test.op === 'exists') return present === test.value;
	// Missing fails every other test, `not_equals` included.
	if (!present) return false;
	if (Array.isArray(value)) {
		if (test.op === 'contains') return value.some((item) => pyRuleEq(item, test.value));
		return value.some((item) => testScalar(test, item));
	}
	return testScalar(test, value);
}

const countOk = (n: number, bound: Count | null, holds: (n: number, b: Num) => boolean) =>
	bound === null || holds(n, bound);

function evaluateRelationship(model: Model, el: ElementRec, atom: RelationshipAtom): boolean {
	const mm = model.metamodel;
	const relTypes = mm.relationshipDescendants(atom.type);
	const farTypes = atom.to === null ? null : mm.elementDescendants(atom.to);
	const outgoing = atom.direction === 'outgoing';
	let n = 0;
	for (const rel of outgoing ? el.out : el.in) {
		if (!relTypes.has(rel.typeName)) continue;
		if (farTypes !== null || atom.where !== null) {
			const far = outgoing ? rel.target : rel.source;
			if (farTypes !== null && !farTypes.has(far.typeName)) continue;
			if (atom.where !== null && !evaluateCondition(model, far, atom.where)) continue;
		}
		n++;
	}
	if (atom.exists !== null) return n > 0 === atom.exists;
	const { eq, gte, lte } = atom.count!;
	return (
		countOk(n, eq, numEq) && countOk(n, gte, (a, b) => a >= b) && countOk(n, lte, (a, b) => a <= b)
	);
}

/** Whether `el` satisfies `cond`, in the model it belongs to. */
export function evaluateCondition(model: Model, el: ElementRec, cond: Condition): boolean {
	if ('all' in cond) return cond.all.every((sub) => evaluateCondition(model, el, sub));
	if ('any' in cond) return cond.any.some((sub) => evaluateCondition(model, el, sub));
	if ('not' in cond) return !evaluateCondition(model, el, cond.not);
	if ('property' in cond) return evaluateProperty(el, cond);
	return evaluateRelationship(model, el, cond);
}

function issueFor(cr: CompiledRule, el: ElementRec): Issue {
	const { rule } = cr;
	// Python's `or`: an empty message falls back too.
	const message =
		rule.message !== null && rule.message !== ''
			? rule.message
			: `Rule '${rule.name}' violated` + (rule.description !== '' ? `: ${rule.description}` : '');
	return {
		severity: rule.severity,
		message,
		targetIds: [el.id],
		category: 'conformance',
		check: cr.check
	};
}

/**
 * The compiled rules as the pipeline's seventh validator, one per run. Each
 * issue carries its rule's check. A rule that throws is counted under its
 * check instead of breaking validation; the run's counts are merged into the
 * compile once, by the global hook.
 */
export class RulesValidator implements Validator {
	readonly checkName = '';
	private readonly compiled: CompiledRules;
	private readonly errors = new Map<string, number>();

	constructor(compiled: CompiledRules) {
		this.compiled = compiled;
	}

	validateElement(run: Run, el: ElementRec): void {
		const rules = this.compiled.rulesByType.get(el.typeName);
		if (rules === undefined) return;
		for (const cr of rules) {
			try {
				if (cr.rule.when !== null && !evaluateCondition(run.model, el, cr.rule.when)) continue;
				if (!evaluateCondition(run.model, el, cr.rule.then)) run.out.push(issueFor(cr, el));
			} catch {
				this.errors.set(cr.check, (this.errors.get(cr.check) ?? 0) + 1);
			}
		}
	}

	validateGlobal(): void {
		const merged = this.compiled.evalErrors;
		for (const [check, n] of this.errors) merged.set(check, (merged.get(check) ?? 0) + n);
		this.errors.clear();
	}
}
