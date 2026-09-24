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
	/** The user's own commit landed; its staged buffer was cleared in the same run. */
	onCommit(info: { changed: ArtifactMark[]; deletedIds: string[] }): void;
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
 * Keeps the sync's artifact context the project's: its committed payloads
 * and the frontend's staged buffer. Fetches run one at a time in the order
 * asked, so a later answer never lands under an earlier one. A commit's
 * refresh holds the staged pushes: the engine reads the working copy the
 * commit came from until one `putArtifacts` brings its payloads with the
 * buffer as it is then. A failed fetch leaves the context as it was; the
 * next `load()` heals it.
 */
export function createArtifactFollower(deps: ArtifactFollowerDeps): ArtifactFollower {
	const { sync } = deps;
	let stopped = false;
	/** The rev of every committed artifact the engine was handed. */
	let revs = new Map<string, number>();
	let chain: Promise<void> = Promise.resolve();
	let running = 0;
	/** Commit refreshes asked and not yet landed. */
	let holding = 0;
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

	const pushStaged = () => {
		sync.setStagedArtifacts(deps.staged());
	};

	const stagedChanged = () => {
		if (stopped || pushQueued) return;
		pushQueued = true;
		// One microtask: a commit announced in the same run as its buffer's clear holds this.
		queueMicrotask(() => {
			pushQueued = false;
			try {
				if (!stopped && holding === 0) pushStaged();
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

		onCommit({ changed, deletedIds }) {
			if (stopped) return;
			// A commit that moved no artifact changed nothing a staged entry stands for.
			if (changed.length === 0 && deletedIds.length === 0) {
				stagedChanged();
				return;
			}
			holding += 1;
			enqueue(async () => {
				let landed = false;
				try {
					const ids = changed.filter(newer).map((mark) => mark.id);
					const got = ids.length === 0 ? [] : await fetchNamed(ids);
					if (stopped) return;
					sync.putArtifacts(got.map(wire), deletedIds, deps.staged());
					remember(got, deletedIds);
					landed = true;
				} finally {
					holding -= 1;
					// A buffer the failed refresh did not carry goes on its own.
					if (!landed && !stopped && holding === 0) pushStaged();
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
