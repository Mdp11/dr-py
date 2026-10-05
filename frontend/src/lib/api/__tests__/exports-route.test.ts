import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import {
	fakeProject,
	ready,
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
import { setActiveProjectId } from '../client';
import { asSent, installEngineSeam } from '../engine-route';
import { runExporter, runExporterDraft } from '../exports';
import { exportTable, previewTableJson, type ExportResult } from '../tables';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const made: ReturnType<typeof syncOver>[] = [];

afterEach(() => {
	installEngineSeam(null);
	setActiveProjectId(null);
	for (const over of made.splice(0)) over.dispose();
});

/**
 * A ready replica of `project` behind an installed seam; `call` is the seam's
 * view of `sync.call`, spied on. MSW holds the replica's own routes and no
 * export route: an export that strays to the server fails the test.
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
	setActiveProjectId(project.projectId);
	return { replica, call };
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

describe('the exports on the engine', () => {
	it('exportTable answers the engine’s parts as a Blob, with its name, type and truncated flag', async () => {
		const project = fakeProject();
		const { call } = await over(project);
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
	});

	it('exportTable of a saved table in xlsx is its zip-free workbook, named after the table', async () => {
		const project = fakeProject();
		const { replica, call } = await over(project);
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
	});

	it('runExporter and runExporterDraft answer the engine’s zip', async () => {
		const project = fakeProject();
		const { replica, call } = await over(project);
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
	});

	it('previewTableJson answers the engine’s sample', async () => {
		const project = fakeProject();
		const { call } = await over(project);
		const definition = namesOf(typeOf(project));

		const preview = await previewTableJson({ definition });

		expect(call).toHaveBeenCalledWith('previewTableJson', asSent({ definition }), {});
		expect(preview).toEqual(direct(project, 'previewTableJson', asSent({ definition }) as never));
	});

	it('a table the engine cannot translate a pattern of is a 422, not a file', async () => {
		const project = fakeProject();
		await over(project);
		const definition = TableDefinitionSchema.parse({
			row_source: {
				kind: 'scope',
				types: [typeOf(project)],
				criteria: [{ type: 'property', name: 'name', op: 'matches', value: '(?x)a' }]
			},
			columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 } }]
		});

		const refused = exportTable({ definition, format: 'csv' });

		await expect(refused).rejects.toMatchObject({ status: 422 });
		await expect(refused).rejects.toThrow(/inline flags/);
	});
});
