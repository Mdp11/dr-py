import { apiFetch, type ClientConfig } from './client';
import {
	RelationshipListSchema,
	RelationshipSchema,
	type CreateRelationshipRequest,
	type Relationship
} from './types';

export interface RelationshipFilters {
	type?: string;
	source_id?: string;
	target_id?: string;
}

export function listRelationships(
	filters?: RelationshipFilters,
	cfg?: ClientConfig
): Promise<Relationship[]> {
	return apiFetch(
		'/model/relationships',
		{
			method: 'GET',
			schema: RelationshipListSchema,
			query: {
				type: filters?.type,
				source_id: filters?.source_id,
				target_id: filters?.target_id
			}
		},
		cfg
	);
}

export function createRelationship(
	payload: CreateRelationshipRequest,
	cfg?: ClientConfig
): Promise<Relationship> {
	return apiFetch(
		'/model/relationships',
		{ method: 'POST', body: payload, schema: RelationshipSchema },
		cfg
	);
}

export function deleteRelationship(relationshipId: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch(
		`/model/relationships/${encodeURIComponent(relationshipId)}`,
		{ method: 'DELETE' },
		cfg
	);
}
