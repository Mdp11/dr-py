import type { Metamodel } from '../../metamodel/metamodel.ts';
import { getProp, type ElementRec } from '../../model/records.ts';
import { cmpCodePoint } from '../../value/compare.ts';
import { errorIssue } from '../issue.ts';
import type { Run, Validator } from '../pipeline.ts';
import { pyReprFrozen } from '../values.ts';

/**
 * Elements sharing an identity (the model's uniqueness groups). A scoped
 * element in a group of two or more that is not its primary — the member
 * with the least `ord` — is reported against the primary, its identity
 * rendered from its OWN key: members are equal as Python compares values,
 * not in how they render (`1`, `1.0` and `True`).
 */
export class Uniqueness implements Validator {
	readonly checkName = 'uniqueness';
	private readonly mm: Metamodel;

	constructor(mm: Metamodel) {
		this.mm = mm;
	}

	validateGlobal(run: Run, scope: readonly string[]): void {
		const indexes = run.model.indexes;
		// Uniqueness key → the group's primary, so that a group is gathered once a run.
		const primaries = new Map<string, ElementRec>();
		for (const id of scope) {
			const el = run.model.findElement(id);
			// Alone in its bucket, an element is alone in its group.
			if (el === undefined || !(indexes.buckets.get(el.uniq) instanceof Set)) continue;
			const key = indexes.uniqKey(el);
			let primary = primaries.get(key);
			if (primary === undefined) {
				primary = el;
				for (const member of indexes.uniqGroupOf(el)) {
					if (member.ord < primary.ord) primary = member;
				}
				primaries.set(key, primary);
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
