import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
	ArtifactSet,
	drain,
	EVALUATIONS,
	TableOrderCache,
	ViewPlacements,
	type ReadParams
} from '$engine';
import { EngineGoneError } from '$lib/engine/client';
import { createEngineSeam } from '$lib/engine/seam';
import { SURFACES } from '$lib/engine/surfaces';
import {
	fakeProject,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import {
	TablePageSchema,
	TableDefinitionSchema,
	ChainPageSchema,
	type TableDefinition
} from '../types';
import { setActiveBaseUrl } from '../client';
import { asSent, installEngineSeam, type Side, type Surface } from '../engine-route';
import {
	answeredBy,
	evaluateTable,
	exportTable,
	fetchScriptErrors,
	previewTableJson
} from '../tables';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

const DEFN = {
	schema_version: 1,
	row_source: { kind: 'scope', types: ['Block'], criteria: [] },
	columns: [
		{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: 'Block', hidden: false }
	],
	default_cell_mode: 'collapse',
	show_row_numbers: false
} as unknown as TableDefinition;

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

	it('parses pending cells and script_status', () => {
		const page = TablePageSchema.parse({
			columns: [{ kind: 'script', header: '', width_px: null }],
			rows: [{ key: [null], cells: [{ kind: 'pending' }] }],
			total: 1,
			base_total: 1,
			truncated: false,
			offset: 0,
			model_rev: 3,
			warnings: [],
			script_status: { state: 'computing', done: 10, total: 3000, message: null }
		});
		expect(page.script_status?.state).toBe('computing');
		expect(page.rows[0].cells[0].kind).toBe('pending');
	});

	it('tolerates absent script_status (older responses)', () => {
		const page = TablePageSchema.parse({
			columns: [],
			rows: [],
			total: 0,
			base_total: 0,
			truncated: false,
			offset: 0,
			model_rev: 1,
			warnings: []
		});
		expect(page.script_status ?? null).toBeNull();
	});

	it('tolerates a null script_status', () => {
		const page = TablePageSchema.parse({
			columns: [],
			rows: [],
			total: 0,
			truncated: false,
			offset: 0,
			model_rev: 1,
			warnings: [],
			script_status: null
		});
		expect(page.script_status ?? null).toBeNull();
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

describe('exportTable', () => {
	it('returns a preparing result on a 202 (script-cache sweep still running)', async () => {
		server.use(
			http.post(`${BASE}/tables/export`, () =>
				HttpResponse.json(
					{ state: 'computing', done: 10, total: 3000, message: null },
					{ status: 202, headers: { 'Retry-After': '1' } }
				)
			)
		);
		const result = await exportTable({ artifactId: 'a1' }, cfg);
		expect(result).toEqual({ kind: 'preparing', done: 10, total: 3000 });
	});

	it('returns a ready result with the blob + filename on 200', async () => {
		server.use(
			http.post(`${BASE}/tables/export`, () =>
				HttpResponse.arrayBuffer(new TextEncoder().encode('xlsx-bytes').buffer, {
					headers: { 'content-disposition': 'attachment; filename="my table.xlsx"' }
				})
			)
		);
		const result = await exportTable({ artifactId: 'a1' }, cfg);
		expect(result.kind).toBe('ready');
		expect(result.kind === 'ready' && result.filename).toBe('my table.xlsx');
	});

	it('sends the requested format and returns the json filename', async () => {
		let seen: unknown = null;
		server.use(
			http.post(`${BASE}/tables/export`, async ({ request }) => {
				seen = await request.json();
				return new HttpResponse('[]', {
					headers: {
						'content-type': 'application/json',
						'content-disposition': 'attachment; filename="table.json"'
					}
				});
			})
		);
		const res = await exportTable({ definition: DEFN, format: 'json' }, cfg);
		expect((seen as { format: string }).format).toBe('json');
		expect(res).toMatchObject({ kind: 'ready', filename: 'table.json' });
	});

	it('defaults the format to xlsx', async () => {
		let seen: unknown = null;
		server.use(
			http.post(`${BASE}/tables/export`, async ({ request }) => {
				seen = await request.json();
				return new HttpResponse('x', {
					headers: { 'content-disposition': 'attachment; filename="t.xlsx"' }
				});
			})
		);
		await exportTable({ definition: DEFN }, cfg);
		expect((seen as { format: string }).format).toBe('xlsx');
	});

	it('falls back to a .json filename when content-disposition is missing', async () => {
		server.use(http.post(`${BASE}/tables/export`, () => new HttpResponse('[]')));
		const res = await exportTable({ definition: DEFN, format: 'json' }, cfg);
		expect(res.kind === 'ready' && res.filename).toBe('table.json');
	});

	it('falls back to a .xlsx filename when content-disposition is missing', async () => {
		server.use(http.post(`${BASE}/tables/export`, () => new HttpResponse('x')));
		const res = await exportTable({ definition: DEFN }, cfg);
		expect(res.kind === 'ready' && res.filename).toBe('table.xlsx');
	});

	it('fetches a json preview', async () => {
		server.use(
			http.post(`${BASE}/tables/json-preview`, () =>
				HttpResponse.json({ sample: '[]', truncated: true })
			)
		);
		await expect(previewTableJson({ definition: DEFN }, cfg)).resolves.toEqual({
			sample: '[]',
			truncated: true
		});
	});
});

describe('fetchScriptErrors', () => {
	it('returns the recap on a 200', async () => {
		server.use(
			http.post(`${BASE}/tables/script-errors`, () =>
				HttpResponse.json({
					state: 'ready',
					errors: [
						{
							row_index: 1,
							row_element_id: 't2',
							row_label: 't2',
							column_index: 1,
							column_label: 'script',
							message: 'ZeroDivisionError: division by zero'
						}
					],
					total_errors: 2,
					truncated: false
				})
			)
		);
		const recap = await fetchScriptErrors({ artifactId: 'a1' }, cfg);
		expect('retry' in recap).toBe(false);
		expect(recap).toMatchObject({ state: 'ready', total_errors: 2, truncated: false });
		expect('retry' in recap ? [] : recap.errors[0]).toMatchObject({
			row_index: 1,
			column_index: 1,
			column_label: 'script',
			row_label: 't2'
		});
	});

	// The 202 is discriminated by the STATUS CODE, never the body: a 202 body
	// routinely says `computing` for a sweep that already finished (the server
	// decides ship-vs-retry by re-probing its cache, not by the job's state).
	it('returns { retry: true } on a 202 (sweep still filling the cache)', async () => {
		server.use(
			http.post(`${BASE}/tables/script-errors`, () =>
				HttpResponse.json(
					{ state: 'computing', done: 10, total: 3000, message: null },
					{ status: 202, headers: { 'Retry-After': '1' } }
				)
			)
		);
		expect(await fetchScriptErrors({ artifactId: 'a1' }, cfg)).toEqual({ retry: true });
	});

	// `offset`/`limit` are IGNORED by the route (the recap is always
	// whole-table) but `sort` is load-bearing: `row_index` is only a valid grid
	// address for the (definition, sort, model_rev) the page was rendered with.
	it('sends the table address only — the definition carries the sort', async () => {
		let body: Record<string, unknown> = {};
		server.use(
			http.post(`${BASE}/tables/script-errors`, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json({ state: 'ready', errors: [], total_errors: 0, truncated: false });
			})
		);
		await fetchScriptErrors({ artifactId: 'a1' }, cfg);
		expect(body).toMatchObject({ artifact_id: 'a1' });
		expect('sort' in body).toBe(false);
	});
});

describe('evaluateTable on the tables surface', () => {
	const made: ReturnType<typeof syncOver>[] = [];

	afterEach(() => {
		installEngineSeam(null);
		setActiveBaseUrl(null);
		for (const over of made.splice(0)) over.dispose();
	});

	const SERVED = {
		columns: [{ kind: 'element', header: '', width_px: null }],
		rows: [
			{
				key: ['srv'],
				cells: [
					{
						kind: 'element',
						item: { id: 'srv', type_name: 'Building', display_name: 'Served', child_count: 0 }
					}
				]
			}
		],
		total: 1,
		base_total: 1,
		truncated: false,
		offset: 0,
		model_rev: 0,
		warnings: [],
		script_status: null
	};

	/**
	 * A ready replica of `project` behind a seam with `tables` on `side` and
	 * every other surface on the server; the server's evaluate route answers
	 * `SERVED` (after `gate`, when given) and records each body it is sent.
	 */
	async function over(project: FakeProject, side: Side, gate?: Promise<void>) {
		const bodies: unknown[] = [];
		server.use(
			...project.handlers(),
			http.post(`${project.baseUrl}/tables/evaluate`, async ({ request }) => {
				bodies.push(await request.json());
				if (gate !== undefined) await gate;
				return HttpResponse.json(SERVED);
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
			SURFACES.map((surface) => [surface, surface === 'tables' ? side : 'server'])
		) as Record<Surface, Side>;
		installEngineSeam(
			createEngineSeam(
				{ status: () => replica.sync.status(), call: call as typeof replica.sync.call },
				surfaces
			)
		);
		setActiveBaseUrl(project.baseUrl);
		return { replica, call, bodies };
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

	const scripted = (): TableDefinition =>
		TableDefinitionSchema.parse({
			row_source: { kind: 'scope', types: [], criteria: [] },
			columns: [
				{ kind: 'element', source: { kind: 'row', chain_index: 0 } },
				{ kind: 'script', source: { kind: 'row', chain_index: 0 }, snippet: { ref: 'sn1' } }
			]
		});

	/** What the engine's evaluation answers over the fake's own model, with no artifacts. */
	function direct(project: FakeProject, params: ReadParams) {
		const ctx = {
			model: project.model,
			artifacts: new ArtifactSet(),
			placements: new ViewPlacements(),
			working: { rev: project.rev, stagedVersion: 0, tableOrders: new TableOrderCache() }
		};
		return TablePageSchema.parse(
			JSON.parse(JSON.stringify(drain(EVALUATIONS['evaluateTable']!(ctx, params))))
		);
	}

	/** A type with more than one page of elements: `e_000031` is one of the 160 people. */
	const typeOf = (project: FakeProject) => project.model.getElement('e_000031').typeName;

	it("on the engine, an inline definition is the engine's page and the server is never asked", async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'engine');
		const definition = namesOf(typeOf(project));

		const page = await evaluateTable({ definition: new Proxy(definition, {}), limit: 5 });

		const sent = JSON.parse(JSON.stringify({ definition, offset: 0, limit: 5 })) as ReadParams;
		expect(page).toEqual(direct(project, sent));
		expect(page.rows).toHaveLength(5);
		expect(page.total).toBeGreaterThan(5);
		expect(page).not.toHaveProperty('fallback');
		expect(answeredBy(page)).toBe('engine');
		expect(call).toHaveBeenCalledWith('evaluateTable', sent, {});
		expect(bodies).toEqual([]);
	});

	it('on the engine, an artifact id resolves through the artifacts the engine holds', async () => {
		const project = fakeProject();
		const { replica, bodies } = await over(project, 'engine');
		const definition = namesOf(typeOf(project));
		replica.sync.setArtifacts([
			{ id: 't1', kind: 'table', name: 'T', artifact_rev: 1, payload: asSent(definition) as never }
		]);

		const page = await evaluateTable({ artifactId: 't1', offset: 2, limit: 3 });

		const inline = JSON.parse(JSON.stringify({ definition, offset: 2, limit: 3 })) as ReadParams;
		expect(page).toEqual(direct(project, inline));
		expect(bodies).toEqual([]);
	});

	it("on the engine, a table that reaches a script is the server's page marked script", async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'engine');
		const definition = scripted();

		const page = await evaluateTable({ definition, limit: 10 });

		expect(page).toEqual({ ...TablePageSchema.parse(SERVED), fallback: 'script' });
		expect(answeredBy(page)).toBe('server');
		expect(call).toHaveBeenCalledOnce();
		expect(bodies).toEqual([asSent({ definition, offset: 0, limit: 10 })]);
	});

	it('on the server, both reach the server alone, unmarked', async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'server');
		const definition = namesOf(typeOf(project));

		const page = await evaluateTable({ definition });
		expect(page).toEqual(TablePageSchema.parse(SERVED));
		expect(answeredBy(page)).toBe('server');
		expect(await evaluateTable({ definition: scripted(), offset: 100 })).toEqual(
			TablePageSchema.parse(SERVED)
		);

		expect(call).not.toHaveBeenCalled();
		expect(bodies).toEqual([
			asSent({ definition, offset: 0, limit: 100 }),
			asSent({ definition: scripted(), offset: 100, limit: 100 })
		]);
	});

	it("on the engine, a call the engine cannot answer is the server's page, unmarked", async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'engine');
		const definition = namesOf(typeOf(project));
		call.mockRejectedValueOnce(new EngineGoneError());

		const page = await evaluateTable({ definition, limit: 10 });

		expect(page).toEqual(TablePageSchema.parse(SERVED));
		expect(answeredBy(page)).toBe('server');
		expect(bodies).toEqual([asSent({ definition, offset: 0, limit: 10 })]);
	});

	it('an aborted signal rejects with an AbortError on either side', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		try {
			for (const side of ['engine', 'server'] as const) {
				const project = fakeProject();
				const { bodies } = await over(project, side, gate);
				const controller = new AbortController();

				const page = evaluateTable({
					definition: namesOf(typeOf(project)),
					signal: controller.signal
				});
				if (side === 'server') await vi.waitFor(() => expect(bodies).toHaveLength(1));
				controller.abort();

				await expect(page).rejects.toMatchObject({ name: 'AbortError' });
				expect(bodies).toHaveLength(side === 'server' ? 1 : 0);
				installEngineSeam(null);
			}
		} finally {
			release();
		}
	});
});
