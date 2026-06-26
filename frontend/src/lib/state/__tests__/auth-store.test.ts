import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import { fetchMe, getCurrentUser, isAdmin } from '../auth.svelte';
import { getCurrentUserId } from '../../api/identity';

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
