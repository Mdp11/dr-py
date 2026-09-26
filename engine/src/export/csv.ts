/**
 * The CSV writer of `core/table/csv_export.py`: `csv.writer`'s excel dialect,
 * minimal quoting and CRLF, a cell as `cellText` renders it and a non-string
 * through Python's `str()`. Encoding is the caller's, UTF-8 without a BOM.
 */
import type { Model } from '../model/model.ts';
import { Meter } from '../navigation/evaluate.ts';
import { drain, type Steps } from '../steps/steps.ts';
import { cellText } from '../table/cell-text.ts';
import type { TableCell } from '../table/cells.ts';
import { pyStr } from '../value/repr.ts';
import type { Value } from '../value/types.ts';

const NEEDS_QUOTES = /[",\r\n]/;

function field(value: Value): string {
	const text = value === null ? '' : pyStr(value);
	return NEEDS_QUOTES.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

/** One record and its CRLF; a record of one empty field is `""`, as an empty line would read as none. */
function record(values: readonly Value[]): string {
	if (values.length === 1 && field(values[0]!) === '') return '""\r\n';
	return values.map(field).join(',') + '\r\n';
}

/**
 * The file's lines, one step a slice of rows: the header, then each row's
 * cells with the 1-based row number at `rowNumberAt`. A row carries a cell
 * for every header but the row number's.
 */
export function* csvLinesSteps(
	model: Model,
	headers: readonly string[],
	rows: readonly (readonly TableCell[])[],
	rowNumberAt: number | null,
	meter: Meter
): Steps<string[]> {
	const width = headers.length - (rowNumberAt === null ? 0 : 1);
	const lines = [record(headers)];
	for (const [r, row] of rows.entries()) {
		if (row.length !== width) {
			throw new Error(`row ${r + 1} has ${row.length} cell(s), expected ${width}`);
		}
		const values: Value[] = row.map((cell) => cellText(model, cell));
		if (rowNumberAt !== null) values.splice(rowNumberAt, 0, r + 1);
		lines.push(record(values));
		if (meter.tick()) yield meter.end();
	}
	return lines;
}

/** The whole file as text. */
export function renderCsv(
	model: Model,
	headers: readonly string[],
	rows: readonly (readonly TableCell[])[],
	rowNumberAt: number | null
): string {
	return drain(csvLinesSteps(model, headers, rows, rowNumberAt, new Meter(0))).join('');
}
