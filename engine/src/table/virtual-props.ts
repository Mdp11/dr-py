/**
 * The properties a property column may name besides the metamodel's own, as
 * `core/table/virtual_props.py` has them. `_Stereotype` reads an element's
 * type name; it is declared on every type, single-valued and read-only.
 */
import type { Metamodel } from '../metamodel/metamodel.ts';
import { getProp, type ElementRec } from '../model/records.ts';
import type { Value } from '../value/types.ts';

export const STEREOTYPE_PROPERTY = '_Stereotype';

export const isVirtualProperty = (name: string): boolean => name === STEREOTYPE_PROPERTY;

/** Whether `typeName` declares `name`; a virtual property always is. */
export function propertyDeclared(mm: Metamodel, typeName: string, name: string): boolean {
	if (isVirtualProperty(name)) return true;
	return mm.effectiveElementProperties(typeName).some((p) => p.name === name);
}

/** The datatype `typeName` declares for `name`; `null` when undeclared or virtual. */
export function propertyDatatype(mm: Metamodel, typeName: string, name: string): string | null {
	if (isVirtualProperty(name)) return null;
	return mm.effectiveElementProperties(typeName).find((p) => p.name === name)?.datatype ?? null;
}

/** Whether `typeName` declares `name` with an element datatype: its values are element ids. */
export function propertyIsElementTyped(mm: Metamodel, typeName: string, name: string): boolean {
	const datatype = propertyDatatype(mm, typeName, name);
	return datatype !== null && mm.isElementType(datatype);
}

/**
 * The stored value of `name` on `element` (`undefined` when unset), or the
 * virtual property's. Declaration is not checked.
 */
export function rawProperty(element: ElementRec, name: string): Value | undefined {
	if (name === STEREOTYPE_PROPERTY) return element.typeName;
	return getProp(element.props, name);
}
