/**
 * The ONE selector every issue consumer reads (issues panel, containment
 * tree, diff drawer, inspector relationships list, top bar): the
 * origin-tagged Validate overlay when one is active, else the live committed
 * issue list. Its own module because it imports BOTH stores — folding it
 * into either would create a model ↔ validation import cycle.
 */
import type { Issue } from '$lib/api/types';
import { getLiveIssues } from './model.svelte';
import { getOverlay } from './validation.svelte';

export function getEffectiveIssues(): readonly Issue[] {
	return getOverlay() ?? getLiveIssues();
}
