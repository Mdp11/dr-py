/**
 * Dev-only identity seam.
 *
 * In production a gateway injects the real identity and these headers are
 * dropped; a real auth integration replaces this module. For local development
 * the backend's DevHeaderIdentityProvider trusts the `x-user-id` header (and
 * `?x-user-id=` query param on the WebSocket feed), so to exercise multi-user
 * interaction on one machine we let each browser session pick its own identity:
 *
 *   - `?user=<id>` in the URL selects the user and is persisted to localStorage
 *     (so it survives client-side navigation that drops the query string);
 *   - otherwise the last-used value from localStorage;
 *   - otherwise `default-user` (the dev-seed project owner).
 *
 * Open `http://localhost:5173/?user=alice` in one browser profile and
 * `?user=bob` in another to act as two different users. Email is cosmetic
 * (the dev provider keys on the id only) and derived as `<id>@example.com`.
 *
 * The id is resolved once at module load, so it is stable for the lifetime of
 * the page — exactly the lifetime of a feed connection and the checkout token.
 */
const DEFAULT_USER_ID = 'default-user';
const STORAGE_KEY = 'data-rover:dev-user-id';

/** Resolve the dev identity from `?user=`, then localStorage, then the default.
 * Exported for tests; app code uses the resolved {@link DEV_USER_ID}. */
export function resolveDevUserId(): string {
	if (typeof window === 'undefined') return DEFAULT_USER_ID; // SSR / non-browser
	let fromQuery: string | null;
	try {
		fromQuery = new URLSearchParams(window.location.search).get('user');
	} catch {
		fromQuery = null;
	}
	if (fromQuery) {
		try {
			window.localStorage.setItem(STORAGE_KEY, fromQuery);
		} catch {
			/* localStorage unavailable (private mode) — fall through with the query value */
		}
		return fromQuery;
	}
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		if (stored) return stored;
	} catch {
		/* ignore */
	}
	return DEFAULT_USER_ID;
}

export const DEV_USER_ID: string = resolveDevUserId();
export const DEV_USER_EMAIL = `${DEV_USER_ID}@example.com`;

export const DEV_IDENTITY_HEADERS: Record<string, string> = {
	'x-user-id': DEV_USER_ID,
	'x-user-email': DEV_USER_EMAIL
};

/** The current user's id as seen by the backend (dev seam). Used by the
 * checkout store to recognize its OWN lock events in the feed. */
export function getCurrentUserId(): string {
	return DEV_USER_ID;
}
