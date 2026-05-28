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
	modelName: string,
	filters?: RelationshipFilters,
	cfg?: ClientConfig
): Promise<Relationship[]> {
	return apiFetch(
		`/models/${encodeURIComponent(modelName)}/relationships`,
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
	modelName: string,
	payload: CreateRelationshipRequest,
	cfg?: ClientConfig
): Promise<Relationship> {
	return apiFetch(
		`/models/${encodeURIComponent(modelName)}/relationships`,
		{ method: 'POST', body: payload as unknown as BodyInit, schema: RelationshipSchema },
		cfg
	);
}

export function deleteRelationship(
	modelName: string,
	relationshipId: string,
	cfg?: ClientConfig
): Promise<void> {
	return apiFetch(
		`/models/${encodeURIComponent(modelName)}/relationships/${encodeURIComponent(
			relationshipId
		)}`,
		{ method: 'DELETE' },
		cfg
	);
}
