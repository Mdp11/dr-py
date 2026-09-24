/**
 * The engine's sweep of model M against the Python oracle's, over the same
 * violations: `scripts/issues_large.py` writes a batch of ops that breaks
 * every check it can, lands it on the document the snapshot was written
 * from and runs the server's own sweep; here the same batch lands on the
 * snapshot through `applyBatch` and a `LiveIssues` sweeps it to its end. The
 * two are compared as multisets of `issueKey`. Exits 1, with the first
 * differences, when they differ.
 *
 * `pixi run engine-parity-large` writes the oracle's side and runs this, once
 * `pixi run engine-bench-data` has written the snapshot.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
	applyBatch,
	cmpCodePoint,
	drain,
	issueKey,
	LiveIssues,
	Metamodel,
	openSnapshot,
	parseJson,
	readOps,
	type Issue,
	type MetamodelDoc
} from '../src/index.ts';

const SHOWN = 20;
const CHUNK_BYTES = 1 << 16;

const DIR = new URL('../../benchmarks/', import.meta.url);
const SNAPSHOT = new URL('large.snapshot.v2', DIR);
const METAMODEL = new URL('large.snapshot.v2.metamodel.json', DIR);
const ORACLE = new URL('large.issues.json', DIR);
const VIOLATIONS = new URL('large.violations.ops.json', DIR);

for (const file of [SNAPSHOT, METAMODEL, ORACLE, VIOLATIONS]) {
	if (!existsSync(file)) {
		console.error(`Missing ${file.pathname}: run \`pixi run engine-bench-data\` first.`);
		process.exit(1);
	}
}

function* cut(bytes: Uint8Array): Generator<Uint8Array> {
	for (let at = 0; at < bytes.length; at += CHUNK_BYTES) yield bytes.subarray(at, at + CHUNK_BYTES);
}

/** `keys` as a count per key. */
function counted(keys: Iterable<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	return counts;
}

/** What `a` holds more of than `b`, one line per surplus issue. */
function surplus(a: Map<string, number>, b: Map<string, number>): string[] {
	const out: string[] = [];
	for (const [key, n] of a) for (let i = b.get(key) ?? 0; i < n; i++) out.push(key);
	return out.sort(cmpCodePoint);
}

const { header, workingCopy } = await openSnapshot(
	cut(readFileSync(SNAPSHOT)),
	Metamodel.fromJSON(JSON.parse(readFileSync(METAMODEL, 'utf-8')) as MetamodelDoc),
	() => undefined
);
// Committed state, as the oracle holds it: the store wraps the working copy after.
const ops = readOps(parseJson(readFileSync(VIOLATIONS, 'utf-8')));
applyBatch(workingCopy.model, ops);
const live = new LiveIssues(workingCopy);
const start = performance.now();
if (!drain(live.sweepSteps())) {
	console.error('The sweep ended unusable: a facet pattern the engine cannot run.');
	process.exit(1);
}
const ms = performance.now() - start;
const issues = [...live.store.iter()];
const engine = counted(issues.map(issueKey));
// Re-rendered as the engine renders a key, so an escaping difference is no difference.
const oracle = counted(
	(JSON.parse(readFileSync(ORACLE, 'utf-8')) as string[]).map((key) =>
		JSON.stringify(JSON.parse(key))
	)
);

const onlyEngine = surplus(engine, oracle);
const onlyOracle = surplus(oracle, engine);
const size = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);
console.log(
	`Model M: ${header.elements.toLocaleString('en-US')} elements, ` +
		`${header.relationships.toLocaleString('en-US')} relationships, ` +
		`${ops.length.toLocaleString('en-US')} violating ops applied. ` +
		`Engine: ${size(engine).toLocaleString('en-US')} issues, swept in ${ms.toFixed(0)} ms; ` +
		`oracle: ${size(oracle).toLocaleString('en-US')} issues.`
);
const byCheck = counted(issues.map((i: Issue) => `${i.check} (${i.category})`));
for (const [check, n] of [...byCheck].sort(([a], [b]) => cmpCodePoint(a, b))) {
	console.log(`  ${check}: ${n.toLocaleString('en-US')}`);
}
if (onlyEngine.length === 0 && onlyOracle.length === 0) {
	console.log('Parity: the two multisets are equal.');
} else {
	console.log(
		`Parity FAILS: ${onlyEngine.length} issue(s) only the engine finds, ` +
			`${onlyOracle.length} only the oracle finds. The first ${SHOWN}:`
	);
	const differences = [
		...onlyEngine.map((key) => `  engine only  ${key}`),
		...onlyOracle.map((key) => `  oracle only  ${key}`)
	];
	for (const line of differences.slice(0, SHOWN)) console.log(line);
	process.exit(1);
}
