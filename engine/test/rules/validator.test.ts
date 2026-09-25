import { describe, expect, it } from 'vitest';
import {
	appliesPopulation,
	compileRuleSets,
	FacetPatterns,
	Metamodel,
	Model,
	validateScoped,
	Validators,
	type CompiledRules,
	type Condition
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import type { StepsFixture } from '../golden/model-steps.ts';

const mm = Metamodel.fromJSON(
	loadFixture<{ runs: StepsFixture[] }>('rules_compile').runs[0]!.metamodel
);

const compiled = (...rules: { name: string; applies_to: string }[]): CompiledRules =>
	compileRuleSets(
		[
			{
				artifactId: 'a',
				name: 'Set',
				parse: {
					ok: true,
					document: JSON.stringify({
						rules: rules.map((rule) => ({ ...rule, then: { property: 'name', exists: true } }))
					})
				}
			}
		],
		mm
	);

describe('appliesPopulation', () => {
	it('lists each applies type, sorted, with its own elements sorted by code point', () => {
		const model = new Model(mm);
		for (const [type, id] of [
			['Twig', 'z'],
			['Leaf', 'b'],
			['Leaf', '\u{1F600}'],
			['Leaf', '￿'],
			['Other', 'o'],
			['Twig', 'a']
		] as const) {
			model.createElement(type, id);
		}
		const onTwig = compiled({ name: 'twig', applies_to: 'Twig' });
		const onLeaf = compiled({ name: 'leaf', applies_to: 'Leaf' });
		expect(appliesPopulation(model, onTwig)).toEqual(['a', 'z']);
		expect(appliesPopulation(model, onTwig, onLeaf)).toEqual(['b', '￿', '\u{1F600}', 'a', 'z']);
		expect(appliesPopulation(model, compiled({ name: 'mid', applies_to: 'Mid' }))).toEqual([
			'b',
			'￿',
			'\u{1F600}',
			'a',
			'z'
		]);
		expect(appliesPopulation(model)).toEqual([]);
	});
});

describe('RulesValidator', () => {
	it('counts a rule that throws under its check, merged once per run, and goes on', () => {
		const model = new Model(mm);
		model.createElement('Leaf', 'l1');
		model.createElement('Leaf', 'l2');
		const rules = compiled(
			{ name: 'broken', applies_to: 'Leaf' },
			{ name: 'fine', applies_to: 'Leaf' }
		);
		// A condition no document can hold: evaluating it throws.
		(rules.rules[0]!.rule as { then: Condition }).then = { all: null } as unknown as Condition;
		const v = new Validators(mm);
		const p = new FacetPatterns(mm);
		const issues = validateScoped(model, ['l1', 'l2'], v, p, rules);
		const ruled = issues.filter((i) => i.check.startsWith('rule:'));
		expect(ruled.map((i) => [i.targetIds[0], i.check])).toEqual([
			['l1', 'rule:fine'],
			['l2', 'rule:fine']
		]);
		expect(Object.fromEntries(rules.evalErrors)).toEqual({ 'rule:broken': 2 });
		validateScoped(model, ['l1'], v, p, rules);
		expect(Object.fromEntries(rules.evalErrors)).toEqual({ 'rule:broken': 3 });
		expect(validateScoped(model, ['l1'], v, p).some((i) => i.check.startsWith('rule:'))).toBe(
			false
		);
	});
});
