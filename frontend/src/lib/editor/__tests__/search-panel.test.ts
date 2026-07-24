// The custom Ctrl+F panel. Mounted against a REAL EditorView in happy-dom —
// the same approach Snippet/__tests__/code-editor.test.ts uses to exercise
// CodeMirror for real rather than through a facet lookup.
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { afterEach, describe, expect, it } from 'vitest';

import { luxurySearch } from '../search-panel';

const DOC = ['a = 1', 'b = 2', 'a = 3', 'A = 4'].join('\n');

let view: EditorView | undefined;

function open(doc = DOC): EditorView {
	view = new EditorView({
		parent: document.body,
		state: EditorState.create({ doc, extensions: [luxurySearch] })
	});
	openSearchPanel(view);
	return view;
}

function q(sel: string): HTMLElement {
	const el = document.querySelector(sel) as HTMLElement;
	if (!el) throw new Error(`missing ${sel}`);
	return el;
}

function input(): HTMLInputElement {
	return q('[data-testid="cm-search-field"]') as HTMLInputElement;
}

function type(value: string): void {
	const el = input();
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

function click(sel: string): void {
	q(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function count(): string | null {
	return q('[data-testid="cm-search-count"]').textContent;
}

afterEach(() => {
	view?.destroy();
	view = undefined;
	document.body.innerHTML = '';
});

describe('luxurySearch panel', () => {
	it('opens with the custom chrome instead of CodeMirror default buttons', () => {
		open();
		expect(q('[data-testid="cm-search-panel"]')).toBeTruthy();
		expect(document.querySelector('button[name="next"]')).toBeNull();
		// CodeMirror focuses the field tagged main-field on open.
		expect(input().getAttribute('main-field')).toBe('true');
	});

	it('reports a match count that advances with the next button', () => {
		const v = open();
		type('a');
		// case-insensitive by default: 'a = 1', 'a = 3', 'A = 4'
		expect(count()).toBe('1/3');
		// The cursor starts at offset 0, so the FIRST next selects match 1 — the
		// counter agreeing with findNext here (rather than jumping to 2) is the
		// contract: it reports where the selection is, not how many times the
		// button was pressed.
		click('[data-testid="cm-search-next"]');
		expect(count()).toBe('1/3');
		expect(v.state.selection.main.empty).toBe(false);
		click('[data-testid="cm-search-next"]');
		expect(count()).toBe('2/3');
		click('[data-testid="cm-search-next"]');
		expect(count()).toBe('3/3');
		// and wraps
		click('[data-testid="cm-search-next"]');
		expect(count()).toBe('1/3');
	});

	it('the previous button walks backwards', () => {
		open();
		type('a');
		click('[data-testid="cm-search-next"]');
		click('[data-testid="cm-search-next"]');
		expect(count()).toBe('2/3');
		click('[data-testid="cm-search-prev"]');
		expect(count()).toBe('1/3');
	});

	it('says so when there are no matches', () => {
		open();
		type('zzz');
		expect(count()).toBe('no results');
	});

	it('the match-case chip narrows the query', () => {
		open();
		type('a');
		click('[data-testid="cm-search-case"]');
		expect(count()).toBe('1/2');
		expect(q('[data-testid="cm-search-case"]').getAttribute('aria-pressed')).toBe('true');
	});

	it('flags an invalid regexp instead of throwing', () => {
		open();
		click('[data-testid="cm-search-regexp"]');
		type('a(');
		expect(count()).toBe('—');
		expect(input().getAttribute('aria-invalid')).toBe('true');
	});

	it('discloses the replace row only on request, and replaces', () => {
		const v = open();
		expect(document.querySelector('[data-testid="cm-search-replace-field"]')).toBeNull();
		click('[data-testid="cm-search-toggle-replace"]');
		type('b');
		const rep = q('[data-testid="cm-search-replace-field"]') as HTMLInputElement;
		rep.value = 'Z';
		rep.dispatchEvent(new Event('input', { bubbles: true }));
		click('[data-testid="cm-search-replace-all"]');
		expect(v.state.doc.toString()).toContain('Z = 2');
	});

	it('Enter finds the next match and Escape closes the panel', () => {
		const v = open();
		type('a');
		input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(count()).toBe('2/3');
		input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(searchPanelOpen(v.state)).toBe(false);
	});
});
