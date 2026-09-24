import { wireIssue, type Issue, type IssueOut, type Origin } from './issue.ts';
import type { IssueStore } from './store.ts';

/** The most issues `GET /model/issues` sends; `counts` stays exact past it. */
export const ISSUES_RESPONSE_MAX = 5000;

/** `GET /model/issues`'s body, in its field order. */
export type IssueListBody = {
	model_rev: number;
	issues: IssueOut[];
	counts: { [severity: string]: number };
	truncated: boolean;
	rules_status: { total: number; skipped: never[]; eval_errors: { [rule: string]: number } };
};

const ON_SERVER = (): Origin => 'on_server';

/** The store as `GET /model/issues` answers it: its first issues in store order, every origin `tagOf`'s. */
export function storeListBody(
	store: IssueStore,
	rev: number,
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
		rules_status: { total: 0, skipped: [], eval_errors: {} }
	};
}
