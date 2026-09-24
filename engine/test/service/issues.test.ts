import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	Metamodel,
	Model,
	type IssueListBody,
	type IssueOut,
	type MetamodelDoc,
	type ModelOp,
	type PreviewBody,
	type Props
} from '../../src/index.ts';
import { loadFixture, untag } from '../golden/load.ts';
import { parseOps, type StepsFixture } from '../golden/model-steps.ts';
import {
	autoHost,
	connect,
	fakeHost,
	openReplica,
	refusal,
	settle,
	smartCity,
	type Client
} from './helpers.ts';

const fixture = loadFixture<StepsFixture>('validation_steps');
const DOC = fixture.metamodel;

/** The `validation_steps` model as its `seed` step sweeps it: the first batch, then `g-1` of an unknown type. */
function seeded(): Model {
	const model = new Model(Metamodel.fromJSON(DOC));
	applyBatch(model, parseOps(fixture.steps[0]!.ops!));
	const insert = fixture.steps[1]!;
	model.insertElement(insert.id!, insert.type!, untag(insert.value!) as Props, insert.rev!);
	return model;
}

/** `count` elements of type `Blk`, named apart, each above its `n` facet's max. */
function blocks(count: number, doc: MetamodelDoc = DOC): Model {
	const model = new Model(Metamodel.fromJSON(doc));
	for (let i = 0; i < count; i++) {
		const element = model.createElement('Blk', `k-${i}`);
		model.setProperty(element, 'name', `k-${i}`);
		model.setProperty(element, 'req', 'x');
		model.setProperty(element, 'n', 9);
	}
	return model;
}

const setN = (id: string, n: number): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { n }
});

type Event = Client['events'][number];

const isSweep = (event: Event) => event.event === 'progress' && event.task === 'sweep';
const isSwept = (event: Event) => isSweep(event) && event.done === event.total;
const isVerify = (event: Event) => event.event === 'progress' && event.task === 'verify';

/** A `changed` with nothing in it: the sweep's own. */
const isBare = (event: Event) =>
	event.event === 'changed' &&
	event.structural === false &&
	(
		['element_ids', 'relationship_ids', 'deleted_element_ids', 'deleted_relationship_ids'] as const
	).every((key) => (event[key] as unknown[]).length === 0);

/** Resolves once some event from `from` on passes `match`. */
async function until(client: Client, match: (event: Event) => boolean, from = 0): Promise<Event> {
	for (;;) {
		const found = client.events.slice(from).find(match);
		if (found !== undefined) return found;
		await settle();
	}
}

/** The last `issues_version` a `changed` carried, 0 before any. */
const issuesVersion = (client: Client) =>
	(client.eventsOf('changed').at(-1)?.['issues_version'] as number | undefined) ?? 0;

async function swept(model = seeded(), doc: MetamodelDoc = DOC, client = connect()) {
	await openReplica(client, model, doc);
	await until(client, isSwept);
	await client.call('staged');
	return client;
}

const issue = (message: string, targetIds: string[], origin: IssueOut['origin']) => ({
	severity: 'error',
	message,
	target_ids: targetIds,
	category: 'conformance',
	check: 'facets',
	origin
});

describe('the sweep', () => {
	it('reports from done 0 to done === total, and getModelIssues then answers the oracle', async () => {
		const model = seeded();
		const client = await swept(model);
		const total = model.elementCount + model.relationshipCount;
		const sweeps = client.events.filter(isSweep);
		expect(sweeps[0]).toEqual({ event: 'progress', task: 'sweep', done: 0, total });
		expect(sweeps.at(-1)).toEqual({ event: 'progress', task: 'sweep', done: total, total });
		const body = await client.call<IssueListBody>('getModelIssues');
		expect(JSON.stringify(body)).toBe(JSON.stringify(fixture.steps[3]!.result));
	});

	it('posts a bare changed at most once a slice while it moves the store', async () => {
		const base = autoHost(1);
		// The events delivered by the time each host turn ends a slice.
		const marks: number[] = [];
		const host = {
			...base,
			deps: {
				...base.deps,
				yieldToHost: () =>
					base.deps.yieldToHost().then(() => {
						marks.push(client.events.length);
					})
			}
		};
		const client: Client = connect(host);
		const model = blocks(4000);
		await swept(model, DOC, client);
		const bare = client.events.flatMap((event, i) => (isBare(event) ? [i] : []));
		expect(bare.length).toBeGreaterThan(0);
		// Eight steps moved the store, over fewer slices.
		expect(bare.length).toBeLessThan(8);
		const bounds = [0, ...marks, client.events.length];
		for (let i = 1; i < bounds.length; i++) {
			const inSlice = bare.filter((at) => at >= bounds[i - 1]! && at < bounds[i]!);
			expect(inSlice.length).toBeLessThanOrEqual(1);
		}
		const versions = bare.map((at) => client.events[at]!['issues_version'] as number);
		expect(versions).toEqual([...new Set(versions)].sort((a, b) => a - b));
		expect(client.events[bare.at(-1)!]).toMatchObject({ rev: 0, staged_version: 0 });
		const body = await client.call<IssueListBody>('getModelIssues');
		expect(body.counts).toEqual({ error: 4000 });
	});
});

describe('getModelIssues', () => {
	it("follows a stage: a changed with a new issues_version before the answer, the issue 'uncommitted'", async () => {
		const client = await swept();
		const version = issuesVersion(client);
		const from = client.events.length;
		const at = await client
			.call('stage', { ops: [setN('b-1', 9)] })
			.then(() => client.events.length);
		const changed = client.events.slice(from, at).filter((event) => event.event === 'changed');
		expect(changed).toHaveLength(1);
		expect(changed[0]).toMatchObject({ element_ids: ['b-1'], staged_version: 1 });
		expect(changed[0]!['issues_version']).toBeGreaterThan(version);
		const body = await client.call<IssueListBody>('getModelIssues');
		expect(body.issues).toContainEqual(issue('n: 9 above max 5.0', ['b-1'], 'uncommitted'));
		expect(body.issues).toContainEqual(issue('n: 9 above max 5.0', ['b-2'], 'on_server'));
		expect([body.model_rev, body.counts]).toEqual([0, { error: 4 }]);
	});

	it('restarts a digest check in flight when it probes, and the check still ends true', async () => {
		const host = fakeHost({ tick: 10 });
		host.auto = true;
		const client = connect(host);
		await openReplica(client, blocks(30_000), DOC);
		const from = client.events.length;
		await client.call('stage', { ops: [setN('k-7', 1)] });
		// The check is under way.
		await until(client, (event) => isVerify(event) && (event.done as number) > 0, from);
		const probing = client.events.length;
		// Answered from a store the sweep has not filled yet: a direct call may read it.
		expect((await client.call<IssueListBody>('getModelIssues')).model_rev).toBe(0);
		await until(client, (event) => isVerify(event) && event.done === 0, probing);
		await until(client, (event) => isVerify(event) && event.done === event.total, probing);
		const states = client.events.filter((event) => event.event === 'replica');
		expect(states.map((event) => event['state'])).toEqual(['opening', 'ready']);
	});

	it('waits behind a running scan, and is never answered at its slice boundary', async () => {
		const host = fakeHost({ tick: 3 });
		host.auto = true;
		const client = connect(host);
		const { model, doc } = smartCity();
		await swept(model, doc, client);
		await until(client, (event) => isVerify(event) && event.done === event.total);
		await settle();
		host.auto = false;
		const order: string[] = [];
		const search = client
			.call('listElementsPage', { q: 'organization', limit: 500 })
			.then(() => order.push('search'));
		await settle();
		expect(host.waiting).toBe(1);
		const read = client.call('getElement', { id: 'e_000002' }).then(() => order.push('read'));
		const issues = client.call('getModelIssues').then(() => order.push('issues'));
		const late = client.call('getElement', { id: 'e_000001' }).then(() => order.push('late'));
		host.auto = true;
		host.turn();
		await Promise.all([search, read, issues, late]);
		expect(order).toEqual(['read', 'search', 'issues', 'late']);
	});
});

describe('validateModel', () => {
	it('answers after a sweep it restarts, from the staged batches it names', async () => {
		const client = await swept();
		await client.call('stage', { ops: [setN('b-1', 9)] });
		const from = client.events.length;
		const [body, at] = await client
			.call<IssueOut[]>('validateModel', { batch_ids: [1] })
			.then((out) => [out, client.events.length] as const);
		const sweeps = client.events.slice(from, at).filter(isSweep);
		expect(sweeps[0]).toMatchObject({ done: 0 });
		expect(sweeps.at(-1)!['done']).toBe(sweeps.at(-1)!['total']);
		expect(body).toHaveLength(4);
		expect(body).toContainEqual(issue('n: 9 above max 5.0', ['b-1'], 'uncommitted'));
		expect(body).toContainEqual(issue('n: 9 above max 5.0', ['b-2'], 'on_server'));
	});

	it("refuses batch ids that are not the staged ones with 409 'stale staged batches'", async () => {
		const client = await swept();
		await client.call('stage', { ops: [setN('b-1', 9)] });
		for (const batchIds of [[], [2], [1, 2]]) {
			expect(await refusal(client.call('validateModel', { batch_ids: batchIds }))).toEqual({
				status: 409,
				detail: 'stale staged batches'
			});
		}
		expect(await refusal(client.call('validateModel', { batch_ids: ['1'] }))).toEqual({
			status: 422,
			detail: 'batch_ids must be a list of batch ids'
		});
	});

	it("answers 409 'replica is not ready' when the replica closes before the sweep ends", async () => {
		const client = await swept(blocks(20_000));
		const from = client.events.length;
		const validating = refusal(client.call('validateModel', { batch_ids: [] }));
		await until(client, (event) => isSweep(event) && event.done === 0, from);
		await client.call('close');
		expect(await validating).toEqual({ status: 409, detail: 'replica is not ready' });
	});
});

describe('previewCommit', () => {
	it('answers the model half over the staged batches', async () => {
		const client = await swept();
		await client.call('stage', { ops: [setN('b-1', 9)] });
		const params = { base_rev: 0, batch_ids: [1] };
		expect(await client.call<PreviewBody>('previewCommit', { ...params, strict: true })).toEqual({
			conformance_error_count: 1,
			structural_blockers: [],
			issues: [issue('n: 9 above max 5.0', ['b-1'], 'on_server')],
			would_block: true
		});
		const lenient = await client.call<PreviewBody>('previewCommit', { ...params, strict: false });
		expect(lenient.would_block).toBe(false);
	});

	it("refuses a stale base_rev with 409 'stale base_rev', and stale batches", async () => {
		const client = await swept();
		await client.call('stage', { ops: [setN('b-1', 9)] });
		expect(
			await refusal(client.call('previewCommit', { base_rev: 1, batch_ids: [1], strict: false }))
		).toEqual({ status: 409, detail: 'stale base_rev' });
		expect(
			await refusal(client.call('previewCommit', { base_rev: 0, batch_ids: [], strict: false }))
		).toEqual({ status: 409, detail: 'stale staged batches' });
		expect(
			await refusal(client.call('previewCommit', { base_rev: 0, batch_ids: [1], strict: 'no' }))
		).toEqual({ status: 422, detail: 'strict must be a boolean' });
	});
});

describe('what the engine refuses', () => {
	const calls = [
		['getModelIssues', {}],
		['validateModel', { batch_ids: [] }],
		['previewCommit', { base_rev: 0, batch_ids: [], strict: true }]
	] as const;

	it('answers 501 to all three over a facet pattern it cannot run', async () => {
		const doc = structuredClone(DOC);
		const blk = doc.elements.find((type) => type.name === 'Blk')!;
		blk.properties.find((property) => property.name === 'code')!.pattern = '(?x)a';
		const client = connect();
		await openReplica(client, blocks(3, doc), doc);
		for (const [method, params] of calls) {
			expect(await refusal(client.call(method, params))).toEqual({
				status: 501,
				detail: 'reaches an unsupported pattern'
			});
		}
		expect(client.events.filter(isSweep)).toEqual([]);
	});

	it('answers 501 to all three while a validation_rules artifact resolves', async () => {
		const client = await swept();
		const rules = {
			id: 'r-1',
			kind: 'validation_rules',
			name: 'Rules',
			artifact_rev: 1,
			payload: { text: '' }
		};
		await client.call('setArtifacts', { artifacts: [rules] });
		for (const [method, params] of calls) {
			expect(await refusal(client.call(method, params))).toEqual({
				status: 501,
				detail: 'reaches validation rules'
			});
		}
		await client.call('setStagedArtifacts', { entries: [{ op: 'delete', id: 'r-1' }] });
		expect((await client.call<IssueListBody>('getModelIssues')).counts).toEqual({ error: 3 });
		await client.call('setStagedArtifacts', {
			entries: [{ op: 'create', id: 'tmp_r', kind: 'validation_rules', name: 'R', payload: {} }]
		});
		expect(await refusal(client.call('getModelIssues'))).toEqual({
			status: 501,
			detail: 'reaches validation rules'
		});
	});

	it('posts a bare changed with a moved issues_version whenever the rules start or stop resolving', async () => {
		const client = await swept();
		const rules = {
			id: 'r-1',
			kind: 'validation_rules',
			name: 'Rules',
			artifact_rev: 1,
			payload: { text: '' }
		};
		const other = { id: 'q-1', kind: 'query', name: 'Q', artifact_rev: 1, payload: {} };
		const seen: number[] = [issuesVersion(client)];
		/** Runs `method`, and the bare `changed` events it posted. */
		const bare = async (method: string, params: object) => {
			const from = client.events.length;
			await client.call(method, params);
			const posted = client.events.slice(from).filter(isBare);
			for (const event of posted) seen.push(event['issues_version'] as number);
			return posted;
		};
		// Nothing flips: no rules before, none after.
		expect(await bare('setArtifacts', { artifacts: [other] })).toEqual([]);
		expect(await bare('putArtifacts', { changed: [rules], deleted_ids: [] })).toHaveLength(1);
		expect(await bare('putArtifacts', { changed: [other], deleted_ids: [] })).toEqual([]);
		expect(
			await bare('setStagedArtifacts', { entries: [{ op: 'delete', id: 'r-1' }] })
		).toHaveLength(1);
		expect(
			await bare('setStagedArtifacts', { entries: [{ op: 'delete', id: 'q-1' }] })
		).toHaveLength(1);
		expect(await bare('setArtifacts', { artifacts: [other] })).toHaveLength(1);
		expect(
			await bare('putArtifacts', {
				changed: [],
				deleted_ids: [],
				staged: [{ op: 'create', id: 'tmp_r', kind: 'validation_rules', name: 'R', payload: {} }]
			})
		).toHaveLength(1);
		expect(await bare('setArtifacts', { artifacts: [] })).toEqual([]);
		expect(await bare('setStagedArtifacts', { entries: [] })).toHaveLength(1);
		expect(seen).toEqual([...new Set(seen)].sort((a, b) => a - b));
		expect(seen).toHaveLength(7);
		expect((await client.call<IssueListBody>('getModelIssues')).counts).toEqual({ error: 3 });
	});
});
