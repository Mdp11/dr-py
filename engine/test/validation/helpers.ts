import {
	cmpCodePoint,
	drain,
	issueKey,
	LiveIssues,
	type IssueStore,
	type WorkingCopy
} from '../../src/index.ts';

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

/** The store a sweep of the working state from scratch fills; it only reads the working copy. */
export function sweptFresh(wc: WorkingCopy): IssueStore {
	const live = new LiveIssues(wc);
	drain(live.sweepSteps());
	return live.store;
}
