import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/api/history', () => ({
	getCommitHistory: vi.fn()
}));
import { getCommitHistory } from '$lib/api/history';
import { loadFirstPage, loadMore, getCommits, getHasMore, resetHistory } from '../history.svelte';

function summary(rev: number) {
	return {
		rev,
		commit_id: `c${rev}`,
		author_id: null,
		ts: '2026-01-01T00:00:00Z',
		message: `m${rev}`,
		validation_error_count: 0,
		op_count: 1,
		is_rebind: false
	};
}

beforeEach(() => {
	resetHistory();
	vi.clearAllMocks();
});

describe('history store', () => {
	it('loadFirstPage populates commits + has_more', async () => {
		vi.mocked(getCommitHistory).mockResolvedValue({
			commits: [summary(3), summary(2)],
			has_more: true
		});
		await loadFirstPage();
		expect(getCommits().map((c) => c.rev)).toEqual([3, 2]);
		expect(getHasMore()).toBe(true);
	});

	it('loadMore appends using before_rev cursor of the last row', async () => {
		vi.mocked(getCommitHistory)
			.mockResolvedValueOnce({ commits: [summary(3), summary(2)], has_more: true })
			.mockResolvedValueOnce({ commits: [summary(1)], has_more: false });
		await loadFirstPage();
		await loadMore();
		expect(getCommits().map((c) => c.rev)).toEqual([3, 2, 1]);
		expect(getHasMore()).toBe(false);
		expect(vi.mocked(getCommitHistory).mock.calls[1][0]).toMatchObject({ beforeRev: 2 });
	});
});
