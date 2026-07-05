import { apiFetch, type ClientConfig } from './client';
import {
	ArtifactListSchema,
	ArtifactSchema,
	ChainPageSchema,
	type Artifact,
	type ArtifactList,
	type ChainPage,
	type NavigationDefinition
} from './types';

export function listArtifacts(kind?: string, cfg?: ClientConfig): Promise<ArtifactList> {
	return apiFetch('/artifacts', { method: 'GET', schema: ArtifactListSchema, query: { kind } }, cfg);
}

export function getArtifact(id: string, cfg?: ClientConfig): Promise<Artifact> {
	return apiFetch(`/artifacts/${id}`, { method: 'GET', schema: ArtifactSchema }, cfg);
}

export function createArtifact(
	body: { kind: string; name: string; payload: Record<string, unknown> },
	cfg?: ClientConfig
): Promise<Artifact> {
	return apiFetch('/artifacts', { method: 'POST', body, schema: ArtifactSchema }, cfg);
}

export function updateArtifact(
	id: string,
	body: { artifact_rev: number; name?: string; payload?: Record<string, unknown> },
	cfg?: ClientConfig
): Promise<Artifact> {
	return apiFetch(`/artifacts/${id}`, { method: 'PUT', body, schema: ArtifactSchema }, cfg);
}

export function deleteArtifact(id: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch(`/artifacts/${id}`, { method: 'DELETE' }, cfg);
}

export function evaluateNavigation(
	body: {
		definition?: NavigationDefinition;
		artifact_id?: string;
		limit?: number;
		offset?: number;
	},
	cfg?: ClientConfig
): Promise<ChainPage> {
	return apiFetch('/navigations/evaluate', { method: 'POST', body, schema: ChainPageSchema }, cfg);
}
