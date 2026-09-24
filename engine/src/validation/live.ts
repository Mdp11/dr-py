import type { Model } from '../model/model.ts';
import type { ModelOp } from '../ops/types.ts';
import type { Steps } from '../steps/steps.ts';
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
import type { Issue } from './issue.ts';
import { FacetPatterns, PatternUnusable, validateScoped, Validators } from './pipeline.ts';
import { IssueStore } from './store.ts';

/** Ids a sweep step validates and splices. */
export const SWEEP_STEP = 512;

export type LiveIssuesOptions = {
	/** A store already complete for the working copy's state: the replica counts as swept. */
	seed?: IssueStore;
	/** Ids per sweep step, `SWEEP_STEP` unless given. */
	sweepStep?: number;
};

/**
 * What the staged ops change, as the server's preview sees them: `dirty`, the
 * dirty set of the staged ops applied as one batch to the committed state,
 * and its issues on the working state and on the committed state.
 */
export type Origins = {
	readonly dirty: readonly string[];
	readonly working: readonly Issue[];
	readonly committed: readonly Issue[];
};

const NOTHING_STAGED: Origins = { dirty: [], working: [], committed: [] };

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

/** Every element id in state order, then every relationship id. */
function allIds(model: Model): string[] {
	const ids: string[] = [];
	for (const element of model.elements()) ids.push(element.id);
	for (const rel of model.relationships()) ids.push(rel.id);
	return ids;
}

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
 * Nothing else may write to the working copy while this one wraps it.
 */
export class LiveIssues {
	readonly wc: WorkingCopy;
	private readonly validators: Validators;
	private readonly patterns: FacetPatterns;
	private readonly sweepStep: number;
	private issues: IssueStore;
	private moves = 0;
	private swept: boolean;
	private broken: 'pattern' | null = null;
	/** The sweep due: the ids its first step listed, and how many are done; `null` when none is. */
	private sweep: { ids: string[] | null; at: number } | null;
	private waiters: (() => void)[] = [];
	private cached: { rev: number; stagedVersion: number; origins: Origins } | null = null;

	constructor(wc: WorkingCopy, options: LiveIssuesOptions = {}) {
		this.wc = wc;
		const mm = wc.model.metamodel;
		this.validators = new Validators(mm);
		this.patterns = new FacetPatterns(mm);
		this.sweepStep = options.sweepStep ?? SWEEP_STEP;
		this.issues = options.seed ?? new IssueStore();
		this.swept = options.seed !== undefined;
		this.sweep = options.seed === undefined ? { ids: null, at: 0 } : null;
		if (this.patterns.unusable) {
			this.broken = 'pattern';
			this.issues = new IssueStore();
			this.sweep = null;
		}
	}

	get store(): IssueStore {
		return this.issues;
	}

	/** Moves when the store's content moves, when a delta moves the committed rev, and when it becomes unusable. */
	get version(): number {
		return this.moves;
	}

	/** Set once a sweep has run to its end; a later sweep keeps it. */
	get seeded(): boolean {
		return this.swept;
	}

	get unusable(): 'pattern' | null {
		return this.broken;
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
		this.revalidate(dirty.ids, false);
		return out;
	}

	unstage(what: Unstage): ChangeSet {
		if (this.broken !== null) return this.wc.unstage(what);
		const dirty = new DirtyCollector();
		const touched = this.beforeRebase(this.wc.touchedIds(), dirty);
		const changes = this.wc.unstage(what);
		this.afterRebase(dirty, touched, changes);
		this.revalidate(dirty.ids, false);
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
		this.revalidate(dirty.ids, out.status === 'applied');
		return out;
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

	/** The neighbourhoods, after a rebase, of what it could touch, of what it did, and of their ends. */
	private afterRebase(dirty: DirtyCollector, touched: readonly string[], changes: ChangeSet): void {
		const after = new Set([...touched, ...changedIds(changes)]);
		addNeighbourhood(this.wc.model, new Set([...after, ...endsOf(this.wc, after)]), dirty);
	}

	/** Validates `ids` and splices them into the store. */
	private revalidate(ids: readonly string[], revMoved: boolean): void {
		let moved = revMoved;
		if (this.broken === null && ids.length > 0) {
			try {
				const found = validateScoped(this.wc.model, ids, this.validators, this.patterns);
				moved = this.issues.replace(ids, found) || moved;
			} catch (caught) {
				if (!(caught instanceof PatternUnusable)) throw caught;
				this.markUnusable();
				return;
			}
		}
		if (moved) this.moves++;
	}

	private markUnusable(): void {
		this.broken = 'pattern';
		this.issues = new IssueStore();
		this.sweep = null;
		this.cached = null;
		this.moves++;
		this.release();
	}

	// -- the sweep -----------------------------------------------------------

	/**
	 * The sweep in steps: the first lists every element id in state order,
	 * then every relationship id; each after it validates the next
	 * `sweepStep` of them and splices them into the store, a complete change
	 * of its own. An id gone since is dropped from the store, and one new since
	 * was validated by the transition that made it. Its state is this object's,
	 * never the generator's, so any generator resumes it where it stands. The
	 * value is `true` when a sweep ran to its end, `false` when the store is
	 * unusable.
	 */
	*sweepSteps(): Steps<boolean> {
		for (;;) {
			if (this.broken !== null) return false;
			const sweep = this.sweep;
			if (sweep === null) return true;
			if (sweep.ids === null) {
				sweep.ids = allIds(this.wc.model);
				sweep.at = 0;
				yield { done: 0, total: sweep.ids.length };
				continue;
			}
			const ids = sweep.ids;
			const next = ids.slice(sweep.at, sweep.at + this.sweepStep);
			sweep.at += next.length;
			this.revalidate(next, false);
			if (this.broken !== null) return false;
			if (sweep.at < ids.length) {
				yield { done: sweep.at, total: ids.length };
				continue;
			}
			if (this.sweep === sweep) {
				this.sweep = null;
				this.swept = true;
				this.release();
			}
			yield { done: ids.length, total: ids.length };
		}
	}

	/** Sweeps again from a fresh list of ids, in place: the store keeps what it holds meanwhile. */
	restartSweep(): void {
		if (this.broken === null) this.sweep = { ids: null, at: 0 };
	}

	/** Resolves once no sweep is due, or the store is unusable. */
	whenSwept(): Promise<void> {
		if (this.sweep === null) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	private release(): void {
		for (const resolve of this.waiters.splice(0)) resolve();
	}

	// -- origins -------------------------------------------------------------

	/**
	 * The staged ops' dirty set and its issues on both states, by a probe of
	 * the working copy: probed once per committed rev and staged version.
	 * Throws `PatternUnusable` when the store is unusable, or becomes so.
	 */
	origins(): Origins {
		if (this.broken !== null) throw new PatternUnusable();
		const wc = this.wc;
		const cached = this.cached;
		if (cached !== null && cached.rev === wc.rev && cached.stagedVersion === wc.stagedVersion) {
			return cached.origins;
		}
		let origins = NOTHING_STAGED;
		if (wc.staged().length > 0) {
			let scope: readonly string[] = [];
			const validate = (ids: readonly string[]) =>
				validateScoped(wc.model, ids, this.validators, this.patterns);
			try {
				origins = wc.probeStaged(
					(dirty) => validate((scope = dirty)),
					() => validate(scope)
				);
			} catch (caught) {
				if (caught instanceof PatternUnusable) this.markUnusable();
				throw caught;
			}
		}
		this.cached = { rev: wc.rev, stagedVersion: wc.stagedVersion, origins };
		return origins;
	}
}
