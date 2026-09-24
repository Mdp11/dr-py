import type { Metamodel } from '../../metamodel/metamodel.ts';
import { Multiplicity as Mult } from '../../metamodel/multiplicity.ts';
import { getProp, type ElementRec, type Props, type RelRec } from '../../model/records.ts';
import { pyRepr } from '../../value/repr.ts';
import type { Value } from '../../value/types.ts';
import { errorIssue } from '../issue.ts';
import type { Run, Validator } from '../pipeline.ts';

/** A property that can be violated: its name, its declared multiplicity, and that parsed. */
type PropMult = { name: string; spec: string; mult: Mult };

const count = (value: Value | undefined) =>
	value === undefined || value === null ? 0 : Array.isArray(value) ? value.length : 1;

/**
 * The number of values of each property against its multiplicity; then, for
 * an element, the number of its relationships of each exact type against the
 * relationship type's end multiplicities.
 */
export class Multiplicity implements Validator {
	readonly checkName = 'multiplicity';
	private readonly mm: Metamodel;
	private readonly elementMults = new Map<string, PropMult[]>();
	private readonly relationshipMults = new Map<string, PropMult[]>();

	constructor(mm: Metamodel) {
		this.mm = mm;
	}

	private propMults(typeName: string, ofElement: boolean): PropMult[] {
		const cache = ofElement ? this.elementMults : this.relationshipMults;
		let mults = cache.get(typeName);
		if (mults === undefined) {
			const props = ofElement
				? this.mm.effectiveElementProperties(typeName)
				: this.mm.effectiveRelationshipProperties(typeName);
			// `0..*` can never be violated.
			mults = props
				.map((p) => ({ name: p.name, spec: p.multiplicity, mult: Mult.parse(p.multiplicity) }))
				.filter(({ mult }) => mult.lower > 0 || mult.upper !== null);
			cache.set(typeName, mults);
		}
		return mults;
	}

	private checkProps(run: Run, typeName: string, id: string, props: Props, ofElement: boolean) {
		for (const { name, spec, mult } of this.propMults(typeName, ofElement)) {
			const n = count(getProp(props, name));
			if (!mult.countOk(n)) {
				run.out.push(
					errorIssue(`${typeName}.${name}: ${n} value(s) violates multiplicity ${pyRepr(spec)}`, [
						id
					])
				);
			}
		}
	}

	validateElement(run: Run, el: ElementRec): void {
		this.checkProps(run, el.typeName, el.id, el.props, true);
		const indexes = run.model.indexes;
		for (const ec of this.mm.endConstraints(el.typeName)) {
			const rt = this.mm.relationshipType(ec.relTypeName)!;
			if (ec.end === 'target') {
				const n = indexes.countOut(el, ec.relTypeName);
				if (!ec.multiplicity.countOk(n)) {
					run.out.push(
						errorIssue(
							`${ec.relTypeName}: element ${el.id} has ${n} target(s), ` +
								`violates target multiplicity ${pyRepr(rt.target_multiplicity)}`,
							[el.id]
						)
					);
				}
			} else {
				const n = indexes.countIn(el, ec.relTypeName);
				if (!ec.multiplicity.countOk(n)) {
					run.out.push(
						errorIssue(
							`${ec.relTypeName}: element ${el.id} has ${n} source(s), ` +
								`violates source multiplicity ${pyRepr(rt.source_multiplicity)}`,
							[el.id]
						)
					);
				}
			}
		}
	}

	validateRelationship(run: Run, rel: RelRec): void {
		this.checkProps(run, rel.typeName, rel.id, rel.props, false);
	}
}
