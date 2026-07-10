<script lang="ts">
	import { Popover } from 'bits-ui';
	import { Input } from '$lib/components/ui/input';
	import type { PropertyItem } from '$lib/search/property-ops';

	// A searchable property picker. Like StereotypePicker's create mode, but each
	// row shows the property's datatype on the right so same-named properties with
	// different datatypes can be told apart; picking one returns both name and
	// datatype.
	type Props = {
		items: PropertyItem[];
		open: boolean;
		onOpenChange: (next: boolean) => void;
		onPick: (name: string, datatype: string | null) => void;
		/** Renders the trigger button (Popover.Trigger wraps it). */
		trigger: import('svelte').Snippet;
		searchPlaceholder?: string;
		align?: 'start' | 'center' | 'end';
	};

	let { items, open, onOpenChange, onPick, trigger, searchPlaceholder, align }: Props = $props();

	let query = $state('');

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q === '') return items;
		return items.filter(
			(it) => it.name.toLowerCase().includes(q) || (it.datatype ?? '').toLowerCase().includes(q)
		);
	});

	// Reset the query each time the popover opens.
	$effect(() => {
		if (open) query = '';
	});

	function pick(it: PropertyItem): void {
		onPick(it.name, it.datatype);
		onOpenChange(false);
	}
</script>

<Popover.Root bind:open={() => open, (v) => onOpenChange(v)}>
	<Popover.Trigger>
		{@render trigger()}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			align={align ?? 'start'}
			sideOffset={4}
			class="z-50 w-72 rounded-md border border-border bg-popover p-0 text-sm text-popover-foreground shadow-xl outline-none"
		>
			<div class="border-b border-border p-2">
				<Input
					type="text"
					autofocus
					placeholder={searchPlaceholder ?? 'Filter properties…'}
					value={query}
					oninput={(e) => (query = (e.currentTarget as HTMLInputElement).value)}
					class="h-7 border-border bg-card text-xs placeholder:text-muted-foreground/50"
				/>
			</div>
			<ul class="max-h-64 overflow-auto py-1 text-xs">
				{#if filtered.length === 0}
					<li class="px-3 py-2 text-muted-foreground/50">No matches.</li>
				{:else}
					{#each filtered as it (`${it.name} ${it.datatype ?? ''}`)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-muted"
								onclick={() => pick(it)}
							>
								<span class="truncate text-foreground/90">{it.name}</span>
								<span
									class="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
								>
									{it.datatype ?? 'untyped'}
								</span>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
