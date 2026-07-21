<script lang="ts">
	// The embedded Test panel: bind elements, run the snippet, read the result
	// — inside the table-script-column / navigation-script-step editor where
	// the code is actually written. Without it, an embedded snippet can only
	// be judged by the error cell or pruned chain it eventually produces.
	//
	// Run state is COMPONENT-LOCAL ($state + a runSeq generation guard bumped
	// in onDestroy), exactly like SnippetSourceEditor's debounced lint and
	// deliberately NOT the tab-keyed store in state/snippet-editor.svelte.ts:
	// several script columns / steps can be open at once, and a nav script
	// step has no stable key (its array index shifts when steps are reordered
	// or removed), so any keying scheme would silently re-attach one step's
	// result to another. The cost — collapsing the panel discards the last
	// result — is accepted: this is a scratch test, not a saved artifact.
	//
	// There is no Stop button on purpose. M1's POST /snippets/cancel performs
	// a real registry + ownership check but the abort itself is a no-op: a run
	// still ends only at wall_timeout_s (10s default). Offering Stop here
	// would be a lie in a panel this small.
	import { onDestroy } from 'svelte';
	import { runSnippet, type SnippetRunBody, type SnippetRunOut } from '$lib/api/snippets';
	import { ApiError } from '$lib/api/errors';
	import { getModelRev, type SnippetBoundElement, type SnippetRunPhase } from '$lib/state';
	import { isResultStale } from '$lib/snippet/console-view';
	import { entryAvailable, type BoundEntry } from '$lib/snippet/entry-stubs';
	import type { SnippetSource } from '$lib/api/types';
	import ElementContextRow from './ElementContextRow.svelte';
	import SnippetResultView from './SnippetResultView.svelte';

	let {
		snippet,
		entry,
		entryPoints,
		onGoToLine = () => {}
	}: {
		snippet: SnippetSource;
		entry: BoundEntry;
		entryPoints: string[];
		onGoToLine?: (line: number) => void;
	} = $props();

	let open = $state(false);
	let elements = $state<SnippetBoundElement[]>([]);
	let phase = $state<SnippetRunPhase>('idle');
	let result = $state<SnippetRunOut | null>(null);
	let notice = $state<string | null>(null);

	// Generation guard: an in-flight response must not land on an unmounted
	// panel (or behind a newer run). Bumped on unmount, checked after await —
	// the same convention as state/snippet-editor.svelte.ts's
	// `_runGenerations` and SnippetSourceEditor's `lintSeq`. This is
	// defence-in-depth, not a fix for an observed bug, and it is deliberately
	// left without a unit test: its effect is unobservable through the
	// component's public surface. Svelte 5 tolerates a `$state` write after
	// unmount (no throw, no warning), and a superseding in-flight run is
	// structurally impossible here — `requestRun` flips `phase` to
	// `'running'` synchronously before its only `await`, and `runDisabled`
	// blocks re-entry while `phase !== 'idle'`. A mutation probe (deleting
	// the `seq !== runSeq` check) confirmed this: every test still passed,
	// because there is no externally visible difference to assert on.
	let runSeq = 0;
	onDestroy(() => {
		runSeq++;
	});

	// Gating mirrors the server's SnippetRunIn validators (`value` >= 1
	// element, `step` == 1) plus the two things it cannot check: that a
	// snippet is configured at all (the unconfigured `{}` source has nothing
	// to run) and that the code defines the entry point. The existing amber
	// `snippet-entry-warning` in SnippetSourceEditor already explains the
	// last one, so no second message is rendered here.
	const configured = $derived(
		snippet.definition ? snippet.definition.code.trim() !== '' : Boolean(snippet.ref)
	);
	const entryOk = $derived(entryAvailable(entry, entryPoints));
	const countOk = $derived(entry === 'step' ? elements.length === 1 : elements.length >= 1);
	const runDisabled = $derived(phase !== 'idle' || !configured || !entryOk || !countOk);
	const stale = $derived(result ? isResultStale(result, getModelRev()) : false);

	/** The list owner's half of the value-appends / step-replaces rule (the
	 * entry-dependent half lives in ElementContextRow). */
	function addElement(id: string, label: string): void {
		if (entry === 'step') {
			elements = [{ id, label }]; // step: picking replaces
			return;
		}
		if (elements.some((e) => e.id === id)) return; // duplicate — ignored
		elements = [...elements, { id, label }];
	}

	/** Also reachable from the inline CodeEditor's Mod-Enter keymap, which is
	 * why the gate lives HERE and not only on the button (same discipline as
	 * state/snippet-editor.runSnippetTab's entryAvailable guard). */
	export async function requestRun(): Promise<void> {
		open = true;
		if (runDisabled) return;
		const seq = ++runSeq;
		phase = 'running';
		notice = null;
		const body: SnippetRunBody = {
			run_id: crypto.randomUUID(),
			entry,
			element_ids: elements.map((e) => e.id),
			...(snippet.definition
				? { code: snippet.definition.code }
				: { artifact_id: snippet.ref ?? undefined })
		};
		try {
			const out = await runSnippet(body);
			if (seq !== runSeq) return; // unmounted, or a newer run started
			phase = 'idle';
			result = out;
		} catch (err) {
			if (seq !== runSeq) return;
			phase = 'idle';
			// Same vocabulary as state/snippet-editor.runSnippetTab — a 429 is a
			// normal occurrence, not a defect: snippet_per_user_concurrency
			// defaults to 1, so testing while a console run is live hits it.
			notice =
				err instanceof ApiError && err.status === 429
					? 'Another run is already in progress — wait for it to finish.'
					: err instanceof ApiError && err.status === 503
						? 'Code execution is unavailable on this server.'
						: 'Run failed — check your connection and try again.';
		}
	}
</script>

<div class="rounded border border-border/60">
	<button
		type="button"
		data-testid="snippet-test-toggle"
		class="flex w-full items-center gap-1 px-1.5 py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<span class="font-mono">{open ? '▾' : '▸'}</span> Test
	</button>
	{#if open}
		<ElementContextRow
			{entry}
			{elements}
			onAdd={addElement}
			onRemove={(id) => (elements = elements.filter((e) => e.id !== id))}
			onClear={() => (elements = [])}
		/>
		<div class="flex items-center gap-2 px-1.5 py-1">
			<button
				type="button"
				data-testid="snippet-test-run"
				class="rounded bg-primary px-2 py-0.5 text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
				disabled={runDisabled}
				onclick={() => void requestRun()}
			>
				Run
			</button>
			<span class="text-muted-foreground/70">
				{entry === 'step' ? 'runs step(el)' : 'runs value(elements)'}
			</span>
		</div>
		<div class="max-h-56 overflow-y-auto border-t border-border/60">
			<SnippetResultView {phase} {notice} {result} {stale} {onGoToLine} opsFooter={opsReadonly} />
		</div>
	{/if}
</div>

{#snippet opsReadonly()}
	<p data-testid="snippet-test-ops-readonly" class="text-warning">
		This snippet mutates the model — embedded {entry}() runs are read-only and these ops are
		discarded.
	</p>
{/snippet}
