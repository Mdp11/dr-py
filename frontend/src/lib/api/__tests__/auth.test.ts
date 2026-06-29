import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import * as auth from '../auth';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('auth api', () => {
	it('login posts credentials to /api/v1/auth/login', async () => {
		let body: unknown;
		server.use(
			http.post('/api/v1/auth/login', async ({ request }) => {
				body = await request.json();
				return HttpResponse.json({ user_id: 'u1', email: 'a@x', is_admin: true });
			})
		);
		const me = await auth.login('a@x', 'pw');
		expect(body).toEqual({ email: 'a@x', password: 'pw' });
		expect(me.is_admin).toBe(true);
	});

	it('me returns the current user', async () => {
		server.use(
			http.get('/api/v1/auth/me', () =>
				HttpResponse.json({ user_id: 'u1', email: 'a@x', is_admin: false })
			)
		);
		expect((await auth.me()).user_id).toBe('u1');
	});
});
