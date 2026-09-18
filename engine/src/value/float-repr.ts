/**
 * `repr(float)` as Python renders it. Both languages print the shortest digits
 * that round-trip; only the layout differs (`1e+16`, `1e-05`, `5.0`).
 */
export function pyFloatRepr(x: number): string {
	if (Number.isNaN(x)) return 'nan';
	if (x === Infinity) return 'inf';
	if (x === -Infinity) return '-inf';
	const sign = x < 0 || Object.is(x, -0) ? '-' : '';
	const [mantissa, exponent] = Math.abs(x).toExponential().split('e') as [string, string];
	const digits = mantissa.replace('.', '');
	// Position of the decimal point relative to the first digit.
	const decpt = Number(exponent) + 1;
	if (decpt <= -4 || decpt > 16) {
		const e = decpt - 1;
		const tail = digits.length > 1 ? '.' + digits.slice(1) : '';
		const magnitude = String(Math.abs(e)).padStart(2, '0');
		return `${sign}${digits[0]}${tail}e${e < 0 ? '-' : '+'}${magnitude}`;
	}
	if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
	if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
	return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}
