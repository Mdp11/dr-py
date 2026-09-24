import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	drain,
	evaluateNavigation,
	evaluateNavigationCore,
	evaluateSteps,
	Model,
	PropertyValue,
	PyFloat,
	ReadError,
	readNavigation,
	ViewPlacements,
	type CommittedArtifact,
	type EvalContext,
	type NavigationDefinition,
	type Progress
} from '../../src/index.ts';
import { seededRandom } from '../golden/model-steps.ts';
import { thrown } from '../golden/thrown.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';

const refusal = (run: () => unknown) => {
	const error = thrown(run);
	if (!(error instanceof ReadError)) throw new Error(`expected a refusal, got ${String(error)}`);
	return { status: error.status, detail: error.detail };
};

const scope = { kind: 'scope' };
const hop = (type: string, direction = 'out') => ({
	kind: 'relationship',
	relationship_type: type,
	direction
});

describe('readNavigation', () => {
	it('fills the defaults and ignores unknown keys', () => {
		expect(
			readNavigation(
				{
					kind: 'path',
					schema_version: 3,
					name: 'n',
					unknown: true,
					start: { kind: 'scope' },
					steps: [
						{ kind: 'relationship', relationship_type: 'Refers', comment: 'why' },
						{ kind: 'filter' },
						{ kind: 'property', property_name: 'peer' },
						{ kind: 'script' },
						{ kind: 'script', snippet: { ref: 's' }, comment: 'label' }
					]
				},
				'definition'
			)
		).toEqual({
			kind: 'path',
			start: { kind: 'scope', types: [], criteria: [] },
			steps: [
				{ kind: 'relationship', relationship_type: 'Refers', direction: 'out', target_types: [] },
				{ kind: 'filter', criteria: [] },
				{ kind: 'property', property_name: 'peer' },
				{ kind: 'script', snippet: { ref: null, definition: null }, comment: null },
				{ kind: 'script', snippet: { ref: 's', definition: null }, comment: 'label' }
			],
			exclude_visited: true
		});
		expect(
			readNavigation(
				{
					kind: 'set_op',
					op: 'difference',
					operands: [
						{ ref: 'n1' },
						{ definition: { kind: 'path', start: { kind: 'row' } }, step_index: 0 }
					]
				},
				'definition'
			)
		).toEqual({
			kind: 'set_op',
			op: 'difference',
			operands: [
				{ ref: 'n1', definition: null, step_index: null },
				{
					ref: null,
					definition: { kind: 'path', start: { kind: 'row' }, steps: [], exclude_visited: true },
					step_index: 0
				}
			]
		});
	});

	it('reads criteria as a search reads them', () => {
		const read = readNavigation(
			{
				kind: 'path',
				start: { kind: 'scope', types: ['Node'], criteria: [{ type: 'orphan' }] },
				steps: [
					{
						kind: 'filter',
						criteria: [
							{
								type: 'relation_count',
								op: 'exactly',
								count: 1,
								direction: 'either',
								relTypes: ['Refers']
							}
						]
					}
				]
			},
			'definition'
		);
		expect(read).toEqual({
			kind: 'path',
			start: { kind: 'scope', types: ['Node'], criteria: [{ type: 'orphan' }] },
			steps: [
				{
					kind: 'filter',
					criteria: [
						{
							type: 'relation_count',
							op: 'exactly',
							count: 1,
							direction: 'either',
							rel_types: ['Refers']
						}
					]
				}
			],
			exclude_visited: true
		});
	});

	it("refuses what the schema refuses, in the core's words where it has them", () => {
		const path = (extra: object) => ({ kind: 'path', start: scope, ...extra });
		const cases: [unknown, string][] = [
			[
				path({ steps: [{ ...hop('Refers'), children: [{ kind: 'filter' }] }] }),
				'definition.steps[0].children: branching steps (`children`) are not supported in schema v2'
			],
			[
				path({ steps: Array.from({ length: 11 }, () => ({ kind: 'filter' })) }),
				'definition.steps: a navigation may have at most 10 steps'
			],
			[
				{ kind: 'set_op', op: 'union', operands: [{}] },
				'definition.operands[0]: an operand needs exactly one of `ref` / `definition`'
			],
			[
				{ kind: 'set_op', op: 'union', operands: [{ ref: 'a', definition: path({}) }] },
				'definition.operands[0]: an operand needs exactly one of `ref` / `definition`'
			],
			[
				path({ steps: [{ kind: 'script', snippet: { ref: 's', definition: { code: '' } } }] }),
				'definition.steps[0].snippet: provide at most one of `ref` / `definition`'
			],
			[
				{ kind: 'set_op', op: 'union', operands: [{ ref: 'a', step_index: -1 }] },
				'definition.operands[0].step_index: must be an integer of at least 0 or null'
			],
			[
				{ kind: 'set_op', op: 'union', operands: [{ ref: 'a', step_index: 1.5 }] },
				'definition.operands[0].step_index: must be an integer of at least 0 or null'
			],
			[
				{ kind: 'set_op', op: 'union', operands: [] },
				'definition.operands: must hold at least one operand'
			],
			[
				{ kind: 'set_op', op: 'xor', operands: [{ ref: 'a' }] },
				'definition.op: must be one of union, intersection, difference, symmetric_difference'
			],
			[path({ exclude_visited: 1 }), 'definition.exclude_visited: must be a boolean'],
			[
				path({ steps: [{ ...hop('Refers'), direction: 'both' }] }),
				'definition.steps[0].direction: must be one of out, in, either'
			],
			[
				path({ steps: [{ kind: 'property' }] }),
				'definition.steps[0].property_name: must be a string'
			],
			[
				path({ start: { kind: 'scope', types: 'Node' } }),
				'definition.start.types: must be a list of strings'
			],
			[
				path({ start: { kind: 'scope', criteria: [{ type: 'x' }] } }),
				'definition.start.criteria[0].type: must be one of entity_type, property, name_id, relation_count, orphan, connected_to_type, endpoint_type, any_of'
			],
			['path', 'definition: must be an object']
		];
		for (const [raw, detail] of cases) {
			expect(refusal(() => readNavigation(raw, 'definition'))).toEqual({ status: 422, detail });
		}
	});

	it('checks schema_version, a path’s name and every step’s comment, and keeps none but a script’s', () => {
		const set = { kind: 'set_op', op: 'union', operands: [{ ref: 'a' }] };
		const steps = [
			{ ...hop('Links'), comment: 'c' },
			{ kind: 'filter', comment: null },
			{ kind: 'property', property_name: 'p', comment: 'c' },
			{ kind: 'script', comment: 'label' }
		];
		expect(
			readNavigation(
				{
					kind: 'path',
					schema_version: 3,
					name: 'n',
					start: { ...set, schema_version: 2n },
					steps
				},
				'd'
			)
		).toEqual({
			kind: 'path',
			start: {
				kind: 'set_op',
				op: 'union',
				operands: [{ ref: 'a', definition: null, step_index: null }]
			},
			steps: [
				{ kind: 'relationship', relationship_type: 'Links', direction: 'out', target_types: [] },
				{ kind: 'filter', criteria: [] },
				{ kind: 'property', property_name: 'p' },
				{ kind: 'script', snippet: { ref: null, definition: null }, comment: 'label' }
			],
			exclude_visited: true
		});
		// A set has no name: pydantic ignores one, and so does the reader.
		expect(readNavigation({ ...set, name: 5, schema_version: 1 }, 'd')).toMatchObject({
			kind: 'set_op'
		});

		const path = (extra: object) => ({ kind: 'path', start: scope, ...extra });
		const cases: [unknown, string][] = [
			[path({ name: 5 }), 'd.name: must be a string or null'],
			[path({ name: ['x'] }), 'd.name: must be a string or null'],
			[path({ name: true }), 'd.name: must be a string or null'],
			...(['x', 1.5, null, true, '3', new PyFloat(1)] as const).flatMap(
				(version): [unknown, string][] => [
					[path({ schema_version: version }), 'd.schema_version: must be an integer'],
					[{ ...set, schema_version: version }, 'd.schema_version: must be an integer'],
					[
						path({ start: { ...set, schema_version: version } }),
						'd.start.schema_version: must be an integer'
					]
				]
			),
			[
				path({ steps: [{ ...hop('Links'), comment: 5 }] }),
				'd.steps[0].comment: must be a string or null'
			],
			[
				path({ steps: [{ kind: 'filter', comment: ['x'] }] }),
				'd.steps[0].comment: must be a string or null'
			],
			[
				path({ steps: [{ kind: 'property', property_name: 'p', comment: false }] }),
				'd.steps[0].comment: must be a string or null'
			],
			[
				path({ steps: [{ kind: 'script', comment: 5 }] }),
				'd.steps[0].comment: must be a string or null'
			]
		];
		for (const [raw, detail] of cases) {
			expect(refusal(() => readNavigation(raw, 'd'))).toEqual({ status: 422, detail });
		}
	});

	it('requires the kind on every definition, start and step', () => {
		for (const [raw, where] of [
			[{ start: scope }, 'definition.kind'],
			[{ kind: 'path', start: {} }, 'definition.start.kind'],
			[{ kind: 'path' }, 'definition.start'],
			[
				{ kind: 'path', start: scope, steps: [{ relationship_type: 'Refers' }] },
				'definition.steps[0].kind'
			],
			[
				{ kind: 'set_op', op: 'union', operands: [{ definition: { start: scope } }] },
				'definition.operands[0].definition.kind'
			]
		] as const) {
			expect(refusal(() => readNavigation(raw, 'definition'))).toMatchObject({ status: 422 });
			expect(refusal(() => readNavigation(raw, 'definition')).detail.startsWith(`${where}:`)).toBe(
				true
			);
		}
	});
});

describe('PropertyValue', () => {
	it('keys on type and value: true, 1 and 1.0 stay apart', () => {
		const keys = [true, 1, new PyFloat(1), '1', 1n].map((value) => new PropertyValue(value).key);
		expect(new Set(keys).size).toBe(4);
		expect(new PropertyValue(1).key).toBe(new PropertyValue(1n).key);
		expect(new PropertyValue(new PyFloat(0)).key).toBe(new PropertyValue(new PyFloat(-0)).key);
		expect(new PropertyValue(false).key).not.toBe(new PropertyValue(0).key);
	});
});

/** 3,000 nodes, each referring to a few others and naming a peer, seeded. */
function seeded(): Model {
	const model = new Model(nodeMetamodel());
	const random = seededRandom(20260924);
	const count = 3_000;
	const pick = () => `n${Math.floor(random() * count)}`;
	for (let i = 0; i < count; i++) {
		const element = model.createElement('Node', `n${i}`);
		model.setProperty(element, 'name', `node ${i}`);
		if (i % 3 === 0) model.setProperty(element, 'peer', pick());
	}
	for (let i = 0; i < count * 3; i++) model.connect('Refers', pick(), pick(), `r${i}`);
	return model;
}

describe('evaluateSteps', () => {
	const model = seeded();
	const definitions: [string, NavigationDefinition][] = [
		[
			'an untyped scope, one hop',
			readNavigation({ kind: 'path', start: scope, steps: [hop('Refers', 'either')] }, 'd')
		],
		[
			'a typed scope with criteria, two hops, a filter and a property',
			readNavigation(
				{
					kind: 'path',
					start: {
						kind: 'scope',
						types: ['Node'],
						criteria: [{ type: 'name_id', field: 'name', op: 'contains', value: '1' }]
					},
					steps: [
						hop('Refers'),
						{
							kind: 'filter',
							criteria: [{ type: 'relation_count', op: 'at_least', count: 2, direction: 'either' }]
						},
						{ kind: 'property', property_name: 'peer' },
						hop('Refers', 'in')
					]
				},
				'd'
			)
		],
		[
			'sets of paths, and a set as a start',
			readNavigation(
				{
					kind: 'path',
					start: {
						kind: 'set_op',
						op: 'symmetric_difference',
						operands: [
							{ definition: { kind: 'path', start: scope, steps: [hop('Refers')] }, step_index: 1 },
							{
								definition: {
									kind: 'set_op',
									op: 'union',
									operands: [{ definition: { kind: 'path', start: scope } }]
								}
							}
						]
					},
					steps: [hop('Refers', 'either')]
				},
				'd'
			)
		]
	];

	for (const [name, defn] of definitions) {
		it(`yields at most 1,024 units apart and drains to the one-shot result: ${name}`, () => {
			const limits = { maxVisited: 100_000, maxChains: 5_000 };
			const steps = evaluateSteps(model.metamodel, model, defn, limits, null);
			const seen: Progress[] = [];
			let next = steps.next();
			while (next.done !== true) {
				seen.push(next.value);
				next = steps.next();
			}
			expect(seen.length).toBeGreaterThan(10);
			let before = 0;
			for (const { done, total } of seen) {
				expect(done - before).toBeGreaterThan(0);
				expect(done - before).toBeLessThanOrEqual(1024);
				expect(total).toBe(100_000);
				before = done;
			}
			const once = evaluateNavigationCore(model.metamodel, model, defn, limits, null);
			expect(next.value).toEqual(once);
			expect(drain(evaluateSteps(model.metamodel, model, defn, limits, null))).toEqual(once);
		});
	}

	it('counts every element a hop expands, one with no edges too', () => {
		const isolated = new Model(nodeMetamodel());
		for (let i = 0; i < 5_000; i++) isolated.createElement('Node', `n${i}`);
		const defn = readNavigation({ kind: 'path', start: scope, steps: [hop('Refers')] }, 'd');
		const seen: Progress[] = [];
		const steps = evaluateSteps(isolated.metamodel, isolated, defn);
		for (let next = steps.next(); next.done !== true; next = steps.next()) seen.push(next.value);
		// Gathering the 5,000 ids and sorting them in four passes take 25,000 units.
		expect(seen.filter(({ done }) => done > 25_000).length).toBeGreaterThanOrEqual(4);
	});
});

function context(model: Model = family(), artifacts = new ArtifactSet()): EvalContext {
	return { model, artifacts, placements: new ViewPlacements() };
}

const committed = (id: string, kind: string, payload: object) => ({
	id,
	kind,
	name: id,
	rev: 1,
	payload: payload as CommittedArtifact['payload']
});

describe('evaluateNavigation', () => {
	const scripted = {
		kind: 'path',
		start: scope,
		steps: [{ kind: 'script', snippet: { definition: { code: 'def step(el):\n    return el\n' } } }]
	};

	it('answers 501 for a script step, before any step', () => {
		expect(refusal(() => evaluateNavigation(context(), { definition: scripted }))).toEqual({
			status: 501,
			detail: 'reaches a script'
		});
		const byRef = {
			kind: 'path',
			start: scope,
			steps: [{ kind: 'script', snippet: { ref: 'gone' } }]
		};
		expect(refusal(() => evaluateNavigation(context(), { definition: byRef }))).toEqual({
			status: 501,
			detail: 'reaches a script'
		});
	});

	it('answers 501 for a script step reached only through a saved navigation', () => {
		const artifacts = new ArtifactSet();
		artifacts.setCommitted([committed('n1', 'navigation', scripted)]);
		const through = { kind: 'set_op', op: 'union', operands: [{ ref: 'n1', step_index: 0 }] };
		expect(
			refusal(() => evaluateNavigation(context(family(), artifacts), { definition: through }))
		).toEqual({
			status: 501,
			detail: 'reaches a script'
		});
		expect(
			refusal(() => evaluateNavigation(context(family(), artifacts), { artifact_id: 'n1' }))
		).toEqual({
			status: 501,
			detail: 'reaches a script'
		});
	});

	it('answers 501 for an unsupported pattern anywhere in the resolved definition, before any step', () => {
		const artifacts = new ArtifactSet();
		const filtered = {
			kind: 'path',
			start: scope,
			steps: [
				{
					kind: 'filter',
					criteria: [
						{
							type: 'any_of',
							criteria: [{ type: 'name_id', field: 'name', op: 'matches', value: '(?x)a' }]
						}
					]
				}
			]
		};
		artifacts.setCommitted([committed('n1', 'navigation', filtered)]);
		const through = {
			kind: 'path',
			start: { kind: 'set_op', op: 'union', operands: [{ ref: 'n1' }] }
		};
		expect(
			refusal(() => evaluateNavigation(context(family(), artifacts), { definition: through }))
		).toEqual({
			status: 501,
			detail: 'reaches an unsupported pattern'
		});
	});

	it('answers 422 before any step for bad params', () => {
		const definition = { kind: 'path', start: scope };
		for (const [params, detail] of [
			[{ definition, limit: 0 }, 'limit must be an integer from 1 to 500'],
			[{ definition, limit: 501 }, 'limit must be an integer from 1 to 500'],
			[{ definition, offset: -1 }, 'offset must be an integer of at least 0'],
			[{}, 'provide exactly one of `definition` / `artifact_id`'],
			[{ definition, artifact_id: 'n1' }, 'provide exactly one of `definition` / `artifact_id`'],
			[
				{ definition: null, artifact_id: null },
				'provide exactly one of `definition` / `artifact_id`'
			],
			[{ artifact_id: 1 }, 'artifact_id must be a string'],
			[{ definition, row_element_id: 1 }, 'row_element_id must be a string'],
			[{ definition: { kind: 'path' } }, 'definition.start: must be an object']
		] as const) {
			expect(refusal(() => evaluateNavigation(context(), params))).toEqual({ status: 422, detail });
		}
	});

	it('names an unknown saved navigation without quotes, a nested one with them', () => {
		const artifacts = new ArtifactSet();
		artifacts.setCommitted([committed('t1', 'table', {})]);
		const ctx = context(family(), artifacts);
		expect(refusal(() => evaluateNavigation(ctx, { artifact_id: 'n1' }))).toEqual({
			status: 422,
			detail: 'unknown navigation artifact n1'
		});
		expect(refusal(() => evaluateNavigation(ctx, { artifact_id: 't1' }))).toEqual({
			status: 422,
			detail: 'unknown navigation artifact t1'
		});
		const nested = { kind: 'set_op', op: 'union', operands: [{ ref: 't1' }] };
		expect(refusal(() => evaluateNavigation(ctx, { definition: nested }))).toEqual({
			status: 422,
			detail: "unknown navigation artifact 't1'"
		});
	});

	it('answers the page in the route’s field order', () => {
		const page = drain(
			evaluateNavigation(context(), {
				definition: {
					kind: 'path',
					start: { kind: 'scope', types: ['Node'] },
					steps: [hop('Contains')]
				},
				limit: 1,
				offset: 1
			})
		);
		expect(Object.keys(page)).toEqual(['step_types', 'chains', 'total', 'truncated', 'warnings']);
		expect(page).toEqual({
			step_types: ['Contains'],
			chains: [
				[
					{ id: 'b', type_name: 'Node', display_name: 'B', child_count: 1 },
					{ id: 'd', type_name: 'Node', display_name: 'D', child_count: 0 }
				]
			],
			total: 2,
			truncated: false,
			warnings: []
		});
	});
});
