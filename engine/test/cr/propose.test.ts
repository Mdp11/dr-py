import { describe, expect, it } from 'vitest';
import {
	combinedDiffSteps,
	drain,
	elementLine,
	Model,
	modelDigest,
	modelLines,
	opsForChange,
	proposeSteps,
	PyFloat,
	readCrs,
	readCrsText,
	ReadError,
	relationshipLine,
	type CrElement,
	type CrRelationship,
	type Diff,
	type ModelOp,
	type ProposeAnswer,
	type WorkingCopy
} from '../../src/index.ts';
import { family } from '../model/fixtures.ts';
import { clone, workingCopy } from '../working/helpers.ts';

const CREATED_AT = '2026-09-29T10:00:00.000Z';

type Json = { [key: string]: unknown };

type CrOps = {
	eAdded?: Json[];
	eModified?: Json[];
	eDeleted?: Json[];
	rAdded?: Json[];
	rModified?: Json[];
	rDeleted?: Json[];
};

/** A change request document, as a client sends it. */
const cr = (ops: CrOps = {}): Json => ({
	format: 'datarover.cr/v1',
	createdAt: CREATED_AT,
	baseline: { filename: null, elementCount: 0, relationshipCount: 0 },
	ops: {
		elements: {
			added: ops.eAdded ?? [],
			modified: ops.eModified ?? [],
			deleted: ops.eDeleted ?? []
		},
		relationships: {
			added: ops.rAdded ?? [],
			modified: ops.rModified ?? [],
			deleted: ops.rDeleted ?? []
		}
	}
});

/** An element of `model` as a change request lists it, `props` laid over its properties. */
function el(model: Model, id: string, props: Json = {}): Json {
	const rec = model.getElement(id);
	return { id, type_name: rec.typeName, properties: { ...rec.props, ...props }, rev: rec.rev };
}

function rel(model: Model, id: string, over: Json = {}): Json {
	const rec = model.getRelationship(id);
	return {
		id,
		type_name: rec.typeName,
		source_id: rec.source.id,
		target_id: rec.target.id,
		properties: { ...rec.props },
		rev: rec.rev,
		...over
	};
}

const node = (id: string, props: Json = {}, rev: unknown = 0): Json => ({
	id,
	type_name: 'Node',
	properties: props,
	rev
});

const mod = (before: Json, after: Json): Json => ({ id: before['id'], before, after });

const propose = (wc: WorkingCopy, crs: unknown): ProposeAnswer =>
	drain(proposeSteps(wc, { crs: readCrs(crs), created_at: CREATED_AT }));

function refusal(run: () => unknown): { status: number; detail: string } {
	try {
		run();
	} catch (caught) {
		if (caught instanceof ReadError) return { status: caught.status, detail: caught.detail };
		throw caught;
	}
	throw new Error('expected a refusal');
}

const UNREADABLE = { status: 501, detail: 'reaches an unreadable change request' };

/** The staged changes as text: the committed images and the working lines. */
function stagedText(wc: WorkingCopy): string {
	const { elements, relationships } = wc.stagedDiff();
	return JSON.stringify([
		elements.map(({ id, before, after }) => [id, before, after && elementLine(after)]),
		relationships.map(({ id, before, after }) => [id, before, after && relationshipLine(after)])
	]);
}

describe('readCrs', () => {
	it('leaves every request pydantic would read otherwise to the server', () => {
		const added = (entity: Json) => [cr({ eAdded: [entity] })];
		const cases: { [name: string]: unknown } = {
			'no CRs': [],
			'21 CRs': Array.from({ length: 21 }, () => cr()),
			'wrong format': [{ ...cr(), format: 'datarover.cr/v2' }],
			'rev as text': added(node('n1', {}, '3')),
			'null properties': added({ ...node('n1'), properties: null }),
			'a float rev': added(node('n1', {}, 1.5)),
			'a bool rev': added(node('n1', {}, true)),
			'properties a list': added({ ...node('n1'), properties: [] }),
			'no type_name': added({ id: 'n1' }),
			'a numeric id': added({ ...node('n1'), id: 1 }),
			'a relationship without a target': [
				cr({ rAdded: [{ id: 'r', type_name: 'Refers', source_id: 'a', properties: {} }] })
			],
			'a modified entry without after': [cr({ eModified: [{ id: 'a', before: node('a') }] })],
			'no createdAt': [{ format: 'datarover.cr/v1' }],
			'null ops': [{ format: 'datarover.cr/v1', createdAt: CREATED_AT, ops: null }],
			'null baseline': [{ format: 'datarover.cr/v1', createdAt: CREATED_AT, baseline: null }],
			'a list of added as an object': [
				{ format: 'datarover.cr/v1', createdAt: CREATED_AT, ops: { elements: { added: {} } } }
			],
			'not a list': { crs: [] },
			'a CR that is a list': [[]],
			'a bigint JSON cannot carry': added(node('n1', { n: 1n })),
			nothing: undefined
		};
		for (const [name, raw] of Object.entries(cases)) {
			expect(
				refusal(() => readCrs(raw)),
				name
			).toEqual(UNREADABLE);
		}
	});

	it('takes a change request without baseline or ops, and defaults what pydantic defaults', () => {
		const empty = { added: [], modified: [], deleted: [] };
		expect(readCrs([{ format: 'datarover.cr/v1', createdAt: '' }])).toEqual([
			{ elements: empty, relationships: empty }
		]);
		const [read] = readCrs([
			{
				format: 'datarover.cr/v1',
				createdAt: CREATED_AT,
				extra: 1,
				ops: { elements: { added: [{ id: 'n1', type_name: 'Node', extra: 2 }] } }
			}
		]);
		expect(read!.elements.added).toEqual([{ id: 'n1', type_name: 'Node', properties: {}, rev: 0 }]);
		expect(read!.relationships).toEqual(empty);
		// A float stays a float, an integer past 2^53 an integer: `JSON.stringify` writes 2^60 so.
		const [exact] = readCrs(added([{ ...node('n1', { f: 1.5 }), rev: 2 ** 60 }]));
		expect(exact!.elements.added[0]!.properties['f']).toEqual(new PyFloat(1.5));
		expect(exact!.elements.added[0]!.rev).toBe(1152921504606847000n);
		// Text keeps what a parsed body cannot.
		const [text] = readCrsText(
			'[{"format": "datarover.cr/v1", "createdAt": "", "ops": {"elements": {"added": ' +
				'[{"id": "n1", "type_name": "Node", "properties": {"f": 1.0}, "rev": 9007199254740993}]}}}]'
		);
		expect(text!.elements.added[0]!.properties['f']).toEqual(new PyFloat(1));
		expect(text!.elements.added[0]!.rev).toBe(2n ** 53n + 1n);

		function added(entities: Json[]) {
			return [cr({ eAdded: entities })];
		}
	});
});

describe('Phase A', () => {
	it('collects every conflict of the first CR that has one, in bucket order, against the CRs before it', () => {
		const model = family();
		const wc = workingCopy(clone(model), 4);
		const answer = propose(wc, [
			// `rev` is ignored: this `before` matches.
			cr({ eModified: [mod({ ...el(model, 'c'), rev: 99 }, el(model, 'c', { name: 'C0' }))] }),
			cr({
				eAdded: [node('a'), node('n1')],
				eModified: [
					mod(node('zz'), node('zz')),
					mod(el(model, 'b', { name: 'wrong' }), el(model, 'b')),
					// Matches the model, not the state the first CR left.
					mod(el(model, 'c'), el(model, 'c', { name: 'C1' }))
				],
				eDeleted: [node('yy'), el(model, 'd', { name: 'D?' })],
				rAdded: [rel(model, 'a-b')],
				rModified: [
					mod(rel(model, 'a-c', { id: 'q' }), rel(model, 'a-c', { id: 'q' })),
					mod(rel(model, 'a-c', { target_id: 'b' }), rel(model, 'a-c'))
				],
				rDeleted: [rel(model, 'a-c', { id: 'p' }), rel(model, 'b-d', { properties: { x: 1 } })]
			})
		]);
		const conflict = (kind: string, entity: string, id: string, reason: string) => ({
			kind,
			entity,
			id,
			reason
		});
		expect(JSON.stringify(answer)).toBe(
			JSON.stringify({
				conflict: {
					cr_index: 1,
					conflicts: [
						conflict('id_exists', 'element', 'a', "Element 'a' already exists in the model"),
						conflict('missing', 'element', 'zz', "Element 'zz' does not exist in the model"),
						conflict(
							'before_mismatch',
							'element',
							'b',
							"Element 'b' does not match the before snapshot"
						),
						conflict(
							'before_mismatch',
							'element',
							'c',
							"Element 'c' does not match the before snapshot"
						),
						conflict('missing', 'element', 'yy', "Element 'yy' does not exist in the model"),
						conflict(
							'before_mismatch',
							'element',
							'd',
							"Element 'd' does not match the deleted snapshot"
						),
						conflict(
							'id_exists',
							'relationship',
							'a-b',
							"Relationship 'a-b' already exists in the model"
						),
						conflict(
							'missing',
							'relationship',
							'q',
							"Relationship 'q' does not exist in the model"
						),
						conflict(
							'before_mismatch',
							'relationship',
							'a-c',
							"Relationship 'a-c' does not match the before snapshot"
						),
						conflict(
							'missing',
							'relationship',
							'p',
							"Relationship 'p' does not exist in the model"
						),
						conflict(
							'before_mismatch',
							'relationship',
							'b-d',
							"Relationship 'b-d' does not match the deleted snapshot"
						)
					],
					model_rev: 4
				}
			})
		);
	});

	it('compares as Python does: 1.0 and true match 1, key order does not count', () => {
		const model = family();
		model.setProperty(model.getElement('a'), 'constructor', 1);
		const wc = workingCopy(clone(model));
		const before = { ...el(model, 'a'), properties: { constructor: true, name: 'A' } };
		const answer = propose(wc, [cr({ eModified: [mod(before, el(model, 'a', { name: 'A2' }))] })]);
		expect('conflict' in answer).toBe(false);
	});
});

describe('Phase B', () => {
	const combined = (wc: WorkingCopy, crs: unknown): Diff => {
		const out = drain(combinedDiffSteps(wc, readCrs(crs)));
		if ('conflict' in out) throw new Error(JSON.stringify(out.conflict));
		return out.diff;
	};

	it('gives a modified entity its current rev plus one, once per modify', () => {
		const model = family();
		const wc = workingCopy(clone(model));
		const a = model.getElement('a').rev;
		const b = model.getElement('b').rev;
		const diff = combined(wc, [
			cr({
				eModified: [
					mod(el(model, 'a'), el(model, 'a', { name: 'A1' })),
					mod(el(model, 'a'), el(model, 'a', { name: 'A2' })),
					mod(el(model, 'b'), el(model, 'b', { name: 'B1' }))
				]
			}),
			cr({ eModified: [mod(el(model, 'b', { name: 'B1' }), el(model, 'b', { name: 'B2' }))] })
		]);
		expect(
			diff.elements.modified.map((m) => [m.id, m.after.properties['name'], m.after.rev])
		).toEqual([
			['a', 'A2', a + 2],
			['b', 'B2', b + 2]
		]);
	});

	it('adds one to a bigint rev as a bigint, and to the last safe integer exactly', () => {
		const model = family();
		const wc = workingCopy(clone(model));
		const diff = combined(wc, [
			cr({ eAdded: [node('n1', {}, 2 ** 60), node('n2', {}, Number.MAX_SAFE_INTEGER)] }),
			cr({
				eModified: [
					mod(node('n1'), node('n1', { name: 'N1' })),
					mod(node('n2'), node('n2', { name: 'N2' }))
				]
			})
		]);
		expect(diff.elements.added.map((e) => e.rev)).toEqual([1152921504606847001n, 2n ** 53n]);
	});

	it('moves an id deleted by one CR and re-added by a later one last, and drops it when re-added as it was', () => {
		const model = family();
		const wc = workingCopy(clone(model));
		const diff = combined(wc, [
			cr({
				eDeleted: [el(model, 'a'), el(model, 'c')],
				rDeleted: [rel(model, 'a-b'), rel(model, 'a-c')]
			}),
			cr({
				eAdded: [el(model, 'c', { name: 'C again' }), el(model, 'a'), node('n1')],
				eModified: [mod(el(model, 'd'), el(model, 'd', { name: 'D2' }))],
				rAdded: [rel(model, 'a-b')]
			})
		]);
		expect(diff.elements.added.map((e) => e.id)).toEqual(['n1']);
		expect(diff.elements.modified.map((m) => m.id)).toEqual(['d', 'c']);
		expect(diff.elements.deleted).toEqual([]);
		expect(diff.relationships.added).toEqual([]);
		expect(diff.relationships.deleted.map((r) => r.id)).toEqual(['a-c']);
	});

	it('deletes an id listed twice among the deletes once, and a modify then a delete ends deleted', () => {
		const model = family();
		const wc = workingCopy(clone(model));
		const diff = combined(wc, [
			cr({
				eModified: [mod(el(model, 'c'), el(model, 'c', { name: 'C2' }))],
				eDeleted: [el(model, 'c'), el(model, 'c')],
				rDeleted: [rel(model, 'a-c'), rel(model, 'a-c')]
			})
		]);
		expect(diff.elements.modified).toEqual([]);
		expect(diff.elements.deleted.map((e) => e.id)).toEqual(['c']);
		expect(diff.relationships.deleted.map((r) => r.id)).toEqual(['a-c']);
	});
});

const element = (id: string, props: CrElement['properties'], typeName = 'Node'): CrElement => ({
	id,
	type_name: typeName,
	properties: props,
	rev: 0
});

const relationship = (
	id: string,
	source: string,
	target: string,
	props: CrRelationship['properties'] = {},
	typeName = 'Refers'
): CrRelationship => ({
	id,
	type_name: typeName,
	source_id: source,
	target_id: target,
	properties: props,
	rev: 0
});

const noOps = (): Diff => ({
	elements: { added: [], modified: [], deleted: [] },
	relationships: { added: [], modified: [], deleted: [] }
});

describe('opsForChange', () => {
	it('numbers temp ids across both kinds, ends on created elements, and pairs each rewire', () => {
		const diff = noOps();
		diff.elements.added.push(element('n1', { name: 'N1' }), element('n2', {}));
		diff.relationships.added.push(relationship('r1', 'n1', 'a'), relationship('r2', 'n2', 'n1'));
		diff.elements.modified.push({
			id: 'a',
			before: element('a', { name: 'A', x: 1 }),
			after: element('a', { name: 'A2' })
		});
		diff.relationships.modified.push(
			{
				id: 'p',
				before: relationship('p', 'a', 'b', { w: 1 }),
				after: relationship('p', 'a', 'b', { w: 2 })
			},
			{ id: 'rw1', before: relationship('rw1', 'a', 'b'), after: relationship('rw1', 'a', 'n2') },
			{
				id: 'rw2',
				before: relationship('rw2', 'a', 'b'),
				after: relationship('rw2', 'a', 'b', {}, 'Contains')
			}
		);
		diff.relationships.deleted.push(relationship('x', 'a', 'c'));
		diff.elements.deleted.push(element('c', {}));

		const ops = [
			{
				kind: 'create_element',
				temp_id: 'tmp_1',
				type_name: 'Node',
				properties: { name: 'N1' },
				id: 'n1'
			},
			{ kind: 'create_element', temp_id: 'tmp_2', type_name: 'Node', properties: {}, id: 'n2' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_3',
				type_name: 'Refers',
				source_id: 'tmp_1',
				target_id: 'a',
				properties: {},
				id: 'r1'
			},
			{
				kind: 'create_relationship',
				temp_id: 'tmp_4',
				type_name: 'Refers',
				source_id: 'tmp_2',
				target_id: 'tmp_1',
				properties: {},
				id: 'r2'
			},
			{ kind: 'update_element', id: 'a', properties_patch: { name: 'A2', x: null } },
			{ kind: 'update_relationship', id: 'p', properties_patch: { w: 2 } },
			{ kind: 'delete_relationship', id: 'x' },
			{ kind: 'delete_relationship', id: 'rw1' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_5',
				type_name: 'Refers',
				source_id: 'a',
				target_id: 'tmp_2',
				properties: {},
				id: 'rw1'
			},
			{ kind: 'delete_relationship', id: 'rw2' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_6',
				type_name: 'Contains',
				source_id: 'a',
				target_id: 'b',
				properties: {},
				id: 'rw2'
			},
			{ kind: 'delete_element', id: 'c' }
		];
		expect(JSON.stringify(opsForChange(diff))).toBe(JSON.stringify(ops));
	});

	it('puts changed keys in after’s order, then removed keys as null, as Python compares them', () => {
		const diff = noOps();
		diff.elements.modified.push({
			id: 'a',
			before: element('a', { a: 1, b: 2, c: 3, d: 1, n: new PyFloat(NaN) }),
			after: element('a', {
				d: true,
				c: 4,
				e: new PyFloat(Infinity),
				a: new PyFloat(1),
				n: new PyFloat(NaN)
			})
		});
		const [op] = opsForChange(diff) as { properties_patch: { [key: string]: unknown } }[];
		expect(Object.entries(op!.properties_patch)).toEqual([
			['c', 4],
			['e', null],
			['n', null],
			['b', null]
		]);
	});

	it('refuses a retype before it answers any op', () => {
		const diff = noOps();
		diff.elements.added.push(element('n1', {}));
		diff.elements.modified.push(
			{ id: 'a', before: element('a', { name: 'A' }), after: element('a', { name: 'B' }) },
			{ id: 't4', before: element('t4', {}, 'Team'), after: element('t4', {}, 'Organization') }
		);
		expect(refusal(() => opsForChange(diff))).toEqual({
			status: 422,
			detail:
				"Element 't4' changes type ('Team' -> 'Organization'); element type changes are not " +
				'supported — delete and re-create it in the CR'
		});
	});
});

describe('proposeSteps', () => {
	it('answers the combined change request and its ops, in the route’s key order, over the working copy', () => {
		const model = family();
		const wc = workingCopy(clone(model), 2);
		const answer = propose(wc, [
			cr({ eModified: [mod(el(model, 'a'), el(model, 'a', { name: 'A2' }))] }),
			cr({
				eAdded: [node('n1', { name: 'N1' }, 5)],
				rAdded: [rel(model, 'a-c', { id: 'n-r', target_id: 'n1' })]
			})
		]);
		if ('conflict' in answer) throw new Error('a conflict');
		expect(Object.keys(answer)).toEqual(['model_rev', 'cr', 'ops']);
		expect(answer.model_rev).toBe(2);
		expect(answer.cr['createdAt']).toBe(CREATED_AT);
		expect(answer.cr['baseline']).toEqual({
			filename: null,
			elementCount: 4,
			relationshipCount: 3
		});
		expect(answer.ops).toEqual([
			{
				kind: 'create_element',
				temp_id: 'tmp_1',
				type_name: 'Node',
				properties: { name: 'N1' },
				id: 'n1'
			},
			{
				kind: 'create_relationship',
				temp_id: 'tmp_2',
				type_name: 'Refers',
				source_id: 'a',
				target_id: 'tmp_1',
				properties: {},
				id: 'n-r'
			},
			{ kind: 'update_element', id: 'a', properties_patch: { name: 'A2' } }
		]);
	});

	it('refuses what the gate refuses with its 422', () => {
		const model = family();
		const wc = workingCopy(clone(model));
		expect(
			refusal(() => propose(wc, [cr({ eAdded: [{ ...node('n1'), type_name: 'Nope' }] })]))
		).toEqual({
			status: 422,
			detail: "Unknown element type 'Nope'"
		});
		// `b-d` survives the delete of its source.
		expect(
			refusal(() =>
				propose(wc, [cr({ eDeleted: [el(model, 'b')], rDeleted: [rel(model, 'a-b')] })])
			)
		).toEqual({ status: 422, detail: "Relationship 'b-d' references unknown source 'b'" });
	});

	it('leaves the working copy as it was, and answers nothing of its own', () => {
		const model = family();
		const wc = workingCopy(clone(model), 1);
		const staged: ModelOp[] = [
			{ kind: 'update_element', id: 'a', properties_patch: { name: 'A staged' } },
			{ kind: 'create_element', temp_id: 'tmp_x', type_name: 'Node', properties: { name: 'X' } }
		];
		wc.stage(staged);
		const was = {
			digest: modelDigest(wc.model),
			lines: modelLines(wc.model),
			staged: stagedText(wc)
		};
		const working = wc.model;
		const answer = propose(wc, [
			cr({
				eAdded: [node('n1', { name: 'N1' })],
				eModified: [mod(el(working, 'a'), el(working, 'a', { name: 'A2' }))],
				eDeleted: [el(working, 'd')],
				rModified: [mod(rel(working, 'a-c'), rel(working, 'a-c', { target_id: 'n1' }))],
				rDeleted: [rel(working, 'b-d')]
			})
		]);
		if ('conflict' in answer) throw new Error('a conflict');
		const ops = answer.cr['ops'] as { elements: { modified: { before: { properties: Json } }[] } };
		ops.elements.modified[0]!.before.properties['name'] = 'changed by the caller';
		expect(modelDigest(wc.model)).toBe(was.digest);
		expect(modelLines(wc.model)).toEqual(was.lines);
		expect(stagedText(wc)).toBe(was.staged);
	});
});
