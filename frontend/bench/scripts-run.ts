/**
 * The script pool in Chromium, as a test: the bench page (`bench/main.ts`) on the app's origin drives
 * the built sandbox, and this exits non-zero on any parity mismatch, any failed runaway case, any CSP
 * violation, or a control that shows the violation count does not work.
 *
 * `pixi run engine-scripts-browser` writes the corpus model, builds the sandbox and runs this. Both
 * servers must be free: a sandbox preview left running serves an old `dist/`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { IsolationReport, ParityReport, ParityRun, RunawayReport } from './scripts.ts';

const BENCH_URL = 'http://127.0.0.1:5173/';
const SANDBOX_URL = 'http://localhost:5174/';
const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX = fileURLToPath(new URL('../../sandbox/', import.meta.url));
const PARITY = new URL('../../engine/fixtures/golden/script_parity.json', import.meta.url);

type Expected = { name: string; results: string[]; ops?: string };

async function answers(url: string): Promise<boolean> {
	try {
		await fetch(url);
		return true;
	} catch {
		return false;
	}
}

/** Starts `vite` with `args` in `cwd` and waits for `probe`; a port already answering is an error. */
async function serve(probe: string, cwd: string, args: string[]): Promise<ChildProcess> {
	if (await answers(probe)) throw new Error(`${probe} already answers: stop that server first`);
	const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...args], {
		cwd,
		stdio: ['ignore', 'ignore', 'inherit']
	});
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`vite ${args.join(' ')} exited`);
		if (await answers(probe)) return child;
		await new Promise((done) => setTimeout(done, 200));
	}
	child.kill();
	throw new Error(`${probe} did not answer within 30 s`);
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() =>
				typeof address === 'object' && address !== null
					? resolve(address.port)
					: reject(new Error('no port'))
			);
		});
	});
}

type Target = { type: string; url: string };

/** The script workers alive, from the browser's own list of its targets. */
async function liveScriptWorkers(debugPort: number): Promise<number> {
	const targets = (await (
		await fetch(`http://127.0.0.1:${debugPort}/json/list`)
	).json()) as Target[];
	return targets.filter((t) => t.type === 'worker' && t.url.includes('script-worker')).length;
}

const failures: string[] = [];
const fail = (message: string) => {
	failures.push(message);
	console.error(`FAIL ${message}`);
};

const clip = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}...` : text);

function compare(label: string, runs: ParityRun[], expected: Expected[]): number {
	let mismatches = 0;
	if (runs.length !== expected.length) {
		fail(`${label}: ${runs.length} cases ran, the corpus holds ${expected.length}`);
		return runs.length;
	}
	for (const [i, run] of runs.entries()) {
		const want = expected[i]!;
		if (run.name !== want.name) {
			fail(`${label}: case ${i} is ${run.name}, expected ${want.name}`);
			mismatches++;
			continue;
		}
		const wrong: string[] = [];
		if (JSON.stringify(run.texts) !== JSON.stringify(want.results)) {
			wrong.push(
				`results\n    expected ${clip(JSON.stringify(want.results))}\n    got      ${clip(JSON.stringify(run.texts))}`
			);
		}
		if (want.ops !== undefined && run.ops !== want.ops) {
			wrong.push(`ops\n    expected ${clip(want.ops)}\n    got      ${clip(String(run.ops))}`);
		}
		if (wrong.length > 0) {
			mismatches++;
			fail(`${label}: ${want.name}: ${wrong.join('; ')}`);
		}
	}
	return mismatches;
}

const median = (values: readonly number[]) =>
	[...values].sort((a, b) => a - b)[values.length >> 1] ?? NaN;

const expected = (JSON.parse(readFileSync(PARITY, 'utf-8')) as { cases: Expected[] }).cases;
const servers: ChildProcess[] = [];
const debugPort = await freePort();
const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
const pageErrors: string[] = [];
let parity: ParityReport | undefined;
let runaway: RunawayReport | undefined;
let isolated: IsolationReport | undefined;
let control: { violations: number; answer: string } | undefined;
try {
	servers.push(await serve(SANDBOX_URL, SANDBOX, ['preview']));
	servers.push(
		await serve(`${BENCH_URL}data/script-metamodel.json`, FRONTEND, [
			'--config',
			'bench/vite.config.ts'
		])
	);

	// A fresh context for each, so each starts with no worker and no state of the last.
	const visit = async <T>(run: (page: Awaited<ReturnType<typeof newPage>>) => Promise<T>) => {
		const context = await browser.newContext();
		try {
			return await run(await newPage(context));
		} finally {
			await context.close();
		}
	};
	const newPage = async (context: Awaited<ReturnType<typeof browser.newContext>>) => {
		const page = await context.newPage();
		page.on('pageerror', (error) => pageErrors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') pageErrors.push(message.text());
		});
		await page.exposeFunction('scriptWorkers', () => liveScriptWorkers(debugPort));
		await page.goto(BENCH_URL);
		return page;
	};

	parity = await visit((page) => page.evaluate(() => window.bench.parity()));
	runaway = await visit((page) => page.evaluate(() => window.bench.runaway()));
	isolated = await visit((page) => page.evaluate(() => window.bench.isolation()));
	control = await visit((page) => page.evaluate(() => window.bench.violationControl()));
} finally {
	await browser.close();
	for (const child of servers) child.kill();
}

console.log(`Chromium ${browser.version()}`);
if (parity !== undefined) {
	const bad =
		compare('sequential', parity.sequential, expected) +
		compare('concurrent', parity.concurrent, expected);
	const boots = parity.sequential.map((run) => run.boot);
	const snapshotMs = parity.sequential.filter((r) => r.boot === 'snapshot').map((r) => r.bootMs);
	const coldMs = parity.sequential.filter((r) => r.boot === 'cold').map((r) => r.bootMs);
	console.log(
		`parity: ${parity.sequential.length} cases sequentially and ${parity.concurrent.length} at once, ` +
			`${bad} mismatches; isolated ${parity.isolated}; ${parity.violations} CSP violations`
	);
	console.log(
		`boot, sequential runs: ${boots.filter((b) => b === 'snapshot').length} from the snapshot ` +
			`(median ${median(snapshotMs).toFixed(0)} ms), ${boots.filter((b) => b === 'cold').length} cold ` +
			`(median ${median(coldMs).toFixed(0)} ms)`
	);
	if (parity.violations !== 0) fail(`the parity run counted ${parity.violations} CSP violations`);
	if (parity.isolated !== true) fail('the sandbox was not cross-origin isolated');
}
if (runaway !== undefined) {
	for (const c of runaway.cases) {
		console.log(
			`runaway ${c.ok ? 'ok  ' : 'FAIL'} ${c.name} (${(c.ms / 1000).toFixed(1)} s): ${c.detail}`
		);
		if (!c.ok) fail(`runaway: ${c.name}: ${c.detail}`);
	}
	if (runaway.cases.length !== 5) fail(`${runaway.cases.length} runaway cases ran, 5 expected`);
	console.log(`runaway: ${runaway.violations} CSP violations`);
	if (runaway.violations !== 0)
		fail(`the runaway run counted ${runaway.violations} CSP violations`);
}
if (isolated !== undefined) {
	console.log(
		`isolation ${isolated.ok ? 'ok  ' : 'FAIL'}: ${isolated.detail}; ${isolated.violations} CSP violations`
	);
	if (!isolated.ok) fail(`isolation: ${isolated.detail}`);
	if (isolated.violations !== 0)
		fail(`the isolation run counted ${isolated.violations} CSP violations`);
}
if (control !== undefined) {
	console.log(`violation control: ${control.violations} counted for a script that calls js.eval`);
	if (control.violations < 1) fail(`the control counted no violation: ${clip(control.answer)}`);
}
if (pageErrors.length > 0) fail(`page errors: ${[...new Set(pageErrors)].join(' | ')}`);
if (
	parity === undefined ||
	runaway === undefined ||
	isolated === undefined ||
	control === undefined
)
	fail('a run did not finish');

console.log(failures.length === 0 ? '\nPASS' : `\nFAILED: ${failures.length} problem(s)`);
process.exit(failures.length === 0 ? 0 : 1);
