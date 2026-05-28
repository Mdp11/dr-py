import type { Element, Relationship } from '$lib/api/types';

/**
 * Snapshot is the mutable shape of a model's working copy.
 * Only includes the bits that ops can change: elements + relationships.
 * The name, metamodel, and rev stay on the baseline ModelOut.
 */
export interface Snapshot {
	elements: Element[];
	relationships: Relationship[];
}

export type ElementOp =
	| {
			kind: 'create_element';
			temp_id: string;
			type_name: string;
			properties: Record<string, unknown>;
	  }
	| {
			kind: 'update_element';
			id: string;
			properties_patch: Record<string, unknown>;
	  }
	| { kind: 'delete_element'; id: string };

/**
 * NOTE: `update_relationship` only patches `properties`. The backend's
 * PATCH /relationships/{id} doesn't allow changing source_id / target_id.
 * To "rewire" a relationship, emit a delete_relationship followed by a
 * create_relationship.
 */
export type RelationshipOp =
	| {
			kind: 'create_relationship';
			temp_id: string;
			type_name: string;
			source_id: string;
			target_id: string;
			properties: Record<string, unknown>;
	  }
	| {
			kind: 'update_relationship';
			id: string;
			properties_patch: Record<string, unknown>;
	  }
	| { kind: 'delete_relationship'; id: string };

export type Op = ElementOp | RelationshipOp;

export const TEMP_ID_PREFIX = 'tmp_';

/**
 * Generate a temporary client-side id of the form `tmp_<11 chars>`.
 * Uses crypto.randomUUID() if available, else a math.random fallback.
 */
export function createTempId(): string {
	const cryptoObj =
		typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
	if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
		// strip dashes, take first 11 chars
		return TEMP_ID_PREFIX + cryptoObj.randomUUID().replace(/-/g, '').slice(0, 11);
	}
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 11; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return TEMP_ID_PREFIX + out;
}

export function isTempId(id: string): boolean {
	return typeof id === 'string' && id.startsWith(TEMP_ID_PREFIX);
}
