import { describe, expect, it } from 'vitest';
import {
	elementLine,
	PyFloat,
	pyDumps,
	readDeltaText,
	readTailText,
	SnapshotError,
	type Value
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { family } from '../model/fixtures.ts';
import { clone, Server, workingCopy } from './helpers.ts';

/** A commit on a server over the family, and its delta as the feed's text. */
function commitText(extra: object = {}) {
	const committed = family();
	const server = new Server(clone(committed));
	const { delta } = server.commit([
		{
			kind: 'update_element',
			id: 'a',
			properties_patch: { name: 'x', peer: 'c' }
		}
	]);
	const text = pyDumps({ type: 'commit', ...delta, ...extra } as unknown as Value);
	return { committed, server, delta, text };
}

describe('readDeltaText', () => {
	it('reads a commit event', () => {
		const { delta, text } = commitText({ scope: ['model'], commit_id: 'c1', author_id: null });
		expect(readDeltaText(text)).toEqual(delta);
	});

	it('reads a commit response, its revision under model_rev, its extra fields ignored', () => {
		const { delta } = commitText();
		const { rev, ...rest } = delta;
		const text = pyDumps({
			model_rev: rev,
			...rest,
			id_map: { tmp_x: 'x' },
			changed_artifacts: [],
			view_revs: {}
		} as unknown as Value);
		expect(readDeltaText(text)).toEqual(delta);
	});

	it('reads absent lists as empty', () => {
		expect(readDeltaText('{"rev":2,"prev_rev":1,"state_digest":"0123456789abcdef"}')).toEqual({
			rev: 2,
			prev_rev: 1,
			state_digest: '0123456789abcdef',
			changed_elements: [],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			recreated_element_ids: [],
			recreated_relationship_ids: []
		});
	});

	it.each([
		['a null prev_rev', '{"rev":2,"prev_rev":null,"state_digest":"0123456789abcdef"}'],
		['no state_digest', '{"rev":2,"prev_rev":1}'],
		['an array', '[]'],
		['broken JSON', '{"rev":2,'],
		[
			'a list that is not one',
			'{"rev":2,"prev_rev":1,"state_digest":"0123456789abcdef","deleted_element_ids":"a"}'
		]
	])('refuses %s', (_, text) => {
		expect(thrown(() => readDeltaText(text))).toBeInstanceOf(SnapshotError);
	});

	it('keeps what JSON.parse loses', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const { delta } = server.commit([
			{
				kind: 'update_element',
				id: 'a',
				properties_patch: {
					name: new PyFloat(1),
					peer: 9007199254740993n,
					constructor: new PyFloat(-0)
				}
			}
		]);
		const text = pyDumps(delta as unknown as Value);
		expect(text).toContain('1.0');
		expect(wc.applyDelta(readDeltaText(text)).status).toBe('applied');
		expect(elementLine(wc.model.getElement('a'))).toBe(
			'{"id":"a","type_name":"Node","properties":{"name":1.0,"peer":9007199254740993,"constructor":-0.0},"rev":4}'
		);
		expect(wc.diverged).toBe(false);
	});
});

describe('readTailText', () => {
	it('reads the deltas in order', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const first = server.commit([
			{ kind: 'update_element', id: 'a', properties_patch: { name: '1' } }
		]);
		const second = server.commit([{ kind: 'delete_element', id: 'd' }]);
		const text = pyDumps({
			from_rev: 0,
			head_rev: 2,
			complete: true,
			deltas: [first.delta, second.delta]
		} as unknown as Value);
		expect(readTailText(text)).toEqual([first.delta, second.delta]);
	});

	it('refuses an incomplete tail and a malformed one', () => {
		const incomplete = '{"from_rev":0,"head_rev":9,"complete":false,"deltas":[]}';
		expect(thrown(() => readTailText(incomplete))).toBeInstanceOf(SnapshotError);
		expect(thrown(() => readTailText('{"complete":true}'))).toBeInstanceOf(SnapshotError);
		const bad = '{"complete":true,"deltas":[{"rev":1}]}';
		expect(thrown(() => readTailText(bad))).toBeInstanceOf(SnapshotError);
	});
});
