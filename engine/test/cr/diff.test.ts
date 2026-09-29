import { describe, expect, it } from 'vitest';
import {
	crDocument,
	crWire,
	diffSteps,
	drain,
	parseExact,
	PyFloat,
	pyDumps,
	readModelFile,
	type Diff,
	type ElementRec,
	type OtherModel,
	type Progress,
	type RelRec,
	type Value,
	type WorkingCopy
} from '../../src/index.ts';
import { smartCity } from '../service/helpers.ts';
import { workingCopy } from '../working/helpers.ts';

type Entity = { [key: string]: Value };

const elementOf = (rec: ElementRec): Entity => ({
	id: rec.id,
	type_name: rec.typeName,
	properties: rec.props,
	rev: rec.rev
});

const relOf = (rec: RelRec): Entity => ({
	id: rec.id,
	type_name: rec.typeName,
	source_id: rec.source.id,
	target_id: rec.target.id,
	properties: rec.props,
	rev: rec.rev
});

/** The file holding `elements` and `relationships`, read against the working copy's metamodel. */
function fileOf(wc: WorkingCopy, elements: Entity[], relationships: Entity[]): OtherModel {
	const text = pyDumps({ elements, relationships });
	return readModelFile(parseExact(text), wc.model.metamodel);
}

/** The working copy's own state, as a file. */
const sameFile = (wc: WorkingCopy): OtherModel =>
	fileOf(wc, [...wc.model.elements()].map(elementOf), [...wc.model.relationships()].map(relOf));

const ids = (entities: readonly { id: string }[]) => entities.map((entity) => entity.id);

const named = (entity: Entity, name: string): Entity => ({
	...entity,
	properties: { ...(entity['properties'] as Entity), name }
});

const smartReplica = () => workingCopy(smartCity().model);

describe('diffSteps', () => {
	it('finds nothing between the working copy and its own file', () => {
		const wc = smartReplica();
		const diff = drain(diffSteps(wc, sameFile(wc)));
		for (const kind of [diff.elements, diff.relationships]) {
			expect(kind).toEqual({ added: [], modified: [], deleted: [] });
		}
	});

	it("lists added and modified in the file's order, deleted in the working copy's, rev ignored", () => {
		const wc = smartReplica();
		const els = [...wc.model.elements()];
		const rels = [...wc.model.relationships()];
		const gone = new Set([els[7]!.id, els[3]!.id]);
		const survivors = rels.filter((r) => !gone.has(r.source.id) && !gone.has(r.target.id));
		const dropped = survivors[0]!;
		const rewired = survivors[1]!;
		const newTarget = rewired.target.id === els[0]!.id ? els[1]! : els[0]!;

		const kept = els.filter((e) => !gone.has(e.id)).map(elementOf);
		const at = (id: string) => kept.findIndex((e) => e['id'] === id);
		kept[at(els[5]!.id)] = named(kept[at(els[5]!.id)]!, 'renamed 5');
		kept[at(els[11]!.id)] = { ...kept[at(els[11]!.id)]!, rev: 99 };
		// The later element, modified, goes first in the file.
		const [tenth] = kept.splice(at(els[10]!.id), 1);
		const fileElements = [
			named(tenth!, 'renamed 10'),
			{ id: 'new-b', type_name: 'Team', properties: { name: 'B' }, rev: 0 },
			...kept,
			{ id: 'new-a', type_name: 'Team', properties: { name: 'A' }, rev: 0 }
		];
		const fileRels = [
			...survivors
				.filter((r) => r !== dropped)
				.map((r) => (r === rewired ? { ...relOf(r), target_id: newTarget.id } : relOf(r))),
			{
				id: 'new-r',
				type_name: 'MemberOf',
				source_id: 'new-a',
				target_id: 'new-b',
				properties: {},
				rev: 0
			}
		];

		const diff = drain(diffSteps(wc, fileOf(wc, fileElements, fileRels)));
		expect(ids(diff.elements.added)).toEqual(['new-b', 'new-a']);
		expect(ids(diff.elements.modified)).toEqual([els[10]!.id, els[5]!.id]);
		expect(ids(diff.elements.deleted)).toEqual([els[3]!.id, els[7]!.id]);
		expect(ids(diff.relationships.added)).toEqual(['new-r']);
		expect(ids(diff.relationships.modified)).toEqual([rewired.id]);
		expect(ids(diff.relationships.deleted)).toEqual(
			rels
				.filter((r) => r === dropped || gone.has(r.source.id) || gone.has(r.target.id))
				.map((r) => r.id)
		);
		const [modified] = diff.relationships.modified;
		expect(modified!.before).toMatchObject({ target_id: rewired.target.id });
		expect(modified!.after).toMatchObject({ target_id: newTarget.id });
	});

	it('diffs against the WORKING state, staged edits included', () => {
		const committed = smartReplica();
		const committedFile = sameFile(committed);
		const wc = smartReplica();
		const els = [...wc.model.elements()];
		const victim = els.find((e) => e.out.length === 0 && e.in.length === 0) ?? els[4]!;
		const renamed = els.find((e) => e !== victim)!;
		wc.stage([
			{ kind: 'delete_element', id: victim.id },
			{ kind: 'update_element', id: renamed.id, properties_patch: { name: 'staged name' } },
			{
				kind: 'create_element',
				temp_id: 'tmp_1',
				type_name: 'Team',
				properties: { name: 'staged' },
				id: 'staged-y'
			}
		]);

		const diff = drain(diffSteps(wc, committedFile));
		const missing = [...committedFile.elements.keys()].filter(
			(id) => wc.model.findElement(id) === undefined
		);
		expect(missing).toContain(victim.id);
		expect(ids(diff.elements.added)).toEqual(missing);
		expect(ids(diff.elements.deleted)).toEqual(['staged-y']);
		expect(ids(diff.elements.modified)).toEqual([renamed.id]);
		const [modified] = diff.elements.modified;
		expect((modified!.before.properties as Entity)['name']).toBe('staged name');
		expect(modified!.after.properties).toEqual(committedFile.elements.get(renamed.id)!.props);
	});

	it('compares properties with Python equality', () => {
		const wc = smartReplica();
		const team = wc.model.getElement('e_000006');
		expect(team.props['size']).toBe(4);
		const file = (properties: Entity) =>
			fileOf(
				wc,
				[...wc.model.elements()].map((e) =>
					e === team ? { ...elementOf(e), properties } : elementOf(e)
				),
				[...wc.model.relationships()].map(relOf)
			);
		const same = (properties: Entity) =>
			drain(diffSteps(wc, file(properties))).elements.modified.length === 0;
		const reordered = Object.fromEntries(Object.entries(team.props).reverse());
		expect(same(reordered)).toBe(true);
		expect(same({ ...team.props, size: new PyFloat(4) })).toBe(true);
		expect(same({ ...team.props, size: '4' })).toBe(false);
		expect(same({ ...team.props, size: new PyFloat(4.5) })).toBe(false);
		expect(same({ ...team.props, extra: null })).toBe(false);
	});

	it('ends a step every 2,048 entities it visits', () => {
		const wc = smartReplica();
		const other = sameFile(wc);
		const total =
			other.elements.size +
			other.relationships.size +
			wc.model.elementCount +
			wc.model.relationshipCount;
		const steps = diffSteps(wc, other);
		const progress: Progress[] = [];
		for (;;) {
			const next = steps.next();
			if (next.done === true) break;
			progress.push(next.value);
		}
		expect(total).toBeGreaterThan(2048);
		expect(progress.length).toBe(Math.floor(total / 2048));
		let before = 0;
		for (const { done, total: of } of progress) {
			expect(of).toBe(total);
			expect(done - before).toBe(2048);
			before = done;
		}
	});
});

describe('crDocument', () => {
	/** A diff holding one entry of each kind. */
	function everyKind(): Diff {
		const wc = smartReplica();
		const els = [...wc.model.elements()];
		const rels = [...wc.model.relationships()];
		const goneRel = rels.at(-1)!;
		const changedRel = rels[0]!;
		const goneEl = els.find((e) => e.out.length === 0 && e.in.length === 0)!;
		const fileEls = els
			.filter((e) => e !== goneEl)
			.map((e) => (e === els[0] ? named(elementOf(e), 'changed') : elementOf(e)));
		fileEls.push({ id: 'new', type_name: 'Team', properties: { n: 1 }, rev: 0 });
		const fileRels = rels
			.filter((r) => r !== goneRel)
			.map((r) =>
				r === changedRel ? { ...relOf(r), properties: { weight: new PyFloat(2.5) } } : relOf(r)
			);
		fileRels.push({
			id: 'new-r',
			type_name: 'MemberOf',
			source_id: 'new',
			target_id: els[1]!.id,
			properties: {},
			rev: 0
		});
		return drain(diffSteps(wc, fileOf(wc, fileEls, fileRels)));
	}

	it("writes _changes_out's shape and key order", () => {
		const doc = crDocument(everyKind(), { elementCount: 9, relationshipCount: 4 }, 'T0') as {
			[key: string]: unknown;
		};
		expect(Object.keys(doc)).toEqual(['format', 'createdAt', 'baseline', 'ops', 'complete']);
		expect(doc['format']).toBe('datarover.cr/v1');
		expect(doc['createdAt']).toBe('T0');
		expect(doc['complete']).toBe(true);
		expect(JSON.stringify(doc['baseline'])).toBe(
			'{"filename":null,"elementCount":9,"relationshipCount":4}'
		);
		const ops = doc['ops'] as { [kind: string]: { [what: string]: { [key: string]: unknown }[] } };
		expect(Object.keys(ops)).toEqual(['elements', 'relationships']);
		const E = ['id', 'type_name', 'properties', 'rev'];
		const R = ['id', 'type_name', 'source_id', 'target_id', 'properties', 'rev'];
		for (const [kind, keys] of [
			['elements', E],
			['relationships', R]
		] as const) {
			expect(Object.keys(ops[kind]!)).toEqual(['added', 'modified', 'deleted']);
			const { added, modified, deleted } = ops[kind]!;
			expect(added).toHaveLength(1);
			expect(modified).toHaveLength(1);
			expect(deleted).toHaveLength(1);
			expect(Object.keys(added![0]!)).toEqual(keys);
			expect(Object.keys(deleted![0]!)).toEqual(keys);
			expect(Object.keys(modified![0]!)).toEqual(['id', 'before', 'after']);
			expect(Object.keys(modified![0]!['before'] as object)).toEqual(keys);
			expect(Object.keys(modified![0]!['after'] as object)).toEqual(keys);
		}
	});

	it('copies every property bag it writes', () => {
		const diff = everyKind();
		const doc = crDocument(diff, { elementCount: 0, relationshipCount: 0 }, 'T0') as {
			ops: { elements: { modified: { before: { properties: object } }[] } };
		};
		const written = doc.ops.elements.modified[0]!.before.properties;
		expect(written).toEqual(diff.elements.modified[0]!.before.properties);
		expect(written).not.toBe(diff.elements.modified[0]!.before.properties);
	});
});

describe('crWire', () => {
	it('writes a non-finite float as null, as pydantic does', () => {
		expect(crWire(new PyFloat(Infinity))).toBeNull();
		expect(crWire(new PyFloat(-Infinity))).toBeNull();
		expect(crWire(new PyFloat(NaN))).toBeNull();
		expect(crWire({ a: [new PyFloat(Infinity), { b: new PyFloat(NaN) }] })).toEqual({
			a: [null, { b: null }]
		});
	});

	it('writes a float as its number and a bigint as the nearest Number', () => {
		expect(crWire(new PyFloat(1))).toBe(1);
		expect(crWire(new PyFloat(-0))).toBe(-0);
		expect(crWire(18446744073709551616n)).toBe(18446744073709551616);
		expect(typeof crWire(9007199254740993n)).toBe('number');
	});

	it('keeps key order and an own __proto__ key', () => {
		const value: { [key: string]: Value } = { b: 1 };
		Object.defineProperty(value, '__proto__', {
			value: 2,
			writable: true,
			enumerable: true,
			configurable: true
		});
		value['a'] = 3;
		const out = crWire(value) as object;
		expect(Object.keys(out)).toEqual(['b', '__proto__', 'a']);
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
	});
});
