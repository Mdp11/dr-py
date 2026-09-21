import { ModelError } from '../model/errors.ts';
import { pyRepr } from '../value/repr.ts';
import type { Model } from '../model/model.ts';
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
import type { ModelOp } from '../ops/types.ts';
import { entityHash, formatDigest, type EntityHash } from '../snapshot/digest.ts';
import { drain, type Steps } from '../steps/steps.ts';
import { readDelta, type CommittedChange, type Delta } from './delta.ts';

export type WorkingCopyOptions = {
	/** Replaces the `(id, rev)` hash of the state digest; tests check the engine's own against another. */
	entityHash?: EntityHash;
};

export type StagedBatch = { readonly id: number; readonly ops: readonly ModelOp[] };

/** A staged batch that a change underneath it made impossible to apply. */
export type Conflict = { readonly batch: StagedBatch; readonly error: OpError };

/** The ids an operation may have changed, and the ids it left absent. */
export type ChangeSet = {
	elementIds: string[];
	relationshipIds: string[];
	deletedElementIds: string[];
	deletedRelationshipIds: string[];
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

	add(result: BatchResult): void {
		for (const id of result.beforeElements.keys()) this.elements.add(id);
		for (const id of result.beforeRelationships.keys()) this.relationships.add(id);
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
		return changes;
	}
}

const emptyChangeSet = (): ChangeSet => ({
	elementIds: [],
	relationshipIds: [],
	deletedElementIds: [],
	deletedRelationshipIds: []
});

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

	isStaged(id: string): boolean {
		return this.committedElements.has(id) || this.committedRelationships.has(id);
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
	 * `verifyDigest` in steps of 2,048 entities; `diverged` is set, if at all,
	 * after the last. A transition between two steps invalidates it: drop it
	 * and start another.
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
	 */
	stage(ops: readonly ModelOp[]): { batch: StagedBatch; changes: ChangeSet } {
		const result = applyBatch(this.model, ops);
		const batch = { id: this.nextBatchId++, ops };
		this.keep({ batch, result });
		return {
			batch,
			changes: {
				elementIds: [...result.changedElementIds],
				relationshipIds: [...result.changedRelationshipIds],
				deletedElementIds: [...result.deletedElementIds],
				deletedRelationshipIds: [...result.deletedRelationshipIds]
			}
		};
	}

	unstage(what: Unstage): ChangeSet {
		if (what === 'all') {
			this.parked = [];
			return this.rebase(() => (this.entries = []));
		}
		if ('batch' in what) {
			this.parked = this.parked.filter((conflict) => conflict.batch.id !== what.batch);
			if (!this.entries.some((entry) => entry.batch.id === what.batch)) return emptyChangeSet();
			return this.rebase(() => {
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
		return this.rebase(() => {
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

	// -- committed state -----------------------------------------------------

	/**
	 * Takes a commit delta. It applies when it continues from this replica's
	 * revision; one that is not newer is a duplicate; anything else is a gap,
	 * and the caller fetches the tail. For the user's own commit, `own` names
	 * the staged batches it carried: they are dropped, and the ids the server
	 * minted replace their temp ids in what stays staged.
	 *
	 * A delta the replica cannot hold throws `SnapshotError` before anything
	 * moves. One that does not fit the replica, or whose digest disagrees
	 * afterwards, sets `diverged`.
	 */
	applyDelta(delta: Delta, own?: OwnCommit): { status: DeltaStatus; changes: ChangeSet } {
		if (delta.prev_rev !== this.committedRev) {
			const status = delta.rev <= this.committedRev ? 'duplicate' : 'gap';
			return { status, changes: emptyChangeSet() };
		}
		const change = readDelta(delta);
		const changes = this.rebase((touched) => {
			try {
				this.commit(change, touched);
			} catch (caught) {
				if (!(caught instanceof ModelError)) throw caught;
				this.hasDiverged = true;
			}
			if (own !== undefined) this.adopt(own);
		});
		this.committedRev = delta.rev;
		if (this.digest !== delta.state_digest) this.hasDiverged = true;
		return { status: 'applied', changes };
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

	/**
	 * Rewinds every staged batch, newest first; runs `change` on committed
	 * state, where it may also edit the staged list; replays what is left, in
	 * order, parking each batch that is refused.
	 */
	private rebase(change: (touched: Touched) => void): ChangeSet {
		const touched = new Touched();
		for (const entry of this.entries.toReversed()) {
			rewind(this.model, entry.result);
			touched.add(entry.result);
		}
		this.committedElements.clear();
		this.committedRelationships.clear();
		change(touched);
		const replay = this.entries;
		this.entries = [];
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
