import type { WireArtifact, WireStagedArtifact } from '$engine';
import type { Artifact, ArtifactHeader } from '$lib/api/types';
import type { ReplicaSync } from './sync';

export type ArtifactFollowerDeps = {
	sync: Pick<ReplicaSync, 'setArtifacts' | 'putArtifacts' | 'setStagedArtifacts'>;
	/** Every artifact of the project with its payload, or the named ids it still has. */
	payloads(ids?: readonly string[]): Promise<Artifact[]>;
	/** The staged buffer as plain copies, in staging order. */
	staged(): WireStagedArtifact[];
};

/** What a feed event or a commit says of one artifact. */
export type ArtifactMark = Pick<ArtifactHeader, 'id' | 'artifact_rev'>;

export type ArtifactFollower = {
	/** Every committed artifact again: at the start, and after a feed reconnect. */
	load(): void;
	onEvent(action: 'created' | 'updated' | 'deleted', header: ArtifactMark): void;
	/**
	 * The user's own commit landed; its staged buffer was cleared in the same
	 * run. `idMap` names each created artifact's real id by its temp id.
	 */
	onCommit(info: {
		idMap: Readonly<Record<string, string>>;
		changed: ArtifactMark[];
		deletedIds: string[];
	}): void;
	stagedChanged(): void;
	/** Every answer that comes after it is dropped, and nothing more is asked. */
	stop(): void;
	/** Resolves once no fetch is out and no staged push waits. */
	settled(): Promise<void>;
};

/** Past this many ids, one fetch of everything costs less than a long query. */
const NAMED_MAX = 100;

const wire = ({ id, kind, name, artifact_rev, payload }: Artifact): WireArtifact => ({
	id,
	kind,
	name,
	artifact_rev,
	payload
});

/**
 * `buffer` laid over `base` as the buffer coalesces its own entries: an
 * update over a create or an update merges into it, anything else replaces it.
 */
function compose(
	base: readonly WireStagedArtifact[],
	buffer: readonly WireStagedArtifact[]
): WireStagedArtifact[] {
	const out = new Map<string, WireStagedArtifact>();
	for (const entry of base) out.set(entry.id, entry);
	for (const entry of buffer) {
		const prior = out.get(entry.id);
		if (entry.op !== 'update' || prior === undefined || prior.op === 'delete') {
			out.set(entry.id, entry);
			continue;
		}
		out.set(entry.id, {
			...prior,
			...(entry.name === undefined ? {} : { name: entry.name }),
			...(entry.payload === undefined ? {} : { payload: entry.payload })
		});
	}
	return [...out.values()];
}

/**
 * Keeps the sync's artifact context the project's: its committed payloads
 * and the frontend's staged buffer. Fetches run one at a time in the order
 * asked, so a later answer never lands under an earlier one.
 *
 * A commit's refresh holds the staged pushes. At once, the staged overlay
 * becomes the entries the commit carried, each created one ALSO under its
 * real id, with the buffer over them: until one `putArtifacts` brings the
 * payloads with the buffer as it is then, the engine reads the working copy
 * the commit came from under either id. A failed refresh keeps its entries
 * in the overlay until the next `load()` lands, which brings what it could
 * not; any other failed fetch leaves the context as it was until then.
 */
export function createArtifactFollower(deps: ArtifactFollowerDeps): ArtifactFollower {
	const { sync } = deps;
	let stopped = false;
	/** The rev of every committed artifact the engine was handed. */
	let revs = new Map<string, number>();
	let chain: Promise<void> = Promise.resolve();
	let running = 0;
	/** The buffer as last read: at a commit, the entries it carried. */
	let latest: WireStagedArtifact[] = [];
	/** Per commit refresh not yet landed, the entries it lays under the buffer. */
	const holds = new Set<WireStagedArtifact[]>();
	/** The entries of refreshes that failed, laid under the buffer until a `load()` lands. */
	let carried: WireStagedArtifact[] = [];
	let pushQueued = false;
	const idle: (() => void)[] = [];

	const release = () => {
		if (running === 0 && !pushQueued) for (const resolve of idle.splice(0)) resolve();
	};

	/** Runs `task` after every task asked before it; a failure is its own. */
	const enqueue = (task: () => Promise<void>) => {
		running += 1;
		chain = chain
			.then(() => (stopped ? undefined : task()))
			.catch(() => {})
			.finally(() => {
				running -= 1;
				release();
			});
	};

	const newer = (mark: ArtifactMark): boolean => (revs.get(mark.id) ?? -1) < mark.artifact_rev;

	const fetchNamed = async (ids: readonly string[]): Promise<Artifact[]> => {
		if (ids.length <= NAMED_MAX) return deps.payloads(ids);
		const wanted = new Set(ids);
		return (await deps.payloads()).filter((artifact) => wanted.has(artifact.id));
	};

	const remember = (changed: readonly Artifact[], deletedIds: readonly string[]) => {
		for (const artifact of changed) revs.set(artifact.id, artifact.artifact_rev);
		for (const id of deletedIds) revs.delete(id);
	};

	const read = (): WireStagedArtifact[] => {
		latest = deps.staged();
		return latest;
	};

	/** What the engine's staged overlay should be: the buffer over every held or carried entry. */
	const overlay = (): WireStagedArtifact[] => {
		const buffer = read();
		if (holds.size === 0 && carried.length === 0) return buffer;
		return compose([...carried, ...[...holds].flat()], buffer);
	};

	const pushStaged = () => {
		sync.setStagedArtifacts(overlay());
	};

	const stagedChanged = () => {
		if (stopped || pushQueued) return;
		pushQueued = true;
		// One microtask: a commit announced in the same run as its buffer's clear holds this.
		queueMicrotask(() => {
			pushQueued = false;
			try {
				if (stopped) return;
				if (holds.size === 0) pushStaged();
				else read();
			} finally {
				release();
			}
		});
	};

	return {
		load() {
			enqueue(async () => {
				const list = await deps.payloads();
				if (stopped) return;
				sync.setArtifacts(list.map(wire));
				revs = new Map(list.map((artifact) => [artifact.id, artifact.artifact_rev]));
				if (carried.length === 0) return;
				carried = [];
				if (holds.size === 0) pushStaged();
			});
		},

		onEvent(action, header) {
			if (action === 'deleted') {
				enqueue(async () => {
					sync.putArtifacts([], [header.id]);
					remember([], [header.id]);
				});
				return;
			}
			enqueue(async () => {
				if (!newer(header)) return;
				const got = await deps.payloads([header.id]);
				if (stopped || got.length === 0) return;
				sync.putArtifacts(got.map(wire), []);
				remember(got, []);
			});
		},

		onCommit({ idMap, changed, deletedIds }) {
			if (stopped) return;
			// A commit that moved no artifact changed nothing a staged entry stands for.
			if (changed.length === 0 && deletedIds.length === 0) {
				stagedChanged();
				return;
			}
			// The buffer's clear has not been read yet: `latest` is what the commit carried.
			const aliases = latest.flatMap((entry) => {
				const realId = entry.op === 'create' ? idMap[entry.id] : undefined;
				return realId === undefined ? [] : [{ ...entry, id: realId }];
			});
			const held = [...latest, ...aliases];
			holds.add(held);
			pushStaged();
			enqueue(async () => {
				let landed = false;
				try {
					const ids = changed.filter(newer).map((mark) => mark.id);
					const got = ids.length === 0 ? [] : await fetchNamed(ids);
					if (stopped) return;
					holds.delete(held);
					sync.putArtifacts(got.map(wire), deletedIds, overlay());
					remember(got, deletedIds);
					landed = true;
				} finally {
					if (!landed && !stopped) {
						holds.delete(held);
						carried = [...carried, ...held];
						if (holds.size === 0) pushStaged();
					}
				}
			});
		},

		stagedChanged,

		stop() {
			stopped = true;
		},

		settled() {
			if (running === 0 && !pushQueued) return Promise.resolve();
			return new Promise<void>((resolve) => idle.push(resolve));
		}
	};
}
