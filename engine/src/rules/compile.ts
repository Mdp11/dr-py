import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Model } from '../model/model.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyRepr } from '../value/repr.ts';
import { readRuleSet, RulesUnreadable, type Condition, type Rule } from './document.ts';
import { derivePaths, type ReversePath } from './reach.ts';

/**
 * The server's parse of one rule set's YAML: the document as JSON text, or
 * the parse error `/rules/lint` gives.
 */
export type RulesParse =
	{ ok: true; document: string } | { ok: false; errors: { message: string }[] };

/** What every rule's check starts with. */
export const RULE_CHECK_PREFIX = 'rule:';

/** One rule set to compile; `parse` is `null` when the artifact arrived without its parse. */
export type RuleSource = { artifactId: string; name: string; parse: RulesParse | null };

/** A rule, or a whole set (`rule` empty), left out of a compile, in the route's field order. */
export type RuleSkip = { artifact_id: string; set_name: string; rule: string; reason: string };

export type CompiledRule = {
	artifactId: string;
	rule: Rule;
	appliesTypes: ReadonlySet<string>;
	check: string;
	paths: readonly ReversePath[];
};

/**
 * Rule sets compiled against one metamodel. Read-only once built, but for
 * `evalErrors`, which each validation run merges its counts into. `identities`
 * lists each compiled rule's `identity`, in order. `unreadable` says a source
 * could not be read: its rules are missing, so the compile must not be used.
 */
export type CompiledRules = {
	readonly rules: readonly CompiledRule[];
	readonly rulesByType: ReadonlyMap<string, readonly CompiledRule[]>;
	readonly skipped: readonly RuleSkip[];
	readonly evalErrors: Map<string, number>;
	readonly total: number;
	readonly identities: readonly string[];
	readonly unreadable: boolean;
};

/** No rules. Its `evalErrors` never moves: a run merges nothing without a rule. */
export const EMPTY_RULES: CompiledRules = {
	rules: [],
	rulesByType: new Map(),
	skipped: [],
	evalErrors: new Map(),
	total: 0,
	identities: [],
	unreadable: false
};

/** The first schema mismatch of the rule, `when` before `then`, or `null`. */
function driftReason(rule: Rule, mm: Metamodel): string | null {
	if (!mm.isElementType(rule.appliesTo)) return `unknown stereotype ${pyRepr(rule.appliesTo)}`;
	// The DECLARED type's properties, not its subtypes': a property only a
	// subtype declares is drift.
	const walk = (cond: Condition, context: string | null): string | null => {
		if ('all' in cond || 'any' in cond) {
			for (const sub of 'all' in cond ? cond.all : cond.any) {
				const reason = walk(sub, context);
				if (reason !== null) return reason;
			}
			return null;
		}
		if ('not' in cond) return walk(cond.not, context);
		if ('property' in cond) {
			if (context !== null && !mm.effectiveElementPropertyNames(context).has(cond.property)) {
				return `stereotype ${pyRepr(context)} has no property ${pyRepr(cond.property)}`;
			}
			return null;
		}
		if (mm.relationshipType(cond.type) === undefined) {
			return `unknown relationship type ${pyRepr(cond.type)}`;
		}
		if (cond.to !== null && !mm.isElementType(cond.to))
			return `unknown stereotype ${pyRepr(cond.to)}`;
		// Without `to`, the far element's properties are not checkable.
		return cond.where === null ? null : walk(cond.where, cond.to);
	};
	for (const cond of [rule.when, rule.then]) {
		const reason = cond === null ? null : walk(cond, rule.appliesTo);
		if (reason !== null) return reason;
	}
	return null;
}

/**
 * `compile_rule_sets`, in the order given: a failed parse is one skip for the
 * whole set; a disabled rule is dropped before the drift check; a drifted
 * rule is skipped whole with its first mismatch. A document the reader
 * refuses, or a source without a parse, marks the compile `unreadable`.
 */
export function compileRuleSets(sources: readonly RuleSource[], mm: Metamodel): CompiledRules {
	const rules: CompiledRule[] = [];
	const skipped: RuleSkip[] = [];
	let unreadable = false;
	for (const { artifactId, name, parse } of sources) {
		if (parse === null) {
			unreadable = true;
			continue;
		}
		if (!parse.ok) {
			const reason = parse.errors[0]?.message;
			if (reason === undefined) unreadable = true;
			else skipped.push({ artifact_id: artifactId, set_name: name, rule: '', reason });
			continue;
		}
		let defined: readonly Rule[];
		try {
			defined = readRuleSet(parse.document).rules;
		} catch (error) {
			if (!(error instanceof RulesUnreadable)) throw error;
			unreadable = true;
			continue;
		}
		for (const rule of defined) {
			if (rule.disabled) continue;
			const reason = driftReason(rule, mm);
			if (reason !== null) {
				skipped.push({ artifact_id: artifactId, set_name: name, rule: rule.name, reason });
				continue;
			}
			rules.push({
				artifactId,
				rule,
				appliesTypes: mm.elementDescendants(rule.appliesTo),
				check: `${RULE_CHECK_PREFIX}${rule.name}`,
				paths: derivePaths(rule, mm)
			});
		}
	}
	const rulesByType = new Map<string, CompiledRule[]>();
	for (const cr of rules) {
		for (const type of [...cr.appliesTypes].sort(cmpCodePoint)) {
			const list = rulesByType.get(type);
			if (list === undefined) rulesByType.set(type, [cr]);
			else list.push(cr);
		}
	}
	return {
		rules,
		rulesByType,
		skipped,
		evalErrors: new Map(),
		total: rules.length,
		identities: rules.map((cr) => cr.rule.identity),
		unreadable
	};
}

/**
 * Every element a rule of `compiled` applies to: the applies types, sorted,
 * each type's own elements sorted, first-seen order.
 */
export function appliesPopulation(
	model: Model,
	...compiled: readonly Pick<CompiledRules, 'rules'>[]
): string[] {
	const types = new Set<string>();
	for (const c of compiled)
		for (const cr of c.rules) for (const type of cr.appliesTypes) types.add(type);
	const out = new Set<string>();
	for (const type of [...types].sort(cmpCodePoint)) {
		const members = model.indexes.byType.get(type);
		if (members === undefined) continue;
		for (const id of [...members].map((el) => el.id).sort(cmpCodePoint)) out.add(id);
	}
	return [...out];
}
