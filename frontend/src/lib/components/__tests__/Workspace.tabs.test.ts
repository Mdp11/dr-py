// Render tests for the dynamic-only Workspace tab strip: the empty
// placeholder when no tab is open, and the Issues tab opening as a closable
// dynamic tab. Follows the repo's established Svelte-5 render convention
// (mount/unmount/flushSync — see `ArtifactExportButton.test.ts`); `@testing-
// library/svelte` is not a project dependency.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Workspace from '../Workspace.svelte';
import { openIssuesTab, resetWorkspaceTabs } from '$lib/state';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetWorkspaceTabs();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	resetWorkspaceTabs();
	host.remove();
});

describe('Workspace tab strip', () => {
	it('renders the empty placeholder when no tab is open', () => {
		app = mount(Workspace, { target: host });
		flushSync();
		expect(host.querySelector('[data-testid="workspace-empty"]')).not.toBeNull();
		const tabLabels = Array.from(host.querySelectorAll('[role="tab"]')).map((t) =>
			t.textContent?.trim()
		);
		expect(tabLabels).not.toContain('Detail');
		expect(tabLabels).not.toContain('Graph');
	});

	it('opens Issues as a closable tab rendering the panel', () => {
		app = mount(Workspace, { target: host });
		openIssuesTab();
		flushSync();
		const issuesTab = Array.from(host.querySelectorAll('[role="tab"]')).find((t) =>
			/Issues/.test(t.textContent ?? '')
		);
		expect(issuesTab).not.toBeUndefined();
		expect(host.querySelector('[aria-label="Close Issues"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="workspace-empty"]')).toBeNull();
	});
});
