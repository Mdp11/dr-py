import { describe, expect, it } from 'vitest';
import {
	dumpIndexes,
	elementLine,
	modelLines,
	OpError,
	verifyConsistent,
	type ModelOp,
	type Props,
	type WorkingCopy
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { family } from '../model/fixtures.ts';
import { clone, Server, workingCopy } from './helpers.ts';

const update = (id: string, properties_patch: Props): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch
});

/** The committed state with `wc.staged()` replayed through plain staging. */
function replayed(wc: WorkingCopy, committed: WorkingCopy): WorkingCopy {
	for (const batch of wc.staged()) committed.stage(batch.ops);
	return committed;
}

function sameState(a: WorkingCopy, b: WorkingCopy): void {
	expect(modelLines(a.model)).toEqual(modelLines(b.model));
	expect(dumpIndexes(a.model)).toEqual(dumpIndexes(b.model));
}

describe('coalescing', () => {
	it('two updates of one element become one op', () => {
		const wc = workingCopy(family());
		const first = wc.stage([update('a', { name: 'x', peer: 'c' })], { coalesce: true });
		const second = wc.stage([update('a', { peer: null, constructor: 'k' })], { coalesce: true });
		expect(first.coalesced).toBe(false);
		expect(second.coalesced).toBe(true);
		expect(second.batch.id).toBe(first.batch.id);
		expect(wc.staged()).toEqual([
			{ id: 1, ops: [update('a', { name: 'x', peer: null, constructor: 'k' })] }
		]);
		expect(wc.model.getElement('a').props).toEqual({ name: 'x', constructor: 'k' });
		verifyConsistent(wc.model);
	});

	it('the merged op keeps its place', () => {
		const committed = family();
		const wc = workingCopy(clone(committed));
		wc.stage([update('a', { name: 'x1' })], { coalesce: true });
		wc.stage([update('c', { name: 'y' })], { coalesce: true });
		const { batch } = wc.stage([update('a', { name: 'x2' })], { coalesce: true });
		expect(batch.id).toBe(1);
		expect(wc.staged()).toEqual([
			{ id: 1, ops: [update('a', { name: 'x2' })] },
			{ id: 2, ops: [update('c', { name: 'y' })] }
		]);
		sameState(wc, replayed(wc, workingCopy(committed)));
		verifyConsistent(wc.model);
	});

	it('merges into the first op of that kind and id, inside a larger batch too', () => {
		const committed = family();
		const wc = workingCopy(clone(committed));
		const create: ModelOp = {
			kind: 'create_element',
			temp_id: 'tmp_e',
			type_name: 'Node',
			properties: { name: 'E' }
		};
		wc.stage([create, update('a', { name: 'one' }), update('a', { peer: 'c' })]);
		wc.stage([update('c', { name: 'C2' })]);
		const { batch, coalesced } = wc.stage([update('a', { name: 'two' })], { coalesce: true });
		expect([batch.id, coalesced]).toEqual([1, true]);
		expect(wc.staged()[0]!.ops).toEqual([
			create,
			update('a', { name: 'two' }),
			update('a', { peer: 'c' })
		]);
		sameState(wc, replayed(wc, workingCopy(committed)));
	});

	it('a deleted key that is set again stays where it was', () => {
		const committed = family();
		const wc = workingCopy(clone(committed));
		wc.stage([update('a', { peer: 'c' })]);
		wc.stage([update('a', { name: null })], { coalesce: true });
		expect(elementLine(wc.model.getElement('a'))).toBe(
			'{"id":"a","type_name":"Node","properties":{"peer":"c"},"rev":3}'
		);
		wc.stage([update('a', { name: 'Z' })], { coalesce: true });
		// In place, `name` would come back after `peer`, at rev 4.
		expect(elementLine(wc.model.getElement('a'))).toBe(
			'{"id":"a","type_name":"Node","properties":{"name":"Z","peer":"c"},"rev":3}'
		);
		sameState(wc, replayed(wc, workingCopy(committed)));
	});

	it('a refused patch leaves no trace', () => {
		const wc = workingCopy(family());
		wc.stage([update('a', { name: 'kept' })], { coalesce: true });
		wc.stage([update('c', { name: 'also' })], { coalesce: true });
		const staged = wc.staged();
		const [lines, dump, version] = [modelLines(wc.model), dumpIndexes(wc.model), wc.stagedVersion];
		const error = thrown(() => wc.stage([update('a', { undeclared: 1 })], { coalesce: true }));
		expect(error).toBeInstanceOf(OpError);
		expect([(error as OpError).status, (error as OpError).detail]).toEqual([
			422,
			"Node' has no property 'undeclared"
		]);
		expect(wc.staged()).toHaveLength(2);
		wc.staged().forEach((batch, i) => expect(batch).toBe(staged[i]));
		expect(wc.conflicts()).toEqual([]);
		expect(modelLines(wc.model)).toEqual(lines);
		expect(dumpIndexes(wc.model)).toEqual(dump);
		expect(wc.stagedVersion).toBe(version);
	});

	it('nothing coalesces without the option, for two ops, a create, a delete or a first touch', () => {
		const wc = workingCopy(family());
		expect(wc.stage([update('a', { name: '1' })]).coalesced).toBe(false);
		expect(wc.stage([update('a', { name: '2' })]).coalesced).toBe(false);
		const two = wc.stage([update('a', { name: '3' }), update('c', { name: '3' })], {
			coalesce: true
		});
		expect(two.coalesced).toBe(false);
		const create: ModelOp = { kind: 'create_element', temp_id: 'tmp_e', type_name: 'Node' };
		expect(wc.stage([create], { coalesce: true }).coalesced).toBe(false);
		expect(wc.stage([{ kind: 'delete_element', id: 'd' }], { coalesce: true }).coalesced).toBe(
			false
		);
		expect(wc.stage([update('b', { name: 'first' })], { coalesce: true }).coalesced).toBe(false);
		expect(wc.staged().map((batch) => batch.id)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('nothing coalesces into a parked batch', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([update('c', { name: 'parked' }), update('d', { name: 'gone' })]);
		wc.applyDelta(server.commit([{ kind: 'delete_element', id: 'b' }]).delta);
		expect(wc.conflicts().map(({ batch }) => batch.id)).toEqual([1]);
		const { batch, coalesced } = wc.stage([update('c', { name: 'again' })], { coalesce: true });
		expect([batch.id, coalesced]).toEqual([2, false]);
		expect(wc.conflicts().map(({ batch }) => batch.ops)).toEqual([
			[update('c', { name: 'parked' }), update('d', { name: 'gone' })]
		]);
	});

	it('the committed image stays the first one', () => {
		const wc = workingCopy(family());
		const before = wc.committedElement('a');
		for (let i = 0; i < 5; i++) wc.stage([update('a', { name: `edit ${i}` })], { coalesce: true });
		expect(wc.staged()).toHaveLength(1);
		expect(wc.committedElement('a')).toEqual(before);
		wc.unstage({ batch: 1 });
		expect(elementLine(wc.model.getElement('a'))).toBe(
			'{"id":"a","type_name":"Node","properties":{"name":"A"},"rev":1}'
		);
	});
});
