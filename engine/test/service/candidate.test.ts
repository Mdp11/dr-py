import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	candidateKey,
	type CandidateDiff,
	type IssueListBody,
	type IssueOut,
	type MetamodelDoc,
	type ModelOp,
	type PreviewBody,
	type StageResult
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { loadModelFile, parseOps, ruleSetDocs, type StepsFixture } from '../golden/model-steps.ts';
import { clone, Server } from '../working/helpers.ts';
import {
	autoHost,
	connect,
	deltaText,
	fakeHost,
	openReplica,
	refusal,
	settle,
	smartCity,
	type Client
} from './helpers.ts';

const [, previews] = loadFixture<{ runs: StepsFixture[] }>('metamodel_candidate').runs;

/** The fixture's rule sets over the smart-city types: `team-staffed` fires on ten teams. */
const RULES = ruleSetDocs(previews!.steps[0]!);
const COMMITTED_RULES = RULES.map((doc) => ({ ...doc, artifact_rev: 1 }));
const STAGED_RULES = RULES.map((doc) => ({ op: 'create', ...doc, id: `tmp_${doc.id}` }));

type Event = Client['events'][number];

const isSwept = (event: Event) =>
	event.event === 'progress' && event.task === 'sweep' && event.done === event.total;
const isVerified = (event: Event) =>
	event.event === 'progress' && event.task === 'verify' && event.done === event.total;

/** Resolves once some event passes `match`. */
async function until(client: Client, match: (event: Event) => boolean): Promise<void> {
	while (!client.events.some(match)) await settle();
}

/** A ready smart-city replica, its first sweep ended, with `rules` committed before it opened. */
async function ready(host = autoHost(), rules: object[] = []): Promise<Client> {
	const client = connect(host);
	if (rules.length > 0) await client.call('setArtifacts', { artifacts: rules });
	const { model, doc } = smartCity();
	await openReplica(client, model, doc);
	await until(client, isSwept);
	await client.call('staged');
	return client;
}

/** `ready`, with nothing left in the background, each unit of work then a slice turned by hand. */
async function held(rules: object[] = []) {
	const host = fakeHost({ tick: 10 });
	host.auto = true;
	const client = await ready(host, rules);
	await until(client, isVerified);
	await settle();
	await settle();
	host.auto = false;
	return { host, client };
}

/** Runs `count` held slices. */
async function turns(host: ReturnType<typeof fakeHost>, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		expect(host.waiting).toBe(1);
		host.turn();
		await settle();
	}
}

const answersTo = (client: Client, id: string) =>
	client.answers.filter((answer) => (answer as { id: unknown }).id === id).length;

const DOC = smartCity().doc;

type PropertyDoc = MetamodelDoc['elements'][number]['properties'][number];

/** The live document with `edit` applied to a copy of `type`'s property `name`, or a new one. */
function withProperty(
	type: string,
	name: string,
	edit: (property: PropertyDoc) => void,
	base: MetamodelDoc = DOC
): MetamodelDoc {
	const doc = structuredClone(base);
	const properties = doc.elements.find((element) => element.name === type)!.properties;
	let property = properties.find((p) => p.name === name);
	if (property === undefined) {
		property = {
			...properties[0]!,
			name,
			datatype: 'string',
			min: null,
			max: null,
			pattern: null,
			max_length: null
		};
		properties.push(property);
	}
	edit(property);
	return doc;
}

/** Every Organization needs a property none of them has. */
const REQUIRED = withProperty('Organization', 'registry_id', (p) => (p.multiplicity = '1'));
/** Organization's `industry`, which every one of them has, becomes required. */
const INDUSTRY = withProperty('Organization', 'industry', (p) => (p.multiplicity = '1'));
/** A pattern the host cannot run exactly as Python's `re` does. */
const UNUSABLE = withProperty('Organization', 'country', (p) => (p.pattern = '(?x)a'));
/** `Refines` contains its target. */
const CONTAINMENT = (() => {
	const doc = structuredClone(DOC);
	doc.relationships.find((rel) => rel.name === 'Refines')!.containment = true;
	return doc;
})();

const ORGANIZATIONS = ['e_000001', 'e_000002', 'e_000003', 'e_000004', 'e_000005'];

const issue = (
	message: string,
	targetIds: string[],
	check: string,
	extra: Partial<IssueOut> = {}
): IssueOut => ({
	severity: 'error',
	message,
	target_ids: targetIds,
	category: 'conformance',
	check,
	origin: 'on_server',
	...extra
});

const missing = (type: string, property: string, id: string) =>
	issue(`${type}.${property}: 0 value(s) violates multiplicity '1'`, [id], 'multiplicity');

const outKey = (i: IssueOut) =>
	candidateKey({
		severity: i.severity,
		message: i.message,
		targetIds: i.target_ids,
		category: i.category,
		check: i.check
	});

const diffOf = (client: Client, metamodel: unknown) =>
	client.call<CandidateDiff>('candidateIssues', { metamodel });

const dropIndustry: ModelOp = {
	kind: 'update_element',
	id: 'e_000001',
	properties_patch: { industry: null }
};

const PRIORITY = issue('priority: 9 above max 5.0', ['e_000207'], 'facets');
const overPriority: ModelOp = {
	kind: 'update_element',
	id: 'e_000207',
	properties_patch: { priority: 9 }
};

describe('candidateIssues', () => {
	it("answers an identical candidate with nothing moved and every one of the store's keys unchanged", async () => {
		const client = await ready(autoHost(), COMMITTED_RULES);
		const diff = await diffOf(client, DOC);
		const listed = await client.call<IssueListBody>('getModelIssues');
		const keys = new Set(listed.issues.map(outKey));
		expect(listed.issues.filter((i) => i.check === 'rule:team-staffed')).toHaveLength(10);
		expect(Object.keys(diff)).toEqual([
			'now_failing',
			'now_passing',
			'unchanged_count',
			'current_error_count',
			'candidate_error_count'
		]);
		expect(diff).toEqual({
			now_failing: [],
			now_passing: [],
			unchanged_count: keys.size,
			current_error_count: listed.issues.length,
			candidate_error_count: listed.issues.length
		});
	});

	it('answers a new required property as failing on every element that lacks it', async () => {
		const client = await ready();
		const diff = await diffOf(client, REQUIRED);
		expect(diff.now_failing).toEqual(
			ORGANIZATIONS.map((id) => missing('Organization', 'registry_id', id))
		);
		expect(diff.now_passing).toEqual([]);
		expect(diff.candidate_error_count).toBe(diff.current_error_count + 5);
	});

	it('refuses a malformed document with 422, as open does', async () => {
		const client = await ready();
		for (const params of [{}, { metamodel: null }, { metamodel: { elements: 7 } }]) {
			const refused = await refusal(client.call('candidateIssues', params));
			expect(refused.status).toBe(422);
			expect(refused.detail).toMatch(/^metamodel: /);
		}
	});

	it('refuses 501 a candidate pattern the host cannot run, and unreadable working rules', async () => {
		const client = await ready();
		expect(await refusal(diffOf(client, UNUSABLE))).toEqual({
			status: 501,
			detail: 'reaches an unsupported pattern'
		});
		await client.call('setStagedArtifacts', {
			entries: [{ ...STAGED_RULES[0]!, rules: { ok: true, document: '{"rules":[],"x":1}' } }]
		});
		expect(await refusal(diffOf(client, DOC))).toEqual({
			status: 501,
			detail: 'reaches unreadable rules'
		});
	});

	it('scans the staged edits: a staged update the candidate refuses fails, which the committed model alone does not', async () => {
		const client = await ready();
		expect((await diffOf(client, INDUSTRY)).now_failing).toEqual([]);
		await client.call('stage', { ops: [dropIndustry] });
		const diff = await diffOf(client, INDUSTRY);
		expect(diff.now_failing).toEqual([missing('Organization', 'industry', 'e_000001')]);
		expect(diff.now_passing).toEqual([]);
	});

	it('compiles the working rules under the candidate, staged ones included', async () => {
		const client = await ready();
		await client.call('setStagedArtifacts', { entries: STAGED_RULES });
		const diff = await diffOf(client, DOC);
		const listed = await client.call<IssueListBody>('getModelIssues');
		expect(listed.issues.filter((i) => i.check === 'rule:team-staffed')).toHaveLength(10);
		expect(diff.current_error_count).toBe(listed.issues.length);
		expect([diff.now_failing, diff.now_passing]).toEqual([[], []]);
	});

	it('answers a call posted before the first sweep only once it has ended, as a call after it', async () => {
		const client = connect();
		await client.call('setArtifacts', { artifacts: COMMITTED_RULES });
		const early = diffOf(client, DOC).then((diff) => ({ diff, at: client.events.length }));
		const { model, doc } = smartCity();
		await openReplica(client, model, doc);
		const { diff, at } = await early;
		const swept = client.events.findIndex(isSwept);
		expect(swept).toBeGreaterThanOrEqual(0);
		expect(swept).toBeLessThan(at);
		expect(diff.unchanged_count).toBeGreaterThan(0);
		expect(diff).toEqual(await diffOf(client, DOC));
	});

	it('pairs rules that change mid-scan on both sides, answering once', async () => {
		const before = await diffOf(await ready(), REQUIRED);
		const { host, client } = await held();
		const scanning = client.callAs<CandidateDiff>('scan', 'candidateIssues', {
			metamodel: REQUIRED
		});
		await settle();
		// The transition that starts the scan, then its first two steps.
		await turns(host, 2);
		expect(answersTo(client, 'scan')).toBe(0);
		await client.call('setArtifacts', { artifacts: COMMITTED_RULES });
		host.auto = true;
		host.turn();
		const diff = await scanning;
		const listed = await client.call<IssueListBody>('getModelIssues');
		const fired = listed.issues.filter((i) => i.check.startsWith('rule:')).length;
		expect(fired).toBeGreaterThan(0);
		expect(diff.current_error_count).toBe(listed.issues.length);
		expect(diff.current_error_count).toBe(before.current_error_count + fired);
		expect(diff.candidate_error_count).toBe(before.candidate_error_count + fired);
		expect(diff.now_failing).toEqual(before.now_failing);
		expect(diff).toEqual(await diffOf(client, REQUIRED));
		await settle();
		expect(answersTo(client, 'scan')).toBe(1);
	});

	it('starts over on the next replica when the replica closes mid-scan, answering once', async () => {
		const { host, client } = await held();
		const scanning = client.callAs<CandidateDiff>('scan', 'candidateIssues', {
			metamodel: INDUSTRY
		});
		await settle();
		await turns(host, 2);
		expect(answersTo(client, 'scan')).toBe(0);
		await client.call('close');
		host.auto = true;
		host.turn();
		const { model, doc } = smartCity();
		applyBatch(model, [dropIndustry]);
		await openReplica(client, model, doc, { rev: 1 });
		const diff = await scanning;
		expect(diff.now_failing).toEqual([missing('Organization', 'industry', 'e_000001')]);
		expect(diff).toEqual(await diffOf(client, INDUSTRY));
		await settle();
		expect(answersTo(client, 'scan')).toBe(1);
	});

	it('answers a scan from the state it began on when a delta lands mid-scan: the delta waits for it', async () => {
		const { host, client } = await held();
		const server = new Server(clone(smartCity().model));
		const scanning = client.callAs<CandidateDiff>('scan', 'candidateIssues', {
			metamodel: INDUSTRY
		});
		await settle();
		await turns(host, 2);
		const applied = client.call<{ status: string; rev: number }>('applyDelta', {
			text: deltaText(server.commit([dropIndustry]).delta)
		});
		host.auto = true;
		host.turn();
		expect((await scanning).now_failing).toEqual([]);
		expect(await applied).toMatchObject({ status: 'applied', rev: 1 });
		expect((await diffOf(client, INDUSTRY)).now_failing).toEqual([
			missing('Organization', 'industry', 'e_000001')
		]);
		await settle();
		expect(answersTo(client, 'scan')).toBe(1);
	});

	it('never answers a call cancelled while it waits for a rescan, and serves the next', async () => {
		const { host, client } = await held();
		await client.call('setArtifacts', { artifacts: COMMITTED_RULES });
		client.post({ id: 'waiting', method: 'candidateIssues', params: { metamodel: DOC } });
		await settle();
		expect(host.waiting).toBe(1);
		client.cancel('waiting');
		host.auto = true;
		host.turn();
		expect((await diffOf(client, DOC)).now_failing).toEqual([]);
		await settle();
		expect(answersTo(client, 'waiting')).toBe(0);
	});

	it('never answers a call cancelled while it waits for the first sweep', async () => {
		const client = connect();
		client.post({ id: 'waiting', method: 'candidateIssues', params: { metamodel: DOC } });
		await settle();
		client.cancel('waiting');
		const { model, doc } = smartCity();
		await openReplica(client, model, doc);
		expect((await diffOf(client, DOC)).now_failing).toEqual([]);
		await settle();
		expect(answersTo(client, 'waiting')).toBe(0);
	});

	it('never answers a scan cancelled mid-way, and serves the next', async () => {
		const { host, client } = await held();
		client.post({ id: 'scan', method: 'candidateIssues', params: { metamodel: REQUIRED } });
		await settle();
		await turns(host, 2);
		client.cancel('scan');
		const next = diffOf(client, REQUIRED);
		host.auto = true;
		host.turn();
		expect((await next).now_failing).toHaveLength(5);
		await settle();
		expect(answersTo(client, 'scan')).toBe(0);
	});
});

describe('previewCommit with a rebind', () => {
	const preview = (client: Client, metamodel: unknown, rest: object = {}) =>
		client.call<PreviewBody>('previewCommit', {
			base_rev: 0,
			batch_ids: [1],
			strict: true,
			rebind: { metamodel },
			...rest
		});

	it('never blocks, strict with a staged conformance error', async () => {
		const client = await ready();
		await client.call('stage', { ops: [overPriority] });
		const plain = await client.call<PreviewBody>('previewCommit', {
			base_rev: 0,
			batch_ids: [1],
			strict: true
		});
		expect(plain.would_block).toBe(true);
		const body = await preview(client, DOC);
		expect(Object.keys(body)).toEqual([
			'conformance_error_count',
			'structural_blockers',
			'issues',
			'would_block'
		]);
		expect(body.would_block).toBe(false);
		expect(body.issues).toContainEqual(PRIORITY);
		expect(body.conformance_error_count).toBe(
			body.issues.filter((i) => i.category !== 'structural').length
		);
	});

	it('lists a containment cycle the candidate makes as a structural blocker', async () => {
		const client = await ready();
		const refines = (tempId: string, source: string, target: string): ModelOp => ({
			kind: 'create_relationship',
			temp_id: tempId,
			type_name: 'Refines',
			source_id: source,
			target_id: target,
			properties: {}
		});
		await client.call('stage', {
			ops: [refines('tmp_r1', 'e_000206', 'e_000207'), refines('tmp_r2', 'e_000207', 'e_000206')]
		});
		const plain = await preview(client, DOC);
		expect(plain.structural_blockers).toEqual([]);
		const body = await preview(client, CONTAINMENT);
		expect(body.structural_blockers).toEqual(
			body.issues.filter((i) => i.category === 'structural')
		);
		expect(
			body.structural_blockers.filter((i) => i.message.startsWith('Containment cycle detected'))
		).toHaveLength(1);
		expect(body.would_block).toBe(false);
	});

	it('uses the committed rules alone: a staged rule set does not fire', async () => {
		const client = await ready();
		await client.call('setStagedArtifacts', { entries: STAGED_RULES });
		await client.call('stage', { ops: [overPriority] });
		const fired = (body: PreviewBody) =>
			new Set(body.issues.filter((i) => i.check.startsWith('rule:')).map((i) => i.check));
		expect(fired(await preview(client, DOC))).toEqual(new Set());
		await client.call('setStagedArtifacts', { entries: [] });
		await client.call('setArtifacts', { artifacts: COMMITTED_RULES });
		expect(fired(await preview(client, DOC))).toEqual(
			new Set(['rule:team-staffed', 'rule:nfr-target-bounded'])
		);
	});

	it('refuses a stale base_rev and stale batches with 409, and a malformed rebind with 422', async () => {
		const client = await ready();
		await client.call('stage', { ops: [overPriority] });
		expect(await refusal(preview(client, DOC, { base_rev: 1 }))).toEqual({
			status: 409,
			detail: 'stale base_rev'
		});
		expect(await refusal(preview(client, DOC, { batch_ids: [] }))).toEqual({
			status: 409,
			detail: 'stale staged batches'
		});
		expect(
			await refusal(
				client.call('previewCommit', { base_rev: 0, batch_ids: [1], strict: true, rebind: 7 })
			)
		).toEqual({ status: 422, detail: 'rebind must be {metamodel}' });
		const refused = await refusal(preview(client, { elements: 7 }));
		expect(refused.status).toBe(422);
		expect(refused.detail).toMatch(/^metamodel: /);
		expect(await refusal(preview(client, UNUSABLE))).toEqual({
			status: 501,
			detail: 'reaches an unsupported pattern'
		});
	});

	it('refuses stale batches when a stage lands between its check and its scan', async () => {
		const client = await ready();
		await client.call('stage', { ops: [overPriority] });
		const previewing = refusal(preview(client, DOC));
		const staging = client.call<StageResult>('stage', { ops: [dropIndustry] });
		expect(await previewing).toEqual({ status: 409, detail: 'stale staged batches' });
		expect((await staging).batch.id).toBe(2);
	});

	it("answers a staged create's issues under its tmp_ id", async () => {
		const client = await ready();
		await client.call('stage', {
			ops: [
				{
					kind: 'create_element',
					temp_id: 'tmp_new',
					type_name: 'FunctionalRequirement',
					properties: { name: 'New requirement', feature_id: 'FR-9100' }
				}
			]
		});
		const traced = withProperty('FunctionalRequirement', 'trace_id', (p) => (p.multiplicity = '1'));
		const body = await preview(client, traced);
		expect(body.issues).toContainEqual(missing('FunctionalRequirement', 'criticality', 'tmp_new'));
		expect(body.issues).toContainEqual(missing('FunctionalRequirement', 'trace_id', 'tmp_new'));
	});

	it('answers each preview_rebind step of the golden run as the oracle does', async () => {
		const [rulesStep, batchStep, seedStep, ...steps] = previews!.steps;
		expect([rulesStep!.do, batchStep!.do, seedStep!.do]).toEqual(['rules', 'batch', 'seed']);
		const model = loadModelFile(previews!);
		applyBatch(model, parseOps(batchStep!.ops!));
		const client = connect();
		await client.call('setArtifacts', {
			artifacts: ruleSetDocs(rulesStep!).map((doc) => ({ ...doc, artifact_rev: 1 }))
		});
		await openReplica(client, model, previews!.metamodel);
		expect(steps.map((step) => step.do)).toEqual(Array(4).fill('preview_rebind'));
		for (const step of steps) {
			const { batch } = await client.call<StageResult>('stage', {
				ops: step.ops!.map((line) => JSON.parse(line) as unknown)
			});
			const body = await preview(client, step.metamodel, {
				batch_ids: [batch.id],
				strict: step.strict
			});
			expect(JSON.stringify(body), step.case).toBe(JSON.stringify(step.result));
			await client.call('unstage', { what: 'all' });
		}
	});
});
