/**
 * The engine at model M: opening a snapshot, against opening the same model
 * as one document in the same pass; the digest check; the long operations in
 * steps — their total and their longest step, for there is no scheduler here;
 * the heap one replica holds; staging, rewinding, rebasing and a delta; the
 * issue store's sweep, and the same edits through it, each revalidating; the
 * issue list the panel reads after a keystroke over many staged batches; and
 * the store with custom rules: its sweep, a rescan, a stage widened by the
 * rules' reach and a probe across a staged rule change.
 *
 * `pixi run engine-bench-data` writes the input once, `pixi run engine-bench`
 * measures. Timings drift between sessions: compare only numbers of one run.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
	appliesPopulation,
	ArtifactSet,
	compileRuleSets,
	drain,
	entityHash,
	EVALUATIONS,
	formatDigest,
	issueListBody,
	LiveIssues,
	Metamodel,
	Model,
	openSnapshot,
	parseExact,
	READS,
	ViewPlacements,
	type CompiledRules,
	type Delta,
	type ElementRec,
	type MetamodelDoc,
	type ModelOp,
	type RelRec,
	type Steps,
	type Value,
	type WorkingCopy
} from '../src/index.ts';

const PASSES = 3;
/** The copies of one element staged for the duplicate-group sweep. */
const DUPLICATES = 20_000;
const CHUNK_BYTES = 1 << 16;
const OPEN_BUDGET_MS = 3000;
const HEAP_BUDGET_MB = 400;

const DIR = new URL('../../benchmarks/', import.meta.url);
const SNAPSHOT = new URL('large.snapshot.v2', DIR);
const METAMODEL = new URL('large.snapshot.v2.metamodel.json', DIR);
const DOCUMENT = new URL('large.model.json', DIR);

for (const file of [SNAPSHOT, METAMODEL, DOCUMENT]) {
	if (!existsSync(file)) {
		console.error(`Missing ${file.pathname}: run \`pixi run engine-bench-data\` first.`);
		process.exit(1);
	}
}

/** What is measured, in the order it is shown. */
const ROWS = {
	open: 'open the snapshot: inflated bytes to indexed replica',
	openRead: '  decode, split, parse, load',
	openIndex: '  index',
	document: 'open the same model as one document',
	documentParse: '  exact parse',
	documentLoad: '  load',
	documentIndex: '  index',
	nativeParse: '  (its native parse, which loses 1 vs 1.0)',
	verify: 'verify the digest: every entity hashed',
	indexSteps: 'the index build in steps (the document model again)',
	indexLongest: '  its longest step',
	verifySteps: 'the digest check in steps',
	verifyLongest: '  its longest step',
	scan: "search q='a', the broadest: every element scored, the hits sorted",
	scanLongest: '  its longest step',
	scanRare: "search q='sensor'",
	criteria: "criteria scan (property contains 'a'): every element matched",
	criteriaLongest: '  its longest step',
	navigation: 'navigation, untyped scope, one relationship hop (Owns): every id sorted',
	navigationLongest: '  its longest step',
	iterate: 'iterate every entity in state order',
	stage: 'stage a 1,000-op batch',
	unstage: 'unstage it: every touched entity back in its place',
	iterateAfter: 'iterate again: the first time re-sorts',
	rebase: 'rebase 100 staged batches over a delta',
	unstageEntity: 'unstage one entity among 100 staged batches',
	delta: 'apply a delta (99 changed, 40 new, 10 deleted), nothing staged',
	sweep: 'sweep the issue store: every entity validated, in steps',
	sweepFirst: '  its first step',
	sweepLongest: '  its longest step after the first',
	sweepGroup: `sweep again with ${DUPLICATES.toLocaleString('en-US')} duplicates staged, one group`,
	sweepGroupLongest: '  its longest step after the first',
	uniqGroup: `uniqGroupOf over a ${DUPLICATES.toLocaleString('en-US')}-member group`,
	liveStage: 'stage 1,000 ops + revalidation',
	liveUnstage: 'unstage all + revalidation',
	probe: 'origin probe (100 staged batches)',
	liveDelta: 'delta over 100 staged + revalidation',
	keystroke100: 'getModelIssues after a coalesced keystroke, 100 staged batches',
	keystroke1000: 'getModelIssues after a coalesced keystroke, 1,000 staged batches',
	rescan: 'rules rescan (population of the rule over the largest type)',
	rescanLongest: '  its longest step',
	rulesSweep: 'sweep with rules',
	rulesSweepLongest: '  its longest step after the first',
	rulesStage: 'stage 1,000 ops + revalidation with reach',
	rulesProbe: 'origin probe, 100 staged batches + a staged rule change',
	rulesPopulation: "  the changed rule's population, once"
};
type Row = keyof typeof ROWS;

const timings = new Map<Row, number[]>();

function record(row: Row, ms: number): void {
	timings.set(row, [...(timings.get(row) ?? []), ms]);
}

function timed<T>(row: Row, run: () => T): T {
	const start = performance.now();
	const result = run();
	record(row, performance.now() - start);
	return result;
}

/**
 * Drives `steps` by hand: the whole run under `total`, its longest step under
 * `longest` — past the first one when `first` takes that apart.
 */
function stepped<T>(total: Row, longest: Row | null, steps: Steps<T>, first?: Row | null): T {
	let worst = 0;
	let taken = 0;
	const start = performance.now();
	for (;;) {
		const before = performance.now();
		const next = steps.next();
		const ms = performance.now() - before;
		if (first !== undefined && taken++ === 0) {
			if (first !== null) record(first, ms);
		} else worst = Math.max(worst, ms);
		if (next.done === true) {
			record(total, performance.now() - start);
			if (longest !== null) record(longest, worst);
			return next.value;
		}
	}
}

const search = (model: Model, q: string) =>
	READS['listElementsPage']!(model, new ViewPlacements(), { q, limit: 100 }) as Steps<unknown>;

const criteriaScan = (model: Model) =>
	EVALUATIONS['searchModel']!(
		{ model, artifacts: new ArtifactSet(), placements: new ViewPlacements() },
		{
			target: 'element',
			criteria: [{ type: 'property', name: 'name', op: 'contains', value: 'a' }],
			limit: 100
		}
	);

const navigation = (model: Model) =>
	EVALUATIONS['evaluateNavigation']!(
		{ model, artifacts: new ArtifactSet(), placements: new ViewPlacements() },
		{
			definition: {
				kind: 'path',
				start: { kind: 'scope' },
				steps: [{ kind: 'relationship', relationship_type: 'Owns' }]
			}
		}
	);

/**
 * Rules over the smart-city types, as the server's parse writes them: a
 * property test under a `when`, a `count` over a type with a subtype, a
 * two-hop path under `where`, a `to` naming a subtype and a warning.
 */
const BENCH_RULES = (replicas: string) =>
	JSON.stringify({
		rules: [
			{
				name: 'prod-replicas',
				applies_to: 'Microservice',
				when: { property: 'status', equals: 'Active' },
				then: { property: 'replica_count', gte: '@replicas' }
			},
			{
				name: 'no-dependency',
				applies_to: 'Microservice',
				then: { relationship: { type: 'DependsOn', direction: 'outgoing', count: { eq: 0 } } }
			},
			{
				name: 'hosted-deployment',
				applies_to: 'Service',
				when: { relationship: { type: 'DeployedOn', direction: 'outgoing', exists: true } },
				then: {
					relationship: {
						type: 'DeployedOn',
						direction: 'outgoing',
						to: 'Node',
						where: { relationship: { type: 'HostedIn', direction: 'outgoing', exists: true } },
						exists: true
					}
				}
			},
			{
				name: 'four-services',
				applies_to: 'System',
				then: {
					relationship: {
						type: 'SystemContainsComponent',
						direction: 'outgoing',
						to: 'Service',
						count: { gte: 4 }
					}
				}
			},
			{
				name: 'lead-in-team',
				applies_to: 'Person',
				severity: 'warning',
				when: { property: 'role', equals: 'Lead' },
				then: { relationship: { type: 'MemberOf', direction: 'outgoing', exists: true } }
			}
		]
	}).replace('"@replicas"', replicas);

/** One rule set compiled whole against `wc`'s metamodel. */
function compiledRules(wc: WorkingCopy, document: string): CompiledRules {
	const source = { artifactId: 'bench', name: 'Bench', parse: { ok: true as const, document } };
	const compiled = compileRuleSets([source], wc.model.metamodel);
	if (compiled.unreadable || compiled.skipped.length > 0) {
		throw new Error('the bench rules do not compile whole');
	}
	return compiled;
}

const count = (n: number) => n.toLocaleString('en-US');

const median = (values: readonly number[]) =>
	[...values].sort((a, b) => a - b)[values.length >> 1]!;

function* cut(bytes: Uint8Array): Generator<Uint8Array> {
	for (let at = 0; at < bytes.length; at += CHUNK_BYTES) yield bytes.subarray(at, at + CHUNK_BYTES);
}

/** Every `stride`-th item from `offset` that passes, `count` of them. */
function sample<T>(items: readonly T[], count: number, offset: number, pass: (item: T) => boolean) {
	const stride = Math.max(1, Math.floor(items.length / (count * 4)));
	const out: T[] = [];
	for (let i = offset; i < items.length && out.length < count; i += stride) {
		if (pass(items[i]!)) out.push(items[i]!);
	}
	if (out.length < count) throw new Error(`the model holds too few entities to sample ${count}`);
	return out;
}

const renamed = (element: ElementRec, name: string): ModelOp => ({
	kind: 'update_element',
	id: element.id,
	properties_patch: { name }
});

const committed = (element: ElementRec, name: string): Value => ({
	id: element.id,
	type_name: element.typeName,
	properties: { ...element.props, name },
	rev: element.rev + 1
});

/** A delta over untouched entities, its digest folded the way the server maintains it. */
function deltaOver(
	wc: WorkingCopy,
	changed: readonly ElementRec[],
	added: { elements: readonly ElementRec[]; relationships: readonly RelRec[] },
	deleted: readonly RelRec[]
): Delta {
	let digest = BigInt('0x' + wc.digest);
	for (const element of changed) {
		digest ^= entityHash(element.id, element.rev) ^ entityHash(element.id, element.rev + 1);
	}
	for (const rel of deleted) digest ^= entityHash(rel.id, rel.rev);
	const tag = `bench-${wc.rev}-`;
	const elements = added.elements.map((like, i) => {
		digest ^= entityHash(`${tag}e${i}`, 0);
		return { id: `${tag}e${i}`, type_name: like.typeName, properties: { ...like.props }, rev: 0 };
	});
	const relationships = added.relationships.map((like, i) => {
		digest ^= entityHash(`${tag}r${i}`, 0);
		return {
			id: `${tag}r${i}`,
			type_name: like.typeName,
			source_id: like.source.id,
			target_id: like.target.id,
			properties: {},
			rev: 0
		};
	});
	return {
		rev: wc.rev + 1,
		prev_rev: wc.rev,
		state_digest: formatDigest(digest),
		changed_elements: [
			...changed.map((element, i) => committed(element, `theirs ${i}`)),
			...elements
		],
		changed_relationships: relationships,
		deleted_element_ids: [],
		deleted_relationship_ids: deleted.map((rel) => rel.id),
		recreated_element_ids: [],
		recreated_relationship_ids: []
	};
}

const entities = (model: Model): [ElementRec[], RelRec[]] => [
	[...model.elements()],
	[...model.relationships()]
];

const any = () => true;

const namedIn = (model: Model) => (element: ElementRec) =>
	model.metamodel.effectiveElementPropertyNames(element.typeName).has('name');

/**
 * 500 renames, 200 new elements, 200 new relationships, 50 relationships and
 * 50 leaf elements deleted — relationships first: nothing names an entity
 * already gone.
 */
function thousandOps(model: Model, elements: ElementRec[], relationships: RelRec[]): ModelOp[] {
	const metamodel = model.metamodel;
	const named = namedIn(model);
	const leaf = (element: ElementRec) =>
		element.out.every((rel) => !metamodel.isContainment(rel.typeName));
	const batch: ModelOp[] = [
		...sample(elements, 500, 0, named).map((element, i) => renamed(element, `mine ${i}`)),
		...sample(elements, 200, 1, named).map((like, i): ModelOp => ({
			kind: 'create_element',
			temp_id: `tmp_e${i}`,
			type_name: like.typeName,
			properties: { name: `new ${i}` }
		})),
		...sample(relationships, 200, 1, any).map((like, i): ModelOp => ({
			kind: 'create_relationship',
			temp_id: `tmp_r${i}`,
			type_name: like.typeName,
			source_id: like.source.id,
			target_id: like.target.id
		})),
		...sample(relationships, 50, 0, any).map((rel): ModelOp => ({
			kind: 'delete_relationship',
			id: rel.id
		})),
		...sample(elements, 50, 2, leaf).map((element): ModelOp => ({
			kind: 'delete_element',
			id: element.id
		}))
	];
	if (batch.length !== 1000) throw new Error(`the batch holds ${batch.length} ops`);
	return batch;
}

function measureEdits(wc: WorkingCopy): void {
	const { model } = wc;
	const named = namedIn(model);
	let [elements, relationships] = timed('iterate', () => entities(model));
	const batch = thousandOps(model, elements, relationships);
	timed('stage', () => wc.stage(batch));
	timed('unstage', () => wc.unstage('all'));
	// A deleted entity came back as a new record: the lists are read again.
	[elements, relationships] = timed('iterateAfter', () => entities(model));

	const mine = sample(elements, 100, 3, named);
	mine.forEach((element, i) => wc.stage([renamed(element, `mine ${i}`)]));
	const theirs = sample(elements, 100, 5, named);
	const one = deltaOver(wc, theirs.slice(0, 1), { elements: [], relationships: [] }, []);
	timed('rebase', () => wc.applyDelta(one));
	timed('unstageEntity', () => wc.unstage({ entity: mine[50]!.id }));
	wc.unstage('all');

	const delta = deltaOver(
		wc,
		theirs.slice(1),
		{ elements: sample(elements, 20, 7, any), relationships: sample(relationships, 20, 7, any) },
		sample(relationships, 10, 9, any)
	);
	timed('delta', () => wc.applyDelta(delta));
	const sound = !wc.diverged && wc.verifyDigest();
	if (!sound) throw new Error('the bench drove the replica off its digest');
}

/**
 * The issue store over the replica: its sweep, and edits like the ones above
 * through it, each revalidating what it may have moved. Then a group of
 * duplicates: one member's `uniqGroupOf`, and a sweep over it, whose members
 * each read the whole group.
 */
function measureIssues(wc: WorkingCopy): void {
	const { model } = wc;
	const named = namedIn(model);
	const live = new LiveIssues(wc);
	if (!stepped('sweep', 'sweepLongest', live.sweepSteps(), 'sweepFirst')) {
		throw new Error('the sweep ended unusable');
	}
	const batch = thousandOps(model, ...entities(model));
	timed('liveStage', () => live.stage(batch));
	timed('liveUnstage', () => live.unstage('all'));
	// A deleted entity came back as a new record: the lists are read again.
	const [elements] = entities(model);
	sample(elements, 100, 3, named).forEach((element, i) =>
		live.stage([renamed(element, `mine ${i}`)])
	);
	timed('probe', () => live.origins());
	const theirs = sample(elements, 100, 5, named);
	const one = deltaOver(wc, theirs.slice(0, 1), { elements: [], relationships: [] }, []);
	timed('liveDelta', () => live.applyDelta(one));
	live.unstage('all');

	// A rule over every element of the largest type, where there was none.
	const [largest] = [...model.indexes.byType].reduce((a, b) => (b[1].size > a[1].size ? b : a));
	const rule = { name: 'named', applies_to: largest, then: { property: 'name', exists: true } };
	const overLargest = compiledRules(wc, JSON.stringify({ rules: [rule] }));
	live.setRules({ working: overLargest, committed: overLargest });
	if (!stepped('rescan', 'rescanLongest', live.sweepSteps())) {
		throw new Error('the rescan ended unusable');
	}

	// Staged past the store: its dirty sets would sort the growing group once an op.
	const like = sample(elements, 1, 11, named)[0]!;
	const copies = Array.from({ length: DUPLICATES }, (_, i): ModelOp => ({
		kind: 'create_element',
		temp_id: `tmp_dup${i}`,
		type_name: like.typeName,
		properties: { ...like.props }
	}));
	wc.stage(copies);
	// A staged entity lives under its temp id.
	const copy = model.getElement('tmp_dup0');
	const group = timed('uniqGroup', () => model.indexes.uniqGroupOf(copy));
	if (group.length < DUPLICATES) throw new Error('the copies make no group');
	const grouped = new LiveIssues(wc);
	stepped('sweepGroup', 'sweepGroupLongest', grouped.sweepSteps(), null);
	if (grouped.store.size < DUPLICATES) throw new Error('the copies make no group');
	wc.unstage('all');
	const sound = !wc.diverged && wc.verifyDigest();
	if (!sound) throw new Error('the bench drove the replica off its digest');
}

/**
 * The issue list the panel reads after a keystroke that merges into the
 * latest staged batch, over 100 and then 1,000 staged batches, each read once
 * before the keystroke as the panel's refetch reads it.
 */
function measureKeystrokes(wc: WorkingCopy): void {
	const { model } = wc;
	const live = new LiveIssues(wc);
	drain(live.sweepSteps());
	const [elements] = entities(model);
	const named = sample(elements, 1000, 13, namedIn(model));
	let staged = 0;
	for (const [row, batches] of [
		['keystroke100', 100],
		['keystroke1000', 1000]
	] as const) {
		for (; staged < batches; staged++) live.stage([renamed(named[staged]!, `mine ${staged}`)]);
		issueListBody(live);
		const typed = live.stage([renamed(named[staged - 1]!, `mine ${staged - 1}!`)], {
			coalesce: true
		});
		if (!typed.coalesced) throw new Error('the keystroke did not merge');
		timed(row, () => issueListBody(live));
	}
	live.unstage('all');
	const sound = !wc.diverged && wc.verifyDigest();
	if (!sound) throw new Error('the bench drove the replica off its digest');
}

/**
 * The issue store with the bench rules: its sweep, a 1,000-op stage whose
 * dirty set their reach widens, and a probe over 100 staged batches with one
 * rule changed in the staged rule sets, the rescan it queued drained first.
 */
function measureRules(wc: WorkingCopy): void {
	const { model } = wc;
	const rules = compiledRules(wc, BENCH_RULES('3.0'));
	const live = new LiveIssues(wc, { rules: { working: rules, committed: rules } });
	if (!stepped('rulesSweep', 'rulesSweepLongest', live.sweepSteps(), null)) {
		throw new Error('the sweep with rules ended unusable');
	}
	const batch = thousandOps(model, ...entities(model));
	timed('rulesStage', () => live.stage(batch));
	live.unstage('all');
	const [elements] = entities(model);
	sample(elements, 100, 3, namedIn(model)).forEach((element, i) =>
		live.stage([renamed(element, `mine ${i}`)])
	);
	const changed = compiledRules(wc, BENCH_RULES('4.0'));
	live.setRules({ working: changed, committed: rules });
	drain(live.sweepSteps());
	timed('rulesProbe', () => live.origins());
	const prodReplicas = changed.rules.filter((cr) => cr.rule.name === 'prod-replicas');
	timed('rulesPopulation', () => appliesPopulation(model, { rules: prodReplicas }));
	live.unstage('all');
	const sound = !wc.diverged && wc.verifyDigest();
	if (!sound) throw new Error('the bench drove the replica off its digest');
}

const bytes = readFileSync(SNAPSHOT);
const metamodelDoc = JSON.parse(readFileSync(METAMODEL, 'utf-8')) as MetamodelDoc;

const heapMb: number[] = [];
let counts = '';

async function pass(): Promise<void> {
	const start = performance.now();
	let loaded = start;
	const { header, workingCopy } = await openSnapshot(
		cut(bytes),
		Metamodel.fromJSON(metamodelDoc),
		(done, total) => {
			if (done === total) loaded = performance.now();
		}
	);
	const end = performance.now();
	record('open', end - start);
	record('openRead', loaded - start);
	record('openIndex', end - loaded);
	if (!timed('verify', () => workingCopy.verifyDigest())) {
		throw new Error('the snapshot does not hold what its digest names');
	}
	if (!stepped('verifySteps', 'verifyLongest', workingCopy.verifyDigestSteps())) {
		throw new Error('the digest check in steps disagrees');
	}
	stepped('scan', 'scanLongest', search(workingCopy.model, 'a'));
	stepped('scanRare', null, search(workingCopy.model, 'sensor'));
	stepped('criteria', 'criteriaLongest', criteriaScan(workingCopy.model));
	stepped('navigation', 'navigationLongest', navigation(workingCopy.model));
	counts = `${count(header.elements)} elements, ${count(header.relationships)} relationships`;
	// Weighed before the document is read: the last text a regular expression
	// ran over stays reachable, and further down that is the whole document.
	globalThis.gc?.();
	globalThis.gc?.();
	heapMb.push(process.memoryUsage().heapUsed / 2 ** 20);

	const text = readFileSync(DOCUMENT, 'utf-8');
	const documentStart = performance.now();
	const doc = timed('documentParse', () => parseExact(text)) as { [key: string]: Value[] };
	const model = new Model(Metamodel.fromJSON(metamodelDoc));
	timed('documentLoad', () => {
		for (const element of doc['elements']!) model.loadElement(element);
		for (const rel of doc['relationships']!) model.loadRelationship(rel);
	});
	timed('documentIndex', () => model.rebuildIndexes());
	record('document', performance.now() - documentStart);
	stepped('indexSteps', 'indexLongest', model.rebuildIndexSteps());
	timed('nativeParse', () => JSON.parse(text) as unknown);

	measureEdits(workingCopy);
	measureIssues(workingCopy);
	measureKeystrokes(workingCopy);
	measureRules(workingCopy);
}

for (let i = 0; i < PASSES; i++) await pass();

const width = Math.max(...Object.values(ROWS).map((label) => label.length));
const shown = (ms: number) => ms.toFixed(ms < 10 ? 1 : 0);
const open = median(timings.get('open')!);
const heap = median(heapMb);

console.log(
	`\nModel M: ${counts}, ${(bytes.length / 2 ** 20).toFixed(1)} MiB inflated. ` +
		`Node ${process.version}; ms, median of ${PASSES} passes [each pass].\n`
);
for (const [row, label] of Object.entries(ROWS) as [Row, string][]) {
	const values = timings.get(row)!;
	const each = values.map(shown).join(' ');
	console.log(`${label.padEnd(width)}  ${shown(median(values)).padStart(6)}   [${each}]`);
}
const collected = globalThis.gc === undefined ? '   (run without --expose-gc: not collected)' : '';
const each = heapMb.map((mb) => mb.toFixed(0)).join(' ');
console.log(
	`${'heap after GC with one replica open, MB'.padEnd(width)}  ${heap.toFixed(0).padStart(6)}   [${each}]${collected}`
);
const verdict = (within: boolean) => (within ? 'within budget' : 'OVER BUDGET');
console.log(
	`\nopen: ${open.toFixed(0)} of ${OPEN_BUDGET_MS} ms, ${verdict(open <= OPEN_BUDGET_MS)}; ` +
		`heap: ${heap.toFixed(0)} of ${HEAP_BUDGET_MB} MB, ${verdict(heap <= HEAP_BUDGET_MB)}`
);
