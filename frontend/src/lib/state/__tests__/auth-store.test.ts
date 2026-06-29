import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import { fetchMe, getCurrentUser, isAdmin, signOut } from '../auth.svelte';
import { getCurrentUserId } from '../../api/identity';
import { getActiveProjectId, setActiveProject } from '../active-project.svelte';
import { stopRealtime } from '../realtime.svelte';

// Partial-mock realtime so we can assert signOut() stops the feed, while
// leaving every other realtime export at its real implementation.
vi.mock('../realtime.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../realtime.svelte')>();
	return { ...actual, stopRealtime: vi.fn() };
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('auth store', () => {
	it('fetchMe populates the current user and the api identity', async () => {
		server.use(
			http.get('/api/v1/auth/me', () =>
				HttpResponse.json({ user_id: 'u9', email: 'z@x', is_admin: true })
			)
		);
		const me = await fetchMe();
		expect(me?.user_id).toBe('u9');
		expect(getCurrentUser()?.email).toBe('z@x');
		expect(isAdmin()).toBe(true);
		expect(getCurrentUserId()).toBe('u9'); // wired into the api identity seam
	});

	it('fetchMe returns null on 401 and leaves no current user', async () => {
		server.use(http.get('/api/v1/auth/me', () => new HttpResponse(null, { status: 401 })));
		expect(await fetchMe()).toBeNull();
		expect(getCurrentUser()).toBeNull();
	});
});

describe('signOut', () => {
	afterEach(() => {
		// Clean up active-project state set by these tests.
		vi.clearAllMocks();
	});

	it('clears the active project in the finally block (even on network success)', async () => {
		server.use(http.post('/api/v1/auth/logout', () => new HttpResponse(null, { status: 204 })));
		setActiveProject('test-project');
		expect(getActiveProjectId()).toBe('test-project');

		await signOut();

		// clearActiveProject() + stopRealtime() must have run in the finally block
		expect(getActiveProjectId()).toBeNull();
		expect(stopRealtime).toHaveBeenCalled();
	});

	it('still clears the active project when logout network call rejects', async () => {
		server.use(http.post('/api/v1/auth/logout', () => HttpResponse.error()));
		setActiveProject('test-project');

		// try/finally re-throws the network error, but the finally block still
		// runs first — so state is torn down despite the throw.
		await expect(signOut()).rejects.toThrow();

		// Despite the throw, active project must be cleared + realtime stopped
		expect(getActiveProjectId()).toBeNull();
		expect(stopRealtime).toHaveBeenCalled();
	});
});
