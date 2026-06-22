import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SwapMetamodelDrawer from '../SwapMetamodelDrawer.svelte';

// Mock the API client so no network is needed.
vi.mock('$lib/api/metamodel', () => ({
	diffMetamodel: vi.fn(),
	rebindMetamodel: vi.fn()
}));
import { diffMetamodel } from '$lib/api/metamodel';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

function file(text: string, name = 'cand.metamodel.yaml'): File {
	return new File([text], name, { type: 'application/x-yaml' });
}

/** Wait up to ms for predicate to be truthy, polling every 10 ms. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function triggerFilePick(f: File): Promise<void> {
	const input = document.querySelector('input[type="file"]') as HTMLInputElement;
	if (!input) throw new Error('no file input found');
	// Simulate file pick: set .files via DataTransfer, then dispatch change.
	const dt = new DataTransfer();
	dt.items.add(f);
	Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

function bodyText(): string {
	return document.body.textContent ?? '';
}

describe('SwapMetamodelDrawer read path', () => {
	it('runs the diff on file pick and shows the counts headline', async () => {
		(diffMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			now_failing: [
				{ severity: 'error', message: 'a unknown type', target_ids: ['a'], category: 'conformance' }
			],
			now_passing: [],
			unchanged_count: 5,
			current_error_count: 5,
			candidate_error_count: 6
		});
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await triggerFilePick(file('elements: []\n'));
			await waitFor(() => /1 now failing/i.test(bodyText()));
			expect(diffMetamodel).toHaveBeenCalledWith('elements: []\n');
			expect(/0 now passing/i.test(bodyText())).toBe(true);
			expect(/5 unchanged/i.test(bodyText())).toBe(true);
		} finally {
			unmount(component);
		}
	});

	it('caps each issue section at 200 with an "and N more" footer', async () => {
		const many = Array.from({ length: 250 }, (_, i) => ({
			severity: 'error',
			message: `issue ${i}`,
			target_ids: [`e${i}`],
			category: 'conformance'
		}));
		(diffMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			now_failing: many,
			now_passing: [],
			unchanged_count: 0,
			current_error_count: 0,
			candidate_error_count: 250
		});
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await triggerFilePick(file('elements: []\n'));
			await waitFor(() => /and 50 more/i.test(bodyText()));
			expect(/and 50 more/i.test(bodyText())).toBe(true);
		} finally {
			unmount(component);
		}
	});

	it('surfaces a parse error when the diff call rejects', async () => {
		(diffMetamodel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bad yaml'));
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await triggerFilePick(file('nope'));
			await waitFor(() => /couldn.t read the candidate/i.test(bodyText()));
			expect(/couldn.t read the candidate/i.test(bodyText())).toBe(true);
		} finally {
			unmount(component);
		}
	});
});
