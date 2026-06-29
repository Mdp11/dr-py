/**
 * Mid-session 401 recovery. The route guard (routes/+layout.ts) only runs on
 * navigation, so a cookie that expires WHILE the workspace is open leaves the
 * user stuck: every REST call 401s, callers swallow it, and the feed 4401-loops.
 * This module bridges that gap by registering a global 401 handler on the api
 * client (the `setUnauthorizedHandler` seam — the api layer never imports state,
 * so the dependency is injected this way) that tears the session down and
 * bounces to /login.
 *
 * CRITICAL: the handler is a NO-OP when no user is logged in. That is what tells
 * a real mid-session expiry (current user present → bounce) apart from a normal
 * login-attempt 401 ("Invalid email or password." shown locally by LoginForm)
 * or the boot `fetchMe()` 401 (not-logged-in → the guard already routes to
 * /login). The ApiError is still thrown by the client either way, so those local
 * catch blocks are untouched.
 */

import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { setUnauthorizedHandler } from '$lib/api/client';
import { getCurrentUser, signOut } from './auth.svelte';
import { clearActiveProject } from './active-project.svelte';
import { stopRealtime } from './realtime.svelte';

// Re-entrancy guard: signOut() itself issues a request that may 401, which would
// re-enter this handler. The flag (plus the no-user no-op once the store clears)
// prevents a double bounce.
let _recovering = false;

/** Tear down an expired session and bounce to /login. No-op when logged out. */
export async function recoverFromUnauthorized(): Promise<void> {
	if (_recovering) return;
	if (getCurrentUser() === null) return; // not a mid-session expiry
	_recovering = true;
	try {
		stopRealtime();
		clearActiveProject();
		// signOut clears the auth store (adopt(null)) in its finally even if the
		// network logout 401s; swallow any throw so the redirect still happens.
		await signOut().catch(() => {});
		await goto(resolve('/login'));
	} finally {
		_recovering = false;
	}
}

/** Register {@link recoverFromUnauthorized} as the client's global 401 handler.
 * Called once on app load (routes/+layout.svelte). Idempotent: re-registering
 * just replaces the same handler. */
export function installSessionRecovery(): void {
	setUnauthorizedHandler(() => void recoverFromUnauthorized());
}
