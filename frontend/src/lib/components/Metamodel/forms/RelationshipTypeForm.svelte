<script lang="ts">
	import { Plus, Trash2 } from '@lucide/svelte';
	import type { Metamodel } from '$lib/api/types';
	import { relationshipAncestors } from '$lib/metamodel/helpers';
	import { applyDiagramEdit, selectDiagramNode } from '$lib/state';
	import {
		addBtnCls,
		dangerBtnCls,
		headingCls,
		inputCls,
		labelCls,
		rowRemoveCls,
		selectCls
	} from './field-classes';
	import PropertyListEditor from './PropertyListEditor.svelte';

	/**
	 * Everything a relationship type declares. Same commit conventions as
	 * `ElementTypeForm` (text on blur/Enter, selects and checkboxes on change,
	 * a rejected edit rolls its control back).
	 *
	 * `mappings` is the part with no canvas equivalent: a mapping pair is drawn
	 * as an EDGE, and an edge can be drawn but never edited in place. So the
	 * rows here are the only way to remove one, and the add row is the only way
	 * to add a pair whose endpoints are not both on screen.
	 */

	let {
		mm,
		name,
		readOnly,
		onRequestDelete
	}: {
		mm: Metamodel;
		name: string;
		readOnly: boolean;
		onRequestDelete: (name: string) => void;
	} = $props();

	const rel = $derived(mm.relationships.find((r) => r.name === name) ?? null);
	const elementNames = $derived(mm.elements.map((e) => e.name));

	/** Same cycle guard as the element form, over the relationship chain:
	 * `relationshipAncestors` walks INCLUSIVELY, so one predicate drops this
	 * type and everything already descending from it. */
	const extendsOptions = $derived(
		mm.relationships
			.filter((o) => !relationshipAncestors(mm, o.name).some((a) => a.name === name))
			.map((o) => o.name)
	);

	let addingMapping = $state(false);
	let newSource = $state('');
	let newTarget = $state('');

	function commitRename(input: HTMLInputElement): void {
		const to = input.value.trim();
		if (to === name) return;
		if (to === '' || !applyDiagramEdit({ kind: 'renameRelationshipType', from: name, to })) {
			input.value = name;
			return;
		}
		selectDiagramNode({ kind: 'relationship', name: to });
	}

	function commitMultiplicity(end: 'source' | 'target', input: HTMLInputElement): void {
		const value = input.value.trim();
		const current = end === 'source' ? rel?.source_multiplicity : rel?.target_multiplicity;
		if (value === '' || value === current) {
			input.value = current ?? '';
			return;
		}
		if (!applyDiagramEdit({ kind: 'setEndMultiplicity', name, end, value })) {
			input.value = current ?? '';
		}
	}

	function openAddMapping(): void {
		newSource = elementNames[0] ?? '';
		newTarget = elementNames[0] ?? '';
		addingMapping = true;
	}

	function confirmAddMapping(): void {
		if (newSource === '' || newTarget === '') return;
		applyDiagramEdit({
			kind: 'addMapping',
			name,
			mapping: { source: newSource, target: newTarget }
		});
		addingMapping = false;
	}

	function onEnter(e: KeyboardEvent): void {
		if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
	}
</script>

{#if rel === null}
	<p class="text-[11px] italic text-muted-foreground/70">
		This relationship type is no longer in the draft.
	</p>
{:else}
	<div class="flex flex-col gap-3">
		<div class="flex flex-col gap-1">
			<label class="flex flex-col gap-0.5">
				<span class={labelCls}>Relationship type</span>
				<input
					class={inputCls}
					data-testid="mm-rel-name"
					disabled={readOnly}
					value={rel.name}
					onblur={(e) => commitRename(e.currentTarget)}
					onkeydown={onEnter}
				/>
			</label>
			<p class="text-[10px] text-muted-foreground/70">
				Renaming re-types instances on rebind (shows as remove + add in Preview).
			</p>
		</div>

		<div class="flex flex-col gap-1">
			<label class="flex items-center gap-2 text-[11px] text-foreground/90">
				<input
					type="checkbox"
					data-testid="mm-rel-abstract"
					disabled={readOnly}
					checked={rel.abstract}
					onchange={(e) => {
						// A checkbox owns its own DOM state, so a REFUSED command has to be
						// undrawn by hand or the box sits flipped against an unchanged draft.
						if (
							!applyDiagramEdit({
								kind: 'setRelationshipAbstract',
								name,
								value: e.currentTarget.checked
							})
						) {
							e.currentTarget.checked = rel.abstract;
						}
					}}
				/>
				Abstract
			</label>
			<label class="flex items-center gap-2 text-[11px] text-foreground/90">
				<input
					type="checkbox"
					data-testid="mm-rel-containment"
					disabled={readOnly}
					checked={rel.containment}
					onchange={(e) => {
						if (
							!applyDiagramEdit({
								kind: 'setRelationshipContainment',
								name,
								value: e.currentTarget.checked
							})
						) {
							e.currentTarget.checked = rel.containment;
						}
					}}
				/>
				Containment
			</label>
		</div>

		<label class="flex flex-col gap-0.5">
			<span class={labelCls}>Extends</span>
			<select
				class={selectCls}
				data-testid="mm-rel-extends"
				disabled={readOnly}
				value={rel.extends ?? ''}
				onchange={(e) => {
					// Same rollback as the checkboxes: the select holds its own value.
					const value = e.currentTarget.value === '' ? null : e.currentTarget.value;
					if (!applyDiagramEdit({ kind: 'setRelationshipExtends', name, value })) {
						e.currentTarget.value = rel.extends ?? '';
					}
				}}
			>
				<option value="">— none —</option>
				{#each extendsOptions as opt, i (`${i}:${opt}`)}<option value={opt}>{opt}</option>{/each}
				{#if rel.extends !== null && !extendsOptions.includes(rel.extends)}
					<option value={rel.extends}>{rel.extends} (unknown)</option>
				{/if}
			</select>
		</label>

		<div class="grid grid-cols-2 gap-1.5">
			<label class="flex flex-col gap-0.5">
				<span class={labelCls}>Source multiplicity</span>
				<input
					class={inputCls}
					data-testid="mm-rel-source-mult"
					disabled={readOnly}
					value={rel.source_multiplicity}
					onblur={(e) => commitMultiplicity('source', e.currentTarget)}
					onkeydown={onEnter}
				/>
			</label>
			<label class="flex flex-col gap-0.5">
				<span class={labelCls}>Target multiplicity</span>
				<input
					class={inputCls}
					data-testid="mm-rel-target-mult"
					disabled={readOnly}
					value={rel.target_multiplicity}
					onblur={(e) => commitMultiplicity('target', e.currentTarget)}
					onkeydown={onEnter}
				/>
			</label>
		</div>

		<div class="flex flex-col gap-1.5">
			<p class={headingCls}>Mappings</p>
			{#if rel.mappings.length === 0}
				<p class="text-[11px] italic text-muted-foreground/70">
					No endpoints — nothing anchors this type on the canvas.
				</p>
			{/if}
			{#each rel.mappings as m, i (`${i}:${m.source}→${m.target}`)}
				<div class="flex items-center gap-1 text-[11px]" data-testid="mm-map-row">
					<span class="min-w-0 flex-1 truncate text-foreground/90">
						{m.source} → {m.target}
					</span>
					{#if !readOnly}
						<button
							type="button"
							class={rowRemoveCls}
							data-testid="mm-map-remove"
							title={`Remove mapping ${m.source} → ${m.target}`}
							aria-label={`Remove mapping ${m.source} → ${m.target}`}
							onclick={() => applyDiagramEdit({ kind: 'removeMapping', name, mapping: m })}
						>
							<Trash2 class="h-3 w-3" />
						</button>
					{/if}
				</div>
			{/each}

			{#if !readOnly}
				{#if addingMapping}
					<div class="flex items-center gap-1">
						<select
							class={selectCls}
							data-testid="mm-map-new-source"
							aria-label="Mapping source"
							value={newSource}
							onchange={(e) => (newSource = e.currentTarget.value)}
						>
							{#each elementNames as n, j (`${j}:${n}`)}<option value={n}>{n}</option>{/each}
						</select>
						<span class="text-[11px] text-muted-foreground/70">→</span>
						<select
							class={selectCls}
							data-testid="mm-map-new-target"
							aria-label="Mapping target"
							value={newTarget}
							onchange={(e) => (newTarget = e.currentTarget.value)}
						>
							{#each elementNames as n, j (`${j}:${n}`)}<option value={n}>{n}</option>{/each}
						</select>
						<button
							type="button"
							class={addBtnCls}
							data-testid="mm-map-confirm"
							onclick={confirmAddMapping}
						>
							Add
						</button>
						<button
							type="button"
							class="text-[11px] text-muted-foreground hover:text-foreground"
							onclick={() => (addingMapping = false)}
						>
							Cancel
						</button>
					</div>
				{:else}
					<button
						type="button"
						class={addBtnCls}
						data-testid="mm-map-add"
						disabled={elementNames.length === 0}
						title={elementNames.length === 0 ? 'No element types to map between' : undefined}
						onclick={openAddMapping}
					>
						<Plus class="h-3 w-3" /> Mapping
					</button>
				{/if}
			{/if}
		</div>

		<PropertyListEditor {mm} owner={{ kind: 'relationship', name }} {readOnly} />

		{#if !readOnly}
			<div class="border-t border-border pt-2">
				<p class="{headingCls} mb-1">Danger zone</p>
				<button
					type="button"
					class={dangerBtnCls}
					data-testid="mm-rel-delete"
					onclick={() => onRequestDelete(name)}
				>
					<Trash2 class="h-3 w-3" /> Delete {name}
				</button>
			</div>
		{/if}
	</div>
{/if}
