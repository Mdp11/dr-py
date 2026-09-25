/**
 * The engine against the Python oracle at model M, over the same
 * (pre-violation) replica: the gate's table, row for row; then, with the
 * same violations and the same custom rules applied, the sweep.
 * `scripts/table_large.py` writes the table oracle's side (`tableSteps`'s
 * counterpart) over `engine/bench/big-table.json`, before any op lands: its
 * rows, and beside them its build's totals, which the rows cannot say;
 * `scripts/issues_large.py` writes a batch of ops that breaks every check it
 * can, lands it on the document the snapshot was written from, compiles its
 * rule sets and runs the server's own sweep. Here the table's rows are built
 * over the freshly opened replica first; then the same violation batch lands
 * on it through `applyBatch`, the rule sets it wrote — the payloads route's
 * bodies, each with its parse — compile as the service compiles them, and a
 * `LiveIssues` holding them sweeps it to its end, compared with the oracle's
 * issues as multisets of `issueKey`. Exits 1, with the first differences of
 * whichever side disagrees, when either does.
 *
 * `pixi run engine-parity-large` writes both oracle sides and runs this,
 * once `pixi run engine-bench-data` has written the snapshot.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
	applyBatch,
	ArtifactSet,
	cmpCodePoint,
	compileRuleSets,
	DEFAULT_TABLE_LIMITS,
	drain,
	issueKey,
	LiveIssues,
	Metamodel,
	navigationFetch,
	openSnapshot,
	parseJson,
	pyDumps,
	readArtifacts,
	readOps,
	readTableDefinition,
	resolveTableRefs,
	RULE_CHECK_PREFIX,
	ruleSources,
	tableSteps,
	wireCell,
	wireKey,
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
const RULES = new URL('large.rules.json', DIR);
const BIG_TABLE = new URL('big-table.json', import.meta.url);
const TABLE_ORACLE = new URL('large.table.json', DIR);
const TABLE_ORACLE_META = new URL('large.table.meta.json', DIR);

for (const file of [SNAPSHOT, METAMODEL, ORACLE, VIOLATIONS, RULES]) {
	if (!existsSync(file)) {
		console.error(`Missing ${file.pathname}: run \`pixi run engine-bench-data\` first.`);
		process.exit(1);
	}
}
for (const file of [TABLE_ORACLE, TABLE_ORACLE_META]) {
	if (!existsSync(file)) {
		console.error(`Missing ${file.pathname}: run \`pixi run engine-table-oracle\` first.`);
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

// The gate's table, over the replica as opened: before any violation lands.
const bigTable = resolveTableRefs(
	readTableDefinition(JSON.parse(readFileSync(BIG_TABLE, 'utf-8')), 'definition'),
	navigationFetch(new ArtifactSet())
);
const tableStart = performance.now();
const built = drain(tableSteps(workingCopy.model, bigTable, DEFAULT_TABLE_LIMITS));
const tableMs = performance.now() - tableStart;
// Two empty tables would be equal row for row: the gate's table is the capped one.
if (!built.truncated || built.keys.length !== DEFAULT_TABLE_LIMITS.maxRows) {
	console.error(`The gate's table holds ${built.keys.length} rows, truncated=${built.truncated}.`);
	process.exit(1);
}
const oracleMeta = JSON.parse(readFileSync(TABLE_ORACLE_META, 'utf-8')) as {
	rows: number;
	base_total: number;
	truncated: boolean;
};
const engineMeta = {
	rows: built.keys.length,
	base_total: built.baseTotal,
	truncated: built.truncated
};
const metaOk =
	oracleMeta.rows === engineMeta.rows &&
	oracleMeta.base_total === engineMeta.base_total &&
	oracleMeta.truncated === engineMeta.truncated;
const engineTable = built.keys.map((key, i) =>
	pyDumps([wireKey(key), built.cells[i]!.map(wireCell)])
);
const oracleTable = readFileSync(TABLE_ORACLE, 'utf-8')
	.split('\n')
	.filter((line) => line !== '');
const tableDiffs: string[] = [];
for (let i = 0; i < Math.max(oracleTable.length, engineTable.length); i++) {
	if (oracleTable[i] === engineTable[i]) continue;
	if (tableDiffs.length < SHOWN) {
		tableDiffs.push(
			`  row ${i}: oracle ${oracleTable[i] ?? '<missing>'}\n` +
				`         engine ${engineTable[i] ?? '<missing>'}`
		);
	}
}
const rowsOk = tableDiffs.length === 0 && oracleTable.length === engineTable.length;
const tableOk = rowsOk && metaOk;
console.log(
	`Table: ${engineTable.length.toLocaleString('en-US')} rows (base ${built.baseTotal.toLocaleString('en-US')}, ` +
		`truncated=${built.truncated}), built + sorted + evaluated in ${tableMs.toFixed(0)} ms. ` +
		(rowsOk
			? 'Parity: equal, row for row.'
			: `Parity FAILS: rows differ (oracle ${oracleTable.length.toLocaleString('en-US')}, ` +
				`engine ${engineTable.length.toLocaleString('en-US')}). The first ${SHOWN}:`)
);
for (const line of tableDiffs) console.log(line);
if (!metaOk) {
	console.log(
		`Parity FAILS: the build's totals differ: oracle ${JSON.stringify(oracleMeta)}, ` +
			`engine ${JSON.stringify(engineMeta)}.`
	);
}

// Committed state, as the oracle holds it: the store wraps the working copy after.
const ops = readOps(parseJson(readFileSync(VIOLATIONS, 'utf-8')));
applyBatch(workingCopy.model, ops);
const artifacts = new ArtifactSet();
artifacts.setCommitted(readArtifacts(JSON.parse(readFileSync(RULES, 'utf-8'))));
const rules = compileRuleSets(ruleSources(artifacts, 'committed'), workingCopy.model.metamodel);
if (rules.unreadable || rules.skipped.length > 0) {
	console.error(
		'The rule sets do not compile whole:',
		rules.unreadable ? 'unreadable' : rules.skipped
	);
	process.exit(1);
}
const live = new LiveIssues(workingCopy, { rules: { working: rules, committed: rules } });
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
		`${rules.total} rules. ` +
		`Engine: ${size(engine).toLocaleString('en-US')} issues, ` +
		`${issues.filter((i) => i.check.startsWith(RULE_CHECK_PREFIX)).length.toLocaleString('en-US')} ` +
		`of them the rules', swept in ${ms.toFixed(0)} ms; ` +
		`oracle: ${size(oracle).toLocaleString('en-US')} issues.`
);
const byCheck = counted(issues.map((i: Issue) => `${i.check} (${i.category})`));
for (const [check, n] of [...byCheck].sort(([a], [b]) => cmpCodePoint(a, b))) {
	console.log(`  ${check}: ${n.toLocaleString('en-US')}`);
}
const issuesOk = onlyEngine.length === 0 && onlyOracle.length === 0;
if (issuesOk) {
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
}
if (!tableOk || !issuesOk) process.exit(1);
