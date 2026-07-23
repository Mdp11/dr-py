import { describe, expect, it } from 'vitest';
import type { Element, Relationship, TreeItem } from '$lib/api/types';
import type { Diff, EntityDiff } from '../diff';
import { createTempId } from '../ops';
import { deriveStagedElementRows, stagedRelationshipOpIds } from '../staged-rows';

const el = (id: string, name: string, type = 'Device'): Element => ({
	id,
	type_name: type,
	properties: { name },
	rev: 1
});

const rel = (id: string, source: string, target: string): Relationship => ({
	id,
	type_name: 'Owns',
	source_id: source,
	target_id: target,
	properties: {},
	rev: 1
});

const lite = (id: string, display: string, type = 'Device'): TreeItem => ({
	id,
	type_name: type,
	display_name: display,
	child_count: 0
});

const diff = (elements: EntityDiff[], relationships: EntityDiff[] = []): Diff => ({
	elements,
	relationships,
	counts: { added: 0, modified: 0, deleted: 0 }
});

/** The endpoint rule only fires for relationships a staged relationship OP
 * names — the 4th argument. `opIds()` means "no staged relationship ops". */
const opIds = (...ids: string[]) => new Set(ids);

const none = new Map<string, Element>();
const noLite = new Map<string, TreeItem>();

describe('deriveStagedElementRows', () => {
	it('maps added/modified/deleted element diffs to badged rows', () => {
		const tmp = createTempId();
		const cache = new Map([
			[tmp, el(tmp, 'Fresh')],
			['e1', el('e1', 'Edited')]
		]);
		const rows = deriveStagedElementRows(
			diff([
				{ id: tmp, status: 'added', after: cache.get(tmp) },
				{ id: 'e1', status: 'modified', before: el('e1', 'Old'), after: cache.get('e1') },
				{ id: 'e2', status: 'deleted', before: el('e2', 'Gone', 'Sensor') }
			]),
			cache,
			noLite,
			opIds()
		);
		expect(rows).toEqual([
			{ id: tmp, status: 'new', displayName: 'Fresh', typeName: 'Device' },
			{ id: 'e1', status: 'modified', displayName: 'Edited', typeName: 'Device' },
			{ id: 'e2', status: 'deleted', displayName: 'Gone', typeName: 'Sensor' }
		]);
	});

	it('omits a temp element deleted in the same buffer (net no-op)', () => {
		const tmp = createTempId();
		const rows = deriveStagedElementRows(
			diff([{ id: tmp, status: 'deleted', before: el(tmp, 'Ghost') }]),
			none,
			noLite,
			opIds()
		);
		expect(rows).toEqual([]);
	});

	it('marks real endpoints of staged relationship changes as modified', () => {
		const tmpEl = createTempId();
		const tmpRel = createTempId();
		const cache = new Map([
			[tmpEl, el(tmpEl, 'Fresh')],
			['s1', el('s1', 'Source')]
		]);
		const rows = deriveStagedElementRows(
			diff(
				[{ id: tmpEl, status: 'added', after: cache.get(tmpEl) }],
				[{ id: tmpRel, status: 'added', after: rel(tmpRel, 's1', tmpEl) }]
			),
			cache,
			noLite,
			opIds(tmpRel)
		);
		// s1 (real endpoint) becomes modified; tmpEl endpoint stays 'new'
		expect(rows).toEqual([
			{ id: tmpEl, status: 'new', displayName: 'Fresh', typeName: 'Device' },
			{ id: 's1', status: 'modified', displayName: 'Source', typeName: 'Device' }
		]);
	});

	it('endpoint rule never downgrades an existing deleted status', () => {
		// r1 IS named by a staged delete_relationship op, so the endpoint rule
		// fires for both its ends — but e1 is already deleted and stays deleted.
		const rows = deriveStagedElementRows(
			diff(
				[{ id: 'e1', status: 'deleted', before: el('e1', 'Gone') }],
				[{ id: 'r1', status: 'deleted', before: rel('r1', 'e1', 'e2') }]
			),
			none,
			noLite,
			opIds('r1')
		);
		expect(rows).toEqual([
			{ id: 'e2', status: 'modified', displayName: 'e2', typeName: null },
			{ id: 'e1', status: 'deleted', displayName: 'Gone', typeName: 'Device' }
		]);
	});

	it('ignores relationships no staged op names (delete_element cascade)', () => {
		// Staging delete_element(e1) makes getStagedDiff() synthesise a deleted
		// entry for the cascade-removed r1(e1,e2) — but no relationship OP was
		// staged, so e2 must NOT get an "edited" row: nothing staged targets it,
		// and its revert button would be a permanent no-op.
		const rows = deriveStagedElementRows(
			diff(
				[{ id: 'e1', status: 'deleted', before: el('e1', 'Gone') }],
				[{ id: 'r1', status: 'deleted', before: rel('r1', 'e1', 'e2') }]
			),
			none,
			noLite,
			opIds() // no staged relationship ops
		);
		expect(rows).toEqual([
			{ id: 'e1', status: 'deleted', displayName: 'Gone', typeName: 'Device' }
		]);
	});

	it('falls back to the lite tree-item cache, then to the bare id', () => {
		const rows = deriveStagedElementRows(
			diff([], [{ id: 'r1', status: 'added', after: rel('r1', 'known', 'unknown') }]),
			none,
			new Map([['known', lite('known', 'Known thing', 'Sensor')]]),
			opIds('r1')
		);
		expect(rows).toEqual([
			{ id: 'known', status: 'modified', displayName: 'Known thing', typeName: 'Sensor' },
			{ id: 'unknown', status: 'modified', displayName: 'unknown', typeName: null }
		]);
	});

	it('sorts new → modified → deleted, alphabetical within a group', () => {
		const t1 = createTempId();
		const t2 = createTempId();
		const cache = new Map([
			[t1, el(t1, 'zeta')],
			[t2, el(t2, 'alpha')],
			['m1', el('m1', 'beta')]
		]);
		const rows = deriveStagedElementRows(
			diff([
				{ id: 'd1', status: 'deleted', before: el('d1', 'aaa') },
				{ id: t1, status: 'added', after: cache.get(t1) },
				{ id: 'm1', status: 'modified', before: el('m1', 'x'), after: cache.get('m1') },
				{ id: t2, status: 'added', after: cache.get(t2) }
			]),
			cache,
			noLite,
			opIds()
		);
		expect(rows.map((r) => [r.status, r.displayName])).toEqual([
			['new', 'alpha'],
			['new', 'zeta'],
			['modified', 'beta'],
			['deleted', 'aaa']
		]);
	});
});

describe('stagedRelationshipOpIds', () => {
	it('names create ops by temp_id, update/delete ops by id, and skips element ops', () => {
		const tmpEl = createTempId();
		const tmpRel = createTempId();
		expect(
			stagedRelationshipOpIds([
				{ kind: 'create_element', temp_id: tmpEl, type_name: 'Device', properties: {} },
				{ kind: 'update_element', id: 'e1', properties_patch: {} },
				{ kind: 'delete_element', id: 'e2' },
				{
					kind: 'create_relationship',
					temp_id: tmpRel,
					type_name: 'Owns',
					source_id: 'e1',
					target_id: tmpEl,
					properties: {}
				},
				{ kind: 'update_relationship', id: 'r2', properties_patch: {} },
				{ kind: 'delete_relationship', id: 'r3' }
			])
		).toEqual(new Set([tmpRel, 'r2', 'r3']));
	});
});
