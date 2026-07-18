<script lang="ts">
	import { untrack } from 'svelte';
	import { basicSetup } from 'codemirror';
	import { EditorView, keymap, hoverTooltip } from '@codemirror/view';
	import { python } from '@codemirror/lang-python';
	import { lintGutter, setDiagnostics } from '@codemirror/lint';
	import {
		autocompletion,
		type CompletionContext,
		type CompletionResult
	} from '@codemirror/autocomplete';
	import { toCmDiagnostics } from '$lib/editor/lint-map';
	import {
		computeCompletions,
		resolveDocAt,
		type VocabSummary
	} from '$lib/editor/completion-source';
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

	export function goToLine(line: number): void {
		if (!view || line < 1 || line > view.state.doc.lines) return;
		const pos = view.state.doc.line(line).from;
		view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
		view.focus();
	}

	// Adapters close over the live `docs`/`vocab` props, same pattern as
	// `onChange` — docs arriving after mount simply start returning results,
	// no reconfigure needed.
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
						lintGutter(),
						keymap.of([{ key: 'Mod-Enter', run: () => (onRun(), true) }]),
						EditorView.updateListener.of((u) => {
							if (u.docChanged) onChange(u.state.doc.toString());
						}),
						autocompletion({ override: [completionSource] }),
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

<div bind:this={host} class="h-full overflow-auto text-sm" data-testid="snippet-editor"></div>
