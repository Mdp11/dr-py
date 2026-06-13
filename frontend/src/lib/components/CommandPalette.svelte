<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import type { Element } from '$lib/api/types';
	import { listElementsPage } from '$lib/api/model-read';
	import {
		getCommandPaletteOpen,
		getModelSummary,
		seedElements,
		select,
		setActiveTab,
		setCommandPaletteOpen,
		setDiffDrawerOpen,
		undo,
		type WorkspaceTab
	} from '$lib/state';
	import { runValidation } from '$lib/state/validate-action';
	import { elementDisplayName } from '$lib/util/element-name';

	const MAX_RESULTS = 50;
	const DEBOUNCE_MS = 200;

	const open = $derived(getCommandPaletteOpen());

	let query = $state('');

	// Server-ranked entity search (same endpoint as the sidebar search). An
	// empty query lists the first page in model order, like the old palette
	// listed everything.
	let entityHits: Element[] = $state([]);
	let requestSeq = 0;

	// Derived BOOLEAN (not the summary object — same pattern as the
	// containment tree's hasModel): per-ack summary replacements swap the
	// object identity without changing "a model is loaded", and tracking the
	// object would refetch the palette page on every ack while it is open.
	const hasModel = $derived(getModelSummary() !== null);

	$effect(() => {
		const isOpen = open;
		const q = query.trim();
		const loaded = hasModel;
		const seq = ++requestSeq;
		if (!isOpen || !loaded) {
			entityHits = [];
			return;
		}
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const page = await listElementsPage({
						q: q === '' ? undefined : q,
						limit: MAX_RESULTS
					});
					if (seq !== requestSeq) return;
					seedElements(page.items);
					entityHits = page.items;
				} catch {
					if (seq !== requestSeq) return;
					entityHits = [];
				}
			})();
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	function close(): void {
		setCommandPaletteOpen(false);
		query = '';
	}

	function pickEntity(id: string): void {
		select({ kind: 'element', id });
		close();
	}

	function gotoTab(t: WorkspaceTab): void {
		setActiveTab(t);
		close();
	}

	function actionSave(): void {
		setDiffDrawerOpen(true);
		close();
	}

	function actionValidate(): void {
		close();
		void runValidation();
	}

	function actionReloadModel(): void {
		close();
		window.location.reload();
	}

	function actionUndo(): void {
		close();
		void undo();
	}

	function onOpenChange(v: boolean): void {
		setCommandPaletteOpen(v);
		if (!v) query = '';
	}
</script>

<Command.Dialog
	{open}
	{onOpenChange}
	title="Command Palette"
	description="Search entities, run actions, or switch tabs."
	shouldFilter={false}
>
	<Command.Input placeholder="Search entities, actions, tabs…" bind:value={query} autofocus />
	<Command.List>
		<Command.Empty>No results.</Command.Empty>

		<Command.Group heading="Actions">
			<Command.Item value="action:save" onSelect={actionSave}>
				<span>Save</span>
			</Command.Item>
			<Command.Item value="action:validate" onSelect={actionValidate}>
				<span>Validate</span>
			</Command.Item>
			<Command.Item value="action:tab-detail" onSelect={() => gotoTab('detail')}>
				<span>Open Detail tab</span>
			</Command.Item>
			<Command.Item value="action:tab-graph" onSelect={() => gotoTab('graph')}>
				<span>Open Graph tab</span>
			</Command.Item>
			<Command.Item value="action:tab-issues" onSelect={() => gotoTab('issues')}>
				<span>Open Issues tab</span>
			</Command.Item>
			<Command.Item value="action:reload" onSelect={actionReloadModel}>
				<span>Reload model</span>
			</Command.Item>
			<Command.Item value="action:undo" onSelect={actionUndo}>
				<span class="text-red-300">Undo last change</span>
			</Command.Item>
		</Command.Group>

		<Command.Separator />

		<Command.Group heading="Tabs">
			<Command.Item value="tab:detail" onSelect={() => gotoTab('detail')}>
				<span>Detail</span>
			</Command.Item>
			<Command.Item value="tab:graph" onSelect={() => gotoTab('graph')}>
				<span>Graph</span>
			</Command.Item>
			<Command.Item value="tab:issues" onSelect={() => gotoTab('issues')}>
				<span>Issues</span>
			</Command.Item>
		</Command.Group>

		{#if entityHits.length > 0}
			<Command.Separator />
			<Command.Group heading="Entities">
				{#each entityHits as el (el.id)}
					<Command.Item value={'entity:' + el.id} onSelect={() => pickEntity(el.id)}>
						<span class="truncate">{elementDisplayName(el)}</span>
						<span
							class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400"
						>
							{el.type_name}
						</span>
						<span class="shrink-0 font-mono text-[10px] text-zinc-600">{el.id}</span>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
	</Command.List>
</Command.Dialog>
