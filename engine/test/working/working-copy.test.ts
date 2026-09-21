import { describe, expect, it } from 'vitest';
import {
	OpError,
	parseJson,
	SnapshotError,
	verifyConsistent,
	WorkingCopy,
	type ModelOp
} from '../../src/index.ts';
import { stateDigest } from '../golden/digest.ts';
import { observe } from '../golden/model-steps.ts';
import { thrown } from '../golden/thrown.ts';
import { family } from '../model/fixtures.ts';
import { clone, Server, workingCopy } from './helpers.ts';

const rename = (id: string, name: string | null): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

const node = (temp_id: string, name: string): ModelOp => ({
	kind: 'create_element',
	temp_id,
	type_name: 'Node',
	properties: { name }
});

const refers = (temp_id: string, source_id: string, target_id: string): ModelOp => ({
	kind: 'create_relationship',
	temp_id,
	type_name: 'Refers',
	source_id,
	target_id
});

describe('staging', () => {
	it('applies in place under temp ids, says what changed, and keeps committed state readable', () => {
		const wc = workingCopy(family());
		const { batch, changes } = wc.stage([
			rename('a', 'renamed'),
			node('tmp_e', 'E'),
			refers('tmp_r', 'tmp_e', 'a'),
			{ kind: 'delete_element', id: 'b' }
		]);
		expect(batch.id).toBe(1);
		expect(changes).toEqual({
			elementIds: ['a', 'tmp_e'],
			relationshipIds: ['tmp_r'],
			deletedElementIds: ['b', 'd'],
			// per deleted element, its outgoing relationships, then its incoming ones
			deletedRelationshipIds: ['b-d', 'a-b'],
			structural: true
		});
		expect(wc.model.getElement('a').props).toEqual({ name: 'renamed' });
		expect(wc.committedElement('a')).toMatchObject({ props: { name: 'A' }, rev: 1 });
		expect(wc.committedElement('b')).toMatchObject({ props: { name: 'B' } });
		expect(wc.committedElement('tmp_e')).toBeNull();
		expect(wc.committedElement('c')).toMatchObject({ props: { name: 'C' } });
		expect(wc.committedRelationship('a-b')).toMatchObject({ sourceId: 'a', targetId: 'b' });
		expect(wc.committedRelationship('tmp_r')).toBeNull();
		expect(['a', 'tmp_e', 'a-b', 'c'].map((id) => wc.isStaged(id))).toEqual([
			true,
			true,
			true,
			false
		]);
		verifyConsistent(wc.model);
	});

	it('keeps the FIRST committed image when batches touch an entity again', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'one')]);
		wc.stage([rename('a', 'two')]);
		expect(wc.committedElement('a')).toMatchObject({ props: { name: 'A' }, rev: 1 });
	});

	it('throws on a refused batch and leaves no trace of it', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'kept')]);
		const before = observe(wc.model);
		const error = thrown(() => wc.stage([rename('c', 'lost'), rename('ghost', 'x')]));
		expect(error).toBeInstanceOf(OpError);
		expect(observe(wc.model)).toEqual(before);
		expect(wc.staged().map((batch) => batch.id)).toEqual([1]);
		expect(wc.isStaged('c')).toBe(false);
	});
});

describe('unstaging', () => {
	it('everything: the committed state is back byte for byte, order included', () => {
		const wc = workingCopy(family());
		const committed = observe(wc.model);
		wc.stage([{ kind: 'delete_element', id: 'a' }]);
		wc.stage([node('tmp_e', 'E'), refers('tmp_r', 'tmp_e', 'c')]);
		wc.stage([rename('c', null)]);
		const changes = wc.unstage('all');
		expect(observe(wc.model)).toEqual(committed);
		expect(wc.staged()).toEqual([]);
		expect(wc.isStaged('a')).toBe(false);
		expect(changes.elementIds.sort()).toEqual(['a', 'b', 'c', 'd']);
		expect(changes.deletedElementIds).toEqual(['tmp_e']);
		expect(changes.deletedRelationshipIds).toEqual(['tmp_r']);
		verifyConsistent(wc.model);
	});

	it('one batch: the rest replays on top, and a batch that needed it is parked, not dropped', () => {
		const wc = workingCopy(family());
		wc.stage([node('tmp_e', 'E')]);
		wc.stage([rename('c', 'still here')]);
		wc.stage([refers('tmp_r', 'tmp_e', 'c')]);
		wc.unstage({ batch: 1 });
		expect(wc.staged().map((batch) => batch.id)).toEqual([2]);
		expect(wc.model.getElement('c').props).toEqual({ name: 'still here' });
		expect(wc.model.findElement('tmp_e')).toBeUndefined();
		expect(wc.conflicts().map(({ batch, error }) => [batch.id, error.detail])).toEqual([
			[3, "No source element 'tmp_e"]
		]);
		wc.unstage({ batch: 3 });
		expect(wc.conflicts()).toEqual([]);
		verifyConsistent(wc.model);
	});

	it('one entity: the ops that target it go, the rest of their batches stay', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'x'), rename('c', 'y')]);
		wc.stage([rename('a', 'z')]);
		wc.unstage({ entity: 'a' });
		expect(wc.staged()).toEqual([{ id: 1, ops: [rename('c', 'y')] }]);
		expect(wc.model.getElement('a').props).toEqual({ name: 'A' });
		expect(wc.model.getElement('a').rev).toBe(1);
		expect(wc.unstage({ entity: 'nobody' })).toEqual({
			elementIds: [],
			relationshipIds: [],
			deletedElementIds: [],
			deletedRelationshipIds: [],
			structural: false
		});
	});

	it('one entity with its incident relationship ops, whatever names their ends', () => {
		const wc = workingCopy(family());
		wc.stage([node('tmp_e', 'E'), refers('tmp_r', 'tmp_e', 'c')]);
		wc.stage([{ kind: 'delete_relationship', id: 'tmp_r' }]);
		wc.stage([{ kind: 'delete_relationship', id: 'a-c' }, rename('d', 'D2')]);
		wc.unstage({ entity: 'c', incident: true });
		expect(wc.staged()).toEqual([
			{ id: 1, ops: [node('tmp_e', 'E')] },
			{ id: 3, ops: [rename('d', 'D2')] }
		]);
		expect(wc.conflicts()).toEqual([]);
		expect(wc.model.findRelationship('a-c')).toBeDefined();
	});
});

describe('deltas', () => {
	it('rebases the staged batches over a peer commit, as if they had been staged after it', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('a', 'mine'), node('tmp_e', 'E'), refers('tmp_r', 'tmp_e', 'c')]);
		const { delta } = server.commit([
			rename('c', 'theirs'),
			node('tmp_p', 'P'),
			{ kind: 'delete_element', id: 'd' }
		]);
		const { status, changes } = wc.applyDelta(delta);
		expect(status).toBe('applied');
		expect([wc.rev, wc.digest, wc.diverged]).toEqual([1, delta.state_digest, false]);
		expect(changes.elementIds.sort()).toEqual(['a', 'c', 'srv-1', 'tmp_e']);
		expect(changes.deletedElementIds).toEqual(['d']);

		const fresh = workingCopy(clone(server.model));
		fresh.stage(wc.staged()[0]!.ops);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		expect([...wc.model.elements()].map((e) => e.id)).toEqual(['a', 'b', 'c', 'srv-1', 'tmp_e']);
		expect(wc.committedElement('c')).toMatchObject({ props: { name: 'theirs' } });
		verifyConsistent(wc.model);
	});

	it('ignores a delta that is not newer and reports one that skips ahead', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const first = server.commit([rename('a', 'one')]).delta;
		const second = server.commit([rename('a', 'two')]).delta;
		expect(wc.applyDelta(second).status).toBe('gap');
		expect(wc.rev).toBe(0);
		expect(wc.applyDelta(first).status).toBe('applied');
		expect(wc.applyDelta(first).status).toBe('duplicate');
		expect(wc.applyDelta(second).status).toBe('applied');
		expect(wc.model.getElement('a').props).toEqual({ name: 'two' });
		expect(wc.diverged).toBe(false);
	});

	it('own commit: drops the committed batches and rewrites their temp ids in what stays', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const first = wc.stage([node('tmp_e', 'E')]).batch;
		const second = wc.stage([refers('tmp_r', 'tmp_e', 'c')]).batch;
		wc.stage([
			{ kind: 'update_element', id: 'tmp_e', properties_patch: { peer: 'tmp_e' } },
			{ kind: 'update_element', id: 'a', properties_patch: { peer: 'tmp_e' } },
			refers('tmp_s', 'a', 'tmp_e'),
			{ kind: 'delete_relationship', id: 'tmp_r' }
		]);
		const { delta, result } = server.commit([...first.ops, ...second.ops]);
		wc.applyDelta(delta, { batchIds: [first.id, second.id], idMap: result.idMap });
		expect(wc.staged()).toEqual([
			{
				id: 3,
				ops: [
					{ kind: 'update_element', id: 'srv-1', properties_patch: { peer: 'srv-1' } },
					{ kind: 'update_element', id: 'a', properties_patch: { peer: 'srv-1' } },
					{ ...refers('tmp_s', 'a', 'srv-1'), properties: {} },
					{ kind: 'delete_relationship', id: 'srv-2' }
				]
			}
		]);
		expect(wc.conflicts()).toEqual([]);
		expect(wc.model.findElement('tmp_e')).toBeUndefined();
		expect(wc.model.getElement('srv-1').props).toEqual({ name: 'E', peer: 'srv-1' });
		expect(wc.committedElement('srv-1')).toMatchObject({ props: { name: 'E' } });
		expect(wc.model.findRelationship('srv-2')).toBeUndefined();
		expect(wc.diverged).toBe(false);
		verifyConsistent(wc.model);
	});

	it('parks a staged batch the commit made impossible, and replays the others', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('d', 'doomed')]);
		wc.stage([rename('c', 'fine')]);
		wc.applyDelta(server.commit([{ kind: 'delete_element', id: 'b' }]).delta);
		expect(wc.staged().map((batch) => batch.id)).toEqual([2]);
		expect(
			wc.conflicts().map(({ batch, error }) => [batch.id, error.status, error.detail])
		).toEqual([[1, 422, "No element with id 'd"]]);
		expect(wc.model.getElement('c').props).toEqual({ name: 'fine' });
		expect(wc.diverged).toBe(false);
	});

	it('puts an entity the delta names as created again last, as the server did', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const { delta } = server.commit([
			{ kind: 'delete_relationship', id: 'a-b' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Contains',
				source_id: 'c',
				target_id: 'b',
				id: 'a-b'
			}
		]);
		wc.applyDelta(delta);
		expect(observe(wc.model)).toEqual(observe(server.model));
		expect([...wc.model.relationships()].map((r) => r.id)).toEqual(['b-d', 'a-c', 'a-b']);
		expect(wc.model.containerOf('b')).toBe('c');
		verifyConsistent(wc.model);
	});

	it('also when it comes back as it was, which only the name can tell from an update', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const { delta } = server.commit([
			{ kind: 'delete_element', id: 'c' },
			{ kind: 'create_element', temp_id: 'tmp_c', type_name: 'Node', id: 'c' },
			refers('tmp_r', 'a', 'tmp_c')
		]);
		expect(delta.recreated_element_ids).toEqual(['c']);
		expect(delta.deleted_relationship_ids).toEqual(['a-c']);
		wc.applyDelta(delta);
		expect(wc.diverged).toBe(false);
		expect(observe(wc.model)).toEqual(observe(server.model));
		expect([...wc.model.elements()].map((e) => e.id)).toEqual(['a', 'b', 'd', 'c']);
		verifyConsistent(wc.model);
	});
});

describe('divergence', () => {
	it('is set when the digest after a delta is not the one the delta names', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const { delta } = server.commit([rename('a', 'x')]);
		wc.applyDelta({ ...delta, state_digest: '0'.repeat(16) });
		expect(wc.diverged).toBe(true);
		expect(wc.digest).toBe(stateDigest(wc.model));
	});

	it('is set by a delta that does not fit the replica, and staged work survives', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'mine')]);
		const orphan = parseJson(
			'{"id":"r","type_name":"Refers","source_id":"nobody","target_id":"a","properties":{},"rev":0}'
		);
		wc.applyDelta({
			rev: 1,
			prev_rev: 0,
			state_digest: wc.digest,
			changed_elements: [],
			changed_relationships: [orphan],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			recreated_element_ids: [],
			recreated_relationship_ids: []
		});
		expect(wc.diverged).toBe(true);
		expect(wc.staged().map((batch) => batch.id)).toEqual([1]);
		expect(wc.model.getElement('a').props).toEqual({ name: 'mine' });
	});

	it('is set by a record that changes its ends or its type without being named as created again', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const rewired = workingCopy(committed);
		const { delta } = server.commit([
			{ kind: 'delete_relationship', id: 'a-b' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Contains',
				source_id: 'c',
				target_id: 'b',
				id: 'a-b'
			}
		]);
		rewired.applyDelta({ ...delta, recreated_relationship_ids: [] });
		expect(rewired.diverged).toBe(true);

		const retyped = workingCopy(family());
		retyped.applyDelta({
			rev: 1,
			prev_rev: 0,
			state_digest: retyped.digest,
			changed_elements: [parseJson('{"id":"c","type_name":"Other","properties":{},"rev":0}')],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			recreated_element_ids: [],
			recreated_relationship_ids: []
		});
		expect(retyped.diverged).toBe(true);
	});

	it('a delta the replica cannot hold throws before anything moves', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'mine')]);
		const before = observe(wc.model);
		const error = thrown(() =>
			wc.applyDelta({
				rev: 1,
				prev_rev: 0,
				state_digest: wc.digest,
				changed_elements: [
					parseJson('{"id":"a","type_name":"Node","properties":{"name":{"7":1}},"rev":2}')
				],
				changed_relationships: [],
				deleted_element_ids: [],
				deleted_relationship_ids: [],
				recreated_element_ids: [],
				recreated_relationship_ids: []
			})
		);
		expect(error).toBeInstanceOf(SnapshotError);
		expect((error as Error).message).toBe(
			"changed_elements[0]: property key '7' is an array index, which cannot keep its place in insertion order"
		);
		expect(observe(wc.model)).toEqual(before);
		expect([wc.rev, wc.diverged]).toEqual([0, false]);
	});
});

describe('verifying the digest', () => {
	it('recomputes it from committed state, whatever is staged on top', () => {
		const wc = workingCopy(family());
		expect(wc.verifyDigest()).toBe(true);
		wc.stage([
			rename('a', 'mine'),
			node('tmp_e', 'E'),
			refers('tmp_r', 'tmp_e', 'c'),
			{ kind: 'delete_element', id: 'b' }
		]);
		expect(wc.verifyDigest()).toBe(true);
		expect(wc.diverged).toBe(false);
	});

	it('holds after a delta lands under staged work', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('c', 'mine'), { kind: 'delete_relationship', id: 'a-c' }]);
		wc.applyDelta(server.commit([rename('a', 'theirs'), node('tmp_x', 'X')]).delta);
		expect(wc.verifyDigest()).toBe(true);
		expect(wc.diverged).toBe(false);
	});

	it('fails, and sets diverged, when the replica does not hold what the digest names', () => {
		const model = family();
		const wrong = new WorkingCopy(model, { rev: 0, digest: '0'.repeat(16) });
		expect(wrong.verifyDigest()).toBe(false);
		expect(wrong.diverged).toBe(true);

		const wc = workingCopy(family());
		wc.model.setProperty(wc.model.getElement('d'), 'name', 'behind its back');
		expect(wc.verifyDigest()).toBe(false);
		expect(wc.diverged).toBe(true);
	});

	it('takes another hash when one is given', () => {
		const model = family();
		const count = model.elementCount + model.relationshipCount;
		let calls = 0;
		const wc = new WorkingCopy(
			model,
			{ rev: 0, digest: '0'.repeat(16) },
			{ entityHash: () => (calls++, 0n) }
		);
		expect(wc.verifyDigest()).toBe(true);
		expect(calls).toBe(count);
	});
});

describe('the own commit on a duplicate', () => {
	it("a duplicate that names the user's own batches still drops them", () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const mine = wc.stage([node('tmp_e', 'E')]).batch;
		wc.stage([{ kind: 'update_element', id: 'a', properties_patch: { peer: 'tmp_e' } }]);
		const { delta, result } = server.commit(mine.ops);
		// The echo first: the staged create now exists twice, under its temp id and its real one.
		expect(wc.applyDelta(delta).status).toBe('applied');
		expect(wc.model.findElement('tmp_e')).toBeDefined();
		expect(wc.model.findElement('srv-1')).toBeDefined();

		const own = { batchIds: [mine.id], idMap: result.idMap };
		const { status, changes } = wc.applyDelta(delta, own);
		expect(status).toBe('duplicate');
		expect(changes.structural).toBe(true);
		expect(wc.staged()).toEqual([
			{ id: 2, ops: [{ kind: 'update_element', id: 'a', properties_patch: { peer: 'srv-1' } }] }
		]);
		expect(wc.model.findElement('tmp_e')).toBeUndefined();
		const fresh = workingCopy(clone(server.model), 1);
		for (const batch of wc.staged()) fresh.stage(batch.ops);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		expect(wc.diverged).toBe(false);
		verifyConsistent(wc.model);
	});

	it('a batch its own echo parked is dropped too', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const mine = wc.stage([{ kind: 'delete_element', id: 'c' }]).batch;
		const { delta, result } = server.commit(mine.ops);
		wc.applyDelta(delta);
		expect(wc.conflicts().map(({ batch, error }) => [batch.id, error.detail])).toEqual([
			[1, "No element with id 'c"]
		]);
		const { status } = wc.applyDelta(delta, { batchIds: [mine.id], idMap: result.idMap });
		expect(status).toBe('duplicate');
		expect(wc.conflicts()).toEqual([]);
		expect(wc.staged()).toEqual([]);
		expect(observe(wc.model)).toEqual(observe(server.model));
	});

	it('a duplicate without own changes nothing', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('a', 'mine')]);
		const { delta } = server.commit([rename('c', 'theirs')]);
		wc.applyDelta(delta);
		const [before, version, staged] = [observe(wc.model), wc.stagedVersion, wc.staged()];
		const { status, changes } = wc.applyDelta(delta);
		expect(status).toBe('duplicate');
		expect(changes).toEqual({
			elementIds: [],
			relationshipIds: [],
			deletedElementIds: [],
			deletedRelationshipIds: [],
			structural: false
		});
		expect(observe(wc.model)).toEqual(before);
		expect(wc.stagedVersion).toBe(version);
		expect(wc.staged()).toEqual(staged);
	});
});

describe('structural', () => {
	it('a property-only stage is not', () => {
		expect(workingCopy(family()).stage([rename('a', 'x')]).changes.structural).toBe(false);
	});

	it.each<[string, ModelOp[]]>([
		['a create', [node('tmp_e', 'E')]],
		['a delete', [{ kind: 'delete_element', id: 'c' }]],
		['a relationship created', [refers('tmp_r', 'a', 'd')]],
		['a relationship updated', [{ kind: 'update_relationship', id: 'a-c', properties_patch: {} }]],
		['a relationship deleted', [{ kind: 'delete_relationship', id: 'a-c' }]]
	])('%s is', (_, ops) => {
		expect(workingCopy(family()).stage(ops).changes.structural).toBe(true);
	});

	it('the unstage of a staged create and of a staged delete are', () => {
		const created = workingCopy(family());
		created.stage([node('tmp_e', 'E')]);
		expect(created.unstage('all').structural).toBe(true);
		const deleted = workingCopy(family());
		deleted.stage([{ kind: 'delete_element', id: 'c' }]);
		expect(deleted.unstage({ entity: 'c' }).structural).toBe(true);
	});

	it('a peer delta that only changes properties while renames are staged is not', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('a', 'one')]);
		wc.stage([rename('b', 'two')]);
		wc.stage([rename('d', 'three')]);
		const { changes } = wc.applyDelta(server.commit([rename('c', 'theirs')]).delta);
		expect(changes.structural).toBe(false);
	});

	it('a delta that adds an element is', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('a', 'one')]);
		const { changes } = wc.applyDelta(server.commit([node('tmp_p', 'P')]).delta);
		expect(changes.structural).toBe(true);
	});

	it('an own commit with an id map is', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const mine = wc.stage([rename('a', 'one'), node('tmp_e', 'E')]).batch;
		const { delta, result } = server.commit(mine.ops);
		const { changes } = wc.applyDelta(delta, { batchIds: [mine.id], idMap: result.idMap });
		expect(changes.structural).toBe(true);
	});
});

describe('the staged version', () => {
	it('moves on stage, merge, unstage, own-commit drop and a rebase that parks', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const moves: boolean[] = [];
		const step = (action: () => unknown) => {
			const version = wc.stagedVersion;
			action();
			moves.push(wc.stagedVersion !== version);
		};
		step(() => wc.stage([rename('a', 'one')]));
		step(() => wc.stage([rename('a', 'two')], { coalesce: true }));
		step(() => wc.stage([rename('d', 'doomed')]));
		step(() => wc.unstage({ entity: 'a' }));
		step(() => wc.applyDelta(server.commit([{ kind: 'delete_element', id: 'b' }]).delta));
		const mine = wc.stage([node('tmp_e', 'E')]).batch;
		const { delta, result } = server.commit(mine.ops);
		step(() => wc.applyDelta(delta, { batchIds: [mine.id], idMap: result.idMap }));
		expect(moves).toEqual([true, true, true, true, true, true]);
	});

	it('stays on a delta that leaves the lists alone and on an unstage that matched nothing', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('a', 'one')]);
		const version = wc.stagedVersion;
		wc.applyDelta(server.commit([rename('c', 'theirs')]).delta);
		wc.unstage({ entity: 'nobody' });
		wc.unstage({ batch: 99 });
		expect(wc.stagedVersion).toBe(version);
	});
});

describe('stagedDiff', () => {
	it('pairs the committed image with the staged record, in first-touch order', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'renamed')]);
		wc.stage([node('tmp_e', 'E'), { kind: 'delete_element', id: 'c' }]);
		const diff = wc.stagedDiff();
		expect(diff.elements.map(({ id, before, after }) => [id, before?.props, after?.props])).toEqual(
			[
				['a', { name: 'A' }, { name: 'renamed' }],
				['tmp_e', undefined, { name: 'E' }],
				['c', { name: 'C' }, undefined]
			]
		);
		expect(diff.elements[1]!.before).toBeNull();
		expect(diff.elements[2]!.after).toBeNull();
		expect(diff.elements[0]!.after).toBe(wc.model.getElement('a'));
		expect(
			diff.relationships.map(({ id, before, after }) => [id, before?.sourceId, after])
		).toEqual([['a-c', 'a', null]]);
	});
});
