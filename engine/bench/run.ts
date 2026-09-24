/**
 * The engine at model M: opening a snapshot, against opening the same model
 * as one document in the same pass; the digest check; the long operations in
 * steps — their total and their longest step, for there is no scheduler here;
 * the heap one replica holds; staging, rewinding, rebasing and a delta.
 *
 * `pixi run engine-bench-data` writes the input once, `pixi run engine-bench`
 * measures. Timings drift between sessions: compare only numbers of one run.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
	ArtifactSet,
	entityHash,
	EVALUATIONS,
	formatDigest,
	Metamodel,
	Model,
	openSnapshot,
	parseExact,
	READS,
	ViewPlacements,
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
	delta: 'apply a delta (99 changed, 40 new, 10 deleted), nothing staged'
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

/** Drives `steps` by hand: the whole run under `total`, its longest step under `longest`. */
function stepped<T>(total: Row, longest: Row | null, steps: Steps<T>): T {
	let worst = 0;
	const start = performance.now();
	for (;;) {
		const before = performance.now();
		const next = steps.next();
		worst = Math.max(worst, performance.now() - before);
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

function measureEdits(wc: WorkingCopy): void {
	const { model } = wc;
	const metamodel = model.metamodel;
	let [elements, relationships] = timed('iterate', () => entities(model));
	const named = (element: ElementRec) =>
		metamodel.effectiveElementPropertyNames(element.typeName).has('name');
	const leaf = (element: ElementRec) =>
		element.out.every((rel) => !metamodel.isContainment(rel.typeName));
	const any = () => true;

	// Deletions come last, relationships first: nothing names an entity already gone.
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
