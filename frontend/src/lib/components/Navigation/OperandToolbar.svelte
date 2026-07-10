<script lang="ts">
	import { ChevronDown, ChevronUp, Trash2 } from '@lucide/svelte';

	let {
		canMoveUp,
		canMoveDown,
		onUp,
		onDown,
		onRemove
	}: {
		canMoveUp: boolean;
		canMoveDown: boolean;
		onUp: () => void;
		onDown: () => void;
		onRemove: () => void;
	} = $props();
</script>

<span class="flex items-center gap-0.5">
	<button
		type="button"
		aria-label="Move up"
		class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground/90 disabled:opacity-30"
		disabled={!canMoveUp}
		onclick={onUp}><ChevronUp class="size-3" /></button
	>
	<button
		type="button"
		aria-label="Move down"
		class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground/90 disabled:opacity-30"
		disabled={!canMoveDown}
		onclick={onDown}><ChevronDown class="size-3" /></button
	>
	<button
		type="button"
		aria-label="Remove operand"
		class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
		onclick={onRemove}><Trash2 class="size-3" /></button
	>
</span>
