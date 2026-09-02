import type { ArtifactKind } from '$lib/artifacts/kinds';
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
			/** Requested final id — only proposed batches (CR / compare) set it; the
			 * server reinstates the entity under it or 422s the batch if taken.
			 * `temp_id` stays the batch-internal handle. Manual edits never set it. */
			id?: string;
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
			/** See `create_element.id`. */
			id?: string;
	  }
	| {
			kind: 'update_relationship';
			id: string;
			properties_patch: Record<string, unknown>;
	  }
	| { kind: 'delete_relationship'; id: string };

/**
 * Artifact-content ops — mirror of the backend's
 * ArtifactOpIn (api/schemas.py). Applied to ArtifactRow DB rows by
 * POST /commits, never to the in-memory model; /model/ops rejects them.
 * `update_artifact.payload` is a FULL replacement (omitted = name-only
 * change). The backend's optional `artifact_rev` OCC precondition is
 * deliberately never sent: the art: lease is the concurrency control
 * (CLAUDE.md "Lease rule").
 */
export type ArtifactOp =
	| {
			kind: 'create_artifact';
			temp_id: string;
			artifact_kind: ArtifactKind;
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

/**
 * View-content ops — mirror of the backend's
 * ViewOpIn (api/schemas.py). Applied by POST /commits to the session view
 * blob named by `view_id` (api/view_ops.py), never to the model; /model/ops
 * rejects them. Every op carries `view_id`: a project holds N named views and
 * each client edits its own active one, so the batch — not the session —
 * says which view an op addresses (an unknown id is a 422 at commit).
 * No `view_rev` precondition exists on any of these BY DECISION: the
 * folder:/view: lease is the concurrency control, exactly as `update_artifact`
 * never sends `artifact_rev` (CLAUDE.md "Lease rule").
 * `index` omitted = append (the server clamps + canonicalizes it).
 */
export type ViewOp =
	| {
			kind: 'create_folder';
			view_id: string;
			temp_id: string;
			parent_id: string;
			name: string;
			index?: number;
	  }
	| { kind: 'rename_folder'; view_id: string; id: string; name: string }
	| { kind: 'move_folder'; view_id: string; id: string; to_parent_id: string; index?: number }
	| { kind: 'delete_folder'; view_id: string; id: string }
	| {
			kind: 'place_element';
			view_id: string;
			element_id: string;
			folder_id: string;
			index?: number;
	  }
	| { kind: 'remove_element'; view_id: string; element_id: string; folder_id: string }
	| {
			kind: 'move_element';
			view_id: string;
			element_id: string;
			from_folder_id: string;
			to_folder_id: string;
			index?: number;
	  }
	| {
			kind: 'place_artifact';
			view_id: string;
			artifact_id: string;
			artifact_kind: string;
			folder_id: string;
			index?: number;
	  }
	| { kind: 'remove_artifact'; view_id: string; artifact_id: string; folder_id: string }
	| {
			kind: 'move_artifact';
			view_id: string;
			artifact_id: string;
			from_folder_id: string;
			to_folder_id: string;
			index?: number;
	  };

/**
 * Metamodel-family ops — mirror of the backend's
 * MetamodelOpIn (api/schemas.py). Applied by POST /commits to the session
 * metamodel + metamodel_layouts blob; /model/ops rejects them. At most one
 * rebind per batch (the server hoists it first); `pos: null` removes a
 * layout key.
 */
export type MetamodelOp =
	| { kind: 'metamodel.rebind'; blob: string }
	| { kind: 'metamodel.move_node'; node: string; pos: { x: number; y: number } | null };

/** Model-content ops — the ONLY ops the model store's staged buffer may
 * hold (mirrors the backend's ModelOpIn / assert_never split). */
export type ModelOp = ElementOp | RelationshipOp;

export type Op = ModelOp | ArtifactOp | ViewOp | MetamodelOp;

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

/** Client mirror of api/locking.py's FOLDER_PREFIX (same idiom as `art:`):
 * folder lock targets are REQUESTED with the bare folder id + type:"folder",
 * granted leases come back canonicalized under this namespace, and the
 * checkout registry keys on the canonical form. */
export const FOLDER_RESOURCE_PREFIX = 'folder:';

export function folderResource(folderId: string): string {
	return FOLDER_RESOURCE_PREFIX + folderId;
}

export function isFolderResource(resourceId: string): boolean {
	return resourceId.startsWith(FOLDER_RESOURCE_PREFIX);
}

/** Client mirror of api/locking.py's METAMODEL_RESOURCE (singleton lease).
 * Unlike `art:`/`folder:` this is not a prefix but the whole resource id:
 * there is exactly ONE metamodel per project, so the lease has nothing to be
 * keyed by. Requested as `{resource_id: 'mm', type: 'metamodel'}` and granted
 * back under this same id, so no canonicalization is involved either. */
export const METAMODEL_RESOURCE = 'mm';

/** Client mirror of api/locking.py's VIEW_PREFIX: a view's ROOT-membership
 * lease (top-level folders and root-level artifact refs). Folder ids are
 * uuids, unique across a project's views, so `folder:<id>` needs no view
 * scoping — only the root, which every view has, does. Requested as
 * `{resource_id: <view id>, type: 'view'}`, granted back canonicalized. */
export const VIEW_RESOURCE_PREFIX = 'view:';

export function viewResource(viewId: string): string {
	return VIEW_RESOURCE_PREFIX + viewId;
}

export function isViewResource(resourceId: string): boolean {
	return resourceId.startsWith(VIEW_RESOURCE_PREFIX);
}

/** The view root's fixed folder id (backend core/view/ids.VIEW_ROOT_ID).
 * Element ops may NEVER name it (an unplaced element already renders at the
 * root — "move to root" is remove_element); artifact ops MAY (the root has a
 * real artifacts list). It is NOT a lease target itself: locking the root of
 * view V is the `view:V` lease — see {@link folderLeaseResource}. */
export const VIEW_ROOT_ID = 'root';

/** The canonical lease resource a folder op's container maps to: the view's
 * own `view:` lease for {@link VIEW_ROOT_ID}, `folder:<id>` otherwise. The ONE
 * place this mapping lives — lock targets (edit-gate's `folderTargets`), the
 * commit-time needed-set and the folder release path all go through it. */
export function folderLeaseResource(folderId: string, viewId: string): string {
	return folderId === VIEW_ROOT_ID ? viewResource(viewId) : folderResource(folderId);
}
