<script lang="ts">
	// Placeholder — Task 9 fills this in.
	let {
		open = $bindable(false),
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		onCreated
	}: { open?: boolean; onCreated: (id: string) => void } = $props();
</script>

{#if open}{/if}
