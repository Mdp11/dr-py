<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import type { Element } from '$lib/api/types';
	import {
		getCommandPaletteOpen,
		getWorkingModel,
		resetOps,
		select,
		setActiveTab,
		setCommandPaletteOpen,
		setDiffDrawerOpen,
		type WorkspaceTab
	} from '$lib/state';
	import { runValidation } from '$lib/state/validate-action';

	type ScoredHit = { el: Element; score: number; displayName: string };

	const MAX_RESULTS = 50;

	const open = $derived(getCommandPaletteOpen());
	const working = $derived(getWorkingModel());

	let query = $state('');

	function elementDisplayName(el: Element): string {
		const n = el.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : el.id;
	}

	const entityHits = $derived.by<ScoredHit[]>(() => {
		const q = query.trim().toLowerCase();
		const hits: ScoredHit[] = [];
		for (const el of working.elements) {
			let score = 0;
			if (q === '') {
				score = 1;
			} else {
				const nameVal = el.properties?.name;
				const nameStr = typeof nameVal === 'string' ? nameVal : null;
				if (nameStr && nameStr.toLowerCase().includes(q)) score += 2;
				if (el.id.toLowerCase().includes(q)) score += 1;
				if (el.type_name.toLowerCase().includes(q)) score += 1;
				for (const [k, v] of Object.entries(el.properties ?? {})) {
					if (k === 'name') continue;
					if (typeof v === 'string' && v.toLowerCase().includes(q)) score += 0.5;
				}
			}
			if (score > 0) hits.push({ el, score, displayName: elementDisplayName(el) });
		}
		hits.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.el.id.localeCompare(b.el.id);
		});
		return hits.slice(0, MAX_RESULTS);
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

	function actionDiscardChanges(): void {
		close();
		const ok = window.confirm('Discard all unsaved changes? This cannot be undone.');
		if (ok) resetOps();
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
			<Command.Item value="action:discard" onSelect={actionDiscardChanges}>
				<span class="text-red-300">Discard all changes</span>
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
				{#each entityHits as r (r.el.id)}
					<Command.Item value={'entity:' + r.el.id} onSelect={() => pickEntity(r.el.id)}>
						<span class="truncate">{r.displayName}</span>
						<span
							class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400"
						>
							{r.el.type_name}
						</span>
						<span class="shrink-0 font-mono text-[10px] text-zinc-600">{r.el.id}</span>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
	</Command.List>
</Command.Dialog>
