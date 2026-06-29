/**
 * Access-denied notice store. The workspace boot path can discover that the
 * current user is NOT a member of the project they navigated to (the project
 * picker shows an admin every project, even ones they don't belong to, by
 * synthesizing `role=owner` — but `require_membership` 403s when they open one).
 * When that happens the workspace bounces to `/projects`, and this tiny store
 * carries a one-shot message across the redirect so the picker can explain why.
 *
 * It is a plain accessor store (Svelte 5 runes): set on bounce, read-and-clear
 * by the page that renders it.
 */

import { isForbidden } from '$lib/api/errors';

let _notice = $state<string | null>(null);

export function getAccessNotice(): string | null {
	return _notice;
}

export function setAccessNotice(message: string): void {
	_notice = message;
}

export function clearAccessNotice(): void {
	_notice = null;
}

/** Classify-and-react for a boot-time error from the first project-scoped fetch.
 *
 * Only a **403** (not a member) triggers a bounce — a 404 is AMBIGUOUS (unknown
 * project OR an empty-but-mine project whose `GET /metamodel` legitimately 404s
 * "No metamodel loaded"), so 404 and every other error fall through to the
 * caller's existing best-effort handling and MUST NOT bounce.
 *
 * Side effects are injected (`setNotice` / `navigate`) so the decision is
 * unit-testable without mounting the workspace component or a real router.
 * The destination (/projects) is the caller's concern, so `navigate` is
 * parameterless (keeps SvelteKit's typed-route `resolve()` happy at the call
 * site). Returns true iff it bounced (the caller should then stop booting). */
export function reactToBootError(
	err: unknown,
	deps: { setNotice: (message: string) => void; navigate: () => void }
): boolean {
	if (isForbidden(err)) {
		deps.setNotice('You are not a member of this project.');
		deps.navigate();
		return true;
	}
	return false;
}
