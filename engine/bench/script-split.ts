/**
 * Where the time of 10,000 script cells goes in Node: the ten scripts of
 * `frontend/bench/main.ts` (`scripts()`) over 1,000 `Microservice` ids of model
 * M, through `nodeScriptHost`. Three passes each of
 *   - the real run (total, and the dispatcher's own time),
 *   - the same run with every reply canned (no dispatch: the Python side),
 *   - Python's `json` over the texts of one real pass, inside Pyodide,
 *   - a no-op post-and-wake round trip between two `worker_threads`.
 * Run from `engine/`: `pixi run -e frontend node --expose-gc
 * --disable-warning=ExperimentalWarning bench/script-split.ts` after
 * `pixi run engine-bench-data`. Timings drift between sessions.
 */
import { readFileSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { loadInterpreter, nodeScriptHost } from '../node/script-host.ts';
import { Metamodel, openSnapshot, type MetamodelDoc } from '../src/index.ts';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../src/script/bridge.ts';
import type { Bridge } from '../src/script/host.ts';

const BODIES = [
	'return els[0].name.upper()',
	'return len(els[0].outgoing())',
	'return len(els[0].incoming())',
	'p = els[0].parent(); return p.name if p else None',
	'return [r.destination().name for r in els[0].outgoing()][:5]',
	'return sum(len(r.destination().outgoing()) for r in els[0].outgoing())',
	"return els[0].get('status')",
	"return ', '.join(sorted(els[0].get('tags') or []))",
	"e = els[0]; return f'{e.stereotype}:{e.id}'",
	'return len(els[0].children())'
];
const PASSES = 3;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

if (!isMainThread) {
	// The "script worker": post a no-op request, block on a shared flag until it is answered.
	const { sab, trips } = workerData as { sab: SharedArrayBuffer; trips: number };
	const flag = new Int32Array(sab);
	parentPort!.once('message', () => {
		const t0 = performance.now();
		for (let i = 0; i < trips; i++) {
			Atomics.store(flag, 0, 0);
			parentPort!.postMessage('noop');
			Atomics.wait(flag, 0, 0);
		}
		parentPort!.postMessage({ done: performance.now() - t0 });
	});
	parentPort!.postMessage('ready');
} else {
	await main();
}

async function main(): Promise<void> {
	const dir = new URL('../../benchmarks/', import.meta.url);
	const bytes = readFileSync(new URL('large.snapshot.v2', dir));
	const doc = JSON.parse(
		readFileSync(new URL('large.snapshot.v2.metamodel.json', dir), 'utf-8')
	) as MetamodelDoc;
	function* cut(b: Uint8Array) {
		for (let at = 0; at < b.length; at += 1 << 20) yield b.subarray(at, at + (1 << 20));
	}
	const { workingCopy } = await openSnapshot(cut(bytes), Metamodel.fromJSON(doc));
	const model = workingCopy.model;
	const ids: string[] = [];
	for (const e of model.elements()) {
		if (e.typeName !== 'Microservice') continue;
		ids.push(e.id);
		if (ids.length === 1000) break;
	}
	if (ids.length < 1000) throw new Error(`only ${ids.length} Microservice elements`);
	const calls = ids.map((id) => ({ elementIds: [id] }));

	const dispatcher = new BridgeDispatcher(model, false);
	const canned = new Map<string, string>();
	const pairs: { req: string; rep: string }[] = [];
	const rootTexts: string[] = [];
	const resultTexts: string[] = [];
	let mode: 'real' | 'record' | 'canned' = 'real';
	let dispatchMs = 0;
	let lookupMs = 0;
	const bridge: Bridge = {
		dispatch(text) {
			const t0 = performance.now();
			if (mode === 'canned') {
				const rep = canned.get(text)!;
				lookupMs += performance.now() - t0;
				return rep;
			}
			const rep = dispatcher.dispatch(text);
			dispatchMs += performance.now() - t0;
			canned.set(text, rep);
			if (mode === 'record') pairs.push({ req: text, rep });
			return rep;
		},
		roots(list) {
			const text = dumpDefault(projectRoots(model, list));
			if (mode === 'record') rootTexts.push(text);
			return text;
		}
	};
	const host = nodeScriptHost(bridge);
	await host.boot();
	await host.run({
		code: 'def value(els):\n    return els[0].name\n',
		entry: 'value',
		calls: [calls[0]!]
	});

	async function pass(): Promise<{ trips: number; ms: number }> {
		let trips = 0;
		let ms = 0;
		for (const body of BODIES) {
			const run = await host.run({ code: `def value(els):\n    ${body}\n`, entry: 'value', calls });
			const failed = run.results.find((r) => r.error !== null);
			if (failed) throw new Error(String(failed.error));
			if (mode === 'record') for (const r of run.results) resultTexts.push(r.text!);
			trips += run.trips;
			ms += run.ms;
		}
		return { trips, ms };
	}

	const real: { trips: number; ms: number; dispatch: number }[] = [];
	for (let i = 0; i < PASSES; i++) {
		mode = i === 0 ? 'record' : 'real';
		dispatchMs = 0;
		real.push({ ...(await pass()), dispatch: dispatchMs });
	}
	mode = 'canned';
	const replay: { ms: number; lookup: number }[] = [];
	for (let i = 0; i < PASSES; i++) {
		lookupMs = 0;
		replay.push({ ...(await pass()), lookup: lookupMs });
	}
	host.dispose();
	const trips = real[0]!.trips;

	for (const r of real) {
		console.log(
			`real    trips ${r.trips} total ${r.ms.toFixed(0)} ms, dispatch ${r.dispatch.toFixed(0)} ms`
		);
	}
	for (const r of replay) {
		console.log(
			`canned  total ${r.ms.toFixed(0)} ms, lookup ${r.lookup.toFixed(0)} ms, python side ${(r.ms - r.lookup).toFixed(0)} ms`
		);
	}

	// `json` over the texts of the recorded pass, timed inside Pyodide (the request is
	// dumped from its dict, every other text loaded, the result dumped from its dict).
	const py = await loadInterpreter();
	py.globals.set(
		'_blob',
		JSON.stringify({
			req: pairs.map((p) => p.req),
			rep: pairs.map((p) => p.rep),
			roots: rootTexts,
			res: resultTexts
		})
	);
	const jsonRuns: Record<string, number>[] = [];
	for (let i = 0; i < PASSES; i++) {
		jsonRuns.push(
			JSON.parse(
				py.runPython(`
import json, time
_d = json.loads(_blob)
_req = [json.loads(t) for t in _d['req']]
_res = [json.loads(t) for t in _d['res']]
def _time(f, xs):
    t0 = time.perf_counter()
    for x in xs:
        f(x)
    return (time.perf_counter() - t0) * 1000
def _timer_cost():
    acc = {}
    t0 = time.perf_counter()
    for _ in range(100000):
        a = time.perf_counter()
        acc['k'] = acc.get('k', 0.0) + (time.perf_counter() - a)
    return (time.perf_counter() - t0) * 1000
json.dumps({
    'request dumps': _time(json.dumps, _req),
    'reply loads': _time(json.loads, _d['rep']),
    'roots loads': _time(json.loads, _d['roots']),
    'result dumps': _time(json.dumps, _res),
    'timer pair x100000': _timer_cost(),
})`) as string
			) as Record<string, number>
		);
	}
	const jsonSum = (run: Record<string, number>) =>
		Object.entries(run)
			.filter(([key]) => !key.startsWith('timer'))
			.reduce((sum, [, ms]) => sum + ms, 0);
	for (const run of jsonRuns) {
		const parts = Object.entries(run).map(([key, ms]) => `${key} ${ms.toFixed(0)} ms`);
		console.log(
			`json    ${parts.join(', ')}; sum ${jsonSum(run).toFixed(0)} ms (${pairs.length} trips, ${rootTexts.length} roots, ${resultTexts.length} results)`
		);
	}

	// Post and wake: a no-op request answered on the other thread, `trips` times.
	const wakes: number[] = [];
	for (let i = 0; i < PASSES; i++) {
		const sab = new SharedArrayBuffer(4);
		const flag = new Int32Array(sab);
		const worker = new Worker(new URL(import.meta.url), { workerData: { sab, trips } });
		const done = new Promise<number>((resolve) => {
			worker.on('message', (m: unknown) => {
				if (m === 'ready') worker.postMessage('go');
				else if (m === 'noop') {
					Atomics.store(flag, 0, 1);
					Atomics.notify(flag, 0);
				} else resolve((m as { done: number }).done);
			});
		});
		wakes.push(await done);
		await worker.terminate();
	}
	for (const w of wakes) {
		console.log(
			`wake    ${trips} no-op round trips ${w.toFixed(0)} ms = ${((w * 1000) / trips).toFixed(1)} us each`
		);
	}

	console.log(
		`\nmedians of ${PASSES}: real ${median(real.map((r) => r.ms)).toFixed(0)} ms, dispatch ${median(real.map((r) => r.dispatch)).toFixed(0)}, python side ${median(replay.map((r) => r.ms - r.lookup)).toFixed(0)}, json ${median(jsonRuns.map(jsonSum)).toFixed(0)}, wake ${median(wakes).toFixed(0)}`
	);
}
