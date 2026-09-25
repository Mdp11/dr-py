import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Model } from '../model/model.ts';
import type { ElementRec, RelRec } from '../model/records.ts';
import type { CompiledRules } from '../rules/compile.ts';
import { RulesValidator } from '../rules/evaluate.ts';
import { beyondHost, translatePyRegex } from '../value/regex.ts';
import type { Issue } from './issue.ts';
import { Containment } from './validators/containment.ts';
import { EndpointTyping } from './validators/endpoint-typing.ts';
import { Facets } from './validators/facets.ts';
import { Multiplicity } from './validators/multiplicity.ts';
import { TypeConformance } from './validators/type-conformance.ts';
import { Uniqueness } from './validators/uniqueness.ts';

/** One validation run: the model, the facet patterns, and the issues found so far. */
export type Run = {
	readonly model: Model;
	readonly patterns: FacetPatterns;
	readonly out: Issue[];
};

/**
 * A validator appends what it finds to `run.out`. The entity hooks are
 * O(entity) over the model's indexes and memoized metamodel lookups; the
 * global hook runs once per run, after every entity, over the scope's ids.
 */
export interface Validator {
	readonly checkName: string;
	validateElement?(run: Run, el: ElementRec): void;
	validateRelationship?(run: Run, rel: RelRec): void;
	validateGlobal?(run: Run, scope: readonly string[]): void;
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

/** A facet pattern the host cannot run although Python can. */
export class PatternUnusable extends Error {
	constructor() {
		super('reaches an unsupported pattern');
		this.name = 'PatternUnusable';
	}
}

type Test = (subject: string) => boolean;

/**
 * `re.fullmatch` for every distinct facet pattern of one metamodel, each
 * translated once and run on a one-byte and a two-byte subject, so that a
 * translation V8 will not compile shows here. A pattern the translator does
 * not take, or one the host fails to run, makes the set `unusable`; a test of
 * such a pattern throws `PatternUnusable`.
 */
export class FacetPatterns {
	readonly metamodel: Metamodel;
	private readonly tests = new Map<string, Test | null>();
	private broken = false;

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

	get unusable(): boolean {
		return this.broken;
	}

	private compile(pattern: string): Test | null {
		try {
			const regex = translatePyRegex(pattern, 'fullmatch');
			if (regex.kind === 'ok') {
				regex.test('');
				regex.test('\u0100');
				return regex.test;
			}
		} catch (error) {
			if (!beyondHost(error)) throw error;
		}
		this.broken = true;
		return null;
	}

	/** `re.fullmatch(pattern, subject)` for a pattern of this metamodel. */
	fullmatch(pattern: string, subject: string): boolean {
		const test = this.tests.get(pattern);
		if (test === undefined) throw new Error(`pattern ${JSON.stringify(pattern)} was not compiled`);
		if (test === null) throw new PatternUnusable();
		try {
			return test(subject);
		} catch (error) {
			if (!beyondHost(error)) throw error;
			this.tests.set(pattern, null);
			this.broken = true;
			throw new PatternUnusable();
		}
	}
}

function stamp(out: Issue[], from: number, checkName: string): void {
	for (let i = from; i < out.length; i++) if (out[i]!.check === '') out[i]!.check = checkName;
}

/**
 * The pipeline over a scope of ids: each id once, its first occurrence
 * deciding the order; an element runs every element hook, a relationship
 * every relationship hook, an id naming nothing is skipped; then every global
 * hook, in validator order. With `rules`, a `RulesValidator` over them runs
 * seventh.
 */
export function validateScoped(
	model: Model,
	ids: Iterable<string>,
	v: Validators,
	p: FacetPatterns,
	rules: CompiledRules | null = null
): Issue[] {
	if (v.metamodel !== model.metamodel || p.metamodel !== model.metamodel) {
		throw new Error('validators built for another metamodel');
	}
	const list: readonly Validator[] =
		rules === null ? v.list : [...v.list, new RulesValidator(rules)];
	const scope = [...new Set(ids)];
	const run: Run = { model, patterns: p, out: [] };
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
	for (const validator of list) {
		const from = out.length;
		validator.validateGlobal?.(run, scope);
		stamp(out, from, validator.checkName);
	}
	return out;
}
