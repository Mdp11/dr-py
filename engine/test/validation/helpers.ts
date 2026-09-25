import { expect } from 'vitest';
import {
	cmpCodePoint,
	compileRuleSets,
	drain,
	EMPTY_RULES,
	issueKey,
	issueOwner,
	LiveIssues,
	pyDumps,
	PyFloat,
	rulesStatusBody,
	storeListBody,
	type CompiledRules,
	type IssueListBody,
	type IssueOut,
	type IssueStore,
	type Metamodel,
	type Model,
	type Origin,
	type Value,
	type WorkingCopy
} from '../../src/index.ts';
import { clone, workingCopy } from '../working/helpers.ts';

const CYCLE = 'Containment cycle detected involving element ';

/**
 * A store as owner → issue keys, owners sorted, containment-cycle issues left
 * out: past its first link a chain's verdict is not dirtied by any rule.
 */
export function byOwner(store: IssueStore): [string, string[]][] {
	const out: [string, string[]][] = [];
	for (const owner of store.owners()) {
		const keys = store
			.issuesOf(owner)
			.filter((issue) => !issue.message.startsWith(CYCLE))
			.map(issueKey);
		if (keys.length > 0) out.push([owner, keys]);
	}
	return out.sort(([a], [b]) => cmpCodePoint(a, b));
}

/**
 * The store a sweep of the working state from scratch fills, under `rules`
 * both working and committed; it only reads the working copy.
 */
export function sweptFresh(wc: WorkingCopy, rules: CompiledRules = EMPTY_RULES): IssueStore {
	const live = new LiveIssues(wc, { rules: { working: rules, committed: rules } });
	drain(live.sweepSteps());
	return live.store;
}

/** An issue's identity when its origin is decided, as the bodies match it: its check aside. */
const originKey = (severity: string, message: string, targetIds: readonly string[]) =>
	JSON.stringify([severity, message, targetIds]);

export const wireKey = (i: IssueOut) => originKey(i.severity, i.message, i.target_ids);

const cyclic = (i: { message: string }) => i.message.startsWith(CYCLE);

/** The issues of a fresh sweep of `model` under `rules`, as a multiset of origin keys. */
function sweptKeys(model: Model, rules: CompiledRules): Map<string, number> {
	const keys = new Map<string, number>();
	for (const issue of sweptFresh(workingCopy(clone(model)), rules).iter()) {
		const key = originKey(issue.severity, issue.message, issue.targetIds);
		keys.set(key, (keys.get(key) ?? 0) + 1);
	}
	return keys;
}

/** Takes one of `key` from the multiset; false when none is left. */
function take(keys: Map<string, number>, key: string): boolean {
	const n = keys.get(key) ?? 0;
	if (n === 0) return false;
	keys.set(key, n - 1);
	return true;
}

/**
 * The staged branch of `POST /model/validate` worked out from two fresh
 * sweeps: the working state's issues under the working rules, each
 * `on_server` while an issue of `committed`, swept under the committed rules,
 * matches it, then the committed ones left `resolved`. As sorted lines of
 * check, key and origin, a resolved issue's check `?`; containment-cycle
 * issues left out, as `byOwner` leaves them.
 */
export function classified(live: LiveIssues, committed: Model): string[] {
	const left = sweptKeys(committed, live.rules.committed);
	const out: string[] = [];
	for (const issue of sweptFresh(live.wc, live.rules.working).iter()) {
		const key = originKey(issue.severity, issue.message, issue.targetIds);
		const origin = take(left, key) ? 'on_server' : 'uncommitted';
		if (!cyclic(issue)) out.push(`${issue.check} ${key} ${origin}`);
	}
	for (const [key, n] of left) {
		if (!JSON.parse(key)[1].startsWith(CYCLE))
			for (let k = 0; k < n; k++) out.push(`? ${key} resolved`);
	}
	return out.sort(cmpCodePoint);
}

/** `validateBody`'s answer in `classified`'s terms. */
export const answered = (body: readonly IssueOut[]) =>
	body
		.filter((i) => !cyclic(i))
		.map((i) => `${i.origin === 'resolved' ? '?' : i.check} ${wireKey(i)} ${i.origin}`)
		.sort(cmpCodePoint);

/** The origin of each listed issue, matched in list order against a fresh sweep of `committed` under `rules`. */
export function listedTags(body: IssueListBody, committed: Model, rules: CompiledRules): Origin[] {
	const left = sweptKeys(committed, rules);
	return body.issues.map((i) => (take(left, wireKey(i)) ? 'on_server' : 'uncommitted'));
}

/**
 * `GET /model/issues` as the probe tags it: an issue owned inside the probe's
 * dirty set `on_server` while a committed issue there matches it, every other
 * one `on_server`. Reads `origins()` only, so it leaves the tag scope alone.
 */
export function probedListBody(live: LiveIssues): IssueListBody {
	const { dirty, committed } = live.origins();
	const staged = new Set(dirty);
	const key = (i: {
		severity: string;
		message: string;
		targetIds: readonly string[];
		category: string;
	}) => JSON.stringify([i.severity, i.message, i.targetIds, i.category]);
	const left = new Map<string, number>();
	for (const issue of committed) left.set(key(issue), (left.get(key(issue)) ?? 0) + 1);
	return storeListBody(live.store, live.wc.rev, rulesStatusBody(live.rules.working), (i) =>
		!staged.has(issueOwner(i)) || take(left, key(i)) ? 'on_server' : 'uncommitted'
	);
}

/** A rule of a document: a JSON object, floats as `PyFloat`. */
export type RuleDoc = { [key: string]: Value };

/**
 * Rule sets `[id, name, rules]` compiled over `mm` in the order given, each
 * document written as the server writes it. Every rule must compile.
 */
export function compileSets(mm: Metamodel, ...sets: [string, string, RuleDoc[]][]): CompiledRules {
	const compiled = compileRuleSets(
		sets.map(([artifactId, name, rules]) => ({
			artifactId,
			name,
			parse: { ok: true, document: pyDumps({ rules }) }
		})),
		mm
	);
	expect(compiled.unreadable).toBe(false);
	expect(compiled.skipped).toEqual([]);
	return compiled;
}

const float = (value: number) => new PyFloat(value);

/**
 * Rules over the `ops_churn` metamodel whose atoms reach two hops: a named
 * `Part` seated on a `Slot` that `Feeds` a coded `Slot`; a `Slot` fed by a
 * held one; a `Part` owning a `Part` that owns at most one (`Seats` counts, as
 * a subtype of `Owns`); a `Slot` seated by a `Part` named `a` or `b`.
 */
export const CHURN_RULES = {
	seated: {
		name: 'seated',
		applies_to: 'Part',
		when: { property: 'name', exists: true },
		then: {
			relationship: {
				type: 'Seats',
				direction: 'outgoing',
				to: 'Slot',
				exists: true,
				where: {
					relationship: {
						type: 'Feeds',
						direction: 'outgoing',
						to: 'Slot',
						count: { gte: 1 },
						where: { property: 'code', gte: float(1) }
					}
				}
			}
		}
	},
	fed: {
		name: 'fed',
		applies_to: 'Slot',
		then: {
			relationship: {
				type: 'Feeds',
				direction: 'incoming',
				to: 'Slot',
				exists: true,
				where: { property: 'holder', exists: true }
			}
		}
	},
	/** `fed` changed: fed by a slot with a code, a warning. */
	fedLoose: {
		name: 'fed',
		applies_to: 'Slot',
		severity: 'warning',
		then: {
			relationship: {
				type: 'Feeds',
				direction: 'incoming',
				to: 'Slot',
				exists: true,
				where: { property: 'code', exists: true }
			}
		}
	},
	owns: {
		name: 'owns',
		applies_to: 'Part',
		then: {
			relationship: {
				type: 'Owns',
				direction: 'outgoing',
				to: 'Part',
				exists: true,
				where: { relationship: { type: 'Owns', direction: 'outgoing', count: { lte: 1 } } }
			}
		}
	},
	named: {
		name: 'named',
		applies_to: 'Slot',
		then: {
			relationship: {
				type: 'Owns',
				direction: 'incoming',
				to: 'Part',
				exists: true,
				where: { property: 'name', in: ['a', 'b'] }
			}
		}
	}
} satisfies { [name: string]: RuleDoc };

/**
 * Two rule sets over the `ops_churn` metamodel and the rules between them:
 * `a` holds `seated`, `fed` and `named`; `b` keeps `seated`, changes `fed`,
 * drops `named` and adds `owns`. `delta` compiles the rules only one of
 * them holds.
 */
export function churnRules(mm: Metamodel) {
	const { seated, fed, fedLoose, owns, named } = CHURN_RULES;
	return {
		a: compileSets(mm, ['rs-1', 'Churn', [seated, fed, named]]),
		b: compileSets(mm, ['rs-1', 'Churn', [seated, fedLoose, owns]]),
		delta: compileSets(mm, ['rs-a', 'A', [fed, named]], ['rs-b', 'B', [fedLoose, owns]])
	};
}
