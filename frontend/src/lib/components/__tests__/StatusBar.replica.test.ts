import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { OFF, type ReplicaStatus } from '$lib/engine/sync';
import StatusBar from '../StatusBar.svelte';

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getFilename: vi.fn(() => 'model.json'),
		getIssueCounts: vi.fn(() => null),
		getModelSummary: vi.fn(() => null),
		getTypeFilter: vi.fn(() => new Set<string>()),
		getFeedConnected: vi.fn(() => true),
		getPresence: vi.fn(() => []),
		getStagedChangeCount: vi.fn(() => 0),
		getLockNotice: vi.fn(() => null),
		getStaleResources: vi.fn(() => []),
		getReplicaStatus: vi.fn(() => OFF)
	};
});

import { getReplicaStatus } from '$lib/state';

let mounted: ReturnType<typeof mount> | null = null;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = null;
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

/** Mounts the bar over `status` (unmounting the one before) and returns its indicator. */
function render(status: Partial<ReplicaStatus>): HTMLElement | null {
	vi.mocked(getReplicaStatus).mockReturnValue({ ...OFF, ...status });
	if (mounted) unmount(mounted);
	mounted = mount(StatusBar, { target: document.body });
	flushSync();
	return document.querySelector<HTMLElement>('[data-testid="replica-indicator"]');
}

describe('the replica indicator', () => {
	it('shows nothing while off', () => {
		expect(render({})).toBeNull();
		expect(document.body.textContent).not.toContain('replica');
	});

	it('opening, with a known total', () => {
		const el = render({
			phase: 'opening',
			attempt: 1,
			progress: { task: 'download', done: 42, total: 100 }
		})!;
		expect(el.textContent?.trim()).toBe('replica 42 %');
		expect(el.dataset['phase']).toBe('opening');
		expect(el.title).toContain('attempt 1 of 3');
	});

	it('opening, total unknown or no progress yet', () => {
		expect(
			render({
				phase: 'opening',
				attempt: 1,
				progress: { task: 'download', done: 42, total: null }
			})!.textContent?.trim()
		).toBe('replica …');
		expect(render({ phase: 'resyncing', attempt: 2 })!.textContent?.trim()).toBe('replica …');
	});

	it('resyncing, with a known total', () => {
		const el = render({
			phase: 'resyncing',
			attempt: 2,
			rev: 12,
			progress: { task: 'parse', done: 1, total: 3 }
		})!;
		expect(el.textContent?.trim()).toBe('replica 33 %');
		expect(el.dataset['phase']).toBe('resyncing');
		expect(el.title).toContain('attempt 2 of 3');
	});

	it('ready: the rev, dim, and its attributes', () => {
		const el = render({ phase: 'ready', rev: 128, source: 'cache', isolated: true })!;
		expect(el.textContent?.trim()).toBe('replica r128');
		expect(el.dataset).toMatchObject({
			phase: 'ready',
			rev: '128',
			source: 'cache',
			isolated: 'true',
			cspViolations: '0'
		});
		expect(el.className).toContain('text-muted-foreground/50');
		expect(el.className).not.toContain('text-warning');
		expect(el.title).not.toContain('attempt');
		expect(el.title).not.toContain('isolated');
		expect(el.title).not.toContain('violation');
	});

	it('ready, but not isolated and with violations: the title says so', () => {
		const el = render({ phase: 'ready', rev: 3, isolated: false, cspViolations: 2 })!;
		expect(el.dataset).toMatchObject({ isolated: 'false', cspViolations: '2' });
		expect(el.title).toContain('not cross-origin isolated');
		expect(el.title).toContain('2 CSP violations');
	});

	it('before the handshake, isolation and source are absent', () => {
		const el = render({ phase: 'opening', attempt: 1 })!;
		expect(el.dataset['isolated']).toBeUndefined();
		expect(el.dataset['source']).toBeUndefined();
		expect(el.dataset['rev']).toBeUndefined();
	});

	it.each([
		['frozen', 'replica frozen', 'metamodel changed at rev 9'],
		['failed', 'replica failed', 'tail failed'],
		['server', 'server mode', 'open the app at http://127.0.0.1:5173']
	] as const)('%s: warned, the reason in the title', (phase, text, reason) => {
		const el = render({ phase, rev: 8, reason })!;
		expect(el.textContent?.trim()).toBe(text);
		expect(el.dataset['phase']).toBe(phase);
		expect(el.className).toContain('text-warning');
		expect(el.title).toContain(reason);
	});
});
