/**
 * The snippet editor's Ctrl+F panel.
 *
 * CodeMirror's stock search panel is browser-default `<input>`s, text buttons
 * ("next", "previous", "all", "replace", "replace all") and raw checkboxes;
 * `theme.ts` could only ever style the strip they sit in. This module owns
 * the panel's PRESENTATION and nothing else: every action delegates to
 * `@codemirror/search`'s own commands and state, so `Mod-f`, `F3`,
 * `Mod-Shift-l` and the rest keep working exactly as configured upstream.
 *
 * Plain DOM, not a mounted Svelte component. CodeMirror creates and destroys
 * the panel on its own schedule; a nested Svelte root inside it would buy
 * lifecycle problems for styling convenience. Icons are therefore inline SVG
 * (lucide's 24x24 stroke geometry) rather than `@lucide/svelte` components,
 * and the styling lives in `theme.ts` under `cm-dr-search*` class names — the
 * same `EditorView.theme` mechanism as the rest of the editor chrome, and not
 * subject to Tailwind's content-scanning heuristics for class strings
 * assembled inside a `.ts` file.
 */
import type { EditorState, Extension } from '@codemirror/state';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';
import {
	SearchQuery,
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	search,
	setSearchQuery
} from '@codemirror/search';

/** Stop counting matches past this many. A one-character query against a long
 * snippet would otherwise turn every keystroke into a full-document scan; the
 * counter is a comfort, not a report, so it degrades to "1/1000+". */
const MATCH_CAP = 1000;

interface Counted {
	total: number;
	/** 1-based position of the current match, or 0 when there are none. */
	index: number;
	capped: boolean;
}

function countMatches(state: EditorState, query: SearchQuery): Counted {
	if (!query.valid) return { total: 0, index: 0, capped: false };
	const sel = state.selection.main;
	const cursor = query.getCursor(state);
	let total = 0;
	let exact = 0;
	let upcoming = 0;
	for (let it = cursor.next(); !it.done; it = cursor.next()) {
		const m = it.value;
		total++;
		if (m.from === sel.from && m.to === sel.to) exact = total;
		else if (upcoming === 0 && m.from >= sel.from) upcoming = total;
		if (total >= MATCH_CAP) return { total, index: exact || upcoming, capped: true };
	}
	// No match at or after the cursor wraps to the first one — the same
	// wrap-around `findNext` performs, so the counter agrees with the button.
	const index = exact || upcoming || (total > 0 ? 1 : 0);
	return { total, index, capped: false };
}

function countLabel(c: Counted): string {
	if (c.total === 0) return 'no results';
	return c.capped ? `${c.index}/${MATCH_CAP}+` : `${c.index}/${c.total}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	attrs: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	return node;
}

/** Lucide-geometry inline SVG. `paths` are `d` attributes on a 24x24 grid. */
function icon(...paths: string[]): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '2');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of paths) {
		const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p.setAttribute('d', d);
		svg.append(p);
	}
	return svg;
}

const ICON_CHEVRON_RIGHT = 'm9 18 6-6-6-6';
const ICON_CHEVRON_DOWN = 'm6 9 6 6 6-6';
const ICON_UP = 'm18 15-6-6-6 6';
const ICON_DOWN = 'm6 9 6 6 6-6';
const ICON_X = 'M18 6 6 18M6 6l12 12';

function iconButton(testid: string, label: string, ...paths: string[]): HTMLButtonElement {
	const b = el('button', 'cm-dr-search-btn', {
		type: 'button',
		'data-testid': testid,
		'aria-label': label,
		title: label
	});
	b.append(icon(...paths));
	return b;
}

function chip(testid: string, text: string, label: string): HTMLButtonElement {
	const b = el('button', 'cm-dr-search-chip', {
		type: 'button',
		'data-testid': testid,
		'aria-label': label,
		'aria-pressed': 'false',
		title: label
	});
	b.textContent = text;
	return b;
}

class LuxurySearchPanel implements Panel {
	readonly dom: HTMLElement;
	readonly top = true;

	private readonly view: EditorView;
	private readonly field: HTMLInputElement;
	private readonly replaceField: HTMLInputElement;
	private readonly count: HTMLElement;
	private readonly replaceRow: HTMLElement;
	private readonly caseChip: HTMLButtonElement;
	private readonly regexpChip: HTMLButtonElement;
	private readonly wordChip: HTMLButtonElement;
	private readonly discloseBtn: HTMLButtonElement;
	private replaceOpen = false;

	constructor(view: EditorView) {
		this.view = view;
		this.dom = el('div', 'cm-dr-search', { 'data-testid': 'cm-search-panel', role: 'search' });

		const row = el('div', 'cm-dr-search-row');
		this.discloseBtn = iconButton('cm-search-toggle-replace', 'Show replace', ICON_CHEVRON_RIGHT);
		this.discloseBtn.addEventListener('click', () => this.toggleReplace());

		// `main-field` is CodeMirror's contract for "focus this on open" — the
		// SearchConfig.createPanel docs require it on the search input.
		this.field = el('input', 'cm-dr-search-field', {
			'data-testid': 'cm-search-field',
			'main-field': 'true',
			type: 'text',
			placeholder: 'Find',
			'aria-label': 'Find',
			spellcheck: 'false'
		});
		this.field.addEventListener('input', () => this.commit());
		this.field.addEventListener('keydown', (e) => this.onFieldKey(e));

		this.count = el('span', 'cm-dr-search-count', { 'data-testid': 'cm-search-count' });

		const prev = iconButton('cm-search-prev', 'Previous match', ICON_UP);
		prev.addEventListener('click', () => findPrevious(this.view));
		const next = iconButton('cm-search-next', 'Next match', ICON_DOWN);
		next.addEventListener('click', () => findNext(this.view));
		const close = iconButton('cm-search-close', 'Close search', ICON_X);
		close.addEventListener('click', () => closeSearchPanel(this.view));

		row.append(this.discloseBtn, this.field, this.count, prev, next, close);

		const chips = el('div', 'cm-dr-search-chips');
		this.caseChip = chip('cm-search-case', 'Aa', 'Match case');
		this.caseChip.addEventListener('click', () => this.toggleChip(this.caseChip));
		this.regexpChip = chip('cm-search-regexp', '.*', 'Regular expression');
		this.regexpChip.addEventListener('click', () => this.toggleChip(this.regexpChip));
		this.wordChip = chip('cm-search-word', 'ab|', 'Whole word');
		this.wordChip.addEventListener('click', () => this.toggleChip(this.wordChip));
		chips.append(this.caseChip, this.regexpChip, this.wordChip);

		this.replaceRow = el('div', 'cm-dr-search-row cm-dr-search-replace');
		this.replaceField = el('input', 'cm-dr-search-field', {
			'data-testid': 'cm-search-replace-field',
			type: 'text',
			placeholder: 'Replace with',
			'aria-label': 'Replace with',
			spellcheck: 'false'
		});
		this.replaceField.addEventListener('input', () => this.commit());
		this.replaceField.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				closeSearchPanel(this.view);
			}
		});
		const replaceOne = el('button', 'cm-dr-search-action', {
			type: 'button',
			'data-testid': 'cm-search-replace'
		});
		replaceOne.textContent = 'Replace';
		replaceOne.addEventListener('click', () => replaceNext(this.view));
		const replaceEvery = el('button', 'cm-dr-search-action', {
			type: 'button',
			'data-testid': 'cm-search-replace-all'
		});
		replaceEvery.textContent = 'All';
		replaceEvery.addEventListener('click', () => replaceAll(this.view));
		this.replaceRow.append(this.replaceField, replaceOne, replaceEvery);

		this.dom.append(row, chips);
		this.syncFromState(view.state);
	}

	mount(): void {
		this.field.focus();
		this.field.select();
	}

	update(update: ViewUpdate): void {
		// Doc/selection changes move the counter; a setSearchQuery effect means
		// something else (the `Mod-Shift-l`-style commands, or a selection-seeded
		// open) changed the query and the widgets must follow.
		const queryChanged = update.transactions.some((tr) =>
			tr.effects.some((e) => e.is(setSearchQuery))
		);
		if (update.docChanged || update.selectionSet || queryChanged) {
			this.syncFromState(update.state, queryChanged);
		}
	}

	/** Push the panel's widget values into a new `SearchQuery`. */
	private commit(): void {
		const query = new SearchQuery({
			search: this.field.value,
			caseSensitive: this.caseChip.getAttribute('aria-pressed') === 'true',
			regexp: this.regexpChip.getAttribute('aria-pressed') === 'true',
			wholeWord: this.wordChip.getAttribute('aria-pressed') === 'true',
			replace: this.replaceField.value
		});
		this.view.dispatch({ effects: setSearchQuery.of(query) });
	}

	private toggleChip(b: HTMLButtonElement): void {
		b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
		this.commit();
	}

	private toggleReplace(): void {
		this.replaceOpen = !this.replaceOpen;
		this.discloseBtn.replaceChildren(
			icon(this.replaceOpen ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT)
		);
		this.discloseBtn.setAttribute('aria-label', this.replaceOpen ? 'Hide replace' : 'Show replace');
		if (this.replaceOpen) this.dom.append(this.replaceRow);
		else this.replaceRow.remove();
	}

	private onFieldKey(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) findPrevious(this.view);
			else findNext(this.view);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			closeSearchPanel(this.view);
		}
	}

	/** Refresh the counter, and (when the query itself changed elsewhere) the
	 * widget values. `syncWidgets` is false on plain doc/selection updates so a
	 * sync never fights the user's in-progress typing. */
	private syncFromState(state: EditorState, syncWidgets = true): void {
		const query = getSearchQuery(state);
		if (syncWidgets) {
			if (this.field.value !== query.search) this.field.value = query.search;
			if (this.replaceField.value !== query.replace) this.replaceField.value = query.replace;
			this.caseChip.setAttribute('aria-pressed', String(query.caseSensitive));
			this.regexpChip.setAttribute('aria-pressed', String(query.regexp));
			this.wordChip.setAttribute('aria-pressed', String(query.wholeWord));
		}
		// An empty field is not an error; a non-empty invalid regexp is. `valid`
		// covers both, so the error state is gated on there being input at all.
		const invalid = query.search !== '' && !query.valid;
		this.field.setAttribute('aria-invalid', String(invalid));
		this.field.classList.toggle('cm-dr-search-invalid', invalid);
		this.count.textContent = invalid ? '—' : countLabel(countMatches(state, query));
	}
}

/** The search extension with the custom panel, anchored at the top of the
 * editor. Added AFTER `basicSetup`, which contributes only `searchKeymap` and
 * `highlightSelectionMatches` — never a `search()` configuration — so there is
 * no second panel and no precedence subtlety. */
export const luxurySearch: Extension = search({
	top: true,
	createPanel: (view) => new LuxurySearchPanel(view)
});
