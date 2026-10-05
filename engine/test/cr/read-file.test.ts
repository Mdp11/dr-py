import { describe, expect, it } from 'vitest';
import {
	decodeModelFile,
	Metamodel,
	parseExact,
	PyFloat,
	ReadError,
	readModelFile,
	type MetamodelDoc
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { thrown } from '../golden/thrown.ts';

const metamodel = Metamodel.fromJSON(
	loadFixture<{ metamodel: MetamodelDoc }>('change_request').metamodel
);

const bytesOf = (...parts: (string | number[])[]): ArrayBuffer => {
	const chunks = parts.map((part) =>
		typeof part === 'string' ? new TextEncoder().encode(part) : Uint8Array.from(part)
	);
	const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out.buffer;
};

const BOM = [0xef, 0xbb, 0xbf];

const unreadable = (fn: () => unknown) => {
	const error = thrown(fn);
	expect(error).toBeInstanceOf(ReadError);
	expect(error).toMatchObject({ status: 422, detail: 'not a UTF-8 JSON model file' });
};

describe('decodeModelFile', () => {
	it('decodes UTF-8', () => {
		expect(decodeModelFile(bytesOf('{"a": "é☃"}'))).toBe('{"a": "é☃"}');
	});

	it('strips one byte order mark and keeps a second', () => {
		expect(decodeModelFile(bytesOf(BOM, '{}'))).toBe('{}');
		expect(decodeModelFile(bytesOf(BOM, BOM, '{}'))).toBe('\ufeff{}');
	});

	it('refuses invalid UTF-8', () => {
		unreadable(() => decodeModelFile(bytesOf('{"a": "', [0xff], '"}')));
		unreadable(() => decodeModelFile(bytesOf('{"a": "', [0xc3], '"}')));
	});

	it('refuses the bytes of a lone surrogate', () => {
		unreadable(() => decodeModelFile(bytesOf('{"a": "', [0xed, 0xa0, 0x80], '"}')));
	});

	it('refuses UTF-16 with its byte order mark', () => {
		unreadable(() => decodeModelFile(bytesOf([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00])));
	});
});

describe("parseExact's control characters", () => {
	it('are taken raw by default', () => {
		expect(parseExact('"a\u0001b"')).toBe('a\u0001b');
	});

	it('are refused raw inside a string, as json.loads refuses them', () => {
		for (const code of [0x00, 0x01, 0x0a, 0x1f]) {
			const text = `{"k": "a${String.fromCharCode(code)}b"}`;
			expect(thrown(() => parseExact(text, { controlCharacters: false }))).toBeInstanceOf(
				SyntaxError
			);
		}
	});

	it('are accepted escaped, and whitespace between tokens is no string', () => {
		expect(parseExact('"a\\u0001b"', { controlCharacters: false })).toBe('a\u0001b');
		expect(parseExact('{\t"k":\n\t[1,\r\n2]}', { controlCharacters: false })).toEqual({
			k: [1, 2]
		});
		expect(parseExact('"a\u007fb"', { controlCharacters: false })).toBe('a\u007fb');
	});
});

describe('readModelFile', () => {
	// `POST /model/compare`'s refusals, as the change_request fixture records them.
	it.each([
		['[]', 'Model payload must be a JSON object'],
		['{"elements": null}', "Model payload field 'elements' must be a list"],
		['{"elements": [], "relationships": 5}', "Model payload field 'relationships' must be a list"],
		['{"elements": [5]}', 'elements[0]: must be an object'],
		['{"elements": [{"type_name": "Team"}]}', "elements[0]: field 'id' must be a string"],
		[
			'{"elements": [{"id": "x", "type_name": 5}]}',
			"elements[0]: field 'type_name' must be a string"
		],
		[
			'{"elements": [{"id": "tmp_x", "type_name": "Team"}]}',
			"Element id 'tmp_x' uses the reserved 'tmp_' prefix (client-side temporary ids of the ops protocol); loaded models must not contain such ids"
		],
		[
			'{"elements": [{"id": "x", "type_name": "NamedElement"}]}',
			"Element type 'NamedElement' is abstract and cannot be instantiated"
		],
		[
			'{"elements": [{"id": "x", "type_name": "Team"}, {"id": "x", "type_name": "Team"}]}',
			"Duplicate element id 'x' in snapshot"
		],
		[
			'{"elements": [{"id": "x", "type_name": "Team", "properties": []}]}',
			"elements[0]: field 'properties' must be an object"
		],
		[
			'{"elements": [{"id": "x", "type_name": "Team", "rev": true}]}',
			"elements[0]: field 'rev' must be an integer"
		],
		[
			'{"elements": [{"id": "x", "type_name": "Team", "rev": 1.5}]}',
			"elements[0]: field 'rev' must be an integer"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "r", "type_name": "MemberOf", "source_id": "p"}]}',
			"relationships[0]: field 'target_id' must be a string"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "tmp_r", "type_name": "MemberOf", "source_id": "p", "target_id": "t"}]}',
			"Relationship id 'tmp_r' uses the reserved 'tmp_' prefix (client-side temporary ids of the ops protocol); loaded models must not contain such ids"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "r", "type_name": "MemberOf", "source_id": "ghost", "target_id": "t"}]}',
			"Relationship 'r' references unknown source 'ghost'"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "r", "type_name": "MemberOf", "source_id": "p", "target_id": "ghost"}]}',
			"Relationship 'r' references unknown target 'ghost'"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "r", "type_name": "MemberOf", "source_id": "p", "target_id": "t"}, {"id": "r", "type_name": "MemberOf", "source_id": "p", "target_id": "t"}]}',
			"Duplicate relationship id 'r' in snapshot"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "r", "type_name": "MemberOf", "source_id": "p", "target_id": "t", "rev": "1"}]}',
			"relationships[0]: field 'rev' must be an integer"
		],
		[
			'{"elements": [{"id": "x", "type_name": "Team"}, {"id": "x", "type_name": "Team", "properties": []}]}',
			"Duplicate element id 'x' in snapshot"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": 1}], "relationships": [5]}',
			"elements[1]: field 'id' must be a string"
		],
		['{"elements": [5], "relationships": 5}', "Model payload field 'relationships' must be a list"],
		['{"elements": [{"type_name": 5}]}', "elements[0]: field 'id' must be a string"],
		[
			'{"elements": [{"id": "tmp_x", "type_name": "NamedElement"}]}',
			"Element id 'tmp_x' uses the reserved 'tmp_' prefix (client-side temporary ids of the ops protocol); loaded models must not contain such ids"
		],
		[
			'{"elements": [{"id": "x", "type_name": "Team"}, {"id": "x", "type_name": "NamedElement"}]}',
			"Element type 'NamedElement' is abstract and cannot be instantiated"
		],
		[
			'{"elements": [{"id": "x", "type_name": "Team", "properties": [], "rev": true}]}',
			"elements[0]: field 'properties' must be an object"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "tmp_r", "type_name": "MemberOf", "source_id": "ghost", "target_id": "t"}]}',
			"Relationship id 'tmp_r' uses the reserved 'tmp_' prefix (client-side temporary ids of the ops protocol); loaded models must not contain such ids"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "r", "type_name": "MemberOf", "source_id": "ghost", "target_id": "ghost"}]}',
			"Relationship 'r' references unknown source 'ghost'"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "r", "type_name": "MemberOf", "source_id": "p", "target_id": "t"}, {"id": "r", "type_name": "MemberOf", "source_id": "p", "target_id": "ghost"}]}',
			"Relationship 'r' references unknown target 'ghost'"
		],
		[
			'{"elements": [{"id": "t", "type_name": "Team"}, {"id": "p", "type_name": "Person"}], "relationships": [{"id": "r", "type_name": "MemberOf", "source_id": "p", "target_id": "t", "properties": 5, "rev": "1"}]}',
			"relationships[0]: field 'properties' must be an object"
		]
	])('refuses %s', (text, detail) => {
		const error = thrown(() => readModelFile(parseExact(text), metamodel));
		expect(error).toBeInstanceOf(ReadError);
		expect(error).toMatchObject({ status: 422, detail });
	});

	it('reads what the server tolerates, in file order', () => {
		const other = readModelFile(
			parseExact(
				'{"rev": 5, "elements": [' +
					'{"id": "b", "type_name": "Nope", "extra": 1},' +
					'{"id": "a", "type_name": "Team", "properties": null, "rev": 18446744073709551616},' +
					'{"id": "s", "type_name": "Team", "properties": {"0": 1, "x": 1.0}}' +
					'], "relationships": [' +
					'{"id": "s", "type_name": "NopeRel", "source_id": "a", "target_id": "b"}]}'
			),
			metamodel
		);
		expect([...other.elements.keys()]).toEqual(['b', 'a', 's']);
		expect(other.elements.get('b')).toEqual({ id: 'b', typeName: 'Nope', props: {}, rev: 0 });
		expect(other.elements.get('a')).toEqual({
			id: 'a',
			typeName: 'Team',
			props: {},
			rev: 18446744073709551616n
		});
		expect(other.elements.get('s')!.props).toEqual({ '0': 1, x: new PyFloat(1) });
		expect(other.relationships.get('s')).toEqual({
			id: 's',
			typeName: 'NopeRel',
			sourceId: 'a',
			targetId: 'b',
			props: {},
			rev: 0
		});
	});

	it('reads an empty object as an empty model', () => {
		const other = readModelFile(parseExact('{}'), metamodel);
		expect(other.elements.size).toBe(0);
		expect(other.relationships.size).toBe(0);
	});
});
