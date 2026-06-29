import * as authApi from '$lib/api/auth';
import type { Me } from '$lib/api/auth';
import { setCurrentUserId } from '$lib/api/identity';
import { isUnauthorized } from '$lib/api/errors';
import { clearActiveProject } from './active-project.svelte';
import { stopRealtime } from './realtime.svelte';

let current = $state<Me | null>(null);

/** The authenticated user, or null when not logged in. */
export function getCurrentUser(): Me | null {
	return current;
}

export function isAdmin(): boolean {
	return current?.is_admin === true;
}

function adopt(me: Me | null): void {
	current = me;
	setCurrentUserId(me?.user_id ?? '');
}

/** Fetch /auth/me; returns the user or null on 401. Populates the store + the
 * api identity seam so the checkout store can recognize its own lock events. */
export async function fetchMe(): Promise<Me | null> {
	try {
		const me = await authApi.me();
		adopt(me);
		return me;
	} catch (err) {
		if (isUnauthorized(err)) {
			adopt(null);
			return null;
		}
		throw err;
	}
}

export async function signIn(email: string, password: string): Promise<void> {
	adopt(await authApi.login(email, password));
}

export async function signOut(): Promise<void> {
	try {
		await authApi.logout();
	} finally {
		adopt(null);
		// Tidy up in-browser session state so the feed and project context are
		// cleared even if the caller didn't (e.g. an explicit sign-out button).
		// session-recovery.ts also calls these before signOut — that becomes
		// idempotent (both paths are safe to call in succession).
		clearActiveProject();
		stopRealtime();
	}
}
