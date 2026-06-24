<script lang="ts">
	import { metamodel as metamodelApi, ApiError, ConflictError } from '$lib/api';
	import { uploadModelBody } from '$lib/api/model-ops';
	import { ViewSchema, type View } from '$lib/api/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		adoptSummary,
		clearChangesBadge,
		clearIssues,
		clearViewState,
		pushView,
		resetModelStore,
		setFileHandle,
		setFilename,
		setMetamodel,
		setMetamodelFilename,
		setViewBaseline,
		setViewFilename
	} from '$lib/state';
	import { createMutation } from '@tanstack/svelte-query';

	type Loaded = {
		metamodelFilename: string;
		viewFilename: string | null;
	};

	type Props = {
		open: boolean;
		onLoaded?: (loaded: Loaded) => void;
	};

	let { open = $bindable(false), onLoaded }: Props = $props();

	// metamodel + model are required, view is optional. The three are applied in
	// order in a single batch because the backend has hard ordering deps:
	// uploading a metamodel clears the active model, a model must exist before a
	// view, and the view is validated against the freshly-loaded model.
	let metamodelFilename: string | null = $state(null);
	let metamodelBody: string | null = $state(null);
	let modelFilename: string | null = $state(null);
	let modelFile: File | null = $state(null);
	let viewFilename: string | null = $state(null);
	let viewBody: View | null = $state(null);
	let errorMessage: string | null = $state(null);

	let metamodelInputRef: HTMLInputElement | null = $state(null);
	let modelInputRef: HTMLInputElement | null = $state(null);
	let viewInputRef: HTMLInputElement | null = $state(null);

	const mutation = createMutation(() => ({
		mutationFn: async (vars: {
			metamodelBody: string;
			modelFile: File;
			modelFilename: string;
			viewBody: View | null;
		}) => {
			// 1. metamodel — uploading clears the active model on the backend.
			// If the model is non-empty the backend returns 409 (initial-bind
			// only guard). In that case clear the existing metamodel+model first
			// (DELETE /metamodel resets both) and then retry the upload. This
			// matches the dialog's stated intent: "Loading discards the current
			// model and unsaved changes."
			let mm: Awaited<ReturnType<typeof metamodelApi.uploadMetamodel>>;
			try {
				mm = await metamodelApi.uploadMetamodel(vars.metamodelBody);
			} catch (e) {
				if (e instanceof ConflictError) {
					await metamodelApi.clearMetamodel();
					mm = await metamodelApi.uploadMetamodel(vars.metamodelBody);
				} else {
					throw e;
				}
			}
			setMetamodel(mm);
			setMetamodelFilename(metamodelFilename);
			setViewFilename(null);
			resetModelStore();
			setFilename(null);
			setFileHandle(null);
			clearIssues();
			clearChangesBadge();

			// 2. model — streamed as the raw body, parsed against the new metamodel
			const summary = await uploadModelBody(vars.modelFile);
			resetModelStore();
			adoptSummary(summary);
			setFilename(vars.modelFilename);
			setFileHandle(null);
			clearIssues();
			clearChangesBadge();

			// 3. view (optional) — validated against the active model. Baseline
			// from the SERVER-echoed view so the view-change count starts at 0
			// even if the backend normalizes the snapshot.
			if (vars.viewBody) {
				const { view: storedView } = await pushView(vars.viewBody);
				setViewFilename(viewFilename);
				setViewBaseline(storedView);
			} else {
				// No view in this load: clear any view carried over from a prior
				// session so the badge/View tab don't report a stale view as changes.
				clearViewState();
			}
		},
		onSuccess: () => {
			const loaded: Loaded = {
				metamodelFilename: metamodelFilename ?? 'metamodel',
				viewFilename: viewBody ? (viewFilename ?? 'view.json') : null
			};
			resetForm();
			open = false;
			onLoaded?.(loaded);
		},
		onError: (err: unknown) => {
			if (err instanceof ApiError) {
				errorMessage = err.message;
			} else if (err instanceof Error) {
				errorMessage = err.message;
			} else {
				errorMessage = 'Load failed';
			}
		}
	}));

	function resetForm(): void {
		metamodelFilename = null;
		metamodelBody = null;
		modelFilename = null;
		modelFile = null;
		viewFilename = null;
		viewBody = null;
		errorMessage = null;
	}

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) resetForm();
	}

	async function onMetamodelSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		metamodelFilename = file.name;
		metamodelBody = await file.text();
		errorMessage = null;
	}

	function onModelSelected(event: Event): void {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		modelFilename = file.name;
		modelFile = file;
		errorMessage = null;
	}

	async function onViewSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		viewFilename = file.name;
		try {
			const text = await file.text();
			viewBody = ViewSchema.parse(JSON.parse(text));
			errorMessage = null;
		} catch (err) {
			viewBody = null;
			errorMessage = err instanceof Error ? err.message : 'Invalid view JSON';
		}
	}

	function clearView(): void {
		viewFilename = null;
		viewBody = null;
	}

	const canSubmit = $derived(metamodelBody !== null && modelFile !== null);

	function onSubmit(event: SubmitEvent): void {
		event.preventDefault();
		errorMessage = null;
		if (!metamodelBody) {
			errorMessage = 'Choose a metamodel file';
			return;
		}
		if (!modelFile || modelFilename === null) {
			errorMessage = 'Choose a model file';
			return;
		}
		mutation.mutate({ metamodelBody, modelFile, modelFilename, viewBody });
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Load files</Dialog.Title>
			<Dialog.Description>
				Pick a metamodel and a model; a view is optional. Loading discards the current model and
				unsaved changes.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={onSubmit} class="flex flex-col gap-4">
			<div class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-zinc-300"
					>Metamodel <span class="text-zinc-500">(required)</span></span
				>
				<div class="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onclick={() => metamodelInputRef?.click()}
					>
						Choose file...
					</Button>
					<span class="truncate font-mono text-xs text-zinc-400">
						{metamodelFilename ?? 'No file selected'}
					</span>
					<input
						bind:this={metamodelInputRef}
						type="file"
						accept=".yaml,.yml,.json"
						class="hidden"
						data-testid="metamodel-file-input"
						onchange={onMetamodelSelected}
					/>
				</div>
			</div>

			<div class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-zinc-300"
					>Model <span class="text-zinc-500">(required)</span></span
				>
				<div class="flex items-center gap-2">
					<Button type="button" variant="outline" size="sm" onclick={() => modelInputRef?.click()}>
						Choose file...
					</Button>
					<span class="truncate font-mono text-xs text-zinc-400">
						{modelFilename ?? 'No file selected'}
					</span>
					<input
						bind:this={modelInputRef}
						type="file"
						accept=".json"
						class="hidden"
						data-testid="model-file-input"
						onchange={onModelSelected}
					/>
				</div>
			</div>

			<div class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-zinc-300"
					>View <span class="text-zinc-500">(optional)</span></span
				>
				<div class="flex items-center gap-2">
					<Button type="button" variant="outline" size="sm" onclick={() => viewInputRef?.click()}>
						Choose file...
					</Button>
					<span class="truncate font-mono text-xs text-zinc-400">
						{viewFilename ?? 'No file selected'}
					</span>
					{#if viewFilename}
						<Button type="button" variant="ghost" size="sm" onclick={clearView}>Clear</Button>
					{/if}
					<input
						bind:this={viewInputRef}
						type="file"
						accept=".json"
						class="hidden"
						data-testid="view-file-input"
						onchange={onViewSelected}
					/>
				</div>
			</div>

			{#if errorMessage}
				<p class="text-xs text-red-400">{errorMessage}</p>
			{/if}
			<Dialog.Footer>
				<Button
					type="button"
					variant="ghost"
					onclick={() => onOpenChange(false)}
					disabled={mutation.isPending}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={mutation.isPending || !canSubmit}>
					{mutation.isPending ? 'Loading...' : 'Load'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
