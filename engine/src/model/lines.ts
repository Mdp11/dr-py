import { pyDumps } from '../value/serialize.ts';
import type { Model } from './model.ts';
import type { ElementRec, RelRec } from './records.ts';

/** The element as one compact JSON line, byte for byte what the server writes. */
export function elementLine(element: ElementRec): string {
	return pyDumps({
		id: element.id,
		type_name: element.typeName,
		properties: element.props,
		rev: element.rev
	});
}

export function relationshipLine(rel: RelRec): string {
	return pyDumps({
		id: rel.id,
		type_name: rel.typeName,
		source_id: rel.source.id,
		target_id: rel.target.id,
		properties: rel.props,
		rev: rel.rev
	});
}

/** Every element, then every relationship, in state order. */
export function modelLines(model: Model): string[] {
	const lines: string[] = [];
	for (const element of model.elements()) lines.push(elementLine(element));
	for (const rel of model.relationships()) lines.push(relationshipLine(rel));
	return lines;
}
