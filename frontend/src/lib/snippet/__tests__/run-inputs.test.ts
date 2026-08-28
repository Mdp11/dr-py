import { describe, expect, it } from 'vitest';
import {
	emptyBinding,
	initialInputKind,
	parseScalarLines,
	toWireInputs,
	type InputBinding
} from '../run-inputs';
import type { Column } from '$lib/api/types';

const col = (kind: Column['kind']) => ({ kind }) as Column;

describe('initialInputKind', () => {
	it('starts element-producing columns on the element picker', () => {
		expect(initialInputKind(col('element'))).toBe('elements');
		expect(initialInputKind(col('navigation'))).toBe('elements');
	});

	it('starts everything else — and an unresolvable ref — on values', () => {
		expect(initialInputKind(col('property'))).toBe('scalars');
		expect(initialInputKind(col('script'))).toBe('scalars');
		expect(initialInputKind(undefined)).toBe('scalars');
	});
});

describe('parseScalarLines', () => {
	it('decodes JSON lines and keeps plain text as strings', () => {
		expect(parseScalarLines('3\ntrue\nnull\n"a, b"\nBuilding One')).toEqual([
			3,
			true,
			null,
			'a, b',
			'Building One'
		]);
	});

	it('drops blank lines so a trailing newline binds nothing extra', () => {
		expect(parseScalarLines('1\n\n  \n2\n')).toEqual([1, 2]);
		expect(parseScalarLines('')).toEqual([]);
	});

	it('binds an empty string only when written as JSON', () => {
		expect(parseScalarLines('""')).toEqual(['']);
	});
});

describe('toWireInputs', () => {
	it('renders both kinds in declaration order', () => {
		const bindings: Record<string, InputBinding> = {
			owners: { kind: 'elements', elements: [{ id: 'b2', label: 'Two' }] },
			qty: { kind: 'scalars', text: '7' }
		};
		expect(
			toWireInputs(
				[
					{ name: 'owners', kind: 'elements' },
					{ name: 'qty', kind: 'scalars' }
				],
				bindings
			)
		).toEqual({
			owners: { kind: 'elements', ids: ['b2'] },
			qty: { kind: 'scalars', values: [7] }
		});
	});

	it('ships an unbound input as an empty list rather than omitting it', () => {
		expect(toWireInputs([{ name: 'qty', kind: 'scalars' }], {})).toEqual({
			qty: { kind: 'scalars', values: [] }
		});
		expect(toWireInputs([{ name: 'owners', kind: 'elements' }], {})).toEqual({
			owners: { kind: 'elements', ids: [] }
		});
	});

	it('follows the binding kind, not the declared hint', () => {
		expect(
			toWireInputs([{ name: 'owners', kind: 'elements' }], {
				owners: { kind: 'scalars', text: 'x' }
			})
		).toEqual({ owners: { kind: 'scalars', values: ['x'] } });
	});
});

describe('emptyBinding', () => {
	it('matches the kind it is asked for', () => {
		expect(emptyBinding('elements')).toEqual({ kind: 'elements', elements: [] });
		expect(emptyBinding('scalars')).toEqual({ kind: 'scalars', text: '' });
	});
});
