import { setActiveProject } from '$lib/state/active-project.svelte';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = ({ params }) => {
	// Point the project-scoped API base URL at this project BEFORE the page's
	// onMount boot() runs its first project-scoped fetch. Runs for the entire
	// /p/[projectId] subtree (workspace AND /compare) so direct-link / hard-
	// refresh on any child route also sets the active project.
	setActiveProject(params.projectId);
	return { projectId: params.projectId };
};
