import { setActiveProject } from '$lib/state/active-project.svelte';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
	// Point the project-scoped API base URL at this project BEFORE the page's
	// onMount boot() runs its first project-scoped fetch.
	setActiveProject(params.projectId);
	return { projectId: params.projectId };
};
