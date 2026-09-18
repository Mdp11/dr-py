import type { Props } from '../model/records.ts';

/**
 * The model family of the ops protocol, in the server's wire shapes. A create
 * op names its entity by a provisional `temp_id`; `id` asks for a given final
 * id instead of a minted one. A patch is a merge patch one level deep: `null`
 * removes the key, anything else replaces its value.
 */
export type CreateElementOp = {
	kind: 'create_element';
	temp_id: string;
	type_name: string;
	properties?: Props;
	id?: string | null;
};

export type UpdateElementOp = { kind: 'update_element'; id: string; properties_patch: Props };

export type DeleteElementOp = { kind: 'delete_element'; id: string };

export type CreateRelationshipOp = {
	kind: 'create_relationship';
	temp_id: string;
	type_name: string;
	source_id: string;
	target_id: string;
	properties?: Props;
	id?: string | null;
};

export type UpdateRelationshipOp = {
	kind: 'update_relationship';
	id: string;
	properties_patch: Props;
};

export type DeleteRelationshipOp = { kind: 'delete_relationship'; id: string };

export type ModelOp =
	| CreateElementOp
	| UpdateElementOp
	| DeleteElementOp
	| CreateRelationshipOp
	| UpdateRelationshipOp
	| DeleteRelationshipOp;
