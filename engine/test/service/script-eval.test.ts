import { afterEach, describe, expect, it } from 'vitest';
import { SETTLE_STEP } from '../../src/evaluate/fill.ts';
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
	fakeHost,
	gzChunks,
	openReplica,
	portPair,
	refusal,
	settle,
	snapshotText,
	tailText,
	type Client
} from './helpers.ts';

// Evaluations that reach a script, over the real service, the real pool and real Pyodide: the
// host, the cell cache evicted by what a transition touched, and the progress of a fill. The
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
function tracked(limits?: { callMs: number; graceMs: number }) {
	const ported = instrumented();
	const batches: { code: string; ids: string[][] }[] = [];
	const hosts: ScriptHost[] = [];
	const hook: { after: ((index: number) => Promise<void>) | null } = { after: null };
	const factory: ScriptHostFactory = () => {
		const host = createPool(ported.spawn, { cap: 2, limits, now: () => performance.now() });
		hosts.push(host);
		return {
			boot: () => host.boot(),
			prewarm: () => host.prewarm(),
			warmed: (signal) => host.warmed(signal),
			async run(batch, bridge, signal) {
				const index =
					batches.push({ code: batch.code, ids: batch.calls.map((one) => [...one.elementIds]) }) -
					1;
				const run = await host.run(batch, bridge, signal);
				await hook.after?.(index);
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

/** A service over a tracked pool, its replica open. */
async function evaluating(limits?: { callMs: number; graceMs: number }) {
	const tracker = tracked(limits);
	trackers.push(tracker);
	const client = connect(autoHost(), portPair(), { scripts: tracker.factory });
	await openReplica(client, bridgeModel(), doc);
	return { client, tracker };
}

const evaluate = (client: Client, row: string, code: string) =>
	client.call<Page>('evaluateNavigation', nav(row, code));

const stage = (client: Client, ops: ModelOp[]) => client.call('stage', { ops });

/** The service's own model, one revision on: the delta of `ops` committed at the server. */
const commit = (ops: ModelOp[]) => deltaText(new Server(clone(bridgeModel())).commit(ops).delta);

describe('evaluating scripts', () => {
	it('leaves an evaluation that reaches no script as it was', async () => {
		const { client, tracker } = await evaluating();
		const page = await client.call<{ total: number }>('searchModel', { target: 'element' });
		expect(page.total).toBeGreaterThan(0);
		expect(tracker.batches).toEqual([]);
	});

	it('answers 503 where the host gave the engine no script host, for a table that has a script column only', async () => {
		const client = connect(autoHost());
		await openReplica(client, bridgeModel(), doc);
		const definition = (columns: object[]) => ({
			definition: {
				row_source: { kind: 'scope', types: ['Node'], criteria: [] },
				columns: [{ kind: 'element' }, ...columns]
			}
		});
		const scripted = definition([
			{ kind: 'script', snippet: { definition: { code: NAME('hostless') } } }
		]);
		expect(await refusal(client.call('evaluateTable', scripted))).toEqual({
			status: 503,
			detail: 'no script host'
		});
		const page = await client.call<{ total: number }>('evaluateTable', definition([]));
		expect(page.total).toBeGreaterThan(0);
	});

	it('waits for the first replica, and an evaluation sent before the open is filled', async () => {
		const tracker = tracked();
		trackers.push(tracker);
		const client = connect(autoHost(), portPair(), { scripts: tracker.factory });
		const sent = client.call<{ rows: { key: unknown[]; cells: { value?: unknown }[] }[] }>(
			'evaluateTable',
			{
				definition: {
					row_source: { kind: 'scope', types: ['Node'], criteria: [] },
					columns: [
						{ kind: 'element' },
						{
							kind: 'script',
							snippet: {
								definition: {
									code: `# early\ndef value(els):\n    return str(els[0].name)\n`
								}
							}
						}
					]
				}
			}
		);
		await openReplica(client, bridgeModel(), doc);
		const page = await sent;
		expect(page.rows.find((row) => row.key[0] === 'n1')!.cells[1]).toMatchObject({
			value: 'one'
		});
	}, 60_000);
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
		await openReplica(client, bridgeModel(), doc);
		expect(await evaluate(client, 'n2', NAME('after close')).then(endsOf)).toEqual(['two']);
	}, 60_000);

	it('answers 409 replica closed when another replica is opened over it', async () => {
		const { client, tracker } = await evaluating();
		const refused = refusal(evaluate(client, 'n1', SPIN('reopen')));
		await tracker.started();
		await openReplica(client, bridgeModel(), doc);
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
		await openReplica(client, bridgeModel(), doc);
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

describe('the state an evaluation answers', () => {
	const search = (client: Client) => client.call('searchModel', { target: 'element' });
	const text = (value: unknown) => JSON.stringify(value);

	/** A client on an engine with no script host, to say what a scan that reads no script answers there. */
	async function plain(): Promise<Client> {
		const client = connect(autoHost(), portPair());
		await openReplica(client, bridgeModel(), doc);
		return client;
	}

	it('is the state it ran on when a stage is posted right behind it, as without a script host', async () => {
		const { client } = await evaluating();
		const bare = await plain();
		const answers: string[] = [];
		for (const one of [client, bare]) {
			const sent = search(one);
			const staged = stage(one, [rename('n1', 'changed')]);
			answers.push(text(await sent));
			await staged;
			// The stage did land.
			expect(text(await search(one))).toContain('changed');
		}
		expect(answers[0]).not.toContain('changed');
		expect(answers[0]).toBe(answers[1]);
	}, 60_000);

	it('is not starved by a stream of stages', async () => {
		const { client, tracker } = await evaluating();
		const bare = await plain();
		const streamed = autoHost(10);
		const slow = connect(streamed, portPair(), { scripts: tracker.factory });
		await openReplica(slow, bridgeModel(), doc);
		const STAGES = 200;
		const answeredAfter = async (one: Client) => {
			let stages = 0;
			const loop = (async () => {
				while (stages < STAGES) {
					await stage(one, [rename('n1', `c${stages}`)]);
					stages++;
				}
			})();
			let at = -1;
			const sent = search(one).then(() => (at = stages));
			await Promise.all([loop, sent]);
			return at;
		};
		// The evaluation was posted before the first stage, and answers before the stream is over.
		expect(await answeredAfter(client)).toBeLessThan(10);
		expect(await answeredAfter(slow)).toBeLessThan(10);
		expect(await answeredAfter(bare)).toBeLessThan(10);
	}, 120_000);

	it('keeps a round across a transition that changed nothing', async () => {
		const { client, tracker } = await evaluating();
		const code = NAME('no-op');
		let release!: () => void;
		let arrived!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const reached = new Promise<void>((resolve) => (arrived = resolve));
		tracker.hook.after = async () => {
			tracker.hook.after = null;
			arrived();
			await held;
		};
		const answered = evaluate(client, 'n1', code);
		await reached;
		// Nothing is staged: neither the model nor a cell it could have read moved.
		await client.call('unstage', { what: 'all' });
		release();
		expect(await answered.then(endsOf)).toEqual(['one']);
		expect(tracker.batches).toHaveLength(1);
		expect(await evaluate(client, 'n1', code).then(endsOf)).toEqual(['one']);
		expect(tracker.batches).toHaveLength(1);
	}, 60_000);

	it('is not refused for arriving while the replica is diverged: it waits for the next one', async () => {
		const { client, tracker } = await evaluating();
		const delta = new Server(clone(bridgeModel())).commit([rename('n2', 'dos')]).delta;
		const diverged = client.nextEvent(
			(event) => event.event === 'replica' && event.state === 'diverged'
		);
		await client.call('applyDelta', {
			text: deltaText({ ...delta, state_digest: '0'.repeat(16) })
		});
		await diverged;
		const waiting = evaluate(client, 'n1', NAME('early'));
		waiting.catch(() => undefined);
		await settle();
		expect(tracker.batches).toEqual([]);
		await openReplica(client, bridgeModel(), doc);
		expect(await waiting.then(endsOf)).toEqual(['one']);
		// It filled on the new replica's cache, which a transition there evicts from.
		await stage(client, [rename('n1', 'uno')]);
		expect(await evaluate(client, 'n1', NAME('early')).then(endsOf)).toEqual(['uno']);
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

	it('says nothing into the next replica for a fill the replica ended under', async () => {
		const { client, tracker } = await evaluating();
		const column = (code: string) => ({ kind: 'script', snippet: { definition: { code } } });
		const sent = client.call('evaluateTable', {
			definition: {
				row_source: { kind: 'scope', types: ['Node'], criteria: [] },
				columns: [
					{ kind: 'element' },
					column(`# spun\ndef value(els):\n    while True:\n        pass\n`),
					column(`# quick\ndef value(els):\n    return str(els[0].name)\n`)
				]
			},
			limit: 1
		});
		sent.catch(() => undefined);
		// One of the round's two batches is done: one call of two.
		await until(() => scripts(client).some((event) => event.done === 1 && event.total === 2));
		const before = scripts(client).length;
		const ran = tracker.ran();
		await openReplica(client, bridgeModel(), doc);
		// The fill ends once its batches have: the one that spins is stopped.
		await until(() => ran.every((one) => one.terminated));
		await settle();
		await expect(sent).rejects.toMatchObject({ status: 409 });
		expect(scripts(client)).toHaveLength(before);
		expect(scripts(client).every((event) => event.done < event.total)).toBe(true);
	}, 60_000);

	it('counts a fill of a dropped replica in no progress of the next', async () => {
		const { client, tracker } = await evaluating();
		const column = (code: string) => ({ kind: 'script', snippet: { definition: { code } } });
		const sent = client.call('evaluateTable', {
			definition: {
				row_source: { kind: 'scope', types: ['Node'], criteria: [] },
				columns: [
					{ kind: 'element' },
					column(`# spun2\ndef value(els):\n    while True:\n        pass\n`),
					column(`# quick2\ndef value(els):\n    return str(els[0].name)\n`)
				]
			},
			limit: 1
		});
		sent.catch(() => undefined);
		// The spinning batch's answer is held back, so the old fill is still in flight when the next starts.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		tracker.hook.after = async (index) => {
			if (tracker.batches[index]!.code.includes('spun2')) await gate;
		};
		await until(() => scripts(client).some((event) => event.done === 1 && event.total === 2));
		await openReplica(client, bridgeModel(), doc);
		const before = scripts(client).length;
		await Promise.all([evaluate(client, 'n1', NAME('next')), evaluate(client, 'n2', NAME('next'))]);
		await settle();
		const after = scripts(client).slice(before);
		expect(after.length).toBeGreaterThan(0);
		expect(after.every((event) => event.total <= 2)).toBe(true);
		expect(after.at(-1)).toMatchObject({ done: 2, total: 2 });
		tracker.hook.after = null;
		release();
		await expect(sent).rejects.toMatchObject({ status: 409 });
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

describe('a table with script columns', () => {
	type Cell = { kind: string; value?: unknown; message?: string | null };
	type TablePage = { rows: { key: unknown[]; cells: Cell[] }[]; total: number };

	const column = (code: string, extra: object = {}) => ({
		kind: 'script',
		snippet: { definition: { code } },
		...extra
	});
	const table = (columns: object[], extra: object = {}, page: object = {}) => ({
		definition: {
			row_source: { kind: 'scope', types: ['Node'], criteria: [] },
			columns: [{ kind: 'element' }, ...columns],
			...extra
		},
		...page
	});
	const evaluateTable = (client: Client, params: object) =>
		client.call<TablePage>('evaluateTable', params);

	const NAMED = (tag: string) => `# ${tag}\ndef value(els):\n    return str(els[0].name)\n`;
	const FAILS = (tag: string) => `# ${tag}\ndef value(els):\n    raise ValueError("no")\n`;
	const SPINS = (tag: string) => `# ${tag}\ndef value(els):\n    while True:\n        pass\n`;
	const WIDTH = (tag: string) => `# ${tag}\ndef value(els, inputs):\n    return len(inputs["x"])\n`;
	const valueOf = (page: TablePage, id: string, col = 1) =>
		page.rows.find((row) => row.key[0] === id)!.cells[col]!;
	/** How many calls the hosts were asked for, over every batch. */
	const callsOf = (tracker: ReturnType<typeof tracked>, tag?: string) =>
		tracker.batches
			.filter((batch) => tag === undefined || batch.code.includes(`# ${tag}\n`))
			.reduce((sum, batch) => sum + batch.ids.length, 0);

	it('shows the value of a row element the working copy has an edit staged on', async () => {
		const { client, tracker } = await evaluating();
		const params = table([column(NAMED('edit'))]);
		expect(valueOf(await evaluateTable(client, params), 'n1')).toMatchObject({ value: 'one' });
		await stage(client, [rename('n1', 'uno')]);
		const page = await evaluateTable(client, params);
		expect(valueOf(page, 'n1')).toMatchObject({ kind: 'value', value: 'uno' });
		expect(valueOf(page, 'n2')).toMatchObject({ value: 'two' });
		// Only the edited row asked again.
		expect(callsOf(tracker, 'edit')).toBe(page.total + 1);
		await client.call('unstage', { what: 'all' });
		expect(valueOf(await evaluateTable(client, params), 'n1')).toMatchObject({ value: 'one' });
	}, 60_000);

	it('answers a timeout as an error cell and does not keep it: the next evaluation runs it again', async () => {
		const { client, tracker } = await evaluating({ callMs: 300, graceMs: 500 });
		const params = table([column(SPINS('spin')), column(NAMED('beside'))], {}, { limit: 1 });
		const first = await evaluateTable(client, params);
		expect(first.rows[0]!.cells[1]).toMatchObject({ kind: 'error' });
		expect(first.rows[0]!.cells[1]!.message).toMatch(/time/i);
		expect(first.rows[0]!.cells[2]).toMatchObject({ kind: 'value' });
		const second = await evaluateTable(client, params);
		expect(second.rows[0]!.cells[1]).toMatchObject({ kind: 'error' });
		expect(callsOf(tracker, 'spin')).toBe(2);
		// The value beside it was kept.
		expect(callsOf(tracker, 'beside')).toBe(1);
	}, 60_000);

	it('never sends a cell whose input failed to the host', async () => {
		const { client, tracker } = await evaluating();
		const x = { name: 'x', ref: { kind: 'column', index: 1 } };
		const params = table(
			[column(FAILS('source')), column(WIDTH('dependent'), { inputs: [x] })],
			{},
			{ limit: 3 }
		);
		const page = await evaluateTable(client, params);
		for (const row of page.rows) {
			expect(row.cells[1]).toMatchObject({ kind: 'error' });
			expect(row.cells[2]).toMatchObject({ kind: 'error' });
			expect(row.cells[2]!.message).toMatch(/^input 'x': ValueError: no/);
		}
		expect(callsOf(tracker, 'source')).toBe(3);
		expect(tracker.batches.some((batch) => batch.code.includes('# dependent\n'))).toBe(false);
	}, 60_000);

	it('fills the whole scope for a sort by a script column, and only the page for a plain one', async () => {
		const { client, tracker } = await evaluating();
		const plain = await evaluateTable(client, table([column(NAMED('plain'))], {}, { limit: 2 }));
		expect(plain.rows).toHaveLength(2);
		expect(callsOf(tracker, 'plain')).toBe(2);
		const sorted = await evaluateTable(
			client,
			table([column(NAMED('sorted'))], { sort: [{ column: 1 }] }, { limit: 2 })
		);
		expect(sorted.rows).toHaveLength(2);
		expect(callsOf(tracker, 'sorted')).toBe(sorted.total);
		expect(sorted.total).toBeGreaterThan(2);
	}, 60_000);

	it('orders by the snippet as it is staged: an edit of a saved snippet moves the kept order', async () => {
		const { client } = await evaluating();
		const snippet = (code: string) => ({ code: `# saved\ndef value(els):\n    return ${code}\n` });
		const LENGTH = 'len(str(els[0].name))';
		await client.call('setArtifacts', {
			artifacts: [
				{ id: 'snip', kind: 'code_snippet', name: 'S', artifact_rev: 1, payload: snippet(LENGTH) },
				{
					id: 'tbl',
					kind: 'table',
					name: 'T',
					artifact_rev: 1,
					payload: table([{ kind: 'script', snippet: { ref: 'snip' } }], { sort: [{ column: 1 }] })
						.definition
				}
			]
		});
		const firstOf = async () =>
			(await evaluateTable(client, { artifact_id: 'tbl', limit: 1 })).rows[0]!.key[0];
		// The shortest name first; l1's name is a list.
		expect(await firstOf()).toBe('é1');
		await client.call('setStagedArtifacts', {
			entries: [{ op: 'update', id: 'snip', payload: snippet(`-${LENGTH}`) }]
		});
		expect(await firstOf()).toBe('l1');
		await client.call('setStagedArtifacts', { entries: [] });
		expect(await firstOf()).toBe('é1');
	}, 60_000);

	it('tells a sort that falls back to the build order every time, from the kept order too', async () => {
		const { client, tracker } = await evaluating();
		const navigation = {
			kind: 'navigation',
			navigation: {
				definition: {
					kind: 'path',
					start: { kind: 'row' },
					steps: [{ kind: 'script', snippet: { definition: { code: NAME('fallback') } } }]
				}
			}
		};
		const params = table([navigation], { sort: [{ column: 1, direction: 'desc' }] }, { limit: 2 });
		const first = await client.call<TablePage & { warnings: unknown[] }>('evaluateTable', params);
		expect(first.warnings).toEqual([
			{ code: 'sort_needs_script_nav', occurrences: 1, total: 0, detail: null }
		]);
		// Build order (ids by code point), whatever the sort says; the step ran for the page's cells.
		expect(first.rows.map((row) => row.key[0])).toEqual(['l1', 'n1']);
		expect(callsOf(tracker, 'fallback')).toBe(2);
		const second = await client.call<TablePage & { warnings: unknown[] }>('evaluateTable', params);
		expect(second).toEqual(first);
		expect(callsOf(tracker, 'fallback')).toBe(2);
	}, 60_000);

	it('passes a non-finite float on to the column that reads it as an input', async () => {
		const { client } = await evaluating();
		const x = { name: 'x', ref: { kind: 'column', index: 1 } };
		const page = await evaluateTable(
			client,
			table(
				[
					column(
						'# infinite\ndef value(els):\n    return [float("inf"), float("-inf"), float("nan")]\n'
					),
					column(
						'# echo\ndef value(els, inputs):\n    return "|".join(str(v) for v in inputs["x"])\n',
						{
							inputs: [x]
						}
					)
				],
				{},
				{ limit: 1 }
			)
		);
		expect(page.rows[0]!.cells[2]).toMatchObject({ kind: 'value', value: 'inf|-inf|nan' });
	}, 60_000);

	it('previews a script-sorted table in the order of its first rows', async () => {
		const { client } = await evaluating();
		const params = table(
			[column('# preview\ndef value(els):\n    return len(str(els[0].name))\n')],
			{ sort: [{ column: 1, direction: 'desc' }] }
		);
		const page = await evaluateTable(client, params);
		const { sample } = await client.call<{ sample: string }>('previewTableJson', params);
		const shown = (JSON.parse(sample) as { script_1: number }[]).map((doc) => doc.script_1);
		expect(shown).toEqual(page.rows.map((row) => row.cells[1]!.value));
		// A real sort: the longest name first.
		expect(shown[0]).toBe(Math.max(...shown));
		expect(new Set(shown).size).toBeGreaterThan(2);
	}, 60_000);
});

describe('an export through a transform', () => {
	type Shipped = { parts: ArrayBuffer[]; filename: string; script_errors: boolean };
	type Preview = {
		files: {
			filename: string;
			input: string;
			output: string | null;
			stdout: string;
			error: object | null;
		}[];
		split: boolean;
		truncated: boolean;
	};

	const NAMES = (tag: string) =>
		`# ${tag}\ndef transform(doc):\n    return {"names": [d["element_0"] for d in doc]}\n`;
	const PRINTS = (tag: string) =>
		`# ${tag}\ndef transform(doc):\n    print("rows", len(doc))\n    return doc\n`;
	const RAISING = (tag: string) => `# ${tag}\ndef transform(doc):\n    raise ValueError("no")\n`;
	const SPINNING = (tag: string) =>
		`# ${tag}\ndef transform(doc):\n    while True:\n        pass\n`;
	const FAILS = '# fails\ndef value(els):\n    raise ValueError("no")\n';

	const rows = { kind: 'scope', types: ['Node'], criteria: [] };
	const table = (extra: object = {}, columns: object[] = []) => ({
		row_source: rows,
		columns: [{ kind: 'element' }, ...columns],
		...extra
	});
	const params = (definition: object, format = 'json') => ({
		definition,
		format,
		date: '20240229',
		project: 'p'
	});
	const text = (file: Shipped) =>
		new TextDecoder().decode(
			new Uint8Array(file.parts.flatMap((part) => [...new Uint8Array(part)]))
		);
	const callsOf = (tracker: ReturnType<typeof tracked>, tag: string) =>
		tracker.batches
			.filter((batch) => batch.code.includes(`# ${tag}\n`))
			.reduce((sum, batch) => sum + batch.ids.length, 0);
	const names = (file: Shipped) => (JSON.parse(text(file)) as { names: string[] }).names;

	it('writes what the transform returns, and keeps the call for the document it was asked about', async () => {
		const { client, tracker } = await evaluating();
		const definition = table({ transform: { definition: { code: NAMES('names') } } });
		const first = await client.call<Shipped>('exportTable', params(definition));
		expect(names(first)).toContain('one');
		expect(first).toMatchObject({ filename: 'table.json', script_errors: false });
		expect(callsOf(tracker, 'names')).toBe(1);
		const second = await client.call<Shipped>('exportTable', params(definition));
		expect(text(second)).toBe(text(first));
		expect(callsOf(tracker, 'names')).toBe(1);
	}, 60_000);

	it('asks again for the document an edit staged changed, and for no other', async () => {
		const { client, tracker } = await evaluating();
		const definition = table({ transform: { definition: { code: NAMES('edited') } } });
		const before = await client.call<Shipped>('exportTable', params(definition));
		await stage(client, [rename('n1', 'uno')]);
		const after = await client.call<Shipped>('exportTable', params(definition));
		expect(names(after)).toContain('uno');
		expect(names(after)).not.toContain('one');
		expect(callsOf(tracker, 'edited')).toBe(2);
		await client.call('unstage', { what: 'all' });
		expect(text(await client.call<Shipped>('exportTable', params(definition)))).toBe(text(before));
		expect(callsOf(tracker, 'edited')).toBe(2);
	}, 60_000);

	it('refuses with 422 when the transform raises', async () => {
		const { client } = await evaluating();
		const definition = table({ transform: { definition: { code: RAISING('raises') } } });
		expect(await refusal(client.call('exportTable', params(definition)))).toEqual({
			status: 422,
			detail: 'table: transform failed (runtime): ValueError: no'
		});
	}, 60_000);

	it('refuses a transform that times out and does not keep the timeout', async () => {
		const { client, tracker } = await evaluating({ callMs: 300, graceMs: 500 });
		const definition = table({ transform: { definition: { code: SPINNING('spins') } } });
		for (let attempt = 1; attempt <= 2; attempt++) {
			const refused = await refusal(client.call('exportTable', params(definition)));
			expect(refused.status).toBe(422);
			expect(refused.detail).toMatch(/^table: transform failed \(timeout\): /);
			expect(callsOf(tracker, 'spins')).toBe(attempt);
		}
	}, 60_000);

	it('flags a file in which a script cell failed, and not one in which none did', async () => {
		const { client } = await evaluating();
		const column = { kind: 'script', snippet: { definition: { code: FAILS } } };
		const failing = await client.call<Shipped>('exportTable', params(table({}, [column]), 'csv'));
		expect(text(failing)).toContain('#ERROR');
		expect(failing.script_errors).toBe(true);
		const clean = await client.call<Shipped>('exportTable', params(table(), 'csv'));
		expect(clean.script_errors).toBe(false);
	}, 60_000);

	describe('run as an exporter', () => {
		const saved = (id: string, payload: object) => ({
			id,
			kind: 'table',
			name: id,
			artifact_rev: 1,
			payload
		});
		// A row source whose columns read a chain slot it does not have: the evaluation itself raises.
		const slotless = table({}, []);
		slotless.row_source = {
			kind: 'chains',
			navigation: {
				definition: {
					kind: 'path',
					start: { kind: 'scope', types: ['Node'], criteria: [] },
					steps: []
				}
			}
		} as never;
		slotless.columns = [{ kind: 'element', source: { kind: 'row', chain_index: 3 } }];
		const run = (client: Client, ...entries: object[]) =>
			client.call('runExporterDraft', {
				definition: { schema_version: 1, output: {}, entries },
				date: '20240229',
				project: 'p'
			});
		const withTransform = (tag: string) => ({ definition: { code: NAMES(tag) } });

		it('stops at the first entry that fails, as the oracle does: a later entry that raises does not replace it', async () => {
			const { client, tracker } = await evaluating();
			await client.call('setArtifacts', {
				artifacts: [saved('t_ok', table()), saved('t_slotless', slotless)]
			});
			// The first entry refuses for its own shape; the second, with a transform, raises in the evaluation.
			const shapeless = {
				source: { ref: 't_ok' },
				format: 'json',
				json_doc: { shape: 'object' }
			};
			const raising = {
				source: { ref: 't_slotless' },
				format: 'json',
				transform: withTransform('later')
			};
			expect(await refusal(run(client, shapeless, raising))).toEqual({
				status: 422,
				detail: "t_ok: json_doc.shape 'object' requires key_column"
			});
			// Alone, the second entry is the refusal.
			expect(await refusal(run(client, raising))).toMatchObject({
				status: 422,
				detail: expect.stringContaining('chain_index 3 out of range') as unknown as string
			});
			expect(tracker.batches).toEqual([]);
		}, 60_000);

		it('refuses every transform that does not parse in one list, whatever an entry before it raised', async () => {
			const { client } = await evaluating();
			await client.call('setArtifacts', { artifacts: [saved('t_slotless', slotless)] });
			const raising = {
				source: { ref: 't_slotless' },
				format: 'json',
				transform: withTransform('first')
			};
			const unparsed = (tag: string) => ({
				source: { ref: 't_slotless' },
				name: tag,
				format: 'json',
				transform: { definition: { code: `# ${tag}\ndef transform(doc:\n    return doc\n` } }
			});
			expect(await refusal(run(client, raising, unparsed('second'), unparsed('third')))).toEqual({
				status: 422,
				detail:
					'invalid transform for entries: second: transform code does not parse; third: transform code does not parse'
			});
		}, 60_000);
	});

	describe('previewed', () => {
		const saved = (payload: object) => [
			{ id: 't_nodes', kind: 'table', name: 't_nodes', artifact_rev: 1, payload }
		];
		const preview = (client: Client, code: string, extra: object = {}) =>
			client.call<Preview>('previewTransform', {
				entry: {
					source: { ref: 't_nodes' },
					format: 'json',
					transform: { definition: { code } },
					...extra
				},
				date: '20240229',
				project: 'p'
			});

		it('shows the document, what the transform made of it and what it printed', async () => {
			const { client } = await evaluating();
			await client.call('setArtifacts', { artifacts: saved(table()) });
			const body = await preview(client, PRINTS('shows'));
			expect(body).toMatchObject({ split: false, truncated: false });
			expect(body.files).toHaveLength(1);
			const [file] = body.files;
			expect(file).toMatchObject({ filename: 't_nodes.json', error: null });
			expect(file!.output).toBe(file!.input);
			expect(file!.stdout).toMatch(/^rows \d+\n$/);
			expect(Object.keys(body)).toEqual(['files', 'split', 'truncated']);
			expect(Object.keys(file!)).toEqual(['filename', 'input', 'output', 'stdout', 'error']);
		}, 60_000);

		it('answers a transform that fails as the file`s own error, and a refused entry as 422', async () => {
			const { client } = await evaluating();
			await client.call('setArtifacts', { artifacts: saved(table()) });
			const body = await preview(client, RAISING('previewed'));
			expect(body.files[0]).toMatchObject({
				output: null,
				error: { kind: 'runtime', message: 'ValueError: no' }
			});
			expect(await refusal(preview(client, 'x = 1\n'))).toMatchObject({
				status: 422,
				detail: 't_nodes: transform code does not define a one-argument top-level transform(doc)'
			});
			expect(await refusal(preview(client, PRINTS('format'), { format: 'csv' }))).toMatchObject({
				status: 422,
				detail: "t_nodes: transform is only supported for JSON-family formats, not 'csv'"
			});
		}, 60_000);
	});
});

describe('a round settled in slices', () => {
	// More rows than one settle step, so the settle of a round spans two scan steps.
	const EXTRA = SETTLE_STEP + 44;
	const wideModel = () =>
		loadLines(
			doc,
			[
				...fixture.elements,
				...Array.from(
					{ length: EXTRA },
					(_, i) => `{"id":"x${i}","type_name":"Node","properties":{"name":"x${i}"},"rev":0}`
				)
			],
			fixture.relationships
		);
	const NAMED = (tag: string) => `# ${tag}\ndef value(els):\n    return str(els[0].name)\n`;
	const params = (tag: string) => ({
		definition: {
			row_source: { kind: 'scope', types: ['Node'], criteria: [] },
			columns: [
				{ kind: 'element' },
				{ kind: 'script', snippet: { definition: { code: NAMED(tag) } } }
			]
		},
		limit: EXTRA + 10
	});
	type TablePage = { rows: { key: unknown[]; cells: { value?: unknown }[] }[]; total: number };
	const valueOf = (page: TablePage, id: string) =>
		page.rows.find((row) => row.key[0] === id)!.cells[1]!.value;
	const callsOf = (tracker: ReturnType<typeof tracked>, tag: string) =>
		tracker.batches
			.filter((batch) => batch.code.includes(`# ${tag}\n`))
			.reduce((sum, batch) => sum + batch.ids.length, 0);
	const verified = (event: Client['events'][number]) =>
		event.event === 'progress' && event.task === 'verify' && event.done === event.total;

	/**
	 * A service whose replica is open and idle, over a host whose every unit of work ends a slice.
	 * The first batch of the evaluation is held back until `release`; the slices after it wait for
	 * `turn`, and `slice` resolves at the next one.
	 */
	async function held(tag: string) {
		const host = fakeHost({ tick: 10 });
		host.auto = true;
		const tracker = tracked();
		trackers.push(tracker);
		const gate: { slice: (() => void) | null } = { slice: null };
		const client = connect(host, portPair(), {
			scripts: tracker.factory,
			yieldToHost: () => {
				const hit = gate.slice;
				gate.slice = null;
				const turn = host.deps.yieldToHost();
				hit?.();
				return turn;
			}
		});
		await openReplica(client, wideModel(), doc);
		await client.nextEvent(verified);
		await settle();
		let release!: () => void;
		let arrived!: () => void;
		const releasing = new Promise<void>((resolve) => (release = resolve));
		const reached = new Promise<void>((resolve) => (arrived = resolve));
		tracker.hook.after = async () => {
			tracker.hook.after = null;
			arrived();
			await releasing;
		};
		const answered = client.call<TablePage>('evaluateTable', params(tag));
		// The answer may be refused before anyone awaits it.
		answered.catch(() => undefined);
		await reached;
		await settle();
		return {
			host,
			tracker,
			client,
			answered,
			/** Lets the fill settle its round, and resolves at the first slice that ends. */
			release: () => {
				const sliced = new Promise<void>((resolve) => (gate.slice = resolve));
				host.auto = false;
				release();
				return sliced;
			}
		};
	}

	it('answers an edit staged during a settle after the settle, which evicts a cell that was put before it', async () => {
		const { host, tracker, client, answered, release } = await held('mid');
		await release();
		let landed = false;
		const staged = stage(client, [rename('n1', 'uno')]).then((out) => ((landed = true), out));
		await settle();
		// The stage waits behind the settle, which has settled one step of its two.
		expect(landed).toBe(false);
		host.turn();
		await settle();
		// The settle's second step has run; the stage is next.
		expect(landed).toBe(false);
		host.auto = true;
		host.turn();
		await staged;
		const page = await answered;
		expect(valueOf(page, 'n1')).toBe('uno');
		expect(valueOf(page, 'n2')).toBe('two');
		expect(valueOf(page, 'x0')).toBe('x0');
		// The round it spanned was kept for every row but the edited one, which asked again.
		expect(callsOf(tracker, 'mid')).toBe(page.total + 1);
		expect(valueOf(await client.call<TablePage>('evaluateTable', params('mid')), 'n1')).toBe('uno');
		expect(callsOf(tracker, 'mid')).toBe(page.total + 1);
	}, 120_000);

	it('keeps no cell of a settle that its replica was dropped under', async () => {
		const { host, tracker, client, answered, release } = await held('drop');
		await release();
		// A second open drops the replica between the two steps of the settle.
		const opening = client.call('open', { project_id: 'demo', metamodel: doc });
		await settle();
		host.auto = true;
		host.turn();
		await opening;
		expect(await refusal(answered)).toEqual({ status: 409, detail: 'replica closed' });
		const chunks = gzChunks(snapshotText(wideModel()), 1 << 16).map((bytes) =>
			client.call('chunk', { bytes }, [bytes])
		);
		await client.call('end');
		await Promise.all(chunks);
		const ready = client.nextEvent((event) => event.event === 'replica' && event.state === 'ready');
		await client.call('applyTail', { text: tailText([], 0) });
		await ready;
		const page = await client.call<TablePage>('evaluateTable', params('drop'));
		expect(valueOf(page, 'n1')).toBe('one');
		// The new replica found nothing of the half-settled round: every call ran again.
		expect(callsOf(tracker, 'drop')).toBe(2 * page.total);
	}, 120_000);
});
