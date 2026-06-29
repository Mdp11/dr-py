import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import * as admin from '../admin';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('admin api', () => {
	it('lists users with a query', async () => {
		let url = '';
		server.use(
			http.get('/api/v1/admin/users', ({ request }) => {
				url = request.url;
				return HttpResponse.json([{ id: 'u1', email: 'a@x', is_admin: false, is_active: true }]);
			})
		);
		const us = await admin.listUsers('a');
		expect(us[0].email).toBe('a@x');
		expect(url).toContain('q=a');
	});

	it('creates and patches a user', async () => {
		server.use(
			http.post('/api/v1/admin/users', () =>
				HttpResponse.json(
					{ id: 'u2', email: 'b@x', is_admin: true, is_active: true },
					{ status: 201 }
				)
			),
			http.patch('/api/v1/admin/users/u2', () =>
				HttpResponse.json({ id: 'u2', email: 'b@x', is_admin: false, is_active: true })
			)
		);
		expect(
			(await admin.createUser({ email: 'b@x', password: 'secret12', is_admin: true })).id
		).toBe('u2');
		expect((await admin.patchUser('u2', { is_admin: false })).is_admin).toBe(false);
	});

	it('adds a member', async () => {
		server.use(
			http.post('/api/v1/admin/projects/p1/members', () =>
				HttpResponse.json({ user_id: 'u1', email: 'a@x', role: 'editor' }, { status: 201 })
			)
		);
		expect((await admin.addMember('p1', 'u1', 'editor')).role).toBe('editor');
	});
});
