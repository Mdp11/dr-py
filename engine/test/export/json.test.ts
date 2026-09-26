import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	drain,
	EVALUATIONS,
	jsonlText,
	jsonText,
	Metamodel,
	Model,
	PyFloat,
	ReadError,
	readTableDefinition,
	renderJsonEx,
	shapeJsonDocs,
	toParts,
	ViewPlacements,
	type ExportFileResult,
	type JsonDoc,
	type MetamodelDoc,
	type ReadParams,
	type TableCell,
	type Value
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { NODE_DOC } from '../model/fixtures.ts';

const node = NODE_DOC.elements[0]!;
const DOC: MetamodelDoc = {
	...NODE_DOC,
	elements: [
		{
			...node,
			properties: [
				...node.properties,
				{
					name: 'tags',
					datatype: 'string',
					multiplicity: '0..*',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			]
		}
	]
};

/** One node whose tags are equal in Python three ways, and a string that is not. */
function tagged(tags: Value[]): Model {
	const model = new Model(Metamodel.fromJSON(DOC));
	const el = model.createElement('Node', 'e1');
	model.setProperty(el, 'name', 'E1');
	model.setProperty(el, 'tags', tags);
	return model;
}

const EQUAL_TAGS: Value[] = [1, new PyFloat(1), true, '1'];

const decode = (result: ExportFileResult) =>
	new TextDecoder('utf-8', { fatal: true }).decode(
		new Uint8Array(result.parts.flatMap((part) => [...new Uint8Array(part)]))
	);

function exportJson(model: Model, definition: object): string {
	const params: ReadParams = { definition, format: 'json', date: '20240229', project: 'p' };
	const ctx = { model, artifacts: new ArtifactSet(), placements: new ViewPlacements() };
	return decode(drain(EVALUATIONS.exportTable!(ctx, params)) as ExportFileResult);
}

const SCOPE = { kind: 'scope', types: ['Node'] };

describe('JSON documents keep their keys in insertion order', () => {
	const docs: JsonDoc[] = [1, 2, 3].map((n) => new Map([['n', n]]));

	it('in the object shape, keyed by numeric-looking keys', () => {
		const shaped = shapeJsonDocs('json', docs, ['0', '10', '2']);
		expect(jsonText(shaped, false)).toBe('{"0":{"n":1},"10":{"n":2},"2":{"n":3}}');
		expect(jsonText(shaped, true)).toBe(
			'{\n  "0": {\n    "n": 1\n  },\n  "10": {\n    "n": 2\n  },\n  "2": {\n    "n": 3\n  }\n}'
		);
	});

	it('in the array shape, and always in JSONL', () => {
		expect(jsonText(shapeJsonDocs('json', docs, null), false)).toBe('[{"n":1},{"n":2},{"n":3}]');
		expect(jsonlText(shapeJsonDocs('jsonl', docs, ['0', '10', '2']) as JsonDoc[])).toBe(
			'{"n":1}\n{"n":2}\n{"n":3}\n'
		);
		expect(jsonText([], true)).toBe('[]');
		expect(jsonlText([])).toBe('');
	});

	it('in a row, keyed by numeric-looking headers', () => {
		const text = exportJson(tagged(['x']), {
			row_source: SCOPE,
			columns: [
				{ kind: 'element', header: '10' },
				{ kind: 'property', name: 'name', header: '2' },
				{ kind: 'property', name: 'tags', header: '0' }
			]
		});
		expect(text).toBe(
			'[\n  {\n    "10": "E1",\n    "2": "E1",\n    "0": [\n      "x"\n    ]\n  }\n]'
		);
	});
});

describe('JSON grouping buckets on Python equality', () => {
	it('partitions a grouped column: 1, 1.0 and True one entry, "1" another', () => {
		const text = exportJson(tagged(EQUAL_TAGS), {
			row_source: SCOPE,
			columns: [
				{ kind: 'element', header: 'Block' },
				{
					kind: 'property',
					name: 'tags',
					mode: 'expand',
					header: 'Tags',
					json_export: { group: true }
				}
			]
		});
		expect(JSON.parse(text)).toEqual([{ Block: 'E1', Tags: [1, '1'] }]);
	});

	it('merges rows whose other slots hold 1, 1.0 and True into one document, "1" another', () => {
		const text = exportJson(tagged([new PyFloat(1), 1, true, '1']), {
			row_source: SCOPE,
			columns: [
				{ kind: 'property', name: 'tags', mode: 'expand', header: 'Tag' },
				{
					kind: 'property',
					name: 'name',
					mode: 'expand',
					header: 'Names',
					json_export: { group: true }
				}
			]
		});
		// The first row of a bucket gives its plain columns: 1.0 stays a float.
		expect(text).toBe(
			'[\n  {\n    "Tag": 1.0,\n    "Names": [\n      "E1"\n    ]\n  },\n' +
				'  {\n    "Tag": "1",\n    "Names": [\n      "E1"\n    ]\n  }\n]'
		);
	});

	it('keeps every row apart when nothing groups, equal rows included', () => {
		const text = exportJson(tagged(EQUAL_TAGS), {
			row_source: SCOPE,
			columns: [{ kind: 'property', name: 'tags', mode: 'expand', header: 'Tag' }]
		});
		expect(JSON.parse(text)).toEqual([{ Tag: 1 }, { Tag: 1 }, { Tag: true }, { Tag: '1' }]);
		expect(text).toContain('"Tag": 1.0');
	});
});

describe('the key column', () => {
	const model = tagged([]);
	const defn = readTableDefinition(
		{ row_source: SCOPE, columns: [{ kind: 'element' }, { kind: 'property', name: 'name' }] },
		'definition'
	);
	const valueCell = (value: Value): TableCell => ({
		kind: 'value',
		item: null,
		ref_type: null,
		present: true,
		value,
		element_id: null,
		editable: false,
		items: null,
		values: null,
		total: null,
		truncated: null,
		message: null,
		traceback: null
	});
	const keysOf = (values: Value[]) =>
		renderJsonEx(
			model,
			defn,
			values.map(() => ['e1']),
			values.map((v) => [valueCell('E1'), valueCell(v)]),
			1,
			{ order: null, rowNumber: null, keyColumn: 1 }
		)[1];

	it('refuses two keys whose str() is equal: 1 and "1"', () => {
		const error = thrown(() => keysOf([1, '1']));
		expect(error).toBeInstanceOf(ReadError);
		expect(error).toMatchObject({
			status: 422,
			detail: "json_doc.key_column: duplicate document key '1'"
		});
	});

	it('keeps keys that are equal in Python but not as text: 1, 1.0 and True', () => {
		expect(keysOf([1, new PyFloat(1), true])).toEqual(['1', '1.0', 'True']);
	});

	it('refuses an empty, absent or non-scalar key, naming the document', () => {
		for (const [values, n] of [
			[[1, ''], 2],
			[[null], 1],
			[['a', 'b', [1]], 3]
		] as [Value[], number][]) {
			expect(thrown(() => keysOf(values))).toMatchObject({
				status: 422,
				detail: `json_doc.key_column renders an empty or non-scalar key for document ${n}`
			});
		}
	});

	it('refuses a key column out of range', () => {
		const error = thrown(() =>
			renderJsonEx(model, defn, [['e1']], [[valueCell('E1'), valueCell(1)]], 1, {
				order: null,
				rowNumber: null,
				keyColumn: 2
			})
		);
		expect(error).toMatchObject({
			status: 422,
			detail: 'json_doc.key_column 2 out of range (table has 2 columns)'
		});
	});
});

describe('an export file', () => {
	function exported(model: Model, definition: object, format: string): unknown {
		const params: ReadParams = { definition, format, date: '20240229', project: 'p' };
		const ctx = { model, artifacts: new ArtifactSet(), placements: new ViewPlacements() };
		return thrown(() => drain(EVALUATIONS.exportTable!(ctx, params)));
	}

	it('refuses a lone surrogate as Python cannot encode it, a JSONL line counted alone', () => {
		const model = tagged([]);
		model.setProperty(model.getElement('e1'), 'name', 'E\ud800');
		model.setProperty(model.createElement('Node', 'e0'), 'name', 'ok');
		const definition = {
			row_source: SCOPE,
			columns: [
				{ kind: 'element', header: 'El' },
				{ kind: 'property', name: 'name', header: 'N' }
			],
			sort: [{ column: 1, direction: 'desc' }]
		};
		const at = (n: number) =>
			`'utf-8' codec can't encode character '\\ud800' in position ${n}: surrogates not allowed`;
		expect(exported(model, definition, 'csv')).toMatchObject({ status: 422, detail: at(14) });
		expect(exported(model, definition, 'json')).toMatchObject({ status: 422, detail: at(57) });
		expect(exported(model, definition, 'jsonl')).toMatchObject({ status: 422, detail: at(8) });
		model.setProperty(model.getElement('e1'), 'name', 'E\udc00\ud800 😀');
		expect(exported(model, definition, 'csv')).toMatchObject({
			status: 422,
			detail: "'utf-8' codec can't encode characters in position 14-15: surrogates not allowed"
		});
	});

	it('holds every element a navigation cell reaches, whatever its cell cap', () => {
		const model = tagged([]);
		for (const id of ['n1', 'n2', 'n3']) {
			model.setProperty(model.createElement('Node', id), 'name', id.toUpperCase());
			model.connect('Refers', 'e1', id, `r-${id}`);
		}
		const text = exportJson(model, {
			row_source: SCOPE,
			columns: [
				{
					kind: 'navigation',
					header: 'Refers',
					cell_cap: 1,
					navigation: {
						definition: {
							kind: 'path',
							start: { kind: 'row' },
							steps: [{ kind: 'relationship', relationship_type: 'Refers' }]
						}
					}
				}
			]
		});
		expect(JSON.parse(text)[0]).toEqual({ Refers: ['N1', 'N2', 'N3'] });
	});

	it('is answered in parts of at most 4 MiB, each on a buffer of its own', () => {
		const MiB = 1024 * 1024;
		const bytes = new Uint8Array(9 * MiB).map((_, i) => i % 251);
		const parts = toParts(bytes);
		expect(parts.map((part) => part.byteLength)).toEqual([4 * MiB, 4 * MiB, MiB]);
		expect(new Set(parts).size).toBe(3);
		expect(parts.every((part) => part !== bytes.buffer)).toBe(true);
		let differing = 0;
		parts.forEach((part, p) => {
			const view = new Uint8Array(part);
			for (let i = 0; i < view.length; i++) if (view[i] !== bytes[p * 4 * MiB + i]) differing++;
		});
		expect(differing).toBe(0);
		expect(toParts(new Uint8Array(0))).toEqual([]);
		expect(toParts(new Uint8Array(4 * MiB)).map((part) => part.byteLength)).toEqual([4 * MiB]);
	});
});
