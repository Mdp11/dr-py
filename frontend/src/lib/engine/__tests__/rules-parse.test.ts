import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { WireStagedArtifact } from '$engine';
import { server } from '$lib/api/__tests__/server';
import { parseRules } from '$lib/api/rules';
import type { RulesParseOut } from '$lib/api/types';
import { createRulesParser, engineParse } from '../rules-parse';
import { DE_ONLY, DE_OR_FR, parsed, RULES_KIND, rulesPayload, yamlOf } from './support/rules';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A parser whose every parse waits for a deferred the test settles, in the order asked. */
function parserOver() {
	const asked: { yaml: string; answer: Deferred<RulesParseOut> }[] = [];
	const parser = createRulesParser((yaml) => {
		const answer = deferred<RulesParseOut>();
		asked.push({ yaml, answer });
		return answer.promise;
	});
	let heard = 0;
	parser.onParsed(() => {
		heard += 1;
	});
	return { parser, asked, heard: () => heard };
}

const A = yamlOf(DE_ONLY);
const B = yamlOf(DE_OR_FR);

const create = (id: string, yaml: string, kind = RULES_KIND): WireStagedArtifact => ({
	op: 'create',
	id,
	kind,
	name: id,
	payload: rulesPayload(yaml)
});

const update = (id: string, yaml: string): WireStagedArtifact => ({
	op: 'update',
	id,
	payload: rulesPayload(yaml)
});

const noKind = () => undefined;

/** Once the microtasks queued so far, and what they queue, have run. */
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('the rules parser', () => {
	it("marks a rules create 'pending' and starts one parse for two entries with the same text", () => {
		const { parser, asked } = parserOver();

		const out = parser.attach([create('tmp_a', A), create('tmp_b', A)], noKind);

		expect(out).toEqual([
			{ ...create('tmp_a', A), rules: 'pending' },
			{ ...create('tmp_b', A), rules: 'pending' }
		]);
		expect(asked.map((ask) => ask.yaml)).toEqual([A]);

		// Attached again while it is out: no second parse.
		parser.attach([create('tmp_a', A)], noKind);
		expect(asked).toHaveLength(1);
	});

	it('when it lands, onParsed fires and the next attach carries the parse', async () => {
		const { parser, asked, heard } = parserOver();
		parser.attach([create('tmp_a', A)], noKind);

		asked[0]!.answer.resolve(parsed(DE_ONLY));
		await parser.settled();

		expect(heard()).toBe(1);
		expect(parser.attach([create('tmp_a', A), create('tmp_b', A)], noKind)).toEqual([
			{ ...create('tmp_a', A), rules: { ok: true, document: parsed(DE_ONLY).document } },
			{ ...create('tmp_b', A), rules: { ok: true, document: parsed(DE_ONLY).document } }
		]);
		expect(asked).toHaveLength(1);
	});

	it('a parse that failed on the server travels with its errors', async () => {
		const { parser, asked } = parserOver();
		parser.attach([create('tmp_a', A)], noKind);
		const failed: RulesParseOut = {
			ok: false,
			document: null,
			errors: [{ message: 'Malformed rules YAML', line: 1, column: 3 }]
		};

		asked[0]!.answer.resolve(failed);
		await parser.settled();

		expect(parser.attach([create('tmp_a', A)], noKind)).toEqual([
			{ ...create('tmp_a', A), rules: { ok: false, errors: failed.errors } }
		]);
	});

	it('a parse that is not answered is retried at the next attach, and only then', async () => {
		const { parser, asked, heard } = parserOver();
		parser.attach([create('tmp_a', A)], noKind);

		asked[0]!.answer.reject(new Error('network'));
		await parser.settled();
		await macrotask();

		expect(heard()).toBe(0);
		expect(asked).toHaveLength(1);
		expect(parser.attach([create('tmp_a', A)], noKind)).toEqual([
			{ ...create('tmp_a', A), rules: 'pending' }
		]);
		expect(asked.map((ask) => ask.yaml)).toEqual([A, A]);

		asked[1]!.answer.resolve(parsed(DE_ONLY));
		await parser.settled();
		expect(heard()).toBe(1);
		expect(parser.attach([create('tmp_a', A)], noKind)[0]).toMatchObject({
			rules: { ok: true }
		});
	});

	it('a 422 from /rules/parse is a parse not answered: nothing is made up, and the next attach asks again', async () => {
		const BASE = 'http://api.test/api/v1';
		let posts = 0;
		server.use(
			http.post(`${BASE}/rules/parse`, () => {
				posts += 1;
				return HttpResponse.json({ detail: 'invalid date' }, { status: 422 });
			})
		);
		const parser = createRulesParser((yaml) => parseRules(yaml, { baseUrl: BASE }));
		let heard = 0;
		parser.onParsed(() => {
			heard += 1;
		});
		const entry = create('tmp_a', 'x: 2001-13-45\n');

		expect(parser.attach([entry], noKind)).toEqual([{ ...entry, rules: 'pending' }]);
		await parser.settled();
		await macrotask();
		expect([posts, heard]).toEqual([1, 0]);

		expect(parser.attach([entry], noKind)).toEqual([{ ...entry, rules: 'pending' }]);
		await parser.settled();
		expect([posts, heard]).toEqual([2, 0]);
	});

	it('an answer the engine could not take is a parse not answered', async () => {
		const { parser, asked, heard } = parserOver();
		parser.attach([create('tmp_a', A)], noKind);

		asked[0]!.answer.resolve({ ok: true, document: null, errors: [] });
		await parser.settled();

		expect(heard()).toBe(0);
		expect(parser.attach([create('tmp_a', A)], noKind)[0]).toMatchObject({ rules: 'pending' });
		expect(asked).toHaveLength(2);
	});

	it('non-rules entries, updates without a payload and deletes pass through unchanged', () => {
		const { parser, asked } = parserOver();
		const entries: WireStagedArtifact[] = [
			create('tmp_n', A, 'navigation'),
			{ op: 'update', id: 'n1', payload: rulesPayload(A) },
			{ op: 'update', id: 'r1', name: 'renamed' },
			{ op: 'delete', id: 'r2' }
		];
		const kinds: Record<string, string> = { n1: 'navigation', r1: RULES_KIND, r2: RULES_KIND };

		const out = parser.attach(entries, (id) => kinds[id]);

		expect(out).toEqual(entries);
		out.forEach((entry, i) => expect(entry).toBe(entries[i]));
		expect(asked).toEqual([]);
	});

	it("an update's kind comes from kindOf", async () => {
		const { parser, asked } = parserOver();
		const kinds: Record<string, string> = { r1: RULES_KIND, n1: 'navigation' };
		const kindOf = (id: string) => kinds[id];

		expect(parser.attach([update('r1', B), update('n1', A)], kindOf)).toEqual([
			{ ...update('r1', B), rules: 'pending' },
			update('n1', A)
		]);
		expect(asked.map((ask) => ask.yaml)).toEqual([B]);
		// An id kindOf does not know is not a rule set.
		expect(parser.attach([update('r1', B), update('r9', A)], kindOf)).toEqual([
			{ ...update('r1', B), rules: 'pending' },
			update('r9', A)
		]);
		expect(asked).toHaveLength(1);

		asked[0]!.answer.resolve(parsed(DE_OR_FR));
		await parser.settled();
		expect(parser.attach([update('r1', B)], kindOf)).toEqual([
			{ ...update('r1', B), rules: { ok: true, document: parsed(DE_OR_FR).document } }
		]);
	});

	it('settled() resolves once no parse is out', async () => {
		const { parser, asked } = parserOver();
		await parser.settled();
		parser.attach([create('tmp_a', A), create('tmp_b', B)], noKind);
		let done = false;
		void parser.settled().then(() => {
			done = true;
		});

		asked[0]!.answer.resolve(parsed(DE_ONLY));
		await macrotask();
		expect(done).toBe(false);
		asked[1]!.answer.reject(new Error('network'));
		await macrotask();
		expect(done).toBe(true);
	});

	it('forgets the parse of a text no longer attached, and one that lands after it went', async () => {
		const { parser, asked, heard } = parserOver();
		parser.attach([create('tmp_a', A), create('tmp_b', B)], noKind);
		asked[0]!.answer.resolve(parsed(DE_ONLY));
		await macrotask();
		expect(heard()).toBe(1);

		// B is discarded while its parse is out; A is discarded after its landed.
		parser.attach([], noKind);
		asked[1]!.answer.resolve(parsed(DE_OR_FR));
		await parser.settled();
		expect(heard()).toBe(1);

		expect(parser.attach([create('tmp_a', A), create('tmp_b', B)], noKind)).toEqual([
			{ ...create('tmp_a', A), rules: 'pending' },
			{ ...create('tmp_b', B), rules: 'pending' }
		]);
		expect(asked.map((ask) => ask.yaml)).toEqual([A, B, A, B]);
	});
});

describe('engineParse', () => {
	it("keeps the document text as it came, and a failure's errors", () => {
		const text = '{"rules":[{"name":"r","applies_to":"A","then":{"property":"n","gt":1.0}}]}';
		expect(engineParse({ ok: true, document: text, errors: [] })).toEqual({
			ok: true,
			document: text
		});
		const errors = [{ message: 'bad', line: null, column: null }];
		expect(engineParse({ ok: false, document: null, errors })).toEqual({ ok: false, errors });
	});

	it('is null for a body the engine could not read as a parse', () => {
		expect(engineParse({ ok: true, document: null, errors: [] })).toBeNull();
		expect(engineParse({ ok: false, document: null, errors: [] })).toBeNull();
	});
});
