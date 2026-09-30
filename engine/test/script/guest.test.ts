import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PyFloat, type MetamodelDoc } from '../../src/index.ts';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../../src/script/bridge.ts';
import type { Bridge, ScriptBatch, ScriptHost, ScriptRun } from '../../src/script/host.ts';
import { createGuest, type Interpreter } from '../../src/script/guest.ts';
import { loadInterpreter, nodeScriptHost } from '../../node/script-host.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';

type Fixture = { metamodel: MetamodelDoc; elements: string[]; relationships: string[] };

const fixture = loadFixture<Fixture>('script_bridge');
const model = loadLines(fixture.metamodel, fixture.elements, fixture.relationships);
const dispatcher = new BridgeDispatcher(model, false);
const bridge: Bridge = {
	dispatch: (text) => dispatcher.dispatch(text),
	roots: (ids) => dumpDefault(projectRoots(model, ids))
};

let host: ScriptHost;
let bootMs = 0;

beforeAll(async () => {
	host = nodeScriptHost(bridge);
	bootMs = (await host.boot()).ms;
	console.info(`pyodide boot: ${Math.round(bootMs)} ms`);
}, 60_000);

afterAll(() => {
	host.dispose();
});

function one(code: string, ids: string[], entry: ScriptBatch['entry'] = 'value') {
	return host.run({ code, entry, calls: [{ elementIds: ids }] });
}

function parsed(run: ScriptRun, index = 0): { payload: unknown; reads: unknown } {
	const result = run.results[index];
	expect(result?.error, 'error').toBeNull();
	return JSON.parse(result?.text ?? 'null');
}

describe('the guest runs a script batch over the ported bridge', () => {
	it('answers a scalar from the roots without a trip', async () => {
		const code = 'def value(els): return els[0].name';
		const batch: ScriptBatch = {
			code,
			entry: 'value',
			calls: [{ elementIds: ['n1'] }, { elementIds: ['n2'] }]
		};
		const run = await host.run(batch);
		expect(run.trips).toBe(0);
		expect(run.ms).toBeGreaterThanOrEqual(0);
		expect(run.results[0]?.text).toBe(
			'{"payload": {"kind": "scalar", "value": "one"}, "reads": [["el", "n1"]]}'
		);
		expect(run.results[1]?.text).toBe(
			'{"payload": {"kind": "scalar", "value": "two"}, "reads": [["el", "n2"]]}'
		);
		expect(run.results.every((r) => r.error === null)).toBe(true);
	});

	it('takes a trip for what the roots do not carry', async () => {
		const run = await one('def value(els): return len(els[0].outgoing())', ['n1']);
		expect(parsed(run).payload).toEqual({ kind: 'scalar', value: 5 });
		expect(run.trips).toBeGreaterThanOrEqual(1);
	});

	it('walks relationships in code-point id order', async () => {
		const run = await one(
			'def value(els): return [r.destination().name for r in els[0].outgoing()]',
			['n1']
		);
		expect(parsed(run).payload).toEqual({
			kind: 'scalars',
			values: ['two', 'listed', 'two', null, 'Upper']
		});
	});

	it('runs the step entry', async () => {
		const run = await one('def step(el): return el.children()', ['n1'], 'step');
		expect(parsed(run).payload).toEqual({ nodes: ['l1', 'n2', 'n2'] });
	});

	it('runs the transform entry over a document, with no roots sent', async () => {
		const run = await host.run({
			code: "def transform(doc): return {'a': doc['a'], 'k': [1, 2.0]}",
			entry: 'transform',
			calls: [{ elementIds: [], doc: { a: 1 } }]
		});
		expect(run.trips).toBe(0);
		expect(run.results[0]?.text).toBe(
			'{"payload": {"kind": "json", "value": {"a": 1, "k": [1, 2.0]}}, "reads": []}'
		);
	});

	it('keeps floats, ints, big ints and astral text apart', async () => {
		const run = await one(
			`def value(els): return [type(els[0]["f"]).__name__, type(els[0]["i"]).__name__, els[0]["big"] == 2**60, els[0]["s"]]`,
			['n3']
		);
		expect(parsed(run).payload).toEqual({
			kind: 'scalars',
			values: ['float', 'int', true, '😀']
		});
		expect(run.results[0]?.text).toContain('"\\ud83d\\ude00"');
	});

	it('reports the reads of a call that listed outgoing relationships', async () => {
		const run = await one('def value(els): return len(els[0].outgoing())', ['n2']);
		expect(parsed(run).reads).toEqual([
			['el', 'n2'],
			['out', 'n2']
		]);
	});

	it('reports a raising call and runs the next', async () => {
		const run = await host.run({
			code: 'def value(els):\n    if els[0].name == "one":\n        raise ValueError("x")\n    return els[0].name',
			entry: 'value',
			calls: [{ elementIds: ['n1'] }, { elementIds: ['n2'] }]
		});
		expect(run.results[0]).toEqual({ text: null, error: 'ValueError: x' });
		expect(run.results[1]?.error).toBeNull();
		expect(JSON.parse(run.results[1]?.text ?? '').payload).toEqual({
			kind: 'scalar',
			value: 'two'
		});
	});

	it('reports a missing element as NotFoundError', async () => {
		const run = await one('def value(els): return els[0].name', ['nope']);
		expect(run.results[0]?.text).toBeNull();
		expect(run.results[0]?.error).toMatch(/^NotFoundError/);
	});

	it('does not let a batch bring the host down', async () => {
		const calls = [{ elementIds: ['n1'] }, { elementIds: ['n2'] }];
		const bad: { name: string; code: string; error: RegExp }[] = [
			{ name: 'syntax error', code: 'def value(els) return 1', error: /^SyntaxError/ },
			{ name: 'module-level raise', code: 'raise KeyError("boot")', error: /^KeyError/ },
			{ name: 'module-level exit', code: 'import sys\nsys.exit(3)', error: /^SystemExit/ },
			{ name: 'missing entry', code: 'def other(els): return 1', error: /^NameError/ }
		];
		for (const { name, code, error } of bad) {
			const run = await host.run({ code, entry: 'value', calls });
			expect(run.results, name).toHaveLength(2);
			for (const result of run.results) {
				expect(result.text, name).toBeNull();
				expect(result.error, name).toMatch(error);
			}
		}
		const after = await one('def value(els): return els[0].name', ['n1']);
		expect(after.results[0]?.error).toBeNull();
	});

	it('reports a call that exits without failing its batch', async () => {
		const run = await host.run({
			code: 'def value(els):\n    raise SystemExit(2)',
			entry: 'value',
			calls: [{ elementIds: ['n1'] }]
		});
		expect(run.results[0]?.error).toMatch(/^SystemExit/);
	});

	it('gives each batch its own globals', async () => {
		await one('counter = 41\ndef value(els): return counter', ['n1']);
		const run = await one('def value(els): return globals().get("counter", "absent")', ['n1']);
		expect(parsed(run).payload).toEqual({ kind: 'scalar', value: 'absent' });
	});

	it('sends a document and inputs to the script as the caller wrote them', async () => {
		const transform = await host.run({
			code: 'def transform(doc): return doc',
			entry: 'transform',
			calls: [{ elementIds: [], doc: { f: new PyFloat(1), i: 1, big: 2n ** 60n, s: '😀' } }]
		});
		expect(JSON.parse(transform.results[0]?.text ?? '').payload.value.s).toBe('😀');
		expect(transform.results[0]?.text).toBe(
			'{"payload": {"kind": "json", "value": {"f": 1.0, "i": 1, "big": 1152921504606846976, "s": "\\ud83d\\ude00"}}, "reads": []}'
		);
		const withInputs = await host.run({
			code: 'def value(els, inputs): return [inputs["e"][0].name, len(inputs["x"]), els[0].name]',
			entry: 'value',
			calls: [
				{
					elementIds: ['n1'],
					inputs: {
						x: { kind: 'values', values: [1, new PyFloat(2.5)] },
						e: { kind: 'elements', ids: ['n2'] }
					}
				}
			]
		});
		expect(parsed(withInputs).payload).toEqual({ kind: 'scalars', values: ['two', 2, 'one'] });
	});
});

describe('the guest on its own interpreter', () => {
	let py: Interpreter;

	beforeAll(async () => {
		py = await loadInterpreter();
	}, 60_000);

	it('refuses a batch whose root texts do not match its calls', () => {
		const guest = createGuest(py, (text) => bridge.dispatch(text));
		expect(() =>
			guest.run({ code: '', entry: 'value', calls: [{ elementIds: ['n1'] }] }, [])
		).toThrow(/1 calls but 0 root texts/);
	});

	it('destroys every proxy it takes from the interpreter', () => {
		let taken = 0;
		let destroyed = 0;
		const spy: Interpreter = {
			runPython: (code) => py.runPython(code),
			globals: {
				set: (name, value) => py.globals.set(name, value),
				get(name) {
					const value = py.globals.get(name);
					if (typeof value === 'function' || (typeof value === 'object' && value !== null)) {
						const proxy = value as { destroy?: () => void };
						const destroy = proxy.destroy?.bind(proxy);
						if (destroy !== undefined) {
							taken++;
							proxy.destroy = () => {
								destroyed++;
								destroy();
							};
						}
					}
					return value;
				}
			}
		};
		const guest = createGuest(spy, (text) => bridge.dispatch(text));
		const code = 'def value(els): return len(els[0].outgoing())';
		for (let i = 0; i < 3; i++)
			guest.run({ code, entry: 'value', calls: [{ elementIds: ['n1'] }] }, [bridge.roots(['n1'])]);
		expect(taken).toBeGreaterThanOrEqual(3);
		expect(destroyed).toBe(taken);
	});
});
