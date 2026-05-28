import type { Element, ModelOut, Relationship } from '$lib/api/types';
import type { Op, Snapshot } from './ops';

export class ApplyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ApplyError';
	}
}

/**
 * Apply a sequence of ops onto a baseline ModelOut, producing a new Snapshot.
 *
 * Pure function: does not mutate `baseline` or `ops`. Each op is applied to
 * the result of the previous ones, so later ops can reference temp_ids
 * created earlier in the same batch.
 */
export function apply(baseline: ModelOut, ops: ReadonlyArray<Op>): Snapshot {
	// Shallow-clone the baseline entities so we don't mutate the caller's data.
	const elements: Element[] = baseline.elements.map((e) => ({
		...e,
		properties: { ...e.properties }
	}));
	const relationships: Relationship[] = baseline.relationships.map((r) => ({
		...r,
		properties: { ...r.properties }
	}));

	for (const op of ops) {
		applyOne(elements, relationships, op);
	}

	return { elements, relationships };
}

function applyOne(elements: Element[], relationships: Relationship[], op: Op): void {
	switch (op.kind) {
		case 'create_element': {
			if (elements.some((e) => e.id === op.temp_id)) {
				throw new ApplyError(`duplicate id: ${op.temp_id}`);
			}
			elements.push({
				id: op.temp_id,
				type_name: op.type_name,
				properties: { ...op.properties },
				rev: 0
			});
			return;
		}
		case 'update_element': {
			const idx = elements.findIndex((e) => e.id === op.id);
			if (idx === -1) {
				throw new ApplyError(`unknown element: ${op.id}`);
			}
			elements[idx] = {
				...elements[idx],
				properties: mergePatch(elements[idx].properties, op.properties_patch)
			};
			return;
		}
		case 'delete_element': {
			const idx = elements.findIndex((e) => e.id === op.id);
			if (idx === -1) {
				throw new ApplyError(`unknown element: ${op.id}`);
			}
			elements.splice(idx, 1);
			// Cascade: drop relationships pointing at this element on either end.
			for (let i = relationships.length - 1; i >= 0; i--) {
				const r = relationships[i];
				if (r.source_id === op.id || r.target_id === op.id) {
					relationships.splice(i, 1);
				}
			}
			return;
		}
		case 'create_relationship': {
			if (relationships.some((r) => r.id === op.temp_id)) {
				throw new ApplyError(`duplicate id: ${op.temp_id}`);
			}
			relationships.push({
				id: op.temp_id,
				type_name: op.type_name,
				source_id: op.source_id,
				target_id: op.target_id,
				properties: { ...op.properties },
				rev: 0
			});
			return;
		}
		case 'update_relationship': {
			const idx = relationships.findIndex((r) => r.id === op.id);
			if (idx === -1) {
				throw new ApplyError(`unknown relationship: ${op.id}`);
			}
			relationships[idx] = {
				...relationships[idx],
				properties: mergePatch(relationships[idx].properties, op.properties_patch)
			};
			return;
		}
		case 'delete_relationship': {
			const idx = relationships.findIndex((r) => r.id === op.id);
			if (idx === -1) {
				throw new ApplyError(`unknown relationship: ${op.id}`);
			}
			relationships.splice(idx, 1);
			return;
		}
		default: {
			const _exhaustive: never = op;
			throw new ApplyError(`malformed op: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

/**
 * Shallow-merge `patch` into `base`. Keys set to `null` in the patch are
 * removed from the result. All other keys are overwritten.
 */
function mergePatch(
	base: Record<string, unknown>,
	patch: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete out[key];
		} else {
			out[key] = value;
		}
	}
	return out;
}
