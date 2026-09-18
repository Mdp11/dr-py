import { resolveProps } from './resolve.ts';
import type { ModelOp } from './types.ts';

/**
 * The op with every reference to a mapped temp id rewritten — the ids it
 * targets, its ends, its property values. Its own `temp_id` is not a
 * reference, and stays.
 */
export function remapOp(op: ModelOp, idMap: ReadonlyMap<string, string>): ModelOp {
	const id = (value: string) => idMap.get(value) ?? value;
	switch (op.kind) {
		case 'create_element':
			return { ...op, properties: resolveProps(op.properties, idMap) };
		case 'create_relationship':
			return {
				...op,
				source_id: id(op.source_id),
				target_id: id(op.target_id),
				properties: resolveProps(op.properties, idMap)
			};
		case 'update_element':
		case 'update_relationship':
			return { ...op, id: id(op.id), properties_patch: resolveProps(op.properties_patch, idMap) };
		case 'delete_element':
		case 'delete_relationship':
			return { ...op, id: id(op.id) };
	}
}
