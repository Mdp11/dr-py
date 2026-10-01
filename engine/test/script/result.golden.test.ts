import { describe, expect, it } from 'vitest';
import { hostErrorText } from '../../src/script/host-error.ts';
import { PENDING, parseScriptResult, type EmbeddedEntry } from '../../src/script/result.ts';
import { pyDumps } from '../../src/value/serialize.ts';
import type { Value } from '../../src/value/types.ts';
import { loadFixture, untag, type Tagged } from '../golden/load.ts';

type Decoded = {
	payload: Tagged | null;
	error: { kind: string; message: string; traceback: string | null } | null;
	reads: [string, string | null][] | null;
	stdout: string;
};

type Case = { text: string; entry: EmbeddedEntry; decoded: Decoded };

const cases = loadFixture<Case[]>('script_decode');

const dump = (value: Value) => pyDumps(value, undefined, { allowNan: true });

const keyText = ([tag, id]: readonly [string, string | null]) => dump([tag, id]);

describe('a script result text decodes as the oracle decodes it', () => {
	it('has a corpus that holds every kind of answer', () => {
		const messages = new Set(cases.map((c) => c.decoded.error?.message));
		expect(cases.length).toBeGreaterThan(150);
		expect(messages).toContain('malformed value() result payload');
		expect(messages).toContain('malformed step() result payload');
		expect(messages).toContain('malformed transform() result payload');
		expect(messages).toContain('malformed call result payload');
		expect(cases.some((c) => c.decoded.reads === null && c.decoded.error === null)).toBe(true);
		expect(cases.some((c) => c.decoded.error?.kind === 'timeout')).toBe(true);
		expect(cases.some((c) => c.decoded.reads?.length === 2000)).toBe(true);
	});

	it.each(cases.map((c, i) => [i, c.entry, c.text.slice(0, 90)] as const))(
		'case %i (%s) %s',
		(index) => {
			const { text, entry, decoded } = cases[index]!;
			const result = parseScriptResult(text, entry);
			const label = `${entry}: ${text.slice(0, 200)}`;
			expect(
				result.payload === null ? null : dump(result.payload as unknown as Value),
				`${label} payload`
			).toBe(decoded.payload === null ? null : dump(untag(decoded.payload)));
			expect(result.error, `${label} error`).toEqual(decoded.error);
			expect(result.stdout, `${label} stdout`).toBe(decoded.stdout);
			if (decoded.reads === null) expect(result.reads, `${label} reads`).toBeNull();
			else {
				// The oracle holds a set: each key once, in no order.
				const got = (result.reads ?? []).map(keyText);
				expect(new Set(got).size, `${label} reads are distinct`).toBe(got.length);
				expect(new Set(got), `${label} reads`).toEqual(new Set(decoded.reads.map(keyText)));
			}
		}
	);
});

describe('a script result', () => {
	it('keeps an integer past 2^53 and a float that reads as an integer', () => {
		const text =
			'{"payload": {"kind": "scalars", "values": [1152921504606846976, 1.0, 1]}, "error": null, "reads": [], "stdout": ""}';
		const result = parseScriptResult(text, 'value');
		expect(dump(result.payload as unknown as Value)).toBe(
			'{"kind":"scalars","values":[1152921504606846976,1.0,1]}'
		);
	});

	it('reads the text a host writes for a call it failed', () => {
		const text = hostErrorText(
			{ code: '', entry: 'value', calls: [{ elementIds: [] }] },
			'timeout',
			'call limit'
		);
		expect(parseScriptResult(text, 'value')).toEqual({
			payload: null,
			error: { kind: 'timeout', message: 'call limit', traceback: null },
			reads: null,
			stdout: ''
		});
	});

	it('is not computed until a fill answers it', () => {
		expect(PENDING).toEqual({
			payload: null,
			error: { kind: 'pending', message: 'not computed yet', traceback: null },
			reads: null,
			stdout: ''
		});
	});

	it('refuses a text that is not the harness answer', () => {
		expect(() => parseScriptResult('[]', 'value')).toThrow(/script result/);
		expect(() => parseScriptResult('{"payload": null}', 'value')).toThrow(/script result/);
		expect(() => parseScriptResult('not json', 'value')).toThrow();
	});
});
