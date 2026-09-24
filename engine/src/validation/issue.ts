export type Severity = 'error' | 'warning';

/** `structural` is model-graph corruption, which fails a commit; `conformance` never does. */
export type Category = 'structural' | 'conformance';

/**
 * One validation finding. `targetIds[0]` is the entity it is attributed to;
 * `check` names the validator that produced it.
 */
export type Issue = {
	severity: Severity;
	message: string;
	targetIds: readonly string[];
	category: Category;
	check: string;
};

/** How an issue relates to the committed model. */
export type Origin = 'on_server' | 'uncommitted' | 'resolved';

/** An issue as the server's routes send it, in their field order. */
export type IssueOut = {
	severity: Severity;
	message: string;
	target_ids: string[];
	category: Category;
	check: string;
	origin: Origin;
};

/** A built-in validator's issue: always an error; the pipeline stamps `check`. */
export function errorIssue(
	message: string,
	targetIds: readonly string[],
	category: Category = 'conformance'
): Issue {
	return { severity: 'error', message, targetIds, category, check: '' };
}

/** The entity an issue is attributed to: its first target. Every validator names one. */
export function issueOwner(i: Issue): string {
	return i.targetIds[0] ?? '';
}

/** Equal keys are the same issue when issues are compared as multisets. */
export function issueKey(i: Issue): string {
	return JSON.stringify([i.severity, i.category, i.check, i.message, i.targetIds]);
}

export function wireIssue(i: Issue, origin: Origin): IssueOut {
	return {
		severity: i.severity,
		message: i.message,
		target_ids: [...i.targetIds],
		category: i.category,
		check: i.check,
		origin
	};
}
