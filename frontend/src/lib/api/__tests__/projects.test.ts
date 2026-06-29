import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import * as projects from '../projects';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('projects api', () => {
	it('lists projects', async () => {
		server.use(
			http.get('/api/v1/projects', () =>
				HttpResponse.json([{ id: 'p1', name: 'One', role: 'owner' }])
			)
		);
		const ps = await projects.listProjects();
		expect(ps[0]).toEqual({ id: 'p1', name: 'One', role: 'owner' });
	});

	it('creates a project via multipart with name + metamodel', async () => {
		let form: FormData | null = null;
		server.use(
			http.post('/api/v1/projects', async ({ request }) => {
				form = await request.formData();
				return HttpResponse.json({ id: 'p2', name: 'Fresh', role: 'owner' }, { status: 201 });
			})
		);
		const mm = new File(['types: []'], 'mm.yaml', { type: 'application/yaml' });
		const res = await projects.createProject({ name: 'Fresh', metamodel: mm });
		expect(res.id).toBe('p2');
		expect(form!.get('name')).toBe('Fresh');
		expect((form!.get('metamodel') as File).name).toBe('mm.yaml');
	});
});
