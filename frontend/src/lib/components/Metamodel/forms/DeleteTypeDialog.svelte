<script lang="ts">
	import type { Metamodel } from '$lib/api/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { DiagramSelection } from '$lib/metamodel/diagram-build';
	import { applyDiagramEdit } from '$lib/state';

	/**
	 * Delete confirmation that shows the CASCADE, split the way `yaml-edit`
	 * actually behaves: some references are auto-fixed by the remove
	 * handler, and the rest are deliberately left in the YAML for the linter to
	 * flag rather than silently rewritten.
	 *
	 * That split is the whole point of this dialog — "Delete Building?" is not
	 * the question; "Delete Building, dropping two mappings and leaving
	 * `Sensor.site` pointing at nothing?" is. The two lists are derived HERE
	 * from `mm` rather than returned by the command, because the command has
	 * already run by the time anything could report on it.
	 */

	let {
		sel,
		mm,
		onConfirm,
		onCancel
	}: {
		sel: DiagramSelection;
		mm: Metamodel;
		onConfirm: () => void;
		onCancel: () => void;
	} = $props();

	/** Open on mount: the parent decides WHETHER this exists, so there is no
	 * closed state to represent. Escape and an overlay click flip it, and
	 * `onOpenChange` turns that into the cancel the parent expects. */
	let open = $state(true);

	interface Consequences {
		updated: string[];
		dangling: string[];
	}

	/** Every place a property datatype names `typeName` — the references the
	 * remove handlers deliberately do NOT rewrite (there is nothing correct to
	 * rewrite them to), so they surface here as the linter's future work. */
	function danglingDatatypes(typeName: string): string[] {
		const out: string[] = [];
		for (const el of mm.elements) {
			for (const p of el.properties) if (p.datatype === typeName) out.push(`${el.name}.${p.name}`);
		}
		for (const rel of mm.relationships) {
			for (const p of rel.properties)
				if (p.datatype === typeName) out.push(`${rel.name}.${p.name}`);
		}
		return out;
	}

	const consequences = $derived.by((): Consequences => {
		if (sel.kind === 'element') {
			const updated: string[] = [];
			for (const rel of mm.relationships) {
				for (const m of rel.mappings) {
					if (m.source === sel.name || m.target === sel.name) {
						updated.push(`${rel.name}: mapping ${m.source} → ${m.target} removed`);
					}
				}
			}
			for (const el of mm.elements) {
				if (el.extends === sel.name) updated.push(`${el.name}: extends cleared`);
			}
			// A key's `out:`/`in:` entries name a RELATIONSHIP end, so an element
			// delete cannot dangle one — only datatypes can.
			return { updated, dangling: danglingDatatypes(sel.name) };
		}
		if (sel.kind === 'relationship') {
			const updated = mm.relationships
				.filter((r) => r.extends === sel.name)
				.map((r) => `${r.name}: extends cleared`);
			const dangling: string[] = [];
			for (const el of mm.elements) {
				for (const entry of el.key ?? []) {
					if (entry === `out:${sel.name}` || entry === `in:${sel.name}`) {
						dangling.push(`${el.name}.key ${entry}`);
					}
				}
			}
			return { updated, dangling };
		}
		return { updated: [], dangling: danglingDatatypes(sel.name) };
	});

	const KIND_LABEL: Record<DiagramSelection['kind'], string> = {
		element: 'element type',
		relationship: 'relationship type',
		enum: 'enum'
	};

	function confirm(): void {
		const cmd =
			sel.kind === 'element'
				? ({ kind: 'removeElementType', name: sel.name } as const)
				: sel.kind === 'relationship'
					? ({ kind: 'removeRelationshipType', name: sel.name } as const)
					: ({ kind: 'removeEnum', name: sel.name } as const);
		applyDiagramEdit(cmd);
		open = false;
		onConfirm();
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		// Escape / overlay click are DISMISSALS — never a confirm.
		if (!o) onCancel();
	}}
>
	<Dialog.Content data-testid="mm-delete-dialog" class="max-w-md gap-4" showCloseButton={false}>
		<Dialog.Title class="font-display text-lg font-light tracking-wide">
			Delete {KIND_LABEL[sel.kind]} “{sel.name}”?
		</Dialog.Title>
		<Dialog.Description class="text-xs leading-relaxed text-muted-foreground">
			This edits your draft only — nothing changes for the project until you rebind.
		</Dialog.Description>

		{#if consequences.updated.length > 0}
			<div class="flex flex-col gap-0.5" data-testid="mm-delete-updated">
				<p class="text-[11px] font-medium text-foreground/90">Will be updated:</p>
				<ul class="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
					{#each consequences.updated as line, i (`${i}:${line}`)}
						<li>{line}</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if consequences.dangling.length > 0}
			<div class="flex flex-col gap-0.5" data-testid="mm-delete-dangling">
				<p class="text-[11px] font-medium text-warning">Will be left for the linter:</p>
				<ul class="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
					{#each consequences.dangling as line, i (`${i}:${line}`)}
						<li>{line}</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="flex items-center justify-end gap-2">
			<Button
				type="button"
				variant="ghost"
				size="xs"
				data-testid="mm-delete-cancel"
				onclick={() => {
					open = false;
					onCancel();
				}}
			>
				Cancel
			</Button>
			<Button
				type="button"
				variant="destructive"
				size="xs"
				data-testid="mm-delete-confirm"
				onclick={confirm}
			>
				Delete
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
