import { ArtifactSet, readArtifacts, readStagedArtifacts } from '../artifacts/artifact-set.ts';
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
	wireRelImage
} from '../read/wire.ts';
import {
	compileRuleSets,
	type CompiledRules,
	type RuleSource,
	type RulesParse
} from '../rules/compile.ts';
import { ruleSources } from '../rules/sources.ts';
import { openSnapshot, type OpenedSnapshot, type SnapshotHeader } from '../snapshot/open.ts';
import { drain, isSteps, type Steps } from '../steps/steps.ts';
import { TableOrderCache } from '../table/order-cache.ts';
import { issueListBody, previewBody, validateBody } from '../validation/bodies.ts';
import { LiveIssues, type SweepStep } from '../validation/live.ts';
import { pyRepr } from '../value/repr.ts';
import { readDeltaText, readTailText } from '../working/delta.ts';
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
const NOT_READY = 'replica is not ready';
const STALE_BATCHES = 'stale staged batches';
const STALE_BASE = 'stale base_rev';

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

// -- calls and methods ---------------------------------------------------------

/** A request being served: answered once, or not at all once cancelled. */
type Call = {
	readonly id: string | number;
	readonly params: ReadParams;
	cancelled: boolean;
	answer(result: unknown): void;
	refuse(error: unknown): void;
};

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
		service.issues(
			call,
			(live) => previewBody(live, strict),
			(wc) => {
				if (wc.rev !== baseRev) throw new Refused(409, STALE_BASE);
				requireStaged(wc, ids);
			}
		);
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

	constructor(port: Port, deps: ServiceDeps) {
		this.port = port;
		this.deps = deps;
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
		const post = (message: object) => {
			this.awaiting.delete(id);
			if (settled || call.cancelled) return;
			settled = true;
			this.port.post(message);
		};
		const call: Call = {
			id,
			params,
			cancelled: false,
			answer: (result) => post({ id, ok: true, result }),
			refuse: (error) => post({ id, ok: false, error: errorBody(error) })
		};
		return call;
	}

	private cancel(id: string | number): void {
		this.scheduler.cancel(id);
		const call = this.awaiting.get(id);
		if (call !== undefined) call.cancelled = true;
	}

	answerLater(call: Call, work: Promise<unknown>): void {
		this.awaiting.set(call.id, call);
		work.then(call.answer, call.refuse);
	}

	private submit<T>(call: Call, lane: Lane, job: Job<T>): void {
		this.scheduler.submit(call.id, lane, job, (outcome) =>
			outcome.ok ? call.answer(outcome.value) : call.refuse(outcome.error)
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
	 * lane runs while the scan does, so the stamp holds to its end.
	 */
	evaluate(method: string, call: Call): void {
		this.submit(call, 'model', {
			kind: 'scan',
			run: () => {
				const wc = this.ready();
				return EVALUATIONS[method]!(
					{
						model: wc.model,
						artifacts: this.artifacts,
						placements: this.placements,
						working: {
							rev: wc.rev,
							stagedVersion: wc.stagedVersion,
							tableOrders: this.tableOrders
						}
					},
					call.params
				);
			}
		});
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
		this.progressHeld.clear();
		this.tableOrders.clear();
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
		return { ...header };
	}

	close(): null {
		this.discard();
		this.failed = null;
		this.enter('opening');
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
						const { status, changes } = this.moving(wc).applyDelta(delta);
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
			const { status, changes } = this.moving(wc).applyDelta(delta, own);
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
		this.progressHeld.clear();
		this.tableOrders.clear();
		this.scheduler.setOpen(false);
		this.scheduler.setBackground(null);
		this.dropIssues();
		this.enter('diverged');
	}

	// -- staging -------------------------------------------------------------

	stage(wc: WorkingCopy, ops: readonly ModelOp[]): StageResult {
		const version = wc.stagedVersion;
		const { batch, coalesced, changes } = this.moving(wc).stage(ops, { coalesce: true });
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
		const changes = this.moving(wc).unstage(what);
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
