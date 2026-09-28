import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	buildWorkbook,
	PyFloat,
	ReadError,
	sheetTitle,
	type TableCell,
	type Value
} from '../../src/index.ts';
import { family } from '../model/fixtures.ts';
import { readXlsx, xlsxParts } from './xlsx-reader.ts';
import { SAMPLE_URL, sampleWorkbook } from './xlsx-sample.ts';

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

/** A workbook of one column under `header`, a row a value. */
const column = (header: string, values: readonly Value[]) =>
	buildWorkbook(
		model,
		[header],
		'S',
		values.map((v) => [value(v)]),
		null
	);

/** Every `<v>` of the sheet, in order. */
const valueTexts = (bytes: Uint8Array) =>
	[...xlsxParts(bytes)['xl/worksheets/sheet1.xml']!.matchAll(/<v>([^<]*)<\/v>/g)].map((m) => m[1]);

function refusal(run: () => unknown): ReadError {
	try {
		run();
	} catch (error) {
		if (error instanceof ReadError) return error;
		throw error;
	}
	throw new Error('no refusal');
}

describe('buildWorkbook', () => {
	it('writes the same bytes twice', () => {
		const rows = [[value('a'), value(new PyFloat(2.5)), value(true)]];
		const build = () => buildWorkbook(model, ['#', 'A', 'B', 'C'], 'Sheet', rows, 0);
		expect(build()).toEqual(build());
		expect(sampleWorkbook()).toEqual(sampleWorkbook());
	});

	it('keeps no date in docProps/core.xml', () => {
		const core = xlsxParts(column('H', ['x']))['docProps/core.xml']!;
		expect(core).toContain('<cp:coreProperties');
		expect(core).not.toMatch(/dcterms:(created|modified)|[0-9]{4}-[0-9]{2}-[0-9]{2}/);
	});

	it('autofits a column as xlsxwriter does, a blank header adding nothing', () => {
		const width = (v: Value) => readXlsx(column('', [v])).widths['A'];
		expect(width('s')).toBe(1.85546875);
		expect(width('x'.repeat(40))).toBe(41);
		expect(width('日本語テキスト')).toBe(9);
		expect(width(true)).toBe(5.42578125);
		expect(width(false)).toBe(6.140625);
	});

	it('measures the widest line of a multi-line string, and a number by its str()', () => {
		const width = (v: Value) => readXlsx(column('', [v])).widths['A'];
		expect(width('x'.repeat(40) + '\nab')).toBe(41);
		// str(2.5) is three characters, str(10**20) twenty-one.
		expect(width(new PyFloat(2.5))).toBe(width('000'));
		expect(width(10n ** 20n)).toBe(width('0'.repeat(21)));
	});

	it('adds the filter button to a header, caps a width at 600 px, and leaves a blank column unset', () => {
		const grid = readXlsx(
			buildWorkbook(
				model,
				['H', '', 'C'],
				'S',
				[[value('m'.repeat(200)), value(''), value(null)]],
				null
			)
		);
		expect(grid.widths).toEqual({ A: 85.7109375, C: 4.42578125 });
		expect(grid.autofilter).toBe('A1:C2');
		expect(grid.pane).toBe('A2');
	});

	it('writes contiguous columns of one width as one <col>', () => {
		const bytes = buildWorkbook(model, ['a', 'a', 'cc'], 'S', [], null);
		expect(xlsxParts(bytes)['xl/worksheets/sheet1.xml']).toContain(
			'<cols><col min="1" max="2" width="4.28515625" bestFit="1" customWidth="1"/>' +
				'<col min="3" max="3" width="5" bestFit="1" customWidth="1"/></cols>'
		);
	});

	it("writes each value as xlsxwriter's write() does", () => {
		const grid = readXlsx(
			column('H', [
				'=1+1',
				'http://x',
				'',
				null,
				true,
				false,
				7,
				new PyFloat(1),
				new PyFloat(-0),
				2 ** 60,
				['a', 1],
				{ k: null }
			])
		);
		expect(grid.rows.map((row) => row[0])).toEqual([
			{ v: 'H', t: 's' },
			{ v: '=1+1', t: 's' },
			{ v: 'http://x', t: 's' },
			{ v: null, t: 'n' },
			{ v: null, t: 'n' },
			{ v: true, t: 'b' },
			{ v: false, t: 'b' },
			{ v: 7, t: 'n' },
			{ v: 1, t: 'n' },
			{ v: 0, t: 'n' },
			{ v: 1.152921504606847e18, t: 'n' },
			{ v: "['a', 1]", t: 's' },
			{ v: "{'k': None}", t: 's' }
		]);
	});

	it("writes a number as Python's '%.16G', rounding half to even on the exact value", () => {
		const texts = valueTexts(
			column('', [
				new PyFloat(-0),
				new PyFloat(2.5),
				new PyFloat(1e20),
				new PyFloat(1e23),
				new PyFloat(0.1),
				new PyFloat(1e-5),
				new PyFloat(0.0001),
				new PyFloat(1234567890123456.5),
				new PyFloat(123456789012345.25),
				new PyFloat(5e-324),
				2 ** 53,
				2n ** 64n,
				-3
			])
		);
		expect(texts).toEqual([
			'-0',
			'2.5',
			'1E+20',
			'9.999999999999999E+22',
			'0.1',
			'1E-05',
			'0.0001',
			'1234567890123456',
			'123456789012345.2',
			'4.940656458412465E-324',
			'9007199254740992',
			'1.844674407370955E+19',
			'-3'
		]);
	});

	it("escapes a string as xlsxwriter's shared strings do", () => {
		const sst = xlsxParts(
			column('H', ['a & <b>', ' lead', 'trail\n', '\u0001_x0041_\uffff', 'a\nb'])
		)['xl/sharedStrings.xml']!;
		expect(sst).toContain(
			'<si><t>a &amp; &lt;b&gt;</t></si>' +
				'<si><t xml:space="preserve"> lead</t></si>' +
				'<si><t xml:space="preserve">trail\n</t></si>' +
				'<si><t>_x0001__x005F_x0041__xFFFF_</t></si>' +
				'<si><t>a\nb</t></si>'
		);
		expect(sst).toContain('count="6" uniqueCount="6"');
	});

	it('writes a string that looks like markup or an array formula as a plain string', () => {
		const grid = readXlsx(column('H', ['{=1+1}', '<r>abc</r>']));
		expect(grid.rows.slice(1)).toEqual([[{ v: '{=1+1}', t: 's' }], [{ v: '<r>abc</r>', t: 's' }]]);
	});

	it('cuts a string to 32,767 code points, as xlsxwriter does', () => {
		const long = '𝒜'.repeat(40000);
		const grid = readXlsx(column('H', [long]));
		expect(Array.from(grid.rows[1]![0]!.v as string)).toHaveLength(32767);
	});

	it("refuses a lone surrogate with Python's encoder error, positioned in the part it breaks", () => {
		expect(refusal(() => column('H', ['ab\ud800c'])).detail).toBe(
			"'utf-8' codec can't encode character '\\ud800' in position 9: surrogates not allowed"
		);
		expect(refusal(() => column('H\ud800', ['x'])).detail).toBe(
			"'utf-8' codec can't encode character '\\ud800' in position 8: surrogates not allowed"
		);
		expect(refusal(() => column('H', [' a&\udc00\ud800'])).detail).toBe(
			"'utf-8' codec can't encode characters in position 35-36: surrogates not allowed"
		);
		expect(
			refusal(() => buildWorkbook(model, ['H'], 'a\ud800', [[value('\ud800')]], null)).detail
		).toBe("'utf-8' codec can't encode character '\\ud800' in position 14: surrogates not allowed");
	});

	it('writes a row number at its column', () => {
		const grid = readXlsx(buildWorkbook(model, ['A', '#'], 'S', [[value('x')], [value('y')]], 1));
		expect(grid.rows.map((row) => row[1]!.v)).toEqual(['#', 1, 2]);
	});

	it('writes a sheet of no column with no filter and no shared strings', () => {
		const bytes = buildWorkbook(model, [], 'S', [[], []], null);
		const parts = xlsxParts(bytes);
		expect(Object.keys(parts)).not.toContain('xl/sharedStrings.xml');
		expect(parts['[Content_Types].xml']).not.toContain('sharedStrings');
		expect(parts['xl/styles.xml']).toContain('<fonts count="1">');
		expect(parts['xl/styles.xml']).toContain('<cellXfs count="1">');
		expect(readXlsx(bytes)).toEqual({
			title: 'S',
			rows: [],
			widths: {},
			pane: 'A2',
			autofilter: null
		});
	});

	it('writes the cell formats in use only, as xlsxwriter does', () => {
		const styles = (rows: TableCell[][]) =>
			xlsxParts(buildWorkbook(model, ['H'], 'S', rows, null))['xl/styles.xml']!;
		expect(styles([])).toContain('<borders count="2">');
		expect(styles([])).toContain('<cellXfs count="2">');
		expect(styles([[value('x')]])).toContain('<borders count="3">');
		expect(styles([[value('x')]])).toContain('<cellXfs count="3">');
	});

	it('quotes the filter range sheet name as xlsxwriter does', () => {
		const definedName = (name: string) =>
			/<definedName [^>]*>([^<]*)<\/definedName>/.exec(
				xlsxParts(buildWorkbook(model, ['H'], name, [], null))['xl/workbook.xml']!
			)![1];
		expect(definedName('table')).toBe('table!$A$1');
		expect(definedName('My Sheet')).toBe("'My Sheet'!$A$1");
		expect(definedName("it's")).toBe("'it''s'!$A$1");
		expect(definedName('1st')).toBe("'1st'!$A$1");
		expect(definedName('ab12')).toBe("'ab12'!$A$1");
		expect(definedName('abcd12')).toBe('abcd12!$A$1');
		expect(definedName('ﬀ1')).toBe("'ﬀ1'!$A$1");
		expect(definedName('R1x')).toBe("'R1x'!$A$1");
		expect(definedName('rc')).toBe("'rc'!$A$1");
		expect(definedName('a😀')).toBe('a😀!$A$1');
		expect(definedName('😀a')).toBe("'😀a'!$A$1");
		expect(definedName('a&b')).toBe("'a&amp;b'!$A$1");
	});

	it('is the committed sample, which openpyxl reads as the oracle wrote it', () => {
		const committed = new Uint8Array(readFileSync(SAMPLE_URL));
		expect(
			Buffer.compare(sampleWorkbook(), committed) === 0,
			'the engine no longer writes fixtures/xlsx/sample.xlsx: run `npm run xlsx-sample` ' +
				'(pixi run engine-xlsx-sample) and check it with tests/golden/test_engine_xlsx.py'
		).toBe(true);
	});
});

describe('sheetTitle', () => {
	it('replaces the characters Excel forbids, cuts to 31 code points, then strips apostrophes', () => {
		expect(sheetTitle('a[b]:c*d?e/f\\g')).toBe('a_b__c_d_e_f_g');
		expect(sheetTitle("'quoted name'")).toBe('quoted name');
		expect(sheetTitle('')).toBe('Table');
		expect(sheetTitle("''''")).toBe('Table');
		expect(sheetTitle('a'.repeat(30) + "'" + 'extra text past the limit')).toBe('a'.repeat(30));
		expect(sheetTitle('x'.repeat(40))).toBe('x'.repeat(31));
		expect(sheetTitle('𝒜'.repeat(40))).toBe('𝒜'.repeat(31));
		expect(sheetTitle("a[b]:c*d?e/f\\g'𝒜日xxxxxxxxxxxxx'yyyy")).toBe(
			"a_b__c_d_e_f_g'𝒜日xxxxxxxxxxxxx"
		);
	});
});
