import { setActiveBaseUrl } from '$lib/api/client';

let activeId = $state<string | null>(null);

export function getActiveProjectId(): string | null {
	return activeId;
}

/** Select the active project: tracks the id and points the project-scoped API
 * base URL at it, so every project-scoped apiFetch (which passes no per-call
 * baseUrl) targets /api/v1/projects/{id}. */
export function setActiveProject(id: string): void {
	activeId = id;
	setActiveBaseUrl(`/api/v1/projects/${id}`);
}

export function clearActiveProject(): void {
	activeId = null;
	setActiveBaseUrl(null);
}
