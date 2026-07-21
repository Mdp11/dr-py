import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { TablePageSchema, TableDefinitionSchema, ChainPageSchema } from '../types';
import { exportTable } from '../tables';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

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
			warnings: ['warning 1']
		});
		expect(page.warnings).toEqual(['warning 1']);
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
			warnings: ['chain warning']
		});
		expect(page.warnings).toEqual(['chain warning']);
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
});
