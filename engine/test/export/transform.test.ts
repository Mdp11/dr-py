import { describe, expect, it } from 'vitest';
import {
	Meter,
	PENDING,
	PyFloat,
	pyTypeName,
	ReadError,
	TRANSFORM_MAX_BYTES,
	transformSteps,
	type ScriptReader
} from '../../src/index.ts';
import { counted } from './meters.ts';

// The size caps and the call a transform makes, over a reader that has run nothing: every call it
// is asked for is pending, as the first pass of a fill sees it.

type Call = Parameters<ScriptReader['read']>[0];

function asked(): { reader: ScriptReader; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		reader: {
			read(call) {
				calls.push(call);
				return PENDING;
			}
		}
	};
}

const run = (
	doc: Parameters<typeof transformSteps>[2],
	reader = asked().reader,
	meter = new Meter(0)
) => counted(transformSteps(reader, 'def transform(doc): return doc', doc, 'x', meter));

function refusal(doc: Parameters<typeof transformSteps>[2]): ReadError {
	try {
		run(doc);
	} catch (error) {
		expect(error).toBeInstanceOf(ReadError);
		return error as ReadError;
	}
	throw new Error('no refusal');
}

describe('transformSteps', () => {
	it('asks for the call with the document as compact JSON text, its keys in order', () => {
		const { reader, calls } = asked();
		const doc = new Map<string, unknown>([
			['10', 1],
			['2', [new PyFloat(1), null, 'é\n']],
			['b', new Map([['1', true]])]
		]);
		const { value } = run(doc as never, reader);
		expect(value).toEqual({ kind: 'pending' });
		expect(calls).toEqual([
			{
				code: 'def transform(doc): return doc',
				entry: 'transform',
				elementIds: [],
				inputsText: null,
				docText: '{"10":1,"2":[1.0,null,"é\\n"],"b":{"1":true}}'
			}
		]);
	});

	it('holds a document to 8 MiB of UTF-8, not of code units', () => {
		// `["` and `"]` take four bytes; `é` takes two.
		const atCap = ['é'.repeat((TRANSFORM_MAX_BYTES - 4) / 2)];
		expect(run(atCap).value).toEqual({ kind: 'pending' });
		const error = refusal(['é'.repeat((TRANSFORM_MAX_BYTES - 4) / 2 + 1)]);
		expect([error.status, error.detail]).toEqual([
			422,
			`x: transform document exceeds snippet_transform_max_bytes (${TRANSFORM_MAX_BYTES})`
		]);
		// Three bytes a unit fits fewer of them.
		expect(refusal(['日'.repeat(TRANSFORM_MAX_BYTES / 3)]).status).toBe(422);
	});

	it('refuses a lone surrogate as Python`s encoder does, before the cap', () => {
		const error = refusal(['ab\ud800c']);
		expect([error.status, error.detail]).toEqual([
			422,
			"'utf-8' codec can't encode character '\\ud800' in position 4: surrogates not allowed"
		]);
		// Past the cap, and in the last slice of the text: the encoder fails first.
		const long = ['x'.repeat(TRANSFORM_MAX_BYTES + 10) + '\udc00'];
		expect(refusal(long).detail).toMatch(
			/^'utf-8' codec can't encode character '\\udc00' in position /
		);
		// A pair is no lone surrogate, wherever a slice would cut it.
		for (let pad = 0; pad < 3; pad++) {
			expect(run(['x'.repeat(65_534 + pad) + '😀']).value).toEqual({ kind: 'pending' });
		}
	});

	it('ends a step a slice of a large document, not one for all of it', () => {
		const { yields } = run(['x'.repeat(3 * 1024 * 1024)]);
		expect(yields).toBeGreaterThan(20);
	});
});

describe('pyTypeName', () => {
	it('names the type Python gives a JSON value', () => {
		const names = [null, 'a', true, 1, 10n ** 30n, new PyFloat(1), [], {}, new Map()].map((v) =>
			pyTypeName(v as never)
		);
		expect(names).toEqual([
			'NoneType',
			'str',
			'bool',
			'int',
			'int',
			'float',
			'list',
			'dict',
			'dict'
		]);
	});
});
