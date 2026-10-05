import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelOp } from '$engine';
import { createEngineSeam } from '$lib/engine/seam';
import {
	fakeProject,
	ready,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import type { AdvancedQuery } from '$lib/search/types';
import { installEngineSeam } from '../engine-route';
import { ValidationError } from '../errors';
import { searchModel } from '../model-read';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('searchModel on the engine', () => {
	const made: ReturnType<typeof syncOver>[] = [];

	afterEach(() => {
		installEngineSeam(null);
		for (const over of made.splice(0)) over.dispose();
	});

	/**
	 * A ready replica of `project` behind an installed seam, whose `call` is
	 * spied on. MSW holds the replica's own routes and no search route: a
	 * search that strays to the server fails the test.
	 */
	async function over(project: FakeProject) {
		server.use(...project.handlers());
		const replica = syncOver(project);
		made.push(replica);
		replica.sync.open(project.projectId);
		await replica.sync.settled();
		expect(replica.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
		const call = vi.fn(
			(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
				replica.sync.call(method, params, options)
		);
		installEngineSeam(createEngineSeam({ call: call as typeof replica.sync.call }, ready));
		return { replica, call };
	}

	const stage = (replica: ReturnType<typeof syncOver>, ops: ModelOp[]) =>
		replica.sync.call('stage', { ops }, { transition: true });

	const named = (value: string): AdvancedQuery => ({
		target: 'element',
		criteria: [{ type: 'property', name: 'name', op: 'equals', value }]
	});

	it('a staged property edit is found', async () => {
		const project = fakeProject();
		const { replica, call } = await over(project);
		await stage(replica, [
			{ kind: 'update_element', id: 'e_000001', properties_patch: { name: 'Staged only' } }
		]);

		const page = await searchModel(named('Staged only'), { limit: 10 });

		expect(page.total).toBe(1);
		expect(page.elements.map((element) => element.id)).toEqual(['e_000001']);
		expect(page.elements[0]!.properties['name']).toBe('Staged only');
		expect(call).toHaveBeenLastCalledWith(
			'searchModel',
			{ ...named('Staged only'), limit: 10 },
			{}
		);
	});

	it('criteria held in a proxy are sent as plain JSON', async () => {
		const project = fakeProject();
		const { call } = await over(project);
		const query = named(String(project.model.getElement('e_000001').props['name']));

		const page = await searchModel({ target: 'element', criteria: new Proxy(query.criteria, {}) });

		expect(page.elements.map((element) => element.id)).toContain('e_000001');
		expect(call).toHaveBeenLastCalledWith('searchModel', query, {});
	});

	it('a pattern the engine cannot translate is a 422 that names the construct', async () => {
		const project = fakeProject();
		const { call } = await over(project);
		const query: AdvancedQuery = {
			target: 'element',
			criteria: [{ type: 'property', name: 'name', op: 'matches', value: '(?x)a' }]
		};

		const refused = searchModel(query, { offset: 0 });

		await expect(refused).rejects.toBeInstanceOf(ValidationError);
		await expect(refused).rejects.toMatchObject({ status: 422 });
		await expect(refused).rejects.toThrow(/inline flags/);
		expect(call).toHaveBeenCalledOnce();
	});
});
