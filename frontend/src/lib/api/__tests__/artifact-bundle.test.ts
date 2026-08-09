import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { ConflictError } from '../errors';
import {
	exportBundle,
	exportPreview,
	importConfirm,
	importPlan,
	parseBundleText,
	StalePlanImportError,
	type ArtifactBundle
} from '../artifact-bundle';

const BASE = 'http://api.test/api/v1/projects/p1';
const CFG = { baseUrl: BASE };

const BUNDLE: ArtifactBundle = {
	format: 'datarover.artifact-bundle/v1',
	exported_at: '2026-08-09T00:00:00Z',
	source_project: { id: 'src', name: 'Source' },
	roots: ['n1'],
	artifacts: [{ id: 'n1', kind: 'navigation', name: 'Routes', payload: {} }]
};

const PLAN = {
	entries: [
		{
			bundle_id: 'n1',
			kind: 'navigation',
			name: 'Routes',
			action: 'reuse',
			existing_id: 'x1',
			copy_name: 'Routes (2)'
		}
	],
	skipped: [{ bundle_id: 'd1', reason: 'unknown kind' }]
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('artifact-bundle api', () => {
	it('posts root ids and parses the export preview', async () => {
		server.use(
			http.post(`${BASE}/artifacts/export/preview`, async ({ request }) => {
				expect(await request.json()).toEqual({ root_ids: ['a1'] });
				return HttpResponse.json({
					artifacts: [{ id: 'a1', kind: 'table', name: 'T' }],
					dangling_refs: ['ghost']
				});
			})
		);
		const res = await exportPreview(['a1'], CFG);
		expect(res.artifacts[0].name).toBe('T');
		expect(res.dangling_refs).toEqual(['ghost']);
	});

	it('returns the raw export response for streaming', async () => {
		server.use(http.post(`${BASE}/artifacts/export`, () => HttpResponse.json(BUNDLE)));
		const resp = await exportBundle(['n1'], CFG);
		expect(resp.ok).toBe(true);
		expect((await resp.json()).format).toBe('datarover.artifact-bundle/v1');
	});

	it('fetches an import plan for a bundle', async () => {
		server.use(http.post(`${BASE}/artifacts/import/plan`, () => HttpResponse.json(PLAN)));
		const plan = await importPlan(BUNDLE, CFG);
		expect(plan.entries[0].action).toBe('reuse');
		expect(plan.skipped[0].reason).toBe('unknown kind');
	});

	it('confirms with snake_case field names and parses the result', async () => {
		server.use(
			http.post(`${BASE}/artifacts/import`, async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				expect(body.copy_names).toEqual({ n1: 'Renamed' });
				expect(body.decisions).toEqual({ n1: 'copy' });
				return HttpResponse.json({
					rev: 7,
					created: [{ bundle_id: 'n1', id: 'new1', name: 'Renamed' }],
					reused: [],
					skipped: []
				});
			})
		);
		const res = await importConfirm(
			{ bundle: BUNDLE, decisions: { n1: 'copy' }, copyNames: { n1: 'Renamed' }, message: '' },
			CFG
		);
		expect(res.rev).toBe(7);
		expect(res.created[0].name).toBe('Renamed');
	});

	it('throws StalePlanImportError on a 409 that carries a fresh plan', async () => {
		server.use(
			http.post(`${BASE}/artifacts/import`, () =>
				HttpResponse.json({ detail: 'import plan is stale: x', plan: PLAN }, { status: 409 })
			)
		);
		const err = await importConfirm(
			{ bundle: BUNDLE, decisions: {}, copyNames: {}, message: '' },
			CFG
		).catch((e) => e);
		expect(err).toBeInstanceOf(StalePlanImportError);
		expect(err.plan.entries[0].bundle_id).toBe('n1');
		expect(err.detail).toContain('stale');
	});

	it('rethrows a plan-less 409 as a plain ConflictError', async () => {
		server.use(
			http.post(`${BASE}/artifacts/import`, () =>
				HttpResponse.json({ detail: 'model_rev conflict', model_rev: 9 }, { status: 409 })
			)
		);
		const err = await importConfirm(
			{ bundle: BUNDLE, decisions: {}, copyNames: {}, message: '' },
			CFG
		).catch((e) => e);
		expect(err).toBeInstanceOf(ConflictError);
		expect(err).not.toBeInstanceOf(StalePlanImportError);
	});

	it('parseBundleText rejects a wrong-format file', () => {
		expect(() => parseBundleText(JSON.stringify({ format: 'nope' }))).toThrow();
		expect(() => parseBundleText('not json')).toThrow();
		expect(parseBundleText(JSON.stringify(BUNDLE)).artifacts).toHaveLength(1);
	});
});
