import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../../src/script/bridge.ts';
import type { ScriptBatch } from '../../src/script/host.ts';
import { createGuest, type Guest, type Interpreter } from '../../src/script/guest.ts';
import { loadInterpreter } from '../../node/script-host.ts';
import { expectParity, loadParity, parityBatch, parityModel, parityRoots } from './parity.ts';

let py: Interpreter;
let dispatcher: BridgeDispatcher;
let guest: Guest;

beforeAll(async () => {
	py = await loadInterpreter();
}, 60_000);

// Every guest binds its globals in `py`, so a test that makes another leaves the next one a fresh one.
beforeEach(() => {
	guest = createGuest(py, (text) => dispatcher.dispatch(text));
});

const rootsOf = (ids: string[]) => dumpDefault(projectRoots(parityModel(), ids));

function batchOf(
	code: string,
	ids: string[][],
	entry: ScriptBatch['entry'] = 'value'
): ScriptBatch {
	return { code, entry, calls: ids.map((elementIds) => ({ elementIds })) };
}

function runOn(batch: ScriptBatch, g: Guest = guest) {
	dispatcher = new BridgeDispatcher(parityModel(), batch.entry === 'script' || !!batch.console);
	return g.run(
		batch,
		batch.calls.map((call) => rootsOf([...call.elementIds]))
	);
}

type Answer = { payload: unknown; error: { kind: string; message: string } | null; stdout: string };
const answers = (batch: ScriptBatch) => runOn(batch).map((r) => JSON.parse(r.text) as Answer);

describe('the guest answers the parity corpus, text for text', () => {
	// The determinism group is held on the pool's workers, which pin the clock, the entropy and the hash seed.
	const cases = loadParity().filter((c) => c.group !== 'determinism');

	it('has cases to run', () => {
		expect(cases.length).toBeGreaterThan(30);
	});

	for (const c of cases) {
		it(`${c.group}/${c.name}`, () => {
			const batch = parityBatch(c);
			dispatcher = new BridgeDispatcher(parityModel(), c.mode === 'console');
			const results = guest.run(batch, parityRoots(c, batch));
			expectParity(c, results, dumpDefault(dispatcher.ops));
		});
	}
});

describe('the guest over the harness', () => {
	it('reports each call as it starts and ends, in order', () => {
		const events: string[] = [];
		const batch = batchOf('def value(els): return els[0].id', [['n1'], ['n2'], ['n3']]);
		dispatcher = new BridgeDispatcher(parityModel(), false);
		guest.run(
			batch,
			batch.calls.map((call) => rootsOf([...call.elementIds])),
			{ callStart: (i) => events.push(`start ${i}`), callEnd: (i) => events.push(`end ${i}`) }
		);
		expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
	});

	it('reports the hooks of a call that raises, and of a failed boot', () => {
		const events: string[] = [];
		const hooks = {
			callStart: (i: number) => events.push(`s${i}`),
			callEnd: (i: number) => events.push(`e${i}`)
		};
		for (const code of ['def value(els): raise ValueError("x")', 'raise KeyError("boot")']) {
			const batch = batchOf(code, [['n1'], ['n2']]);
			dispatcher = new BridgeDispatcher(parityModel(), false);
			guest.run(batch, ['[]', '[]'], hooks);
		}
		expect(events).toEqual(['s0', 'e0', 's1', 'e1', 's0', 'e0', 's1', 'e1']);
	});

	it('takes no hooks and does not keep the last ones', () => {
		const events: number[] = [];
		const batch = batchOf('def value(els): return 1', [['n1']]);
		dispatcher = new BridgeDispatcher(parityModel(), false);
		guest.run(batch, ['[]'], { callStart: (i) => events.push(i) });
		guest.run(batch, ['[]']);
		expect(events).toEqual([0]);
	});

	it('gives each batch its own globals', () => {
		answers(batchOf('counter = 41\ndef value(els): return counter', [['n1']]));
		const [after] = answers(
			batchOf('def value(els): return globals().get("counter", "absent")', [['n1']])
		);
		expect(after?.payload).toEqual({ kind: 'scalar', value: 'absent' });
	});

	it('answers a module-level exit as the boot error of every call, and keeps serving', () => {
		const out = answers(batchOf('import sys\nsys.exit(3)', [['n1'], ['n2']]));
		expect(out.map((one) => one.error?.message)).toEqual(['SystemExit: 3', 'SystemExit: 3']);
		const [after] = answers(batchOf('def value(els): return els[0].id', [['n1']]));
		expect(after?.error).toBeNull();
	});

	it('hands a MemoryError to the host and serves the next batch', () => {
		const batch = batchOf('def value(els): raise MemoryError("out")', [['n1']]);
		expect(() => runOn(batch)).toThrow(/MemoryError/);
		const [after] = answers(batchOf('def value(els): return els[0].id\nprint("fine")', [['n1']]));
		expect(after?.error).toBeNull();
		expect(after?.stdout).toBe('fine\n');
	});

	it('refuses a batch whose root texts do not match its calls', () => {
		expect(() =>
			guest.run({ code: '', entry: 'value', calls: [{ elementIds: ['n1'] }] }, [])
		).toThrow(/1 calls but 0 root texts/);
	});

	it('honours the limits it was made with', () => {
		const small = createGuest(py, (text) => dispatcher.dispatch(text), {
			stdoutChars: 5,
			reprChars: 4,
			readMemoMax: 4096
		});
		const batch: ScriptBatch = {
			code: 'print("abcdefghij")\nresult = "wxyz012345"\n',
			entry: 'script',
			calls: [{ elementIds: [] }]
		};
		const [one] = runOn(batch, small);
		expect(JSON.parse(one!.text)).toEqual({
			stdout: 'abcde...',
			result_repr: "'wxy...",
			truncated: true
		});
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
		const spied = createGuest(spy, (text) => dispatcher.dispatch(text));
		const batch = batchOf('def value(els): return len(els[0].outgoing())', [['n1']]);
		for (let i = 0; i < 3; i++) runOn(batch, spied);
		expect(taken).toBeGreaterThanOrEqual(3);
		expect(destroyed).toBe(taken);
	});
});
