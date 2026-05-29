import type { Conflict, Element, ModelOut, Relationship } from '$lib/api/types';
import type { ChangeRequest } from './cr';
import { deepEqual } from './diff';

export type { Conflict } from '$lib/api/types';

export type ApplyResult = { ok: true; model: ModelOut } | { ok: false; conflicts: Conflict[] };

function elementsMatch(a: Element, b: Element): boolean {
	return a.type_name === b.type_name && deepEqual(a.properties, b.properties);
}

function relationshipsMatch(a: Relationship, b: Relationship): boolean {
	return (
		a.type_name === b.type_name &&
		a.source_id === b.source_id &&
		a.target_id === b.target_id &&
		deepEqual(a.properties, b.properties)
	);
}

export function applyChangeRequest(model: ModelOut, cr: ChangeRequest): ApplyResult {
	const conflicts: Conflict[] = [];

	const elementById = new Map<string, Element>(model.elements.map((e) => [e.id, e]));
	const relById = new Map<string, Relationship>(model.relationships.map((r) => [r.id, r]));

	// --- validate elements ---
	for (const added of cr.ops.elements.added) {
		if (elementById.has(added.id)) {
			conflicts.push({
				kind: 'id_exists',
				entity: 'element',
				id: added.id,
				reason: `Element '${added.id}' already exists in model`
			});
		}
	}

	for (const mod of cr.ops.elements.modified) {
		const current = elementById.get(mod.id);
		if (!current) {
			conflicts.push({
				kind: 'missing',
				entity: 'element',
				id: mod.id,
				reason: `Element '${mod.id}' not found in model`
			});
		} else if (!elementsMatch(current, mod.before)) {
			conflicts.push({
				kind: 'before_mismatch',
				entity: 'element',
				id: mod.id,
				reason: `Element '${mod.id}' does not match CR before snapshot`
			});
		}
	}

	for (const deleted of cr.ops.elements.deleted) {
		const current = elementById.get(deleted.id);
		if (!current) {
			conflicts.push({
				kind: 'missing',
				entity: 'element',
				id: deleted.id,
				reason: `Element '${deleted.id}' not found in model`
			});
		} else if (!elementsMatch(current, deleted)) {
			conflicts.push({
				kind: 'before_mismatch',
				entity: 'element',
				id: deleted.id,
				reason: `Element '${deleted.id}' does not match CR deleted snapshot`
			});
		}
	}

	// --- validate relationships ---
	for (const added of cr.ops.relationships.added) {
		if (relById.has(added.id)) {
			conflicts.push({
				kind: 'id_exists',
				entity: 'relationship',
				id: added.id,
				reason: `Relationship '${added.id}' already exists in model`
			});
		}
	}

	for (const mod of cr.ops.relationships.modified) {
		const current = relById.get(mod.id);
		if (!current) {
			conflicts.push({
				kind: 'missing',
				entity: 'relationship',
				id: mod.id,
				reason: `Relationship '${mod.id}' not found in model`
			});
		} else if (!relationshipsMatch(current, mod.before)) {
			conflicts.push({
				kind: 'before_mismatch',
				entity: 'relationship',
				id: mod.id,
				reason: `Relationship '${mod.id}' does not match CR before snapshot`
			});
		}
	}

	for (const deleted of cr.ops.relationships.deleted) {
		const current = relById.get(deleted.id);
		if (!current) {
			conflicts.push({
				kind: 'missing',
				entity: 'relationship',
				id: deleted.id,
				reason: `Relationship '${deleted.id}' not found in model`
			});
		} else if (!relationshipsMatch(current, deleted)) {
			conflicts.push({
				kind: 'before_mismatch',
				entity: 'relationship',
				id: deleted.id,
				reason: `Relationship '${deleted.id}' does not match CR deleted snapshot`
			});
		}
	}

	if (conflicts.length > 0) {
		return { ok: false, conflicts };
	}

	// --- apply elements ---
	const addedElementIds = new Set(cr.ops.elements.added.map((e) => e.id));
	const modifiedElementMap = new Map(cr.ops.elements.modified.map((m) => [m.id, m]));
	const deletedElementIds = new Set(cr.ops.elements.deleted.map((e) => e.id));

	const newElements: Element[] = [];
	for (const e of model.elements) {
		if (deletedElementIds.has(e.id)) continue;
		const mod = modifiedElementMap.get(e.id);
		if (mod) {
			newElements.push({
				...mod.after,
				properties: { ...mod.after.properties },
				rev: e.rev + 1
			});
		} else {
			newElements.push({ ...e, properties: { ...e.properties } });
		}
	}
	for (const added of cr.ops.elements.added) {
		if (addedElementIds.has(added.id)) {
			newElements.push({ ...added, properties: { ...added.properties } });
		}
	}

	// --- apply relationships ---
	const addedRelIds = new Set(cr.ops.relationships.added.map((r) => r.id));
	const modifiedRelMap = new Map(cr.ops.relationships.modified.map((m) => [m.id, m]));
	const deletedRelIds = new Set(cr.ops.relationships.deleted.map((r) => r.id));

	const newRelationships: Relationship[] = [];
	for (const r of model.relationships) {
		if (deletedRelIds.has(r.id)) continue;
		const mod = modifiedRelMap.get(r.id);
		if (mod) {
			newRelationships.push({
				...mod.after,
				properties: { ...mod.after.properties },
				rev: r.rev + 1
			});
		} else {
			newRelationships.push({ ...r, properties: { ...r.properties } });
		}
	}
	for (const added of cr.ops.relationships.added) {
		if (addedRelIds.has(added.id)) {
			newRelationships.push({ ...added, properties: { ...added.properties } });
		}
	}

	return { ok: true, model: { elements: newElements, relationships: newRelationships } };
}
