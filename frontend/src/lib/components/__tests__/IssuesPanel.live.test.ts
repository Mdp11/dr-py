import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import IssuesPanel from '../Workspace/IssuesPanel.svelte';
import { clearOverlay, setOverlay } from '$lib/state/validation.svelte';
import { adoptIssues, adoptSummary, resetModelStore } from '$lib/state/model.svelte';
import type { Issue } from '$lib/api/types';

vi.mock('$lib/state/validate-action', () => ({
	runValidation: vi.fn(async () => {})
}));

afterEach(() => {
	document.body.innerHTML = '';
	clearOverlay();
	resetModelStore();
	vi.clearAllMocks();
});

function boot(rev = 1): void {
	adoptSummary({
		model_rev: rev,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: {},
		undo_depth: 0
	});
}

function issue(message: string, owner: string): Issue {
	return { severity: 'error', message, target_ids: [owner], check: '', origin: 'on_server' };
}

describe('IssuesPanel live mode', () => {
	it('renders live issues with no origin filter row and no "Not validated yet"', () => {
		boot();
		adoptIssues([issue('live boom', 'e1')], { error: 1 }, 1);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();
		const text = document.body.textContent ?? '';
		expect(text).toContain('live boom');
		expect(text).not.toContain('Not validated yet');
		expect(text).not.toContain('On server'); // origin filter row hidden in live mode
		unmount(c);
	});

	it('renders "No issues" (not the not-validated empty state) when the live map is clean', () => {
		boot();
		adoptIssues([], {}, 1);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();
		expect(document.body.textContent).toContain('No issues');
		expect(document.body.textContent).not.toContain('Not validated yet');
		unmount(c);
	});

	it('shows the truncation notice when the server capped the list', () => {
		boot();
		adoptIssues([issue('a', 'e1'), issue('b', 'e2')], { error: 5001 }, 1, true);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();
		// The numerator is the LIVE list we actually hold (2), not the exact
		// total — pinned literally so a wrong numerator cannot pass.
		expect(document.body.textContent).toMatch(/showing first 2 of 5001 issues/i);
		unmount(c);
	});

	it('an EMPTY overlay stays in overlay mode — [] is an overlay, only null is live', () => {
		boot();
		adoptIssues([issue('live boom', 'e1')], { error: 1 }, 1);
		setOverlay([]); // a Validate run that found nothing
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();
		const text = document.body.textContent ?? '';
		expect(text).not.toContain('live boom'); // must NOT fall through to live
		expect(text).toContain('No issues (validated'); // the overlay's own empty state
		expect(text).toContain('last run'); // overlay header
		unmount(c);
	});

	it('an overlay brings back the origin UI, and clearing it returns to live', () => {
		boot();
		adoptIssues([issue('live boom', 'e1')], { error: 1 }, 1);
		setOverlay([
			{
				severity: 'error',
				message: 'staged boom',
				target_ids: ['e2'],
				check: '',
				origin: 'uncommitted'
			}
		]);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();
		expect(document.body.textContent).toContain('staged boom');
		expect(document.body.textContent).toContain('last run'); // overlay header
		clearOverlay();
		flushSync();
		expect(document.body.textContent).toContain('live boom');
		expect(document.body.textContent).not.toContain('last run');
		unmount(c);
	});
});
