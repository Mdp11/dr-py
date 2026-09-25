import { RULE_CHECK_PREFIX, type CompiledRules, type RuleSkip } from '../rules/compile.ts';
import { issueOwner, wireIssue, type Issue, type IssueOut, type Origin } from './issue.ts';
import type { LiveIssues } from './live.ts';
import type { IssueStore } from './store.ts';

/** The most issues `GET /model/issues` sends; `counts` stays exact past it. */
export const ISSUES_RESPONSE_MAX = 5000;

/** `GET /model/issues`'s `rules_status`, in its field order. */
export type RulesStatusBody = {
	total: number;
	skipped: RuleSkip[];
	eval_errors: { [check: string]: number };
};

/** `GET /model/issues`'s body, in its field order. */
export type IssueListBody = {
	model_rev: number;
	issues: IssueOut[];
	counts: { [severity: string]: number };
	truncated: boolean;
	rules_status: RulesStatusBody;
};

/** A compile's `rules_status`: how many rules it holds, what it left out, what failed to evaluate. */
export function rulesStatusBody(compiled: CompiledRules): RulesStatusBody {
	return {
		total: compiled.total,
		skipped: compiled.skipped.map(({ artifact_id, set_name, rule, reason }) => ({
			artifact_id,
			set_name,
			rule,
			reason
		})),
		eval_errors: Object.fromEntries(compiled.evalErrors)
	};
}

const ON_SERVER = (): Origin => 'on_server';

/** The store as `GET /model/issues` answers it: its first issues in store order, every origin `tagOf`'s. */
export function storeListBody(
	store: IssueStore,
	rev: number,
	rulesStatus: RulesStatusBody,
	tagOf: (i: Issue) => Origin = ON_SERVER
): IssueListBody {
	const issues: IssueOut[] = [];
	for (const issue of store.iter()) {
		if (issues.length === ISSUES_RESPONSE_MAX) break;
		issues.push(wireIssue(issue, tagOf(issue)));
	}
	return {
		model_rev: rev,
		issues,
		counts: store.counts(),
		truncated: store.size > ISSUES_RESPONSE_MAX,
		rules_status: rulesStatus
	};
}

/** `POST /commits/preview`'s body, in its field order. */
export type PreviewBody = {
	conformance_error_count: number;
	structural_blockers: IssueOut[];
	issues: IssueOut[];
	would_block: boolean;
};

/** An issue's identity when working and committed issues are matched: `check` aside. */
const originKey = (i: Issue) => JSON.stringify([i.severity, i.message, i.targetIds, i.category]);

/** The committed issues as a multiset, each working issue that matches one taking it. */
class Committed {
	private readonly left = new Map<string, number>();

	constructor(issues: readonly Issue[]) {
		for (const issue of issues) {
			const key = originKey(issue);
			this.left.set(key, (this.left.get(key) ?? 0) + 1);
		}
	}

	/** Takes one committed issue matching `i`; false when none is left. */
	take(i: Issue): boolean {
		const key = originKey(i);
		const n = this.left.get(key) ?? 0;
		if (n === 0) return false;
		this.left.set(key, n - 1);
		return true;
	}
}

/**
 * `GET /model/issues` over the working state: the store's issues, each of an
 * owner the staged changes may have moved (`tagScope()`) `on_server` while a
 * committed one matches it and `uncommitted` past that, every other one
 * `on_server`. A committed issue the staged changes fixed is not listed.
 * `rules_status` is the working rules'.
 */
export function issueListBody(live: LiveIssues): IssueListBody {
	const scope = live.tagScope();
	const matches = new Committed([...scope.values()].flat());
	return storeListBody(live.store, live.wc.rev, rulesStatusBody(live.rules.working), (i) =>
		!scope.has(issueOwner(i)) || matches.take(i) ? 'on_server' : 'uncommitted'
	);
}

/**
 * The staged branch of `POST /model/validate`: the store's issues of the
 * owners the staged changes leave alone, then theirs, fresh, tagged against
 * the committed ones, then the committed ones left unmatched as `resolved`.
 */
export function validateBody(live: LiveIssues): IssueOut[] {
	const { dirty, working, committed } = live.origins();
	const staged = new Set(dirty);
	const out: IssueOut[] = [];
	for (const issue of live.store.iter()) {
		if (!staged.has(issueOwner(issue))) out.push(wireIssue(issue, 'on_server'));
	}
	const matches = new Committed(committed);
	for (const issue of working) {
		out.push(wireIssue(issue, matches.take(issue) ? 'on_server' : 'uncommitted'));
	}
	for (const issue of committed) if (matches.take(issue)) out.push(wireIssue(issue, 'resolved'));
	return out;
}

/**
 * The model half of `POST /commits/preview`: the staged ops' dirty set,
 * widened by the committed rules' reach, validated on the working state with
 * the committed rules, every issue `on_server`. `would_block` is strict mode
 * and a conformance issue the ops can be held to: owned by an entity they
 * touch, or any rule's.
 */
export function previewBody(live: LiveIssues, strict: boolean): PreviewBody {
	const { hooks, preview } = live.origins();
	const touched = new Set(hooks);
	const body: PreviewBody = {
		conformance_error_count: 0,
		structural_blockers: [],
		issues: [],
		would_block: false
	};
	let attributable = false;
	for (const issue of preview) {
		body.issues.push(wireIssue(issue, 'on_server'));
		if (issue.category === 'structural') {
			body.structural_blockers.push(wireIssue(issue, 'on_server'));
		} else {
			body.conformance_error_count++;
			attributable ||= touched.has(issueOwner(issue)) || issue.check.startsWith(RULE_CHECK_PREFIX);
		}
	}
	body.would_block = strict && attributable;
	return body;
}
