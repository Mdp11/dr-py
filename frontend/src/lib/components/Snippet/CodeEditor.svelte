<script lang="ts">
	import { untrack } from 'svelte';
	import { basicSetup } from 'codemirror';
	import { EditorView, keymap, hoverTooltip, placeholder } from '@codemirror/view';
	import { Prec } from '@codemirror/state';
	import { expandTabs, hasTabs, INDENT_WIDTH } from '$lib/editor/indent';
	import { pythonIndentation } from '$lib/editor/indent-extension';
	import { python, pythonLanguage } from '@codemirror/lang-python';
	import { lintGutter, setDiagnostics } from '@codemirror/lint';
	import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
	import { toCmDiagnostics } from '$lib/editor/lint-map';
	import {
		computeCompletions,
		resolveDocAt,
		type VocabSummary
	} from '$lib/editor/completion-source';
	import { editorLuxuryTheme } from '$lib/editor/theme';
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

	/** Whether the CURRENT document still holds a tab character — drives the
	 * "Fix indentation" affordance. Derived from the `code` prop rather than the
	 * view so it is correct before the editor mounts and after an external
	 * replacement, and so it stays plain reactive state (the view is not). */
	const tabby = $derived(hasTabs(code));

	/** Expand every tab in the document to spaces in ONE undoable transaction.
	 * Offered as a button (not done silently on every keystroke) because it
	 * rewrites text the author did not just type — but paste, the way tabs
	 * actually get in here, IS normalized silently below. */
	function fixIndentation(): void {
		if (!view) return;
		const current = view.state.doc.toString();
		const fixed = expandTabs(current);
		if (fixed === current) return;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fixed } });
		view.focus();
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
	// autocompletion({override}) would suppress them — that was the old bug).
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
						Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (onRun(), true) }])),
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

<div class="relative h-full">
	<div bind:this={host} class="h-full overflow-auto text-sm" data-testid="snippet-editor"></div>
	<!-- Shown only while a tab character survives in the document: paste is
	     normalized on the way in, so this is the escape hatch for code that got
	     here another way (a loaded draft, a saved snippet from before this
	     rule). It disappears the moment there is nothing left to fix. -->
	{#if tabby}
		<button
			type="button"
			data-testid="snippet-fix-indent"
			class="absolute top-1 right-3 z-10 rounded border border-warning/40 bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning shadow-sm hover:bg-warning/25"
			title="This snippet mixes tab and space indentation, which Python rejects. Expand every tab to {INDENT_WIDTH} spaces."
			onclick={fixIndentation}
		>
			Fix indentation
		</button>
	{/if}
</div>
