import { SnapshotError } from '../model/errors.ts';
import { asEntity, readProps, readRev, requireStr } from '../model/load.ts';
import type { Props } from '../model/records.ts';
import type { Value } from '../value/types.ts';

/**
 * What a replica reads of a commit delta, in the wire's names. `changed_*`
 * hold whole entities as committed, in first-touch order; `deleted_*` name
 * every entity the commit removed, cascades included.
 */
export type Delta = {
	rev: number;
	prev_rev: number;
	state_digest: string;
	changed_elements: readonly Value[];
	changed_relationships: readonly Value[];
	deleted_element_ids: readonly string[];
	deleted_relationship_ids: readonly string[];
};

export type CommittedElement = { id: string; typeName: string; props: Props; rev: number };
export type CommittedRel = CommittedElement & { sourceId: string; targetId: string };

export type CommittedChange = {
	elements: CommittedElement[];
	relationships: CommittedRel[];
	deletedElementIds: readonly string[];
	deletedRelationshipIds: readonly string[];
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
		deletedRelationshipIds: readIds(delta.deleted_relationship_ids, 'deleted_relationship_ids')
	};
}
