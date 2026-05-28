import type { Element, ModelOut, Relationship } from '$lib/api/types';
import { ApiError } from '../api/errors';
import * as model from '../api/model';
import { isTempId, type Snapshot } from './ops';

export type SaveResult =
	| { ok: true; model: ModelOut }
	| { ok: false; kind: 'api' | 'tempid' | 'cr'; message: string };

/**
 * Resolve every `tmp_*` id in `working` into a freshly generated id and
 * rewrite any references (relationship endpoints + property values that
 * exactly match a temp id) using that mapping.
 *
 * Pure: does not mutate `working` and does not touch any stores.
 */
export function resolveTempIds(
	working: Snapshot,
	generateId: () => string
): { resolved: Snapshot; mapping: Record<string, string> } {
	const mapping: Record<string, string> = {};

	for (const e of working.elements) {
		if (isTempId(e.id) && !(e.id in mapping)) {
			mapping[e.id] = generateId();
		}
	}
	for (const r of working.relationships) {
		if (isTempId(r.id) && !(r.id in mapping)) {
			mapping[r.id] = generateId();
		}
	}

	const remap = (id: string): string => mapping[id] ?? id;

	const resolvedElements: Element[] = working.elements.map((e) => ({
		...e,
		id: remap(e.id),
		properties: remapProperties(e.properties, mapping)
	}));

	const resolvedRelationships: Relationship[] = working.relationships.map((r) => ({
		...r,
		id: remap(r.id),
		source_id: remap(r.source_id),
		target_id: remap(r.target_id),
		properties: remapProperties(r.properties, mapping)
	}));

	return {
		resolved: { elements: resolvedElements, relationships: resolvedRelationships },
		mapping
	};
}

function remapProperties(
	props: Record<string, unknown>,
	mapping: Record<string, string>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(props)) {
		out[k] = remapValue(v, mapping);
	}
	return out;
}

function remapValue(value: unknown, mapping: Record<string, string>): unknown {
	if (typeof value === 'string') {
		return mapping[value] ?? value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => remapValue(v, mapping));
	}
	return value;
}

function defaultGenerateId(): string {
	const c =
		typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
	if (c && typeof c.randomUUID === 'function') return c.randomUUID();
	return 'id_' + Math.random().toString(36).slice(2, 14);
}

/**
 * Resolve temp ids, push the snapshot to the backend (single session, no
 * concurrency), and return the resolved server model. Pure-ish: only touches
 * the API client. Callers are responsible for refetching state and saving
 * the returned model to a file.
 */
export async function saveCurrentModel(working: Snapshot): Promise<SaveResult> {
	let resolved: Snapshot;
	try {
		resolved = resolveTempIds(working, defaultGenerateId).resolved;
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to resolve temp ids';
		return { ok: false, kind: 'tempid', message };
	}

	try {
		const result = await model.snapshotModel({
			elements: resolved.elements,
			relationships: resolved.relationships
		});
		return { ok: true, model: result };
	} catch (err) {
		if (err instanceof ApiError) {
			return { ok: false, kind: 'api', message: err.message };
		}
		const message = err instanceof Error ? err.message : 'Save failed';
		return { ok: false, kind: 'api', message };
	}
}
