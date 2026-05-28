<script lang="ts">
	import { Popover } from 'bits-ui';
	import { Input } from '$lib/components/ui/input';

	type FilterMode = {
		mode: 'filter';
		names: string[];
		checked: ReadonlySet<string>;
		onToggle: (name: string) => void;
		onSelectAll: () => void;
		onDeselectAll: () => void;
	};

	type CreateMode = {
		mode: 'create';
		names: string[];
		onPick: (name: string) => void;
	};

	type Props = (FilterMode | CreateMode) & {
		open: boolean;
		onOpenChange: (next: boolean) => void;
		searchPlaceholder?: string;
		emptyLabel?: string;
		/** Children renders the trigger button (Popover.Trigger wraps it). */
		trigger: import('svelte').Snippet;
		align?: 'start' | 'center' | 'end';
	};

	let props: Props = $props();

	let query = $state('');

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q === '') return props.names;
		return props.names.filter((n) => n.toLowerCase().includes(q));
	});

	// Reset the query each time the popover opens.
	$effect(() => {
		if (props.open) query = '';
	});

	function handlePick(name: string): void {
		if (props.mode === 'create') {
			props.onPick(name);
			props.onOpenChange(false);
		} else {
			props.onToggle(name);
		}
	}
</script>

<Popover.Root bind:open={() => props.open, (v) => props.onOpenChange(v)}>
	<Popover.Trigger>
		{@render props.trigger()}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			align={props.align ?? 'end'}
			sideOffset={4}
			class="z-50 w-64 rounded-md border border-zinc-800 bg-zinc-950 p-0 text-sm text-zinc-200 shadow-xl outline-none"
		>
			{#if props.mode === 'filter'}
				<div class="flex items-center justify-between gap-2 border-b border-zinc-800 px-2 py-1.5">
					<button
						type="button"
						class="rounded px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
						onclick={() => props.onSelectAll()}
					>
						Select all
					</button>
					<button
						type="button"
						class="rounded px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
						onclick={() => props.onDeselectAll()}
					>
						Deselect all
					</button>
				</div>
			{/if}
			<div class="border-b border-zinc-800 p-2">
				<Input
					type="text"
					autofocus
					placeholder={props.searchPlaceholder ?? 'Filter…'}
					value={query}
					oninput={(e) => (query = (e.currentTarget as HTMLInputElement).value)}
					class="h-7 border-zinc-800 bg-zinc-900 text-xs placeholder:text-zinc-600"
				/>
			</div>
			<ul class="max-h-64 overflow-auto py-1 text-xs">
				{#if filtered.length === 0}
					<li class="px-3 py-2 text-zinc-600">{props.emptyLabel ?? 'No matches.'}</li>
				{:else}
					{#each filtered as name (name)}
						{#if props.mode === 'filter'}
							<li>
								<label class="flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-zinc-800">
									<input
										type="checkbox"
										class="h-3 w-3 shrink-0 accent-zinc-300"
										checked={props.checked.has(name)}
										onchange={() => handlePick(name)}
									/>
									<span class="truncate">{name}</span>
								</label>
							</li>
						{:else}
							<li>
								<button
									type="button"
									class="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-zinc-800"
									onclick={() => handlePick(name)}
								>
									<span class="truncate">{name}</span>
								</button>
							</li>
						{/if}
					{/each}
				{/if}
			</ul>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
