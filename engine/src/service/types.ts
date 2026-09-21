import type { SnapshotHeader } from '../snapshot/open.ts';
import type { Wire, WireElement, WireRelationship } from '../read/wire.ts';
import type { HostDeps } from './scheduler.ts';

/** Where messages cross: a `MessagePort` in a worker, a direct pair in tests. */
export type Port = {
	post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
	onMessage(handler: (message: unknown) => void): void;
};

/** What the host supplies: the shared thread, and gzip, which the engine does not hold. */
export type ServiceDeps = HostDeps & {
	inflate(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
};

export type ReplicaState = 'opening' | 'ready' | 'diverged';

export type RequestMessage = { id: string | number; method: string; params?: unknown };
export type CancelMessage = { cancel: string | number };

export type ErrorBody = { status: number; detail: string };

export type ResponseMessage =
	| { id: string | number; ok: true; result: unknown }
	| { id: string | number; ok: false; error: ErrorBody };

export type ProgressTask = 'parse' | 'index' | 'tail' | 'verify';

/** The ids a transition may have changed, in the wire's names. */
export type WireChanges = {
	element_ids: string[];
	relationship_ids: string[];
	deleted_element_ids: string[];
	deleted_relationship_ids: string[];
	structural: boolean;
};

export type ServiceEvent =
	| { event: 'replica'; state: ReplicaState; rev: number | null }
	| { event: 'progress'; task: ProgressTask; done: number; total: number }
	| ({ event: 'changed'; rev: number; staged_version: number } & WireChanges);

export type WireBatch = { id: number; ops: Wire[] };
export type WireConflict = { batch: WireBatch; error: ErrorBody };

// -- params and results, per method ------------------------------------------

export type OpenParams = { project_id: string; metamodel: unknown };
export type ChunkParams = { bytes: ArrayBuffer };
export type EndResult = SnapshotHeader;
export type AdoptParams = { batches: { id: number; ops: unknown }[] };
export type AdoptResult = { changes: WireChanges; conflicts: WireConflict[] };
export type TailParams = { text: string };
export type TailResult = {
	status: 'applied' | 'gap';
	rev: number;
	applied: number;
	diverged: boolean;
};
export type DeltaParams = {
	text: string;
	own?: { batch_ids: number[]; id_map: { [tempId: string]: string } };
};
export type DeltaResult = {
	status: 'applied' | 'duplicate' | 'gap';
	rev: number;
	diverged: boolean;
};
export type StageParams = { ops: unknown };
export type StageResult = {
	batch: WireBatch;
	coalesced: boolean;
	changes: WireChanges;
	/** The post-state of what `changes` names as changed; `null` past 500 entities. */
	elements: WireElement[] | null;
	relationships: WireRelationship[] | null;
};
export type StagedDiffResult = {
	elements: { id: string; before: WireElement | null; after: WireElement | null }[];
	relationships: { id: string; before: WireRelationship | null; after: WireRelationship | null }[];
};
export type ViewPlacementParams = { view_id: string; element_ids: string[] };
