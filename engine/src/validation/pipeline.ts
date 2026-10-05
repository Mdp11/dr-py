import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Model } from '../model/model.ts';
import type { ElementRec, RelRec } from '../model/records.ts';
import { liveStructure, type Structure } from '../model/structure.ts';
import type { CompiledRules } from '../rules/compile.ts';
import { RulesValidator } from '../rules/evaluate.ts';
import { beyondHost, HOST_REFUSED, translatePyRegex } from '../value/regex.ts';
import type { Issue } from './issue.ts';
import { Containment } from './validators/containment.ts';
import { EndpointTyping } from './validators/endpoint-typing.ts';
import { Facets } from './validators/facets.ts';
import { Multiplicity } from './validators/multiplicity.ts';
import { TypeConformance } from './validators/type-conformance.ts';
import { Uniqueness } from './validators/uniqueness.ts';

/**
 * One validation run: the model, its structure under the run's metamodel, the
 * facet patterns, and the issues found so far. Containment parents and
 * uniqueness groups are read from `structure`, never from the records.
 */
export type Run = {
	readonly model: Model;
	readonly structure: Structure;
	readonly patterns: FacetPatterns;
	readonly out: Issue[];
};

/**
 * A validator's global hook in a run over the whole model, made for that run:
 * fed every element, then every relationship, in state order, then finished.
 */
export interface WholeGlobal {
	element?(el: ElementRec): void;
	relationship?(rel: RelRec): void;
	finish?(): void;
}

/**
 * A validator appends what it finds to `run.out`. The entity hooks are
 * O(entity) over the model's indexes and memoized metamodel lookups; the
 * global hook runs once per run, after every entity, over the scope's ids.
 * A validator with a global hook also has `validateWhole`, its global hook
 * over the whole model, which appends to `out`.
 */
export interface Validator {
	readonly checkName: string;
	validateElement?(run: Run, el: ElementRec): void;
	validateRelationship?(run: Run, rel: RelRec): void;
	validateGlobal?(run: Run, scope: readonly string[]): void;
	validateWhole?(run: Run, out: Issue[]): WholeGlobal;
}

/**
 * The six built-in validators in pipeline order, with their memos, for one
 * metamodel. Built once and reused: the memos fill as types are met.
 */
export class Validators {
	readonly metamodel: Metamodel;
	readonly list: readonly Validator[];

	constructor(mm: Metamodel) {
		this.metamodel = mm;
		this.list = [
			new TypeConformance(mm),
			new Multiplicity(mm),
			new Facets(mm),
			new EndpointTyping(mm),
			new Containment(),
			new Uniqueness(mm)
		];
	}
}

type Test = (subject: string) => boolean;

/** A pattern that cannot be checked here, and why. */
type Unchecked = { readonly reason: string };

/**
 * `re.fullmatch` for every distinct facet pattern of one metamodel, each
 * translated once and run on a one-byte and a two-byte subject, so that a
 * translation V8 will not compile shows here. A pattern the translator does
 * not take, or one the host fails to run, answers with its reason instead of
 * a verdict, for good.
 */
export class FacetPatterns {
	readonly metamodel: Metamodel;
	private readonly tests = new Map<string, Test | Unchecked>();

	constructor(mm: Metamodel) {
		this.metamodel = mm;
		for (const type of [...mm.elements, ...mm.relationships]) {
			for (const { pattern } of type.properties) {
				if (pattern !== null && !this.tests.has(pattern)) {
					this.tests.set(pattern, this.compile(pattern));
				}
			}
		}
	}

	private compile(pattern: string): Test | Unchecked {
		try {
			const regex = translatePyRegex(pattern, 'fullmatch');
			if (regex.kind === 'invalid') return { reason: 'not a valid regular expression' };
			if (regex.kind === 'unsupported') return { reason: regex.reason };
			regex.test('');
			regex.test('\u0100');
			return regex.test;
		} catch (error) {
			if (!beyondHost(error)) throw error;
			return { reason: HOST_REFUSED };
		}
	}

	/** `re.fullmatch(pattern, subject)` for a pattern of this metamodel, or why it cannot be checked. */
	test(pattern: string, subject: string): boolean | Unchecked {
		const test = this.tests.get(pattern);
		if (test === undefined) throw new Error(`pattern ${JSON.stringify(pattern)} was not compiled`);
		if (typeof test === 'object') return test;
		try {
			return test(subject);
		} catch (error) {
			if (!beyondHost(error)) throw error;
			const unchecked = { reason: HOST_REFUSED };
			this.tests.set(pattern, unchecked);
			return unchecked;
		}
	}

	/** The patterns of this metamodel that cannot be checked. */
	unusable(): Array<{ pattern: string; reason: string }> {
		const out: Array<{ pattern: string; reason: string }> = [];
		for (const [pattern, test] of this.tests) {
			if (typeof test === 'object') out.push({ pattern, reason: test.reason });
		}
		return out;
	}
}

function stamp(out: Issue[], from: number, checkName: string): void {
	for (let i = from; i < out.length; i++) if (out[i]!.check === '') out[i]!.check = checkName;
}

/** A pass's issues, and where each validator's global issues begin, in list order. */
type Pass = { readonly out: Issue[]; readonly globals: readonly number[] };

/** The run's validators, a `RulesValidator` over `rules` last; throws unless all share the structure's metamodel. */
function validatorsOf(
	v: Validators,
	p: FacetPatterns,
	rules: CompiledRules | null,
	structure: Structure
): readonly Validator[] {
	if (v.metamodel !== structure.metamodel || p.metamodel !== structure.metamodel) {
		throw new Error('validators built for another metamodel');
	}
	return rules === null ? v.list : [...v.list, new RulesValidator(rules)];
}

function pass(
	model: Model,
	ids: Iterable<string>,
	v: Validators,
	p: FacetPatterns,
	rules: CompiledRules | null,
	structure: Structure
): Pass {
	const list = validatorsOf(v, p, rules, structure);
	const scope = [...new Set(ids)];
	const run: Run = { model, structure, patterns: p, out: [] };
	const out = run.out;
	for (const id of scope) {
		const el = model.findElement(id);
		if (el !== undefined) {
			for (const validator of list) {
				const from = out.length;
				validator.validateElement?.(run, el);
				stamp(out, from, validator.checkName);
			}
			continue;
		}
		const rel = model.findRelationship(id);
		if (rel === undefined) continue;
		for (const validator of list) {
			const from = out.length;
			validator.validateRelationship?.(run, rel);
			stamp(out, from, validator.checkName);
		}
	}
	const globals: number[] = [];
	for (const validator of list) {
		const from = out.length;
		globals.push(from);
		validator.validateGlobal?.(run, scope);
		stamp(out, from, validator.checkName);
	}
	return { out, globals };
}

/**
 * The pipeline over a scope of ids: each id once, its first occurrence
 * deciding the order; an element runs every element hook, a relationship
 * every relationship hook, an id naming nothing is skipped; then every global
 * hook, in validator order. With `rules`, a `RulesValidator` over them runs
 * seventh. The validators, the patterns and `structure` share one metamodel.
 */
export function validateScoped(
	model: Model,
	ids: Iterable<string>,
	v: Validators,
	p: FacetPatterns,
	rules: CompiledRules | null = null,
	structure: Structure = liveStructure(model)
): Issue[] {
	return pass(model, ids, v, p, rules, structure).out;
}

/**
 * `validateScoped` split: the entity hooks' issues, and each global hook's
 * own, one list per validator in list order, the rules' last when given.
 */
export function validateSplit(
	model: Model,
	ids: Iterable<string>,
	v: Validators,
	p: FacetPatterns,
	rules: CompiledRules | null,
	structure: Structure
): { entity: Issue[]; global: Issue[][] } {
	const { out, globals } = pass(model, ids, v, p, rules, structure);
	return {
		entity: out.slice(0, globals[0]),
		global: globals.map((from, i) => out.slice(from, globals[i + 1] ?? out.length))
	};
}

/**
 * `ValidationPipeline.validate(model)`: the run over the whole model
 * (`Scope.all()`), fed every element, then every relationship, in state
 * order, in slices as the caller likes. Each goes through the entity hooks and
 * through each validator's `validateWhole`, which answers unlike the global
 * hook of a scoped run over every id: one containment cycle for the model,
 * duplicates group by group. `finish` answers the entity issues, then each
 * validator's global issues, in validator order. The validators, the patterns
 * and `structure` share one metamodel; nothing may write the model while the
 * run is fed.
 */
export class WholeRun {
	private readonly run: Run;
	private readonly list: readonly Validator[];
	private readonly globals: { checkName: string; out: Issue[]; hook: WholeGlobal }[] = [];

	constructor(
		model: Model,
		v: Validators,
		p: FacetPatterns,
		rules: CompiledRules | null,
		structure: Structure
	) {
		this.list = validatorsOf(v, p, rules, structure);
		this.run = { model, structure, patterns: p, out: [] };
		for (const validator of this.list) {
			if (validator.validateWhole !== undefined) {
				const out: Issue[] = [];
				const hook = validator.validateWhole(this.run, out);
				this.globals.push({ checkName: validator.checkName, out, hook });
			} else if (validator.validateGlobal !== undefined) {
				throw new Error(`${validator.checkName} has no global hook over the whole model`);
			}
		}
	}

	element(el: ElementRec): void {
		const out = this.run.out;
		for (const validator of this.list) {
			const from = out.length;
			validator.validateElement?.(this.run, el);
			stamp(out, from, validator.checkName);
		}
		for (const { hook } of this.globals) hook.element?.(el);
	}

	relationship(rel: RelRec): void {
		const out = this.run.out;
		for (const validator of this.list) {
			const from = out.length;
			validator.validateRelationship?.(this.run, rel);
			stamp(out, from, validator.checkName);
		}
		for (const { hook } of this.globals) hook.relationship?.(rel);
	}

	finish(): Issue[] {
		const out = this.run.out;
		for (const { checkName, out: found, hook } of this.globals) {
			hook.finish?.();
			const from = out.length;
			for (const issue of found) out.push(issue);
			stamp(out, from, checkName);
		}
		return out;
	}
}
