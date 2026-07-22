import { describe, expect, it } from 'vitest';
import type { Element, Relationship, TreeItem } from '$lib/api/types';
import type { Diff, EntityDiff } from '../diff';
import { createTempId } from '../ops';
import { deriveStagedElementRows } from '../staged-rows';

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
			noLite
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
			noLite
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
			noLite
		);
		// s1 (real endpoint) becomes modified; tmpEl endpoint stays 'new'
		expect(rows).toEqual([
			{ id: tmpEl, status: 'new', displayName: 'Fresh', typeName: 'Device' },
			{ id: 's1', status: 'modified', displayName: 'Source', typeName: 'Device' }
		]);
	});

	it('endpoint rule never downgrades an existing deleted status', () => {
		const rows = deriveStagedElementRows(
			diff(
				[{ id: 'e1', status: 'deleted', before: el('e1', 'Gone') }],
				[{ id: 'r1', status: 'deleted', before: rel('r1', 'e1', 'e2') }]
			),
			none,
			noLite
		);
		expect(rows).toEqual([
			{ id: 'e2', status: 'modified', displayName: 'e2', typeName: null },
			{ id: 'e1', status: 'deleted', displayName: 'Gone', typeName: 'Device' }
		]);
	});

	it('falls back to the lite tree-item cache, then to the bare id', () => {
		const rows = deriveStagedElementRows(
			diff([], [{ id: 'r1', status: 'added', after: rel('r1', 'known', 'unknown') }]),
			none,
			new Map([['known', lite('known', 'Known thing', 'Sensor')]])
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
			noLite
		);
		expect(rows.map((r) => [r.status, r.displayName])).toEqual([
			['new', 'alpha'],
			['new', 'zeta'],
			['modified', 'beta'],
			['deleted', 'aaa']
		]);
	});
});
