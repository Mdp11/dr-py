import { describe, expect, it } from 'vitest';
import { MetamodelSchema } from '$lib/api/types';
import { computeCompletions, resolveDocAt, vocabFromMetamodel } from '../completion-source';
import type { SnippetDocsOut } from '$lib/api/types';

const DOCS: SnippetDocsOut = {
	facade: [
		{
			name: 'dr.create',
			kind: 'function',
			signature: 'dr.create(type_name, properties=None) -> str (temp id)',
			doc: 'Record a dry-run element create.',
			example: null
		},
		{
			name: 'dr.elements',
			kind: 'function',
			signature: 'dr.elements(type=None)',
			doc: 'Iterate.',
			example: null
		},
		{
			name: 'dr.NotFoundError',
			kind: 'exception',
			signature: 'dr.NotFoundError',
			doc: 'Missing id.',
			example: null
		},
		{
			name: 'Element.set',
			kind: 'method',
			signature: 'Element.set(key, value)',
			doc: 'Update.',
			example: null
		},
		{
			name: 'Element.id',
			kind: 'property',
			signature: 'Element.id -> str',
			doc: 'Id.',
			example: null
		}
	],
	limits: {
		wall_timeout_s: 10,
		memory_bytes: 1,
		stdout_bytes: 1,
		result_repr_bytes: 1,
		max_ops: 1,
		max_op_bytes: 1,
		page_limit: 1
	},
	notes: []
};

const VOCAB = vocabFromMetamodel(
	MetamodelSchema.parse({
		elements: [
			{ name: 'Building', properties: [] },
			{ name: 'Sensor', properties: [] },
			{ name: 'Asset', abstract: true, properties: [] }
		],
		relationships: []
	})
);

describe('vocabFromMetamodel', () => {
	it('lists concrete type names sorted, null for no metamodel', () => {
		expect(VOCAB).toEqual({ typeNames: ['Building', 'Sensor'] });
		expect(vocabFromMetamodel(null)).toBeNull();
	});
});

describe('computeCompletions', () => {
	it('completes dr. members with signature detail', () => {
		const r = computeCompletions('x = dr.', DOCS, VOCAB);
		expect(r?.from).toBe(7);
		const labels = r!.options.map((o) => o.label);
		expect(labels).toContain('create');
		expect(labels).toContain('NotFoundError');
		expect(r!.options.find((o) => o.label === 'create')?.detail).toContain('type_name');
	});

	it('filters dr. members by the partial word', () => {
		const r = computeCompletions('dr.cre', DOCS, VOCAB);
		expect(r?.from).toBe(3);
		expect(r!.options.map((o) => o.label)).toEqual(['create']);
	});

	it('offers Element members after a non-dr dot only with a partial or explicit', () => {
		expect(computeCompletions('el.', DOCS, VOCAB)).toBeNull();
		expect(computeCompletions('el.', DOCS, VOCAB, true)).not.toBeNull();
		const r = computeCompletions('el.s', DOCS, VOCAB);
		expect(r?.from).toBe(3);
		expect(r!.options.map((o) => o.label)).toEqual(['set']);
		expect(r!.options[0].boost).toBeLessThan(0);
	});

	it('never offers Element members after dr.', () => {
		const labels = computeCompletions('dr.s', DOCS, VOCAB)?.options.map((o) => o.label) ?? [];
		expect(labels).not.toContain('set');
	});

	it('completes type names inside create/type/elements string literals', () => {
		expect(computeCompletions('dr.create("', DOCS, VOCAB)?.options.map((o) => o.label)).toEqual([
			'Building',
			'Sensor'
		]);
		const partial = computeCompletions("dr.create('Bu", DOCS, VOCAB);
		expect(partial?.from).toBe(11);
		expect(partial!.options.map((o) => o.label)).toEqual(['Building']);
		expect(computeCompletions('dr.elements(type="', DOCS, VOCAB)).not.toBeNull();
		expect(computeCompletions('dr.type("', DOCS, VOCAB)).not.toBeNull();
		expect(computeCompletions('dr.connect("', DOCS, VOCAB)).toBeNull();
		expect(computeCompletions('print("', DOCS, VOCAB)).toBeNull();
	});

	it('stays inert without docs/vocab', () => {
		expect(computeCompletions('dr.', null, VOCAB)).toBeNull();
		expect(computeCompletions('dr.create("', DOCS, null)).toBeNull();
		expect(computeCompletions('plain word', DOCS, VOCAB)).toBeNull();
	});
});

describe('resolveDocAt', () => {
	it('resolves dr.<member> under the cursor', () => {
		const line = 'x = dr.create("Building")';
		expect(resolveDocAt(line, 9, DOCS)?.name).toBe('dr.create');
	});

	it('resolves Element members after a non-dr dot, heuristically', () => {
		expect(resolveDocAt('el.set("name", 1)', 4, DOCS)?.name).toBe('Element.set');
	});

	it('returns null on plain words and without docs', () => {
		expect(resolveDocAt('create = 1', 2, DOCS)).toBeNull();
		expect(resolveDocAt('x = dr.create()', 9, null)).toBeNull();
	});
});
