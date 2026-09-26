import { describe, expect, it } from 'vitest';
import { PyFloat, renderCsv, type TableCell, type Value } from '../../src/index.ts';
import { family } from '../model/fixtures.ts';

const model = family();

const BLANK: TableCell = {
	kind: 'value',
	item: null,
	ref_type: null,
	present: true,
	value: null,
	element_id: null,
	editable: false,
	items: null,
	values: null,
	total: null,
	truncated: null,
	message: null,
	traceback: null
};

const value = (v: Value): TableCell => ({ ...BLANK, value: v });
const absent = (): TableCell => ({ ...BLANK, present: false, value: 'ignored' });
const element = (id: string | null): TableCell => ({
	...BLANK,
	kind: 'element',
	present: null,
	item: id === null ? null : { id, type_name: 'Node', display_name: '', child_count: 0 }
});

const lines = (text: string) => text.split('\r\n');

describe('renderCsv', () => {
	it('writes the header, then one CRLF-ended line a row, as csv.writer does', () => {
		expect(renderCsv(model, ['A', 'B'], [[value('x'), value('y')]], null)).toBe('A,B\r\nx,y\r\n');
		expect(renderCsv(model, ['A'], [], null)).toBe('A\r\n');
	});

	it('quotes a field holding a comma, a quote, CR or LF, doubling a quote, and no other', () => {
		const fields = ['a,b', 'say "hi"', 'cr\rhere', 'line\nbreak', ' lead space', "it's", 'tab\tx'];
		const row = renderCsv(model, fields, [], null);
		expect(row).toBe('"a,b","say ""hi""","cr\rhere","line\nbreak", lead space,it\'s,tab\tx\r\n');
	});

	it("writes non-strings through Python's str()", () => {
		const cases: [Value, string][] = [
			[new PyFloat(1), '1.0'],
			[new PyFloat(-0), '-0.0'],
			[new PyFloat(1e16), '1e+16'],
			[new PyFloat(1.5), '1.5'],
			[true, 'True'],
			[false, 'False'],
			[3, '3'],
			[1152921504606846976n, '1152921504606846976'],
			[[1, 'a'], '"[1, \'a\']"'],
			[{ a: 1 }, "{'a': 1}"],
			[{ a: [1, 'b'] }, "\"{'a': [1, 'b']}\""]
		];
		for (const [v, field] of cases) {
			expect(lines(renderCsv(model, ['h', 'x'], [[value(v), value('x')]], null))[1]).toBe(
				`${field},x`
			);
		}
	});

	it('writes an absent or empty value blank, and one blank field alone as ""', () => {
		expect(lines(renderCsv(model, ['h'], [[value('')], [absent()], [value(null)]], null))).toEqual([
			'h',
			'""',
			'""',
			'""',
			''
		]);
		expect(lines(renderCsv(model, ['h', 'i'], [[value(''), absent()]], null))[1]).toBe(',');
		expect(lines(renderCsv(model, ['h', 'i'], [[value(''), value('b')]], null))[1]).toBe(',b');
	});

	it('writes an element as its name, and a missing one blank', () => {
		const text = renderCsv(
			model,
			['El', 'x'],
			[
				[element('a'), value(1)],
				[element(null), value(2)]
			],
			null
		);
		expect(lines(text)).toEqual(['El,x', 'A,1', ',2', '']);
	});

	it('numbers rows from 1 in the row-number column', () => {
		const rows = [[value('a')], [value('b')]];
		expect(renderCsv(model, ['#', 'v'], rows, 0)).toBe('#,v\r\n1,a\r\n2,b\r\n');
		expect(renderCsv(model, ['v', 'n'], rows, 1)).toBe('v,n\r\na,1\r\nb,2\r\n');
		// The row number is the only field: never blank.
		expect(renderCsv(model, ['#'], [[], []], 0)).toBe('#\r\n1\r\n2\r\n');
	});

	it('writes a row of no fields as a bare CRLF', () => {
		expect(renderCsv(model, [], [[], []], null)).toBe('\r\n\r\n\r\n');
	});

	it('joins several values and elements with "; " through str()', () => {
		const values: TableCell = {
			...BLANK,
			kind: 'values',
			values: [1, new PyFloat(2), 'x', true, null]
		};
		const elements: TableCell = {
			...BLANK,
			kind: 'elements',
			present: null,
			items: ['a', 'b'].map((id) => ({ id, type_name: 'Node', display_name: '', child_count: 0 }))
		};
		expect(lines(renderCsv(model, ['V', 'E'], [[values, elements]], null))[1]).toBe(
			'1; 2.0; x; True; None,A; B'
		);
	});
});
