import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import HistoryDrawer from '../HistoryDrawer.svelte';

vi.mock('$lib/state/history.svelte', () => ({
	loadFirstPage: vi.fn(async () => {}),
	loadMore: vi.fn(async () => {}),
	getCommits: vi.fn(() => [
		{ rev: 2, commit_id: 'c2', author_id: 'u', ts: '2026-01-01T00:00:00Z',
		  message: 'second', validation_error_count: 0, op_count: 1, is_rebind: false },
		{ rev: 1, commit_id: 'c1', author_id: 'u', ts: '2026-01-01T00:00:00Z',
		  message: 'first', validation_error_count: 2, op_count: 3, is_rebind: true }
	]),
	getHasMore: vi.fn(() => false),
	getLoading: vi.fn(() => false),
	modelAt: vi.fn(),
	resetHistory: vi.fn()
}));
vi.mock('$lib/state/realtime.svelte', () => ({ onCommitEvent: vi.fn(() => () => {}) }));
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return { ...actual, getRole: vi.fn(() => 'owner'), getModelRev: vi.fn(() => 2),
		getStagedDepth: vi.fn(() => 0), getLockState: vi.fn(() => new Map()) };
});

import { loadFirstPage } from '$lib/state/history.svelte';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('HistoryDrawer list', () => {
	it('loads + lists commits with rebind/issue badges when open', async () => {
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(loadFirstPage).toHaveBeenCalled();
		expect(document.body.textContent).toContain('second');
		expect(document.body.textContent).toContain('first');
		expect(document.body.textContent?.toLowerCase()).toContain('rebind');
		unmount(c);
	});
});
