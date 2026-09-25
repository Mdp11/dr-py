import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	ArtifactSet,
	drain,
	evaluateTable,
	Metamodel,
	Model,
	ViewPlacements,
	type CommittedArtifact,
	type Props,
	type StagedArtifact,
	type TablePageBody
} from '../../src/index.ts';
import { loadFixture, untag } from '../golden/load.ts';
import { parseOps, type Step, type StepsFixture } from '../golden/model-steps.ts';
import { nodeMetamodel, NODE_DOC } from '../model/fixtures.ts';
import {
	autoHost,
	connect,
	fakeHost,
	openReplica,
	refusal,
	settle,
	type Client
} from './helpers.ts';

type Event = Client['events'][number];

/** Resolves once the background digest check and the sweep of the ready replica have ended. */
async function idle(client: Client): Promise<void> {
	const ended = (task: string) => (event: Event) =>
		event.event === 'progress' && event.task === task && event.done === event.total;
	for (;;) {
		if (client.events.some(ended('verify')) && client.events.some(ended('sweep'))) break;
		await settle();
	}
	await client.call('staged');
}

// -- the fixture ----------------------------------------------------------------

const fixture = loadFixture<StepsFixture>('table_eval');

/** The fixture's model at its last step: its batches, landed with the oracle's ids, and what it inserts. */
function fixtureModel(): Model {
	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	let minted = 0;
	for (const step of fixture.steps) {
		if (step.do === 'batch') {
			applyBatch(model, parseOps(step.ops!), { idFor: () => `id-${++minted}` });
		} else if (step.do === 'insert_element') {
			model.insertElement(step.id!, step.type!, untag(step.value!) as Props, step.rev!);
		}
	}
	return model;
}

const fixtureArtifacts = Object.entries(
	fixture.steps.find((s) => s.do === 'artifacts')!.artifacts!
).map(([id, { kind, payload }]) => ({
	id,
	kind,
	name: id,
	artifact_rev: 1,
	payload: untag(payload)
}));

/** The reads of the fixture recorded after its last batch, and those of saved tables. */
const lastBatch = fixture.steps.findLastIndex((s) => s.do === 'batch');
const reads = fixture.steps.filter(
	(s: Step, i) =>
		s.do === 'read' &&
		s.error === null &&
		(i > lastBatch || typeof s.params?.['artifact_id'] === 'string')
);

// -- a ring of nodes ------------------------------------------------------------

const COUNT = 3_000;

/** `n0` … refers to the next, the last to the first; names sort otherwise than ids. */
function ring(): Model {
	const model = new Model(nodeMetamodel());
	for (let i = 0; i < COUNT; i++) {
		model.setProperty(model.createElement('Node', `n${i}`), 'name', `node ${(i * 7) % COUNT}`);
	}
	for (let i = 0; i < COUNT; i++) model.connect('Refers', `n${i}`, `n${(i + 1) % COUNT}`, `r${i}`);
	return model;
}

const hop = (direction: 'out' | 'in') => ({
	kind: 'path',
	start: { kind: 'row' },
	steps: [{ kind: 'relationship', relationship_type: 'Refers', direction }]
});

/** Nodes and where each refers through the saved navigation `nv`, sorted by the latter. */
const TABLE = {
	row_source: { kind: 'scope', types: ['Node'] },
	columns: [{ kind: 'element' }, { kind: 'navigation', navigation: { ref: 'nv' } }],
	sort: [{ column: 1 }]
};

const committed = [
	{ id: 't', kind: 'table', name: 'T', artifact_rev: 1, payload: TABLE },
	{ id: 'nv', kind: 'navigation', name: 'Out', artifact_rev: 1, payload: hop('out') }
];
const turned = { op: 'update', id: 'nv', payload: hop('in') };

const PARAMS = { artifact_id: 't', limit: 5 };

/** What the table answers over the ring, its navigation as committed or turned. */
function expected(staged: readonly object[]): string {
	const set = new ArtifactSet();
	set.setCommitted(
		committed.map((a) => ({ ...a, rev: 1, payload: a.payload as CommittedArtifact['payload'] }))
	);
	set.setStaged(staged as StagedArtifact[]);
	const ctx = { model: ring(), artifacts: set, placements: new ViewPlacements() };
	return JSON.stringify(drain(evaluateTable(ctx, PARAMS)));
}

/** A ready replica of the ring on a host whose turns the test ends, the scan paused past its first slice. */
async function paused() {
	const host = fakeHost({ tick: 3 });
	host.auto = true;
	const client = connect(host);
	await openReplica(client, ring(), NODE_DOC);
	await idle(client);
	await client.call('setArtifacts', { artifacts: committed });
	await settle();
	host.auto = false;
	return { host, client };
}

describe('evaluateTable over the service', () => {
	it("answers the fixture's bodies", async () => {
		const client = connect(autoHost());
		await openReplica(client, fixtureModel(), fixture.metamodel);
		await client.call('setArtifacts', { artifacts: fixtureArtifacts });
		expect(reads.length).toBeGreaterThan(3);
		for (const step of reads) {
			const body = await client.call<TablePageBody>('evaluateTable', step.params!);
			expect(JSON.stringify(body), JSON.stringify(step.params)).toBe(JSON.stringify(step.result));
		}
	});

	it('answers a scan from the artifacts it started with, and the next call from those staged meanwhile', async () => {
		const before = expected([]);
		const after = expected([turned]);
		expect(after).not.toBe(before);
		const { host, client } = await paused();

		const answer = client.call<TablePageBody>('evaluateTable', PARAMS);
		await settle();
		// Mid-scan: the pump waits for the host.
		expect(host.waiting).toBe(1);
		await client.call('setStagedArtifacts', { entries: [turned] });
		expect(host.waiting).toBe(1);
		host.auto = true;
		host.turn();
		expect(JSON.stringify(await answer)).toBe(before);

		expect(JSON.stringify(await client.call('evaluateTable', PARAMS))).toBe(after);
		expect(JSON.stringify(await client.call('evaluateTable', { ...PARAMS, offset: 0 }))).toBe(
			after
		);
		await client.call('setStagedArtifacts', { entries: [] });
		expect(JSON.stringify(await client.call('evaluateTable', PARAMS))).toBe(before);
	});

	it('never answers a cancelled scan, and answers a later call', async () => {
		const { host, client } = await paused();
		let answered = false;
		void client.callAs('scan', 'evaluateTable', PARAMS).then(() => (answered = true));
		await settle();
		expect(host.waiting).toBe(1);
		client.cancel('scan');
		const next = client.call<TablePageBody>('evaluateTable', PARAMS);
		host.auto = true;
		host.turn();
		expect(JSON.stringify(await next)).toBe(expected([]));
		await settle();
		expect(answered).toBe(false);
	});

	it('holds a call posted before ready, and answers it from the ready replica', async () => {
		const client = connect(autoHost());
		await client.call('setArtifacts', { artifacts: committed });
		let answered = false;
		const early = client.call<TablePageBody>('evaluateTable', PARAMS).then((body) => {
			answered = true;
			return body;
		});
		await settle();
		expect(answered).toBe(false);
		await openReplica(client, ring(), NODE_DOC);
		expect(JSON.stringify(await early)).toBe(expected([]));
	});

	it('answers model_rev as the committed rev, and a refusal in its own words', async () => {
		const client = connect(autoHost());
		await openReplica(client, ring(), NODE_DOC, { rev: 7 });
		await client.call('setArtifacts', { artifacts: committed });
		const body = await client.call<TablePageBody>('evaluateTable', PARAMS);
		expect(body.model_rev).toBe(7);
		expect(await refusal(client.call('evaluateTable', { artifact_id: 'gone' }))).toEqual({
			status: 422,
			detail: 'unknown artifact gone'
		});
	});

	it('forgets its orders when the replica closes: a new one at the same stamps answers its own model', async () => {
		const client = connect(autoHost());
		await openReplica(client, ring(), NODE_DOC);
		await client.call('setArtifacts', { artifacts: committed });
		expect(JSON.stringify(await client.call('evaluateTable', PARAMS))).toBe(expected([]));
		const other = ring();
		// Its row, n1499's, sorts first: the first page moves.
		other.setProperty(other.getElement('n1500'), 'name', 'aaa');
		await client.call('close');
		await openReplica(client, other, NODE_DOC);
		const body = await client.call<TablePageBody>('evaluateTable', PARAMS);
		const ctx = {
			model: other,
			artifacts: (() => {
				const set = new ArtifactSet();
				set.setCommitted(
					committed.map((a) => ({
						...a,
						rev: 1,
						payload: a.payload as CommittedArtifact['payload']
					}))
				);
				return set;
			})(),
			placements: new ViewPlacements()
		};
		const own = JSON.stringify(drain(evaluateTable(ctx, PARAMS)));
		expect(own).not.toBe(expected([]));
		expect(JSON.stringify(body)).toBe(own);
	});
});
