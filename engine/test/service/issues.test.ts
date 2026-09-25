import { describe, expect, it, vi } from 'vitest';
import {
	applyBatch,
	Metamodel,
	Model,
	RulesValidator,
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

const fixture = loadFixture<{ runs: StepsFixture[] }>('validation_steps').runs[0]!;
const DOC = fixture.metamodel;

/** The `validation_steps` model as its `seed` step sweeps it: the first batch, then `g-1` of an unknown type. */
function seeded(doc: MetamodelDoc = DOC): Model {
	const model = new Model(Metamodel.fromJSON(doc));
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
});

// -- rules -------------------------------------------------------------------

type Rule = { name: string; applies_to: string; then: object; when?: object };

const FLAGGED: Rule = { name: 'flagged', applies_to: 'Blk', then: { property: 'b', exists: true } };
const CODED: Rule = { name: 'coded', applies_to: 'Blk', then: { property: 'code', exists: true } };
const COLOURED: Rule = {
	name: 'coloured',
	applies_to: 'Blk',
	then: { property: 'c', exists: true }
};
const DRIFTING: Rule = {
	name: 'drifting',
	applies_to: 'Blk',
	then: { property: 'nope', exists: true }
};
/** Holds on every `Car`: its rescan leaves the store as it was. */
const NAMED: Rule = { name: 'named', applies_to: 'Car', then: { property: 'name', exists: true } };

/** `POST /rules/parse`'s body for a set of `rules`. */
const parsed = (...rules: Rule[]) => ({ ok: true, document: JSON.stringify({ rules }) });

/** A document the engine's reader refuses: a key the grammar does not have. */
const UNREADABLE = { ok: true, document: '{"rules":[],"x":1}' };

/** A committed rule set; without `parse`, as an older shell sends it. */
const ruleSet = (id: string, name: string, parse?: object) => ({
	id,
	kind: 'validation_rules',
	name,
	artifact_rev: 1,
	payload: { schema_version: 1, yaml: '' },
	...(parse === undefined ? {} : { rules: parse })
});

const created = (id: string, name: string, rules: object | 'pending') => ({
	op: 'create',
	id,
	kind: 'validation_rules',
	name,
	payload: { schema_version: 1, yaml: 'staged' },
	rules
});

const updated = (id: string, rules: object | 'pending') => ({
	op: 'update',
	id,
	payload: { schema_version: 1, yaml: 'edited' },
	rules
});

const ruleIssue = (rule: string, id: string, origin: IssueOut['origin']) => ({
	severity: 'error',
	message: `Rule '${rule}' violated`,
	target_ids: [id],
	category: 'conformance',
	check: `rule:${rule}`,
	origin
});

const rulesOf = (issues: IssueOut[]) => issues.filter((i) => i.check.startsWith('rule:'));

const listed = (client: Client) => client.call<IssueListBody>('getModelIssues');

/** What `promise` settles to within `turns` host turns, else `'unanswered'`. */
async function within<T>(promise: Promise<T>, turns = 200): Promise<T | 'unanswered'> {
	let out: { value: T } | null = null;
	void promise.then((value) => (out = { value }));
	for (let turn = 0; turn < turns && out === null; turn++) await settle();
	return out === null ? 'unanswered' : (out as { value: T }).value;
}

/**
 * Makes every element a validator run reaches throw while `armed.on`: a bug
 * in a validator, which no model can trigger.
 */
function breaking() {
	const armed = { on: true };
	const original = RulesValidator.prototype.validateElement;
	const spy = vi.spyOn(RulesValidator.prototype, 'validateElement').mockImplementation(function (
		this: RulesValidator,
		...args: Parameters<RulesValidator['validateElement']>
	) {
		if (armed.on) throw new Error('a validator bug');
		return original.apply(this, args);
	});
	return { armed, restore: () => spy.mockRestore() };
}

/** A replica of `blocks(count)` swept with nothing left in the background, its host now turned by hand. */
async function paused(count: number, host = autoHost(1), rules: object[] = []) {
	const client = connect(host);
	if (rules.length > 0) await client.call('setArtifacts', { artifacts: rules });
	await swept(blocks(count), DOC, client);
	await until(client, (event) => isVerify(event) && event.done === event.total);
	await settle();
	await settle();
	host.auto = false;
	return client;
}

describe('rules', () => {
	const calls = [
		['getModelIssues', {}],
		['validateModel', { batch_ids: [] }],
		['previewCommit', { base_rev: 0, batch_ids: [], strict: true }]
	] as const;

	it('compiles the rule sets set before open with the store: the first read lists their issues', async () => {
		const client = connect();
		await client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED))] });
		await swept(seeded(), DOC, client);
		const body = await listed(client);
		expect(rulesOf(body.issues)).toEqual([
			ruleIssue('flagged', 'b-1', 'on_server'),
			ruleIssue('flagged', 'b-2', 'on_server')
		]);
		expect(body.counts).toEqual({ error: 5 });
		expect(body.rules_status).toEqual({ total: 1, skipped: [], eval_errors: {} });
	});

	it('answers a read posted with a rule set that lands after the sweep only after its rescan, which reports no progress', async () => {
		const client = await swept();
		const version = issuesVersion(client);
		const from = client.events.length;
		void client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED))] });
		const [body, at] = await listed(client).then((out) => [out, client.events.length] as const);
		expect(rulesOf(body.issues)).toEqual([
			ruleIssue('flagged', 'b-1', 'on_server'),
			ruleIssue('flagged', 'b-2', 'on_server')
		]);
		const between = client.events.slice(from, at);
		expect(between.filter(isBare).map((event) => event['issues_version'])).toContainEqual(
			version + 1
		);
		expect(between.filter(isSweep)).toEqual([]);
	});

	it("lists a staged rule set's issues 'uncommitted', and drops them with the entry", async () => {
		const client = await swept();
		await client.call('setStagedArtifacts', { entries: [created('tmp_r', 'R', parsed(FLAGGED))] });
		const body = await listed(client);
		expect(rulesOf(body.issues)).toEqual([
			ruleIssue('flagged', 'b-1', 'uncommitted'),
			ruleIssue('flagged', 'b-2', 'uncommitted')
		]);
		expect(body.issues).toContainEqual(issue('n: 9 above max 5.0', ['b-2'], 'on_server'));
		await client.call('setStagedArtifacts', { entries: [] });
		const after = await listed(client);
		expect(rulesOf(after.issues)).toEqual([]);
		expect([after.counts, after.rules_status.total]).toEqual([{ error: 3 }, 0]);
	});

	it("keeps the committed rules under a 'pending' update, and applies the parse the next push brings", async () => {
		const client = connect();
		await client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED))] });
		await swept(seeded(), DOC, client);
		await client.call('setStagedArtifacts', { entries: [updated('r-1', 'pending')] });
		expect(rulesOf((await listed(client)).issues)).toEqual([
			ruleIssue('flagged', 'b-1', 'on_server'),
			ruleIssue('flagged', 'b-2', 'on_server')
		]);
		await client.call('setStagedArtifacts', { entries: [updated('r-1', parsed(CODED))] });
		expect(rulesOf((await listed(client)).issues)).toEqual([
			ruleIssue('coded', 'b-1', 'uncommitted'),
			ruleIssue('coded', 'b-2', 'uncommitted')
		]);
	});

	it('names a staged rule the metamodel drifts in rules_status.skipped', async () => {
		const client = connect();
		await client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED))] });
		await swept(seeded(), DOC, client);
		await client.call('setStagedArtifacts', {
			entries: [updated('r-1', parsed(FLAGGED, DRIFTING))]
		});
		expect((await listed(client)).rules_status).toEqual({
			total: 1,
			skipped: [
				{
					artifact_id: 'r-1',
					set_name: 'Rules',
					rule: 'drifting',
					reason: "stereotype 'Blk' has no property 'nope'"
				}
			],
			eval_errors: {}
		});
	});

	it("reads a committed staged create 'on_server' under its real id, each issue once", async () => {
		const client = await swept();
		await client.call('setStagedArtifacts', { entries: [created('tmp_r', 'R', parsed(FLAGGED))] });
		expect(rulesOf((await listed(client)).issues).map((i) => i.origin)).toEqual([
			'uncommitted',
			'uncommitted'
		]);
		await client.call('putArtifacts', {
			changed: [ruleSet('r-9', 'R', parsed(FLAGGED))],
			deleted_ids: [],
			staged: []
		});
		const body = await listed(client);
		expect(rulesOf(body.issues)).toEqual([
			ruleIssue('flagged', 'b-1', 'on_server'),
			ruleIssue('flagged', 'b-2', 'on_server')
		]);
		expect(body.counts).toEqual({ error: 5 });
	});

	it('previews with the committed rules alone, a staged rule set aside', async () => {
		const client = connect();
		await client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(CODED))] });
		await swept(seeded(), DOC, client);
		await client.call('setStagedArtifacts', { entries: [created('tmp_r', 'R', parsed(FLAGGED))] });
		await client.call('stage', { ops: [setN('b-1', 9)] });
		expect(
			await client.call<PreviewBody>('previewCommit', { base_rev: 0, batch_ids: [1], strict: true })
		).toEqual({
			conformance_error_count: 2,
			structural_blockers: [],
			issues: [
				issue('n: 9 above max 5.0', ['b-1'], 'on_server'),
				ruleIssue('coded', 'b-1', 'on_server')
			],
			would_block: true
		});
	});

	it("answers 501 'reaches unreadable rules' to all three over a document it cannot read, committed or staged", async () => {
		const client = await swept();
		const refused = async () => {
			for (const [method, params] of calls) {
				expect(await refusal(client.call(method, params))).toEqual({
					status: 501,
					detail: 'reaches unreadable rules'
				});
			}
		};
		const answered = async () => {
			for (const [method, params] of calls) await client.call(method, params);
		};
		await client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', UNREADABLE)] });
		await refused();
		await client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED))] });
		await answered();
		await client.call('setStagedArtifacts', { entries: [created('tmp_r', 'R', UNREADABLE)] });
		await refused();
		await client.call('setStagedArtifacts', { entries: [] });
		await answered();
		expect(rulesOf((await listed(client)).issues)).toHaveLength(2);
	});

	it("answers 501 'reaches unreadable rules' over a rule set that arrived without its parse", async () => {
		const client = await swept();
		await client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules')] });
		expect(await refusal(listed(client))).toEqual({
			status: 501,
			detail: 'reaches unreadable rules'
		});
	});

	it('moves issues_version when the rule sets change, and not when a push leaves them as they were', async () => {
		const client = await swept();
		const other = { id: 'q-1', kind: 'query', name: 'Q', artifact_rev: 1, payload: {} };
		const seen: number[] = [issuesVersion(client)];
		/** Runs `method`, and the bare `changed` events it posted. */
		const bare = async (method: string, params: object) => {
			const from = client.events.length;
			await client.call(method, params);
			await settle();
			const posted = client.events.slice(from).filter(isBare);
			for (const event of posted) seen.push(event['issues_version'] as number);
			return posted;
		};
		const named = ruleSet('r-1', 'Rules', parsed(NAMED));
		const renamed = { op: 'update', id: 'r-1', name: 'Renamed' };
		expect(await bare('setArtifacts', { artifacts: [other] })).toEqual([]);
		expect(await bare('putArtifacts', { changed: [named], deleted_ids: [] })).toHaveLength(1);
		expect(await bare('putArtifacts', { changed: [named], deleted_ids: [] })).toEqual([]);
		expect(await bare('setStagedArtifacts', { entries: [renamed] })).toHaveLength(1);
		expect(await bare('setStagedArtifacts', { entries: [renamed] })).toEqual([]);
		expect(
			await bare('setStagedArtifacts', { entries: [renamed, { op: 'delete', id: 'q-1' }] })
		).toEqual([]);
		expect(await bare('setStagedArtifacts', { entries: [] })).toHaveLength(1);
		expect(seen).toEqual([...new Set(seen)].sort((a, b) => a - b));
		expect(seen).toHaveLength(4);
	});

	it('answers validateModel posted during a rescan after both the sweep it restarts and the rescan', async () => {
		const host = autoHost(1);
		const client = await paused(6000, host);
		void client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED))] });
		await settle();
		// Mid-rescan: the pump waits for the host.
		expect(host.waiting).toBe(1);
		const from = client.events.length;
		const validating = client
			.call<IssueOut[]>('validateModel', { batch_ids: [] })
			.then((out) => [out, client.events.length] as const);
		host.auto = true;
		host.turn();
		const [body, at] = await validating;
		expect(body.filter((i) => i.check === 'rule:flagged')).toHaveLength(6000);
		expect(body).toHaveLength(12000);
		const sweeps = client.events.slice(from, at).filter(isSweep);
		expect(sweeps[0]).toMatchObject({ done: 0 });
		expect(sweeps.at(-1)!['done']).toBe(sweeps.at(-1)!['total']);
	});

	it("answers 409 'replica is not ready' to a read waiting for a rescan when the replica closes", async () => {
		const host = autoHost(1);
		const client = await paused(6000, host);
		void client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED))] });
		const reading = refusal(listed(client));
		await settle();
		expect(host.waiting).toBe(1);
		await client.call('close');
		expect(await reading).toEqual({ status: 409, detail: 'replica is not ready' });
		host.auto = true;
		host.turn();
	});

	it('makes a read wait again when a second rescan starts after the first settled, before its answer', async () => {
		// Every unit of work is a slice of its own: each host turn runs one.
		const host = fakeHost({ tick: 10 });
		host.auto = true;
		const client = await paused(1000, host, [ruleSet('r-1', 'Rules', parsed(FLAGGED))]);
		void client.call('setStagedArtifacts', { entries: [updated('r-1', parsed(CODED))] });
		let answered = false;
		const reading = listed(client).then((out) => {
			answered = true;
			return out;
		});
		await settle();
		// The read's first transition ran: it waits for the rescan's two steps.
		expect(host.waiting).toBe(1);
		for (let step = 0; step < 2; step++) {
			host.turn();
			await settle();
		}
		// The rescan has settled; the read's answering transition is queued.
		expect(answered).toBe(false);
		void client.call('setStagedArtifacts', { entries: [updated('r-1', parsed(COLOURED))] });
		await settle();
		host.auto = true;
		host.turn();
		const body = await reading;
		expect(body.counts).toEqual({ error: 2000 });
		expect(new Set(rulesOf(body.issues).map((i) => `${i.check} ${i.origin}`))).toEqual(
			new Set(['rule:coloured uncommitted'])
		);
	});

	it("refuses 409 'replica is not ready' what waits for a rescan whose step throws, and a later read runs the step again", async () => {
		const client = await swept(blocks(1200));
		const broken = breaking();
		try {
			void client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED))] });
			const [reading, validating] = await Promise.all([
				refusal(listed(client)),
				refusal(client.call('validateModel', { batch_ids: [] }))
			]);
			// Nothing drives the rescan now: a later read sets it going again.
			const again = await within(refusal(listed(client)));
			const notReady = { status: 409, detail: 'replica is not ready' };
			expect({ reading, validating, again }).toEqual({
				reading: notReady,
				validating: notReady,
				again: notReady
			});
			broken.armed.on = false;
			const body = await listed(client);
			expect(rulesOf(body.issues)).toHaveLength(1200);
			expect(body.counts).toEqual({ error: 2400 });
		} finally {
			broken.restore();
		}
	});

	it('never answers a waiting read that was cancelled', async () => {
		const host = autoHost(1);
		const client = await paused(6000, host);
		void client.call('setArtifacts', { artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED))] });
		client.post({ id: 'waiting', method: 'getModelIssues', params: {} });
		await settle();
		expect(host.waiting).toBe(1);
		client.cancel('waiting');
		host.auto = true;
		host.turn();
		expect((await listed(client)).counts).toEqual({ error: 12000 });
		await settle();
		expect(client.answers.filter((answer) => (answer as { id: unknown }).id === 'waiting')).toEqual(
			[]
		);
	});

	it('compiles afresh against the metamodel of a replica opened again, the artifacts unmoved', async () => {
		const drifted = structuredClone(DOC);
		const blk = drifted.elements.find((type) => type.name === 'Blk')!;
		blk.properties = blk.properties.filter((property) => property.name !== 'c');
		const client = connect();
		await client.call('setArtifacts', {
			artifacts: [ruleSet('r-1', 'Rules', parsed(FLAGGED, COLOURED))]
		});
		await swept(seeded(), DOC, client);
		expect((await listed(client)).rules_status).toEqual({
			total: 2,
			skipped: [],
			eval_errors: {}
		});
		await client.call('close');
		const from = client.events.length;
		await openReplica(client, seeded(drifted), drifted);
		await until(client, isSwept, from);
		expect((await listed(client)).rules_status).toEqual({
			total: 1,
			skipped: [
				{
					artifact_id: 'r-1',
					set_name: 'Rules',
					rule: 'coloured',
					reason: "stereotype 'Blk' has no property 'c'"
				}
			],
			eval_errors: {}
		});
	});
});
