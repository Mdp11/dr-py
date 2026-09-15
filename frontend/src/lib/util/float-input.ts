/**
 * Text-input parsing for `float` properties.
 *
 * JSON has no infinity literal, so an infinite float travels through the
 * model as one of two canonical string tokens (the backend's
 * `FLOAT_INFINITIES`). A plain `<input type="number">` can hold neither, so
 * float fields are text inputs that accept a finite number or any common
 * spelling of an infinity and store the canonical form.
 */

export type FloatInfinity = 'Infinity' | '-Infinity';
export type FloatValue = number | FloatInfinity;

const POSITIVE = new Set(['infinity', 'inf', '+infinity', '+inf', '∞', '+∞']);
const NEGATIVE = new Set(['-infinity', '-inf', '-∞']);

export function isFloatInfinity(value: unknown): value is FloatInfinity {
	return value === 'Infinity' || value === '-Infinity';
}

/**
 * `null` = blank (clear the value), `undefined` = not a float (keep the
 * previous value and warn), otherwise the value to store.
 */
export function parseFloatInput(raw: string): FloatValue | null | undefined {
	const text = raw.trim();
	if (text === '') return null;
	const lower = text.toLowerCase();
	if (POSITIVE.has(lower)) return 'Infinity';
	if (NEGATIVE.has(lower)) return '-Infinity';
	// Number('') is 0 and Number('Infinity') is Infinity, both handled above;
	// what remains is finite or garbage (NaN).
	const n = Number(text);
	return Number.isFinite(n) ? n : undefined;
}

/** The text an input shows for a stored float value. */
export function floatInputText(value: unknown): string {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (isFloatInfinity(value)) return value;
	return '';
}
