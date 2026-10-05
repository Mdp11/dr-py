import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
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
import {
	TablePageSchema,
	TableDefinitionSchema,
	ChainPageSchema,
	type TableDefinition
} from '../types';
import { asSent, EngineUnavailableError, installEngineSeam } from '../engine-route';
import { evaluateTable, fetchScriptErrors } from '../tables';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('TablePageSchema', () => {
	it('parses an element + value row', () => {
		const page = TablePageSchema.parse({
			columns: [{ kind: 'element', header: '', width_px: null }],
			rows: [
				{
					key: ['e1'],
					cells: [
						{
							kind: 'element',
							item: { id: 'e1', type_name: 'Block', display_name: 'B', child_count: 0 }
						}
					]
				}
			],
			total: 1,
			truncated: false,
			offset: 0,
			model_rev: 3
		});
		expect(page.rows[0].cells[0].kind).toBe('element');
	});

	it('parses a value cell with editable flag', () => {
		const page = TablePageSchema.parse({
			columns: [{ kind: 'property', header: 'Mass', width_px: 120 }],
			rows: [
				{
					key: ['e1'],
					cells: [{ kind: 'value', present: true, value: 10, element_id: 'e1', editable: true }]
				}
			],
			total: 1,
			truncated: false,
			offset: 0,
			model_rev: 3
		});
		const cell = page.rows[0].cells[0];
		expect(cell.kind === 'value' && cell.editable).toBe(true);
	});

	it('parses a table page with error cells', () => {
		const page = TablePageSchema.parse({
			columns: [{ kind: 'property', header: 'Test', width_px: null }],
			rows: [
				{
					key: ['e1'],
					cells: [{ kind: 'error', message: 'boom', traceback: null }]
				}
			],
			total: 1,
			truncated: false,
			offset: 0,
			model_rev: 3
		});
		const cell = page.rows[0].cells[0];
		expect(cell.kind).toBe('error');
		expect(cell.kind === 'error' && cell.message).toBe('boom');
	});

	it('parses a table page with warnings', () => {
		const page = TablePageSchema.parse({
			columns: [{ kind: 'element', header: '', width_px: null }],
			rows: [
				{
					key: ['e1'],
					cells: [
						{
							kind: 'element',
							item: { id: 'e1', type_name: 'Block', display_name: 'B', child_count: 0 }
						}
					]
				}
			],
			total: 1,
			truncated: false,
			offset: 0,
			model_rev: 3,
			warnings: [{ code: 'nav_step_failed', occurrences: 1, total: 0, detail: 'warning 1' }]
		});
		expect(page.warnings).toEqual([
			{ code: 'nav_step_failed', occurrences: 1, total: 0, detail: 'warning 1' }
		]);
	});
});

describe('TableDefinitionSchema', () => {
	it('parses a script column with inline definition', () => {
		const definition = TableDefinitionSchema.parse({
			schema_version: 1,
			row_source: { kind: 'scope', types: ['Block'] },
			columns: [
				{
					kind: 'script',
					snippet: {
						definition: {
							code: 'def value(els): return 1'
						}
					}
				}
			]
		});
		expect(definition.columns[0].kind).toBe('script');
		expect(
			definition.columns[0].kind === 'script' && definition.columns[0].snippet.definition?.code
		).toBe('def value(els): return 1');
	});

	it('defaults chains row-source unique off for payloads that predate it', () => {
		const definition = TableDefinitionSchema.parse({
			schema_version: 1,
			row_source: { kind: 'chains', navigation: {} },
			columns: [{ kind: 'element' }]
		});
		expect(definition.row_source).toMatchObject({ kind: 'chains', unique: false });
	});

	it('round-trips chains row-source unique', () => {
		const definition = TableDefinitionSchema.parse({
			schema_version: 1,
			row_source: { kind: 'chains', navigation: {}, unique: true },
			columns: [{ kind: 'element' }]
		});
		expect(definition.row_source).toMatchObject({ kind: 'chains', unique: true });
	});

	it('parses a script column with ref', () => {
		const definition = TableDefinitionSchema.parse({
			schema_version: 1,
			row_source: { kind: 'scope', types: ['Block'] },
			columns: [
				{
					kind: 'script',
					snippet: {
						ref: 'a1'
					}
				}
			]
		});
		expect(definition.columns[0].kind).toBe('script');
		expect(definition.columns[0].kind === 'script' && definition.columns[0].snippet.ref).toBe('a1');
	});
});

describe('ChainPageSchema', () => {
	it('parses a chain page with warnings', () => {
		const page = ChainPageSchema.parse({
			step_types: ['element'],
			chains: [[{ id: 'e1', type_name: 'Block', display_name: 'B', child_count: 0 }]],
			total: 1,
			truncated: false,
			warnings: [{ code: 'nav_step_failed', occurrences: 1, total: 0, detail: 'chain warning' }]
		});
		expect(page.warnings).toEqual([
			{ code: 'nav_step_failed', occurrences: 1, total: 0, detail: 'chain warning' }
		]);
	});
});

describe('the table reads on the engine', () => {
	const made: ReturnType<typeof syncOver>[] = [];

	afterEach(() => {
		installEngineSeam(null);
		for (const over of made.splice(0)) over.dispose();
	});

	/**
	 * A ready replica of `project` behind an installed seam, whose `call` is
	 * spied on. MSW holds the replica's own routes and no table route: a call
	 * that strays to the server fails the test.
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

	/** What the engine's evaluation answers over the fake's own model, with no artifacts. */
	function direct(project: FakeProject, params: ReadParams) {
		const ctx = {
			model: project.model,
			artifacts: new ArtifactSet(),
			placements: new ViewPlacements(),
			scripts: NO_SCRIPTS,
			working: { rev: project.rev, stagedVersion: 0, tableOrders: new TableOrderCache() }
		};
		return TablePageSchema.parse(
			JSON.parse(JSON.stringify(drain(EVALUATIONS['evaluateTable']!(ctx, params))))
		);
	}

	/** A type with more than one page of elements: `e_000031` is one of the 160 people. */
	const typeOf = (project: FakeProject) => project.model.getElement('e_000031').typeName;

	it("an inline definition is the engine's page", async () => {
		const project = fakeProject();
		const { call } = await over(project);
		const definition = namesOf(typeOf(project));

		const page = await evaluateTable({ definition: new Proxy(definition, {}), limit: 5 });

		const sent = JSON.parse(JSON.stringify({ definition, offset: 0, limit: 5 })) as ReadParams;
		expect(page).toEqual(direct(project, sent));
		expect(page.rows).toHaveLength(5);
		expect(page.total).toBeGreaterThan(5);
		expect(call).toHaveBeenCalledWith('evaluateTable', sent, {});
	});

	it('an artifact id resolves through the artifacts the engine holds', async () => {
		const project = fakeProject();
		const { replica } = await over(project);
		const definition = namesOf(typeOf(project));
		replica.sync.setArtifacts([
			{ id: 't1', kind: 'table', name: 'T', artifact_rev: 1, payload: asSent(definition) as never }
		]);

		const page = await evaluateTable({ artifactId: 't1', offset: 2, limit: 3 });

		const inline = JSON.parse(JSON.stringify({ definition, offset: 2, limit: 3 })) as ReadParams;
		expect(page).toEqual(direct(project, inline));
	});

	it('the script-error recap is the engine answer', async () => {
		const project = fakeProject();
		const { call } = await over(project);
		const definition = namesOf(typeOf(project));

		const recap = await fetchScriptErrors({ definition });

		// The recap is always whole-table: the definition carries the sort, and nothing else is sent.
		expect(call).toHaveBeenCalledWith(
			'tableScriptErrors',
			JSON.parse(JSON.stringify({ definition })),
			{}
		);
		expect(recap).toMatchObject({ state: 'ready', errors: [], total_errors: 0 });
	});

	it('a call the engine cannot answer at all is unavailable', async () => {
		const project = fakeProject();
		const { replica } = await over(project);
		replica.link!.dispose();

		await expect(evaluateTable({ definition: namesOf(typeOf(project)) })).rejects.toBeInstanceOf(
			EngineUnavailableError
		);
		await replica.sync.settled();
	});

	it('an aborted signal rejects with an AbortError', async () => {
		const project = fakeProject();
		const { replica, call } = await over(project);
		const controller = new AbortController();
		// The call waits for the gate first: abort once the engine has it.
		const posted = new Promise<void>((resolve) => {
			call.mockImplementationOnce((method, params, options) => {
				resolve();
				return replica.sync.call(method, params, options);
			});
		});

		const page = evaluateTable({
			definition: namesOf(typeOf(project)),
			signal: controller.signal
		});
		await posted;
		controller.abort();

		await expect(page).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('a table with a pattern the engine cannot translate is a 422', async () => {
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

		const refused = evaluateTable({ definition });

		await expect(refused).rejects.toMatchObject({ status: 422 });
		await expect(refused).rejects.toThrow(/inline flags/);
	});
});
