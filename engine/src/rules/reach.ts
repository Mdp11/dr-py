import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Model } from '../model/model.ts';
import type { ElementRec } from '../model/records.ts';
import { cmpCodePoint } from '../value/compare.ts';
import type { CompiledRules } from './compile.ts';
import type { Condition, Rule } from './document.ts';

/** One hop of a rule's path, as written: owner to far element. */
export type ReverseStep = {
	relTypes: ReadonlySet<string>;
	direction: 'outgoing' | 'incoming';
	farTypes: ReadonlySet<string> | null;
};

/** The hops from a rule's owner to the far element of one relationship atom, root first. */
export type ReversePath = readonly ReverseStep[];

/** A path per relationship atom of `when` then `then`; a `where` extends its atom's path. */
export function derivePaths(rule: Rule, mm: Metamodel): ReversePath[] {
	const paths: ReversePath[] = [];
	const walk = (cond: Condition, prefix: ReversePath): void => {
		if ('all' in cond) for (const sub of cond.all) walk(sub, prefix);
		else if ('any' in cond) for (const sub of cond.any) walk(sub, prefix);
		else if ('not' in cond) walk(cond.not, prefix);
		else if (!('property' in cond)) {
			const step: ReverseStep = {
				relTypes: mm.relationshipDescendants(cond.type),
				direction: cond.direction,
				farTypes: cond.to === null ? null : mm.elementDescendants(cond.to)
			};
			paths.push([...prefix, step]);
			if (cond.where !== null) walk(cond.where, [...prefix, step]);
		}
	};
	for (const cond of [rule.when, rule.then]) if (cond !== null) walk(cond, []);
	return paths;
}

/** One hop backwards: the elements whose `step` reaches `frontier`. */
function owners(frontier: ReadonlySet<ElementRec>, step: ReverseStep): Set<ElementRec> {
	const out = new Set<ElementRec>();
	for (const el of frontier) {
		if (step.direction === 'outgoing') {
			for (const rel of el.in) if (step.relTypes.has(rel.typeName)) out.add(rel.source);
		} else {
			for (const rel of el.out) if (step.relTypes.has(rel.typeName)) out.add(rel.target);
		}
	}
	return out;
}

const byId = (a: ElementRec, b: ElementRec) => cmpCodePoint(a.id, b.id);

/**
 * The elements whose rule verdicts a change to `dirtyIds` may move: from each
 * dirty element (relationship and deleted ids drop out), every suffix of every
 * rule path is walked backwards, and each element reached whose type the rule
 * applies to is kept, in first-seen order. The far types are never used to
 * filter: a retype on the path must not hide an owner.
 */
export function expandScope(
	model: Model,
	compiled: CompiledRules,
	dirtyIds: Iterable<string>
): string[] {
	if (compiled.rules.length === 0) return [];
	const seeds = new Set<ElementRec>();
	for (const id of dirtyIds) {
		const el = model.findElement(id);
		if (el !== undefined) seeds.add(el);
	}
	if (seeds.size === 0) return [];
	const extra = new Set<string>();
	for (const cr of compiled.rules) {
		for (const steps of cr.paths) {
			for (let d = 1; d <= steps.length; d++) {
				let frontier: ReadonlySet<ElementRec> = seeds;
				for (let i = d - 1; i >= 0; i--) {
					frontier = owners(frontier, steps[i]!);
					if (frontier.size === 0) break;
				}
				for (const el of [...frontier].sort(byId)) {
					if (cr.appliesTypes.has(el.typeName)) extra.add(el.id);
				}
			}
		}
	}
	return [...extra];
}
