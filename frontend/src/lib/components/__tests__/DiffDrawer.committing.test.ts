import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import DiffDrawer from '../DiffDrawer.svelte';

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getStagedDiff: vi.fn(() => ({
			elements: [
				{
					id: 'e1',
					type_name: 'Node',
					status: 'added',
					before: null,
					after: { id: 'e1', type_name: 'Node', properties: {}, rev: 1 }
				}
			],
			relationships: [],
			counts: { added: 1, modified: 0, deleted: 0 }
		})),
		previewStaged: vi.fn(async () => ({
			conformance_error_count: 0,
			structural_blockers: [],
			issues: [],
			would_block: false
		})),
		commitStaged: vi.fn(),
		commitApplied: vi.fn(() => null),
		discardAll: vi.fn(async () => {}),
		discardElement: vi.fn(async () => {}),
		ensureElement: vi.fn(async () => {}),
		getEffectiveIssues: vi.fn(() => []),
		indexIssues: vi.fn(() => ({ byEntity: new Map(), all: [] })),
		getView: vi.fn(() => null),
		getViewFileHandle: vi.fn(() => null),
		getViewFilename: vi.fn(() => null),
		setViewFileHandle: vi.fn(),
		setViewFilename: vi.fn(),
		getStagedViewEntries: vi.fn(() => []),
		getStagedViewDepth: vi.fn(() => 0),
		discardViewChanges: vi.fn(async () => {})
	};
});

import { commitApplied, commitStaged } from '$lib/state';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

const tick = () => new Promise((r) => setTimeout(r, 20));

const content = () => document.querySelector('[data-slot="dialog-content"]');
const closeButton = () => document.querySelector('[data-slot="dialog-close"]');
const commitButton = () =>
	Array.from(document.querySelectorAll('button')).find((b) =>
		/^Commit/.test(b.textContent?.trim() ?? '')
	) as HTMLButtonElement | undefined;

function pressEscape(): void {
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function clickOutside(): void {
	const outside = document.querySelector('[data-slot="dialog-overlay"]') ?? document.body;
	for (const type of ['pointerdown', 'pointerup']) {
		outside.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				button: 0,
				clientX: 500,
				clientY: 500
			})
		);
	}
	outside.dispatchEvent(
		new MouseEvent('click', {
			bubbles: true,
			cancelable: true,
			button: 0,
			clientX: 500,
			clientY: 500
		})
	);
}

/** Opens the drawer, waits for its preview and clicks Commit, whose POST `release` lets go. */
async function commitHeld(result: 'resolve' | 'reject'): Promise<{
	component: ReturnType<typeof mount>;
	release(): Promise<void>;
}> {
	let settle!: () => void;
	vi.mocked(commitStaged).mockImplementation(
		() =>
			new Promise((resolve, reject) => {
				settle = () => (result === 'resolve' ? resolve({} as never) : reject(new Error('boom')));
			})
	);
	const component = mount(DiffDrawer, { target: document.body, props: { open: true } });
	flushSync();
	await waitFor(() => commitButton()?.disabled === false);
	commitButton()!.click();
	flushSync();
	await waitFor(() => /Committing/.test(commitButton()?.textContent ?? ''));
	return {
		component,
		async release() {
			settle();
			await tick();
			flushSync();
		}
	};
}

describe('DiffDrawer while committing', () => {
	it('cannot be dismissed while the commit is in flight, and closes when it lands', async () => {
		const { component, release } = await commitHeld('resolve');

		expect(closeButton()).toBeNull();
		pressEscape();
		await tick();
		flushSync();
		expect(content()).not.toBeNull();
		clickOutside();
		await tick();
		flushSync();
		expect(content()).not.toBeNull();

		await release();
		await waitFor(() => content() === null);
		unmount(component);
	});

	it('stays up and undismissable until the replica has applied the landed commit', async () => {
		let applied!: () => void;
		vi.mocked(commitApplied).mockReturnValueOnce(
			new Promise<void>((resolve) => (applied = resolve))
		);
		const { component, release } = await commitHeld('resolve');

		// The POST has answered; the replica has not applied it yet.
		await release();
		expect(content()).not.toBeNull();
		expect(commitApplied).toHaveBeenCalledOnce();
		expect(commitButton()?.textContent).toMatch(/Committing/);
		expect(commitButton()?.disabled).toBe(true);
		expect(closeButton()).toBeNull();
		pressEscape();
		await tick();
		flushSync();
		expect(content()).not.toBeNull();
		clickOutside();
		await tick();
		flushSync();
		expect(content()).not.toBeNull();

		applied();
		await waitFor(() => content() === null);
		unmount(component);
	});

	it('can be dismissed again once a refused commit has settled', async () => {
		const { component, release } = await commitHeld('reject');
		pressEscape();
		await tick();
		flushSync();
		expect(content()).not.toBeNull();

		await release();
		expect(content()).not.toBeNull();
		expect(commitApplied).not.toHaveBeenCalled();
		expect(document.body.textContent).toMatch(/boom/);
		expect(closeButton()).not.toBeNull();
		pressEscape();
		await waitFor(() => content() === null);
		unmount(component);
	});
});
