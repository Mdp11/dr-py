/**
 * The replica in the browser at model M: the bench page (`bench/main.ts`) on
 * the app's origin drives the built sandbox's worker, in a fresh browser
 * context per pass; the worker's heap is read over its own debugger socket.
 *
 * `pixi run engine-bench-data` writes the input once; `pixi run
 * engine-bench-browser` builds the sandbox and measures. A miss is reported,
 * never an exit status. Timings drift between sessions: compare only numbers
 * of one run.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { Measures, OpenReport } from './main.ts';

const PASSES = 3;
const OPEN_BUDGET_MS = 3000;
const HEAP_BUDGET_MB = 400;
const SLICE_BUDGET_MS = 16;
const TRANSITION_BUDGET_MS = 100;

const BENCH_URL = 'http://127.0.0.1:5173/';
const SANDBOX_URL = 'http://localhost:5174/';
const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX = fileURLToPath(new URL('../../sandbox/', import.meta.url));
const BENCHMARKS = new URL('../../benchmarks/', import.meta.url);

const HEAP = 'worker heap after GC, one replica, digest check done, MB';
const BACKING = '  ArrayBuffer backing stores beside it (not added), MB';
const OPEN = 'cold open: first byte asked to replica ready';
const SLICES = [
	'longest staged round trip during the open (slice bound)',
	'longest staged round trip during it (slice bound)'
];
const TABLE_SLICE = 'longest staged round trip during the table (slice bound)';
const RESCAN_SLICE = 'longest staged round trip during the rescan (slice bound)';
const TRANSITIONS = [
	'stage 1,000 update_element ops',
	'unstage all',
	'applyDelta over the 100 staged batches'
];

for (const name of ['large.snapshot.v2.gz', 'large.snapshot.v2.metamodel.json']) {
	if (!existsSync(new URL(name, BENCHMARKS))) {
		console.error(`Missing benchmarks/${name}: run \`pixi run engine-bench-data\` first.`);
		process.exit(1);
	}
}
if (!existsSync(new URL('large.rules.json', BENCHMARKS))) {
	console.error('Missing benchmarks/large.rules.json: run `pixi run engine-parity-oracle` first.');
	process.exit(1);
}

async function answer(url: string): Promise<Response | null> {
	try {
		return await fetch(url);
	} catch {
		return null;
	}
}

/** Starts `vite` with `args` in `cwd`, or reuses what already answers `probe`. */
async function serve(probe: string, cwd: string, args: string[]): Promise<ChildProcess | null> {
	const found = await answer(probe);
	if (found !== null) {
		if (!found.ok)
			throw new Error(`${probe} answers ${found.status}: another server holds its port`);
		console.log(`reusing the server at ${probe}`);
		return null;
	}
	const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...args], {
		cwd,
		stdio: ['ignore', 'ignore', 'inherit']
	});
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`vite ${args.join(' ')} exited`);
		if ((await answer(probe))?.ok) return child;
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

type Target = { type: string; url: string; webSocketDebuggerUrl?: string };
type HeapUsage = { usedSize: number; backingStorageSize?: number };

/** The engine worker's V8 heap after a collection, over the worker's own debugger socket. */
async function workerHeap(debugPort: number): Promise<HeapUsage> {
	const targets = (await (
		await fetch(`http://127.0.0.1:${debugPort}/json/list`)
	).json()) as Target[];
	const worker = targets.filter((t) => t.type === 'worker' && t.url.includes('engine-worker'));
	if (worker.length !== 1 || worker[0]!.webSocketDebuggerUrl === undefined) {
		throw new Error(`expected one engine worker target, found ${worker.length}`);
	}
	const socket = new WebSocket(worker[0]!.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});
	let nextId = 1;
	const send = (method: string) =>
		new Promise<unknown>((resolve, reject) => {
			const id = nextId++;
			const onMessage = (event: MessageEvent) => {
				const message = JSON.parse(String(event.data)) as {
					id?: number;
					result?: unknown;
					error?: { message: string };
				};
				if (message.id !== id) return;
				socket.removeEventListener('message', onMessage);
				if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`));
				else resolve(message.result);
			};
			socket.addEventListener('message', onMessage);
			socket.send(JSON.stringify({ id, method }));
		});
	try {
		await send('HeapProfiler.collectGarbage');
		return (await send('Runtime.getHeapUsage')) as HeapUsage;
	} finally {
		socket.close();
	}
}

const rows = new Map<string, number[]>();

function record(measures: Measures): void {
	for (const [label, value] of Object.entries(measures)) {
		rows.set(label, [...(rows.get(label) ?? []), value]);
	}
}

const median = (values: readonly number[]) =>
	[...values].sort((a, b) => a - b)[values.length >> 1]!;
const shown = (value: number) => (Number.isNaN(value) ? '-' : value.toFixed(value < 10 ? 1 : 0));
const mb = (bytes: number) => bytes / 2 ** 20;

// Read before anything starts: the load the run began under.
const load = execFileSync('uptime', { encoding: 'utf-8' }).replace(/^.*load average:\s*/s, '');
const servers: ChildProcess[] = [];
const debugPort = await freePort();
const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
const version = browser.version();
let first: OpenReport | null = null;
const hosts: string[] = [];
const pageErrors: string[] = [];
try {
	for (const child of [
		await serve(`${SANDBOX_URL}`, SANDBOX, ['preview']),
		await serve(`${BENCH_URL}data/metamodel.json`, FRONTEND, ['--config', 'bench/vite.config.ts'])
	]) {
		if (child !== null) servers.push(child);
	}

	for (let pass = 0; pass < PASSES; pass++) {
		const context = await browser.newContext();
		const page = await context.newPage();
		page.on('pageerror', (error) => pageErrors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') pageErrors.push(message.text());
		});
		await page.goto(BENCH_URL);
		const opened = await page.evaluate(() => window.bench.open());
		first ??= opened;
		hosts.push(`isolated ${opened.isolated}, ${opened.violations} CSP violations`);
		record(opened.measures);
		const heap = await workerHeap(debugPort);
		record({ [HEAP]: mb(heap.usedSize), [BACKING]: mb(heap.backingStorageSize ?? NaN) });
		record(await page.evaluate(() => window.bench.transitions()));
		await page.evaluate(() => window.bench.close());
		await context.close();
	}
} finally {
	await browser.close();
	for (const child of servers) child.kill();
}

const header = first!.header;
const count = (n: number) => n.toLocaleString('en-US');
console.log(
	`\nModel M: ${count(header.elements)} elements, ${count(header.relationships)} relationships, ` +
		`${count(first!.gzipBytes)} gzip bytes. ` +
		`Chromium ${version}, Playwright's default headless shell (e2e's browser); ` +
		`load ${load.trim()}. ms, median of ${PASSES} passes [each pass], each in a fresh context.`
);
console.log(`Per pass: ${hosts.join('; ')}.`);
if (pageErrors.length > 0) console.log(`Page errors: ${pageErrors.join(' | ')}`);
console.log('');

const width = Math.max(...[...rows.keys()].map((label) => label.length));
for (const [label, values] of rows) {
	const each = values.map(shown).join(' ');
	console.log(`${label.padEnd(width)}  ${shown(median(values)).padStart(6)}   [${each}]`);
}

const verdict = (value: number, budget: number, unit: string) =>
	`${value.toFixed(0)} of ${budget} ${unit}, ${value <= budget ? 'within budget' : 'OVER BUDGET'}`;
const open = median(rows.get(OPEN)!);
const heap = median(rows.get(HEAP)!);
const slice = Math.max(...SLICES.map((label) => median(rows.get(label)!)));
const tableSlice = median(rows.get(TABLE_SLICE)!);
const rescanSlice = median(rows.get(RESCAN_SLICE)!);
const edits = TRANSITIONS.map(
	(label) => `${label}: ${verdict(median(rows.get(label)!), TRANSITION_BUDGET_MS, 'ms')}`
);
console.log(
	`\ncold open: ${verdict(open, OPEN_BUDGET_MS, 'ms')}; heap: ${verdict(heap, HEAP_BUDGET_MB, 'MB')}; ` +
		`longest slice, bounded from outside: ${verdict(slice, SLICE_BUDGET_MS, 'ms')}; ` +
		`table's longest slice: ${verdict(tableSlice, SLICE_BUDGET_MS, 'ms')}; ` +
		`rescan's longest slice: ${verdict(rescanSlice, SLICE_BUDGET_MS, 'ms')}; ` +
		`${edits.join('; ')}`
);
