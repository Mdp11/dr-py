// chainStepOptions: the option list behind every "which step of this
// navigation" field. Ground truth for the numbering is chainColumns (the same
// helper the editor rail, the results headers and the `→ feeds` popover badge
// with), so these expectations double as the contract that a table editor's
// "step 2" is the step badged 2 in the navigation editor.
import { expect, test } from 'vitest';
import { chainStepOptions } from '$lib/table/chain-steps';
import type { NavigationDefinition } from '$lib/api/types';

const hop = (relationship_type: string, target_types: string[] = []) => ({
	kind: 'relationship',
	relationship_type,
	direction: 'out',
	target_types,
	children: []
});

test('numbers the start 0 and each chain-advancing hop after it; filter steps get none', () => {
	const path = {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types: ['Site'], criteria: [] },
		steps: [
			hop('Contains', ['Building']),
			{ kind: 'filter', criteria: [] },
			hop('Owns'),
			{ kind: 'property', property_name: 'name' },
			{ kind: 'script', snippet: {}, comment: '' }
		],
		exclude_visited: true
	} as unknown as NavigationDefinition;
	expect(chainStepOptions(path)).toEqual([
		{ index: 0, label: '0: Start (Site)' },
		{ index: 1, label: '1: Contains (Building)' },
		{ index: 2, label: '2: Owns' },
		{ index: 3, label: '3: name (property)' },
		// label and sub would both read "script" — say it once.
		{ index: 4, label: '4: script' }
	]);
});

test('a set_op definition offers only step 0 (its chains are single-element)', () => {
	expect(
		chainStepOptions({
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: []
		} as unknown as NavigationDefinition)
	).toEqual([{ index: 0, label: '0: Combined elements' }]);
});

test('an unknown definition yields null so the field can degrade to a numeric input', () => {
	expect(chainStepOptions(null)).toBeNull();
	expect(chainStepOptions(undefined)).toBeNull();
});
