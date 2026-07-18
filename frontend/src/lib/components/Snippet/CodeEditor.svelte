<script lang="ts">
	import { untrack } from 'svelte';
	import { basicSetup } from 'codemirror';
	import { EditorView, keymap } from '@codemirror/view';
	import { python } from '@codemirror/lang-python';
	import { lintGutter, setDiagnostics } from '@codemirror/lint';
	import { toCmDiagnostics } from '$lib/editor/lint-map';
	import type { SnippetDiagnostic } from '$lib/api/types';

	let {
		code,
		diagnostics = [],
		onChange,
		onRun
	}: {
		code: string;
		diagnostics?: SnippetDiagnostic[];
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
						})
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
