import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
	ModelOp,
	ModelSummary,
	TreeItemPage,
	WireArtifact,
	WireStagedArtifact
} from '$engine';
import { NotFoundError, ValidationError } from '$lib/api/errors';
import { server } from '$lib/api/__tests__/server';
import { EngineGoneError } from '../client';
import { FrameError } from '../frame';
import type { CommitAnswer } from '../sync';
import {
	fakeProject,
	hold,
	syncOver,
	type Committed,
	type FakeProject,
	type SyncOverrides
} from './support/project-server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const made: ReturnType<typeof syncOver>[] = [];

afterEach(() => {
	for (const over of made.splice(0)) over.dispose();
	server.resetHandlers();
	server.events.removeAllListeners();
});

function open(project: FakeProject, overrides: SyncOverrides = {}) {
	const over = syncOver(project, overrides);
	made.push(over);
	over.sync.open(project.projectId);
	return over;
}

/** A sync of `project`, opened and `ready`. */
async function ready(project: FakeProject, overrides: SyncOverrides = {}) {
	server.use(...project.handlers());
	const over = open(project, overrides);
	await over.sync.settled();
	expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
	return over;
}

const rename = (id: string, name: string): ModelOp[] => [
	{ kind: 'update_element', id, properties_patch: { name } }
];

const createOrganization = (tempId: string, name: string): ModelOp[] => [
	{ kind: 'create_element', temp_id: tempId, type_name: 'Organization', properties: { name } }
];

function answer(committed: Committed): CommitAnswer {
	const body = JSON.parse(committed.responseText) as {
		model_rev: number;
		id_map: { [tempId: string]: string };
	};
	return {
		text: committed.responseText,
		rev: body.model_rev,
		applied: true,
		rebound: false,
		idMap: body.id_map
	};
}

/** The feed frame of `committed`, its state digest flipped: the replica diverges on it. */
function withWrongDigest(committed: Committed): string {
	const digest = committed.delta['state_digest'] as string;
	const wrong = (BigInt('0x' + digest) ^ 1n).toString(16).padStart(16, '0');
	return committed.eventText.replace(`"state_digest":"${digest}"`, `"state_digest":"${wrong}"`);
}

/** Whether `promise` has settled once the microtasks and a macrotask have run. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	promise.then(
		() => (settled = true),
		() => (settled = true)
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return !settled;
}

const summaryOf = (over: ReturnType<typeof syncOver>) =>
	over.sync.call<ModelSummary>('getModelSummary');

describe('reading from the replica', () => {
	it('a read is answered by the replica', async () => {
		const project = fakeProject({ rev: 4 });
		const over = await ready(project);

		const summary = await summaryOf(over);
		expect(summary).toMatchObject({
			element_count: project.model.elementCount,
			relationship_count: project.model.relationshipCount,
			model_rev: 4
		});
		const ghost = over.sync.call('getElement', { id: 'ghost' });
		await expect(ghost).rejects.toBeInstanceOf(NotFoundError);
		await expect(ghost).rejects.toThrow("No element with id 'ghost");
	});

	it('a read asked while opening waits for ready', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = open(project);
		await held.reached;
		const read = summaryOf(over);
		expect(await pending(read)).toBe(true);
		project.silentCommit(rename('e_000001', 'while opening'));

		held.release();
		await expect(read).resolves.toMatchObject({ model_rev: 1 });
		const methods = over.methods();
		const tail = methods.indexOf('applyTail');
		const posted = methods.indexOf('getModelSummary');
		expect(tail).toBeGreaterThan(-1);
		expect(posted).toBeGreaterThan(tail);
		expect(over.calls[tail]!.result).toMatchObject({ status: 'applied', rev: 1 });
	});

	it('a read asked before there is a link waits for it', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const over = syncOver(project);
		made.push(over);
		over.sync.open(project.projectId);
		expect(over.link).toBeUndefined();
		const read = summaryOf(over);
		await expect(read).resolves.toMatchObject({ model_rev: 0 });
	});

	it('a read sees the commit the UI already has', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const flight = over.sync.beginCommit();
		const peer = project.commit(rename('e_000002', 'peer'));
		const own = project.commit(createOrganization('tmp_a', 'own'));
		over.sync.feedCommit(peer.eventText, 1);
		over.sync.feedCommit(own.eventText, 2);
		const settled = answer(own);
		const created = settled.idMap['tmp_a']!;

		flight.settle(settled);
		const read = over.sync.call('getElement', { id: created });

		await expect(read).resolves.toMatchObject({ id: created, properties: { name: 'own' } });
		const methods = over.methods();
		const deltas = over.calls.filter((call) => call.method === 'applyDelta');
		expect(deltas.map((call) => (call.result as { rev: number }).rev)).toEqual([1, 2]);
		const lastDelta = methods.lastIndexOf('applyDelta');
		expect(methods.indexOf('getElement')).toBeGreaterThan(lastDelta);
		expect(methods.slice(-3)).toEqual(['applyDelta', 'applyDelta', 'getElement']);
	});

	it('a read waits for the catch-up a snapshot event ahead starts', async () => {
		const project = fakeProject();
		const over = await ready(project);
		project.silentCommit(rename('e_000001', 'one'));
		project.silentCommit(rename('e_000002', 'two'));

		over.sync.feedSnapshot(2);
		await expect(summaryOf(over)).resolves.toMatchObject({ model_rev: 2 });
		const methods = over.methods();
		expect(methods.indexOf('getModelSummary')).toBeGreaterThan(methods.lastIndexOf('applyTail'));
	});

	it('a read does not wait for a commit still in flight', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const flight = over.sync.beginCommit();
		project.commit(rename('e_000001', 'in flight'));

		await expect(summaryOf(over)).resolves.toMatchObject({ model_rev: 0 });
		flight.abandon();
	});

	it('a frozen replica answers as it is', async () => {
		const project = fakeProject();
		const over = await ready(project);
		project.rebind('mm-2');
		over.sync.feedRebind(1);
		const later = project.commit(rename('e_000001', 'under mm-2'));
		over.sync.feedCommit(later.eventText, 2);
		expect(over.sync.status()).toMatchObject({ phase: 'frozen', rev: 0 });

		await expect(summaryOf(over)).resolves.toMatchObject({ model_rev: 0 });
	});

	it('server and off refuse at once', async () => {
		const unreachable = fakeProject();
		server.use(...unreachable.handlers());
		const refused = open(unreachable, {
			connect: () => Promise.reject(new FrameError('timeout', 'no answer'))
		});
		await refused.sync.settled();
		expect(refused.sync.status().phase).toBe('server');
		await expect(summaryOf(refused)).rejects.toBeInstanceOf(EngineGoneError);

		const empty = fakeProject({ projectId: 'empty' });
		empty.fail('descriptor', 404, 1);
		server.use(...empty.handlers());
		const off = open(empty);
		await off.sync.settled();
		expect(off.sync.status()).toMatchObject({ phase: 'off', reason: 'no model' });
		await expect(summaryOf(off)).rejects.toBeInstanceOf(EngineGoneError);

		const never = syncOver(unreachable);
		made.push(never);
		await expect(summaryOf(never)).rejects.toBeInstanceOf(EngineGoneError);
	});

	it('a read waiting when the open gives up is refused', async () => {
		const project = fakeProject();
		project.fail('snapshot', 503, 99);
		server.use(...project.handlers());
		const over = open(project);
		const read = summaryOf(over);
		const refusal = expect(read).rejects.toBeInstanceOf(EngineGoneError);
		await over.sync.settled();

		expect(over.sync.status().phase).toBe('server');
		await refusal;
		expect(over.methods()).not.toContain('getModelSummary');
	});

	it('an aborted wait posts nothing', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = open(project);
		await held.reached;
		const controller = new AbortController();
		const read = over.sync.call('getModelSummary', undefined, { signal: controller.signal });
		controller.abort();
		await expect(read).rejects.toMatchObject({ name: 'AbortError' });
		await expect(read).rejects.toBeInstanceOf(DOMException);

		held.release();
		await over.sync.settled();
		expect(over.sync.status().phase).toBe('ready');
		expect(over.methods()).not.toContain('getModelSummary');

		const early = new AbortController();
		early.abort();
		await expect(
			over.sync.call('getModelSummary', undefined, { signal: early.signal })
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(over.methods()).not.toContain('getModelSummary');
	});

	it('an aborted posted read is cancelled', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const controller = new AbortController();
		const read = over.sync.call('listElementsPage', { q: 'a' }, { signal: controller.signal });
		const posted = over.calls.at(-1)!;
		expect(posted).toMatchObject({ method: 'listElementsPage', params: { q: 'a' } });
		expect(posted.signal).toBe(controller.signal);

		controller.abort();
		await expect(read).rejects.toMatchObject({ name: 'AbortError' });
		// The engine goes on answering.
		await expect(summaryOf(over)).resolves.toMatchObject({ model_rev: 0 });
	});

	it('stop refuses the waiters', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = open(project);
		await held.reached;
		const read = summaryOf(over);

		over.sync.stop();
		await expect(read).rejects.toBeInstanceOf(EngineGoneError);
		held.release();
		await over.sync.settled();
		expect(over.methods()).not.toContain('getModelSummary');
	});
});

describe('view placements', () => {
	/** The ids of the roots the replica does not place in `viewId`. */
	const excluded = async (over: ReturnType<typeof syncOver>, viewId: string) => {
		const page = await over.sync.call<TreeItemPage>('listExcludedRoots', {
			view_id: viewId,
			limit: 500
		});
		return page.items.map((item) => item.id);
	};

	it('placements reach the engine, now and on every new link', async () => {
		const project = fakeProject();
		const root = project.model.indexes.roots.list()[0]!.id;
		server.use(...project.handlers());
		const over = syncOver(project);
		made.push(over);
		over.sync.setViewPlacement('v1', [root]);
		over.sync.open(project.projectId);
		await over.sync.settled();
		expect(over.sync.status().phase).toBe('ready');

		expect(await excluded(over, 'v1')).not.toContain(root);
		expect(await excluded(over, 'other')).toContain(root);

		// A re-bootstrap, on the same worker.
		const diverging = project.commit(rename('e_000001', 'diverges'));
		const seen = over.statuses.length;
		over.sync.feedCommit(withWrongDigest(diverging), 1);
		await over.sync.settled();
		expect(over.statuses.slice(seen).some((s) => s.phase === 'resyncing')).toBe(true);
		expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: 1 });
		expect(over.connects).toBe(1);
		expect(await excluded(over, 'v1')).not.toContain(root);

		// A re-bootstrap whose worker dies mid-open: the next attempt connects anew.
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const again = project.commit(rename('e_000002', 'diverges again'));
		over.sync.feedCommit(withWrongDigest(again), 2);
		await held.reached;
		over.links[0]!.dispose();
		held.release();
		await over.sync.settled();
		expect(over.connects).toBe(2);
		expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: 2 });
		expect(await excluded(over, 'v1')).not.toContain(root);

		over.sync.dropViewPlacement('v1');
		expect(await excluded(over, 'v1')).toContain(root);

		over.sync.setViewPlacement('v1', [root]);
		over.sync.stop();
		const before = over.calls.length;
		over.sync.open(project.projectId);
		await over.sync.settled();
		expect(over.sync.status().phase).toBe('ready');
		expect(over.methods().slice(before)).not.toContain('setViewPlacement');
		expect(await excluded(over, 'v1')).toContain(root);
	});

	it('a placement set while ready reaches the engine at once', async () => {
		const project = fakeProject();
		const root = project.model.indexes.roots.list()[0]!.id;
		const over = await ready(project);

		over.sync.setViewPlacement('v1', [root]);
		expect(await excluded(over, 'v1')).not.toContain(root);
		expect(over.calls.find((call) => call.method === 'setViewPlacement')!.params).toEqual({
			view_id: 'v1',
			element_ids: [root]
		});
	});
});

describe('the artifact context', () => {
	const scope = (type: string) => ({
		kind: 'path',
		start: { kind: 'scope', types: [type] },
		steps: []
	});
	const committed = (id: string, type: string): WireArtifact => ({
		id,
		kind: 'navigation',
		name: `nav ${id}`,
		artifact_rev: 1,
		payload: scope(type)
	});
	const stagedCreate = (id: string, type: string): WireStagedArtifact => ({
		op: 'create',
		id,
		kind: 'navigation',
		name: `nav ${id}`,
		payload: scope(type)
	});
	const evaluate = (over: ReturnType<typeof syncOver>, params: object) =>
		over.sync.call<{ total: number }>('evaluateNavigation', params);
	const totalOf = async (over: ReturnType<typeof syncOver>, type: string) =>
		(await evaluate(over, { definition: scope(type) })).total;

	it('a new worker gets the artifacts, then the staged entries, before a held evaluation', async () => {
		const project = fakeProject();
		const over = await ready(project);
		over.sync.setArtifacts([committed('n1', 'Organization')]);
		over.sync.setStagedArtifacts([stagedCreate('tmp_b', 'Project')]);
		const organizations = await totalOf(over, 'Organization');
		const projects = await totalOf(over, 'Project');
		expect(organizations).not.toBe(projects);
		await expect(evaluate(over, { artifact_id: 'n1' })).resolves.toMatchObject({
			total: organizations
		});

		// The worker dies; a read finds it gone and the replica is rebuilt on a new one.
		over.links[0]!.dispose();
		const before = over.calls.length;
		await expect(summaryOf(over)).rejects.toBeInstanceOf(EngineGoneError);
		expect(over.sync.status().phase).toBe('resyncing');
		const held = evaluate(over, { artifact_id: 'n1' });
		const heldStaged = evaluate(over, { artifact_id: 'tmp_b' });

		await expect(held).resolves.toMatchObject({ total: organizations });
		await expect(heldStaged).resolves.toMatchObject({ total: projects });
		expect(over.connects).toBe(2);
		const methods = over.methods().slice(before);
		const artifacts = methods.indexOf('setArtifacts');
		const staged = methods.indexOf('setStagedArtifacts');
		expect(artifacts).toBeGreaterThan(-1);
		expect(staged).toBeGreaterThan(artifacts);
		expect(methods.indexOf('open')).toBeGreaterThan(staged);
		expect(methods.indexOf('evaluateNavigation')).toBeGreaterThan(staged);
		expect(over.calls[before + artifacts]!.params).toEqual({
			artifacts: [committed('n1', 'Organization')]
		});
		expect(over.calls[before + staged]!.params).toEqual({
			entries: [stagedCreate('tmp_b', 'Project')]
		});
	});

	it('a put reaches the engine at once and is what the next worker gets', async () => {
		const project = fakeProject();
		const over = await ready(project);
		over.sync.setArtifacts([committed('n1', 'Organization'), committed('n2', 'Organization')]);
		over.sync.setStagedArtifacts([stagedCreate('tmp_b', 'Project')]);
		over.sync.putArtifacts([committed('n3', 'Project')], ['n1'], []);
		expect(over.calls.at(-1)).toMatchObject({
			method: 'putArtifacts',
			params: { changed: [committed('n3', 'Project')], deleted_ids: ['n1'], staged: [] }
		});
		over.sync.putArtifacts([committed('n2', 'Project')], []);
		expect(over.calls.at(-1)!.params).toEqual({
			changed: [committed('n2', 'Project')],
			deleted_ids: []
		});

		over.links[0]!.dispose();
		const before = over.calls.length;
		await expect(summaryOf(over)).rejects.toBeInstanceOf(EngineGoneError);
		await over.sync.settled();
		expect(over.sync.status().phase).toBe('ready');

		const sent = over.calls.slice(before);
		expect(sent.find((call) => call.method === 'setArtifacts')!.params).toEqual({
			artifacts: [committed('n2', 'Project'), committed('n3', 'Project')]
		});
		expect(sent.map((call) => call.method)).not.toContain('setStagedArtifacts');
		await expect(evaluate(over, { artifact_id: 'n1' })).rejects.toThrow(
			'unknown navigation artifact n1'
		);
		await expect(evaluate(over, { artifact_id: 'tmp_b' })).rejects.toThrow(
			'unknown navigation artifact tmp_b'
		);
	});

	it('stop forgets both, and no artifact of one project reaches the next', async () => {
		const first = fakeProject({ projectId: 'a' });
		const second = fakeProject({ projectId: 'b' });
		server.use(...first.handlers(), ...second.handlers());
		const over = syncOver(first);
		made.push(over);
		over.sync.setArtifacts([committed('n1', 'Organization')]);
		over.sync.setStagedArtifacts([stagedCreate('tmp_b', 'Project')]);
		over.sync.open(first.projectId);
		await over.sync.settled();
		await expect(evaluate(over, { artifact_id: 'n1' })).resolves.toBeDefined();
		await expect(evaluate(over, { artifact_id: 'tmp_b' })).resolves.toBeDefined();

		over.sync.stop();
		const before = over.calls.length;
		over.sync.open(second.projectId);
		// Asked before the next project's own artifacts could land.
		const other = evaluate(over, { artifact_id: 'n1' });
		const otherStaged = evaluate(over, { artifact_id: 'tmp_b' });
		await expect(other).rejects.toBeInstanceOf(ValidationError);
		await expect(other).rejects.toThrow('unknown navigation artifact n1');
		await expect(otherStaged).rejects.toThrow('unknown navigation artifact tmp_b');
		expect(over.sync.status()).toMatchObject({ phase: 'ready' });
		expect(over.connects).toBe(2);
		const methods = over.methods().slice(before);
		expect(methods).not.toContain('setArtifacts');
		expect(methods).not.toContain('setStagedArtifacts');

		// A switch through `open` alone forgets them too.
		over.sync.setArtifacts([committed('n2', 'Organization')]);
		await expect(evaluate(over, { artifact_id: 'n2' })).resolves.toBeDefined();
		over.sync.open(first.projectId);
		await expect(evaluate(over, { artifact_id: 'n2' })).rejects.toThrow(
			'unknown navigation artifact n2'
		);
	});
});
