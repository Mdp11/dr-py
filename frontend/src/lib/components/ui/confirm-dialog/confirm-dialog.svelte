<script lang="ts">
	// A small, generic confirmation dialog for destructive-or-lossy actions.
	// This is the app's confirmation prompt. The browser's own survives at
	// exactly one call site — the `beforeNavigate` unload guard in
	// `routes/p/[projectId]/+page.svelte`, which must decide synchronously;
	// there is a comment there explaining why. Everything else uses this.
	//
	// Two ways in. Own an instance directly (`bind:open` + `onConfirm`) when the
	// prompt belongs to a surface you already control, as the table settings
	// dialog's discard gate does. Otherwise call `confirm()` from
	// `$lib/state/confirm.svelte`, the promise-shaped helper that every former
	// `window.confirm` site uses — it drives one shared instance mounted by
	// `ConfirmHost` in the root layout, so a caller needs no markup of its own.
	//
	// Fully controlled: `open` is bindable, and the component never decides on
	// its own that the action should proceed — it reports the click and lets
	// the owner close it. Both buttons close it as a convenience, which is the
	// behaviour every caller so far wants.
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';

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
		// Escape and an overlay click land here — there is no built-in X,
		// since Content below passes showCloseButton={false}. They are
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
			<!-- `ghost` is this repo's dismissive-footer-button convention (see
			     SettingsDialog.svelte's Close and ModelChangeDialog.svelte's Close);
			     `xs` matches this dialog's text-xs scale. Using the shared Button
			     component (rather than hand-rolled classes) keeps every variant's
			     colours inside vetted tokens — a hand-rolled `bg-destructive` +
			     `text-white` combination here previously failed WCAG AA contrast
			     in dark theme. -->
			<Button
				type="button"
				variant="ghost"
				size="xs"
				data-testid="confirm-dialog-cancel"
				onclick={cancel}
			>
				{cancelLabel}
			</Button>
			<Button
				type="button"
				variant={variant === 'destructive' ? 'destructive' : 'default'}
				size="xs"
				data-testid="confirm-dialog-confirm"
				onclick={confirm}
			>
				{confirmLabel}
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
