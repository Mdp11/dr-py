<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';

	let {
		label,
		hint,
		accept,
		required = false,
		disabled = false,
		testid,
		file = $bindable(null)
	}: {
		label: string;
		/** Human-readable expected suffix, e.g. ".model.json". */
		hint: string;
		/** Comma-separated suffix list; doubles as the picker filter and the validation rule. */
		accept: string;
		required?: boolean;
		disabled?: boolean;
		testid?: string;
		file?: File | null;
	} = $props();

	let inputRef: HTMLInputElement | null = $state(null);
	let dragOver = $state(false);
	let slotError = $state<string | null>(null);

	const suffixes = $derived(accept.split(',').map((s) => s.trim().toLowerCase()));
	function matches(name: string): boolean {
		const n = name.toLowerCase();
		return suffixes.some((s) => n.endsWith(s));
	}

	// Shared by the picker and drag-and-drop; drops bypass `accept`, so both
	// paths validate against the same suffix list.
	function take(f: File | null | undefined): void {
		if (!f) return;
		if (!matches(f.name)) {
			slotError = `Expected a ${hint} file`;
			return;
		}
		slotError = null;
		file = f;
	}

	function onChange(e: Event): void {
		const target = e.target as HTMLInputElement;
		take(target.files?.[0]);
		target.value = '';
	}

	function clear(): void {
		file = null;
		slotError = null;
	}

	function formatSize(bytes: number): string {
		if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${bytes} B`;
	}
</script>

<div class="relative">
	<button
		type="button"
		{disabled}
		aria-label={file
			? `${label}: ${file.name} — replace file`
			: `Choose ${label.toLowerCase()} file`}
		class="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors
			disabled:pointer-events-none disabled:opacity-50
			{file
			? 'border-primary/40 bg-primary/5'
			: 'border-dashed border-border hover:border-input hover:bg-accent/40'}
			{dragOver ? 'border-primary bg-primary/10' : ''}"
		onclick={() => inputRef?.click()}
		ondragover={(e) => {
			e.preventDefault();
			dragOver = true;
		}}
		ondragleave={() => (dragOver = false)}
		ondrop={(e) => {
			e.preventDefault();
			dragOver = false;
			if (!disabled) take(e.dataTransfer?.files?.[0]);
		}}
	>
		<span
			class="flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors
				{file ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground'}"
			aria-hidden="true"
		>
			{#if file}
				<CheckIcon class="size-3.5" />
			{:else}
				<PlusIcon class="size-3.5" />
			{/if}
		</span>
		<span class="flex min-w-0 flex-1 flex-col gap-0.5">
			<span class="flex items-baseline gap-2">
				<span class="microlabel text-foreground/80">{label}</span>
				<span class="text-[10px] tracking-wide text-muted-foreground/60">
					{required ? 'Required' : 'Optional'}
				</span>
			</span>
			{#if file}
				<span class="flex min-w-0 items-baseline gap-2 pr-8">
					<span class="truncate font-mono text-xs text-foreground">{file.name}</span>
					<span class="shrink-0 text-[10px] text-muted-foreground">{formatSize(file.size)}</span>
				</span>
			{:else if slotError}
				<span class="text-xs text-destructive">{slotError}</span>
			{:else}
				<span class="text-xs text-muted-foreground">
					Drop a <span class="font-mono">{hint}</span> file or click to browse
				</span>
			{/if}
		</span>
	</button>
	{#if file && !disabled}
		<button
			type="button"
			class="absolute top-1/2 right-3 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			aria-label="Remove {label.toLowerCase()} file"
			onclick={clear}
		>
			<XIcon class="size-3.5" />
		</button>
	{/if}
	<input
		bind:this={inputRef}
		type="file"
		{accept}
		class="hidden"
		data-testid={testid}
		onchange={onChange}
	/>
</div>
