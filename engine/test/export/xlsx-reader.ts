/**
 * Reads a one-sheet workbook as `tests/golden/model_steps.py::_grid` reads it
 * through openpyxl: every cell's value and type over the sheet's used
 * rectangle, the custom column widths, the frozen pane's top-left cell and
 * the autofilter range. It reads what the engine's writer writes and refuses
 * anything else, so a shape it does not know fails loudly.
 */
import { unzipSync } from 'fflate';

export type XlsxCell = { v: string | number | boolean | null; t: string };

export type XlsxGrid = {
	title: string;
	rows: XlsxCell[][];
	widths: { [letter: string]: number };
	pane: string | null;
	autofilter: string | null;
};

const decoder = new TextDecoder('utf-8', { fatal: true });

/** The workbook's parts, by path, as UTF-8 text. */
export function xlsxParts(bytes: Uint8Array): { [path: string]: string } {
	const parts: { [path: string]: string } = {};
	for (const [path, member] of Object.entries(unzipSync(bytes))) {
		parts[path] = decoder.decode(member);
	}
	return parts;
}

function unescapeXml(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, ref: string) => {
		if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
		if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
		return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[ref]!;
	});
}

function attr(tag: string, name: string): string | null {
	const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	return match === null ? null : unescapeXml(match[1]!);
}

/** 1-based column number of a column's letters. */
function columnNumber(letters: string): number {
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n;
}

function columnLetters(n: number): string {
	let out = '';
	for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
		out = String.fromCharCode(65 + ((rest - 1) % 26)) + out;
	}
	return out;
}

/** openpyxl's `_cast_number`: a float when the text holds `.`, `E` or `e`, else an int. */
function castNumber(text: string): number {
	if (/[.Ee]/.test(text)) return Number(text);
	if (!/^-?[0-9]+$/.test(text)) throw new Error(`not an int: ${text}`);
	const n = Number(text);
	return n === 0 ? 0 : n;
}

/** Each `<si>`'s text: its `<t>`, or its runs' `<t>`s joined, less the `x005F_` escape prefix. */
function sharedStrings(xml: string | undefined): string[] {
	if (xml === undefined) return [];
	const strings: string[] = [];
	for (const [, body] of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
		let text = '';
		for (const [, , inner] of body!.matchAll(/<t(\s[^>]*)?>([\s\S]*?)<\/t>|<t(\s[^>]*)?\/>/g)) {
			text += unescapeXml(inner ?? '');
		}
		strings.push(text.replaceAll('x005F_', ''));
	}
	return strings;
}

function cellValue(type: string, raw: string | null, strings: readonly string[]): XlsxCell {
	if (raw === null || raw === '') return { v: null, t: type };
	switch (type) {
		case 'n':
			return { v: castNumber(raw), t: 'n' };
		case 's':
			return { v: strings[Number(raw)]!, t: 's' };
		case 'b':
			return { v: Number(raw) !== 0, t: 'b' };
		case 'str':
			return { v: raw, t: 's' };
		default:
			throw new Error(`unexpected cell type ${type}`);
	}
}

export function readXlsx(bytes: Uint8Array): XlsxGrid {
	const parts = xlsxParts(bytes);
	const workbook = parts['xl/workbook.xml']!;
	const sheets = [...workbook.matchAll(/<sheet\s[^>]*\/>/g)];
	if (sheets.length !== 1) throw new Error(`expected one sheet, found ${sheets.length}`);
	const title = attr(sheets[0]![0], 'name')!;
	const strings = sharedStrings(parts['xl/sharedStrings.xml']);
	const sheet = parts['xl/worksheets/sheet1.xml']!;

	const widths = new Map<number, number>();
	for (const [tag] of sheet.matchAll(/<col\s[^>]*\/>/g)) {
		const custom = attr(tag, 'customWidth');
		if (custom !== '1' && custom !== 'true') continue;
		const width = Number(attr(tag, 'width'));
		for (let c = Number(attr(tag, 'min')); c <= Number(attr(tag, 'max')); c++) widths.set(c, width);
	}

	const cells = new Map<string, XlsxCell>();
	let maxRow = 0;
	let maxCol = 0;
	const cellTags = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
	for (const [, attrs, body] of sheet.matchAll(cellTags)) {
		const tag = ` ${attrs!}`;
		const ref = /^([A-Z]+)([0-9]+)$/.exec(attr(tag, 'r')!)!;
		const col = columnNumber(ref[1]!);
		const row = Number(ref[2]);
		if (body !== undefined && body.includes('<f')) throw new Error(`a formula in ${ref[0]}`);
		const v = body === undefined ? null : /<v>([\s\S]*?)<\/v>/.exec(body);
		const raw = v === null ? null : unescapeXml(v[1]!);
		cells.set(`${row}:${col}`, cellValue(attr(tag, 't') ?? 'n', raw, strings));
		maxRow = Math.max(maxRow, row);
		maxCol = Math.max(maxCol, col);
	}
	const rows: XlsxCell[][] = [];
	for (let r = 1; r <= maxRow; r++) {
		const row: XlsxCell[] = [];
		for (let c = 1; c <= maxCol; c++) row.push(cells.get(`${r}:${c}`) ?? { v: null, t: 'n' });
		rows.push(row);
	}

	const pane = /<pane\s[^>]*\/>/.exec(sheet);
	const filter = /<autoFilter\s[^>]*?\/?>/.exec(sheet);
	return {
		title,
		rows,
		widths: Object.fromEntries(
			[...widths.keys()].sort((a, b) => a - b).map((c) => [columnLetters(c), widths.get(c)!])
		),
		pane: pane === null ? null : attr(pane[0], 'topLeftCell'),
		autofilter: filter === null ? null : attr(filter[0], 'ref')
	};
}
