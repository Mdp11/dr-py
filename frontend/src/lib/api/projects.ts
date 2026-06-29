import { z } from 'zod';
import { apiFetch } from './client';

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

export function createProject(input: CreateProjectInput): Promise<ProjectSummary> {
	const form = new FormData();
	form.set('name', input.name);
	form.set('metamodel', input.metamodel);
	if (input.model) form.set('model', input.model);
	if (input.view) form.set('view', input.view);
	// FormData body: apiFetch leaves it as-is (not JSON-stringified) and the
	// browser sets the multipart Content-Type + boundary itself.
	return apiFetch('/projects', { method: 'POST', body: form, schema: ProjectSummarySchema }, API);
}
