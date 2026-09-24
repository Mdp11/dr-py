import type { Metamodel } from '../../metamodel/metamodel.ts';
import type { PropertyDef } from '../../metamodel/types.ts';
import { getProp, type ElementRec, type Props, type RelRec } from '../../model/records.ts';
import { pyFloatRepr } from '../../value/float-repr.ts';
import { pyRepr } from '../../value/repr.ts';
import { PyFloat, type Value } from '../../value/types.ts';
import { errorIssue } from '../issue.ts';
import type { Run, Validator } from '../pipeline.ts';
import { pyStrNumber } from '../values.ts';

/** Python's `len` of a string: code points, a lone surrogate counting one. */
function pyLen(s: string): number {
	let n = s.length;
	for (let i = 0; i < s.length - 1; i++) {
		const unit = s.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				n--;
				i++;
			}
		}
	}
	return n;
}

/**
 * `min` / `max` on every int and float value, `pattern` (a full match) and
 * `max_length` on every string value, whatever the property's datatype. A
 * bound is a float, and renders as one.
 */
export class Facets implements Validator {
	readonly checkName = 'facets';
	private readonly mm: Metamodel;
	private readonly elementDefs = new Map<string, readonly PropertyDef[]>();
	private readonly relationshipDefs = new Map<string, readonly PropertyDef[]>();

	constructor(mm: Metamodel) {
		this.mm = mm;
	}

	/** The type's effective properties that carry a facet; most carry none. */
	private defs(typeName: string, ofElement: boolean): readonly PropertyDef[] {
		const cache = ofElement ? this.elementDefs : this.relationshipDefs;
		let defs = cache.get(typeName);
		if (defs === undefined) {
			const props = ofElement
				? this.mm.effectiveElementProperties(typeName)
				: this.mm.effectiveRelationshipProperties(typeName);
			defs = props.filter(
				(p) => p.min !== null || p.max !== null || p.pattern !== null || p.max_length !== null
			);
			cache.set(typeName, defs);
		}
		return defs;
	}

	validateElement(run: Run, el: ElementRec): void {
		const defs = this.defs(el.typeName, true);
		if (defs.length > 0) this.checkProps(run, el.id, defs, el.props);
	}

	validateRelationship(run: Run, rel: RelRec): void {
		const defs = this.defs(rel.typeName, false);
		if (defs.length > 0) this.checkProps(run, rel.id, defs, rel.props);
	}

	private checkProps(run: Run, ownerId: string, defs: readonly PropertyDef[], props: Props): void {
		for (const def of defs) {
			const value = getProp(props, def.name);
			if (value === undefined || value === null) continue;
			for (const item of Array.isArray(value) ? value : [value])
				this.check(run, ownerId, def, item);
		}
	}

	private check(run: Run, ownerId: string, def: PropertyDef, item: Value): void {
		const { name } = def;
		if (typeof item === 'number' || typeof item === 'bigint' || item instanceof PyFloat) {
			const x = item instanceof PyFloat ? item.value : item;
			if (def.min !== null && x < def.min) {
				run.out.push(
					errorIssue(`${name}: ${pyStrNumber(item)} below min ${pyFloatRepr(def.min)}`, [ownerId])
				);
			}
			if (def.max !== null && x > def.max) {
				run.out.push(
					errorIssue(`${name}: ${pyStrNumber(item)} above max ${pyFloatRepr(def.max)}`, [ownerId])
				);
			}
		}
		if (typeof item === 'string') {
			if (def.pattern !== null && !run.patterns.fullmatch(def.pattern, item)) {
				run.out.push(
					errorIssue(`${name}: ${pyRepr(item)} does not match pattern ${pyRepr(def.pattern)}`, [
						ownerId
					])
				);
			}
			if (def.max_length !== null) {
				const length = pyLen(item);
				if (length > def.max_length) {
					run.out.push(
						errorIssue(`${name}: length ${length} exceeds max_length ${def.max_length}`, [ownerId])
					);
				}
			}
		}
	}
}
