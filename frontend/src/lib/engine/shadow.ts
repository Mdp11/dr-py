import { ApiError } from '$lib/api/errors';
import type { EngineSeam, Outcome, Surface } from '$lib/api/engine-route';
import { EngineGoneError } from './client';

const STORAGE_KEY = 'dr.shadow';
const SHORT_MAX = 300;
const MAX_ROUNDS = 3;
/** `summary` carries these off the engine as `null` / `0`; the store keeps the server's own. */
const SUMMARY_OMIT = new Set(['issue_counts', 'undo_depth']);

/** Dev-only, and only when the user turned it on: never present in a build. */
export function shadowEnabled(storage?: Pick<Storage, 'getItem'>): boolean {
	if (!import.meta.env.DEV) return false;
	try {
		return (storage ?? globalThis.localStorage).getItem(STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

export type ShadowDeps = {
	/** The replica's current `rev`, or `null` while it has none. */
	rev(): number | null;
	/** Resolves once nothing that could still change what a read sees is in flight. */
	quiet(): Promise<void>;
	/** Whether the user has edits staged in the replica: its answers then differ from the server's by them. */
	staged(): boolean;
	report(line: string): void;
};

/**
 * Builds the seam's `shadow`: runs the server's own answer beside the
 * engine's, and reports a difference that a re-test — after `quiet()`, with
 * the replica's `rev` held still — still shows. A `rev` that moves during a
 * re-test is retried, up to three rounds, then given up on silently: a
 * replica that never rests is not a mismatch. Nothing is compared while an
 * edit is staged in the replica — the server has not seen it — and a
 * comparison under way ends silently once one is; unless the probe says the
 * call sent the staged edits to the server too (`whileStaged`), when a 409 on
 * either side ends it instead: the staged edits or the `rev` moved since the
 * call. An `AbortError` from either side, or an `EngineGoneError` from the
 * engine side (the worker died, or a `stop()` while a re-test was
 * mid-flight), ends the comparison without a report — a comparison the
 * caller can no longer see through is not a mismatch either.
 */
export function createShadow(deps: ShadowDeps): NonNullable<EngineSeam['shadow']> {
	return async function shadow(probe): Promise<void> {
		const { surface, method, params, engine, again, server } = probe;
		const whileStaged = probe.whileStaged === true;
		const staged = () => !whileStaged && deps.staged();
		const moved = (...outcomes: Outcome[]) => whileStaged && outcomes.some(isConflict);
		if (isTerminal(engine) || staged() || moved(engine)) return;

		let serverOutcome: Outcome;
		try {
			serverOutcome = await outcomeOf(server);
		} catch {
			return;
		}
		if (moved(serverOutcome) || same(surface, engine, serverOutcome)) return;

		for (let round = 0; round < MAX_ROUNDS; round++) {
			await deps.quiet();
			if (staged()) return;
			const before = deps.rev();
			let retested: [Outcome, Outcome];
			try {
				retested = await Promise.all([outcomeOf(again), outcomeOf(server)]);
			} catch {
				return;
			}
			const [retestedEngine, retestedServer] = retested;
			if (staged() || moved(retestedEngine, retestedServer)) return;
			if (before !== deps.rev()) continue;
			if (same(surface, retestedEngine, retestedServer)) return;
			deps.report(reportLine(surface, method, params, retestedEngine, retestedServer));
			return;
		}
	};
}

async function outcomeOf(call: () => Promise<unknown>): Promise<Outcome> {
	try {
		return { ok: true, value: await call() };
	} catch (error) {
		if (isTerminalError(error)) throw error;
		return { ok: false, error };
	}
}

function isTerminal(outcome: Outcome): boolean {
	return !outcome.ok && isTerminalError(outcome.error);
}

function isConflict(outcome: Outcome): boolean {
	return !outcome.ok && outcome.error instanceof ApiError && outcome.error.status === 409;
}

/** An `AbortError` (either side) or an `EngineGoneError` (only ever the
 * engine side: `again()`, or the `engine` outcome the probe was handed). */
function isTerminalError(error: unknown): boolean {
	if (error instanceof EngineGoneError) return true;
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'AbortError'
	);
}

/** Deep equality of the parsed values (key order ignored, array order not), or the same
 * kind of failure: the same `status` for two `ApiError`s, else the same error name. */
function same(surface: Surface, a: Outcome, b: Outcome): boolean {
	if (a.ok && b.ok) return deepEqual(present(surface, a.value), present(surface, b.value));
	if (!a.ok && !b.ok) return sameError(a.error, b.error);
	return false;
}

/**
 * `summary` compares without `issue_counts` and `undo_depth`. `issues`
 * compares its lists as multisets: an issue list, a bare list, and a
 * preview's `structural_blockers` and `issues`. A body `truncated` at the
 * cap compares without its `issues`: each side keeps its own subset.
 */
function present(surface: Surface, value: unknown): unknown {
	if (surface === 'issues') {
		if (Array.isArray(value)) return byIssueKey(value);
		if (!isRecord(value)) return value;
		const truncated = value['truncated'] === true;
		const lists = Object.entries(value)
			.filter(([key]) => !(truncated && key === 'issues'))
			.map(([key, item]) =>
				ISSUE_LISTS.has(key) && Array.isArray(item) ? [key, byIssueKey(item)] : [key, item]
			);
		return Object.fromEntries(lists);
	}
	if (surface !== 'summary' || !isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => !SUMMARY_OMIT.has(key)));
}

const ISSUE_LISTS = new Set(['issues', 'structural_blockers']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `issues` in one order whatever order they came in. */
function byIssueKey(issues: readonly unknown[]): unknown[] {
	const keyed = issues.map((issue) => ({ issue, key: issueKey(issue) }));
	keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return keyed.map(({ issue }) => issue);
}

function issueKey(issue: unknown): string {
	if (!isRecord(issue)) return JSON.stringify(issue) ?? '';
	const { severity, category, check, message, target_ids, origin } = issue;
	return JSON.stringify([severity, category, check, message, target_ids, origin]);
}

function sameError(a: unknown, b: unknown): boolean {
	if (a instanceof ApiError && b instanceof ApiError) return a.status === b.status;
	const nameOf = (error: unknown) =>
		typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
	return nameOf(a) === nameOf(b);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, i) => deepEqual(item, b[i]))
		);
	}
	if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
		const av = a as Record<string, unknown>;
		const bv = b as Record<string, unknown>;
		const keys = Object.keys(av);
		return (
			keys.length === Object.keys(bv).length &&
			keys.every((key) => Object.hasOwn(bv, key) && deepEqual(av[key], bv[key]))
		);
	}
	return false;
}

function reportLine(
	surface: Surface,
	method: string,
	params: unknown,
	engine: Outcome,
	server: Outcome
): string {
	return `[shadow] ${surface} ${method} ${jsonText(params)}: engine ${describe(engine)} ≠ server ${describe(server)}`;
}

function describe(outcome: Outcome): string {
	return short(outcome.ok ? jsonText(outcome.value) : describeError(outcome.error));
}

function describeError(error: unknown): string {
	if (error instanceof ApiError) return `${error.name} ${error.status}: ${error.message}`;
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

function jsonText(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function short(text: string): string {
	return text.length > SHORT_MAX ? text.slice(0, SHORT_MAX) : text;
}
