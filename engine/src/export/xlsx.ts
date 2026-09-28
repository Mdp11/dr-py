/**
 * The xlsx writer of `api/table_export.py::build_workbook`, writing the parts
 * xlsxwriter writes for it, byte for byte, but for `docProps/core.xml`, which
 * keeps no date: the bytes are a function of the grid alone. One sheet: a bold
 * header over a medium bottom border, thin borders on every cell, the header
 * row frozen, an autofilter over header and rows, and each column autofitted
 * as xlsxwriter's `autofit` measures it.
 *
 * A cell's value picks its cell as xlsxwriter's `write()` does: a string is
 * shared, `''` and `None` are formatted blanks, a bool is a boolean, an int
 * or float a number, a list or dict the text CSV writes for it. A string
 * `write()` would turn into an array formula (`{=…}`) or rich text markup
 * (`<r>…</r>`) stays a plain string here.
 */
import type { Model } from '../model/model.ts';
import { Meter } from '../navigation/evaluate.ts';
import type { ReadError } from '../read/errors.ts';
import { drain, type Steps } from '../steps/steps.ts';
import { cellText } from '../table/cell-text.ts';
import type { TableCell } from '../table/cells.ts';
import { DECIMAL_DIGITS, SPACE_POINTS } from '../value/digit-tables.ts';
import { pyStr } from '../value/repr.ts';
import { PyFloat, type Value } from '../value/types.ts';
import { surrogateRefusal, utf8Encoder } from './utf8.ts';
import {
	PLAIN_NAME_RANGES,
	QUOTED_START_RANGES,
	THEME_XML,
	UPPER_REFERENCE
} from './xlsx-tables.ts';
import { CHAR_WIDTHS, DEFAULT_CHAR_WIDTH } from './xlsx-widths.ts';
import { zipEntries } from './zip.ts';

// -- sheet title -------------------------------------------------------------------

const INVALID_TITLE_CHARS = new Set(['[', ']', ':', '*', '?', '/', '\\']);

/**
 * `_sheet_title`: the characters Excel forbids in a sheet name replaced by
 * `_`, cut to 31 code points, then its outer apostrophes stripped; `Table`
 * when nothing is left.
 */
export function sheetTitle(name: string): string {
	const cut = Array.from(name, (ch) => (INVALID_TITLE_CHARS.has(ch) ? '_' : ch)).slice(0, 31);
	return cut.join('').replace(/^'+|'+$/g, '') || 'Table';
}

function inRanges(ranges: readonly number[], cp: number): boolean {
	let lo = 0;
	let hi = ranges.length / 2 - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (cp < ranges[2 * mid]!) hi = mid - 1;
		else if (cp > ranges[2 * mid + 1]!) lo = mid + 1;
		else return true;
	}
	return false;
}

let digitValues: Map<number, number> | undefined;

/** The value of a code point `\d` accepts, as `int()` reads it. */
function digitOf(cp: number): number | undefined {
	if (digitValues === undefined) {
		digitValues = new Map();
		for (let i = 0; i < DECIMAL_DIGITS.length; i += 2) {
			digitValues.set(DECIMAL_DIGITS[i]!, DECIMAL_DIGITS[i + 1]!);
		}
	}
	return digitValues.get(cp);
}

/**
 * The digits `\d+` matches at `at` of `cps`, as a number past `limit` once it
 * outgrows it: `[value, end]`, or `null` when there is no digit.
 */
function digitsAt(cps: readonly number[], at: number, limit: number): [number, number] | null {
	let value = 0;
	let end = at;
	for (; end < cps.length; end++) {
		const digit = digitOf(cps[end]!);
		if (digit === undefined) break;
		value = Math.min(value * 10 + digit, limit + 1);
	}
	return end === at ? null : [value, end];
}

const ROW_MAX = 1048576;
const COL_MAX = 16384;

const isCapital = (cp: number) => cp >= 0x41 && cp <= 0x5a;

/** `quote_sheetname`'s verdict: whether a reference must quote the sheet's name. */
function needsQuotes(name: string): boolean {
	const cps = Array.from(name, (ch) => ch.codePointAt(0)!);
	// Rule 1: anything but \w, '.' and xlsxwriter's emoji.
	if (cps.some((cp) => !inRanges(PLAIN_NAME_RANGES, cp))) return true;
	// Rule 2: a leading digit, '.' or emoji.
	if (cps.length > 0 && inRanges(QUOTED_START_RANGES, cps[0]!)) return true;
	// Rules 3 and 4 read `name.upper()`; only what upper-cases to an ASCII
	// capital or a digit can match them.
	const upper = Array.from(
		Array.from(name, (ch) => {
			const cp = ch.codePointAt(0)!;
			if (cp >= 0x61 && cp <= 0x7a) return String.fromCharCode(cp - 32);
			return UPPER_REFERENCE.get(cp) ?? ch;
		}).join(''),
		(ch) => ch.codePointAt(0)!
	);
	// Rule 3: an A1 reference within the sheet's bounds.
	let letters = 0;
	while (letters < upper.length && isCapital(upper[letters]!)) letters++;
	if (letters >= 1 && letters <= 3) {
		const digits = digitsAt(upper, letters, ROW_MAX);
		if (digits !== null && digits[1] === upper.length) {
			let col = 0;
			for (let i = 0; i < letters; i++) col = col * 26 + (upper[i]! - 0x40);
			return digits[0] - 1 < ROW_MAX && col - 1 < COL_MAX && digits[0] >= 1;
		}
	}
	const R = 0x52;
	const C = 0x43;
	// Rule 4: a leading R1 or C1 / RC1 reference within the sheet's bounds.
	if (upper[0] === R) {
		const row = digitsAt(upper, 1, ROW_MAX);
		if (row !== null) return row[0] > 0 && row[0] <= ROW_MAX;
	}
	const cAt = upper[0] === R ? 1 : 0;
	if (upper[cAt] === C) {
		const col = digitsAt(upper, cAt + 1, COL_MAX);
		if (col !== null) return col[0] > 0 && col[0] <= COL_MAX;
	}
	const whole = upper.map((cp) => String.fromCodePoint(cp)).join('');
	return whole === 'R' || whole === 'C' || whole === 'RC';
}

/** A sheet name as a reference writes it, quoted as `quote_sheetname` quotes it. */
function quoteSheetName(name: string): string {
	if (name.startsWith("'") || !needsQuotes(name)) return name;
	return `'${name.replaceAll("'", "''")}'`;
}

// -- numbers -----------------------------------------------------------------------

/**
 * `x` as `format(x, '.16G')` writes it: rounded half to even, on its exact
 * binary value, to 16 significant digits, trailing zeros dropped; exponent
 * notation below 1e-4 and from 1e16. `lower` is `.16g`'s lowercase `e`.
 */
function formatG16(x: number, lower = false): string {
	if (x === 0) return Object.is(x, -0) ? '-0' : '0';
	const sign = x < 0 ? '-' : '';
	let digits: string;
	// Position of the decimal point relative to the first digit.
	let point: number;
	if (Number.isSafeInteger(x)) {
		digits = String(Math.abs(x));
		point = digits.length;
	} else {
		[digits, point] = exactDecimal(Math.abs(x));
		if (digits.length > 16) {
			let head = BigInt(digits.slice(0, 16));
			const rest = digits.slice(16);
			const up =
				rest[0]! > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || head % 2n === 1n));
			if (up) head += 1n;
			digits = head.toString();
			if (digits.length > 16) {
				digits = digits.slice(0, 16);
				point += 1;
			}
		}
	}
	digits = digits.replace(/0+$/, '');
	const exp = point - 1;
	if (exp >= -4 && exp < 16) {
		if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
		const whole = digits.slice(0, point).padEnd(point, '0');
		const fraction = digits.slice(point);
		return fraction === '' ? sign + whole : `${sign}${whole}.${fraction}`;
	}
	const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
	const magnitude = String(Math.abs(exp)).padStart(2, '0');
	return `${sign}${mantissa}${lower ? 'e' : 'E'}${exp < 0 ? '-' : '+'}${magnitude}`;
}

/** The exact decimal digits of a finite positive double, and where its point falls. */
function exactDecimal(x: number): [digits: string, point: number] {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, x);
	const bits = view.getBigUint64(0);
	const field = Number((bits >> 52n) & 0x7ffn);
	let mantissa = bits & 0xfffffffffffffn;
	let exponent = field === 0 ? -1074 : field - 1075;
	if (field !== 0) mantissa |= 1n << 52n;
	while ((mantissa & 1n) === 0n && exponent < 0) {
		mantissa >>= 1n;
		exponent++;
	}
	if (exponent >= 0) {
		const digits = (mantissa << BigInt(exponent)).toString();
		return [digits, digits.length];
	}
	// m / 2^k is m * 5^k / 10^k.
	const digits = (mantissa * 5n ** BigInt(-exponent)).toString();
	return [digits, digits.length + exponent];
}

// -- escaping ----------------------------------------------------------------------

const escapeData = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const escapeAttribute = (text: string) =>
	escapeData(text).replaceAll('"', '&quot;').replaceAll('\n', '&#xA;');

// `re_control_chars_1`, then `re_control_chars_2` and the two noncharacters.
const ESCAPE_LIKE = /(_x[0-9a-fA-F]{4}_)/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\ufffe\uffff]/g;

/**
 * `_escape_control_characters`: what XML cannot hold as `_xHHHH_`, and a
 * text that already reads as such an escape guarded by `_x005F`.
 */
function escapeControl(text: string): string {
	return text
		.replace(ESCAPE_LIKE, '_x005F$1')
		.replace(CONTROL, (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
}

let spaces: Set<number> | undefined;

/** `_preserve_whitespace`: a leading or a trailing `\s`. */
function preservesSpace(text: string): boolean {
	if (text === '') return false;
	spaces ??= new Set(SPACE_POINTS);
	return spaces.has(text.charCodeAt(0)) || spaces.has(text.charCodeAt(text.length - 1));
}

// -- cells -------------------------------------------------------------------------

const STRING_MAX = 32767;

/** `xl_pixel_width`. */
function pixelWidth(text: string): number {
	let width = 0;
	for (const ch of text) width += CHAR_WIDTHS.get(ch.codePointAt(0)!) ?? DEFAULT_CHAR_WIDTH;
	return width;
}

/** The pixels `autofit` gives a string: its widest line. */
function stringWidth(text: string): number {
	if (!text.includes('\n')) return pixelWidth(text);
	let widest = 0;
	for (const line of text.split('\n')) widest = Math.max(widest, pixelWidth(line));
	return widest;
}

/** Column letters of a 0-based column. */
function columnName(col: number): string {
	let name = '';
	for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
		name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	}
	return name;
}

/** The shared strings, in the order first written, and how many cells use one. */
class SharedStrings {
	readonly strings: string[] = [];
	private readonly index = new Map<string, number>();
	count = 0;

	add(text: string): number {
		this.count++;
		let at = this.index.get(text);
		if (at === undefined) {
			at = this.strings.length;
			this.index.set(text, at);
			this.strings.push(text);
		}
		return at;
	}
}

/**
 * The sheet's rows as written, its shared strings, and the widest a column's
 * cells measure: `write()`'s dispatch on a value, and `autofit`'s measure of
 * the cell it wrote.
 */
class SheetWriter {
	readonly sst = new SharedStrings();
	readonly pixels: number[];
	readonly rows: string[] = [];
	private readonly letters: string[];
	private readonly spans: string;

	constructor(width: number) {
		this.pixels = new Array<number>(width).fill(0);
		this.letters = Array.from({ length: width }, (_, col) => columnName(col));
		// Every row holds a cell in every column.
		this.spans = `1:${width}`;
	}

	private claim(col: number, pixels: number): void {
		if (pixels > this.pixels[col]!) this.pixels[col] = pixels;
	}

	cell(row: number, col: number, style: number, value: Value, filter: boolean): string {
		const ref = this.letters[col]! + (row + 1);
		let pixels = 0;
		let xml: string;
		if (value === null || value === '') {
			xml = `<c r="${ref}" s="${style}"/>`;
		} else if (typeof value === 'boolean') {
			xml = `<c r="${ref}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
			pixels = value ? 31 : 36;
		} else if (typeof value === 'number') {
			xml = `<c r="${ref}" s="${style}"><v>${formatG16(value)}</v></c>`;
			// A number measures `7 * len(str(n))`.
			pixels = 7 * pyStr(value).length;
		} else if (typeof value === 'bigint') {
			const float = Number(value);
			if (!Number.isFinite(float)) throw new Error('int too large to convert to float');
			xml = `<c r="${ref}" s="${style}"><v>${formatG16(float)}</v></c>`;
			pixels = 7 * pyStr(value).length;
		} else if (value instanceof PyFloat) {
			if (!Number.isFinite(value.value)) {
				throw new Error("NAN/INF not supported in write_number() without 'nan_inf_to_errors'");
			}
			xml = `<c r="${ref}" s="${style}"><v>${formatG16(value.value)}</v></c>`;
			pixels = 7 * pyStr(value).length;
		} else {
			let text = pyStr(value);
			if (text.length > STRING_MAX && Array.from(text).length > STRING_MAX) {
				text = Array.from(text).slice(0, STRING_MAX).join('');
			}
			xml = `<c r="${ref}" s="${style}" t="s"><v>${this.sst.add(text)}</v></c>`;
			pixels = stringWidth(text);
		}
		// A header cell under the autofilter gains its button.
		if (filter && pixels > 0) pixels += 16;
		this.claim(col, pixels);
		return xml;
	}

	row(row: number, cells: string): void {
		this.rows.push(`<row r="${row + 1}" spans="${this.spans}">${cells}</row>`);
	}
}

// -- parts -------------------------------------------------------------------------

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function contentTypes(shared: boolean): string {
	const override = (part: string, type: string) =>
		`<Override PartName="${part}" ContentType="application/vnd.openxmlformats-${type}"/>`;
	return (
		XML_DECLARATION +
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		override('/docProps/app.xml', 'officedocument.extended-properties+xml') +
		override('/docProps/core.xml', 'package.core-properties+xml') +
		override('/xl/styles.xml', 'officedocument.spreadsheetml.styles+xml') +
		override('/xl/theme/theme1.xml', 'officedocument.theme+xml') +
		override('/xl/workbook.xml', 'officedocument.spreadsheetml.sheet.main+xml') +
		override('/xl/worksheets/sheet1.xml', 'officedocument.spreadsheetml.worksheet+xml') +
		(shared
			? override('/xl/sharedStrings.xml', 'officedocument.spreadsheetml.sharedStrings+xml')
			: '') +
		'</Types>'
	);
}

const relationship = (id: number, type: string, target: string) =>
	`<Relationship Id="rId${id}" Type="${type}" Target="${target}"/>`;

const ROOT_RELS =
	XML_DECLARATION +
	`<Relationships xmlns="${PACKAGE_REL_NS}">` +
	relationship(1, `${REL_NS}/officeDocument`, 'xl/workbook.xml') +
	relationship(
		2,
		'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
		'docProps/core.xml'
	) +
	relationship(3, `${REL_NS}/extended-properties`, 'docProps/app.xml') +
	'</Relationships>';

function workbookRels(shared: boolean): string {
	return (
		XML_DECLARATION +
		`<Relationships xmlns="${PACKAGE_REL_NS}">` +
		relationship(1, `${REL_NS}/worksheet`, 'worksheets/sheet1.xml') +
		relationship(2, `${REL_NS}/theme`, 'theme/theme1.xml') +
		relationship(3, `${REL_NS}/styles`, 'styles.xml') +
		(shared ? relationship(4, `${REL_NS}/sharedStrings`, 'sharedStrings.xml') : '') +
		'</Relationships>'
	);
}

/** `<sheet>` as one write of xlsxwriter's: the chunk a lone surrogate in the title breaks. */
const sheetTag = (title: string) =>
	`<sheet name="${escapeAttribute(title)}" sheetId="1" r:id="rId1"/>`;

function workbook(title: string, filterArea: string | null): string {
	const names =
		filterArea === null
			? ''
			: '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' +
				escapeControl(escapeData(filterArea)) +
				'</definedName></definedNames>';
	return (
		XML_DECLARATION +
		`<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
		'<fileVersion appName="xl" lastEdited="4" lowestEdited="4" rupBuild="4505"/>' +
		'<workbookPr defaultThemeVersion="124226"/>' +
		'<bookViews><workbookView xWindow="240" yWindow="15" windowWidth="16095" windowHeight="9660"/></bookViews>' +
		`<sheets>${sheetTag(title)}</sheets>` +
		names +
		'<calcPr calcId="124519" fullCalcOnLoad="1"/>' +
		'</workbook>'
	);
}

const border = (bottom: string) =>
	'<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>' +
	`<top style="thin"><color auto="1"/></top><bottom style="${bottom}"><color auto="1"/></bottom><diagonal/></border>`;

const font = (bold: boolean) =>
	`<font>${bold ? '<b/>' : ''}<sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>`;

/**
 * The cell formats in use, as xlsxwriter writes only those: the default, then
 * the header's (bold, thin border, medium bottom) once a header is written,
 * then a data cell's (thin border) once a row is.
 */
function styles(used: 0 | 1 | 2): string {
	const xf = [
		'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
		'<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>',
		'<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1"/>'
	].slice(0, used + 1);
	const borders = [
		'<border><left/><right/><top/><bottom/><diagonal/></border>',
		border('medium'),
		border('thin')
	].slice(0, used + 1);
	const fonts = used > 0 ? [font(false), font(true)] : [font(false)];
	return (
		XML_DECLARATION +
		`<styleSheet xmlns="${MAIN_NS}">` +
		`<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
		'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
		`<borders count="${borders.length}">${borders.join('')}</borders>` +
		'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
		`<cellXfs count="${xf.length}">${xf.join('')}</cellXfs>` +
		'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
		'<dxfs count="0"/>' +
		'<tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/>' +
		'</styleSheet>'
	);
}

/** `docProps/core.xml` without the created and modified stamps xlsxwriter takes off the clock. */
const CORE =
	XML_DECLARATION +
	'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
	'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
	'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
	'<dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy></cp:coreProperties>';

function app(title: string): string {
	return (
		XML_DECLARATION +
		'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
		'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
		'<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
		'<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>' +
		'<vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
		'<TitlesOfParts><vt:vector size="1" baseType="lpstr">' +
		`<vt:lpstr>${escapeControl(escapeData(title))}</vt:lpstr></vt:vector></TitlesOfParts>` +
		'<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
		'<HyperlinksChanged>false</HyperlinksChanged><AppVersion>12.0000</AppVersion></Properties>'
	);
}

/** One `<si>`, as `_write_si` writes it in one write. */
function sharedItem(text: string): string {
	const escaped = escapeControl(text);
	const space = preservesSpace(escaped) ? ' xml:space="preserve"' : '';
	return `<si><t${space}>${escapeData(escaped)}</t></si>`;
}

// -- columns -----------------------------------------------------------------------

/** `_pixels_to_width`. */
const pixelsToWidth = (pixels: number) => (pixels <= 12 ? pixels / 12 : (pixels - 5) / 7);

/** The autofit ceiling, `xlsx_autofit_max_px`'s default. */
const AUTOFIT_MAX_PX = 600;

/** `_write_col_info`'s width text of a character width. */
function colWidthText(width: number): string {
	const snapped =
		width < 1
			? Math.trunc((Math.trunc(width * 12 + 0.5) / 7) * 256) / 256
			: Math.trunc(((Math.trunc(width * 7 + 0.5) + 5) / 7) * 256) / 256;
	return formatG16(snapped, true);
}

/** `<cols>`: each measured column's width, a run of equal ones in one `<col>`. */
function cols(pixels: readonly number[]): string {
	const max = Math.min(pixelsToWidth(AUTOFIT_MAX_PX), 255);
	const widths = pixels.map((px) => (px > 0 ? Math.min(pixelsToWidth(px + 7), max) : null));
	let xml = '';
	for (let first = 0; first < widths.length;) {
		const width = widths[first]!;
		let last = first;
		if (width === null) {
			first++;
			continue;
		}
		while (last + 1 < widths.length && widths[last + 1] === width) last++;
		xml +=
			`<col min="${first + 1}" max="${last + 1}" width="${colWidthText(width)}" ` +
			'bestFit="1" customWidth="1"/>';
		first = last + 1;
	}
	return xml === '' ? '' : `<cols>${xml}</cols>`;
}

// -- the workbook ------------------------------------------------------------------

const HEADER_STYLE = 1;
const CELL_STYLE = 2;

/**
 * The workbook's bytes, one step a slice of cells: the header, then each
 * row's cells with the 1-based row number at `rowNumberAt`; a row carries a
 * cell for every header but the row number's. The sheet is named
 * `sheetTitle(sheetName)`. A lone surrogate refuses with Python's encoder
 * error, positioned in the part it breaks first.
 */
export function* buildWorkbookSteps(
	model: Model,
	headers: readonly string[],
	sheetName: string,
	rows: readonly (readonly TableCell[])[],
	rowNumberAt: number | null,
	meter: Meter
): Steps<Uint8Array> {
	const ncols = headers.length;
	const width = ncols - (rowNumberAt === null ? 0 : 1);
	const sheet = new SheetWriter(ncols);
	if (ncols > 0) {
		sheet.row(0, headers.map((h, col) => sheet.cell(0, col, HEADER_STYLE, h, true)).join(''));
	}
	for (const [i, row] of rows.entries()) {
		if (row.length !== width) {
			throw new Error(`row ${i + 1} has ${row.length} cell(s), expected ${width}`);
		}
		if (ncols > 0) {
			const r = i + 1;
			let cells = '';
			let next = 0;
			for (let col = 0; col < ncols; col++) {
				const value = col === rowNumberAt ? r : cellText(model, row[next++]!);
				cells += sheet.cell(r, col, CELL_STYLE, value, false);
				if (meter.tick()) yield meter.end();
			}
			sheet.row(r, cells);
		}
	}

	const title = sheetTitle(sheetName);
	const lastRow = rows.length;
	const lastCell = ncols > 0 ? columnName(ncols - 1) + (lastRow + 1) : 'A1';
	const range = lastCell === 'A1' ? 'A1' : `A1:${lastCell}`;
	const absolute = lastCell === 'A1' ? '$A$1' : `$A$1:$${columnName(ncols - 1)}$${lastRow + 1}`;
	const filterArea = ncols > 0 ? `${quoteSheetName(title)}!${absolute}` : null;

	const { strings, count } = sheet.sst;
	const items = strings.map(sharedItem);
	// The workbook part is written before the shared strings.
	const refusal = surrogateRefusal(sheetTag(title)) ?? firstRefusal(items);
	if (refusal !== null) throw refusal;

	const worksheet =
		XML_DECLARATION +
		`<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
		`<dimension ref="${range}"/>` +
		'<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
		'<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
		'<selection pane="bottomLeft"/></sheetView></sheetViews>' +
		'<sheetFormatPr defaultRowHeight="15"/>' +
		cols(sheet.pixels) +
		(sheet.rows.length === 0 ? '<sheetData/>' : `<sheetData>${sheet.rows.join('')}</sheetData>`) +
		(ncols > 0 ? `<autoFilter ref="${range}"/>` : '') +
		'<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
		'</worksheet>';
	const shared = count > 0;
	const encoder = utf8Encoder();
	const part = (path: string, text: string) => ({ path, bytes: encoder.encode(text) });
	return zipEntries([
		part('[Content_Types].xml', contentTypes(shared)),
		part('_rels/.rels', ROOT_RELS),
		part('xl/_rels/workbook.xml.rels', workbookRels(shared)),
		part('xl/worksheets/sheet1.xml', worksheet),
		part('xl/workbook.xml', workbook(title, filterArea)),
		...(shared
			? [
					part(
						'xl/sharedStrings.xml',
						XML_DECLARATION +
							`<sst xmlns="${MAIN_NS}" count="${count}" uniqueCount="${strings.length}">` +
							items.join('') +
							'</sst>'
					)
				]
			: []),
		part('xl/styles.xml', styles(ncols === 0 ? 0 : rows.length === 0 ? 1 : 2)),
		part('xl/theme/theme1.xml', THEME_XML),
		part('docProps/core.xml', CORE),
		part('docProps/app.xml', app(title))
	]);
}

function firstRefusal(chunks: readonly string[]): ReadError | null {
	for (const chunk of chunks) {
		const refusal = surrogateRefusal(chunk);
		if (refusal !== null) return refusal;
	}
	return null;
}

/** The whole workbook at once. */
export function buildWorkbook(
	model: Model,
	headers: readonly string[],
	sheetName: string,
	rows: readonly (readonly TableCell[])[],
	rowNumberAt: number | null
): Uint8Array {
	return drain(buildWorkbookSteps(model, headers, sheetName, rows, rowNumberAt, new Meter(0)));
}
