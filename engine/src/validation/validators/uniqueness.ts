import type { Metamodel } from '../../metamodel/metamodel.ts';
import { getProp, type ElementRec } from '../../model/records.ts';
import { cmpCodePoint } from '../../value/compare.ts';
import { errorIssue, type Issue } from '../issue.ts';
import type { Run, Validator, WholeGlobal } from '../pipeline.ts';
import { pyReprFrozen } from '../values.ts';

/**
 * Elements sharing an identity (the model's uniqueness groups). A scoped
 * element in a group of two or more that is not its primary — the member
 * with the least `ord` — is reported against the primary, its identity
 * rendered from its OWN key: members are equal as Python compares values,
 * not in how they render (`1`, `1.0` and `True`). Over the whole model the
 * groups come in their primaries' order, each member after the primary in
 * `ord` order, and every one renders the key of the group's SECOND member:
 * the one whose arrival made the group a duplicate as a rebuild fills it.
 */
export class Uniqueness implements Validator {
	readonly checkName = 'uniqueness';
	private readonly mm: Metamodel;

	constructor(mm: Metamodel) {
		this.mm = mm;
	}

	validateGlobal(run: Run, scope: readonly string[]): void {
		const { model, structure } = run;
		const scoped = new Set<ElementRec>();
		for (const id of scope) {
			const el = model.findElement(id);
			if (el !== undefined) scoped.add(el);
		}
		// Scoped member → its group's primary, so that a group is gathered once a
		// run: a group may cost its whole bucket, and it is not asked per member.
		const primaries = new Map<ElementRec, ElementRec>();
		for (const el of scoped) {
			let primary = primaries.get(el);
			if (primary === undefined) {
				const group = structure.groupOf(el);
				if (group === null || group.length < 2) continue;
				primary = el;
				for (const member of group) if (member.ord < primary.ord) primary = member;
				for (const member of group) if (scoped.has(member)) primaries.set(member, primary);
			}
			if (primary !== el) {
				run.out.push(
					errorIssue(
						`Duplicate ${el.typeName} element ${el.id}: matches ${primary.id} ` +
							`(${this.descriptor(el)})`,
						[el.id, primary.id]
					)
				);
			}
		}
	}

	validateWhole(run: Run, out: Issue[]): WholeGlobal {
		// A group is reported when its first member is met, and only then.
		const met = new Set<ElementRec>();
		return {
			element: (el) => {
				if (met.has(el)) return;
				const group = run.structure.groupOf(el);
				if (group === null || group.length < 2) return;
				const [primary, ...dups] = [...group].sort((a, b) => a.ord - b.ord);
				const identity = this.descriptor(dups[0]!);
				for (const member of group) met.add(member);
				for (const dup of dups) {
					out.push(
						errorIssue(
							`Duplicate ${dup.typeName} element ${dup.id}: matches ${primary!.id} (${identity})`,
							[dup.id, primary!.id]
						)
					);
				}
			}
		};
	}

	private descriptor(el: ElementRec): string {
		const spec = this.mm.effectiveElementKeySpec(el.typeName);
		if (spec === null) return 'no key — all properties match';
		const parts = spec.properties.map(
			(name) => `${name}=${pyReprFrozen(getProp(el.props, name) ?? null)}`
		);
		for (const { relType, direction } of spec.relationships) {
			const ends: string[] = [];
			if (direction === 'out') {
				for (const rel of el.out) if (rel.typeName === relType) ends.push(rel.target.id);
			} else {
				for (const rel of el.in) if (rel.typeName === relType) ends.push(rel.source.id);
			}
			parts.push(`${direction}:${relType}→[${ends.sort(cmpCodePoint).join(', ')}]`);
		}
		return parts.join(', ');
	}
}
