import { describe, expect, it } from 'vitest';
import {
	PyFloat,
	pyRuleEq,
	readRuleSet,
	RulesUnreadable,
	type Condition,
	type PropertyAtom,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import type { RulesStepResult, StepsFixture } from '../golden/model-steps.ts';

const fixture = loadFixture<{ runs: StepsFixture[] }>('rules_compile');
const step = fixture.runs[0]!.steps.find((s) => s.do === 'rules')!;
const { parses } = step.result as RulesStepResult;

/** The document the server wrote for the source `artifactId`. */
function documentOf(artifactId: string): string {
	const i = step.sources!.findIndex((source) => source.artifact_id === artifactId);
	return parses[i]!.document!;
}

/** A document of one rule whose `then` is `then`. */
const oneRule = (then: unknown, extra: object = {}) =>
	JSON.stringify({ rules: [{ name: 'r', applies_to: 'T', then, ...extra }] });

const refusal = (text: string) => {
	try {
		readRuleSet(text);
	} catch (error) {
		return error;
	}
	return null;
};

describe('readRuleSet', () => {
	it('reads every document the server wrote', () => {
		for (const run of fixture.runs) {
			for (const s of run.steps.filter((x) => x.do === 'rules')) {
				for (const parse of (s.result as RulesStepResult).parses) {
					if (parse.ok) expect(() => readRuleSet(parse.document!)).not.toThrow();
				}
			}
		}
	});

	it('reads the AST field by field, defaults filled, operands exact', () => {
		const doc = readRuleSet(documentOf('a-all'));
		expect(doc.schemaVersion).toBe(1);
		const [everyTest, relationships, nulls] = doc.rules;
		expect(everyTest).toEqual({
			name: 'every-test',
			description: 'each property test once',
			appliesTo: 'Leaf',
			severity: 'warning',
			disabled: false,
			when: {
				all: [
					{ property: 'flag', test: { op: 'exists', value: true } },
					{ not: { property: 'name', test: { op: 'equals', value: null } } }
				]
			},
			then: {
				any: [
					{ property: 'name', test: { op: 'equals', value: 'x' } },
					{ property: 'name', test: { op: 'not_equals', value: null } },
					{
						property: 'level',
						test: {
							op: 'in',
							values: [
								1,
								'1',
								true,
								new PyFloat(1),
								new PyFloat(1.5),
								9007199254740993n,
								new PyFloat(-0)
							]
						}
					},
					{ property: 'score', test: { op: 'gt', bound: new PyFloat(1) } },
					{ property: 'score', test: { op: 'gte', bound: new PyFloat(Infinity) } },
					{ property: 'score', test: { op: 'lt', bound: new PyFloat(-Infinity) } },
					{ property: 'score', test: { op: 'lte', bound: new PyFloat(NaN) } },
					{ property: 'tags', test: { op: 'contains', value: 'a' } },
					{ property: 'level', test: { op: 'equals', value: 18446744073709551616n } },
					{ property: 'score', test: { op: 'equals', value: new PyFloat(2.5e-8) } },
					{ property: 'flag', test: { op: 'not_equals', value: false } },
					{ property: 'level', test: { op: 'exists', value: false } }
				]
			},
			message: 'custom text',
			identity: expect.any(String)
		});
		const inTest = (everyTest!.then as { any: readonly Condition[] }).any[2] as PropertyAtom;
		const operands = (inTest.test as { values: readonly Value[] }).values;
		expect(Object.is((operands[6] as PyFloat).value, -0)).toBe(true);
		expect(operands[3]).toBeInstanceOf(PyFloat);
		expect(typeof operands[0]).toBe('number');

		expect(relationships).toEqual({
			name: 'relationships',
			description: '',
			appliesTo: 'Root',
			severity: 'error',
			disabled: false,
			when: null,
			then: {
				all: [
					{
						type: 'Link',
						direction: 'outgoing',
						to: null,
						where: null,
						exists: true,
						count: null
					},
					{
						type: 'SubLink',
						direction: 'incoming',
						to: 'Mid',
						where: null,
						exists: null,
						count: { eq: 2, gte: 1, lte: 3 }
					},
					{
						type: 'Link',
						direction: 'outgoing',
						to: 'Leaf',
						where: {
							any: [
								{ property: 'score', test: { op: 'gt', bound: new PyFloat(0.5) } },
								{
									type: 'Owns',
									direction: 'incoming',
									to: 'Other',
									where: { property: 'code', test: { op: 'exists', value: true } },
									exists: false,
									count: null
								}
							]
						},
						exists: null,
						count: { eq: null, gte: 0, lte: null }
					}
				]
			},
			message: null,
			identity: expect.any(String)
		});

		expect(nulls).toEqual({
			name: 'nulls-as-pydantic-reads-them',
			description: '',
			appliesTo: 'Leaf',
			severity: 'error',
			disabled: false,
			when: null,
			then: {
				type: 'Link',
				direction: 'outgoing',
				to: null,
				where: null,
				exists: null,
				count: { eq: null, gte: 1, lte: null }
			},
			message: null,
			identity: expect.any(String)
		});
	});

	it("keeps each rule's entry as the server wrote it, as its identity", () => {
		for (const id of ['a-all', 'a-drift', 'a-twin-1']) {
			const text = documentOf(id);
			const { rules } = readRuleSet(text);
			expect(text.endsWith(`"rules":[${rules.map((rule) => rule.identity).join(',')}]}`)).toBe(
				true
			);
		}
	});

	it('reads an empty document as an empty set', () => {
		expect(readRuleSet('{}')).toEqual({ schemaVersion: 1, rules: [] });
		expect(readRuleSet('{"schema_version":1,"rules":[]}')).toEqual({
			schemaVersion: 1,
			rules: []
		});
	});

	it('tells a bare Infinity from the string "Infinity"', () => {
		const bare = readRuleSet(
			'{"rules":[{"name":"r","applies_to":"T","then":{"property":"p","equals":Infinity}}]}'
		);
		const text = readRuleSet(oneRule({ property: 'p', equals: 'Infinity' }));
		expect(bare.rules[0]!.then).toEqual({
			property: 'p',
			test: { op: 'equals', value: new PyFloat(Infinity) }
		});
		expect(text.rules[0]!.then).toEqual({
			property: 'p',
			test: { op: 'equals', value: 'Infinity' }
		});
	});

	it('refuses what the grammar does not allow, with RulesUnreadable', () => {
		const rel = { type: 'R', direction: 'outgoing' };
		const cases: [string, string][] = [
			['an unknown key', oneRule({ property: 'p', exists: true }, { colour: 'red' })],
			['an unknown key in a condition', oneRule({ property: 'p', exists: true, x: 1 })],
			['an unknown top-level key', '{"rules":[],"extra":1}'],
			['two tests', oneRule({ property: 'p', exists: true, equals: 1 })],
			['no test', oneRule({ property: 'p' })],
			['gt: null', oneRule({ property: 'p', gt: null })],
			['exists: null on a property', oneRule({ property: 'p', exists: null })],
			['in: null', oneRule({ property: 'p', in: null })],
			['a list operand', oneRule({ property: 'p', equals: [1] })],
			['an int bound', oneRule({ property: 'p', gt: 1 })],
			['count: {}', oneRule({ relationship: { ...rel, count: {} } })],
			['a negative count', oneRule({ relationship: { ...rel, count: { eq: -1 } } })],
			['a float count', oneRule({ relationship: { ...rel, count: { eq: 1.5 } } })],
			['exists and count', oneRule({ relationship: { ...rel, exists: true, count: { eq: 1 } } })],
			['neither exists nor count', oneRule({ relationship: { ...rel, exists: null } })],
			['a bad direction', oneRule({ relationship: { ...rel, direction: 'up', exists: true } })],
			['an empty all', oneRule({ all: [] })],
			['an empty any', oneRule({ any: [] })],
			['two combinators', oneRule({ all: [{ property: 'p', exists: true }], any: [] })],
			['a condition that is a list', oneRule([])],
			['an empty condition', oneRule({})],
			['the alias of `in`', oneRule({ property: 'p', in_: [1] })],
			['then: null', oneRule(null)],
			['description: null', oneRule({ property: 'p', exists: true }, { description: null })],
			['an unknown severity', oneRule({ property: 'p', exists: true }, { severity: 'info' })],
			['an empty name', oneRule({ property: 'p', exists: true }, { name: '' })],
			['schema_version 2', '{"schema_version":2}'],
			[
				'duplicate names',
				JSON.stringify({
					rules: [
						{ name: 'a', applies_to: 'T', then: { property: 'p', exists: true } },
						{ name: 'a', applies_to: 'T', then: { property: 'p', exists: true } }
					]
				})
			],
			['a non-object', '[]'],
			['a string', '"rules"'],
			['not JSON', '{"rules":'],
			['rules: null', '{"rules":null}']
		];
		for (const [label, text] of cases) {
			expect(refusal(text), label).toBeInstanceOf(RulesUnreadable);
		}
	});

	it('refuses 201 rules, and a condition nested past eight levels', () => {
		const rule = (i: number) => ({
			name: `r${i}`,
			applies_to: 'T',
			then: { property: 'p', exists: true }
		});
		const many = (n: number) =>
			JSON.stringify({ rules: Array.from({ length: n }, (_, i) => rule(i)) });
		expect(readRuleSet(many(200)).rules).toHaveLength(200);
		expect(refusal(many(201))).toBeInstanceOf(RulesUnreadable);

		const nest = (levels: number): unknown =>
			levels === 1 ? { property: 'p', exists: true } : { not: nest(levels - 1) };
		expect(() => readRuleSet(oneRule(nest(8)))).not.toThrow();
		expect(refusal(oneRule(nest(9)))).toBeInstanceOf(RulesUnreadable);
		// a `where` counts one level
		const where = (levels: number): unknown =>
			levels === 1
				? { property: 'p', exists: true }
				: {
						relationship: {
							type: 'R',
							direction: 'outgoing',
							where: where(levels - 1),
							exists: true
						}
					};
		expect(() => readRuleSet(oneRule(where(8)))).not.toThrow();
		expect(refusal(oneRule(where(9)))).toBeInstanceOf(RulesUnreadable);
		const deep = 100_000;
		const deepText =
			'{"rules":[{"name":"r","applies_to":"T","then":' +
			'{"not":'.repeat(deep) +
			'{"property":"p","exists":true}' +
			'}'.repeat(deep) +
			'}]}';
		expect(refusal(deepText)).toBeInstanceOf(RulesUnreadable);
	});

	it('accepts what pydantic accepts', () => {
		const rel = { type: 'R', direction: 'outgoing' };
		const cases: [string, string][] = [
			[
				'exists: null beside a count',
				oneRule({ relationship: { ...rel, exists: null, count: { gte: 1 } } })
			],
			[
				'a null bound beside another',
				oneRule({ relationship: { ...rel, count: { eq: null, gte: 1 } } })
			],
			['to: null', oneRule({ relationship: { ...rel, to: null, exists: true } })],
			['where: null', oneRule({ relationship: { ...rel, where: null, exists: true } })],
			['when: null', oneRule({ property: 'p', exists: true }, { when: null })],
			['message: null', oneRule({ property: 'p', exists: true }, { message: null })],
			['in: []', oneRule({ property: 'p', in: [] })],
			['equals: null', oneRule({ property: 'p', equals: null })],
			['not_equals: null', oneRule({ property: 'p', not_equals: null })],
			[
				'count: null beside exists',
				oneRule({ relationship: { ...rel, count: null, exists: false } })
			]
		];
		for (const [label, text] of cases) {
			expect(() => readRuleSet(text), label).not.toThrow();
		}
		const { rules } = readRuleSet(
			oneRule(
				{ relationship: { ...rel, exists: null, count: { eq: null, gte: 1 } } },
				{
					when: null,
					message: null
				}
			)
		);
		expect(rules[0]).toMatchObject({
			when: null,
			message: null,
			then: { exists: null, count: { eq: null, gte: 1, lte: null }, to: null, where: null }
		});
	});
});

describe('pyRuleEq', () => {
	it('is Python == with bool kept apart from numbers', () => {
		const table: [Value, Parameters<typeof pyRuleEq>[1], boolean][] = [
			[true, 1, false],
			[1, true, false],
			[true, true, true],
			[false, false, true],
			[1, new PyFloat(1), true],
			[new PyFloat(1), 1, true],
			[new PyFloat(-0), 0, true],
			[2n ** 60n, new PyFloat(2 ** 60), true],
			[2n ** 60n, 2n ** 60n + 1n, false],
			[2n ** 60n + 1n, new PyFloat(2 ** 60), false],
			[2n ** 53n + 1n, new PyFloat(2 ** 53), false],
			[2n ** 53n, new PyFloat(2 ** 53), true],
			[new PyFloat(NaN), new PyFloat(NaN), false],
			[new PyFloat(Infinity), new PyFloat(Infinity), true],
			[[1], 1, false],
			[{ a: 1 }, 1, false],
			['1', 1, false],
			[1, '1', false],
			['x', 'x', true],
			[1, null, false],
			['', null, false],
			[false, null, false],
			// a list item may be None: `None == None`
			[null, null, true],
			[null, 1, false]
		];
		for (const [value, operand, expected] of table) {
			expect(pyRuleEq(value, operand), `${String(value)} == ${String(operand)}`).toBe(expected);
		}
	});
});
