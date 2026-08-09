import { z } from 'zod';
import { apiFetch, apiUpload } from './client';

const API = { baseUrl: '/api/v1' };

export const ProjectSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	role: z.enum(['owner', 'editor', 'viewer'])
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export function listProjects(): Promise<ProjectSummary[]> {
	return apiFetch('/projects', { method: 'GET', schema: z.array(ProjectSummarySchema) }, API);
}

export const SkippedArtifactSchema = z.object({ bundle_id: z.string(), reason: z.string() });
export type SkippedArtifact = z.infer<typeof SkippedArtifactSchema>;

//: Extends ProjectSummary with the artifacts the importer reported-and-skipped
// (unregistered kind, invalid payload, duplicate name). Populated ONLY by the
// create route — see src/data_rover/api/routes/projects.py.
export const ProjectCreatedSchema = ProjectSummarySchema.extend({
	skipped_artifacts: z.array(SkippedArtifactSchema).default([])
});
export type ProjectCreated = z.infer<typeof ProjectCreatedSchema>;

export interface CreateProjectInput {
	name: string;
	metamodel: File;
	model?: File | null;
	view?: File | null;
	artifacts?: File | null;
}

export function createProject(
	input: CreateProjectInput,
	onProgress?: (loaded: number, total: number | null) => void
): Promise<ProjectCreated> {
	const form = new FormData();
	form.set('name', input.name);
	form.set('metamodel', input.metamodel);
	if (input.model) form.set('model', input.model);
	if (input.view) form.set('view', input.view);
	if (input.artifacts) form.set('artifacts', input.artifacts);
	// FormData body, uploaded via XHR (apiUpload) so upload progress can drive
	// the overlay; the browser still sets the multipart Content-Type + boundary
	// itself.
	return apiUpload('/projects', { body: form, schema: ProjectCreatedSchema, onProgress }, API);
}

export function deleteProject(id: string): Promise<void> {
	return apiFetch(`/projects/${id}`, { method: 'DELETE' }, API);
}

export function cloneProject(id: string, name?: string): Promise<ProjectSummary> {
	return apiFetch(
		`/projects/${id}/clone`,
		{ method: 'POST', body: name ? { name } : {}, schema: ProjectSummarySchema },
		API
	);
}
