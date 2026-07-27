<script lang="ts">
	// A small, generic confirmation dialog for destructive-or-lossy actions.
	//
	// Deliberately NOT a replacement for the repo's `window.confirm` call
	// sites — those keep working; this exists so surfaces that need a styled,
	// in-app confirmation (starting with the table settings dialog's discard
	// gate) do not each hand-roll one.
	//
	// Fully controlled: `open` is bindable, and the component never decides on
	// its own that the action should proceed — it reports the click and lets
	// the owner close it. Both buttons close it as a convenience, which is the
	// behaviour every caller so far wants.
	import * as Dialog from '$lib/components/ui/dialog';

	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		variant = 'default',
		onConfirm,
		onCancel
	}: {
		open?: boolean;
		title: string;
		description: string;
		confirmLabel?: string;
		cancelLabel?: string;
		variant?: 'default' | 'destructive';
		onConfirm: () => void;
		onCancel?: () => void;
	} = $props();

	function confirm(): void {
		open = false;
		onConfirm();
	}
	function cancel(): void {
		open = false;
		onCancel?.();
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		// Escape, the overlay and the built-in X all land here. They are
		// DISMISSALS, so they must behave like Cancel — never like Confirm.
		if (!o) onCancel?.();
	}}
>
	<Dialog.Content data-testid="confirm-dialog" class="gap-4" showCloseButton={false}>
		<Dialog.Title class="font-display text-lg font-light tracking-wide">
			{title}
		</Dialog.Title>
		<Dialog.Description class="text-xs leading-relaxed text-muted-foreground">
			{description}
		</Dialog.Description>
		<div class="flex items-center justify-end gap-2">
			<button
				type="button"
				data-testid="confirm-dialog-cancel"
				class="rounded border border-input px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted"
				onclick={cancel}
			>
				{cancelLabel}
			</button>
			<button
				type="button"
				data-testid="confirm-dialog-confirm"
				class="rounded px-3 py-1.5 text-xs transition-colors {variant === 'destructive'
					? 'bg-destructive text-white hover:bg-destructive/90'
					: 'bg-primary text-primary-foreground hover:bg-primary/80'}"
				onclick={confirm}
			>
				{confirmLabel}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
