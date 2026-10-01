/**
 * The script pool in the built sandbox, in Chromium: the parity corpus and the runaway cases, each
 * over a replica of the corpus model. `bench/scripts-run.ts` compares what these return with the
 * oracle's. Each function opens its own link and disposes it.
 */
import type { EndResult, ScriptCallsResult, ScriptWarmResult, TailResult } from '$engine';
import type { EngineClient, EngineLink } from '$lib/engine/client';
import { connectFrame } from '$lib/engine/frame';

/** One case of `engine/fixtures/golden/script_parity.json`, as far as the page runs it. */
type ParityCase = {
	name: string;
	mode: 'embedded' | 'console';
	entry: string;
	code: string;
	calls: { element_ids: string[]; inputs_text?: string; doc_text?: string }[];
};

export type ParityRun = {
	name: string;
	texts: string[];
	ops?: string;
	boot: 'snapshot' | 'cold';
	/** How long the worker that ran it took to boot. */
	bootMs: number;
};

export type ParityReport = {
	/** Every case, one after another. */
	sequential: ParityRun[];
	/** Every case at once, as the pool takes them. */
	concurrent: ParityRun[];
	violations: number;
	isolated: boolean | null;
};

export type RunawayCase = {
	name: string;
	ok: boolean;
	detail: string;
	ms: number;
};

export type RunawayReport = { cases: RunawayCase[]; violations: number };

declare global {
	interface Window {
		/** Counts the script workers alive; the driver supplies it over the browser's debugger. */
		scriptWorkers?: () => Promise<number>;
	}
}

const PROJECT_ID = 'bench';

const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Corpus = {
	link: EngineLink;
	client: EngineClient;
	violations: () => number;
};

/** The corpus model opened as a replica: its snapshot streamed through `open`, `chunk` and `end`. */
async function openCorpus(): Promise<Corpus> {
	const link = await connectFrame();
	const { client } = link;
	let violations = 0;
	link.onViolation(() => violations++);
	let ready!: () => void;
	const replicaReady = new Promise<void>((resolve) => (ready = resolve));
	client.on((event) => {
		if (event.event === 'replica' && event.state === 'ready') ready();
	});
	const metamodel: unknown = await (await fetch('/data/script-metamodel.json')).json();
	await client.call('open', { project_id: PROJECT_ID, metamodel });
	const bytes = await (
		await fetch('/data/script-snapshot.gz', { cache: 'no-store' })
	).arrayBuffer();
	await client.call('chunk', { bytes }, { transfer: [bytes] });
	const header = await client.call<EndResult>('end');
	const tail = await client.call<TailResult>('applyTail', {
		text: JSON.stringify({ from_rev: header.rev, head_rev: header.rev, complete: true, deltas: [] })
	});
	if (tail.status !== 'applied' || tail.diverged) {
		throw new Error(`the empty tail answered ${JSON.stringify(tail)}`);
	}
	await replicaReady;
	return { link, client, violations: () => violations };
}

async function cases(): Promise<ParityCase[]> {
	const file = (await (await fetch('/data/script-parity.json')).json()) as { cases: ParityCase[] };
	return file.cases;
}

const paramsOf = (c: ParityCase) => ({
	code: c.code,
	entry: c.entry,
	...(c.mode === 'console' && { console: true }),
	calls: c.calls
});

async function runCase(client: EngineClient, c: ParityCase): Promise<ParityRun> {
	const run = await client.call<ScriptCallsResult>('scriptCalls', paramsOf(c));
	return {
		name: c.name,
		texts: run.results.map((one) => one.text),
		...(run.ops !== undefined && { ops: run.ops }),
		boot: run.boot,
		bootMs: run.boot_ms
	};
}

/** Every corpus case through `scriptCalls`, sequentially and then all at once. */
export async function parity(): Promise<ParityReport> {
	const { link, client, violations } = await openCorpus();
	try {
		const all = await cases();
		const sequential: ParityRun[] = [];
		for (const c of all) sequential.push(await runCase(client, c));
		const concurrent = await Promise.all(all.map((c) => runCase(client, c)));
		return { sequential, concurrent, violations: violations(), isolated: link.isolated };
	} finally {
		link.dispose();
	}
}

const HONEST_42 =
	'{"payload": {"kind": "json", "value": 42}, "error": null, "reads": [], "stdout": ""}';

type Answer = { error: { kind: string; message: string } | null };

/**
 * A transform that answers 42 for every doc but `'spin'`, for which it runs `body`: the calls of a
 * batch are told apart by what they do.
 */
function transform(body: string, docs: (string | null)[], prelude = '') {
	const indented = body
		.split('\n')
		.map((line) => `        ${line}`)
		.join('\n');
	return {
		code: `${prelude}\ndef transform(doc):\n    if doc == 'spin':\n${indented}\n    return 42\n`,
		entry: 'transform',
		calls: docs.map((doc) => ({ element_ids: [], doc_text: JSON.stringify(doc) }))
	};
}

/** What a replica holds that a script must not move: its revision, counts, nothing staged, and an element. */
async function stamp(client: EngineClient): Promise<string> {
	return JSON.stringify([
		await client.call('getModelSummary'),
		await client.call('getElement', { id: 'n1' }),
		await client.call('staged')
	]);
}

const answered = (text: string) => (JSON.parse(text) as Answer).error?.kind ?? 'none';

/**
 * A runaway ends by its stop and leaves the replica as it was: the soft stop of a loop, the hard stop
 * of what the interrupt cannot reach, and a cancel, each with the default limits. After each, the
 * calls before the runaway kept their answers, the replica's stamp is unchanged, the next batch is
 * answered, and the runaway's worker is gone.
 */
export async function runaway(): Promise<RunawayReport> {
	const { link, client, violations } = await openCorpus();
	const report: RunawayCase[] = [];
	const alive = async () => {
		if (window.scriptWorkers === undefined) throw new Error('the driver gave no worker count');
		return window.scriptWorkers();
	};
	const run = (batch: ReturnType<typeof transform>, signal?: AbortSignal) =>
		client.call<ScriptCallsResult>('scriptCalls', batch, signal === undefined ? {} : { signal });

	const cap = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 1) - 2));

	/**
	 * What the pool holds once the run that just ended has left it: `null` unless every slot is a ready
	 * spare again (`scriptWarm` answers `cap`), which a run's worker still alive would prevent; and the
	 * script workers the browser lists, once they are at most `cap`.
	 */
	async function settled(): Promise<{ warm: ScriptWarmResult | null; listed: number }> {
		const waiting = new AbortController();
		const warm = await Promise.race([
			client.call<ScriptWarmResult>('scriptWarm', undefined, { signal: waiting.signal }),
			sleep(15_000).then(() => null)
		]);
		waiting.abort();
		let listed = Infinity;
		for (let tries = 0; tries < 50 && listed > cap; tries++) {
			listed = await alive();
			if (listed > cap) await sleep(100);
		}
		return { warm, listed };
	}

	async function check(
		name: string,
		minMs: number,
		maxMs: number,
		go: () => Promise<{ detail: string; ok: boolean }>
	): Promise<void> {
		const before = await stamp(client);
		const start = now();
		let outcome: { detail: string; ok: boolean };
		try {
			outcome = await go();
		} catch (error) {
			outcome = { ok: false, detail: `threw ${String(error)}` };
		}
		const ms = now() - start;
		const details = [outcome.detail];
		let ok = outcome.ok;
		if (ms < minMs || ms > maxMs) {
			ok = false;
			details.push(`took ${ms.toFixed(0)} ms, expected ${minMs} to ${maxMs}`);
		}
		const next = await run(transform('pass', [null]));
		if (next.results[0]?.text !== HONEST_42) {
			ok = false;
			details.push(`the next batch answered ${next.results[0]?.text}`);
		}
		if ((await stamp(client)) !== before) {
			ok = false;
			details.push('the replica changed');
		}
		const { warm, listed } = await settled();
		if (warm === null || warm.spares !== cap) {
			ok = false;
			details.push(`the pool did not return to ${cap} ready spares: a worker still holds a slot`);
		}
		if (listed > cap) {
			ok = false;
			details.push(`${listed} script workers are alive, the pool's cap is ${cap}`);
		}
		report.push({ name, ok, detail: details.join('; '), ms });
	}

	const expectKinds = async (batch: ReturnType<typeof transform>, kinds: string[]) => {
		const result = await run(batch);
		const got = result.results.map((one) => (one.text === HONEST_42 ? 'ok' : answered(one.text)));
		return { ok: got.join() === kinds.join(), detail: `answers ${got.join(',')}` };
	};

	try {
		// A first batch, and the pool hot behind it: what is timed is the call and not a boot.
		await run(transform('pass', [null]));
		await settled();

		await check('soft stop: while True', 10_000, 13_500, () =>
			expectKinds(transform('while True:\n    pass', [null, 'spin', null]), ['ok', 'timeout', 'ok'])
		);
		await check('hard stop: except BaseException', 11_400, 14_000, () =>
			expectKinds(
				transform(
					'while True:\n    try:\n        while True:\n            pass\n    except BaseException:\n        pass',
					[null, 'spin', null]
				),
				['ok', 'timeout', 'timeout']
			)
		);
		await check('hard stop: sum(range(10**10))', 11_400, 14_000, () =>
			expectKinds(transform('sum(range(10**10))', [null, 'spin', null]), [
				'ok',
				'timeout',
				'timeout'
			])
		);
		await check('hard stop: time.sleep(60)', 11_400, 14_000, () =>
			expectKinds(transform('time.sleep(60)', [null, 'spin', null], 'import time'), [
				'ok',
				'timeout',
				'timeout'
			])
		);
		await check('cancel: while True', 400, 3000, async () => {
			const controller = new AbortController();
			const running = run(transform('while True:\n    pass', ['spin', null]), controller.signal);
			await sleep(1000);
			// The count must see a busy worker, or it sees none ever.
			const during = await alive();
			if (during < 1) return { ok: false, detail: 'no script worker was listed while one ran' };
			controller.abort();
			try {
				await running;
				return { ok: false, detail: 'the cancelled call answered' };
			} catch (error) {
				return { ok: String(error).includes('abort'), detail: `rejected: ${String(error)}` };
			}
		});
	} finally {
		link.dispose();
	}
	return { cases: report, violations: violations() };
}

/**
 * A control for the count: a script that calls `js.eval` is refused by the CSP in its worker, and
 * the violation must reach the page. Returns the page's count and what the script answered.
 */
export async function violationControl(): Promise<{ violations: number; answer: string }> {
	const { link, client, violations } = await openCorpus();
	try {
		const result = await client.call<ScriptCallsResult>('scriptCalls', {
			code: 'import js\n\ndef transform(doc):\n    return js.eval("1 + 1")\n',
			entry: 'transform',
			calls: [{ element_ids: [], doc_text: 'null' }]
		});
		await sleep(500);
		return { violations: violations(), answer: result.results[0]?.text ?? '' };
	} finally {
		link.dispose();
	}
}

export type IsolationReport = { ok: boolean; detail: string; violations: number };

/**
 * What a script can do to its worker's scope stays in that worker: one batch rebinds the scope's
 * `postMessage` and `addEventListener` and plants a global, and still answers; the next batch, on a
 * worker of its own, finds the scope untouched, a worker scope (no `document`), and isolated.
 */
export async function isolation(): Promise<IsolationReport> {
	const { link, client, violations } = await openCorpus();
	try {
		const run = (code: string) =>
			client.call<ScriptCallsResult>('scriptCalls', {
				code,
				entry: 'transform',
				calls: [{ element_ids: [], doc_text: 'null' }]
			});
		const planted = await run(
			'import js\n\ndef transform(doc):\n    s = js.self\n    s.poison = "x"\n    s.postMessage = None\n    s.addEventListener = None\n    return "planted"\n'
		);
		const probe = await run(
			[
				'import js',
				'',
				'def transform(doc):',
				'    s = js.self',
				'    return {',
				'        "poison": hasattr(s, "poison"),',
				'        "post": str(s.postMessage.typeof),',
				'        "listen": str(s.addEventListener.typeof),',
				'        "document": hasattr(s, "document"),',
				'        "scope": str(s.constructor.name),',
				'        "isolated": bool(s.crossOriginIsolated),',
				'    }',
				''
			].join('\n')
		);
		const payload = (text: string) =>
			JSON.stringify((JSON.parse(text) as { payload: unknown }).payload);
		const got = payload(probe.results[0]?.text ?? 'null');
		const want = JSON.stringify({
			kind: 'json',
			value: {
				poison: false,
				post: 'function',
				listen: 'function',
				document: false,
				scope: 'DedicatedWorkerGlobalScope',
				isolated: true
			}
		});
		const planting = payload(planted.results[0]?.text ?? 'null');
		// An uncaught error in a script worker, after its batch: it must not reach the page as the
		// engine worker's own, which ends the link.
		await run(
			'import js\nfrom pyodide.ffi import create_proxy\n\ndef transform(doc):\n    js.setTimeout(create_proxy(lambda: 1 / 0), 0)\n    return "set"\n'
		);
		await sleep(500);
		await client.call('staged');
		const after = await run('def transform(doc):\n    return 42\n');
		const survived = (after.results[0]?.text ?? '') === HONEST_42;
		const ok =
			planting === JSON.stringify({ kind: 'json', value: 'planted' }) && got === want && survived;
		return {
			ok,
			detail: `the planting batch answered ${planting}; the next batch saw ${got}; the link ${survived ? 'survived' : 'did not survive'} an uncaught error in a worker`,
			violations: violations()
		};
	} catch (error) {
		return { ok: false, detail: `threw ${String(error)}`, violations: violations() };
	} finally {
		link.dispose();
	}
}
