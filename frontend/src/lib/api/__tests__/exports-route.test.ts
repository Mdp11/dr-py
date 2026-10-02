import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
	ArtifactSet,
	drain,
	EVALUATIONS,
	TableOrderCache,
	NO_SCRIPTS,
	ViewPlacements,
	type ReadParams
} from '$engine';
import { createEngineSeam } from '$lib/engine/seam';
import { createShadow } from '$lib/engine/shadow';
import { SURFACES } from '$lib/engine/surfaces';
import {
	fakeProject,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import { utcDate } from '$lib/util/utc-date';
import {
	ExporterDefinitionSchema,
	TableDefinitionSchema,
	type ExporterDefinition,
	type TableDefinition
} from '../types';
import { setActiveBaseUrl, setActiveProjectId } from '../client';
import {
	asSent,
	installEngineSeam,
	type EngineSeam,
	type Side,
	type Surface
} from '../engine-route';
import { runExporter, runExporterDraft } from '../exports';
import { exportTable, previewTableJson, type ExportResult } from '../tables';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const made: ReturnType<typeof syncOver>[] = [];

afterEach(() => {
	installEngineSeam(null);
	setActiveBaseUrl(null);
	setActiveProjectId(null);
	for (const over of made.splice(0)) over.dispose();
});

type Served = { path: string; body: unknown };

/** What the server's export routes answer: a CSV named `served.csv`, truncated. */
const SERVED_TEXT = 'served\r\n';
const SERVED_HEADERS = {
	'content-type': 'text/csv; charset=utf-8',
	'content-disposition': 'attachment; filename="served.csv"',
	'X-Table-Truncated': 'true'
};

/**
 * A ready replica of `project` behind a seam with `exports` on `side` and
 * every other surface on the server; the server's three export routes answer
 * `SERVED_TEXT` (the preview a sample of it) and record each body.
 */
async function over(project: FakeProject, side: Side, shadow?: EngineSeam['shadow']) {
	const served: Served[] = [];
	const record =
		(path: string) =>
		async ({ request }: { request: Request }) => {
			served.push({ path, body: await request.json() });
			return new HttpResponse(SERVED_TEXT, { headers: SERVED_HEADERS });
		};
	server.use(
		...project.handlers(),
		http.post(`${project.baseUrl}/tables/export`, record('/tables/export')),
		http.post(`${project.baseUrl}/exports/run`, record('/exports/run')),
		http.post(`${project.baseUrl}/tables/json-preview`, async ({ request }) => {
			served.push({ path: '/tables/json-preview', body: await request.json() });
			return HttpResponse.json({ sample: '["served"]', truncated: false });
		})
	);
	const replica = syncOver(project);
	made.push(replica);
	replica.sync.open(project.projectId);
	await replica.sync.settled();
	expect(replica.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
	const call = vi.fn(
		(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
			replica.sync.call(method, params, options)
	);
	const surfaces = Object.fromEntries(
		SURFACES.map((surface) => [surface, surface === 'exports' ? side : 'server'])
	) as Record<Surface, Side>;
	installEngineSeam(
		createEngineSeam(
			{ status: () => replica.sync.status(), call: call as typeof replica.sync.call },
			surfaces,
			shadow
		)
	);
	setActiveBaseUrl(project.baseUrl);
	setActiveProjectId(project.projectId);
	return { replica, call, served };
}

/** The element column and the `name` of every element of `type`. */
const namesOf = (type: string): TableDefinition =>
	TableDefinitionSchema.parse({
		row_source: { kind: 'scope', types: [type], criteria: [] },
		columns: [
			{ kind: 'element', source: { kind: 'row', chain_index: 0 } },
			{ kind: 'property', source: { kind: 'row', chain_index: 0 }, name: 'name' }
		],
		sort: [{ column: 1, direction: 'asc' }]
	});

/** A type with more than one page of elements: `e_000031` is one of the 160 people. */
const typeOf = (project: FakeProject) => project.model.getElement('e_000031').typeName;

/** A saved table `t1` over `type` and a saved exporter `x1` of it as CSV, zipped with its manifest. */
function saved(type: string, entry: object = {}) {
	return [
		{ id: 't1', kind: 'table', name: 'People', artifact_rev: 1, payload: asSent(namesOf(type)) },
		{
			id: 'x1',
			kind: 'exporter',
			name: 'Drop',
			artifact_rev: 1,
			payload: asSent(exporter(entry))
		}
	] as { id: string; kind: string; name: string; artifact_rev: number; payload: never }[];
}

const exporter = (entry: object = {}): ExporterDefinition =>
	ExporterDefinitionSchema.parse({
		entries: [{ source: { ref: 't1' }, format: 'csv', ...entry }]
	});

/** What the engine's evaluation `method` answers over the fake's own model and `artifacts`. */
function direct(
	project: FakeProject,
	method: string,
	params: ReadParams,
	artifacts: ReturnType<typeof saved> = []
) {
	const set = new ArtifactSet();
	set.setCommitted(artifacts.map((artifact) => ({ ...artifact, rev: artifact.artifact_rev })));
	const ctx = {
		model: project.model,
		artifacts: set,
		placements: new ViewPlacements(),
		scripts: NO_SCRIPTS,
		working: { rev: project.rev, stagedVersion: 0, tableOrders: new TableOrderCache() }
	};
	return drain(EVALUATIONS[method]!(ctx, params)) as {
		parts?: ArrayBuffer[];
		filename?: string;
		content_type?: string;
		truncated?: boolean;
	};
}

const bytesOf = (parts: readonly ArrayBuffer[]) =>
	new Uint8Array(parts.flatMap((part) => [...new Uint8Array(part)]));

async function blobBytes(result: ExportResult): Promise<Uint8Array> {
	if (result.kind !== 'ready') throw new Error(`not ready: ${JSON.stringify(result)}`);
	return new Uint8Array(await result.blob.arrayBuffer());
}

/** The UTC day, computed apart from `utcDate`. */
const today = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

/** Matches the day a call stamped when `before` was the day it started: that one, or today's. */
const dayFrom = (before: string) => expect.stringMatching(new RegExp(`^(${before}|${today()})$`));

describe('the exports surface on the engine', () => {
	it('exportTable answers the engine’s parts as a Blob, with its name, type and truncated flag', async () => {
		const project = fakeProject();
		const { call, served } = await over(project, 'engine');
		const definition = namesOf(typeOf(project));

		const before = today();
		const result = await exportTable({ definition: new Proxy(definition, {}), format: 'csv' });

		expect(call).toHaveBeenCalledOnce();
		const [method, params] = call.mock.calls[0]!;
		expect(method).toBe('exportTable');
		expect(params).toEqual({
			...(asSent({ definition, format: 'csv' }) as object),
			date: dayFrom(before),
			project: 'p'
		});
		const expected = direct(project, 'exportTable', params as ReadParams);
		expect(await blobBytes(result)).toEqual(bytesOf(expected.parts!));
		expect(result).toMatchObject({
			kind: 'ready',
			filename: expected.filename,
			truncated: expected.truncated
		});
		expect(result.kind === 'ready' && result.blob.type).toBe('text/csv; charset=utf-8');
		expect(result).not.toHaveProperty('fallback');
		expect(served).toEqual([]);
	});

	it('exportTable of a saved table in xlsx is its zip-free workbook, named after the table', async () => {
		const project = fakeProject();
		const { replica, call, served } = await over(project, 'engine');
		const artifacts = saved(typeOf(project));
		replica.sync.setArtifacts(artifacts);

		const before = utcDate();
		const result = await exportTable({ artifactId: 't1' });

		const params = call.mock.calls[0]![1] as ReadParams;
		expect(params).toEqual({
			artifact_id: 't1',
			format: 'xlsx',
			date: dayFrom(before),
			project: 'p'
		});
		const expected = direct(project, 'exportTable', params, artifacts);
		expect(await blobBytes(result)).toEqual(bytesOf(expected.parts!));
		expect(result).toMatchObject({ kind: 'ready', filename: 'People.xlsx', truncated: false });
		expect(result.kind === 'ready' && result.blob.type).toBe(expected.content_type);
		expect(served).toEqual([]);
	});

	it('runExporter and runExporterDraft answer the engine’s zip', async () => {
		const project = fakeProject();
		const { replica, call, served } = await over(project, 'engine');
		const artifacts = saved(typeOf(project));
		replica.sync.setArtifacts(artifacts);

		const before = today();
		const saved1 = await runExporter('x1');
		const draft = await runExporterDraft(exporter({ name: 'Draft' }), 'Drafted');

		const [runParams, draftParams] = call.mock.calls.map(([, params]) => params as ReadParams);
		expect(call.mock.calls.map(([method]) => method)).toEqual(['runExporter', 'runExporterDraft']);
		expect(runParams).toEqual({ artifact_id: 'x1', date: dayFrom(before), project: 'p' });
		expect(draftParams).toEqual({
			definition: asSent(exporter({ name: 'Draft' })),
			name: 'Drafted',
			date: dayFrom(before),
			project: 'p'
		});
		const expectedRun = direct(project, 'runExporter', runParams!, artifacts);
		const expectedDraft = direct(project, 'runExporterDraft', draftParams!, artifacts);
		expect(await blobBytes(saved1)).toEqual(bytesOf(expectedRun.parts!));
		expect(await blobBytes(draft)).toEqual(bytesOf(expectedDraft.parts!));
		expect(saved1).toMatchObject({ kind: 'ready', filename: 'Drop.zip', truncated: false });
		expect(draft).toMatchObject({ kind: 'ready', filename: 'Drafted.zip', truncated: false });
		expect(saved1.kind === 'ready' && saved1.blob.type).toBe('application/zip');
		expect(served).toEqual([]);
	});

	it('previewTableJson answers the engine’s sample', async () => {
		const project = fakeProject();
		const { call, served } = await over(project, 'engine');
		const definition = namesOf(typeOf(project));

		const preview = await previewTableJson({ definition });

		expect(call).toHaveBeenCalledWith('previewTableJson', asSent({ definition }), {});
		expect(preview).toEqual(direct(project, 'previewTableJson', asSent({ definition }) as never));
		expect(served).toEqual([]);
	});

	it('the shadow compares a download by its digest: the same file is not reported, one byte off is', async () => {
		const project = fakeProject();
		const lines: string[] = [];
		let done: Promise<void> = Promise.resolve();
		const shadow: NonNullable<EngineSeam['shadow']> = (probe) => {
			done = Promise.resolve(
				createShadow({
					rev: () => project.rev,
					quiet: () => Promise.resolve(),
					staged: () => false,
					report: (line) => lines.push(line)
				})(probe)
			);
			return done;
		};
		const { call } = await over(project, 'engine', shadow);
		const definition = namesOf(typeOf(project));
		const csv = (tweak: (text: string) => string) =>
			http.post(`${project.baseUrl}/tables/export`, () => {
				const params = call.mock.calls.at(-1)![1] as ReadParams;
				const text = new TextDecoder().decode(
					bytesOf(direct(project, 'exportTable', params).parts!)
				);
				return new HttpResponse(tweak(text), {
					headers: {
						'content-type': 'text/csv; charset=utf-8',
						'content-disposition': 'attachment; filename="table.csv"; filename*=UTF-8\'\'table.csv'
					}
				});
			});

		server.use(csv((text) => text));
		await exportTable({ definition, format: 'csv' });
		await done;
		expect(lines).toEqual([]);

		server.use(csv((text) => text.replace('\r\n', '\r\n!')));
		await exportTable({ definition, format: 'csv' });
		await done;
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[shadow\] exports exportTable /);
	});
});

describe('the exports surface on the server', () => {
	it('every export is the server’s, as before, with truncated from X-Table-Truncated', async () => {
		const project = fakeProject();
		const { call, served } = await over(project, 'server');
		const definition = namesOf(typeOf(project));

		const table = await exportTable({ definition, format: 'csv' });
		const run = await runExporter('x1');
		const preview = await previewTableJson({ artifactId: 't1' });

		expect(call).not.toHaveBeenCalled();
		for (const result of [table, run]) {
			expect(result).toEqual({
				kind: 'ready',
				blob: expect.any(Blob),
				filename: 'served.csv',
				truncated: true
			});
		}
		expect(preview).toEqual({ sample: '["served"]', truncated: false });
		expect(served.map(({ path }) => path)).toEqual([
			'/tables/export',
			'/exports/run',
			'/tables/json-preview'
		]);
	});

	it('an untruncated answer says so, and filename* is read before filename', async () => {
		const project = fakeProject();
		await over(project, 'server');
		server.use(
			http.post(
				`${project.baseUrl}/tables/export`,
				() =>
					new HttpResponse('x', {
						headers: {
							'content-disposition':
								'attachment; filename="_ café.csv"; filename*=UTF-8\'\'%F0%9F%9A%80%20caf%C3%A9.csv'
						}
					})
			),
			http.post(
				`${project.baseUrl}/exports/run`,
				() =>
					new HttpResponse('x', {
						headers: { 'content-disposition': 'attachment; filename="plain.zip"' }
					})
			)
		);

		expect(await exportTable({ artifactId: 't1', format: 'csv' })).toMatchObject({
			filename: '\u{1F680} café.csv',
			truncated: false
		});
		expect(await runExporter('x1')).toMatchObject({ filename: 'plain.zip', truncated: false });
	});

	it('a 202 is still preparing', async () => {
		const project = fakeProject();
		await over(project, 'server');
		server.use(
			http.post(`${project.baseUrl}/exports/run`, () =>
				HttpResponse.json({ state: 'computing', done: 2, total: 5 }, { status: 202 })
			)
		);

		expect(await runExporter('x1')).toEqual({ kind: 'preparing', done: 2, total: 5 });
	});
});
