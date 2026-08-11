<script lang="ts">
	import { untrack } from 'svelte';
	import { basicSetup } from 'codemirror';
	import { EditorView } from '@codemirror/view';
	import { Compartment, EditorState } from '@codemirror/state';
	import { yaml } from '@codemirror/lang-yaml';
	import { lintGutter, setDiagnostics } from '@codemirror/lint';
	import { toCmDiagnostics } from '$lib/editor/lint-map';
	import { editorLuxuryTheme } from '$lib/editor/theme';
	import { luxurySearch } from '$lib/editor/search-panel';
	import type { MetamodelLintError } from '$lib/api/types';

	let {
		code,
		errors = [],
		readOnly = false,
		onChange
	}: {
		code: string;
		errors?: MetamodelLintError[];
		readOnly?: boolean;
		onChange: (code: string) => void;
	} = $props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;
	const readOnlyCompartment = new Compartment();

	function readOnlyExt(ro: boolean) {
		return [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];
	}

	$effect(() => {
		view = untrack(
			() =>
				new EditorView({
					parent: host,
					doc: code,
					extensions: [
						basicSetup,
						yaml(),
						editorLuxuryTheme,
						luxurySearch,
						lintGutter(),
						readOnlyCompartment.of(readOnlyExt(readOnly)),
						EditorView.updateListener.of((u) => {
							if (u.docChanged) onChange(u.state.doc.toString());
						})
					]
				})
		);
		return () => view?.destroy();
	});

	// External replacement (baseline load / draft restore / discard) — never
	// user typing, which flows through the updateListener above.
	$effect(() => {
		if (view && code !== view.state.doc.toString()) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
		}
	});

	$effect(() => {
		if (view) view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExt(readOnly)) });
	});

	// Positioned errors → gutter diagnostics; null-line errors are the host's
	// job (message strip) — they have no anchor in the document.
	$effect(() => {
		if (!view) return;
		const positioned = errors
			.filter((e) => e.line !== null)
			.map((e) => ({
				line: e.line as number,
				col: Math.max(0, (e.column ?? 1) - 1),
				severity: 'error' as const,
				message: e.message
			}));
		view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, positioned)));
	});
</script>

<div bind:this={host} class="h-full overflow-auto text-sm" data-testid="metamodel-editor"></div>
