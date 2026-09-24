import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	PyFloat,
	readArtifacts,
	ReadError,
	readStagedArtifacts,
	type WireArtifact,
	type WireStagedArtifact
} from '../../src/index.ts';

/** The refusal `run` throws, as `{status, detail}`. */
function refusal(run: () => unknown): { status: number; detail: string } {
	try {
		run();
	} catch (error) {
		if (error instanceof ReadError) return { status: error.status, detail: error.detail };
		throw error;
	}
	throw new Error('expected a refusal');
}

const nav = (id: string, name: string, payload: { [key: string]: unknown } = {}): WireArtifact => ({
	id,
	kind: 'navigation',
	name,
	artifact_rev: 1,
	payload
});

/** A set holding `committed`, with `staged` over it. */
function setOf(committed: WireArtifact[], staged: WireStagedArtifact[] = []): ArtifactSet {
	const set = new ArtifactSet();
	set.setCommitted(readArtifacts(committed));
	set.setStaged(readStagedArtifacts(staged));
	return set;
}

describe('ArtifactSet.resolve', () => {
	it('answers a committed artifact, and null for an unknown id', () => {
		const set = setOf([nav('n1', 'One', { kind: 'path' })]);
		expect(set.resolve('n1')).toEqual({
			id: 'n1',
			kind: 'navigation',
			name: 'One',
			payload: { kind: 'path' }
		});
		expect(set.resolve('ghost')).toBeNull();
		expect(set.size).toBe(1);
	});

	it('answers a staged create under its temp id', () => {
		const set = setOf(
			[],
			[{ op: 'create', id: 'tmp_x', kind: 'table', name: 'X', payload: { columns: [] } }]
		);
		expect(set.resolve('tmp_x')).toEqual({
			id: 'tmp_x',
			kind: 'table',
			name: 'X',
			payload: { columns: [] }
		});
		expect(set.size).toBe(1);
	});

	it('lays a staged update over the committed artifact, field by field', () => {
		const committed = [nav('n1', 'One', { v: 'old' })];
		expect(setOf(committed, [{ op: 'update', id: 'n1', name: 'Renamed' }]).resolve('n1')).toEqual({
			id: 'n1',
			kind: 'navigation',
			name: 'Renamed',
			payload: { v: 'old' }
		});
		expect(
			setOf(committed, [{ op: 'update', id: 'n1', payload: { v: 'new' } }]).resolve('n1')
		).toEqual({ id: 'n1', kind: 'navigation', name: 'One', payload: { v: 'new' } });
		expect(
			setOf(committed, [{ op: 'update', id: 'n1', name: 'Both', payload: { v: 'new' } }]).resolve(
				'n1'
			)
		).toEqual({ id: 'n1', kind: 'navigation', name: 'Both', payload: { v: 'new' } });
	});

	it('answers null for an update with nothing committed under it', () => {
		const set = setOf([], [{ op: 'update', id: 'n1', name: 'Orphan', payload: {} }]);
		expect(set.resolve('n1')).toBeNull();
		expect(set.size).toBe(0);
	});

	it('hides a committed artifact staged as a delete, until the overlay is cleared', () => {
		const set = setOf([nav('n1', 'One'), nav('n2', 'Two')], [{ op: 'delete', id: 'n1' }]);
		expect(set.resolve('n1')).toBeNull();
		expect(set.resolve('n2')?.name).toBe('Two');
		expect(set.size).toBe(1);
		set.setStaged([]);
		expect(set.resolve('n1')?.name).toBe('One');
		expect(set.size).toBe(2);
	});

	it('restores the committed view when the overlay is replaced by an empty one', () => {
		const set = setOf(
			[nav('n1', 'One', { v: 1 })],
			[
				{ op: 'update', id: 'n1', name: 'Staged', payload: { v: 2 } },
				{ op: 'create', id: 'tmp_x', kind: 'navigation', name: 'X', payload: {} }
			]
		);
		expect(set.resolve('n1')?.name).toBe('Staged');
		set.setStaged(readStagedArtifacts([]));
		expect(set.resolve('n1')).toEqual({
			id: 'n1',
			kind: 'navigation',
			name: 'One',
			payload: { v: 1 }
		});
		expect(set.resolve('tmp_x')).toBeNull();
	});

	it('gives the same view whichever of put and setStaged comes first', () => {
		const changed = readArtifacts([nav('n2', 'Two', { v: 'committed' }), nav('n3', 'Three')]);
		const staged = readStagedArtifacts([
			{ op: 'update', id: 'n2', payload: { v: 'staged' } },
			{ op: 'delete', id: 'n3' }
		]);
		const view = (set: ArtifactSet) => ['n1', 'n2', 'n3'].map((id) => set.resolve(id));

		const putFirst = setOf([nav('n1', 'One'), nav('n3', 'Old three')]);
		putFirst.put(changed, ['n1']);
		putFirst.setStaged(staged);

		const stagedFirst = setOf([nav('n1', 'One'), nav('n3', 'Old three')]);
		stagedFirst.setStaged(staged);
		stagedFirst.put(changed, ['n1']);

		expect(view(putFirst)).toEqual([
			null,
			{ id: 'n2', kind: 'navigation', name: 'Two', payload: { v: 'staged' } },
			null
		]);
		expect(view(stagedFirst)).toEqual(view(putFirst));
		expect(putFirst.size).toBe(1);
		expect(stagedFirst.size).toBe(1);
	});

	it('upserts and removes committed artifacts with put', () => {
		const set = setOf([nav('n1', 'One'), nav('n2', 'Two')]);
		set.put(readArtifacts([nav('n1', 'One again', { v: 2 })]), ['n2', 'ghost']);
		expect(set.resolve('n1')).toEqual({
			id: 'n1',
			kind: 'navigation',
			name: 'One again',
			payload: { v: 2 }
		});
		expect(set.resolve('n2')).toBeNull();
		expect(set.size).toBe(1);
	});

	it('replaces the whole committed layer with setCommitted', () => {
		const set = setOf([nav('n1', 'One')]);
		set.setCommitted(readArtifacts([nav('n2', 'Two')]));
		expect(set.resolve('n1')).toBeNull();
		expect(set.resolve('n2')?.name).toBe('Two');
	});

	it('resolves a staged artifact that names another staged one, and hides a staged delete', () => {
		const set = setOf(
			[nav('n1', 'One')],
			[
				{
					op: 'create',
					id: 'tmp_a',
					kind: 'navigation',
					name: 'A',
					payload: { kind: 'set_op', op: 'union', operands: [{ ref: 'tmp_b' }, { ref: 'n1' }] }
				},
				{ op: 'create', id: 'tmp_b', kind: 'navigation', name: 'B', payload: { kind: 'path' } },
				{ op: 'delete', id: 'n1' }
			]
		);
		const a = set.resolve('tmp_a');
		expect(a?.payload).toEqual({
			kind: 'set_op',
			op: 'union',
			operands: [{ ref: 'tmp_b' }, { ref: 'n1' }]
		});
		expect(set.resolve('tmp_b')).toEqual({
			id: 'tmp_b',
			kind: 'navigation',
			name: 'B',
			payload: { kind: 'path' }
		});
		expect(set.resolve('n1')).toBeNull();
	});
});

describe('reading artifacts', () => {
	it('reads payload numbers as the server would: 1 an int, 1.5 a float', () => {
		const set = setOf([nav('n1', 'One', { int: 1, float: 1.5, list: [2, 2.5] })]);
		const payload = set.resolve('n1')!.payload as { [key: string]: unknown };
		expect(payload['int']).toBe(1);
		expect(payload['float']).toEqual(new PyFloat(1.5));
		expect(payload['float']).toBeInstanceOf(PyFloat);
		expect(payload['list']).toEqual([2, new PyFloat(2.5)]);
		const [entry] = readStagedArtifacts([{ op: 'update', id: 'n1', payload: { x: 1, y: 0.5 } }]);
		expect(entry).toEqual({ op: 'update', id: 'n1', payload: { x: 1, y: new PyFloat(0.5) } });
	});

	it('holds copies: mutating what was handed in changes nothing resolved', () => {
		const payload = { steps: [{ kind: 'relationship' }] };
		const artifact = nav('n1', 'One', payload);
		const list = readArtifacts([artifact]);
		const set = new ArtifactSet();
		set.setCommitted(list);
		payload.steps.push({ kind: 'filter' });
		artifact.name = 'Changed';
		list[0]!.name = 'Changed too';
		list.length = 0;
		expect(set.resolve('n1')).toEqual({
			id: 'n1',
			kind: 'navigation',
			name: 'One',
			payload: { steps: [{ kind: 'relationship' }] }
		});

		const stagedPayload = { v: 1 };
		const entries = [
			{ op: 'create', id: 'tmp_x', kind: 'table', name: 'X', payload: stagedPayload }
		];
		set.setStaged(readStagedArtifacts(entries));
		stagedPayload.v = 2;
		entries.length = 0;
		expect(set.resolve('tmp_x')?.payload).toEqual({ v: 1 });
	});

	it('drops keys the entries do not use, and optional fields left undefined', () => {
		expect(
			readArtifacts([
				{ ...nav('n1', 'One'), updated_at: '2026-09-24T00:00:00Z', entry_points: null }
			])
		).toEqual([{ id: 'n1', kind: 'navigation', name: 'One', rev: 1, payload: {} }]);
		expect(
			readStagedArtifacts([{ op: 'update', id: 'n1', name: undefined, payload: undefined }])
		).toEqual([{ op: 'update', id: 'n1' }]);
	});

	it('refuses a malformed committed artifact with 422 in its own words', () => {
		const good = nav('n1', 'One');
		const cases: [unknown, string][] = [
			[null, 'artifacts: must be a list'],
			[{ n1: good }, 'artifacts: must be a list'],
			[[good, 'n2'], 'artifacts[1]: must be an object'],
			[[{ ...good, id: 7 }], 'artifacts[0].id: must be a string'],
			[[{ ...good, kind: null }], 'artifacts[0].kind: must be a string'],
			[[{ ...good, name: undefined }], 'artifacts[0].name: must be a string'],
			[[{ ...good, artifact_rev: 1.5 }], 'artifacts[0].artifact_rev: must be an integer'],
			[[{ ...good, artifact_rev: '1' }], 'artifacts[0].artifact_rev: must be an integer'],
			[[{ ...good, payload: [] }], 'artifacts[0].payload: must be an object'],
			[[{ ...good, payload: undefined }], 'artifacts[0].payload: must be an object']
		];
		for (const [raw, detail] of cases) {
			expect(refusal(() => readArtifacts(raw))).toEqual({ status: 422, detail });
		}
		expect(refusal(() => readArtifacts([{ ...good, payload: { big: 1n } }]))).toMatchObject({
			status: 422,
			detail: expect.stringMatching(/^artifacts: not JSON: /)
		});
	});

	it('refuses a malformed staged entry with 422 in its own words', () => {
		const cases: [unknown, string][] = [
			['all', 'entries: must be a list'],
			[[null], 'entries[0]: must be an object'],
			[[{ id: 'n1' }], 'entries[0].op: must be one of create, update, delete'],
			[[{ op: 'rename', id: 'n1' }], 'entries[0].op: must be one of create, update, delete'],
			[[{ op: 'delete' }], 'entries[0].id: must be a string'],
			[
				[{ op: 'create', id: 'tmp_x', name: 'X', payload: {} }],
				'entries[0].kind: must be a string'
			],
			[
				[{ op: 'create', id: 'tmp_x', kind: 'table', name: 'X' }],
				'entries[0].payload: must be an object'
			],
			[[{ op: 'update', id: 'n1', name: null }], 'entries[0].name: must be a string'],
			[[{ op: 'update', id: 'n1', payload: 'x' }], 'entries[0].payload: must be an object']
		];
		for (const [raw, detail] of cases) {
			expect(refusal(() => readStagedArtifacts(raw))).toEqual({ status: 422, detail });
		}
	});

	it('refuses a whole list for one bad entry, leaving the set as it was', () => {
		const set = setOf([nav('n1', 'One')], [{ op: 'update', id: 'n1', name: 'Staged' }]);
		expect(
			refusal(() =>
				set.setCommitted(readArtifacts([nav('n2', 'Two'), { ...nav('n3', 'Three'), id: 3 }]))
			)
		).toMatchObject({ status: 422 });
		expect(
			refusal(() =>
				set.setStaged(
					readStagedArtifacts([
						{ op: 'delete', id: 'n1' },
						{ op: 'delete', id: 1 }
					])
				)
			)
		).toMatchObject({ status: 422 });
		expect(set.resolve('n1')?.name).toBe('Staged');
		expect(set.resolve('n2')).toBeNull();
		expect(set.size).toBe(1);
	});
});
