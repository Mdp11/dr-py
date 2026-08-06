import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import StatusBar from '../StatusBar.svelte';

// Mock $lib/state — spread actual so everything else (notably the real
// staged-artifact store, which this suite drives directly) stays live, and
// override only the model-side reads StatusBar needs to mount.
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getFilename: vi.fn(() => 'model.json'),
		getIssueCounts: vi.fn(() => null),
		getModelSummary: vi.fn(() => ({
			model_rev: 1,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: null,
			undo_depth: 0
		})),
		getTypeFilter: vi.fn(() => new Set<string>()),
		getFeedConnected: vi.fn(() => false),
		getPresence: vi.fn(() => []),
		getStagedChangeCount: vi.fn(() => 0),
		getLockNotice: vi.fn(() => null),
		getStaleResources: vi.fn(() => [])
	};
});

import { getStagedChangeCount } from '$lib/state';
import { resetArtifactEdits, stageArtifactCreate } from '$lib/state/artifact-edits.svelte';

afterEach(() => {
	document.body.innerHTML = '';
	resetArtifactEdits();
	vi.clearAllMocks();
});

describe('StatusBar uncommitted counter', () => {
	it('counts staged artifact ops alongside staged model changes', () => {
		vi.mocked(getStagedChangeCount).mockReturnValue(2);
		// Two distinct entries: the buffer keys by artifact id (one entry per
		// artifact), and each create mints its own temp id.
		stageArtifactCreate('table', 'T', {}, null);
		stageArtifactCreate('code_snippet', 'S', {}, null);

		const c = mount(StatusBar, { target: document.body });
		flushSync();

		expect(document.body.textContent).toContain('4 uncommitted');

		unmount(c);
	});

	it('reports an artifact-only batch rather than zero', () => {
		vi.mocked(getStagedChangeCount).mockReturnValue(0);
		stageArtifactCreate('navigation', 'N', {}, null);

		const c = mount(StatusBar, { target: document.body });
		flushSync();

		expect(document.body.textContent).toContain('1 uncommitted');

		unmount(c);
	});
});
