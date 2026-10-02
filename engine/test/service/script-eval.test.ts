import { afterEach, describe, expect, it } from 'vitest';
import type { MetamodelDoc, ModelOp } from '../../src/index.ts';
import type { ScriptHost, ScriptHostFactory } from '../../src/script/host.ts';
import { createPool } from '../../src/script/pool.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';
import { instrumented } from '../script/fixtures/instrumented.ts';
import { clone, Server } from '../working/helpers.ts';
import {
	autoHost,
	connect,
	deltaText,
	openReplica,
	portPair,
	refusal,
	settle,
	tailText,
	type Client
} from './helpers.ts';

// Evaluations that reach a script, over the real service, the real pool and real Pyodide: the
// option, the cell cache evicted by what a transition touched, and the progress of a fill. The
// model is the script bridge fixture: n1 owns n2 and l1 (a Leaf), n3 stands alone.

type Fixture = { metamodel: MetamodelDoc; elements: string[]; relationships: string[] };
const fixture = loadFixture<Fixture>('script_bridge');
const doc = fixture.metamodel;
const bridgeModel = () => loadLines(doc, fixture.elements, fixture.relationships);

type Chain = { kind: string; id?: string; value?: unknown }[];
type Page = { chains: Chain[]; warnings: { code: string }[] };

/** What each chain of a page ends in: a step's value, or an element's id. */
const endsOf = (page: Page) =>
	page.chains.map((chain) => {
		const last = chain.at(-1)!;
		return last.kind === 'value' ? last.value : last.id;
	});

/** A navigation from `row`, with one script step running `code`. */
const nav = (row: string, code: string) => ({
	definition: {
		kind: 'path',
		start: { kind: 'row' },
		steps: [{ kind: 'script', snippet: { definition: { code } } }]
	},
	row_element_id: row
});

// A comment tells the tests apart: the key of a call holds its code.
const NAME = (tag: string) => `# ${tag}\ndef step(el):\n    return [el.name]\n`;
const LEAVES = (tag: string) =>
	`# ${tag}\ndef step(el):\n    return [len(list(dr.elements(stereotypes="Leaf")))]\n`;
const RAISES = (tag: string) => `# ${tag}\ndef step(el):\n    raise ValueError("no")\n`;
const SPIN = (tag: string) => `# ${tag}\ndef step(el):\n    while True:\n        pass\n`;

const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

/**
 * The real pool over `worker_threads`, with each batch it is asked to run recorded, the workers
 * it spawns watched, and a hook that holds a finished batch's result back from the fill.
 */
function tracked() {
	const ported = instrumented();
	const batches: { code: string; ids: string[][] }[] = [];
	const hosts: ScriptHost[] = [];
	const hook: { after: (() => Promise<void>) | null } = { after: null };
	const factory: ScriptHostFactory = () => {
		const host = createPool(ported.spawn, { cap: 2, now: () => performance.now() });
		hosts.push(host);
		return {
			boot: () => host.boot(),
			prewarm: () => host.prewarm(),
			warmed: (signal) => host.warmed(signal),
			async run(batch, bridge, signal) {
				batches.push({ code: batch.code, ids: batch.calls.map((one) => [...one.elementIds]) });
				const run = await host.run(batch, bridge, signal);
				await hook.after?.();
				return run;
			},
			dispose: () => host.dispose()
		};
	};
	const starts = () =>
		ported.seen.flatMap((one) => one.messages).filter((m) => m.type === 'call-start').length;
	return {
		factory,
		batches,
		hook,
		/** The workers that ran a batch. */
		ran: () => ported.seen.filter((one) => one.runs > 0),
		/** How many calls workers have started. */
		starts,
		/** Resolves once workers have started more than `after` calls. */
		started: (after = 0) => until(() => starts() > after),
		dispose: () => hosts.forEach((host) => host.dispose())
	};
}

async function until(ready: () => boolean, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (!ready()) {
		if (Date.now() > end) throw new Error('timed out waiting');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const trackers: ReturnType<typeof tracked>[] = [];
afterEach(() => trackers.splice(0).forEach((tracker) => tracker.dispose()));

/** A service over a tracked pool, its replica open with `scripts: 'evaluate'`. */
async function evaluating(scripts: unknown = 'evaluate') {
	const tracker = tracked();
	trackers.push(tracker);
	const client = connect(autoHost(), portPair(), { scripts: tracker.factory });
	await openReplica(client, bridgeModel(), doc, { scripts });
	return { client, tracker };
}

const evaluate = (client: Client, row: string, code: string) =>
	client.call<Page>('evaluateNavigation', nav(row, code));

const stage = (client: Client, ops: ModelOp[]) => client.call('stage', { ops });

/** The service's own model, one revision on: the delta of `ops` committed at the server. */
const commit = (ops: ModelOp[]) => deltaText(new Server(clone(bridgeModel())).commit(ops).delta);

describe('the option', () => {
	it('is off by default: a script step answers 501 and no host is asked', async () => {
		const tracker = tracked();
		trackers.push(tracker);
		const client = connect(autoHost(), portPair(), { scripts: tracker.factory });
		await openReplica(client, bridgeModel(), doc);
		expect(await refusal(evaluate(client, 'n1', NAME('off')))).toEqual({
			status: 501,
			detail: 'reaches a script'
		});
		expect(tracker.batches).toEqual([]);
	});

	it('is refused as 422 for any value but "evaluate", and leaves the open replica as it was', async () => {
		const { client, tracker } = await evaluating();
		const code = NAME('bogus');
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['one']);
		const before = client.eventsOf('replica').length;
		for (const scripts of ['bogus', true, null, 1, 'Evaluate']) {
			const refused = await refusal(
				client.call('open', { project_id: 'demo', metamodel: doc, scripts })
			);
			expect(refused.status).toBe(422);
		}
		await settle();
		// Nothing was discarded: no replica event, and the cache still holds the call.
		expect(client.eventsOf('replica')).toHaveLength(before);
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['one']);
		expect(tracker.batches).toHaveLength(1);
	}, 60_000);

	it('lives with the replica: a replica opened again without it refuses, and one with it starts empty', async () => {
		const { client, tracker } = await evaluating();
		const code = NAME('life');
		await evaluate(client, 'n1', code);
		await client.call('close');
		await openReplica(client, bridgeModel(), doc);
		expect((await refusal(evaluate(client, 'n1', code))).status).toBe(501);
		await openReplica(client, bridgeModel(), doc, { scripts: 'evaluate' });
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['one']);
		expect(tracker.batches).toHaveLength(2);
	}, 60_000);

	it('leaves an evaluation that reaches no script as it was', async () => {
		const { client, tracker } = await evaluating();
		const page = await client.call<{ total: number }>('searchModel', { target: 'element' });
		expect(page.total).toBeGreaterThan(0);
		expect(tracker.batches).toEqual([]);
	});

	it('does nothing where the host gave the engine no script host', async () => {
		const client = connect(autoHost());
		await openReplica(client, bridgeModel(), doc, { scripts: 'evaluate' });
		expect(await refusal(evaluate(client, 'n1', NAME('hostless')))).toEqual({
			status: 501,
			detail: 'reaches a script'
		});
	});
});

describe('a fill that is stopped', () => {
	it('is never answered when cancelled, and its workers end', async () => {
		const { client, tracker } = await evaluating();
		const id = 'cancelled';
		const sent = client.callAs(id, 'evaluateNavigation', nav('n1', SPIN('cancel')));
		sent.catch(() => undefined);
		await tracker.started();
		client.cancel(id);
		const ran = tracker.ran();
		expect(ran).toHaveLength(1);
		await until(() => ran[0]!.terminated);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(client.answers.some((answer) => (answer as { id?: unknown }).id === id)).toBe(false);
		// The replica serves on, and what the cancelled call asked for ran nowhere else.
		expect(await evaluate(client, 'n2', NAME('after cancel')).then(endsOf)).toEqual(['two']);
		expect(tracker.batches.map((batch) => batch.code)).toEqual([
			SPIN('cancel'),
			NAME('after cancel')
		]);
	}, 60_000);

	it('answers 409 replica closed when the replica is closed, and a new replica evaluates', async () => {
		const { client, tracker } = await evaluating();
		const sent = evaluate(client, 'n1', SPIN('close'));
		const refused = refusal(sent);
		await tracker.started();
		await client.call('close');
		expect(await refused).toEqual({ status: 409, detail: 'replica closed' });
		const ran = tracker.ran();
		await until(() => ran.every((one) => one.terminated));
		await openReplica(client, bridgeModel(), doc, { scripts: 'evaluate' });
		expect(await evaluate(client, 'n2', NAME('after close')).then(endsOf)).toEqual(['two']);
	}, 60_000);

	it('answers 409 replica closed when another replica is opened over it', async () => {
		const { client, tracker } = await evaluating();
		const refused = refusal(evaluate(client, 'n1', SPIN('reopen')));
		await tracker.started();
		await openReplica(client, bridgeModel(), doc, { scripts: 'evaluate' });
		expect(await refused).toEqual({ status: 409, detail: 'replica closed' });
		expect(await evaluate(client, 'n2', NAME('after reopen')).then(endsOf)).toEqual(['two']);
	}, 60_000);
});

describe('a replica that diverges', () => {
	it('answers a fill in flight 409 replica is not ready, and holds no cell for the next replica', async () => {
		const { client, tracker } = await evaluating();
		const code = NAME('diverge');
		await evaluate(client, 'n1', code);
		const started = tracker.starts();
		const refused = refusal(evaluate(client, 'n1', SPIN('diverge')));
		await tracker.started(started);
		const delta = new Server(clone(bridgeModel())).commit([rename('n2', 'dos')]).delta;
		const diverged = client.nextEvent(
			(event) => event.event === 'replica' && event.state === 'diverged'
		);
		await client.call('applyDelta', {
			text: deltaText({ ...delta, state_digest: '0'.repeat(16) })
		});
		await diverged;
		expect(await refused).toEqual({ status: 409, detail: 'replica is not ready' });
		await until(() => tracker.ran().every((one) => one.terminated));
		await openReplica(client, bridgeModel(), doc, { scripts: 'evaluate' });
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['one']);
		expect(tracker.batches.map((batch) => batch.code)).toEqual([code, SPIN('diverge'), code]);
	}, 60_000);
});

describe('an edit that lands during a fill', () => {
	it('is staged, the evaluation answers with it, and the round it spanned is kept nowhere', async () => {
		const { client, tracker } = await evaluating();
		const code = NAME('spanned');
		let release!: () => void;
		let arrived!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const reached = new Promise<void>((resolve) => (arrived = resolve));
		// The first batch has read the committed name when it is held back.
		tracker.hook.after = async () => {
			tracker.hook.after = null;
			arrived();
			await held;
		};
		const answered = evaluate(client, 'n1', code);
		await reached;
		const staged = await stage(client, [rename('n1', 'uno')]);
		expect(staged).toMatchObject({ coalesced: false });
		release();
		expect(await answered.then(endsOf)).toEqual(['uno']);
		// The held round was dropped and asked for again; the second is what the cache holds.
		expect(tracker.batches).toHaveLength(2);
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['uno']);
		expect(tracker.batches).toHaveLength(2);
		await client.call('unstage', { what: 'all' });
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['one']);
		expect(tracker.batches).toHaveLength(3);
	}, 60_000);
});

describe('progress', () => {
	const scripts = (client: Client) =>
		client.eventsOf('progress').filter((event) => event.task === 'scripts') as unknown as {
			done: number;
			total: number;
		}[];

	it('reports calls done against calls asked for, and ends done === total', async () => {
		const { client } = await evaluating();
		const page = await client.call<Page>('evaluateNavigation', {
			definition: {
				kind: 'path',
				start: { kind: 'scope', types: ['Node'], criteria: [] },
				steps: [{ kind: 'script', snippet: { definition: { code: NAME('progress') } } }]
			}
		});
		await settle();
		const events = scripts(client);
		expect(page.chains.length).toBeGreaterThan(1);
		expect(events.length).toBeGreaterThan(0);
		expect(events.at(-1)!.done).toBe(events.at(-1)!.total);
		expect(events.at(-1)!.total).toBeGreaterThan(1);
		expect(events.every((event) => event.done <= event.total)).toBe(true);
	}, 60_000);

	it('sums every fill in flight, and ends done === total when the last one ends', async () => {
		const { client } = await evaluating();
		await Promise.all([
			evaluate(client, 'n1', NAME('sum')),
			evaluate(client, 'n2', NAME('sum')),
			evaluate(client, 'n3', NAME('sum'))
		]);
		await settle();
		const events = scripts(client);
		expect(events.at(-1)).toMatchObject({ done: 3, total: 3 });
		expect(events.every((event) => event.done <= event.total)).toBe(true);
	}, 60_000);

	it('says nothing for an evaluation that finds every call cached', async () => {
		const { client } = await evaluating();
		await evaluate(client, 'n1', NAME('cached'));
		await settle();
		const before = scripts(client).length;
		await evaluate(client, 'n1', NAME('cached'));
		await settle();
		expect(scripts(client)).toHaveLength(before);
	}, 60_000);
});

describe('what a transition evicts', () => {
	it('drops, for a committed delta, exactly the cells that read what it touched', async () => {
		const { client, tracker } = await evaluating();
		const code = NAME('delta');
		await evaluate(client, 'n1', code);
		await evaluate(client, 'n2', code);
		expect(tracker.batches).toHaveLength(2);
		await client.call('applyDelta', { text: commit([rename('n1', 'uno')]) });
		expect(await evaluate(client, 'n2', code).then(endsOf)).toEqual(['two']);
		expect(tracker.batches).toHaveLength(2);
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['uno']);
		expect(tracker.batches).toHaveLength(3);
		expect(tracker.batches[2]!.ids).toEqual([['n1']]);
	}, 60_000);

	it('drops them likewise for a delta that arrives in a tail', async () => {
		const { client, tracker } = await evaluating();
		const code = NAME('tail');
		await evaluate(client, 'n1', code);
		await evaluate(client, 'n2', code);
		const delta = new Server(clone(bridgeModel())).commit([rename('n2', 'dos')]).delta;
		await client.call('applyTail', { text: tailText([delta], 0) });
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['one']);
		expect(tracker.batches).toHaveLength(2);
		expect(await evaluate(client, 'n2', code).then(endsOf)).toEqual(['dos']);
		expect(tracker.batches).toHaveLength(3);
	}, 60_000);

	it('drops them for a stage and again for an unstage', async () => {
		const { client, tracker } = await evaluating();
		const code = NAME('stage');
		await evaluate(client, 'n1', code);
		await evaluate(client, 'n2', code);
		expect(tracker.batches).toHaveLength(2);
		await stage(client, [rename('n1', 'uno')]);
		expect(await evaluate(client, 'n2', code).then(endsOf)).toEqual(['two']);
		expect(tracker.batches).toHaveLength(2);
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['uno']);
		expect(tracker.batches).toHaveLength(3);
		await client.call('unstage', { what: 'all' });
		expect(await evaluate(client, 'n2', code).then(endsOf)).toEqual(['two']);
		expect(tracker.batches).toHaveLength(3);
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['one']);
		expect(tracker.batches).toHaveLength(4);
		expect(tracker.batches[3]!.ids).toEqual([['n1']]);
	}, 60_000);

	it('merges a staged property update into its batch and still drops the cell', async () => {
		const { client, tracker } = await evaluating();
		const code = NAME('coalesce');
		await stage(client, [rename('n1', 'uno')]);
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['uno']);
		expect(await stage(client, [rename('n1', 'eins')])).toMatchObject({ coalesced: true });
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['eins']);
		expect(tracker.batches).toHaveLength(2);
	}, 60_000);

	it('drops a scan of a type when a delta deletes a member of it by cascade', async () => {
		const { client, tracker } = await evaluating();
		const code = LEAVES('delta cascade');
		expect(await evaluate(client, 'n3', code).then(endsOf)).toEqual([1]);
		await client.call('applyDelta', {
			text: commit([{ kind: 'delete_element', id: 'n1' }])
		});
		expect(await evaluate(client, 'n3', code).then(endsOf)).toEqual([0]);
		expect(tracker.batches).toHaveLength(2);
	}, 60_000);

	it('drops a scan of a type when a stage deletes a member of it by cascade, and when it is unstaged', async () => {
		const { client, tracker } = await evaluating();
		const code = LEAVES('stage cascade');
		expect(await evaluate(client, 'n3', code).then(endsOf)).toEqual([1]);
		await stage(client, [{ kind: 'delete_element', id: 'n1' }]);
		expect(await evaluate(client, 'n3', code).then(endsOf)).toEqual([0]);
		await client.call('unstage', { what: 'all' });
		expect(await evaluate(client, 'n3', code).then(endsOf)).toEqual([1]);
		expect(tracker.batches).toHaveLength(3);
	}, 60_000);

	it('drops a scan of a type when a stage deletes a member an earlier stage created', async () => {
		const { client, tracker } = await evaluating();
		const code = LEAVES('created');
		await stage(client, [
			{ kind: 'create_element', temp_id: 'tmp_1', type_name: 'Leaf', properties: {}, id: null }
		]);
		expect(await evaluate(client, 'n3', code).then(endsOf)).toEqual([2]);
		await stage(client, [{ kind: 'delete_element', id: 'tmp_1' }]);
		expect(await evaluate(client, 'n3', code).then(endsOf)).toEqual([1]);
		expect(tracker.batches).toHaveLength(2);
	}, 60_000);

	it('drops a cell that read the children of a parent when a relationship under it is staged away', async () => {
		const { client, tracker } = await evaluating();
		const code = `# kids\ndef step(el):\n    return [len(el.children())]\n`;
		// n2 under two relationships, l1 under one.
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual([3]);
		await stage(client, [{ kind: 'delete_relationship', id: 'r2' }]);
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual([2]);
		expect(tracker.batches).toHaveLength(2);
	}, 60_000);

	it('keeps what depends on everything through a transition that touched nothing', async () => {
		const { client, tracker } = await evaluating();
		const code = RAISES('nothing');
		const first = await evaluate(client, 'n1', code);
		expect(first.warnings.map((warning) => warning.code)).toEqual(['nav_step_failed']);
		expect(tracker.batches).toHaveLength(1);
		// Nothing is staged: this changes nothing, and a raised error is a cell that read nothing it
		// can name.
		await client.call('unstage', { what: 'all' });
		await evaluate(client, 'n1', code);
		expect(tracker.batches).toHaveLength(1);
		await stage(client, [rename('n2', 'dos')]);
		await evaluate(client, 'n1', code);
		expect(tracker.batches).toHaveLength(2);
	}, 60_000);
});
