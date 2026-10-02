import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MetamodelDoc, ModelOp, RunSnippetResult } from '../../src/index.ts';
import type { ScriptHostFactory } from '../../src/script/host.ts';
import { cappedNodeScriptHost } from '../../node/script-host.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';
import { autoHost, connect, openReplica, portPair, refusal, type Client } from './helpers.ts';

type Fixture = { metamodel: MetamodelDoc; elements: string[]; relationships: string[] };

const fixture = loadFixture<Fixture>('script_bridge');
const doc = fixture.metamodel;
const model = () => loadLines(doc, fixture.elements, fixture.relationships);

const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

const disposers: (() => void)[] = [];
let started: () => void = () => undefined;

/** The capped Node host, announcing each run's start. */
const factory: ScriptHostFactory = (...args) => {
	const host = cappedNodeScriptHost(2)(...args);
	disposers.push(() => host.dispose());
	return {
		...host,
		boot: () => host.boot(),
		prewarm: () => host.prewarm(),
		warmed: (signal) => host.warmed(signal),
		run(batch, bridge, signal) {
			started();
			return host.run(batch, bridge, signal);
		},
		dispose: () => host.dispose()
	};
};

describe('runSnippet without a script host', () => {
	it('is refused 501', async () => {
		const client = connect();
		await openReplica(client, model(), doc);
		expect(await refusal(client.call('runSnippet', { code: 'result = 1' }))).toEqual({
			status: 501,
			detail: 'scripts are not available'
		});
	});
});

describe('runSnippet', () => {
	let client: Client;
	beforeAll(async () => {
		client = connect(autoHost(), portPair(), { scripts: factory });
		await openReplica(client, model(), doc);
	}, 60_000);
	afterAll(() => disposers.forEach((dispose) => dispose()));

	it("answers today's shape over the working copy", async () => {
		await client.call('stage', { ops: [rename('n1', 'uno')] });
		const result = await client.call<RunSnippetResult>('runSnippet', {
			code: 'result = dr.element("n1").name',
			entry: 'script'
		});
		expect(result).toMatchObject({
			stdout: '',
			result_repr: "'uno'",
			ops: [],
			error: null,
			truncated: false
		});
		expect(result.duration_ms).toBeGreaterThanOrEqual(0);
		expect(result.stamp).toEqual({ rev: expect.any(Number), staged: expect.any(Number) });
		expect(result.stamp.staged).toBeGreaterThan(0);
		await client.call('unstage', { what: 'all' });
		const after = await client.call<RunSnippetResult>('runSnippet', {
			code: 'result = dr.element("n1").name'
		});
		expect(after.result_repr).toBe("'one'");
		expect(after.stamp.rev).toBe(result.stamp.rev);
	}, 60_000);

	it('runs a value entry on its elements with inputs', async () => {
		const result = await client.call<RunSnippetResult>('runSnippet', {
			code: 'def value(els, inputs):\n    return [els[0].name, inputs["x"][0]]',
			entry: 'value',
			element_ids: ['n1'],
			inputs: { x: { kind: 'scalars', values: [5] } }
		});
		expect(result.error).toBeNull();
		expect(result.result_repr).toBe("['one', 5]");
		expect(result.ops).toEqual([]);
	}, 60_000);

	it('proposes ops and applies none', async () => {
		const result = await client.call<RunSnippetResult>('runSnippet', {
			code: 'dr.element("n1").set("name", "x")'
		});
		expect(result.error).toBeNull();
		expect(result.ops).toHaveLength(1);
		expect(result.ops[0]).toMatchObject({ kind: 'update_element', id: 'n1' });
		const element = await client.call<{ properties: { name: string } }>('getElement', {
			id: 'n1'
		});
		expect(element.properties.name).toBe('one');
	}, 60_000);

	it('runs a saved snippet by artifact_id', async () => {
		await client.call('setArtifacts', {
			artifacts: [
				{
					id: 'snip',
					kind: 'code_snippet',
					name: 's',
					artifact_rev: 1,
					payload: { code: 'result = 40 + 2' }
				},
				{
					id: 'other',
					kind: 'note',
					name: 'o',
					artifact_rev: 1,
					payload: {}
				}
			]
		});
		const result = await client.call<RunSnippetResult>('runSnippet', { artifact_id: 'snip' });
		expect(result.result_repr).toBe('42');
		expect(await refusal(client.call('runSnippet', { artifact_id: 'other' }))).toMatchObject({
			status: 422
		});
	}, 60_000);

	it('answers 404 for an unknown artifact_id', async () => {
		expect(await refusal(client.call('runSnippet', { artifact_id: 'nope' }))).toEqual({
			status: 404,
			detail: 'snippet not found'
		});
	});

	it('empties the ops and answers a runtime error for a forged non-model op', async () => {
		const result = await client.call<RunSnippetResult>('runSnippet', {
			code: '_transport({"id": 1, "op": {"kind": "create_artifact"}})'
		});
		expect(result.ops).toEqual([]);
		expect(result.error).toEqual({
			kind: 'runtime',
			message: 'the script proposed a create_artifact op, which is not a model op',
			traceback: null
		});
	}, 60_000);

	it('runs a step entry on one element', async () => {
		const result = await client.call<RunSnippetResult>('runSnippet', {
			code: 'def step(el):\n    return el.id',
			entry: 'step',
			element_ids: ['n1']
		});
		expect(result.error).toBeNull();
		expect(result.result_repr).toBe("'n1'");
	}, 60_000);

	it('refuses both code and artifact_id with 422', async () => {
		expect(
			await refusal(client.call('runSnippet', { code: 'x = 1', artifact_id: 'snip' }))
		).toEqual({ status: 422, detail: 'provide exactly one of `code` / `artifact_id`' });
	});

	it('answers a malformed forged op as a runtime error', async () => {
		const result = await client.call<RunSnippetResult>('runSnippet', {
			code: '_transport({"id": 1, "op": {"kind": "update_element"}})'
		});
		expect(result.ops).toEqual([]);
		expect(result.error?.kind).toBe('runtime');
		expect(result.error?.message).toContain('malformed op');
	}, 60_000);

	it('refuses a transform entry with console', async () => {
		expect(
			await refusal(
				client.call('scriptCalls', {
					code: 'def transform(doc): return doc',
					entry: 'transform',
					console: true,
					calls: [{ element_ids: [] }]
				})
			)
		).toEqual({ status: 422, detail: 'a console run has no transform entry' });
	});

	it('stops a runaway run on cancel and still answers a read', async () => {
		const begun = new Promise<void>((resolve) => (started = resolve));
		const answered = vi.fn();
		const running = client.callAs('runaway', 'runSnippet', { code: 'while True: pass' });
		running.then(answered, answered);
		await begun;
		client.cancel('runaway');
		const element = await client.call<{ properties: { name: string } }>('getElement', {
			id: 'n1'
		});
		expect(element.properties.name).toBe('one');
		expect(answered).not.toHaveBeenCalled();
	}, 90_000);
});
