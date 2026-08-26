<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { basicSetup } from 'codemirror';
	import { EditorView, keymap, hoverTooltip, placeholder } from '@codemirror/view';
	import { Prec } from '@codemirror/state';
	import { expandTabs, hasTabs, INDENT_WIDTH } from '$lib/editor/indent';
	import { pythonIndentation } from '$lib/editor/indent-extension';
	import { python, pythonLanguage } from '@codemirror/lang-python';
	import { lintGutter, setDiagnostics } from '@codemirror/lint';
	import {
		acceptCompletion,
		type CompletionContext,
		type CompletionResult
	} from '@codemirror/autocomplete';
	import { toCmDiagnostics } from '$lib/editor/lint-map';
	import {
		computeCompletions,
		resolveDocAt,
		type VocabSummary
	} from '$lib/editor/completion-source';
	import { editorLuxuryTheme } from '$lib/editor/theme';
	import { luxurySearch } from '$lib/editor/search-panel';
	import { lineStartOffset } from '$lib/editor/format';
	import { formatSnippet } from '$lib/api/snippets';
	import { ApiError } from '$lib/api/errors';
	import type { SnippetDiagnostic, SnippetDocsOut } from '$lib/api/types';

	let {
		code,
		diagnostics = [],
		docs = null,
		vocab = null,
		onChange,
		onRun
	}: {
		code: string;
		diagnostics?: SnippetDiagnostic[];
		docs?: SnippetDocsOut | null;
		vocab?: VocabSummary | null;
		onChange: (code: string) => void;
		onRun: () => void;
	} = $props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;

	/** Whether the CURRENT document still holds a tab character. Derived from the
	 * `code` prop rather than the view so it is correct before the editor mounts
	 * and after an external replacement, and so it stays plain reactive state
	 * (the view is not). Drives the Reformat control's warning tint: a tab is
	 * what CPython's tokenizer rejects outright with `TabError`. */
	const tabby = $derived(hasTabs(code));

	let formatting = $state(false);
	let formatError = $state<string | null>(null);
	/** Latched on a 503: the deployment has no `ruff`, so every further attempt
	 * would fail the same way. Latching disables the control instead of letting
	 * the user pump a dead endpoint. */
	let formatUnavailable = $state(false);
	let errorTimer: ReturnType<typeof setTimeout> | null = null;

	function flashError(message: string): void {
		formatError = message;
		if (errorTimer) clearTimeout(errorTimer);
		errorTimer = setTimeout(() => (formatError = null), 6000);
	}

	onDestroy(() => {
		if (errorTimer) clearTimeout(errorTimer);
	});

	/** Replace the whole document in ONE transaction, keeping the cursor on the
	 * same line number (clamped). One transaction, not two, so a reformat is a
	 * single undo step — hence computing the new offset from the incoming text
	 * (`lineStartOffset`) instead of reading it back off the new state. */
	function replaceDoc(next: string): void {
		if (!view) return;
		const current = view.state.doc.toString();
		if (next === current) return;
		const line = view.state.doc.lineAt(view.state.selection.main.head).number;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: next },
			selection: { anchor: Math.min(lineStartOffset(next, line), next.length) },
			scrollIntoView: true
		});
		view.focus();
	}

	/**
	 * Reformat the snippet: expand tabs locally, then let `ruff format` on the
	 * server do the real work.
	 *
	 * Tabs are expanded BEFORE the request because tab-indented Python is a
	 * `TabError` at parse time — ruff would refuse exactly the documents that
	 * most need formatting. And the expansion is applied even when the server
	 * refuses: that is the old "Fix indentation" button's job, which this
	 * control absorbed, and it must keep working when the snippet does not parse
	 * or the formatter is absent.
	 */
	async function reformat(): Promise<void> {
		if (!view || formatting || formatUnavailable) return;
		const before = view.state.doc.toString();
		const expanded = expandTabs(before);
		formatting = true;
		formatError = null;
		try {
			const out = await formatSnippet(expanded);
			if (out.changed || expanded !== before) replaceDoc(out.code);
		} catch (e) {
			if (e instanceof ApiError && e.status === 503) {
				formatUnavailable = true;
				flashError('Formatter unavailable on this server');
			} else {
				flashError(`Can't format: ${e instanceof Error ? e.message : 'unknown error'}`);
			}
			if (expanded !== before) replaceDoc(expanded);
		} finally {
			formatting = false;
		}
	}

	export function goToLine(line: number): void {
		if (!view || line < 1 || line > view.state.doc.lines) return;
		const pos = view.state.doc.line(line).from;
		view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
		view.focus();
	}

	// Adapters close over the live `docs`/`vocab` props, same pattern as
	// `onChange` — docs arriving after mount simply start returning results,
	// no reconfigure needed. Registered as a Python language-data source so it
	// COEXISTS with lang-python's keyword/local-variable sources (an
	// autocompletion({override}) would suppress them).
	function completionSource(ctx: CompletionContext): CompletionResult | null {
		const line = ctx.state.doc.lineAt(ctx.pos);
		const before = line.text.slice(0, ctx.pos - line.from);
		const spec = computeCompletions(before, docs ?? null, vocab ?? null, ctx.explicit);
		if (!spec) return null;
		return { from: line.from + spec.from, options: spec.options, validFor: /^\w*$/ };
	}

	const docHover = hoverTooltip((view, pos) => {
		const line = view.state.doc.lineAt(pos);
		const entry = resolveDocAt(line.text, pos - line.from, docs ?? null);
		if (!entry) return null;
		return {
			pos,
			create: () => {
				const dom = document.createElement('div');
				dom.className = 'p-2 text-xs max-w-xs';
				const sig = document.createElement('code');
				sig.textContent = entry.signature;
				const doc = document.createElement('div');
				doc.textContent = entry.doc;
				dom.append(sig, doc);
				return { dom };
			}
		};
	});

	// Ghost-text guidance shown only while the document is empty (never part of
	// the content — see snippet-editor.svelte.ts DEFAULT_CODE). A DOM factory
	// because the string form collapses newlines.
	function placeholderDom(): HTMLElement {
		const el = document.createElement('div');
		el.textContent =
			'Explore the model through the dr facade, e.g.:\n' +
			'for el in dr.elements():\n' +
			'    print(el.stereotype, el.name)';
		el.style.whiteSpace = 'pre';
		return el;
	}

	// Creation must NOT reactively track `code`/handlers — tracking them would
	// destroy and recreate the editor on every keystroke. The listeners call
	// the CURRENT props (props stay live bindings), so untrack is safe.
	$effect(() => {
		view = untrack(
			() =>
				new EditorView({
					parent: host,
					doc: code,
					extensions: [
						basicSetup,
						python(),
						editorLuxuryTheme,
						// Custom Ctrl+F panel. basicSetup contributes only searchKeymap +
						// highlightSelectionMatches, so this is the ONLY search() config in
						// the editor — no duplicate panel.
						luxurySearch,
						placeholder(placeholderDom),
						lintGutter(),
						// Four-space levels, Tab/Shift-Tab, and paste tab-expansion —
						// see indent-extension.ts for why each of those is spelled out.
						pythonIndentation,
						// Prec.highest is required, not decorative: basicSetup bundles
						// @codemirror/commands' defaultKeymap, which ALSO claims Mod-Enter
						// (for insertBlankLine). CodeMirror's keymap facet tries earlier-
						// registered groups first, and basicSetup sits ABOVE this keymap
						// in the extensions array below — so without an explicit
						// precedence bump, array order alone hands Mod-Enter to
						// insertBlankLine and this binding never fires. Do not "simplify"
						// this back to a plain keymap.of.
						Prec.highest(
							keymap.of([
								{ key: 'Mod-Enter', run: () => (onRun(), true) },
								// VS Code's format shortcut, in the same Prec.highest group as
								// Mod-Enter so basicSetup's defaultKeymap cannot claim it first.
								{ key: 'Shift-Alt-f', run: () => (void reformat(), true) },
								// Tab accepts the open completion. `acceptCompletion` returns
								// false when no list is open, so the key then falls through to
								// `pythonIndentation`'s own Tab binding below and indents.
								{ key: 'Tab', run: acceptCompletion }
							])
						),
						EditorView.updateListener.of((u) => {
							if (u.docChanged) onChange(u.state.doc.toString());
						}),
						pythonLanguage.data.of({ autocomplete: completionSource }),
						docHover
					]
				})
		);
		return () => view?.destroy();
	});

	// External code replacement (draft load/reload) — not user typing.
	$effect(() => {
		if (view && code !== view.state.doc.toString()) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
		}
	});

	$effect(() => {
		if (view)
			view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, diagnostics)));
	});
</script>

<div class="group relative h-full">
	<div bind:this={host} class="h-full overflow-auto text-sm" data-testid="snippet-editor"></div>
	<!-- Editor-corner controls. Muted until the editor is hovered or focused so
	     they never compete with the code. The Reformat control carries a warning
	     tint while a tab character survives in the document, because that is the
	     state CPython rejects outright with TabError — it absorbed the old
	     "Fix indentation" button, which did only the tab half of this job. -->
	<div
		class="pointer-events-none absolute top-1 right-3 z-10 flex items-center gap-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
	>
		{#if formatError}
			<span
				data-testid="snippet-format-error"
				class="pointer-events-auto max-w-[22rem] truncate rounded border border-destructive/40 bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive"
			>
				{formatError}
			</span>
		{/if}
		<button
			type="button"
			data-testid="snippet-format"
			class="pointer-events-auto rounded border px-1.5 py-0.5 text-[10px] shadow-sm transition-colors disabled:opacity-40 {tabby
				? 'border-warning/40 bg-warning/15 text-warning hover:bg-warning/25'
				: 'border-input bg-card/80 text-muted-foreground hover:bg-muted hover:text-foreground'}"
			title={tabby
				? `This snippet mixes tab and space indentation, which Python rejects. Reformat expands every tab to ${INDENT_WIDTH} spaces and reformats the rest (Shift+Alt+F).`
				: 'Reformat this snippet (Shift+Alt+F)'}
			disabled={formatting || formatUnavailable}
			onclick={() => void reformat()}
		>
			{formatting ? 'Formatting…' : 'Reformat'}
		</button>
	</div>
</div>
