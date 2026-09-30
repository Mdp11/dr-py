/**
 * History store for the commit-history browser. Holds the loaded
 * commit page(s) and the paging cursor.
 */
import { getCommitHistory } from '$lib/api/history';
import type { CommitSummary } from '$lib/api/types';

const PAGE = 50;

let _commits: CommitSummary[] = $state([]);
let _hasMore = $state(false);
let _loading = $state(false);

export function getCommits(): CommitSummary[] {
	return _commits;
}
export function getHasMore(): boolean {
	return _hasMore;
}
export function getLoading(): boolean {
	return _loading;
}

export async function loadFirstPage(): Promise<void> {
	_loading = true;
	try {
		const res = await getCommitHistory({ limit: PAGE });
		_commits = res.commits;
		_hasMore = res.has_more;
	} finally {
		_loading = false;
	}
}

export async function loadMore(): Promise<void> {
	if (!_hasMore || _commits.length === 0) return;
	_loading = true;
	try {
		const cursor = _commits[_commits.length - 1].rev;
		const res = await getCommitHistory({ limit: PAGE, beforeRev: cursor });
		_commits = [..._commits, ...res.commits];
		_hasMore = res.has_more;
	} finally {
		_loading = false;
	}
}

export function resetHistory(): void {
	_commits = [];
	_hasMore = false;
	_loading = false;
}
