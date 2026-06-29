import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable current-user the handler self-gates on.
let currentUser: { user_id: string } | null = null;
const signOut = vi.fn();
const stopRealtime = vi.fn();
const clearActiveProject = vi.fn();
const goto = vi.fn();
const setUnauthorizedHandler = vi.fn();

vi.mock('../auth.svelte', () => ({
	getCurrentUser: () => currentUser,
	signOut: (...a: unknown[]) => signOut(...a)
}));
vi.mock('../active-project.svelte', () => ({
	clearActiveProject: (...a: unknown[]) => clearActiveProject(...a)
}));
vi.mock('../realtime.svelte', () => ({ stopRealtime: (...a: unknown[]) => stopRealtime(...a) }));
vi.mock('$lib/api/client', () => ({
	setUnauthorizedHandler: (...a: unknown[]) => setUnauthorizedHandler(...a)
}));
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));

import { installSessionRecovery, recoverFromUnauthorized } from '../session-recovery';

beforeEach(() => {
	currentUser = null;
	vi.clearAllMocks();
	// Default async mocks to resolved promises (the source awaits signOut()/goto()).
	signOut.mockResolvedValue(undefined);
	goto.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('recoverFromUnauthorized', () => {
	it('is a no-op when no user is logged in (login/boot 401s)', async () => {
		currentUser = null;
		await recoverFromUnauthorized();
		expect(stopRealtime).not.toHaveBeenCalled();
		expect(clearActiveProject).not.toHaveBeenCalled();
		expect(signOut).not.toHaveBeenCalled();
		expect(goto).not.toHaveBeenCalled();
	});

	it('tears down the session and bounces to /login when a user is present', async () => {
		currentUser = { user_id: 'u1' };
		await recoverFromUnauthorized();
		expect(stopRealtime).toHaveBeenCalledTimes(1);
		expect(clearActiveProject).toHaveBeenCalledTimes(1);
		expect(signOut).toHaveBeenCalledTimes(1);
		expect(goto).toHaveBeenCalledWith('/login'); // resolve() is identity in the test stub
	});

	it('swallows a signOut rejection but still redirects', async () => {
		currentUser = { user_id: 'u1' };
		signOut.mockRejectedValueOnce(new Error('logout 401'));
		await recoverFromUnauthorized();
		expect(goto).toHaveBeenCalledWith('/login');
	});
});

describe('installSessionRecovery', () => {
	it('registers a 401 handler on the client exactly once per call', () => {
		installSessionRecovery();
		expect(setUnauthorizedHandler).toHaveBeenCalledTimes(1);
		expect(setUnauthorizedHandler.mock.calls[0][0]).toBeTypeOf('function');
	});
});
