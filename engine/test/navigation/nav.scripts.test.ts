import { afterAll, describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	DEFAULT_LIMITS,
	drain,
	evaluateFilled,
	evaluateNavigation,
	evaluateSteps,
	Meter,
	PENDING,
	PropertyValue,
	PyFloat,
	ReadError,
	readNavigation,
	ScriptWarningLog,
	ViewPlacements,
	type BatchRunner,
	type ChainNode,
	type ChainPageOut,
	type EvalContext,
	type Model,
	type ScriptBatch,
	type ScriptHost
} from '../../src/index.ts';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../../src/script/bridge.ts';
import { nodeScriptHost } from '../../node/script-host.ts';
import { thrown } from '../golden/thrown.ts';
import { family } from '../model/fixtures.ts';
import { NO_SCRIPTS } from '../../src/evaluate/fill.ts';

// The script step over real Pyodide in real worker threads, on the small `family` model.

const hosts: ScriptHost[] = [];
afterAll(() => hosts.forEach((host) => host.dispose()));
const host = nodeScriptHost();
hosts.push(host);

function runnerOver(model: Model, seen: ScriptBatch[] = []): BatchRunner {
	return async (batch, signal) => {
		seen.push(batch);
		const dispatcher = new BridgeDispatcher(model, false);
		const run = await host.run(
			batch,
			{
				dispatch: (text) => dispatcher.dispatch(text),
				roots: (ids) => dumpDefault(projectRoots(model, ids))
			},
			signal
		);
		return run.results.map((one) => one.text);
	};
}

const options = (runner: BatchRunner) => ({ runner, signal: new AbortController().signal });
const step = (code: string) => ({
	kind: 'script',
	snippet: { definition: { code: `def step(el):\n${code}\n` } }
});
const path = (...steps: object[]) => ({ kind: 'path', start: { kind: 'scope' }, steps });
const fromRow = (...steps: object[]) => ({ kind: 'path', start: { kind: 'row' }, steps });
const REFERS = '    return [r.destination().id for r in el.outgoing(stereotype="Refers")]';
const CONTAINS = '    return [r.destination().id for r in el.outgoing(stereotype="Contains")]';

function evaluated(model: Model, definition: object, seen: ScriptBatch[] = []) {
	const context: EvalContext = {
		model,
		artifacts: new ArtifactSet(),
		placements: new ViewPlacements(),
		scripts: NO_SCRIPTS
	};
	return evaluateFilled(
		(scripts) =>
			Promise.resolve(
				drain(evaluateNavigation({ ...context, scripts }, { definition })) as ChainPageOut
			),
		options(runnerOver(model, seen))
	);
}

const idsOf = (page: ChainPageOut) =>
	page.chains.map((chain) => chain.map((item) => ('id' in item ? item.id : item.value)));

describe('a script step through the route', () => {
	it('hops to the elements the snippet names, one batch for all of a step', async () => {
		const seen: ScriptBatch[] = [];
		const { value, stats } = await evaluated(family(), path(step(CONTAINS)), seen);
		expect(idsOf(value)).toEqual([
			['a', 'b'],
			['b', 'd']
		]);
		expect(value.warnings).toEqual([]);
		expect(stats).toEqual({ rounds: 1, calls: 4 });
		expect(seen.map((batch) => batch.calls.length)).toEqual([4]);
	}, 60_000);

	it('takes a round for each step of a chain whose steps run different code', async () => {
		const { value, stats } = await evaluated(family(), path(step(CONTAINS), step(REFERS)));
		expect(idsOf(value)).toEqual([]);
		expect(stats.rounds).toBe(2);
		const same = await evaluated(family(), path(step(CONTAINS), step(CONTAINS)));
		expect(idsOf(same.value)).toEqual([['a', 'b', 'd']]);
		// The second step's calls were answered with the first's.
		expect(same.stats.rounds).toBe(1);
	}, 60_000);

	it('reports a failing snippet as a warning and prunes', async () => {
		const { value } = await evaluated(family(), path(step('    raise ValueError("no " + el.id)')));
		expect(value.chains).toEqual([]);
		expect(value.warnings.map((w) => [w.code, w.occurrences, w.detail])).toEqual(
			['a', 'b', 'c', 'd'].map((id) => ['nav_step_failed', 1, `ValueError: no ${id}`])
		);
	}, 60_000);

	it('reports a dangling snippet ref once per element it meets', async () => {
		const ref = { kind: 'script', snippet: { ref: 'gone' } };
		const { value, stats } = await evaluated(family(), path(ref));
		expect(value.warnings).toEqual([
			{ code: 'nav_snippet_not_found', occurrences: 4, total: 0, detail: 'gone' }
		]);
		expect(stats.calls).toBe(0);
	}, 60_000);
});

describe('a script step among the values it returns', () => {
	const model = family();
	const nodes = async (code: string): Promise<ChainNode[]> => {
		const defn = readNavigation(fromRow(step(code)), 'd');
		const { value } = await evaluateFilled(
			(scripts) =>
				Promise.resolve(
					drain(
						evaluateSteps(
							model.metamodel,
							model,
							defn,
							DEFAULT_LIMITS,
							['a'],
							new Meter(DEFAULT_LIMITS.maxVisited),
							{ reader: scripts, warnings: new ScriptWarningLog() }
						)
					).chains.map((chain) => chain[1]!)
				),
			options(runnerOver(model))
		);
		return value;
	};

	it('keeps the first place of an equal value, and its last value', async () => {
		// As a dict keyed by `(type name, value)` does: `0.0 == -0.0`, so one entry, holding `-0.0`.
		const [signed, ...rest] = await nodes('    return [0.0, 1, -0.0, True, 1.0]');
		expect(signed).toBeInstanceOf(PropertyValue);
		const zero = (signed as PropertyValue).value as PyFloat;
		expect(Object.is(zero.value, -0)).toBe(true);
		expect(rest.map((node) => (node as PropertyValue).key)).toEqual([
			'int:1',
			'bool:true',
			'float:1'
		]);
	}, 60_000);

	it('tells an id from a value by what the model holds', async () => {
		const got = await nodes('    return ["b", "B", "zz", 3, None, ["x"][0]]');
		expect(got.map((node) => (typeof node === 'string' ? node : node.key))).toEqual([
			'b',
			'str:B',
			'str:zz',
			'int:3',
			'str:x'
		]);
	}, 60_000);

	it('writes a non-finite float as its repr, after telling it from a string', async () => {
		const got = await nodes('    return [float("nan"), "nan", float("inf"), float("-inf")]');
		expect(got.map((node) => (node as PropertyValue).value)).toEqual(['nan', 'nan', 'inf', '-inf']);
	}, 60_000);
});

describe('evaluateSteps with scripts', () => {
	const model = family();
	const run = (definition: object, scripts: Parameters<typeof evaluateSteps>[6]) =>
		evaluateSteps(
			model.metamodel,
			model,
			readNavigation(definition, 'd'),
			DEFAULT_LIMITS,
			null,
			undefined,
			scripts
		);
	const reader = { read: () => PENDING };

	it('refuses an inline snippet with no code before the first step, nested ones too', () => {
		const empty = { kind: 'script', snippet: { definition: {} } };
		const nested = {
			kind: 'set_op',
			op: 'union',
			operands: [{ definition: path(empty) }]
		};
		for (const definition of [path(empty), nested, { ...path(), start: nested }]) {
			const error = thrown(() => run(definition, { reader, warnings: new ScriptWarningLog() }));
			expect(error).toBeInstanceOf(ReadError);
			expect((error as ReadError).status).toBe(422);
		}
		expect(thrown(() => run(path(empty), null))).toBeUndefined();
	});

	it('answers a pending call as a failure, for a fill to discard the pass', () => {
		const warnings = new ScriptWarningLog();
		const result = drain(run(path(step(CONTAINS)), { reader, warnings }));
		expect(result.chains).toEqual([]);
		expect(result.warnings).toEqual([
			{ code: 'nav_step_failed', occurrences: 4, total: 0, detail: 'not computed yet' }
		]);
	});

	it('prunes a configured step silently when there is nothing to read scripts through', () => {
		const result = drain(run(path(step(REFERS), { kind: 'script', snippet: { ref: 'x' } }), null));
		expect(result.chains).toEqual([]);
		expect(result.warnings).toEqual([]);
	});
});
