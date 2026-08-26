// Schema tests for `SnippetSource` and the two `transform` fields that now
// carry it — the client mirror of core/script/schema.py's `SnippetSource`
// ("at most one of ref/definition; NEITHER set is legal").
import { describe, expect, it } from 'vitest';

import {
	ExporterEntrySchema,
	SnippetSourceSchema,
	TableDefinitionSchema,
	type SnippetSource
} from '../types';

const INLINE = {
	schema_version: 1,
	language: 'python',
	code: 'def transform(doc):\n    return doc\n',
	entry_points: ['script', 'transform']
};

function tableDefinition(transform: unknown) {
	return {
		schema_version: 1,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'name',
				mode: 'collapse',
				keep_empty: true,
				header: 'Name',
				hidden: false
			}
		],
		transform
	};
}

describe('SnippetSourceSchema', () => {
	it('rejects a value with BOTH ref and definition set', () => {
		expect(SnippetSourceSchema.safeParse({ ref: 'snip-1', definition: INLINE }).success).toBe(
			false
		);
	});

	it('accepts ref-only, inline-only and the unconfigured `{}`', () => {
		expect(SnippetSourceSchema.safeParse({ ref: 'snip-1' }).success).toBe(true);
		expect(SnippetSourceSchema.safeParse({ definition: INLINE }).success).toBe(true);
		expect(SnippetSourceSchema.safeParse({}).success).toBe(true);
	});

	it('counts an explicitly nullish half as not set', () => {
		expect(SnippetSourceSchema.safeParse({ ref: 'snip-1', definition: null }).success).toBe(true);
		expect(SnippetSourceSchema.safeParse({ ref: null, definition: INLINE }).success).toBe(true);
		expect(SnippetSourceSchema.safeParse({ ref: null, definition: null }).success).toBe(true);
	});
});

describe('transform is a SnippetSource on both carriers', () => {
	it('a table definition accepts an inline transform', () => {
		const parsed = TableDefinitionSchema.parse(tableDefinition({ definition: INLINE }));
		expect((parsed.transform as SnippetSource).definition?.code).toContain('def transform(doc):');
	});

	it('a table definition still accepts a ref transform and null', () => {
		expect(TableDefinitionSchema.parse(tableDefinition({ ref: 'snip-1' })).transform).toEqual({
			ref: 'snip-1'
		});
		expect(TableDefinitionSchema.parse(tableDefinition(null)).transform).toBeNull();
	});

	it('an exporter entry accepts an inline transform and rejects a both-set one', () => {
		const entry = ExporterEntrySchema.parse({
			source: { ref: 'tbl-1' },
			format: 'json',
			transform: { definition: INLINE }
		});
		expect((entry.transform as SnippetSource).definition?.code).toContain('def transform(doc):');

		expect(
			ExporterEntrySchema.safeParse({
				source: { ref: 'tbl-1' },
				format: 'json',
				transform: { ref: 'snip-1', definition: INLINE }
			}).success
		).toBe(false);
	});
});
