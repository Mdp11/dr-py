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

export interface CreateProjectInput {
	name: string;
	metamodel: File;
	model?: File | null;
	view?: File | null;
}

export function createProject(
	input: CreateProjectInput,
	onProgress?: (loaded: number, total: number | null) => void
): Promise<ProjectSummary> {
	const form = new FormData();
	form.set('name', input.name);
	form.set('metamodel', input.metamodel);
	if (input.model) form.set('model', input.model);
	if (input.view) form.set('view', input.view);
	// FormData body, uploaded via XHR (apiUpload) so upload progress can drive
	// the overlay; the browser still sets the multipart Content-Type + boundary
	// itself.
	return apiUpload('/projects', { body: form, schema: ProjectSummarySchema, onProgress }, API);
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
