<script lang="ts">
	import { Trash2 } from '@lucide/svelte';
	import type { Metamodel } from '$lib/api/types';
	import { isSubtype } from '$lib/metamodel/helpers';
	import { applyDiagramEdit, selectDiagramNode } from '$lib/state';
	import { dangerBtnCls, headingCls, inputCls, labelCls, selectCls } from './field-classes';
	import KeyBuilder from './KeyBuilder.svelte';
	import PropertyListEditor from './PropertyListEditor.svelte';

	/**
	 * Everything an element type declares, as a form: name, `abstract`,
	 * `extends`, its properties and its key.
	 *
	 * **Commit timing is the convention every form here follows**: text commits
	 * on blur or Enter, selects and checkboxes on change. A rename per keystroke
	 * would run the whole rename CASCADE (extends pointers, mapping endpoints,
	 * property datatypes, key DSL entries) once per letter and re-lint each
	 * time, which is both slow and unreadable in the YAML view.
	 *
	 * A rejected edit (a peer took the lease mid-keystroke, the buffer stopped
	 * parsing) rolls the control back to the draft's value rather than leaving
	 * the form claiming a change that never landed — `applyDiagramEdit` returns
	 * false for exactly those cases and changes nothing.
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

	const el = $derived(mm.elements.find((e) => e.name === name) ?? null);

	/** `extends` targets that cannot make a cycle: `isSubtype` walks the chain
	 * INCLUSIVELY, so one predicate drops both this type itself and everything
	 * that already descends from it. */
	const extendsOptions = $derived(
		mm.elements.filter((o) => !isSubtype(mm, o.name, name)).map((o) => o.name)
	);

	function commitRename(input: HTMLInputElement): void {
		const to = input.value.trim();
		if (to === name) return;
		if (to === '' || !applyDiagramEdit({ kind: 'renameElementType', from: name, to })) {
			input.value = name;
			return;
		}
		// The selection is keyed by NAME, so it has to follow the rename or the
		// panel blanks out on the type the user is still editing.
		selectDiagramNode({ kind: 'element', name: to });
	}
</script>

{#if el === null}
	<p class="text-[11px] italic text-muted-foreground/70">
		This element type is no longer in the draft.
	</p>
{:else}
	<div class="flex flex-col gap-3">
		<div class="flex flex-col gap-1">
			<label class="flex flex-col gap-0.5">
				<span class={labelCls}>Element type</span>
				<input
					class={inputCls}
					data-testid="mm-form-name"
					disabled={readOnly}
					value={el.name}
					onblur={(e) => commitRename(e.currentTarget)}
					onkeydown={(e) => {
						if (e.key === 'Enter') e.currentTarget.blur();
					}}
				/>
			</label>
			<p class="text-[10px] text-muted-foreground/70">
				Renaming re-types instances on rebind (shows as remove + add in Preview).
			</p>
		</div>

		<label class="flex items-center gap-2 text-[11px] text-foreground/90">
			<input
				type="checkbox"
				data-testid="mm-form-abstract"
				disabled={readOnly}
				checked={el.abstract}
				onchange={(e) => {
					// A checkbox owns its own DOM state, so a REFUSED command has to be
					// undrawn by hand or the box sits flipped against an unchanged draft.
					if (
						!applyDiagramEdit({ kind: 'setElementAbstract', name, value: e.currentTarget.checked })
					) {
						e.currentTarget.checked = el.abstract;
					}
				}}
			/>
			Abstract
		</label>

		<label class="flex flex-col gap-0.5">
			<span class={labelCls}>Extends</span>
			<select
				class={selectCls}
				data-testid="mm-form-extends"
				disabled={readOnly}
				value={el.extends ?? ''}
				onchange={(e) => {
					// Same rollback as the checkbox: the select holds its own value.
					const value = e.currentTarget.value === '' ? null : e.currentTarget.value;
					if (!applyDiagramEdit({ kind: 'setElementExtends', name, value })) {
						e.currentTarget.value = el.extends ?? '';
					}
				}}
			>
				<option value="">— none —</option>
				{#each extendsOptions as opt, i (`${i}:${opt}`)}<option value={opt}>{opt}</option>{/each}
				<!-- A supertype the draft dropped: keep it selectable rather than
				     silently re-pointing `extends` at the first surviving option. -->
				{#if el.extends !== null && !extendsOptions.includes(el.extends)}
					<option value={el.extends}>{el.extends} (unknown)</option>
				{/if}
			</select>
		</label>

		<PropertyListEditor {mm} owner={{ kind: 'element', name }} {readOnly} />

		<KeyBuilder {mm} {name} {readOnly} />

		{#if !readOnly}
			<div class="border-t border-border pt-2">
				<p class="{headingCls} mb-1">Danger zone</p>
				<button
					type="button"
					class={dangerBtnCls}
					data-testid="mm-form-delete"
					onclick={() => onRequestDelete(name)}
				>
					<Trash2 class="h-3 w-3" /> Delete {name}
				</button>
			</div>
		{/if}
	</div>
{/if}
