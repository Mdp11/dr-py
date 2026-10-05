import { describe, expect, it } from 'vitest';
import {
	FacetPatterns,
	Metamodel,
	Model,
	PyFloat,
	pyIsoDate,
	pyReprFrozen,
	pyStrNumber,
	validateScoped,
	Validators,
	valueConforms,
	type MetamodelDoc
} from '../../src/index.ts';

describe('pyIsoDate is date.fromisoformat', () => {
	it.each([
		'2024-01-01',
		'20240101',
		'2024-W01',
		'2024-W01-1',
		'2024W011',
		'2024W01',
		'0001-01-01',
		'9999-12-31',
		'2020-W53-7',
		'2024-02-29',
		'2020-W53',
		'9999-W52-5',
		// the two bytes past an eight-byte date are never read
		'20240101xx',
		'20240101é',
		'2024W011xx'
	])('accepts %j', (s) => {
		expect(pyIsoDate(s)).toBe(true);
	});

	it.each([
		'2024-001',
		'2024-1-1',
		'２０２４-01-01',
		'2024-01-01 ',
		'2024-02-30',
		'0000-01-01',
		'2024-01-01T00:00',
		'+2024-01-01',
		'2024-W53',
		'2024-W00-1',
		'2024-W01-8',
		'2024-01',
		'202401',
		'2024-0101',
		'2023-02-29',
		'2021-W53',
		'9999-W52-6',
		'0000-W01-1',
		'2024-01-0é',
		'2024W01-1',
		'2024W0112',
		'2024-W011',
		'20240101\ud800',
		'2024\ud800101',
		'2024-01-01x',
		''
	])('refuses %j', (s) => {
		expect(pyIsoDate(s)).toBe(false);
	});
});

describe('the renderings', () => {
	it('pyReprFrozen is repr of the frozen value', () => {
		expect(pyReprFrozen([])).toBe('()');
		expect(pyReprFrozen(['x'])).toBe("('x',)");
		expect(pyReprFrozen({ b: 1, a: [1, 2] })).toBe("(('a', (1, 2)), ('b', 1))");
		expect(pyReprFrozen({})).toBe('()');
		expect(pyReprFrozen([null, true, new PyFloat(1), "it's", 10n ** 20n])).toBe(
			'(None, True, 1.0, "it\'s", 100000000000000000000)'
		);
	});

	it('pyStrNumber is str of a number', () => {
		expect(pyStrNumber(new PyFloat(1e20))).toBe('1e+20');
		expect(pyStrNumber(new PyFloat(2.5))).toBe('2.5');
		expect(pyStrNumber(-3)).toBe('-3');
		expect(pyStrNumber(10n ** 20n)).toBe('100000000000000000000');
	});
});

function metamodel(pattern: string, sibling: string | null = null): Metamodel {
	const doc: MetamodelDoc = {
		enums: { Color: ['red'] },
		elements: [
			{
				name: 'A',
				abstract: false,
				extends: null,
				key: null,
				properties: [
					{
						name: 'code',
						datatype: 'string',
						multiplicity: '0..1',
						min: null,
						max: null,
						pattern,
						max_length: null
					},
					...(sibling === null
						? []
						: [
								{
									name: 'tag',
									datatype: 'string' as const,
									multiplicity: '0..1' as const,
									min: null,
									max: null,
									pattern: sibling,
									max_length: null
								}
							])
				]
			}
		],
		relationships: []
	};
	return Metamodel.fromJSON(doc);
}

describe('valueConforms', () => {
	const mm = metamodel('[A-Z]+');

	it('holds each datatype to its Python type', () => {
		expect(valueConforms(1, 'integer', mm)).toBe(true);
		expect(valueConforms(10n ** 20n, 'integer', mm)).toBe(true);
		expect(valueConforms(new PyFloat(1), 'integer', mm)).toBe(false);
		expect(valueConforms(true, 'integer', mm)).toBe(false);
		expect(valueConforms(new PyFloat(1), 'float', mm)).toBe(true);
		expect(valueConforms(1, 'float', mm)).toBe(true);
		expect(valueConforms('Infinity', 'float', mm)).toBe(true);
		expect(valueConforms('-Infinity', 'float', mm)).toBe(true);
		expect(valueConforms('inf', 'float', mm)).toBe(false);
		expect(valueConforms(true, 'float', mm)).toBe(false);
		expect(valueConforms(false, 'boolean', mm)).toBe(true);
		expect(valueConforms(0, 'boolean', mm)).toBe(false);
		expect(valueConforms('red', 'Color', mm)).toBe(true);
		expect(valueConforms('blue', 'Color', mm)).toBe(false);
		expect(valueConforms('2024-01-01', 'date', mm)).toBe(true);
		expect(valueConforms(20240101, 'date', mm)).toBe(false);
		expect(valueConforms('x', 'nothing', mm)).toBe(false);
	});
});

describe('FacetPatterns', () => {
	it('lists a pattern outside the translator with its reason', () => {
		const patterns = new FacetPatterns(metamodel('(?i:x)'));
		expect(patterns.unusable()).toEqual([
			{ pattern: '(?i:x)', reason: 'inline flags other than a leading (?i), (?m) or (?s)' }
		]);
		expect(patterns.test('(?i:x)', 'x')).toEqual({
			reason: 'inline flags other than a leading (?i), (?m) or (?s)'
		});
	});

	it('is usable over patterns the translator takes', () => {
		const patterns = new FacetPatterns(metamodel('[A-Z]+'));
		expect(patterns.unusable()).toEqual([]);
		expect(patterns.test('[A-Z]+', 'AB')).toBe(true);
		expect(patterns.test('[A-Z]+', 'ABc')).toBe(false);
	});
});

describe('validateScoped', () => {
	function model(pattern: string, code: string | null, tag: string | null = null): Model {
		const m = new Model(metamodel(pattern, tag === null ? null : '[a-z]+'));
		const props: Record<string, string> = {};
		if (code !== null) props['code'] = code;
		if (tag !== null) props['tag'] = tag;
		m.insertElement('a-1', 'A', props, 1);
		return m;
	}

	it('reports each value of an uncheckable pattern as one error, and checks its siblings', () => {
		const m = model('(?i:x)', 'x', 'AB');
		const issues = validateScoped(
			m,
			['a-1'],
			new Validators(m.metamodel),
			new FacetPatterns(m.metamodel)
		);
		expect(issues.map((i) => [i.message, i.severity, i.category, i.targetIds])).toEqual([
			[
				"code: pattern '(?i:x)' cannot be checked: inline flags other than a leading (?i), (?m) or (?s)",
				'error',
				'conformance',
				['a-1']
			],
			["tag: 'AB' does not match pattern '[a-z]+'", 'error', 'conformance', ['a-1']]
		]);
	});

	it('reports nothing while no value meets such a pattern', () => {
		const m = model('(?i:x)', null);
		expect(
			validateScoped(m, ['a-1'], new Validators(m.metamodel), new FacetPatterns(m.metamodel))
		).toEqual([]);
	});

	it('refuses validators built for another metamodel', () => {
		const m = model('[A-Z]+', 'x');
		const other = metamodel('[A-Z]+');
		expect(() =>
			validateScoped(m, ['a-1'], new Validators(other), new FacetPatterns(m.metamodel))
		).toThrow('validators built for another metamodel');
	});
});
