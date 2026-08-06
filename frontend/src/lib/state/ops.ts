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

/**
 * Artifact-content ops (artefacts revamp Phase 1) — mirror of the backend's
 * ArtifactOpIn (api/schemas.py). Applied to ArtifactRow DB rows by
 * POST /commits, never to the in-memory model; /model/ops rejects them.
 * `update_artifact.payload` is a FULL replacement (omitted = name-only
 * change). The backend's optional `artifact_rev` OCC precondition is
 * deliberately never sent: the art: lease is the concurrency control
 * (CLAUDE.md "Lease rule"); OCC-on-ops is a deferred follow-up.
 */
export type ArtifactOp =
	| {
			kind: 'create_artifact';
			temp_id: string;
			artifact_kind: 'navigation' | 'table' | 'code_snippet';
			name: string;
			payload: Record<string, unknown>;
	  }
	| {
			kind: 'update_artifact';
			id: string;
			name?: string;
			payload?: Record<string, unknown>;
	  }
	| { kind: 'delete_artifact'; id: string };

/** Model-content ops — the ONLY ops the model store's staged buffer may
 * hold (mirrors the backend's ModelOpIn / assert_never split). */
export type ModelOp = ElementOp | RelationshipOp;

export type Op = ModelOp | ArtifactOp;

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

/** Client mirror of api/locking.py's ARTIFACT_PREFIX: artifact lock targets
 * are REQUESTED with the bare id + `type: "artifact"`, but granted leases
 * come back canonicalized under this namespace, and the checkout registry
 * keys on the canonical form. Elements stay bare (existing badges depend on it). */
export const ARTIFACT_RESOURCE_PREFIX = 'art:';

export function artifactResource(artifactId: string): string {
	return ARTIFACT_RESOURCE_PREFIX + artifactId;
}

export function isArtifactResource(resourceId: string): boolean {
	return resourceId.startsWith(ARTIFACT_RESOURCE_PREFIX);
}
