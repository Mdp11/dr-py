// Render tests for the per-step editor of a `script`-kind navigation step
// (Task F6). Follows the repo's Svelte-5 mount/flushSync/unmount convention
// (see Table/__tests__/ScriptColumnEditor.test.ts) rather than
// @testing-library/svelte (not a project dependency). The step starts in
// ref mode (`snippet: {}`) so SnippetSourceEditor never needs the
// `/snippets/lint` MSW handler — this test is scoped to ScriptStepRow's own
// wiring (snippet patch + comment), not SnippetSourceEditor's internals
// (covered by its own suite).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NavScriptStep } from '$lib/api/types';
import ScriptStepRow from '../ScriptStepRow.svelte';

function scriptStep(overrides: Partial<NavScriptStep> = {}): NavScriptStep {
	return { kind: 'script', snippet: {}, comment: null, ...overrides };
}

function render(step: NavScriptStep, onChange: (index: number, next: NavScriptStep) => void) {
	const component = mount(ScriptStepRow, {
		target: document.body,
		props: { step, index: 0, onChange, onRemove: vi.fn() }
	});
	flushSync();
	return component;
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ScriptStepRow', () => {
	it('renders the row with the snippet source editor', () => {
		const c = render(scriptStep(), vi.fn());
		try {
			expect(document.querySelector('[data-testid="script-step"]')).not.toBeNull();
			expect(document.querySelector('[data-testid="snippet-source-editor"]')).not.toBeNull();
			expect(document.body.textContent).toContain('Script');
		} finally {
			unmount(c);
		}
	});

	it('wires the snippet editor onChange to a whole-step patch, preserving other fields', () => {
		const onChange = vi.fn();
		const original = scriptStep({ comment: 'existing note' });
		const c = render(original, onChange);
		try {
			click(document.querySelector('[data-testid="snippet-mode-inline"]'));
			expect(onChange).toHaveBeenCalledTimes(1);
			const [index, next] = onChange.mock.calls[0] as [number, NavScriptStep];
			expect(index).toBe(0);
			expect(next).not.toBe(original);
			expect(next.snippet.definition).toBeDefined();
			expect(next.comment).toBe(original.comment);
			// original is untouched
			expect(original.snippet).toEqual({});
		} finally {
			unmount(c);
		}
	});

	it('adding a note opens the comment input and commits on Enter', () => {
		const onChange = vi.fn();
		const original = scriptStep();
		const c = render(original, onChange);
		try {
			click(document.querySelector('[aria-label="Add step note"]'));
			const input = document.querySelector(
				'[data-testid="step-comment-input"]'
			) as HTMLInputElement;
			expect(input).not.toBeNull();
			input.value = 'why this step exists';
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			flushSync();
			expect(onChange).toHaveBeenCalledTimes(1);
			const [index, next] = onChange.mock.calls[0] as [number, NavScriptStep];
			expect(index).toBe(0);
			expect(next.comment).toBe('why this step exists');
			expect(next.snippet).toBe(original.snippet);
		} finally {
			unmount(c);
		}
	});

	it('shows an existing comment and lets it be edited, removing it when cleared', () => {
		const onChange = vi.fn();
		const original = scriptStep({ comment: 'old note' });
		const c = render(original, onChange);
		try {
			const display = document.querySelector('[data-testid="step-comment"]');
			expect(display?.textContent).toContain('old note');
			click(display);
			const input = document.querySelector(
				'[data-testid="step-comment-input"]'
			) as HTMLInputElement;
			expect(input.value).toBe('old note');
			input.value = '';
			input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
			flushSync();
			expect(onChange).toHaveBeenCalledTimes(1);
			const [, next] = onChange.mock.calls[0] as [number, NavScriptStep];
			expect(next.comment).toBeNull();
		} finally {
			unmount(c);
		}
	});
});
