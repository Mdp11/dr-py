import { describe, it, expect } from 'vitest';
import { TablePageSchema, TableDefinitionSchema, ChainPageSchema } from '../types';

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
