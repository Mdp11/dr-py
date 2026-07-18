import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { toCmDiagnostics } from '../lint-map';

const doc = Text.of(['import os', 'print(x)']);

describe('toCmDiagnostics', () => {
	it('maps 1-based line + 0-based col to doc offsets', () => {
		const [d] = toCmDiagnostics(doc, [
			{ line: 2, col: 6, severity: 'warning', message: 'unknown name x' }
		]);
		expect(d.from).toBe(doc.line(2).from + 6);
		expect(d.to).toBe(doc.line(2).to);
		expect(d.severity).toBe('warning');
	});

	it('clamps col overflow to the line end and drops out-of-range lines', () => {
		const [d] = toCmDiagnostics(doc, [{ line: 1, col: 999, severity: 'error', message: 'boom' }]);
		expect(d.from).toBe(doc.line(1).to);
		expect(
			toCmDiagnostics(doc, [{ line: 99, col: 0, severity: 'error', message: 'gone' }])
		).toHaveLength(0);
	});
});
