import type { Metamodel } from '../../metamodel/metamodel.ts';
import { getProp, type ElementRec, type Props, type RelRec } from '../../model/records.ts';
import { pyRepr, pyReprValue } from '../../value/repr.ts';
import type { Value } from '../../value/types.ts';
import { errorIssue } from '../issue.ts';
import type { Run, Validator } from '../pipeline.ts';
import { valueConforms } from '../values.ts';

type Def = { datatype: string; isReference: boolean };

/**
 * Every value of a declared property against its datatype; an element-typed
 * property must name an element of that type or a subtype. An entity of a
 * type the metamodel lacks gets that one issue and nothing else.
 */
export class TypeConformance implements Validator {
	readonly checkName = 'type_conformance';
	private readonly mm: Metamodel;
	private readonly elementDefs = new Map<string, Map<string, Def>>();
	private readonly relationshipDefs = new Map<string, Map<string, Def>>();

	constructor(mm: Metamodel) {
		this.mm = mm;
	}

	private defs(typeName: string, ofElement: boolean): Map<string, Def> {
		const cache = ofElement ? this.elementDefs : this.relationshipDefs;
		let defs = cache.get(typeName);
		if (defs === undefined) {
			const mm = this.mm;
			const props = ofElement
				? mm.effectiveElementProperties(typeName)
				: mm.effectiveRelationshipProperties(typeName);
			defs = new Map(
				props.map((p) => [
					p.name,
					{ datatype: p.datatype, isReference: mm.isElementType(p.datatype) }
				])
			);
			cache.set(typeName, defs);
		}
		return defs;
	}

	validateElement(run: Run, el: ElementRec): void {
		if (this.mm.elementType(el.typeName) === undefined) {
			run.out.push(unknownType(el.id, el.typeName));
			return;
		}
		this.check(run, el.typeName, el.id, this.defs(el.typeName, true), el.props);
	}

	validateRelationship(run: Run, rel: RelRec): void {
		if (this.mm.relationshipType(rel.typeName) === undefined) {
			run.out.push(unknownType(rel.id, rel.typeName));
			return;
		}
		this.check(run, rel.typeName, rel.id, this.defs(rel.typeName, false), rel.props);
	}

	private check(
		run: Run,
		typeName: string,
		ownerId: string,
		defs: Map<string, Def>,
		props: Props
	): void {
		for (const name of Object.keys(props)) {
			const def = defs.get(name);
			const value = getProp(props, name)!;
			if (def === undefined || value === null) continue;
			const items = Array.isArray(value) ? value : [value];
			for (const item of items) {
				if (def.isReference) this.reference(run, typeName, ownerId, name, item, def.datatype);
				else if (!valueConforms(item, def.datatype, this.mm)) {
					run.out.push(
						errorIssue(
							`${typeName}.${name}: value ${pyReprValue(item)} is not a valid ${def.datatype}`,
							[ownerId]
						)
					);
				}
			}
		}
	}

	private reference(
		run: Run,
		typeName: string,
		ownerId: string,
		prop: string,
		item: Value,
		declared: string
	): void {
		if (typeof item !== 'string') {
			run.out.push(
				errorIssue(
					`${typeName}.${prop}: value ${pyReprValue(item)} is not a valid ${declared} reference`,
					[ownerId]
				)
			);
			return;
		}
		const target = run.model.findElement(item);
		if (target === undefined) {
			run.out.push(
				errorIssue(
					`${typeName}.${prop}: reference ${pyRepr(item)} points to no element`,
					[ownerId],
					'structural'
				)
			);
			return;
		}
		if (target.typeName !== declared && !this.mm.isElementSubtype(target.typeName, declared)) {
			run.out.push(
				errorIssue(
					`${typeName}.${prop}: reference ${pyRepr(item)} is ${target.typeName}, ` +
						`expected ${declared} or subtype`,
					[ownerId]
				)
			);
		}
	}
}

function unknownType(id: string, typeName: string) {
	return errorIssue(`${id} is an instance of unknown type ${pyRepr(typeName)}`, [id]);
}
