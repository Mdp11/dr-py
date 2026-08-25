/**
 * Folds a server-PROPOSED op batch (a snippet dry run, a CR / compare
 * proposal) into the staged-edits buffer so it becomes indistinguishable
 * from manual edits (optimistic apply, client-side undo, DiffDrawer, commit,
 * lock release). Three concerns the proposer cannot handle:
 *
 * 1. TEMP-ID REMAP — proposers number temp ids per batch (`tmp_1`, ...), so
 *    two staged batches would collide; every batch gets fresh `createTempId()`
 *    ids, rewritten across `temp_id`/`source_id`/`target_id`/`id` AND
 *    ref-shaped property values. A create's `id` HINT (the file's real id,
 *    CR/compare proposals) is not a temp id and rides through untouched.
 * 2. PRE-STATE — update/delete targets may be uncached (the proposer saw the
 *    server model, not the client cache); `emit`'s optimistic journal needs
 *    the entity present, and relationship ops need the rel's source_id for
 *    lock derivation. A proposal that already carries the pre-state passes
 *    it as `prestate` (seeded first, so nothing is fetched); otherwise each
 *    target is fetched.
 * 3. LOCKS — one acquireLocks call per intent group (edit/connect/delete),
 *    mirroring what the manual UI acquires for the same edits. Any refusal
 *    stages NOTHING (already-acquired leases from earlier groups just expire
 *    via TTL — same as a user who locked an element and never edited it).
 */
import type { Element, Relationship } from '$lib/api/types';
import type { LockTargetIn } from '$lib/api/types';
import type { ModelOp } from './ops';
import { createTempId, isTempId } from './ops';
import { remapProperties } from './remap';
import {
	emit,
	ensureElement,
	ensureRelationship,
	getModelRev,
	seedElements,
	seedRelationships
} from './model.svelte';
import { acquireLocks } from './edit-gate';

export type StageOutcome =
	| { ok: true; count: number }
	| { ok: false; reason: 'empty' | 'stale' | 'locks' | 'missing' };

export interface Prestate {
	elements: Element[];
	relationships: Relationship[];
}

export async function stageProposedOps(
	proposed: ModelOp[],
	modelRev: number,
	prestate?: Prestate
): Promise<StageOutcome> {
	if (proposed.length === 0) return { ok: false, reason: 'empty' };
	if (modelRev !== getModelRev()) return { ok: false, reason: 'stale' };

	// 1. Remap proposer temp ids to fresh client temp ids (id hints untouched).
	const mapping: Record<string, string> = {};
	for (const op of proposed) {
		if (op.kind === 'create_element' || op.kind === 'create_relationship') {
			mapping[op.temp_id] = createTempId();
		}
	}
	const mapId = (id: string): string => mapping[id] ?? id;
	const ops: ModelOp[] = proposed.map((op) => {
		switch (op.kind) {
			case 'create_element':
				return {
					...op,
					temp_id: mapping[op.temp_id],
					properties: remapProperties(op.properties, mapping)
				};
			case 'create_relationship':
				return {
					...op,
					temp_id: mapping[op.temp_id],
					source_id: mapId(op.source_id),
					target_id: mapId(op.target_id),
					properties: remapProperties(op.properties, mapping)
				};
			case 'update_element':
			case 'update_relationship':
				return {
					...op,
					id: mapId(op.id),
					properties_patch: remapProperties(op.properties_patch, mapping)
				};
			case 'delete_element':
			case 'delete_relationship':
				return { ...op, id: mapId(op.id) };
		}
	});

	// 2. Pre-state: seed what the proposal carries, fetch the rest.
	if (prestate) {
		seedElements(prestate.elements);
		seedRelationships(prestate.relationships);
	}
	const relSource = new Map<string, string>();
	for (const op of ops) {
		if ((op.kind === 'update_element' || op.kind === 'delete_element') && !isTempId(op.id)) {
			if ((await ensureElement(op.id)) === null) return { ok: false, reason: 'missing' };
		}
		if (
			(op.kind === 'update_relationship' || op.kind === 'delete_relationship') &&
			!isTempId(op.id)
		) {
			const rel = await ensureRelationship(op.id);
			if (rel === null) return { ok: false, reason: 'missing' };
			relSource.set(op.id, rel.source_id);
		}
	}

	// 3. Locks, grouped by intent — the same targets the manual UI acquires:
	//    edit   -> exclusive on updated elements / updated rels' sources
	//    delete -> exclusive on deleted elements / deleted rels' sources
	//    connect-> exclusive source + shared target per created relationship
	const edit = new Map<string, LockTargetIn>();
	const del = new Map<string, LockTargetIn>();
	const connect = new Map<string, LockTargetIn>();
	for (const op of ops) {
		if (op.kind === 'update_element' && !isTempId(op.id)) {
			edit.set(op.id, { resource_id: op.id, mode: 'exclusive' });
		} else if (op.kind === 'delete_element' && !isTempId(op.id)) {
			del.set(op.id, { resource_id: op.id, mode: 'exclusive' });
		} else if (op.kind === 'update_relationship' && !isTempId(op.id)) {
			const src = relSource.get(op.id);
			if (src !== undefined) edit.set(src, { resource_id: src, mode: 'exclusive' });
		} else if (op.kind === 'delete_relationship' && !isTempId(op.id)) {
			const src = relSource.get(op.id);
			if (src !== undefined) del.set(src, { resource_id: src, mode: 'exclusive' });
		} else if (op.kind === 'create_relationship') {
			if (!isTempId(op.source_id))
				connect.set(op.source_id, { resource_id: op.source_id, mode: 'exclusive' });
			if (!isTempId(op.target_id) && !connect.has(op.target_id)) {
				connect.set(op.target_id, { resource_id: op.target_id, mode: 'shared' });
			}
		}
	}
	const groups: Array<[LockTargetIn[], 'edit' | 'delete' | 'connect']> = [
		[[...edit.values()], 'edit'],
		[[...connect.values()], 'connect'],
		[[...del.values()], 'delete']
	];
	for (const [targets, intent] of groups) {
		if (targets.length === 0) continue;
		if (!(await acquireLocks(targets, intent))) return { ok: false, reason: 'locks' };
	}

	// 4. Stage — indistinguishable from manual edits from here on.
	for (const op of ops) emit(op);
	return { ok: true, count: ops.length };
}
