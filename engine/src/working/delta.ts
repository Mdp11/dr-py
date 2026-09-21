import { SnapshotError } from '../model/errors.ts';
import { asEntity, readProps, readRev, requireStr } from '../model/load.ts';
import type { Props } from '../model/records.ts';
import { parseJson } from '../value/parse.ts';
import { PyFloat, type Value } from '../value/types.ts';

/**
 * What a replica reads of a commit delta, in the wire's names. `changed_*`
 * hold whole entities as committed, in first-touch order; `deleted_*` name
 * every entity the commit removed, cascades included; `recreated_*` name the
 * changed entities the commit deleted and created again under their ids.
 */
export type Delta = {
	rev: number;
	prev_rev: number;
	state_digest: string;
	changed_elements: readonly Value[];
	changed_relationships: readonly Value[];
	deleted_element_ids: readonly string[];
	deleted_relationship_ids: readonly string[];
	recreated_element_ids: readonly string[];
	recreated_relationship_ids: readonly string[];
};

export type CommittedElement = { id: string; typeName: string; props: Props; rev: number };
export type CommittedRel = CommittedElement & { sourceId: string; targetId: string };

export type CommittedChange = {
	elements: CommittedElement[];
	relationships: CommittedRel[];
	deletedElementIds: readonly string[];
	deletedRelationshipIds: readonly string[];
	recreatedElementIds: readonly string[];
	recreatedRelationshipIds: readonly string[];
};

function readElement(doc: Value, where: string): CommittedElement {
	const entity = asEntity(doc, where);
	return {
		id: requireStr(entity, 'id', where),
		typeName: requireStr(entity, 'type_name', where),
		props: readProps(entity, where),
		rev: readRev(entity, where)
	};
}

function readIds(ids: readonly string[], where: string): readonly string[] {
	if (!Array.isArray(ids)) throw new SnapshotError(`${where}: must be a list`);
	ids.forEach((id, i) => {
		if (typeof id !== 'string') throw new SnapshotError(`${where}[${i}]: must be a string`);
	});
	return ids;
}

/**
 * The delta's entities, checked as the bulk loader checks a snapshot's, with
 * the same refusals. Reading happens before anything is applied, so a delta
 * the replica cannot hold leaves it untouched.
 */
export function readDelta(delta: Delta): CommittedChange {
	return {
		elements: delta.changed_elements.map((doc, i) => readElement(doc, `changed_elements[${i}]`)),
		relationships: delta.changed_relationships.map((doc, i) => {
			const where = `changed_relationships[${i}]`;
			const entity = asEntity(doc, where);
			return {
				...readElement(doc, where),
				sourceId: requireStr(entity, 'source_id', where),
				targetId: requireStr(entity, 'target_id', where)
			};
		}),
		deletedElementIds: readIds(delta.deleted_element_ids, 'deleted_element_ids'),
		deletedRelationshipIds: readIds(delta.deleted_relationship_ids, 'deleted_relationship_ids'),
		recreatedElementIds: readIds(delta.recreated_element_ids, 'recreated_element_ids'),
		recreatedRelationshipIds: readIds(
			delta.recreated_relationship_ids,
			'recreated_relationship_ids'
		)
	};
}

type Doc = { [key: string]: Value };

const DIGEST = /^[0-9a-f]{16}$/;

const isDoc = (value: Value | undefined): value is Doc =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

const isCount = (value: Value | undefined): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

function parse(text: string, what: string): Value {
	try {
		return parseJson(text);
	} catch (caught) {
		throw new SnapshotError(`${what}: ${(caught as Error).message}`);
	}
}

function deltaOf(doc: Value, where: string): Delta {
	if (!isDoc(doc)) throw new SnapshotError(`${where}: must be an object`);
	const field = (key: string) => (Object.hasOwn(doc, key) ? doc[key] : undefined);
	// A commit response names its revision `model_rev`.
	const rev = Object.hasOwn(doc, 'rev') ? doc['rev'] : field('model_rev');
	const prevRev = field('prev_rev');
	const digest = field('state_digest');
	if (!isCount(rev)) throw new SnapshotError(`${where}: rev must be a revision`);
	if (!isCount(prevRev)) throw new SnapshotError(`${where}: prev_rev must be a revision`);
	if (typeof digest !== 'string' || !DIGEST.test(digest)) {
		throw new SnapshotError(`${where}: state_digest must be 16 hex digits`);
	}
	const list = (key: string): Value[] => {
		const value = field(key) ?? [];
		if (!Array.isArray(value)) throw new SnapshotError(`${where}: ${key} must be a list`);
		return value;
	};
	// The id lists' members are checked by `readDelta`, before anything moves.
	return {
		rev,
		prev_rev: prevRev,
		state_digest: digest,
		changed_elements: list('changed_elements'),
		changed_relationships: list('changed_relationships'),
		deleted_element_ids: list('deleted_element_ids') as string[],
		deleted_relationship_ids: list('deleted_relationship_ids') as string[],
		recreated_element_ids: list('recreated_element_ids') as string[],
		recreated_relationship_ids: list('recreated_relationship_ids') as string[]
	};
}

/**
 * A delta as a carrier sent it — a feed event, a commit response, one entry
 * of a tail — read with the exact parser: the host's `JSON.parse` would lose
 * `1.0` and every integer past 2^53, which the digest cannot see. The ids and
 * entities are checked when the delta is applied.
 */
export function readDeltaText(text: string): Delta {
	return deltaOf(parse(text, 'delta'), 'delta');
}

/** The deltas of a complete `/replica/tail` body, in order. */
export function readTailText(text: string): Delta[] {
	const doc = parse(text, 'tail');
	if (!isDoc(doc)) throw new SnapshotError('tail: must be an object');
	if (doc['complete'] !== true) throw new SnapshotError('tail is not complete');
	const deltas = Object.hasOwn(doc, 'deltas') ? doc['deltas'] : undefined;
	if (!Array.isArray(deltas)) throw new SnapshotError('tail: deltas must be a list');
	return deltas.map((delta, i) => deltaOf(delta, `tail deltas[${i}]`));
}
