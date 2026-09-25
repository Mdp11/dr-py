import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	PyFloat,
	type CommittedArtifact,
	type StagedArtifact
} from '../../src/index.ts';
import { family, NODE_DOC } from '../model/fixtures.ts';
import {
	connect,
	gzChunks,
	openReplica,
	settle,
	snapshotText,
	tailText,
	type Client
} from './helpers.ts';

type Event = Client['events'][number];

const committed = (
	id: string,
	kind: string,
	payload: CommittedArtifact['payload'] = {},
	extra: Partial<CommittedArtifact> = {}
): CommittedArtifact => ({ id, kind, name: id, rev: 1, payload, ...extra });

describe('ArtifactSet.version', () => {
	it('moves when a layer comes to hold other entries, and not when it is handed the same again', () => {
		const set = new ArtifactSet();
		expect(set.version).toBe(0);
		const moves = (change: () => void): boolean => {
			const before = set.version;
			change();
			return set.version !== before;
		};
		const t = () => committed('t', 'table', { columns: [1, new PyFloat(2)], n: 2n ** 64n });
		expect(moves(() => set.setCommitted([]))).toBe(false);
		expect(moves(() => set.setCommitted([t(), committed('n', 'navigation')]))).toBe(true);
		expect(moves(() => set.setCommitted([t(), committed('n', 'navigation')]))).toBe(false);
		expect(moves(() => set.setCommitted([committed('n', 'navigation'), t()]))).toBe(true);
		expect(moves(() => set.setCommitted([committed('n', 'navigation'), t()]))).toBe(false);

		// Exact values: 2 and 2.0, 0.0 and -0.0 differ.
		const float = (value: number | PyFloat) => committed('t', 'table', { v: value });
		expect(moves(() => set.put([float(new PyFloat(2))], []))).toBe(true);
		expect(moves(() => set.put([float(new PyFloat(2))], []))).toBe(false);
		expect(moves(() => set.put([float(2)], []))).toBe(true);
		expect(moves(() => set.put([float(new PyFloat(0))], []))).toBe(true);
		expect(moves(() => set.put([float(new PyFloat(-0))], []))).toBe(true);
		expect(
			moves(() => set.put([committed('t', 'table', { v: new PyFloat(-0) }, { rev: 2 })], []))
		).toBe(true);
		expect(
			moves(() => set.put([committed('t', 'table', { v: new PyFloat(-0) }, { name: 'T' })], []))
		).toBe(true);
		expect(moves(() => set.put([], ['absent']))).toBe(false);
		expect(moves(() => set.put([], ['n']))).toBe(true);
		const parse = { ok: true as const, document: '{"rules":[]}' };
		expect(
			moves(() => set.put([committed('r', 'validation_rules', {}, { rules: parse })], []))
		).toBe(true);
		expect(
			moves(() => set.put([committed('r', 'validation_rules', {}, { rules: { ...parse } })], []))
		).toBe(false);

		const staged: StagedArtifact[] = [
			{ op: 'update', id: 't', payload: { v: [1, { k: null }] } },
			{ op: 'delete', id: 'r' }
		];
		expect(moves(() => set.setStaged([]))).toBe(false);
		expect(moves(() => set.setStaged(staged))).toBe(true);
		expect(moves(() => set.setStaged(structuredClone(staged)))).toBe(false);
		expect(moves(() => set.setStaged([{ op: 'update', id: 't', name: 'T' }, staged[1]!]))).toBe(
			true
		);
		expect(moves(() => set.setStaged([{ op: 'update', id: 't', name: 'T' }]))).toBe(true);
		expect(
			moves(() => set.setStaged([{ op: 'update', id: 't', name: 'T', rules: 'pending' }]))
		).toBe(true);
		expect(moves(() => set.setStaged([]))).toBe(true);
	});
});

// -- over the service -------------------------------------------------------------

const wire = (id: string, kind: string, payload: object = {}, rules?: object) => ({
	id,
	kind,
	name: id,
	artifact_rev: 1,
	payload,
	...(rules === undefined ? {} : { rules })
});

const TABLE = { row_source: { kind: 'scope' }, columns: [{ kind: 'element' }] };
const NAVIGATION = { kind: 'path', start: { kind: 'row' }, steps: [] };
const RULES = {
	ok: true,
	document: JSON.stringify({
		rules: [{ name: 'named', applies_to: 'Node', then: { property: 'peer', exists: true } }]
	})
};

const isChanged = (event: Event) => event.event === 'changed';

async function ready(client = connect()): Promise<Client> {
	await openReplica(client, family(), NODE_DOC);
	for (;;) {
		const swept = client.events.some(
			(e) => e.event === 'progress' && e.task === 'sweep' && e.done === e.total
		);
		if (swept) break;
		await settle();
	}
	await client.call('staged');
	await settle();
	return client;
}

/** Runs `method`, and the `changed` events it posted. */
async function posted(client: Client, method: string, params: object): Promise<Event[]> {
	const from = client.events.length;
	await client.call(method, params);
	await settle();
	return client.events.slice(from).filter(isChanged);
}

const last = (client: Client) => client.eventsOf('changed').at(-1);

describe('artifacts_version on changed', () => {
	it('moves with every artifact move, issues_version with it only when the rule sets change', async () => {
		const client = await ready();
		let artifacts = (last(client)?.['artifacts_version'] as number | undefined) ?? 0;
		const issues = (last(client)?.['issues_version'] as number | undefined) ?? 0;
		const bare = {
			rev: 0,
			staged_version: 0,
			element_ids: [],
			relationship_ids: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			structural: false
		};
		/** One `changed` with `artifacts_version` moved and `issues_version` at `issuesNow`. */
		const once = async (method: string, params: object, issuesNow = issues) => {
			const events = await posted(client, method, params);
			expect(events, method).toHaveLength(1);
			const [event] = events;
			expect(event!['artifacts_version'], method).toBeGreaterThan(artifacts);
			artifacts = event!['artifacts_version'] as number;
			expect(event).toEqual({
				event: 'changed',
				...bare,
				issues_version: issuesNow,
				artifacts_version: artifacts
			});
			expect(Object.keys(event!)).toEqual([
				'event',
				'rev',
				'staged_version',
				'issues_version',
				'artifacts_version',
				...Object.keys(bare).slice(2)
			]);
		};

		await once('setArtifacts', { artifacts: [wire('t', 'table', TABLE)] });
		await once('putArtifacts', { changed: [wire('n', 'navigation', NAVIGATION)], deleted_ids: [] });
		await once('putArtifacts', {
			changed: [],
			deleted_ids: [],
			staged: [{ op: 'delete', id: 't' }]
		});
		const edited = { op: 'update', id: 't', payload: { ...TABLE, sort: [{ column: 0 }] } };
		await once('setStagedArtifacts', { entries: [edited] });
		expect(await posted(client, 'setStagedArtifacts', { entries: [edited] })).toEqual([]);
		expect(
			await posted(client, 'setArtifacts', {
				artifacts: [wire('t', 'table', TABLE), wire('n', 'navigation', NAVIGATION)]
			})
		).toEqual([]);
		expect(await posted(client, 'putArtifacts', { changed: [], deleted_ids: ['absent'] })).toEqual(
			[]
		);
		await once('setStagedArtifacts', { entries: [] });

		// A rule set moves both, in one post.
		const events = await posted(client, 'putArtifacts', {
			changed: [wire('r', 'validation_rules', { schema_version: 1, yaml: '' }, RULES)],
			deleted_ids: []
		});
		const moved = events.filter((e) => (e['issues_version'] as number) > issues);
		expect(moved.length).toBeGreaterThan(0);
		expect(events[0]!['artifacts_version']).toBeGreaterThan(artifacts);
		expect(events[0]!['issues_version']).toBeGreaterThan(issues);
		artifacts = events[0]!['artifacts_version'] as number;

		// A transition carries it as it stands.
		const staging = await posted(client, 'stage', {
			ops: [{ kind: 'update_element', id: 'a', properties_patch: { name: 'x' } }]
		});
		expect(staging[0]).toMatchObject({ staged_version: 1, artifacts_version: artifacts });
	});

	it('posts nothing before ready, and the first changed after carries the moves made meanwhile', async () => {
		const client = connect();
		await client.call('setArtifacts', { artifacts: [wire('t', 'table', TABLE)] });
		await client.call('open', { project_id: 'demo', metamodel: NODE_DOC });
		await client.call('setStagedArtifacts', {
			entries: [{ op: 'update', id: 't', payload: { ...TABLE, sort: [{ column: 0 }] } }]
		});
		// Read and indexed, the replica waits for its tail.
		await Promise.all(
			gzChunks(snapshotText(family()), 1 << 16).map((bytes) =>
				client.call('chunk', { bytes }, [bytes])
			)
		);
		await client.call('end');
		await client.call('putArtifacts', {
			changed: [wire('n', 'navigation', NAVIGATION)],
			deleted_ids: []
		});
		await settle();
		expect(client.eventsOf('changed')).toEqual([]);
		const ready = client.nextEvent((event) => event.event === 'replica' && event.state === 'ready');
		await client.call('applyTail', { text: tailText([]) });
		await ready;
		const events = await posted(client, 'stage', {
			ops: [{ kind: 'update_element', id: 'a', properties_patch: { name: 'x' } }]
		});
		expect(events[0]!['artifacts_version']).toBe(3);
	});
});
