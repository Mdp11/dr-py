/**
 * An uploaded model file, read as `POST /model/compare` reads its body:
 * decoded, parsed exactly, then checked for the shape
 * `build_model_from_dicts(strict=False)` requires, in its order and words.
 * What is not UTF-8, or not JSON, is a 422.
 */
import type { Metamodel } from '../metamodel/metamodel.ts';
import { reservedIdText, TEMP_ID_PREFIX } from '../model/load.ts';
import { ReadError } from '../read/errors.ts';
import { utf8Decoder } from '../snapshot/utf8.ts';
import { parseExact } from '../value/parse.ts';
import { pyRepr } from '../value/repr.ts';
import { PyFloat, type Value } from '../value/types.ts';

export type OtherElement = {
	id: string;
	typeName: string;
	props: { [key: string]: Value };
	rev: number | bigint;
};

export type OtherRel = OtherElement & { sourceId: string; targetId: string };

/** The file's entities by id, in file order; elements and relationships keep separate ids. */
export type OtherModel = {
	elements: Map<string, OtherElement>;
	relationships: Map<string, OtherRel>;
};

type Dict = { [key: string]: Value };

const isDict = (value: Value | undefined): value is Dict =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

const own = (entity: Dict, key: string): Value | undefined =>
	Object.hasOwn(entity, key) ? entity[key] : undefined;

const refuse = (detail: string): never => {
	throw new ReadError(422, detail);
};

/** The file as text: UTF-8, strictly, one leading byte order mark dropped. */
export function decodeModelFile(bytes: ArrayBuffer): string {
	let text: string;
	try {
		text = utf8Decoder().decode(new Uint8Array(bytes));
	} catch {
		throw new ReadError(422, 'not a UTF-8 JSON model file');
	}
	return text.startsWith('\ufeff') ? text.slice(1) : text;
}

/** The file's JSON, as `json.loads` reads it: exact numbers, bare constants as text, no raw control character. */
export function parseModelFile(bytes: ArrayBuffer): Value {
	const text = decodeModelFile(bytes);
	try {
		return parseExact(text, { controlCharacters: false });
	} catch (error) {
		// A syntax error, or a nesting too deep for the parser's stack.
		throw new ReadError(422, `invalid JSON: ${error instanceof Error ? error.message : error}`);
	}
}

function entityList(raw: Dict, key: string): Value[] {
	const items = Object.hasOwn(raw, key) ? raw[key]! : [];
	if (!Array.isArray(items)) refuse(`Model payload field ${pyRepr(key)} must be a list`);
	return items as Value[];
}

function requireStr(entity: Dict, key: string, where: string): string {
	const value = own(entity, key);
	if (typeof value !== 'string') refuse(`${where}: field ${pyRepr(key)} must be a string`);
	return value as string;
}

function readProps(entity: Dict, where: string): Dict {
	const props = own(entity, 'properties');
	if (props === undefined || props === null) return {};
	if (!isDict(props)) refuse(`${where}: field 'properties' must be an object`);
	return props as Dict;
}

function readRev(entity: Dict, where: string): number | bigint {
	const rev = Object.hasOwn(entity, 'rev') ? entity['rev'] : 0;
	if (typeof rev !== 'number' && typeof rev !== 'bigint') {
		refuse(`${where}: field 'rev' must be an integer`);
	}
	return rev as number | bigint;
}

/**
 * The file's model, or the 422 the route answers for the first thing wrong
 * with it. Unknown types, extra keys, an id shared by an element and a
 * relationship, a `bigint` rev and any property key are taken as they are;
 * property bags are adopted, not copied.
 */
export function readModelFile(raw: Value, metamodel: Metamodel): OtherModel {
	if (!isDict(raw)) refuse('Model payload must be a JSON object');
	const doc = raw as Dict;
	const elementItems = entityList(doc, 'elements');
	const relationshipItems = entityList(doc, 'relationships');

	const elements = new Map<string, OtherElement>();
	elementItems.forEach((item, n) => {
		const where = `elements[${n}]`;
		if (!isDict(item)) refuse(`${where}: must be an object`);
		const entity = item as Dict;
		const id = requireStr(entity, 'id', where);
		const typeName = requireStr(entity, 'type_name', where);
		if (id.startsWith(TEMP_ID_PREFIX)) refuse(reservedIdText('Element', id));
		if (metamodel.elementType(typeName)?.abstract === true) {
			refuse(`Element type ${pyRepr(typeName)} is abstract and cannot be instantiated`);
		}
		if (elements.has(id)) refuse(`Duplicate element id ${pyRepr(id)} in snapshot`);
		const props = readProps(entity, where);
		elements.set(id, { id, typeName, props, rev: readRev(entity, where) });
	});

	const relationships = new Map<string, OtherRel>();
	relationshipItems.forEach((item, n) => {
		const where = `relationships[${n}]`;
		if (!isDict(item)) refuse(`${where}: must be an object`);
		const entity = item as Dict;
		const id = requireStr(entity, 'id', where);
		const typeName = requireStr(entity, 'type_name', where);
		const sourceId = requireStr(entity, 'source_id', where);
		const targetId = requireStr(entity, 'target_id', where);
		if (id.startsWith(TEMP_ID_PREFIX)) refuse(reservedIdText('Relationship', id));
		if (!elements.has(sourceId)) {
			refuse(`Relationship ${pyRepr(id)} references unknown source ${pyRepr(sourceId)}`);
		}
		if (!elements.has(targetId)) {
			refuse(`Relationship ${pyRepr(id)} references unknown target ${pyRepr(targetId)}`);
		}
		if (relationships.has(id)) refuse(`Duplicate relationship id ${pyRepr(id)} in snapshot`);
		const props = readProps(entity, where);
		relationships.set(id, {
			id,
			typeName,
			sourceId,
			targetId,
			props,
			rev: readRev(entity, where)
		});
	});
	return { elements, relationships };
}
