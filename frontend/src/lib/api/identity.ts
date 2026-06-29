/**
 * Current-user identity for the authenticated client.
 *
 * The user id is no longer a dev seam — it is the subject of the logged-in
 * user, set by the auth store after GET /api/v1/auth/me succeeds. The checkout
 * store reads getCurrentUserId() to recognize its OWN lock events on the feed.
 * Requests carry identity via the httpOnly session cookie (see api/client.ts),
 * not headers, so there is nothing to inject here.
 */
let _userId = '';

/** Set the authenticated user's id (called by state/auth.svelte.ts after /me). */
export function setCurrentUserId(id: string): void {
	_userId = id;
}

/** The current user's id as seen by the backend. Empty until login resolves. */
export function getCurrentUserId(): string {
	return _userId;
}
