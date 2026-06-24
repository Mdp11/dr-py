/**
 * History store for the commit-history browser (Phase 8). Holds the loaded
 * commit page(s), the paging cursor, and a rev->ModelOut reconstruction cache
 * so flipping between diffs does not refetch a rev already materialized.
 */
import { getCommitHistory, getModelAtRev } from '$lib/api/history';
import type { CommitSummary, ModelOut } from '$lib/api/types';

const PAGE = 50;

let _commits: CommitSummary[] = $state([]);
let _hasMore = $state(false);
let _loading = $state(false);
const _modelCache = new Map<number, ModelOut>();

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

/** Model at `rev`, cached. rev < 0 resolves to the empty model (for rev-1 of
 * the baseline commit). */
export async function modelAt(rev: number): Promise<ModelOut> {
	if (rev < 0) return { elements: [], relationships: [] };
	const hit = _modelCache.get(rev);
	if (hit) return hit;
	const m = await getModelAtRev(rev);
	_modelCache.set(rev, m);
	return m;
}

export function resetHistory(): void {
	_commits = [];
	_hasMore = false;
	_loading = false;
	_modelCache.clear();
}
