import { ArtifactSet, readArtifacts, readStagedArtifacts } from '../artifacts/artifact-set.ts';
import { compareSteps, UploadedFile } from '../cr/compare.ts';
import { proposeSteps, readCrs, type ChangeRequest } from '../cr/propose.ts';
import { modelFileSteps } from '../download/model-file.ts';
import { evaluateFilled, type FillReader } from '../evaluate/fill.ts';
import { EVALUATIONS } from '../evaluate/index.ts';
import { Metamodel } from '../metamodel/metamodel.ts';
import type { MetamodelDoc } from '../metamodel/types.ts';
import { errorDetail, ModelError, SnapshotError } from '../model/errors.ts';
import { OpError } from '../ops/errors.ts';
import type { ModelOp } from '../ops/types.ts';
import { ReadError } from '../read/errors.ts';
import { READS, readScans } from '../read/index.ts';
import type { ReadParams } from '../read/params.ts';
import { ViewPlacements } from '../read/placements.ts';
import {
	readOps,
	wireElement,
	wireElementImage,
	wireOps,
	wireRelationship,
	toWire,
	wireRelImage
} from '../read/wire.ts';
import {
	compileRuleSets,
	type CompiledRules,
	type RuleSource,
	type RulesParse
} from '../rules/compile.ts';
import { RulesUnreadable } from '../rules/document.ts';
import { ruleSources } from '../rules/sources.ts';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../script/bridge.ts';
import {
	consoleAnswer,
	readRunSnippet,
	type RunSnippetParams,
	type RunStamp
} from '../script/console.ts';
import { snippetFetch } from '../script/snippets.ts';
import { CellCache } from '../script/cell-cache.ts';
import type {
	AbortSignalLike,
	Bridge,
	ScriptBatch,
	ScriptCall,
	ScriptHost
} from '../script/host.ts';
import { deletedKeys, touchedKeys } from '../script/touched.ts';
import { openSnapshot, type OpenedSnapshot, type SnapshotHeader } from '../snapshot/open.ts';
import { drain, isSteps, type Steps } from '../steps/steps.ts';
import { TableOrderCache } from '../table/order-cache.ts';
import { issueListBody, previewBody, validateBody } from '../validation/bodies.ts';
import {
	candidateDiff,
	candidateScan,
	prepareCandidate,
	rebindPreviewBody,
	stagedAdmitted,
	type Candidate
} from '../validation/candidate.ts';
import type { Issue } from '../validation/issue.ts';
import { deltaEnds, deltaIds, LiveIssues, type SweepStep } from '../validation/live.ts';
import { PatternUnusable } from '../validation/pipeline.ts';
import { parseExact } from '../value/parse.ts';
import { pyRepr } from '../value/repr.ts';
import type { Value } from '../value/types.ts';
import { readDeltaText, readTailText, type Delta } from '../working/delta.ts';
import type {
	ChangeSet,
	Conflict,
	OwnCommit,
	StagedBatch,
	Unstage,
	WorkingCopy
} from '../working/working-copy.ts';
import { ByteQueue } from './byte-queue.ts';
import { Scheduler, type Job, type Lane, type Outcome } from './scheduler.ts';
import type {
	AdoptResult,
	DeltaResult,
	ErrorBody,
	Port,
	ProgressTask,
	ReplicaState,
	ScriptCallsResult,
	ScriptWarmResult,
	ServiceDeps,
	ServiceEvent,
	StagedDiffResult,
	StageResult,
	TailResult,
	WireBatch,
	WireChanges,
	WireConflict
} from './types.ts';

/** A refusal of the service's own, in the HTTP vocabulary. */
class Refused extends Error {
	readonly status: number;
	readonly detail: string;

	constructor(status: number, detail: string) {
		super(detail);
		this.name = 'Refused';
		this.status = status;
		this.detail = detail;
	}
}

function errorBody(error: unknown): ErrorBody {
	if (error instanceof OpError || error instanceof ReadError || error instanceof Refused) {
		return { status: error.status, detail: error.detail };
	}
	if (error instanceof ModelError) {
		return error.kind === 'key'
			? { status: 404, detail: errorDetail(error) }
			: { status: 422, detail: error.message };
	}
	if (error instanceof SnapshotError) return { status: 422, detail: error.message };
	return { status: 500, detail: error instanceof Error ? error.message : String(error) };
}

/** A bridge reply that carries only a failure, echoing the request's `id` when the text has one. */
function bridgeFailure(requestText: string, error: string): string {
	let id: Value = null;
	try {
		const request = parseExact(requestText, { floatConstants: true, controlCharacters: false });
		if (isObject(request) && Object.hasOwn(request, 'id')) id = (request as { id: Value }).id;
	} catch {
		// Not JSON: the reply carries no id.
	}
	return dumpDefault({ id, error });
}

// -- the boundary out ----------------------------------------------------------

const wireChanges = (changes: ChangeSet): WireChanges => ({
	element_ids: [...changes.elementIds],
	relationship_ids: [...changes.relationshipIds],
	deleted_element_ids: [...changes.deletedElementIds],
	deleted_relationship_ids: [...changes.deletedRelationshipIds],
	structural: changes.structural
});

const wireBatch = (batch: StagedBatch): WireBatch => ({ id: batch.id, ops: wireOps(batch.ops) });

const wireConflict = (conflict: Conflict): WireConflict => ({
	batch: wireBatch(conflict.batch),
	error: { status: conflict.error.status, detail: conflict.error.detail }
});

function stagedDiff(wc: WorkingCopy): StagedDiffResult {
	const diff = wc.stagedDiff();
	return {
		elements: diff.elements.map(({ id, before, after }) => ({
			id,
			before: before === null ? null : wireElementImage(before),
			after: after === null ? null : wireElement(after)
		})),
		relationships: diff.relationships.map(({ id, before, after }) => ({
			id,
			before: before === null ? null : wireRelImage(before),
			after: after === null ? null : wireRelationship(after)
		}))
	};
}

/** Past this many changed entities, `stage` answers their ids alone. */
const STAGE_POST_STATE_MAX = 500;

/** The refusals the client answers from the server (501), and the ones it retries there (409). */
const UNSUPPORTED_PATTERN = 'reaches an unsupported pattern';
const UNREADABLE_RULES = 'reaches unreadable rules';
const REFUSED_OPS = 'reaches ops the candidate refuses';
const NOT_READY = 'replica is not ready';
const STALE_BATCHES = 'stale staged batches';
const STALE_BASE = 'stale base_rev';

// -- the cell cache's view of a transition -------------------------------------

/**
 * The ids a stage may remove from the state it leaves, besides what it names itself: a staged
 * entity it deletes is known only there, where a committed one has its committed image. A merge
 * into a staged batch replays the batches from it on, which may park one.
 */
function stageLeaves(wc: WorkingCopy, ops: readonly ModelOp[]): readonly string[] | null {
	const op = ops.length === 1 ? ops[0]! : null;
	if (op?.kind === 'update_element' || op?.kind === 'update_relationship') {
		const at = wc.mergePoint(op);
		if (at >= 0) return [...wc.touchedIds(at), op.id];
	}
	const deletes = ops.some(
		(one) => one.kind === 'delete_element' || one.kind === 'delete_relationship'
	);
	return deletes ? wc.touchedIds() : null;
}

/** The ids a delta may touch in the state it leaves, as the issue store reads them: none when it moves nothing. */
function deltaLeaves(wc: WorkingCopy, delta: Delta, own: OwnCommit | undefined) {
	if (delta.prev_rev !== wc.rev && own === undefined) return null;
	return [...wc.touchedIds(), ...deltaIds(delta), ...deltaEnds(delta)];
}

/** Whether a transition's error left the model as it was: a refused batch leaves no trace, nor a delta it cannot read. */
const leftNoTrace = (error: unknown) => error instanceof OpError || error instanceof SnapshotError;

// -- the boundary in -----------------------------------------------------------

const isObject = (value: unknown): value is { [key: string]: unknown } =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string | number =>
	typeof value === 'string' || typeof value === 'number';

function text(params: ReadParams, key: string): string {
	const value = params[key];
	if (typeof value !== 'string') throw new Refused(422, `${key} must be a string`);
	return value;
}

function strings(params: ReadParams, key: string): string[] {
	const value = params[key];
	if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
		throw new Refused(422, `${key} must be a list of strings`);
	}
	return value as string[];
}

function integer(params: ReadParams, key: string): number {
	const value = params[key];
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new Refused(422, `${key} must be an integer`);
	}
	return value;
}

function flag(params: ReadParams, key: string): boolean {
	const value = params[key];
	if (typeof value !== 'boolean') throw new Refused(422, `${key} must be a boolean`);
	return value;
}

/** The client's clock reading, which a change request carries as its `createdAt`. */
function createdAtOf(params: ReadParams): string {
	const createdAt = params['created_at'];
	if (typeof createdAt !== 'string' || createdAt === '') {
		throw new Refused(422, 'created_at must be a string');
	}
	return createdAt;
}

/** `compareModel`'s params: the file's bytes, kept whole for a scan that starts over, and the clock's reading. */
function readCompare(params: ReadParams): { file: UploadedFile; createdAt: string } {
	const file = params['file'];
	if (!(file instanceof ArrayBuffer)) throw new Refused(422, 'file must be an ArrayBuffer');
	return { file: new UploadedFile(file), createdAt: createdAtOf(params) };
}

/** `proposeCr`'s params: the change requests, read once for every start, and the clock's reading. */
function readPropose(params: ReadParams): { crs: ChangeRequest[]; createdAt: string } {
	return { crs: readCrs(params['crs']), createdAt: createdAtOf(params) };
}

function batchIds(params: ReadParams): number[] {
	const value = params['batch_ids'];
	if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id))) {
		throw new Refused(422, 'batch_ids must be a list of batch ids');
	}
	return value as number[];
}

/** Refuses unless `ids` are the staged batches', in order: the ops a caller sent are the ones staged. */
function requireStaged(wc: WorkingCopy, ids: readonly number[]): void {
	const staged = wc.staged();
	if (staged.length !== ids.length || staged.some((batch, i) => batch.id !== ids[i])) {
		throw new Refused(409, STALE_BATCHES);
	}
}

function readBatches(raw: unknown): StagedBatch[] {
	if (!Array.isArray(raw)) throw new Refused(422, 'batches must be a list');
	return raw.map((batch: unknown, i) => {
		const where = `batches[${i}]`;
		if (!isObject(batch)) throw new Refused(422, `${where}: must be an object`);
		const id = batch['id'];
		if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
			throw new Refused(422, `${where}.id must be a batch id`);
		}
		return { id, ops: readOps(batch['ops'], `${where}.ops`) };
	});
}

function readOwn(raw: unknown): OwnCommit | undefined {
	if (raw === undefined || raw === null) return undefined;
	const refuse = () => new Refused(422, 'own must be {batch_ids, id_map}');
	if (!isObject(raw)) throw refuse();
	const [batchIds, idMap] = [raw['batch_ids'], raw['id_map']];
	if (!Array.isArray(batchIds) || !batchIds.every((id) => typeof id === 'number')) throw refuse();
	if (!isObject(idMap) || !Object.values(idMap).every((id) => typeof id === 'string')) {
		throw refuse();
	}
	return { batchIds: batchIds as number[], idMap: new Map(Object.entries(idMap as object)) };
}

/** `previewCommit`'s `rebind`: absent or `null` for a batch that rebinds nothing. */
function readRebind(raw: unknown): { metamodel: unknown } | null {
	if (raw === undefined || raw === null) return null;
	if (!isObject(raw)) throw new Refused(422, 'rebind must be {metamodel}');
	return { metamodel: raw['metamodel'] };
}

/** A candidate document's refusal: the 501s the client takes to the server, else a 422 as `open` gives. */
function candidateRefusal(error: unknown): Refused {
	if (error instanceof PatternUnusable) return new Refused(501, UNSUPPORTED_PATTERN);
	if (error instanceof RulesUnreadable) return new Refused(501, UNREADABLE_RULES);
	return new Refused(422, `metamodel: ${error instanceof Error ? error.message : String(error)}`);
}

function readUnstage(raw: unknown): Unstage {
	if (raw === 'all') return raw;
	if (isObject(raw)) {
		const { batch, entity, incident } = raw;
		if (typeof batch === 'number' && entity === undefined) return { batch };
		if (typeof entity === 'string' && batch === undefined) {
			if (incident === undefined || typeof incident === 'boolean') return { entity, incident };
		}
	}
	throw new Refused(422, "what must be 'all', {batch} or {entity, incident?}");
}

const SCRIPT_ENTRIES: readonly string[] = ['value', 'step', 'transform', 'script'];

/** The kind of a snippet artifact, as the server stores it (`ArtifactKind.code_snippet`). */
const SNIPPET_KIND = 'code_snippet';

/** A call's `inputs_text` or `doc_text`, read exactly as the script is to see it; `undefined` when absent. */
function jsonText(call: ReadParams, key: string, where: string): Value | undefined {
	const raw = call[key];
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'string') throw new Refused(422, `${where}.${key} must be a string`);
	try {
		return parseExact(raw, { floatConstants: true, controlCharacters: false });
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		throw new Refused(422, `${where}.${key} is not valid JSON: ${why}`);
	}
}

/** `scriptCalls`' params, read whole before anything runs. */
function readScriptBatch(params: ReadParams): ScriptBatch {
	const code = text(params, 'code');
	const entry = params['entry'];
	if (typeof entry !== 'string' || !SCRIPT_ENTRIES.includes(entry)) {
		throw new Refused(422, "entry must be 'value', 'step', 'transform' or 'script'");
	}
	const consoleRun = params['console'];
	if (consoleRun !== undefined && typeof consoleRun !== 'boolean') {
		throw new Refused(422, 'console must be a boolean');
	}
	if (entry === 'transform' && consoleRun === true) {
		throw new Refused(422, 'a console run has no transform entry');
	}
	const raw = params['calls'];
	if (!Array.isArray(raw)) throw new Refused(422, 'calls must be a list');
	if (entry === 'script' && raw.length !== 1) {
		throw new Refused(422, "entry 'script' takes exactly one call");
	}
	const calls = raw.map((item: unknown, i): ScriptCall => {
		const where = `calls[${i}]`;
		if (!isObject(item)) throw new Refused(422, `${where} must be an object`);
		const ids = item['element_ids'];
		if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
			throw new Refused(422, `${where}.element_ids must be a list of strings`);
		}
		const inputs = jsonText(item, 'inputs_text', where);
		const doc = jsonText(item, 'doc_text', where);
		return {
			elementIds: ids as string[],
			...(inputs === undefined ? {} : { inputs }),
			...(doc === undefined ? {} : { doc })
		};
	});
	return {
		code,
		entry: entry as ScriptBatch['entry'],
		...(consoleRun === undefined ? {} : { console: consoleRun }),
		calls
	};
}

/** What a run watches to be cancelled: the engine's sources have no DOM to name an `AbortController`. */
type Abortable = {
	readonly signal: AbortSignalLike & { readonly reason?: unknown };
	abort(reason?: unknown): void;
};

function abortable(): Abortable {
	let aborted = false;
	let why: unknown;
	const listeners = new Set<() => void>();
	return {
		signal: {
			get aborted() {
				return aborted;
			},
			get reason() {
				return why;
			},
			addEventListener: (_type, listener) => void listeners.add(listener),
			removeEventListener: (_type, listener) => void listeners.delete(listener)
		},
		abort(reason) {
			if (aborted) return;
			aborted = true;
			why = reason;
			for (const listener of [...listeners]) listener();
		}
	};
}

// -- calls and methods ---------------------------------------------------------

/** A request being served: answered once, or not at all once cancelled. */
type Call = {
	readonly id: string | number;
	readonly params: ReadParams;
	cancelled: boolean;
	/** Set by a method that has work to stop when the call is cancelled. */
	onCancel?: () => void;
	/** Posts `result`, moving the buffers of `transfer` to the other side. */
	answer(result: unknown, transfer?: readonly ArrayBuffer[]): void;
	refuse(error: unknown): void;
};

/** What an answer moves rather than copies: a result's `parts`, when they are all `ArrayBuffer`s. */
function transferOf(result: unknown): readonly ArrayBuffer[] | undefined {
	if (!isObject(result)) return undefined;
	const { parts } = result;
	return Array.isArray(parts) && parts.every((part) => part instanceof ArrayBuffer)
		? (parts as ArrayBuffer[])
		: undefined;
}

type Method = (service: Service, call: Call) => void;

/** Answered at once, in any state. */
const now =
	(run: (service: Service, params: ReadParams) => unknown): Method =>
	(service, call) =>
		call.answer(run(service, call.params));

/** Answered when the work it starts settles; cancellable meanwhile. */
const later =
	(run: (service: Service, params: ReadParams) => Promise<unknown>): Method =>
	(service, call) =>
		service.answerLater(call, run(service, call.params));

/** A read of the model: waits for a ready replica, in arrival order. */
const read =
	(method: string): Method =>
	(service, call) =>
		service.read(method, call);

/** An evaluation: always a scan of the model, waiting for a ready replica in arrival order. */
const evaluate =
	(method: string): Method =>
	(service, call) =>
		service.evaluate(method, call);

/** A read of the working copy itself, queued as a read of the model is. */
const inspect =
	(run: (wc: WorkingCopy) => unknown): Method =>
	(service, call) =>
		service.inspect(call, run);

/**
 * A transition of the model: waits for a ready replica, in arrival order.
 * `accept` reads the params at arrival — a malformed request is refused
 * before it queues — and returns what the transition runs.
 */
const transition =
	(accept: (service: Service, params: ReadParams) => (wc: WorkingCopy) => unknown): Method =>
	(service, call) =>
		service.transition(call, accept(service, call.params));

const METHODS: { readonly [method: string]: Method } = {
	open: now((service, params) => service.open(params)),
	chunk: now((service, params) => service.chunk(params)),
	end: later((service) => service.end()),
	close: now((service) => service.close()),
	scriptCalls: (service, call) => service.scriptCalls(call),
	runSnippet: (service, call) => service.runSnippet(call),
	scriptWarm: (service, call) => service.scriptWarm(call),
	adoptStaged: (service, call) => service.adoptStaged(call),
	applyTail: (service, call) => service.applyTail(call),
	applyDelta: (service, call) => service.applyDelta(call),

	stage: transition((service, params) => {
		const ops = readOps(params['ops']);
		return (wc) => service.stage(wc, ops);
	}),
	unstage: transition((service, params) => {
		const what = readUnstage(params['what']);
		return (wc) => service.unstage(wc, what);
	}),

	getModelIssues: (service, call) => service.issues(call, issueListBody),
	validateModel: (service, call) => service.validateModel(call, batchIds(call.params)),
	previewCommit: (service, call) => {
		const baseRev = integer(call.params, 'base_rev');
		const ids = batchIds(call.params);
		const strict = flag(call.params, 'strict');
		const rebind = readRebind(call.params['rebind']);
		const check = (wc: WorkingCopy) => {
			if (wc.rev !== baseRev) throw new Refused(409, STALE_BASE);
			requireStaged(wc, ids);
		};
		if (rebind === null) service.issues(call, (live) => previewBody(live, strict), check);
		else {
			service.candidate(call, {
				doc: rebind.metamodel,
				layer: 'committed',
				check,
				admits: stagedAdmitted,
				answer: (_live, issues) => rebindPreviewBody(issues)
			});
		}
	},
	candidateIssues: (service, call) =>
		service.candidate(call, {
			doc: call.params['metamodel'],
			layer: 'working',
			check: () => undefined,
			answer: (live, issues) => candidateDiff(live.store.iter(), issues)
		}),
	downloadModel: (service, call) => service.scanWorking(call, (wc) => modelFileSteps(wc)),
	compareModel: (service, call) => {
		const { file, createdAt } = readCompare(call.params);
		service.scanWorking(call, (wc) => compareSteps(wc, { file, created_at: createdAt }));
	},
	proposeCr: (service, call) => {
		const { crs, createdAt } = readPropose(call.params);
		service.scanWorking(call, (wc) => proposeSteps(wc, { crs, created_at: createdAt }));
	},

	staged: now((service) => service.wc?.staged().map(wireBatch) ?? []),
	conflicts: now((service) => service.wc?.conflicts().map(wireConflict) ?? []),
	stagedDiff: inspect(stagedDiff),

	setViewPlacement: now((service, params) => {
		const elementIds = strings(params, 'element_ids');
		service.placements.set(text(params, 'view_id'), elementIds);
		return null;
	}),
	dropViewPlacement: now((service, params) => {
		service.placements.drop(text(params, 'view_id'));
		return null;
	}),

	setArtifacts: now((service, params) => {
		const artifacts = readArtifacts(params['artifacts']);
		service.moveArtifacts(() => service.artifacts.setCommitted(artifacts));
		return null;
	}),
	putArtifacts: now((service, params) => {
		const changed = readArtifacts(params['changed'], 'changed');
		const deletedIds = strings(params, 'deleted_ids');
		const staged = params['staged'];
		const entries =
			staged === undefined || staged === null ? null : readStagedArtifacts(staged, 'staged');
		service.moveArtifacts(() => {
			service.artifacts.put(changed, deletedIds);
			if (entries !== null) service.artifacts.setStaged(entries);
		});
		return null;
	}),
	setStagedArtifacts: now((service, params) => {
		const entries = readStagedArtifacts(params['entries']);
		service.moveArtifacts(() => service.artifacts.setStaged(entries));
		return null;
	}),

	...Object.fromEntries(Object.keys(READS).map((method) => [method, read(method)])),
	...Object.fromEntries(Object.keys(EVALUATIONS).map((method) => [method, evaluate(method)]))
};

/** Whether two parses compile alike. */
function sameParse(a: RulesParse | null, b: RulesParse | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.ok && b.ok) return a.document === b.document;
	if (!a.ok && !b.ok) return a.errors[0]?.message === b.errors[0]?.message;
	return false;
}

/** Whether two lists of rule sets compile alike: the same sets, in the same order, parsed alike. */
function sameSources(a: readonly RuleSource[], b: readonly RuleSource[]): boolean {
	return (
		a.length === b.length &&
		a.every((source, i) => {
			const other = b[i]!;
			return (
				source.artifactId === other.artifactId &&
				source.name === other.name &&
				sameParse(source.parse, other.parse)
			);
		})
	);
}

/** One layer's rule sets compiled, with the sources they were compiled from. */
type Compiled = { readonly sources: readonly RuleSource[]; readonly rules: CompiledRules };

/** What a transition returns for a call it leaves waiting: nothing is answered. */
const WAITING = Symbol('waiting');

/** What a candidate scan returns when the store moved under it: its call waits and scans again. */
const MOVED = Symbol('moved');

/**
 * A call over the working copy under a candidate metamodel: the document, the
 * layer whose rule sets are compiled under it, the check that refuses a stale
 * call, whether the working copy is one the server reaches under the
 * candidate (always, when absent), and the answer over the store and the
 * candidate's issues.
 */
type CandidateCall = {
	readonly doc: unknown;
	readonly layer: 'working' | 'committed';
	readonly check: (wc: WorkingCopy) => void;
	readonly admits?: (wc: WorkingCopy, candidate: Metamodel) => boolean;
	readonly answer: (live: LiveIssues, issues: readonly Issue[]) => unknown;
};

/** A candidate, with the rule sources compiled under it. */
type Prepared = { readonly sources: readonly RuleSource[]; readonly candidate: Candidate };

/** Where the store stood when a candidate scan began: the probe's cache key, on that store. */
type Stamp = {
	readonly live: LiveIssues;
	readonly rev: number;
	readonly stagedVersion: number;
	readonly rulesVersion: number;
};

type Opening = {
	readonly projectId: string;
	readonly queue: ByteQueue;
	settled: Promise<Outcome<OpenedSnapshot>>;
	discarded: boolean;
	ending: boolean;
};

/**
 * The issue store of the ready replica: `seen`, how much of its `version` the
 * service has counted; `working` and `committed`, its rule sets as compiled
 * against the replica's metamodel; `stalled`, whether its steps left the
 * sweep slot by throwing, so that nothing drives them.
 */
type Issues = {
	readonly live: LiveIssues;
	seen: number;
	working: Compiled;
	committed: Compiled;
	stalled: boolean;
};

class Service {
	readonly placements = new ViewPlacements();
	readonly artifacts = new ArtifactSet();
	state: ReplicaState = 'opening';
	wc: WorkingCopy | null = null;

	private readonly port: Port;
	private readonly deps: ServiceDeps;
	private readonly scheduler: Scheduler;
	// The replica's table orders, dropped with it.
	private readonly tableOrders = new TableOrderCache();
	private opening: Opening | null = null;
	// The last open's failure, answered to `chunk` and `end` until the next open.
	private failed: unknown = null;
	private readonly progressHeld = new Map<ProgressTask, { done: number; total: number }>();
	private readonly awaiting = new Map<string | number, Call>();
	private issuesOf: Issues | null = null;
	// Moves with every store's `version`, across replicas: it never goes back.
	private issuesVersion = 0;
	private issuesPosted = 0;
	// The calls waiting for the store: for a sweep `validateModel` restarted, or for a rescan.
	private readonly waiting = new Set<Call>();
	// The script host, made by the first `scriptCalls` or prewarm and disposed by `close`; the host owns its boots.
	private scripting: ScriptHost | null = null;
	// The read-only dispatcher the embedded runs over one working copy share, and that working copy alone.
	private bridged: { readonly wc: WorkingCopy; readonly dispatcher: BridgeDispatcher } | null =
		null;
	// Moves whenever a replica is dropped: a run is pinned to the epoch it began in.
	private epoch = 0;
	// The runs in flight; a replica dropped under them stops them.
	private readonly running = new Set<() => void>();
	// The epoch the host was last told to prewarm for.
	private prewarmed = -1;
	// The one cell cache: a fill that waited for a replica reads it, empty whenever no replica is in hand.
	private readonly cellCache = new CellCache();
	// `cellCache` where the host gave the engine a script host; `null` otherwise.
	private readonly cells: CellCache | null;
	// Moves with every transition that changes the replica's model and every clear of `cells`: a fill keeps what a
	// round answered only if it has not moved since the pass that asked for it began.
	private transitions = 0;
	// The fills in flight, with the calls each has asked for and finished; `fillsEnded` holds those of the fills
	// that ended while others ran, so that the sum only grows until the last one ends.
	private readonly fills = new Set<{ done: number; total: number }>();
	private fillsEnded = { done: 0, total: 0 };
	private fillsPosted = { done: 0, total: 0 };

	constructor(port: Port, deps: ServiceDeps) {
		this.port = port;
		this.deps = deps;
		this.cells = deps.scripts === undefined ? null : this.cellCache;
		this.scheduler = new Scheduler(deps, {
			onSliceEnd: () => {
				this.flushProgress();
				this.flushIssues();
			}
		});
		port.onMessage((message) => this.receive(message));
	}

	// -- messages ------------------------------------------------------------

	private receive(message: unknown): void {
		if (!isObject(message)) return;
		if (isId(message['cancel']) && message['method'] === undefined) {
			this.cancel(message['cancel']);
			return;
		}
		const { id, method, params = {} } = message;
		if (!isId(id) || typeof method !== 'string') return;
		const call = this.call(id, isObject(params) ? params : {});
		if (!isObject(params)) {
			call.refuse(new Refused(422, 'params must be an object'));
			return;
		}
		const handler = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined;
		if (handler === undefined) {
			call.refuse(new Refused(404, `No method ${pyRepr(method)}`));
			return;
		}
		try {
			handler(this, call);
		} catch (error) {
			call.refuse(error);
		}
	}

	private call(id: string | number, params: ReadParams): Call {
		let settled = false;
		const post = (message: object, transfer?: readonly ArrayBuffer[]) => {
			this.awaiting.delete(id);
			if (settled || call.cancelled) return;
			settled = true;
			this.port.post(message, transfer);
		};
		const call: Call = {
			id,
			params,
			cancelled: false,
			answer: (result, transfer) => post({ id, ok: true, result }, transfer),
			refuse: (error) => post({ id, ok: false, error: errorBody(error) })
		};
		return call;
	}

	private cancel(id: string | number): void {
		this.scheduler.cancel(id);
		const call = this.awaiting.get(id);
		if (call === undefined) return;
		call.cancelled = true;
		call.onCancel?.();
	}

	answerLater(
		call: Call,
		work: Promise<unknown>,
		transfer?: (result: unknown) => readonly ArrayBuffer[] | undefined
	): void {
		this.awaiting.set(call.id, call);
		work.then((result) => call.answer(result, transfer?.(result)), call.refuse);
	}

	private submit<T>(
		call: Call,
		lane: Lane,
		job: Job<T>,
		transfer?: (result: T) => readonly ArrayBuffer[] | undefined
	): void {
		this.scheduler.submit(call.id, lane, job, (outcome) =>
			outcome.ok
				? call.answer(outcome.value, transfer?.(outcome.value))
				: call.refuse(outcome.error)
		);
	}

	read(method: string, call: Call): void {
		const run = () => {
			const params =
				method === 'getModelSummary'
					? { ...call.params, model_rev: this.ready().rev }
					: call.params;
			return READS[method]!(this.ready().model, this.placements, params);
		};
		if (readScans(method, call.params)) {
			this.submit(call, 'model', { kind: 'scan', run: () => run() as Steps<unknown> });
		} else {
			this.submit(call, 'model', {
				kind: 'read',
				run: () => {
					const out = run();
					return isSteps(out) ? drain(out) : out;
				}
			});
		}
	}

	/**
	 * Each `run()` reads where the replica stands: no transition of the model
	 * lane runs while the scan does, so the stamp holds to its end. A result's
	 * byte parts are transferred, not copied: nothing keeps them.
	 */
	evaluate(method: string, call: Call): void {
		this.evaluateFilled(method, call);
	}

	/**
	 * An evaluation: the scan runs as a pass of a fill, which runs the scripts the pass could not
	 * answer and runs it again. Each pass is a scan of the model lane, so no transition lands
	 * within one, and the fill runs between passes, outside the scheduler: a stage or a delta lands there and the fill sees it move. A pass is
	 * read at the state its scan started in, and answered whatever lands after it. The call belongs
	 * to the replica its first scan started on, as a call waiting for a replica to be ready waits
	 * for the next one: that replica dropped, it is answered 409, and a cancel stops its batches
	 * and answers nothing. Without a script host a pass that needs a script run answers 503.
	 */
	private evaluateFilled(method: string, call: Call): void {
		const cancel = abortable();
		call.onCancel = () => cancel.abort(new Error('the call was cancelled'));
		this.answerLater(call, this.fill(method, call, cancel), transferOf);
	}

	private async fill(method: string, call: Call, cancel: Abortable): Promise<unknown> {
		const mine = { done: 0, total: 0 };
		// The replica of the first scan: -1 until it starts. Only from then does a replica dropped stop the fill.
		let epoch = -1;
		const start = () => {
			if (epoch < 0) {
				this.ready();
				epoch = this.epoch;
				this.running.add(cancel.abort);
			} else {
				this.stillReady(epoch);
			}
		};
		this.fills.add(mine);
		try {
			const { value } = await evaluateFilled(
				(scripts) => this.pass(method, call, start, scripts, cancel.signal),
				{
					runner: async (batch, signal) => {
						if (this.deps.scripts === undefined) throw new ReadError(503, 'no script host');
						const { results } = await this.runBatch(batch, signal, epoch);
						return results.map(({ text }) => text);
					},
					signal: cancel.signal,
					...(this.cells === null ? {} : { cache: this.cells }),
					transitions: () => this.transitions,
					onProgress: (done, total) => {
						mine.done = done;
						mine.total = total;
						if (this.epoch === epoch) this.postScripts();
					}
				}
			);
			return value;
		} catch (error) {
			// A replica dropped under the fill aborted it: the refusal is the one of a run on it.
			if (epoch >= 0 && this.epoch !== epoch) this.stillReady(epoch);
			throw error;
		} finally {
			this.running.delete(cancel.abort);
			this.endFill(mine, this.epoch === epoch || epoch < 0);
		}
	}

	/**
	 * One pass of a fill: the evaluation as a model-lane scan reading through `scripts`, answered
	 * when the scan ends. `start` pins the fill to the replica its first scan runs on and refuses a
	 * scan on any other. An abort takes the scan out of the lane and rejects the pass.
	 */
	private pass(
		method: string,
		call: Call,
		start: () => void,
		scripts: FillReader,
		signal: AbortSignalLike & { readonly reason?: unknown }
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const stop = () => {
				this.scheduler.cancel(call.id);
				reject(signal.reason);
			};
			signal.addEventListener('abort', stop);
			this.scheduler.submit(
				call.id,
				'model',
				{
					kind: 'scan',
					run: () => {
						start();
						const wc = this.ready();
						// Nothing moves the model while the scan runs: this is the state it reads.
						scripts.begin();
						return EVALUATIONS[method]!(
							{
								model: wc.model,
								artifacts: this.artifacts,
								placements: this.placements,
								working: {
									rev: wc.rev,
									stagedVersion: wc.stagedVersion,
									tableOrders: this.tableOrders
								},
								scripts
							},
							call.params
						);
					}
				},
				(outcome) => {
					signal.removeEventListener('abort', stop);
					if (outcome.ok) resolve(outcome.value);
					else reject(outcome.error);
				}
			);
		});
	}

	/** Posts the calls the fills in flight and those just ended have finished and asked for, summed. */
	private postScripts(): void {
		let { done, total } = this.fillsEnded;
		for (const fill of this.fills) {
			done += fill.done;
			total += fill.total;
		}
		if (total === 0 || (done === this.fillsPosted.done && total === this.fillsPosted.total)) return;
		this.fillsPosted = { done, total };
		this.emit({ event: 'progress', task: 'scripts', done, total });
	}

	/**
	 * A fill is over: what it asked for counts as done, and the last one to end starts the count
	 * anew. `post` is false for a fill of a replica that was dropped: the next one's stream is not
	 * told of it.
	 */
	private endFill(fill: { done: number; total: number }, post: boolean): void {
		this.fills.delete(fill);
		this.fillsEnded = {
			done: this.fillsEnded.done + fill.total,
			total: this.fillsEnded.total + fill.total
		};
		if (post) this.postScripts();
		if (this.fills.size === 0) {
			this.fillsEnded = { done: 0, total: 0 };
			this.fillsPosted = { done: 0, total: 0 };
		}
	}

	/**
	 * A scan of the working copy itself, as an evaluation is: `run` makes the
	 * steps afresh on every start. A result's byte parts are transferred.
	 */
	scanWorking(call: Call, run: (wc: WorkingCopy) => Steps<unknown>): void {
		this.submit<unknown>(call, 'model', { kind: 'scan', run: () => run(this.ready()) }, transferOf);
	}

	inspect(call: Call, run: (wc: WorkingCopy) => unknown): void {
		this.submit(call, 'model', { kind: 'read', run: () => run(this.ready()) });
	}

	transition(call: Call, run: (wc: WorkingCopy) => unknown): void {
		this.submit(call, 'model', { kind: 'transition', run: () => run(this.ready()) });
	}

	/** The replica a model-lane job runs on: the lane runs only while there is a ready one. */
	private ready(): WorkingCopy {
		if (this.state !== 'ready' || this.wc === null) throw new Refused(409, NOT_READY);
		return this.wc;
	}

	// -- scripts -------------------------------------------------------------

	/** Refuses a call whose replica is gone or no longer ready since it arrived in `epoch`. */
	private stillReady(epoch: number): void {
		if (this.epoch !== epoch) {
			throw new Refused(409, this.state === 'diverged' ? NOT_READY : 'replica closed');
		}
		this.ready();
	}

	/** Moves the epoch: what ran on the replica that went stops. */
	private nextEpoch(): void {
		this.bridged = null;
		this.epoch++;
		for (const abort of this.running) abort();
	}

	/** The dispatcher the embedded runs on `wc` share: it reads and records nothing. */
	private sharedDispatcher(wc: WorkingCopy): BridgeDispatcher {
		if (this.bridged?.wc !== wc) {
			this.bridged = { wc, dispatcher: new BridgeDispatcher(wc.model, false) };
		}
		return this.bridged.dispatcher;
	}

	/**
	 * The bridge of one run: it answers from `wc` through `dispatcher` while the replica is the
	 * ready one the run began on, and `BridgeError: replica is not ready` ever after, even once a
	 * replica opened since is ready. `dispatch` runs in the message handler, so it always answers
	 * and never throws: a host may be blocked on the reply.
	 */
	private bridgeOf(epoch: number, wc: WorkingCopy, dispatcher: BridgeDispatcher): Bridge {
		const live = () => this.epoch === epoch && this.state === 'ready';
		return {
			dispatch: (requestText) => {
				try {
					if (!live()) return bridgeFailure(requestText, `BridgeError: ${NOT_READY}`);
					return dispatcher.dispatch(requestText);
				} catch (error) {
					const why = error instanceof Error ? error.message : String(error);
					return bridgeFailure(requestText, `RuntimeError: ${why}`);
				}
			},
			roots: (ids) => (live() ? dumpDefault(projectRoots(wc.model, ids)) : '[]')
		};
	}

	/** `scriptCalls`: its params are read at arrival, so a malformed call is refused before it runs. */
	scriptCalls(call: Call): void {
		const batch = readScriptBatch(call.params);
		const run = abortable();
		call.onCancel = run.abort;
		this.answerLater(call, this.runScripts(batch, run));
	}

	/**
	 * `runSnippet`: one console run over the working copy, answered with the ops it proposes (a
	 * `script` entry only) and the stamp the replica stood at when it began. It runs as `scriptCalls`
	 * does, and a cancel stops it.
	 */
	runSnippet(call: Call): void {
		const params = readRunSnippet(call.params);
		const code = this.snippetCode(params);
		const stamp = this.stamp();
		const batch: ScriptBatch = {
			code,
			entry: params.entry,
			console: true,
			calls: [
				{
					elementIds: params.element_ids,
					...(params.inputs === undefined
						? {}
						: { inputs: parseExact(JSON.stringify(params.inputs), { floatConstants: true }) })
				}
			]
		};
		const run = abortable();
		call.onCancel = run.abort;
		this.answerLater(
			call,
			this.runScripts(batch, run).then((done) => {
				const opsText = done.ops;
				const ops = opsText === undefined ? [] : (toWire(parseExact(opsText)) as unknown[]);
				return consoleAnswer(done.results[0]!.text, ops, done.ms, stamp);
			})
		);
	}

	/** Where the working copy stands, for a run to carry. */
	private stamp(): RunStamp {
		const wc = this.ready();
		return { rev: wc.rev, staged: wc.stagedVersion };
	}

	/** The code `params` runs: inline, or a saved snippet's. */
	private snippetCode(params: RunSnippetParams): string {
		if (params.code !== undefined) return params.code;
		const ref = params.artifact_id!;
		const artifact = this.artifacts.resolve(ref);
		if (artifact === null) throw new Refused(404, 'snippet not found');
		if (artifact.kind !== SNIPPET_KIND) {
			throw new Refused(422, `artifact kind '${artifact.kind}' is not a code_snippet`);
		}
		return snippetFetch(this.artifacts)(ref)!.code;
	}

	/**
	 * A run belongs to the replica it arrived on: it is refused, `replica closed`, if that replica
	 * was dropped before the run began or by the time it ended, and its bridge answers nothing but
	 * that replica; a replica dropped under it also stops it. Runs go in parallel, each in a worker
	 * of the host's pool. Every run goes through `boot()`, which a live host answers at once and a
	 * host that failed or stopped starts over; a failed boot is refused, not kept. A `script` run
	 * gets a dispatcher of its own that records the ops its code proposes, answered as `ops`.
	 */
	private async runScripts(batch: ScriptBatch, cancel: Abortable): Promise<ScriptCallsResult> {
		this.ready();
		this.running.add(cancel.abort);
		try {
			return await this.runBatch(batch, cancel.signal, this.epoch);
		} finally {
			this.running.delete(cancel.abort);
		}
	}

	/**
	 * One batch on the replica of `epoch`, which is stopped by `signal` or by that replica dropped.
	 * The caller registers the abort of `signal` to be run when the replica is dropped.
	 */
	private async runBatch(
		batch: ScriptBatch,
		signal: AbortSignalLike,
		epoch: number
	): Promise<ScriptCallsResult> {
		this.stillReady(epoch);
		const wc = this.ready();
		const host = this.scriptHost();
		const recording = batch.entry === 'script' ? new BridgeDispatcher(wc.model, true) : null;
		const bridge = this.bridgeOf(epoch, wc, recording ?? this.sharedDispatcher(wc));
		try {
			// Calls waiting on one boot share it, and share its failure.
			await host.boot();
			this.stillReady(epoch);
			const {
				results,
				trips,
				ms,
				dispatchMs: dispatch_ms,
				bootMs: boot_ms,
				boot
			} = await host.run(batch, bridge, signal);
			this.stillReady(epoch);
			if (results.length !== batch.calls.length) {
				throw new Refused(
					500,
					`the script host answered ${results.length} results for ${batch.calls.length} calls`
				);
			}
			if (results.some((one) => typeof one?.text !== 'string')) {
				throw new Refused(500, 'the script host answered a result without text');
			}
			return {
				results: results.map(({ text }) => ({ text })),
				trips,
				ms,
				dispatch_ms,
				boot_ms,
				boot,
				...(recording === null ? {} : { ops: dumpDefault(recording.ops) })
			};
		} catch (error) {
			// `close` disposed the host under the run.
			if (this.scripting !== host) throw new Refused(409, 'replica closed');
			throw error;
		}
	}

	/** `scriptWarm`: refused as `scriptCalls` is without a ready replica; a cancel drops the wait. */
	scriptWarm(call: Call): void {
		const warm = abortable();
		call.onCancel = warm.abort;
		this.answerLater(call, this.warmScripts(warm));
	}

	/**
	 * Prewarms the host and answers once its pool holds its spares, for a caller that wants the first
	 * run to start at once (the bench and the tests; the app does not ask). Like a run it belongs to
	 * the replica it arrived on: a replica dropped under it ends the wait, `replica closed`.
	 */
	private async warmScripts(cancel: {
		readonly signal: AbortSignalLike;
		abort(): void;
	}): Promise<ScriptWarmResult> {
		this.ready();
		const epoch = this.epoch;
		const host = this.scriptHost();
		this.running.add(cancel.abort);
		try {
			const warm = await host.warmed(cancel.signal);
			this.stillReady(epoch);
			return warm;
		} catch (error) {
			if (this.scripting !== host) throw new Refused(409, 'replica closed');
			if (this.epoch !== epoch) this.stillReady(epoch);
			throw error;
		} finally {
			this.running.delete(cancel.abort);
		}
	}

	/**
	 * Prewarms the host (its first worker, then the spares up to the pool's cap once the image is
	 * ready) when the artifacts hold a snippet, once for each replica that
	 * is ready: from an artifact move on one, and from the moment a replica becomes ready. Only
	 * where the deps opt in with `prewarmScripts`.
	 */
	private prewarmScripts(): void {
		if (
			this.deps.prewarmScripts !== true ||
			this.deps.scripts === undefined ||
			this.prewarmed === this.epoch
		)
			return;
		if (this.state !== 'ready' || this.wc === null) return;
		const holdsSnippet = this.artifacts
			.ids()
			.some((id) => this.artifacts.resolve(id)?.kind === SNIPPET_KIND);
		if (!holdsSnippet) return;
		this.prewarmed = this.epoch;
		this.scriptHost().prewarm();
	}

	/** The script host, made on first use. */
	private scriptHost(): ScriptHost {
		if (this.scripting === null) {
			const factory = this.deps.scripts;
			if (factory === undefined) throw new Refused(501, 'scripts are not available');
			this.scripting = factory();
		}
		return this.scripting;
	}

	/** Where a transition of `wc` goes: through the issue store once the replica is ready. */
	private moving(wc: WorkingCopy): LiveIssues | WorkingCopy {
		const live = this.issuesOf?.live;
		return live !== undefined && live.wc === wc ? live : wc;
	}

	// -- the issue store -----------------------------------------------------

	/**
	 * The ready replica's issue store, or the refusal of a call that would
	 * read it: 501 where the engine must not answer, so the server does.
	 */
	private live(): LiveIssues {
		const wc = this.ready();
		const live = this.issuesOf?.live;
		if (live === undefined || live.wc !== wc) throw new Refused(409, NOT_READY);
		if (live.unusable !== null) throw new Refused(501, UNSUPPORTED_PATTERN);
		const { working, committed } = live.rules;
		if (working.unreadable || committed.unreadable) throw new Refused(501, UNREADABLE_RULES);
		return live;
	}

	/**
	 * `body` over the store, with the probe it may run. A probe rewinds and
	 * replays the staged batches — the committed images the digest check
	 * walks are rebuilt — so a new one restarts the check.
	 */
	private answer<T>(live: LiveIssues, body: (live: LiveIssues) => T): T {
		const probes = live.probes;
		const probing = live.wc.staged().length > 0;
		let out: T;
		try {
			out = body(live);
		} catch (caught) {
			// A replay that could not even put the batches back left the model below them.
			if (live.wc.diverged) {
				this.diverge(live.wc);
				throw new Refused(409, NOT_READY);
			}
			if (probing) this.scheduler.restartBackground();
			if (live.unusable !== null) throw new Refused(501, UNSUPPORTED_PATTERN);
			throw caught;
		}
		if (probing && live.probes !== probes) this.scheduler.restartBackground();
		return out;
	}

	/**
	 * `getModelIssues` and `previewCommit`: a transition of the model lane —
	 * a probe rewinds, so no scan may be running — that posts no `changed`,
	 * once the store is settled. `check` refuses a stale call before any probe.
	 */
	issues(
		call: Call,
		body: (live: LiveIssues) => unknown,
		check: (wc: WorkingCopy) => void = () => undefined
	): void {
		this.settled(call, (live) => {
			check(live.wc);
			return this.answer(live, body);
		});
	}

	/**
	 * A transition that restarts the sweep; the answer is built by a second
	 * one once that sweep and any rescan have ended, from the same store — or
	 * refused, if the replica went meanwhile or the staged batches moved.
	 */
	validateModel(call: Call, ids: readonly number[]): void {
		this.scheduler.submit(
			call.id,
			'model',
			{
				kind: 'transition',
				run: () => {
					const live = this.live();
					requireStaged(live.wc, ids);
					live.restartSweep();
					this.sweep(live);
					this.wait(call, live.whenSwept(), () =>
						this.settled(
							call,
							(settled) => {
								requireStaged(settled.wc, ids);
								return this.answer(settled, validateBody);
							},
							live
						)
					);
				}
			},
			(outcome) => {
				if (!outcome.ok) call.refuse(outcome.error);
			}
		);
	}

	/**
	 * Answers `call` with `run` over the store, in a model-lane transition run
	 * while no rescan is due. Otherwise the call waits for the store to settle
	 * and asks again in a new transition, since an artifact method can start
	 * another rescan before it runs. A store whose steps threw has them set
	 * going again first, whether the call waits or is answered from the store
	 * as it stands. `on` is the store a waiting call waits on: refused
	 * meanwhile, it is not run; replaced, it is refused.
	 */
	private settled(
		call: Call,
		run: (live: LiveIssues) => unknown,
		on: LiveIssues | null = null
	): void {
		this.scheduler.submit(
			call.id,
			'model',
			{
				kind: 'transition',
				run: () => {
					if (on !== null && (!this.waiting.delete(call) || call.cancelled)) return WAITING;
					const live = this.live();
					if (on !== null && live !== on) throw new Refused(409, NOT_READY);
					if (this.issuesOf!.stalled) this.sweep(live);
					if (!live.settled) {
						this.wait(call, live.whenSettled(), () => this.settled(call, run, live));
						return WAITING;
					}
					return run(live);
				}
			},
			(outcome) => {
				if (!outcome.ok) call.refuse(outcome.error);
				else if (outcome.value !== WAITING) call.answer(outcome.value);
			}
		);
	}

	/**
	 * `candidateIssues` and a rebinding `previewCommit`: the whole working copy
	 * scanned under a candidate metamodel, in a model-lane scan queued once the
	 * store has been swept and is settled. The document is read on arrival, so
	 * a malformed one is refused before it queues. The scan checks the call
	 * again and records where the store stands at its first step, and compares
	 * after its last: a store that moved meanwhile — a rule-set change between
	 * its slices, a replica closed under it — or one not settled when it began
	 * sends the call back to wait and scan again, so that an answer pairs one
	 * state and one pair of rule sets.
	 */
	candidate(call: Call, spec: CandidateCall): void {
		const prepared = { value: this.prepare(spec, null) };
		const scan = (live: LiveIssues): typeof WAITING => {
			spec.check(live.wc);
			if (!live.seeded) {
				this.wait(call, live.whenSwept(), () => this.settled(call, scan, live));
				return WAITING;
			}
			this.scheduler.submit(
				call.id,
				'model',
				{ kind: 'scan', run: () => this.candidateSteps(spec, prepared) },
				(outcome) => {
					if (!outcome.ok) {
						const { error } = outcome;
						call.refuse(error instanceof PatternUnusable ? candidateRefusal(error) : error);
					} else if (outcome.value === MOVED) this.settled(call, scan);
					else call.answer(outcome.value);
				}
			);
			return WAITING;
		};
		this.settled(call, scan);
	}

	/**
	 * One run of a candidate scan: `MOVED` unless the store is seeded and
	 * settled when it begins and stands where it began after its last step.
	 * Staged ops the candidate does not admit are refused before any scanning.
	 */
	private *candidateSteps(spec: CandidateCall, prepared: { value: Prepared }): Steps<unknown> {
		const live = this.live();
		spec.check(live.wc);
		if (!live.seeded || !live.settled) return MOVED;
		const stamp: Stamp = {
			live,
			rev: live.wc.rev,
			stagedVersion: live.wc.stagedVersion,
			rulesVersion: live.rulesVersion
		};
		prepared.value = this.prepare(spec, prepared.value);
		const { candidate } = prepared.value;
		if (spec.admits !== undefined && !spec.admits(live.wc, candidate.metamodel)) {
			throw new Refused(501, REFUSED_OPS);
		}
		const issues = yield* candidateScan(live.wc.model, candidate);
		if (this.movedFrom(stamp)) return MOVED;
		return spec.answer(live, issues);
	}

	/** Whether the store is no longer at `stamp`, or has a rescan due; refused as `live()` refuses. */
	private movedFrom(stamp: Stamp): boolean {
		const live = this.live();
		return (
			live !== stamp.live ||
			live.wc.rev !== stamp.rev ||
			live.wc.stagedVersion !== stamp.stagedVersion ||
			live.rulesVersion !== stamp.rulesVersion ||
			!live.settled
		);
	}

	/** `spec`'s candidate with its layer's rule sets compiled under it: `before` while they compile alike. */
	private prepare(spec: CandidateCall, before: Prepared | null): Prepared {
		const sources = ruleSources(this.artifacts, spec.layer);
		if (before !== null && sameSources(before.sources, sources)) return before;
		try {
			return {
				sources,
				candidate: prepareCandidate(spec.doc, (mm) => compileRuleSets(sources, mm))
			};
		} catch (error) {
			throw candidateRefusal(error);
		}
	}

	/** Holds `call` until `until` resolves, then runs `then`; `dropIssues` refuses it meanwhile. */
	private wait(call: Call, until: Promise<void>, then: () => void): void {
		this.waiting.add(call);
		this.awaiting.set(call.id, call);
		void until.then(then);
	}

	/**
	 * Sets the store's sweep in the scheduler's sweep slot: from where it
	 * stands, or from the start after `restartSweep`, then any rescan due,
	 * whose steps report nothing. Steps that throw leave the slot, their ids
	 * still due, until a call that reads the store sets them going again.
	 */
	private sweep(live: LiveIssues): void {
		const issues = this.issuesOf;
		if (issues?.live === live) issues.stalled = false;
		this.scheduler.setSweep({
			start: () => live.sweepSteps(),
			progress: (step: SweepStep) => {
				if (step.rescan !== true) this.progress('sweep', step.done, step.total);
			},
			done: (ok) => {
				// A step that threw is a bug: what waits is refused, for the server to answer.
				if (!ok && live.unusable === null && this.issuesOf?.live === live) {
					this.issuesOf.stalled = true;
					this.refuseWaiting(new Refused(409, NOT_READY));
				}
			}
		});
	}

	private refuseWaiting(error: unknown): void {
		for (const call of this.waiting) call.refuse(error);
		this.waiting.clear();
	}

	/** The service's `issues_version`, counting what the store's `version` moved since last read. */
	private issuesNow(): number {
		const issues = this.issuesOf;
		if (issues !== null) {
			this.issuesVersion += issues.live.version - issues.seen;
			issues.seen = issues.live.version;
		}
		return this.issuesVersion;
	}

	/**
	 * Runs `put` over the artifacts, then hands the store the rule sets they
	 * resolve to, when they compile otherwise than before: a change of the
	 * working ones queues a rescan. A ready replica posts a bare `changed` when
	 * the artifacts or the store moved.
	 */
	moveArtifacts(put: () => void): void {
		const version = this.artifacts.version;
		put();
		const issues = this.issuesOf;
		if (issues !== null) {
			const { live } = issues;
			const mm = live.wc.model.metamodel;
			const working = this.compiled('working', mm, issues.working);
			const committed = this.compiled('committed', mm, issues.committed);
			if (working !== issues.working || committed !== issues.committed) {
				issues.working = working;
				issues.committed = committed;
				live.setRules({ working: working.rules, committed: committed.rules });
				if (!live.settled) this.sweep(live);
			}
		}
		this.prewarmScripts();
		this.postBare(this.artifacts.version !== version);
	}

	/** A layer's rule sets compiled against `mm`: `before` itself when they compile alike. */
	private compiled(
		layer: 'working' | 'committed',
		mm: Metamodel,
		before: Compiled | null = null
	): Compiled {
		const sources = ruleSources(this.artifacts, layer);
		if (before !== null && sameSources(before.sources, sources)) return before;
		return { sources, rules: compileRuleSets(sources, mm) };
	}

	/** At a slice's end: a bare `changed` when the store moved since the last one posted. */
	private flushIssues(): void {
		this.postBare(false);
	}

	/** A ready replica's `changed` with no ids, when the store moved since the last one posted or `always`. */
	private postBare(always: boolean): void {
		const wc = this.wc;
		if (this.state !== 'ready' || wc === null) return;
		const version = this.issuesNow();
		if (version === this.issuesPosted && !always) return;
		this.issuesPosted = version;
		this.emit({
			event: 'changed',
			rev: wc.rev,
			staged_version: wc.stagedVersion,
			issues_version: version,
			artifacts_version: this.artifacts.version,
			element_ids: [],
			relationship_ids: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			structural: false
		});
	}

	// -- events --------------------------------------------------------------

	private emit(event: ServiceEvent): void {
		this.port.post(event);
	}

	private enter(state: ReplicaState): void {
		this.state = state;
		this.emit({
			event: 'replica',
			state,
			rev: state === 'opening' || this.wc === null ? null : this.wc.rev
		});
	}

	/** A task's first and last reports go out at once; the rest at most once a slice. */
	private progress(task: ProgressTask, done: number, total: number): void {
		if (done === 0 || done === total) {
			this.progressHeld.delete(task);
			this.emit({ event: 'progress', task, done, total });
		} else {
			this.progressHeld.set(task, { done, total });
		}
	}

	private flushProgress(): void {
		for (const [task, { done, total }] of this.progressHeld) {
			this.emit({ event: 'progress', task, done, total });
		}
		this.progressHeld.clear();
	}

	// -- the cell cache ------------------------------------------------------

	/** Empties the cell cache: what a fill in flight holds does not match the model any more. */
	private dropCells(): void {
		this.transitions++;
		this.cells?.clear();
	}

	/**
	 * Runs a transition of `wc` and evicts from the cell cache what it touched, in the keys its
	 * calls recorded their reads in: those of the state the transition leaves, over the ids
	 * `leaving` names, and those of the state it makes, over what it changed. An entity deleted is
	 * read from its committed image where `leaving` did not name it. A transition that changed
	 * nothing evicts nothing and does not move `transitions`: a result computed before it is a
	 * result of the state after it. One that moves it does so in the same synchronous step as the
	 * eviction, so a result computed before it can never be kept after it. One that failed other
	 * than by leaving no trace may have changed anything, so the cache is dropped. The eviction is
	 * bounded by the cache (`CellCacheLimits.evictWork`) and the keys by the entities the
	 * transition names.
	 */
	private transit<T>(
		wc: WorkingCopy,
		leaving: () => readonly string[] | null,
		run: () => T,
		changesOf: (out: T) => ChangeSet
	): T {
		// An empty cache has nothing to evict, which is all that a replica nobody evaluates scripts on costs.
		const cells =
			this.state === 'ready' && this.cells !== null && this.cells.size > 0 ? this.cells : null;
		let before: Set<string> | null = null;
		const ids = cells === null ? null : leaving();
		if (ids !== null) {
			const model = wc.model;
			before = touchedKeys(model, model.metamodel, {
				elementIds: ids.filter((id) => model.findElement(id) !== undefined),
				relationshipIds: ids.filter((id) => model.findRelationship(id) !== undefined)
			});
		}
		let out: T;
		try {
			out = run();
		} catch (error) {
			if (!leftNoTrace(error)) this.dropCells();
			throw error;
		}
		const changes = changesOf(out);
		const named =
			changes.elementIds.length +
			changes.relationshipIds.length +
			changes.deletedElementIds.length +
			changes.deletedRelationshipIds.length;
		if (named === 0) return out;
		this.transitions++;
		if (cells === null) return out;
		const model = wc.model;
		const keys = touchedKeys(model, model.metamodel, changes, before ?? new Set<string>());
		deletedKeys(
			model.metamodel,
			{ elementIds: changes.deletedElementIds, relationshipIds: changes.deletedRelationshipIds },
			{
				element: (id) => wc.committedElement(id),
				relationship: (id) => wc.committedRelationship(id)
			},
			keys
		);
		cells.evict(keys);
		return out;
	}

	/**
	 * After a transition: the digest check starts over when an entity or the
	 * staged list moved, and a ready replica says what changed.
	 */
	private changed(wc: WorkingCopy, changes: ChangeSet, versionBefore: number, moved = false): void {
		const named =
			changes.elementIds.length +
			changes.relationshipIds.length +
			changes.deletedElementIds.length +
			changes.deletedRelationshipIds.length;
		const touched = named > 0 || wc.stagedVersion !== versionBefore;
		if (touched) this.scheduler.restartBackground();
		if (this.state === 'ready' && (touched || moved)) {
			this.issuesPosted = this.issuesNow();
			this.emit({
				event: 'changed',
				rev: wc.rev,
				staged_version: wc.stagedVersion,
				issues_version: this.issuesPosted,
				artifacts_version: this.artifacts.version,
				...wireChanges(changes)
			});
		}
	}

	// -- the replica's life --------------------------------------------------

	/** Drops the replica and any open in flight: the heap never holds two. */
	private discard(): void {
		const opening = this.opening;
		if (opening !== null) {
			opening.discarded = true;
			opening.queue.fail(new Refused(409, 'replica closed'));
			this.opening = null;
		}
		this.wc = null;
		this.nextEpoch();
		this.progressHeld.clear();
		this.tableOrders.clear();
		this.dropCells();
		this.scheduler.setOpen(false);
		this.scheduler.setBackground(null);
		this.dropIssues();
	}

	/** Drops the issue store with its replica; what waits for its sweep is refused. */
	private dropIssues(): void {
		this.issuesOf = null;
		this.scheduler.setSweep(null);
		this.refuseWaiting(new Refused(409, NOT_READY));
	}

	open(params: ReadParams): null {
		const projectId = text(params, 'project_id');
		let metamodel: Metamodel;
		try {
			metamodel = Metamodel.fromJSON(params['metamodel'] as MetamodelDoc);
		} catch (error) {
			throw new Refused(
				422,
				`metamodel: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		this.discard();
		this.failed = null;
		const opening: Opening = {
			projectId,
			queue: new ByteQueue(),
			settled: Promise.resolve({ ok: false, error: null }),
			discarded: false,
			ending: false
		};
		const report = (task: ProgressTask) => (done: number, total: number) => {
			if (!opening.discarded) this.progress(task, done, total);
		};
		const pause = () => {
			if (opening.discarded) throw new Refused(409, 'replica closed');
			return this.scheduler.pause();
		};
		opening.settled = openSnapshot(this.deps.inflate(opening.queue), metamodel, report('parse'), {
			pause,
			onIndex: report('index')
		}).then(
			(value): Outcome<OpenedSnapshot> => ({ ok: true, value }),
			(error: unknown): Outcome<OpenedSnapshot> => {
				if (!opening.discarded) this.failed = error;
				return { ok: false, error };
			}
		);
		this.opening = opening;
		this.enter('opening');
		return null;
	}

	chunk(params: ReadParams): null {
		if (this.failed !== null) throw this.failed;
		const opening = this.opening;
		if (opening === null || opening.ending) throw new Refused(409, 'no snapshot is being opened');
		const bytes = params['bytes'];
		if (bytes instanceof ArrayBuffer) opening.queue.push(new Uint8Array(bytes));
		else if (ArrayBuffer.isView(bytes)) {
			opening.queue.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		} else throw new Refused(422, 'bytes must be an ArrayBuffer');
		return null;
	}

	/** The header, once the replica is read and indexed; the replica stays `opening`. */
	async end(): Promise<SnapshotHeader> {
		if (this.failed !== null) throw this.failed;
		const opening = this.opening;
		if (opening === null || opening.ending) throw new Refused(409, 'no snapshot is being opened');
		opening.ending = true;
		opening.queue.end();
		const outcome = await opening.settled;
		if (opening.discarded) throw new Refused(409, 'replica closed');
		this.opening = null;
		if (!outcome.ok) throw outcome.error;
		const { header, workingCopy } = outcome.value;
		if (header.project_id !== opening.projectId) {
			this.failed = new Refused(
				422,
				`snapshot belongs to project ${pyRepr(header.project_id)}, not ${pyRepr(opening.projectId)}`
			);
			throw this.failed;
		}
		this.wc = workingCopy;
		this.bridged = null;
		return { ...header };
	}

	close(): null {
		this.discard();
		this.failed = null;
		this.enter('opening');
		const scripting = this.scripting;
		this.scripting = null;
		scripting?.dispose();
		return null;
	}

	adoptStaged(call: Call): void {
		const wc = this.wc;
		if (wc === null || this.state !== 'opening') {
			throw new Refused(409, 'replica is not waiting for staged batches');
		}
		const batches = readBatches(call.params['batches']);
		this.submit<AdoptResult>(call, 'control', {
			kind: 'transition',
			run: () => {
				if (this.wc !== wc) throw new Refused(409, 'replica closed');
				const { changes, conflicts } = wc.adoptStaged(batches);
				return { changes: wireChanges(changes), conflicts: conflicts.map(wireConflict) };
			}
		});
	}

	/**
	 * One transition per delta, all queued at once so that nothing slips in
	 * between: on the control lane while the replica opens — the tail is what
	 * makes it ready — on the model lane after.
	 */
	applyTail(call: Call): void {
		const wc = this.wc;
		if (wc === null) throw new Refused(409, 'no replica is open');
		if (this.state === 'diverged') throw new Refused(409, 'replica is diverged');
		const deltas = readTailText(text(call.params, 'text'));
		const lane: Lane = this.state === 'ready' ? 'model' : 'control';
		const tail = { status: 'applied' as TailResult['status'], applied: 0, stopped: false };
		deltas.forEach((delta, i) => {
			this.scheduler.submit(
				call.id,
				lane,
				{
					kind: 'transition',
					run: () => {
						if (tail.stopped || this.wc !== wc) return;
						const version = wc.stagedVersion;
						const { status, changes } = this.transit(
							wc,
							() => deltaLeaves(wc, delta, undefined),
							() => this.moving(wc).applyDelta(delta),
							(out) => out.changes
						);
						if (status === 'gap') {
							tail.status = 'gap';
							tail.stopped = true;
							return;
						}
						if (status === 'applied') tail.applied++;
						this.changed(wc, changes, version, status === 'applied');
						this.progress('tail', i + 1, deltas.length);
						if (wc.diverged) {
							tail.stopped = true;
							this.diverge(wc);
						}
					}
				},
				(outcome) => {
					if (!outcome.ok) {
						tail.stopped = true;
						call.refuse(outcome.error);
					}
				}
			);
		});
		this.submit<TailResult>(call, lane, {
			kind: 'transition',
			run: () => {
				if (this.wc !== wc) throw new Refused(409, 'replica closed');
				if (this.state === 'opening' && tail.status === 'applied' && !wc.diverged) {
					this.becomeReady(wc);
				}
				return { status: tail.status, rev: wc.rev, applied: tail.applied, diverged: wc.diverged };
			}
		});
	}

	applyDelta(call: Call): void {
		if (this.state !== 'ready') throw new Refused(409, 'replica is not ready');
		const delta = readDeltaText(text(call.params, 'text'));
		const own = readOwn(call.params['own']);
		this.transition(call, (wc): DeltaResult => {
			const version = wc.stagedVersion;
			const { status, changes } = this.transit(
				wc,
				() => deltaLeaves(wc, delta, own),
				() => this.moving(wc).applyDelta(delta, own),
				(out) => out.changes
			);
			this.changed(wc, changes, version, status === 'applied');
			if (wc.diverged) this.diverge(wc);
			return { status, rev: wc.rev, diverged: wc.diverged };
		});
	}

	/**
	 * The replica's issue store is built here, with the rule sets compiled
	 * afresh against its metamodel, and swept in the background: the batches
	 * adopted and the tail applied while opening went to the working copy
	 * alone, and the first sweep covers them.
	 */
	private becomeReady(wc: WorkingCopy): void {
		this.enter('ready');
		this.prewarmScripts();
		this.scheduler.setOpen(true);
		this.scheduler.setBackground({
			start: () => wc.verifyDigestSteps(),
			progress: ({ done, total }) => this.progress('verify', done, total),
			done: (ok) => {
				if (!ok && this.wc === wc) this.diverge(wc);
			}
		});
		const mm = wc.model.metamodel;
		const working = this.compiled('working', mm);
		const committed = this.compiled('committed', mm);
		const live = new LiveIssues(wc, {
			rules: { working: working.rules, committed: committed.rules }
		});
		this.issuesOf = { live, seen: live.version, working, committed, stalled: false };
		this.sweep(live);
	}

	private diverge(wc: WorkingCopy): void {
		if (this.wc !== wc || this.state === 'diverged') return;
		this.nextEpoch();
		this.progressHeld.clear();
		this.tableOrders.clear();
		this.dropCells();
		this.scheduler.setOpen(false);
		this.scheduler.setBackground(null);
		this.dropIssues();
		this.enter('diverged');
	}

	// -- staging -------------------------------------------------------------

	stage(wc: WorkingCopy, ops: readonly ModelOp[]): StageResult {
		const version = wc.stagedVersion;
		const { batch, coalesced, changes } = this.transit(
			wc,
			() => stageLeaves(wc, ops),
			() => this.moving(wc).stage(ops, { coalesce: true }),
			(out) => out.changes
		);
		this.changed(wc, changes, version);
		const many = changes.elementIds.length + changes.relationshipIds.length > STAGE_POST_STATE_MAX;
		const model = wc.model;
		return {
			batch: wireBatch(batch),
			coalesced,
			changes: wireChanges(changes),
			elements: many
				? null
				: changes.elementIds.flatMap((id) => {
						const element = model.findElement(id);
						return element === undefined ? [] : [wireElement(element)];
					}),
			relationships: many
				? null
				: changes.relationshipIds.flatMap((id) => {
						const rel = model.findRelationship(id);
						return rel === undefined ? [] : [wireRelationship(rel)];
					})
		};
	}

	unstage(wc: WorkingCopy, what: Unstage): { changes: WireChanges } {
		const version = wc.stagedVersion;
		const changes = this.transit(
			wc,
			() => wc.touchedIds(),
			() => this.moving(wc).unstage(what),
			(out) => out
		);
		this.changed(wc, changes, version);
		return { changes: wireChanges(changes) };
	}
}

/**
 * Serves the engine over one port, per the engine interface: requests
 * `{id, method, params}` answered `{id, ok, result | error}`, `{cancel: id}`,
 * and unsolicited events. A replica is opened from gzip bytes, follows the
 * server by delta, stages edits and answers reads; the work runs in slices
 * of the host's thread (`Scheduler`).
 */
export function createService(port: Port, deps: ServiceDeps): void {
	new Service(port, deps);
}
