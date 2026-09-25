import type { ElementRec, RelRec } from '../model/records.ts';
import type { ModelOp } from '../ops/types.ts';
import {
	appliesPopulation,
	EMPTY_RULES,
	type CompiledRule,
	type CompiledRules
} from '../rules/compile.ts';
import { expandScope } from '../rules/reach.ts';
import type { Progress } from '../steps/steps.ts';
import { PyFloat, type Value } from '../value/types.ts';
import type { Delta } from '../working/delta.ts';
import type {
	ChangeSet,
	DeltaStatus,
	OwnCommit,
	StagedBatch,
	Unstage,
	WorkingCopy
} from '../working/working-copy.ts';
import { addNeighbourhood, DirtyCollector } from './dirty.ts';
import { issueOwner, type Issue } from './issue.ts';
import { FacetPatterns, PatternUnusable, validateScoped, Validators } from './pipeline.ts';
import { IssueStore } from './store.ts';

/** Ids a sweep step validates and splices. */
export const SWEEP_STEP = 512;

/** A sweep step passes over at most this many times `sweepStep` entities, unless `sweepSkip` is given. */
const SKIP_PER_STEP = 16;

/** A step of `sweepSteps`: the sweep's progress, or a rescan step, which reports none. */
export type SweepStep = Progress & { readonly rescan?: true };

/** What a rescan step yields where a sweep step yields its progress. */
export const RESCAN_STEP: SweepStep = Object.freeze({ done: 0, total: 0, rescan: true });

/** The rule sets as staged, over the working state, and as committed. */
export type LiveRules = { readonly working: CompiledRules; readonly committed: CompiledRules };

const NO_RULES: LiveRules = { working: EMPTY_RULES, committed: EMPTY_RULES };

export type LiveIssuesOptions = {
	/** A store already complete for the working copy's state: the replica counts as swept. */
	seed?: IssueStore;
	/** Ids per sweep step, `SWEEP_STEP` unless given. */
	sweepStep?: number;
	/**
	 * Entities a sweep step may pass over besides, those an earlier step
	 * validated; 16 times `sweepStep` unless given.
	 */
	sweepSkip?: number;
	/** The rule sets, none unless given; the store holds the working ones' issues. */
	rules?: LiveRules;
};

/**
 * What the staged changes change, as the server's routes see them. `hooks`
 * is the dirty set of the staged ops applied as one batch to the committed
 * state. `dirty` widens it by the working rules' reach and, while the working
 * rules are not the committed ones, adds every element a changed rule applies
 * to; `working` is its issues on the working state with the working rules,
 * `committed` on the committed state with the committed rules. `previewDirty`
 * widens `hooks` by the committed rules' reach, and `preview` is its issues on
 * the working state with the committed rules, the server's preview.
 */
export type Origins = {
	readonly hooks: readonly string[];
	readonly dirty: readonly string[];
	readonly working: readonly Issue[];
	readonly committed: readonly Issue[];
	readonly previewDirty: readonly string[];
	readonly preview: readonly Issue[];
};

const NOTHING_STAGED: Origins = {
	hooks: [],
	dirty: [],
	working: [],
	committed: [],
	previewDirty: [],
	preview: []
};

const sameList = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((item, i) => item === b[i]);

/** The rules one compile holds more often than the other, by identity: the working side's, then the committed side's. */
function changedRules(working: CompiledRules, committed: CompiledRules): CompiledRule[] {
	const out: CompiledRule[] = [];
	for (const [mine, theirs] of [
		[working, committed],
		[committed, working]
	] as const) {
		const left = new Map<string, number>();
		for (const identity of theirs.identities) left.set(identity, (left.get(identity) ?? 0) + 1);
		for (const cr of mine.rules) {
			const n = left.get(cr.rule.identity) ?? 0;
			if (n > 0) left.set(cr.rule.identity, n - 1);
			else out.push(cr);
		}
	}
	return out;
}

/** Ids in first-seen order, each once. */
const ordered = (...lists: readonly (readonly string[])[]) => [...new Set(lists.flat())];

function byIssueOwner(issues: readonly Issue[]): Map<string, Issue[]> {
	const out = new Map<string, Issue[]>();
	for (const issue of issues) {
		const owner = issueOwner(issue);
		const list = out.get(owner);
		if (list === undefined) out.set(owner, [issue]);
		else list.push(issue);
	}
	return out;
}

function isEntity(doc: Value): doc is { [key: string]: Value } {
	return (
		typeof doc === 'object' && doc !== null && !Array.isArray(doc) && !(doc instanceof PyFloat)
	);
}

/** Every id a delta names or deletes, read leniently: the working copy refuses a malformed one. */
function deltaIds(delta: Delta): string[] {
	const ids: string[] = [];
	for (const docs of [delta.changed_elements, delta.changed_relationships]) {
		if (!Array.isArray(docs)) continue;
		for (const doc of docs) {
			const id = isEntity(doc) ? doc['id'] : undefined;
			if (typeof id === 'string') ids.push(id);
		}
	}
	for (const named of [
		delta.deleted_element_ids,
		delta.deleted_relationship_ids,
		delta.recreated_element_ids,
		delta.recreated_relationship_ids
	]) {
		if (!Array.isArray(named)) continue;
		for (const id of named) if (typeof id === 'string') ids.push(id);
	}
	return ids;
}

/** The ends of a delta's changed relationships, as it names them. */
function deltaEnds(delta: Delta): string[] {
	const ids: string[] = [];
	if (!Array.isArray(delta.changed_relationships)) return ids;
	for (const doc of delta.changed_relationships) {
		if (!isEntity(doc)) continue;
		for (const key of ['source_id', 'target_id']) {
			const id = doc[key];
			if (typeof id === 'string') ids.push(id);
		}
	}
	return ids;
}

/** The ends of every relationship among `ids`: in the model, or as committed when staged away. */
function endsOf(wc: WorkingCopy, ids: Iterable<string>): string[] {
	const out: string[] = [];
	for (const id of ids) {
		const rel = wc.model.findRelationship(id);
		if (rel !== undefined) {
			out.push(rel.source.id, rel.target.id);
			continue;
		}
		const image = wc.committedRelationship(id);
		if (image !== null) out.push(image.sourceId, image.targetId);
	}
	return out;
}

const changedIds = (changes: ChangeSet) => [
	...changes.elementIds,
	...changes.relationshipIds,
	...changes.deletedElementIds,
	...changes.deletedRelationshipIds
];

/** Where the sweep's walk of one map stands: the iterator, and the model's order epoch when it was taken. */
type Cursor<T> = { iter: Iterator<T> | null; epoch: number; ended: boolean };

const cursor = <T>(): Cursor<T> => ({ iter: null, epoch: -1, ended: false });

/**
 * The sweep due: its total when it began (`null` before its first step), how
 * many entities it has validated, and their ids.
 */
type Sweep = {
	total: number | null;
	done: number;
	readonly validated: Set<string>;
	readonly elements: Cursor<ElementRec>;
	readonly relationships: Cursor<RelRec>;
};

const newSweep = (): Sweep => ({
	total: null,
	done: 0,
	validated: new Set(),
	elements: cursor(),
	relationships: cursor()
});

/** The panel's tag scope, kept for one committed rev and one pair of equal rule sets. */
type Tags = {
	readonly rev: number;
	readonly rulesVersion: number;
	readonly committedOf: Map<string, readonly Issue[]>;
};

/**
 * The issues of a working copy's working state, kept as it moves. Every
 * transition goes through here and revalidates the ids whose verdict it may
 * have changed before it returns: a stage the ids its applier's hooks name,
 * the server's own dirty set; a rebase (`unstage`, `applyDelta`) the
 * neighbourhoods, before and after, of every id it may touch and of the ends
 * of every relationship among them; a merged edit both, since it replays the
 * batches from the one it lands in. A background
 * sweep fills the store in steps and resumes across any transition; once it
 * has run to its end the store is `seeded`. A facet pattern the host cannot
 * run makes it `unusable` for good: the store empties and stays empty.
 *
 * The store holds the working rules' issues. Every dirty set is widened by
 * their reach on the state after the transition: an owner whose verdict
 * reads an element that moved is found by walking its paths back from that
 * element. A change of the working rules queues every element the old or the
 * new ones apply to for a rescan, which the sweep's steps drain after any
 * sweep due; the store is `settled` once it has.
 *
 * The panel's tags need each staged owner's committed issues. An exact probe
 * finds them; while the rev and the rule sets hold, and the working rules are
 * the committed ones, the transitions keep them from there (`tagScope`).
 *
 * Nothing else may write to the working copy while this one wraps it.
 */
export class LiveIssues {
	readonly wc: WorkingCopy;
	private readonly validators: Validators;
	private readonly patterns: FacetPatterns;
	private readonly sweepStep: number;
	private readonly sweepSkip: number;
	private issues: IssueStore;
	private moves = 0;
	private swept: boolean;
	private broken: 'pattern' | null = null;
	/** The sweep due; `null` when none is. */
	private sweep: Sweep | null;
	private waiters: (() => void)[] = [];
	private compiled: LiveRules;
	private rulesMoves = 0;
	/** The ids a rule-set change left to revalidate, and how many are done; `null` when none are. */
	private rescan: { ids: string[]; at: number } | null = null;
	private settleWaiters: (() => void)[] = [];
	private cached: {
		rev: number;
		stagedVersion: number;
		rulesVersion: number;
		origins: Origins;
	} | null = null;
	/**
	 * The issues, with the working and with the committed rules, of elements
	 * a changed rule applies to that the staged edits did not reach when they
	 * were found: the same on both states then, so found on the working state
	 * alone. Such an element's issues are its committed ones whenever the
	 * edits do not reach it, so an entry holds for one committed rev and one
	 * pair of rule sets; a transition drops the entries of its dirty ids all
	 * the same.
	 */
	private readonly deltaOf = new Map<string, { working: Issue[]; committed: Issue[] }>();
	private deltaRev = -1;
	/**
	 * Every owner whose issues may differ between the two states, with its
	 * committed issues; `null` until an exact probe finds them, and whenever
	 * they cannot be kept.
	 */
	private tags: Tags | null = null;
	private probeRuns = 0;

	constructor(wc: WorkingCopy, options: LiveIssuesOptions = {}) {
		this.wc = wc;
		const mm = wc.model.metamodel;
		this.validators = new Validators(mm);
		this.patterns = new FacetPatterns(mm);
		this.sweepStep = options.sweepStep ?? SWEEP_STEP;
		this.sweepSkip = options.sweepSkip ?? SKIP_PER_STEP * this.sweepStep;
		this.compiled = options.rules ?? NO_RULES;
		this.issues = options.seed ?? new IssueStore();
		this.swept = options.seed !== undefined;
		this.sweep = options.seed === undefined ? newSweep() : null;
		if (this.patterns.unusable) {
			this.broken = 'pattern';
			this.issues = new IssueStore();
			this.sweep = null;
		}
	}

	get store(): IssueStore {
		return this.issues;
	}

	/**
	 * Moves when the store's content moves, when a delta moves the committed
	 * rev, when the rule sets change, and when it becomes unusable.
	 */
	get version(): number {
		return this.moves;
	}

	get rules(): LiveRules {
		return this.compiled;
	}

	/** Moves whenever `setRules` is called. */
	get rulesVersion(): number {
		return this.rulesMoves;
	}

	/** Whether no rescan is due: the store holds the working rules' issues. */
	get settled(): boolean {
		return this.rescan === null;
	}

	/** Set once a sweep has run to its end; a later sweep keeps it. */
	get seeded(): boolean {
		return this.swept;
	}

	get unusable(): 'pattern' | null {
		return this.broken;
	}

	/** Moves whenever `origins()` finds the origins afresh. */
	get probes(): number {
		return this.probeRuns;
	}

	// -- transitions ---------------------------------------------------------

	stage(
		ops: readonly ModelOp[],
		options: { coalesce?: boolean } = {}
	): { batch: StagedBatch; coalesced: boolean; changes: ChangeSet } {
		if (this.broken !== null) return this.wc.stage(ops, options);
		const dirty = new DirtyCollector();
		// A merge replays the batches from the one it lands in, which later ones
		// may overwrite in part and which may park: its trial run on top cannot
		// say what moved, so those batches are a rebase.
		const op = options.coalesce === true && ops.length === 1 ? ops[0]! : null;
		const update = op?.kind === 'update_element' || op?.kind === 'update_relationship' ? op : null;
		const at = update === null ? -1 : this.wc.mergePoint(update);
		const touched =
			at >= 0 ? this.beforeRebase([...this.wc.touchedIds(at), update!.id], dirty) : [];
		const out = this.wc.stage(ops, { ...options, dirty });
		if (out.coalesced) this.afterRebase(dirty, touched, out.changes);
		this.revalidate(this.reach(dirty), false);
		return out;
	}

	unstage(what: Unstage): ChangeSet {
		if (this.broken !== null) return this.wc.unstage(what);
		const dirty = new DirtyCollector();
		const touched = this.beforeRebase(this.wc.touchedIds(), dirty);
		const changes = this.wc.unstage(what);
		this.afterRebase(dirty, touched, changes);
		this.revalidate(this.reach(dirty), false);
		return changes;
	}

	applyDelta(delta: Delta, own?: OwnCommit): { status: DeltaStatus; changes: ChangeSet } {
		// Out of turn and not the user's own, a delta moves nothing.
		const still = delta.prev_rev !== this.wc.rev && own === undefined;
		if (this.broken !== null || still) {
			const out = this.wc.applyDelta(delta, own);
			if (out.status === 'applied') this.moves++;
			return out;
		}
		const dirty = new DirtyCollector();
		const touched = this.beforeRebase(
			[...this.wc.touchedIds(), ...deltaIds(delta), ...deltaEnds(delta)],
			dirty
		);
		const out = this.wc.applyDelta(delta, own);
		this.afterRebase(dirty, touched, out.changes);
		this.revalidate(this.reach(dirty), out.status === 'applied');
		return out;
	}

	/**
	 * Swaps the rule sets. When the working rules' identities change, in
	 * order, every element the old or the new ones apply to joins the rescan
	 * queue, after the ids still queued. Nothing is validated here.
	 */
	setRules(rules: LiveRules): void {
		const before = this.compiled.working;
		this.compiled = rules;
		if (this.broken === null && !sameList(before.identities, rules.working.identities)) {
			const queued = this.rescan === null ? [] : this.rescan.ids.slice(this.rescan.at);
			const seen = new Set(queued);
			for (const id of appliesPopulation(this.wc.model, before, rules.working)) {
				if (!seen.has(id)) queued.push(id);
				seen.add(id);
			}
			if (queued.length > 0) this.rescan = { ids: queued, at: 0 };
		}
		this.rulesMoves++;
		this.moves++;
		this.cached = null;
		this.deltaOf.clear();
		this.tags = null;
	}

	/**
	 * The neighbourhoods, before a rebase, of the ids it may touch and of the
	 * ends of every relationship among them: a relationship absent on one side
	 * cannot name its ends there, and they move groups all the same. Returns
	 * the ids taken, for `afterRebase`.
	 */
	private beforeRebase(named: readonly string[], dirty: DirtyCollector): string[] {
		const touched = [...named, ...endsOf(this.wc, named)];
		addNeighbourhood(this.wc.model, touched, dirty);
		return touched;
	}

	/**
	 * The collector widened by the working rules' reach on the state after the
	 * transition, as its ids; `deltaOf` forgets them, and the tag scope takes
	 * those it lacks from the store, which still holds their issues from before.
	 */
	private reach(dirty: DirtyCollector): readonly string[] {
		dirty.update(expandScope(this.wc.model, this.compiled.working, dirty.ids));
		if (this.deltaOf.size > 0) for (const id of dirty.ids) this.deltaOf.delete(id);
		this.keepTags(dirty.ids);
		return dirty.ids;
	}

	/** The neighbourhoods, after a rebase, of what it could touch, of what it did, and of their ends. */
	private afterRebase(dirty: DirtyCollector, touched: readonly string[], changes: ChangeSet): void {
		const after = new Set([...touched, ...changedIds(changes)]);
		addNeighbourhood(this.wc.model, new Set([...after, ...endsOf(this.wc, after)]), dirty);
	}

	/** Validates `ids` with the working rules and splices them into the store. */
	private revalidate(ids: readonly string[], revMoved: boolean): void {
		let moved = revMoved;
		if (this.broken === null && ids.length > 0) {
			try {
				const found = this.validate(ids, this.compiled.working);
				moved = this.issues.replace(ids, found) || moved;
			} catch (caught) {
				if (!(caught instanceof PatternUnusable)) throw caught;
				this.markUnusable();
				return;
			}
		}
		if (moved) this.moves++;
	}

	private validate(ids: readonly string[], rules: CompiledRules): Issue[] {
		return validateScoped(this.wc.model, ids, this.validators, this.patterns, rules);
	}

	private markUnusable(): void {
		this.broken = 'pattern';
		this.issues = new IssueStore();
		this.sweep = null;
		this.rescan = null;
		this.cached = null;
		this.deltaOf.clear();
		this.tags = null;
		this.moves++;
		this.release();
	}

	// -- the sweep -----------------------------------------------------------

	/**
	 * The sweep in steps: the first takes the total, the number of entities
	 * then; each after it validates the next `sweepStep` entities it has not
	 * validated yet, elements in state order then relationships, and splices
	 * them into the store, a complete change of its own. Its progress counts the entities validated,
	 * short of the total until the last step. Then the rescan, when one is
	 * due: `sweepStep` of its ids a step, each step yielding `RESCAN_STEP`.
	 * Every step validates with the rules as they are then. Its state is this
	 * object's, never the generator's, so any generator resumes it where it
	 * stands. The value is `true` when both ran to their end, `false` when the
	 * store is unusable.
	 */
	*sweepSteps(): Generator<SweepStep, boolean, void> {
		for (;;) {
			if (this.broken !== null) return false;
			const sweep = this.sweep;
			if (sweep === null) {
				const rescan = this.rescan;
				if (rescan === null) return true;
				const next = rescan.ids.slice(rescan.at, rescan.at + this.sweepStep);
				rescan.at += next.length;
				this.revalidate(next, false);
				if (this.broken !== null) return false;
				if (this.rescan === rescan && rescan.at >= rescan.ids.length) {
					this.rescan = null;
					this.release();
				}
				yield RESCAN_STEP;
				continue;
			}
			const model = this.wc.model;
			if (sweep.total === null) {
				sweep.total = model.elementCount + model.relationshipCount;
				yield { done: 0, total: sweep.total };
				continue;
			}
			const next: string[] = [];
			const skip = { left: this.sweepSkip };
			this.pull(sweep, sweep.elements, () => model.elements(), next, skip);
			if (sweep.elements.ended) {
				this.pull(sweep, sweep.relationships, () => model.relationships(), next, skip);
			}
			sweep.done += next.length;
			this.revalidate(next, false);
			if (this.broken !== null) return false;
			const total = sweep.total;
			if (!sweep.relationships.ended) {
				// Entities made since the start are validated too: the count may pass the total.
				yield { done: Math.max(0, Math.min(sweep.done, total - 1)), total };
				continue;
			}
			if (this.sweep === sweep) {
				this.sweep = null;
				this.swept = true;
				this.release();
			}
			yield { done: total, total };
		}
	}

	/**
	 * Pulls the next entities of `at`'s map that the sweep has not validated
	 * yet into `into`, up to `sweepStep` of them, passing over at most
	 * `skip.left` it has. A live iterator reads, before it ends, every entity
	 * the map holds between two steps: one put back or made again at the map's
	 * end — a refused batch rewound, a probe's replay — included. It is taken
	 * again when a re-sort moves the model's order epoch, since it would read
	 * the whole map again anyway.
	 */
	private pull<T extends ElementRec | RelRec>(
		sweep: Sweep,
		at: Cursor<T>,
		read: () => Iterator<T>,
		into: string[],
		skip: { left: number }
	): void {
		const model = this.wc.model;
		while (into.length < this.sweepStep && skip.left > 0 && !at.ended) {
			if (at.iter === null || at.epoch !== model.orderEpoch) {
				at.iter = read();
				at.epoch = model.orderEpoch;
			}
			const next = at.iter.next();
			if (next.done === true) {
				at.ended = true;
				at.iter = null;
			} else if (sweep.validated.has(next.value.id)) {
				skip.left--;
			} else {
				sweep.validated.add(next.value.id);
				into.push(next.value.id);
			}
		}
	}

	/** Sweeps again from the start, in place: the store keeps what it holds meanwhile. */
	restartSweep(): void {
		if (this.broken === null) this.sweep = newSweep();
	}

	/** Resolves once no sweep and no rescan is due, or the store is unusable. */
	whenSwept(): Promise<void> {
		if (this.sweep === null && this.rescan === null) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Resolves once no rescan is due, or the store is unusable. */
	whenSettled(): Promise<void> {
		if (this.rescan === null) return Promise.resolve();
		return new Promise((resolve) => this.settleWaiters.push(resolve));
	}

	/** Resolves what waits for what is no longer due. */
	private release(): void {
		if (this.rescan !== null) return;
		for (const resolve of this.settleWaiters.splice(0)) resolve();
		if (this.sweep === null) for (const resolve of this.waiters.splice(0)) resolve();
	}

	// -- origins -------------------------------------------------------------

	/**
	 * The staged changes' dirty sets and their issues on both states, by a
	 * probe of the working copy: probed once per committed rev, staged version
	 * and rules version. Throws `PatternUnusable` when the store is unusable,
	 * or becomes so.
	 */
	origins(): Origins {
		if (this.broken !== null) throw new PatternUnusable();
		const wc = this.wc;
		const cached = this.cached;
		if (
			cached !== null &&
			cached.rev === wc.rev &&
			cached.stagedVersion === wc.stagedVersion &&
			cached.rulesVersion === this.rulesMoves
		) {
			return cached.origins;
		}
		let origins: Origins;
		this.probeRuns++;
		try {
			origins = this.probe();
		} catch (caught) {
			if (caught instanceof PatternUnusable) this.markUnusable();
			throw caught;
		}
		this.cached = {
			rev: wc.rev,
			stagedVersion: wc.stagedVersion,
			rulesVersion: this.rulesMoves,
			origins
		};
		return origins;
	}

	/**
	 * The origins afresh. The elements a changed rule applies to that neither
	 * rule set reaches from the hooks have the same inputs on both states: their
	 * issues come from `changedOwners`, not from the probe.
	 */
	private probe(): Origins {
		const wc = this.wc;
		const model = wc.model;
		const { working: w, committed: c } = this.compiled;
		const changed = changedRules(w, c);
		if (wc.staged().length === 0) {
			if (changed.length === 0) return NOTHING_STAGED;
			const population = appliesPopulation(model, { rules: changed });
			return { ...NOTHING_STAGED, dirty: population, ...this.changedOwners(population) };
		}
		// The same rules in the same order: the preview is the working half.
		const same = sameList(w.identities, c.identities);
		let scope: readonly string[] = [];
		let dirty: readonly string[] = [];
		let previewDirty: readonly string[] = [];
		let preview: readonly Issue[] = [];
		let outside: readonly string[] = [];
		const probed = wc.probeStaged(
			(hooks) => {
				const reached = ordered(hooks, expandScope(model, w, hooks));
				scope = dirty = previewDirty = reached;
				if (!same) {
					const reachedByC = expandScope(model, c, hooks);
					previewDirty = ordered(hooks, reachedByC);
					if (changed.length > 0) {
						const modelDirty = new Set([...reached, ...reachedByC]);
						const population = appliesPopulation(model, { rules: changed });
						scope = ordered(
							reached,
							population.filter((id) => modelDirty.has(id))
						);
						outside = population.filter((id) => !modelDirty.has(id));
						dirty = ordered(reached, population);
					}
				}
				const working = this.validate(scope, w);
				preview = same ? working : this.validate(previewDirty, c);
				return working;
			},
			() => this.validate(scope, c)
		);
		const origins = {
			hooks: probed.dirty,
			dirty,
			working: probed.working,
			committed: probed.committed,
			previewDirty,
			preview
		};
		if (outside.length === 0) return origins;
		// On the working state again: the probe put the staged batches back.
		const rest = this.changedOwners(outside);
		return {
			...origins,
			working: [...origins.working, ...rest.working],
			committed: [...origins.committed, ...rest.committed]
		};
	}

	// -- the panel's tags ----------------------------------------------------

	/**
	 * Every owner whose issues may differ between the committed and the
	 * working state, each with its committed issues: what the panel's tags
	 * read, an issue of an owner it does not name being the same on both
	 * states. The exact probe finds it (`origins()`: its dirty set, with the
	 * committed issues); then, while the store is seeded and settled, the rev
	 * and the rule sets hold and the working rules are the committed ones, each
	 * transition adds the ids it dirties, with the store's issues from just
	 * before it: no transition had dirtied them since the probe, so those were
	 * their committed issues. Otherwise every call reads `origins()`. Throws
	 * `PatternUnusable` when the store is unusable, or becomes so.
	 */
	tagScope(): ReadonlyMap<string, readonly Issue[]> {
		if (this.broken !== null) throw new PatternUnusable();
		const kept = this.tags;
		if (kept !== null && this.tagsHold(kept)) return kept.committedOf;
		this.tags = null;
		const { dirty, committed } = this.origins();
		const committedOf = new Map<string, Issue[]>();
		for (const id of dirty) committedOf.set(id, []);
		for (const issue of committed) committedOf.get(issueOwner(issue))?.push(issue);
		const tags = { rev: this.wc.rev, rulesVersion: this.rulesMoves, committedOf };
		if (this.tagsHold(tags)) this.tags = tags;
		return committedOf;
	}

	/** Drops the tag scope kept, so that the next `tagScope()` reads `origins()`; nothing else moves. */
	resetTagScope(): void {
		this.tags = null;
	}

	private tagsHold(tags: Tags): boolean {
		const { working, committed } = this.compiled;
		return (
			this.swept &&
			this.rescan === null &&
			tags.rev === this.wc.rev &&
			tags.rulesVersion === this.rulesMoves &&
			sameList(working.identities, committed.identities)
		);
	}

	/** A transition's dirty ids join the tag scope kept, before it revalidates them. */
	private keepTags(ids: readonly string[]): void {
		const tags = this.tags;
		if (tags === null) return;
		if (!this.tagsHold(tags)) {
			this.tags = null;
			return;
		}
		for (const id of ids) {
			if (!tags.committedOf.has(id)) tags.committedOf.set(id, this.issues.issuesOf(id));
		}
	}

	/** `ids`' issues with the working and with the committed rules on the working state, from `deltaOf` where it has them. */
	private changedOwners(ids: readonly string[]): { working: Issue[]; committed: Issue[] } {
		if (this.deltaRev !== this.wc.rev) {
			this.deltaOf.clear();
			this.deltaRev = this.wc.rev;
		}
		const missing = ids.filter((id) => !this.deltaOf.has(id));
		if (missing.length > 0) {
			const working = byIssueOwner(this.validate(missing, this.compiled.working));
			const committed = byIssueOwner(this.validate(missing, this.compiled.committed));
			for (const id of missing) {
				this.deltaOf.set(id, {
					working: working.get(id) ?? [],
					committed: committed.get(id) ?? []
				});
			}
		}
		const out: { working: Issue[]; committed: Issue[] } = { working: [], committed: [] };
		for (const id of ids) {
			const entry = this.deltaOf.get(id)!;
			out.working.push(...entry.working);
			out.committed.push(...entry.committed);
		}
		return out;
	}
}
