import type { WireArtifact, WireStagedArtifact } from '$engine';
import type { ArtifactHeader, ArtifactPayload } from '$lib/api/types';
import { engineParse, RULES_KIND, type RulesParser } from './rules-parse';
import type { ReplicaSync } from './sync';

export type ArtifactFollowerDeps = {
	sync: Pick<ReplicaSync, 'setArtifacts' | 'putArtifacts' | 'setStagedArtifacts'>;
	/** Every artifact of the project with its payload, or the named ids it still has. */
	payloads(ids?: readonly string[]): Promise<ArtifactPayload[]>;
	/** The staged buffer as plain copies, in staging order. */
	staged(): WireStagedArtifact[];
	/** Parses the staged rule sets' YAML; one per follower. */
	parser: RulesParser;
	/** Waited out before a failed load's one retry; absent, the retry goes at once. */
	pause?(): Promise<void>;
	/** Called once, when the first load has landed and `loaded()` turned true. */
	onLoaded?(): void;
};

/** What a feed event or a commit says of one artifact. */
export type ArtifactMark = Pick<ArtifactHeader, 'id' | 'artifact_rev'>;

export type ArtifactFollower = {
	/**
	 * Every committed artifact again: at the start, and after a feed reconnect.
	 * A failed fetch is asked once more, after `pause()`; the retry's own failure is final.
	 */
	load(): void;
	/** Whether a load has landed since the follower was made, and it is not stopped. */
	loaded(): boolean;
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
	/** The kind of the committed artifact `id`, as the engine was last handed it. */
	kindOf(id: string): string | undefined;
	/**
	 * Whether the engine's staged overlay holds entries the buffer does not:
	 * a commit's, while its refresh is out, or a failed refresh's, until
	 * newer committed news of what they stand for.
	 */
	hasOverlay(): boolean;
	/** Every answer that comes after it is dropped, and nothing more is asked. */
	stop(): void;
	/** Resolves once no fetch or rules parse is out and no staged push waits. */
	settled(): Promise<void>;
};

/** Past this many ids, one fetch of everything costs less than a long query. */
const NAMED_MAX = 100;

/** A rule set whose item carries no parse the engine can read goes without one, which it refuses. */
function wire({ id, kind, name, artifact_rev, payload, rules }: ArtifactPayload): WireArtifact {
	const parse = rules === undefined || rules === null ? null : engineParse(rules);
	return { id, kind, name, artifact_rev, payload, ...(parse === null ? {} : { rules: parse }) };
}

/** A staged entry a commit carried, and the committed id it stands for: a create's real one. */
type Held = { entry: WireStagedArtifact; stands: string };

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
 * asked, so a later answer never lands under an earlier one. Every staged
 * push carries the rule sets' parses through `deps.parser`, `'pending'`
 * while one is out, and goes again when it lands.
 *
 * A commit's refresh holds the staged pushes. At once, the staged overlay
 * becomes the entries the commit carried, each created one ALSO under its
 * real id, with the buffer over them: until one `putArtifacts` brings the
 * payloads with the buffer as it is then, the engine reads the working copy
 * the commit came from under either id. A rule set the commit created or
 * updated is not held: it goes into the committed layer at once, as the
 * commit made it, so the engine's committed rules are the server's from the
 * commit on; one whose parse is still out is left out until the refresh
 * brings it. A failed refresh keeps its entries
 * in the overlay, each only until a fetch brings newer committed news of the
 * artifact it stands for, and asks one `load()` at once. A failed load asks
 * once more after `pause()`; any other failed fetch leaves the context as it
 * was until the next `load()`.
 */
export function createArtifactFollower(deps: ArtifactFollowerDeps): ArtifactFollower {
	const { sync } = deps;
	let stopped = false;
	let loadedOnce = false;
	/** The rev of every committed artifact the engine was handed. */
	let revs = new Map<string, number>();
	/** The kind of every committed artifact the engine was handed. */
	let kinds = new Map<string, string>();
	/** Every committed rule set as the engine was handed it. */
	let ruleSets = new Map<string, WireArtifact>();
	let chain: Promise<void> = Promise.resolve();
	let running = 0;
	/** The buffer as last read: at a commit, the entries it carried. */
	let latest: WireStagedArtifact[] = [];
	/** Per commit refresh not yet landed, the entries it lays under the buffer. */
	const holds = new Set<Held[]>();
	/** The entries of refreshes that failed, laid under the buffer until newer committed news. */
	let carried: Held[] = [];
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

	const fetchNamed = async (ids: readonly string[]): Promise<ArtifactPayload[]> => {
		if (ids.length <= NAMED_MAX) return deps.payloads(ids);
		const wanted = new Set(ids);
		return (await deps.payloads()).filter((artifact) => wanted.has(artifact.id));
	};

	const remember = (changed: readonly WireArtifact[], deletedIds: readonly string[]) => {
		for (const artifact of changed) {
			revs.set(artifact.id, artifact.artifact_rev);
			kinds.set(artifact.id, artifact.kind);
			if (artifact.kind === RULES_KIND) ruleSets.set(artifact.id, artifact);
			else ruleSets.delete(artifact.id);
		}
		for (const id of deletedIds) {
			revs.delete(id);
			kinds.delete(id);
			ruleSets.delete(id);
		}
	};

	const kindOf = (id: string): string | undefined => kinds.get(id);

	/**
	 * The committed rule set a commit made of `entry` (its parse attached) under
	 * `id` at `rev`: `'pending'` while its parse is out, or when the commit
	 * names no rev for it; `undefined` for an entry that is no rule set's
	 * create or update.
	 */
	const committedAs = (
		entry: WireStagedArtifact,
		id: string,
		rev: number | undefined
	): WireArtifact | 'pending' | undefined => {
		if (entry.op === 'delete') return undefined;
		const base =
			entry.op === 'create'
				? entry.kind === RULES_KIND
					? { id, kind: entry.kind, name: entry.name, payload: entry.payload }
					: undefined
				: ruleSets.get(id);
		if (base === undefined) return undefined;
		if (rev === undefined || entry.rules === 'pending') return 'pending';
		return {
			...base,
			...(entry.name === undefined ? {} : { name: entry.name }),
			...(entry.payload === undefined ? {} : { payload: entry.payload }),
			...(entry.rules === undefined ? {} : { rules: entry.rules }),
			artifact_rev: rev
		};
	};

	const read = (): WireStagedArtifact[] => {
		latest = deps.staged();
		return latest;
	};

	/**
	 * What the engine's staged overlay should be: the buffer over every held or
	 * carried entry, each rule set with its parse.
	 */
	const overlay = (): WireStagedArtifact[] => {
		const buffer = read();
		if (holds.size === 0 && carried.length === 0) return deps.parser.attach(buffer, kindOf);
		const base = [...carried, ...[...holds].flat()].map((held) => held.entry);
		return deps.parser.attach(compose(base, buffer), kindOf);
	};

	/**
	 * Committed news of `ids` came: the carried entries standing for them go.
	 * Whether any went, so the call bringing the news also carries the overlay.
	 */
	const drop = (ids: Iterable<string>): boolean => {
		if (carried.length === 0) return false;
		const brought = new Set(ids);
		const kept = carried.filter((held) => !brought.has(held.stands));
		const dropped = kept.length !== carried.length;
		carried = kept;
		return dropped;
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

	/** Whether a staged update names a rule set by an id whose kind moved from `before`. */
	const rulesKindMoved = (before: ReadonlyMap<string, string>): boolean =>
		read().some(
			(entry) =>
				entry.op === 'update' &&
				(before.get(entry.id) === RULES_KIND) !== (kinds.get(entry.id) === RULES_KIND)
		);

	const offParsed = deps.parser.onParsed(stagedChanged);

	const load = () => {
		enqueue(async () => {
			let list: ArtifactPayload[];
			try {
				list = await deps.payloads();
			} catch {
				// One retry, in the same queue slot, so later answers still land after it.
				await deps.pause?.();
				if (stopped) return;
				list = await deps.payloads();
			}
			if (stopped) return;
			const wired = list.map(wire);
			sync.setArtifacts(wired);
			const first = !loadedOnce;
			loadedOnce = true;
			revs = new Map(wired.map((artifact) => [artifact.id, artifact.artifact_rev]));
			const before = kinds;
			kinds = new Map(wired.map((artifact) => [artifact.id, artifact.kind]));
			ruleSets = new Map(
				wired.filter((artifact) => artifact.kind === RULES_KIND).map((a) => [a.id, a])
			);
			// A staged update pushed before its kind was known went without its parse.
			if (carried.length > 0 || (holds.size === 0 && rulesKindMoved(before))) {
				carried = [];
				pushStaged();
			}
			if (first) deps.onLoaded?.();
		});
	};

	return {
		load,

		onEvent(action, header) {
			if (action === 'deleted') {
				enqueue(async () => {
					if (drop([header.id])) sync.putArtifacts([], [header.id], overlay());
					else sync.putArtifacts([], [header.id]);
					remember([], [header.id]);
				});
				return;
			}
			enqueue(async () => {
				if (!newer(header)) return;
				const got = await deps.payloads([header.id]);
				if (stopped) return;
				// Answered without it: gone since, and a `deleted` event follows.
				const corrected = drop([header.id]);
				if (got.length === 0) {
					if (corrected) pushStaged();
					return;
				}
				const before = new Map(kinds);
				const wired = got.map(wire);
				remember(wired, []);
				if (corrected || (holds.size === 0 && rulesKindMoved(before))) {
					sync.putArtifacts(wired, [], overlay());
				} else {
					sync.putArtifacts(wired, []);
				}
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
			const parsed = deps.parser.attach(latest, kindOf);
			const revOf = new Map(changed.map((mark) => [mark.id, mark.artifact_rev]));
			const held: Held[] = [];
			const aliases: Held[] = [];
			const ruleSetsMade: WireArtifact[] = [];
			latest.forEach((entry, at) => {
				const realId = entry.op === 'create' ? idMap[entry.id] : undefined;
				const id = realId ?? entry.id;
				const ruleSet = committedAs(parsed[at]!, id, revOf.get(id));
				if (ruleSet === 'pending') return;
				if (ruleSet !== undefined) {
					ruleSetsMade.push(ruleSet);
				} else if (realId === undefined) {
					held.push({ entry, stands: entry.id });
				} else {
					held.push({ entry, stands: realId });
					aliases.push({ entry: { ...entry, id: realId }, stands: realId });
				}
			});
			held.push(...aliases);
			holds.add(held);
			for (const ruleSet of ruleSetsMade) {
				kinds.set(ruleSet.id, ruleSet.kind);
				ruleSets.set(ruleSet.id, ruleSet);
			}
			// Its rev stays the server's: the refresh still brings the server's copy.
			if (ruleSetsMade.length === 0) pushStaged();
			else sync.putArtifacts(ruleSetsMade, [], overlay());
			enqueue(async () => {
				let landed = false;
				try {
					const ids = changed.filter(newer).map((mark) => mark.id);
					const got = ids.length === 0 ? [] : await fetchNamed(ids);
					if (stopped) return;
					holds.delete(held);
					drop([...changed.map((mark) => mark.id), ...deletedIds]);
					const wired = got.map(wire);
					// Before the overlay: an update staged over a created rule set needs its kind.
					remember(wired, deletedIds);
					sync.putArtifacts(wired, deletedIds, overlay());
					landed = true;
				} finally {
					if (!landed && !stopped) {
						holds.delete(held);
						carried = [...carried, ...held];
						if (holds.size === 0) pushStaged();
						// One reload at once, not a loop: a reconnect's `snapshot` event reloads too.
						load();
					}
				}
			});
		},

		stagedChanged,

		kindOf,

		hasOverlay() {
			return holds.size > 0 || carried.length > 0;
		},

		loaded() {
			return loadedOnce && !stopped;
		},

		stop() {
			stopped = true;
			offParsed();
		},

		async settled() {
			// A landed parse queues a push, and a push may ask a parse again.
			while (running > 0 || pushQueued || deps.parser.busy()) {
				if (deps.parser.busy()) await deps.parser.settled();
				else await new Promise<void>((resolve) => idle.push(resolve));
			}
		}
	};
}
