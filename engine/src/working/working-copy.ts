import { ModelError } from '../model/errors.ts';
import { pyRepr } from '../value/repr.ts';
import type { Model } from '../model/model.ts';
import type { ElementRec, RelRec } from '../model/records.ts';
import { applyBatch } from '../ops/apply.ts';
import { OpError } from '../ops/errors.ts';
import { remapOp } from '../ops/remap.ts';
import {
	elementImage,
	relImage,
	type BatchResult,
	type ElementImage,
	type RelImage
} from '../ops/result.ts';
import { rewind } from '../ops/rewind.ts';
import type { ModelOp, UpdateElementOp, UpdateRelationshipOp } from '../ops/types.ts';
import { entityHash, formatDigest, type EntityHash } from '../snapshot/digest.ts';
import { drain, type Steps } from '../steps/steps.ts';
import { DirtyCollector } from '../validation/dirty.ts';
import { readDelta, type CommittedChange, type Delta } from './delta.ts';

export type WorkingCopyOptions = {
	/** Replaces the `(id, rev)` hash of the state digest; tests check the engine's own against another. */
	entityHash?: EntityHash;
};

export type StagedBatch = { readonly id: number; readonly ops: readonly ModelOp[] };

/** A staged batch that a change underneath it made impossible to apply. */
export type Conflict = { readonly batch: StagedBatch; readonly error: OpError };

/**
 * The ids an operation may have changed, and the ids it left absent.
 * `structural` says that it may have moved more than properties: it names a
 * relationship, a deleted element, or an element that was absent when it
 * began — or it is the user's own commit with minted ids.
 */
export type ChangeSet = {
	elementIds: string[];
	relationshipIds: string[];
	deletedElementIds: string[];
	deletedRelationshipIds: string[];
	structural: boolean;
};

/** Every entity a staged batch touched: its committed image, and its record now. */
export type StagedDiff = {
	elements: { id: string; before: ElementImage | null; after: ElementRec | null }[];
	relationships: { id: string; before: RelImage | null; after: RelRec | null }[];
};

/**
 * What to unstage: everything; one batch, staged or parked; or every staged op
 * that targets one entity — with `incident`, also every staged relationship op
 * with that entity at one end.
 */
export type Unstage = 'all' | { batch: number } | { entity: string; incident?: boolean };

/** The staged batches a delta committed, and the ids the server minted for their temp ids. */
export type OwnCommit = { batchIds: readonly number[]; idMap: ReadonlyMap<string, string> };

export type DeltaStatus = 'applied' | 'duplicate' | 'gap';

type Entry = { batch: StagedBatch; result: BatchResult };

class Touched {
	readonly elements = new Set<string>();
	readonly relationships = new Set<string>();
	// The elements present when the operation began, of those it may name.
	private readonly present = new Set<string>();
	private readonly seen = new Set<string>();

	add(result: BatchResult): void {
		for (const id of result.beforeElements.keys()) this.elements.add(id);
		for (const id of result.beforeRelationships.keys()) this.relationships.add(id);
	}

	/** Before anything moves: which of `ids` are present. */
	notePresent(model: Model, ids: Iterable<string>): void {
		for (const id of ids) if (model.findElement(id) !== undefined) this.present.add(id);
	}

	/** For batches applied in turn: an element's first before-image is its state at the start. */
	noteFirstImages(result: BatchResult): void {
		for (const [id, image] of result.beforeElements) {
			if (this.seen.has(id)) continue;
			this.seen.add(id);
			if (image !== null) this.present.add(id);
		}
	}

	/** Present now means changed, absent means deleted: over-reporting is harmless. */
	changeSet(model: Model): ChangeSet {
		const changes = emptyChangeSet();
		for (const id of this.elements) {
			(model.findElement(id) ? changes.elementIds : changes.deletedElementIds).push(id);
		}
		for (const id of this.relationships) {
			(model.findRelationship(id) ? changes.relationshipIds : changes.deletedRelationshipIds).push(
				id
			);
		}
		changes.structural = isStructural(changes, (id) => this.present.has(id));
		return changes;
	}
}

const emptyChangeSet = (): ChangeSet => ({
	elementIds: [],
	relationshipIds: [],
	deletedElementIds: [],
	deletedRelationshipIds: [],
	structural: false
});

function isStructural(changes: ChangeSet, wasPresent: (id: string) => boolean): boolean {
	return (
		changes.relationshipIds.length > 0 ||
		changes.deletedRelationshipIds.length > 0 ||
		changes.deletedElementIds.length > 0 ||
		changes.elementIds.some((id) => !wasPresent(id))
	);
}

/** What one batch, applied on top, changed: exactly its result's sets. */
function batchChanges(result: BatchResult): ChangeSet {
	const changes: ChangeSet = {
		elementIds: [...result.changedElementIds],
		relationshipIds: [...result.changedRelationshipIds],
		deletedElementIds: [...result.deletedElementIds],
		deletedRelationshipIds: [...result.deletedRelationshipIds],
		structural: false
	};
	changes.structural = isStructural(
		changes,
		(id) => (result.beforeElements.get(id) ?? null) !== null
	);
	return changes;
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((item, i) => item === b[i]);
}

type UpdateOp = UpdateElementOp | UpdateRelationshipOp;

const isUpdate = (op: ModelOp): op is UpdateOp =>
	op.kind === 'update_element' || op.kind === 'update_relationship';

function touches(
	op: ModelOp,
	id: string,
	incident: boolean,
	endsOf: (relId: string) => readonly string[]
): boolean {
	switch (op.kind) {
		case 'create_element':
			return op.temp_id === id || op.id === id;
		case 'update_element':
		case 'delete_element':
			return op.id === id;
		case 'create_relationship':
			if (op.temp_id === id || op.id === id) return true;
			return incident && (op.source_id === id || op.target_id === id);
		case 'update_relationship':
		case 'delete_relationship':
			return op.id === id || (incident && endsOf(op.id).includes(id));
	}
}

/**
 * A replica of one project's model with the user's uncommitted edits applied
 * to it in place. Committed state moves only through `applyDelta`; edits are
 * staged as op batches, each remembered with what it touched. Every change
 * underneath the staged batches is a rebase: rewind them newest first, make
 * the change, replay them in order. A batch that no longer applies is parked
 * as a conflict, never dropped.
 *
 * Nothing else may write to `model` once it is handed over.
 */
export class WorkingCopy {
	readonly model: Model;

	private committedRev: number;
	private committedDigest: bigint;
	private hasDiverged = false;
	private entries: Entry[] = [];
	private parked: Conflict[] = [];
	private nextBatchId = 1;
	private version = 0;
	private readonly entityHash: EntityHash;
	// The first before-image of every entity a staged batch touched: its
	// committed state, `null` when it has none.
	private readonly committedElements = new Map<string, ElementImage | null>();
	private readonly committedRelationships = new Map<string, RelImage | null>();

	constructor(
		model: Model,
		committed: { rev: number; digest: string },
		options: WorkingCopyOptions = {}
	) {
		this.model = model;
		this.committedRev = committed.rev;
		this.committedDigest = BigInt('0x' + committed.digest);
		this.entityHash = options.entityHash ?? entityHash;
	}

	// -- reading -------------------------------------------------------------

	/** The project revision the committed state stands at. */
	get rev(): number {
		return this.committedRev;
	}

	/** The state digest of the committed state, as the wire carries it. */
	get digest(): string {
		return formatDigest(this.committedDigest);
	}

	/** Set once the committed state is known to differ from the server's: discard the replica. */
	get diverged(): boolean {
		return this.hasDiverged;
	}

	staged(): readonly StagedBatch[] {
		return this.entries.map((entry) => entry.batch);
	}

	conflicts(): readonly Conflict[] {
		return this.parked;
	}

	/**
	 * Moves whenever `staged()` or `conflicts()` come to hold other batch
	 * objects: a stage, a merge, a remap, a batch dropped or parked.
	 */
	get stagedVersion(): number {
		return this.version;
	}

	/** One pair per entity a staged batch touched, in first-touch order. */
	stagedDiff(): StagedDiff {
		return {
			elements: [...this.committedElements].map(([id, before]) => ({
				id,
				before,
				after: this.model.findElement(id) ?? null
			})),
			relationships: [...this.committedRelationships].map(([id, before]) => ({
				id,
				before,
				after: this.model.findRelationship(id) ?? null
			}))
		};
	}

	isStaged(id: string): boolean {
		return this.committedElements.has(id) || this.committedRelationships.has(id);
	}

	/**
	 * Every id a staged batch touched, elements then relationships, each in
	 * first-touch order; with `from`, only the batches from that index on.
	 */
	touchedIds(from = 0): string[] {
		if (from === 0) {
			return [...this.committedElements.keys(), ...this.committedRelationships.keys()];
		}
		const elements = new Set<string>();
		const relationships = new Set<string>();
		for (const { result } of this.entries.slice(from)) {
			for (const id of result.beforeElements.keys()) elements.add(id);
			for (const id of result.beforeRelationships.keys()) relationships.add(id);
		}
		return [...elements, ...relationships];
	}

	/**
	 * The index of the staged batch `stage([op], {coalesce: true})` would merge
	 * `op` into, the batches from there on being the ones it replays; -1 when
	 * it would stage `op` as a batch of its own.
	 */
	mergePoint(op: ModelOp): number {
		if (!isUpdate(op)) return -1;
		return this.entries.findIndex(({ batch }) =>
			batch.ops.some((other) => other.kind === op.kind && other.id === op.id)
		);
	}

	/** The element as committed, whatever is staged on top; `null` when it has no committed state. */
	committedElement(id: string): ElementImage | null {
		const image = this.committedElements.get(id);
		if (image !== undefined) return image;
		const element = this.model.findElement(id);
		return element === undefined ? null : elementImage(element);
	}

	committedRelationship(id: string): RelImage | null {
		const image = this.committedRelationships.get(id);
		if (image !== undefined) return image;
		const rel = this.model.findRelationship(id);
		return rel === undefined ? null : relImage(rel);
	}

	/**
	 * Recomputes the state digest from every committed entity — the model's,
	 * with the committed image standing in wherever a staged batch has been —
	 * and compares it with the one held. A mismatch sets `diverged`.
	 */
	verifyDigest(): boolean {
		return drain(this.verifyDigestSteps());
	}

	/**
	 * `verifyDigest` in steps of 2,048 entities, after a first that reports
	 * where it starts; `diverged` is set, if at all, after the last. A
	 * transition between two steps invalidates it: drop it and start another.
	 */
	*verifyDigestSteps(): Steps<boolean> {
		const hash = this.entityHash;
		const model = this.model;
		const total =
			model.elementCount +
			model.relationshipCount +
			this.committedElements.size +
			this.committedRelationships.size;
		let done = 0;
		const counted = () => (++done & 2047) === 0;
		yield { done, total };
		let value = 0n;
		for (const element of model.elements()) {
			if (!this.committedElements.has(element.id)) value ^= hash(element.id, element.rev);
			if (counted()) yield { done, total };
		}
		for (const rel of model.relationships()) {
			if (!this.committedRelationships.has(rel.id)) value ^= hash(rel.id, rel.rev);
			if (counted()) yield { done, total };
		}
		for (const images of [this.committedElements, this.committedRelationships]) {
			for (const image of images.values()) {
				if (image !== null) value ^= hash(image.id, image.rev);
				if (counted()) yield { done, total };
			}
		}
		yield { done: total, total };
		if (value !== this.committedDigest) this.hasDiverged = true;
		return value === this.committedDigest;
	}

	// -- staging -------------------------------------------------------------

	/**
	 * Applies `ops` on top of everything staged. Created entities live under
	 * their temp ids. A refused batch throws `OpError` and leaves no trace.
	 *
	 * With `coalesce`, a single property update merges into the first staged
	 * op of the same kind and id instead — later keys win, a `null` stays —
	 * and the batch holding it is replayed with everything after it. It is
	 * never merged in place: a key deleted and set again would move, and the
	 * state would no longer be the one a replay of `staged()` gives.
	 *
	 * `dirty` receives the dirty-set hooks of the batch applied, or of a merged
	 * op's trial run on top: the same op on the same state. A refused batch
	 * leaves it holding ids of a batch that never happened.
	 */
	stage(
		ops: readonly ModelOp[],
		options: { coalesce?: boolean; dirty?: DirtyCollector } = {}
	): { batch: StagedBatch; coalesced: boolean; changes: ChangeSet } {
		const dirty = options.dirty;
		return this.tracked(() => {
			const merged =
				options.coalesce === true && ops.length === 1 ? this.coalesce(ops[0]!, dirty) : null;
			if (merged !== null) return { ...merged, coalesced: true };
			const result = applyBatch(this.model, ops, { dirty });
			const batch = { id: this.nextBatchId++, ops };
			this.keep({ batch, result });
			return { batch, coalesced: false, changes: batchChanges(result) };
		});
	}

	private coalesce(
		op: ModelOp,
		dirty: DirtyCollector | undefined
	): { batch: StagedBatch; changes: ChangeSet } | null {
		const at = this.mergePoint(op);
		if (at >= 0 && isUpdate(op)) {
			const { batch } = this.entries[at]!;
			const index = batch.ops.findIndex((other) => other.kind === op.kind && other.id === op.id);
			// Tried alone on top first: a bad patch must not park the user's earlier edits.
			rewind(this.model, applyBatch(this.model, [op], { dirty }));
			const found = batch.ops[index] as UpdateOp;
			const patch = { ...found.properties_patch, ...op.properties_patch };
			const merged = {
				id: batch.id,
				ops: batch.ops.with(index, { ...found, properties_patch: patch })
			};
			const changes = this.rebase(at, () => {
				this.entries[0] = { ...this.entries[0]!, batch: merged };
			});
			return { batch: merged, changes };
		}
		return null;
	}

	/**
	 * Replays batches carried over from another replica, under their ids, on
	 * one that has none: what a re-bootstrap keeps. The ones that no longer
	 * apply are parked.
	 */
	adoptStaged(batches: readonly StagedBatch[]): {
		changes: ChangeSet;
		conflicts: readonly Conflict[];
	} {
		if (this.entries.length > 0 || this.parked.length > 0) {
			throw new ModelError(
				'value',
				'Staged batches can only be adopted by a replica that has none'
			);
		}
		return this.tracked(() => {
			const touched = new Touched();
			for (const batch of batches) {
				try {
					const result = applyBatch(this.model, batch.ops);
					touched.noteFirstImages(result);
					touched.add(result);
					this.keep({ batch, result });
				} catch (caught) {
					if (!(caught instanceof OpError)) throw caught;
					this.parked.push({ batch, error: caught });
				}
				this.nextBatchId = Math.max(this.nextBatchId, batch.id + 1);
			}
			return { changes: touched.changeSet(this.model), conflicts: [...this.parked] };
		});
	}

	unstage(what: Unstage): ChangeSet {
		return this.tracked(() => this.unstageNow(what));
	}

	private unstageNow(what: Unstage): ChangeSet {
		if (what === 'all') {
			this.parked = [];
			return this.rebase(0, () => (this.entries = []));
		}
		if ('batch' in what) {
			this.parked = this.parked.filter((conflict) => conflict.batch.id !== what.batch);
			if (!this.entries.some((entry) => entry.batch.id === what.batch)) return emptyChangeSet();
			return this.rebase(0, () => {
				this.entries = this.entries.filter((entry) => entry.batch.id !== what.batch);
			});
		}
		// Ends are looked up while the staged state still stands.
		const kept = this.entries.map((entry) => ({
			batch: entry.batch,
			ops: entry.batch.ops.filter(
				(op) => !touches(op, what.entity, what.incident === true, (id) => this.endsOf(id))
			)
		}));
		if (kept.every(({ batch, ops }) => ops.length === batch.ops.length)) return emptyChangeSet();
		return this.rebase(0, () => {
			this.entries = this.entries.flatMap((entry, i) => {
				const ops = kept[i]!.ops;
				return ops.length === 0 ? [] : [{ ...entry, batch: { id: entry.batch.id, ops } }];
			});
		});
	}

	/** The ends of a relationship, staged or committed or deleted by a staged batch. */
	private endsOf(relId: string): readonly string[] {
		const rel = this.model.findRelationship(relId);
		if (rel !== undefined) return [rel.source.id, rel.target.id];
		for (const entry of this.entries) {
			const image = entry.result.beforeRelationships.get(relId);
			if (image) return [image.sourceId, image.targetId];
		}
		return [];
	}

	/**
	 * Looks at the staged batches as the server would take them, and leaves no
	 * trace: rewinds them, replays them in order into one dirty collector —
	 * the dirty set of the staged ops applied as one batch to the committed
	 * state — and runs `onWorking` over it; rewinds again and runs
	 * `onCommitted` on the committed state; replays once more. The entries
	 * and committed images are rebuilt from the replays, `staged()`,
	 * `conflicts()` and `stagedVersion` stay as they were. Neither callback may
	 * write to the model.
	 */
	probeStaged<W, C>(
		onWorking: (dirty: readonly string[]) => W,
		onCommitted: () => C
	): { dirty: string[]; working: W; committed: C } {
		const model = this.model;
		for (const entry of this.entries.toReversed()) rewind(model, entry.result);
		const collector = new DirtyCollector();
		this.replayInPlace(collector);
		const dirty = [...collector.ids];
		const working = onWorking(dirty);
		for (const entry of this.entries.toReversed()) rewind(model, entry.result);
		let committed: C;
		try {
			committed = onCommitted();
		} finally {
			this.replayInPlace();
		}
		return { dirty, working, committed };
	}

	/**
	 * Applies every staged batch again, the state below them being the one they
	 * were applied to, and keeps the new results. It cannot be refused: these
	 * are the batches that applied there. If one is all the same, a plain
	 * `Error` is thrown with the staged batches put back as they stood, or,
	 * when even that fails, still listed and the replica diverged.
	 */
	private replayInPlace(dirty?: DirtyCollector): void {
		const batches = this.entries.map((entry) => entry.batch);
		let replayed: Entry[];
		try {
			replayed = this.applyAll(batches, dirty);
		} catch (caught) {
			try {
				this.reinstate(this.applyAll(batches));
			} catch {
				// The model stands below the batches, which the next replica adopts.
				this.hasDiverged = true;
			}
			const reason = caught instanceof Error ? caught.message : String(caught);
			throw new Error(`a staged batch did not replay where it applied: ${reason}`, {
				cause: caught
			});
		}
		this.reinstate(replayed);
	}

	/** Applies `batches` in order; a refusal rewinds what they applied and propagates. */
	private applyAll(batches: readonly StagedBatch[], dirty?: DirtyCollector): Entry[] {
		const applied: Entry[] = [];
		try {
			for (const batch of batches) {
				applied.push({ batch, result: applyBatch(this.model, batch.ops, { dirty }) });
			}
		} catch (caught) {
			for (const entry of applied.toReversed()) rewind(this.model, entry.result);
			throw caught;
		}
		return applied;
	}

	/** Takes `entries` as the staged ones, rebuilding the committed images from them. */
	private reinstate(entries: readonly Entry[]): void {
		this.entries = [];
		this.committedElements.clear();
		this.committedRelationships.clear();
		for (const entry of entries) this.keep(entry);
	}

	// -- committed state -----------------------------------------------------

	/**
	 * Takes a commit delta. It applies when it continues from this replica's
	 * revision; one that is not newer is a duplicate; anything else is a gap,
	 * and the caller fetches the tail. For the user's own commit, `own` names
	 * the staged batches it carried: they are dropped, and the ids the server
	 * minted replace their temp ids in what stays staged.
	 *
	 * A duplicate that names the user's own commit still drops its batches:
	 * the echo of a commit can arrive before the commit's own answer.
	 *
	 * A delta the replica cannot hold throws `SnapshotError` before anything
	 * moves. One that does not fit the replica, or whose digest disagrees
	 * afterwards, sets `diverged`.
	 */
	applyDelta(delta: Delta, own?: OwnCommit): { status: DeltaStatus; changes: ChangeSet } {
		return this.tracked(() => this.applyDeltaNow(delta, own));
	}

	private applyDeltaNow(
		delta: Delta,
		own?: OwnCommit
	): { status: DeltaStatus; changes: ChangeSet } {
		const minted = own !== undefined && own.idMap.size > 0;
		if (delta.prev_rev !== this.committedRev) {
			const status = delta.rev <= this.committedRev ? 'duplicate' : 'gap';
			if (status === 'duplicate' && own !== undefined && this.holdsAny(own.batchIds)) {
				const changes = this.rebase(0, () => this.adopt(own));
				changes.structural ||= minted;
				return { status, changes };
			}
			return { status, changes: emptyChangeSet() };
		}
		const change = readDelta(delta);
		const named = [
			...change.elements.map((element) => element.id),
			...change.deletedElementIds,
			...change.recreatedElementIds
		];
		const changes = this.rebase(
			0,
			(touched) => {
				try {
					this.commit(change, touched);
				} catch (caught) {
					if (!(caught instanceof ModelError)) throw caught;
					this.hasDiverged = true;
				}
				if (own !== undefined) this.adopt(own);
			},
			named
		);
		changes.structural ||= minted;
		this.committedRev = delta.rev;
		if (this.digest !== delta.state_digest) this.hasDiverged = true;
		return { status: 'applied', changes };
	}

	private holdsAny(batchIds: readonly number[]): boolean {
		const ids = new Set(batchIds);
		return (
			this.entries.some((entry) => ids.has(entry.batch.id)) ||
			this.parked.some((conflict) => ids.has(conflict.batch.id))
		);
	}

	/**
	 * Writes committed state, the staged batches being rewound: relationships
	 * out, elements out, elements in, relationships in. A record keeps its
	 * identity and its place; a new entity goes last, and so does one the delta
	 * names as created again, which goes out first. A record that would have to
	 * change its type or its ends without being named does not fit the replica.
	 */
	private commit(change: CommittedChange, touched: Touched): void {
		const model = this.model;
		const fold = (id: string, rev: number) => {
			this.committedDigest ^= this.entityHash(id, rev);
		};
		const dropRelationship = (id: string) => {
			const rel = model.findRelationship(id);
			if (rel === undefined) return;
			fold(id, rel.rev);
			model.disconnect(id);
			touched.relationships.add(id);
		};
		const dropElement = (id: string) => {
			const element = model.findElement(id);
			if (element === undefined) return;
			// A consistent delta names every relationship of a deleted element.
			// What it does not name goes unfolded, and the digest tells.
			fold(id, element.rev);
			model.deleteElement(id);
			touched.elements.add(id);
		};
		for (const id of change.deletedRelationshipIds) dropRelationship(id);
		for (const id of change.recreatedRelationshipIds) dropRelationship(id);
		for (const id of change.deletedElementIds) dropElement(id);
		for (const id of change.recreatedElementIds) dropElement(id);
		for (const next of change.elements) {
			const element = model.findElement(next.id);
			touched.elements.add(next.id);
			if (element === undefined) {
				model.insertElement(next.id, next.typeName, next.props, next.rev);
			} else {
				if (element.typeName !== next.typeName) {
					throw new ModelError(
						'value',
						`Element ${pyRepr(next.id)} changes its type without being named as created again`
					);
				}
				fold(next.id, element.rev);
				model.overwrite(element, next.props, next.rev);
			}
			fold(next.id, next.rev);
		}
		for (const next of change.relationships) {
			const rel = model.findRelationship(next.id);
			touched.relationships.add(next.id);
			if (rel !== undefined) {
				const same =
					rel.typeName === next.typeName &&
					rel.source.id === next.sourceId &&
					rel.target.id === next.targetId;
				if (!same) {
					throw new ModelError(
						'value',
						`Relationship ${pyRepr(next.id)} changes its type or its ends ` +
							'without being named as created again'
					);
				}
				fold(next.id, rel.rev);
				model.overwrite(rel, next.props, next.rev);
			} else {
				model.insertRelationship(
					next.id,
					next.typeName,
					next.sourceId,
					next.targetId,
					next.props,
					next.rev
				);
			}
			fold(next.id, next.rev);
		}
	}

	/** Drops the batches the server committed and rewrites their temp ids in the rest. */
	private adopt(own: OwnCommit): void {
		const committed = new Set(own.batchIds);
		const remap = (batch: StagedBatch): StagedBatch => ({
			id: batch.id,
			ops: batch.ops.map((op) => remapOp(op, own.idMap))
		});
		this.entries = this.entries
			.filter((entry) => !committed.has(entry.batch.id))
			.map((entry) => ({ ...entry, batch: remap(entry.batch) }));
		this.parked = this.parked
			.filter((conflict) => !committed.has(conflict.batch.id))
			.map((conflict) => ({ ...conflict, batch: remap(conflict.batch) }));
	}

	// -- rebase --------------------------------------------------------------

	private keep(entry: Entry): void {
		this.entries.push(entry);
		for (const [id, image] of entry.result.beforeElements) {
			if (!this.committedElements.has(id)) this.committedElements.set(id, image);
		}
		for (const [id, image] of entry.result.beforeRelationships) {
			if (!this.committedRelationships.has(id)) this.committedRelationships.set(id, image);
		}
	}

	/** Runs `action`, and moves the staged version if the batch lists hold other objects after it. */
	private tracked<T>(action: () => T): T {
		const staged = this.entries.map((entry) => entry.batch);
		const parked = this.parked.map((conflict) => conflict.batch);
		try {
			return action();
		} finally {
			const same =
				sameItems(
					staged,
					this.entries.map((entry) => entry.batch)
				) &&
				sameItems(
					parked,
					this.parked.map((conflict) => conflict.batch)
				);
			if (!same) this.version++;
		}
	}

	/**
	 * Rewinds the staged batches from the newest down to the one at `from`;
	 * runs `change` on the state below them, where it may also edit that part
	 * of the staged list; replays it, in order, parking each batch that is
	 * refused. The batches below `from` stand as they are. `named` are the
	 * element ids the change itself may touch.
	 */
	private rebase(
		from: number,
		change: (touched: Touched) => void,
		named: Iterable<string> = []
	): ChangeSet {
		const touched = new Touched();
		const kept = this.entries.slice(0, from);
		const rewound = this.entries.slice(from);
		touched.notePresent(this.model, named);
		for (const entry of rewound)
			touched.notePresent(this.model, entry.result.beforeElements.keys());
		for (const entry of rewound.toReversed()) {
			rewind(this.model, entry.result);
			touched.add(entry.result);
		}
		this.committedElements.clear();
		this.committedRelationships.clear();
		this.entries = rewound;
		change(touched);
		const replay = this.entries;
		this.entries = [];
		for (const entry of kept) this.keep(entry);
		for (const { batch } of replay) {
			try {
				const result = applyBatch(this.model, batch.ops);
				this.keep({ batch, result });
				touched.add(result);
			} catch (caught) {
				if (!(caught instanceof OpError)) throw caught;
				this.parked.push({ batch, error: caught });
			}
		}
		return touched.changeSet(this.model);
	}
}
