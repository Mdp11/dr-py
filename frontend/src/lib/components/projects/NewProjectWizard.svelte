<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { createProject } from '$lib/api/projects';
	import { ApiError } from '$lib/api/errors';
	import { beginJourney, journeyUpload, cancelJourney } from '$lib/state/open-journey';
	import FileSlot from './FileSlot.svelte';

	let {
		open = $bindable(false),
		onCreated,
		onListChanged
	}: {
		open?: boolean;
		onCreated: (id: string) => void | Promise<void>;
		/** A createProject abandoned by closing the dialog can still succeed
		 * server-side; this tells the parent the projects list changed so the
		 * orphan shows up without a full reload (else the user re-submits the
		 * same files and creates a duplicate). */
		onListChanged?: () => void;
	} = $props();

	let name = $state('');
	let metamodel = $state<File | null>(null);
	let model = $state<File | null>(null);
	let view = $state<File | null>(null);
	let artifacts = $state<File | null>(null);
	let error = $state<string | null>(null);
	let pending = $state(false);
	let skipped = $state<{ bundle_id: string; reason: string }[] | null>(null);
	let createdId = $state<string | null>(null);

	const canSubmit = $derived(name.trim().length > 0 && metamodel !== null);

	// Bumped on every close: a createProject still in flight when the dialog
	// closes is ABANDONED — its settlement compares its captured generation
	// and, when stale, neither writes error/skipped/createdId onto the fresh
	// form nor navigates via onCreated (a late success would otherwise drop
	// the user into a project they cancelled). Same pattern as
	// ImportArtifactsDialog's post-await guards.
	let submitGen = 0;

	// True from just before `await onCreated` (navigation into the created
	// project) until the close-reset runs. The parent closes the dialog
	// BEFORE the goto resolves, so the close-reset fires during a SUCCESSFUL
	// hand-off too — this flag is what lets it tell that apart from a user
	// abandoning an in-flight submit, where the journey bar must die at close
	// (boot() adopts the bar on success; nothing would ever tear it down on
	// an abandon, and the singleton beginJourney would hand the orphan to the
	// next attempt).
	let navigating = false;

	// The project is created either way; when the importer reported-and-skipped
	// artifacts, navigation is DEFERRED until the user clicks through the
	// warning panel below. Reset EVERYTHING when the dialog closes so a
	// re-open starts fresh — a partial reset (just the artifacts/skipped/
	// createdId trio) left the name and the other three file slots showing
	// the PREVIOUS attempt's values while the artifacts slot alone went
	// mysteriously blank, which is not a state a fresh wizard should ever show.
	// `pending` is reset here too (the abandoned request must not freeze a
	// reopened wizard); the stale flight's own `finally` is gen-guarded so it
	// cannot clobber a NEWER submit's pending afterwards.
	$effect(() => {
		if (!open) {
			// A user abandoning an in-flight submit kills its journey bar NOW —
			// not whenever the request settles (possibly never, on a hung
			// connection). Guarded so the successful hand-off (parent closes
			// while `await onCreated` navigates; boot() adopts the bar) is
			// left alone.
			if (pending && !navigating) cancelJourney();
			navigating = false;
			submitGen++;
			name = '';
			metamodel = null;
			model = null;
			view = null;
			artifacts = null;
			error = null;
			pending = false;
			skipped = null;
			createdId = null;
		}
	});

	async function onSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!canSubmit || !metamodel) return;
		error = null;
		pending = true;
		navigating = false; // a previous attempt's failed onCreated must not leak the flag
		const gen = submitGen;
		// Start the single journey bar now (on the click). It survives the goto()
		// into the workspace, where boot() adopts the same journey (beginJourney is
		// idempotent) and drives it through hydration/validation to 100%.
		beginJourney('create');
		try {
			const created = await createProject(
				{ name, metamodel, model, view, artifacts },
				(loaded, total) => {
					journeyUpload(loaded, total);
				}
			);
			if (gen !== submitGen) {
				// The dialog closed mid-flight: the user cancelled this attempt,
				// and the close already tore its journey bar down (touching the
				// singleton journey here could clobber a NEWER attempt's bar).
				// The project now exists server-side though — do NOT navigate
				// into it, but do tell the parent so the list shows the orphan.
				onListChanged?.();
				return;
			}
			if (created.skipped_artifacts.length > 0) {
				// Show the warning BEFORE entering the project: the journey bar is
				// torn down (boot() starts its own when the user proceeds).
				cancelJourney();
				createdId = created.id;
				skipped = created.skipped_artifacts;
				return;
			}
			// Do NOT end the journey here — boot() continues it after navigation.
			navigating = true;
			await onCreated(created.id);
		} catch (err) {
			// Abandoned attempt: the close already cancelled ITS journey, and the
			// live journey (if any) belongs to a newer attempt — leave it alone
			// and keep the fresh form pristine.
			if (gen !== submitGen) return;
			cancelJourney(); // tear the bar down on failure
			error =
				err instanceof ApiError ? err.message : 'Could not create the project. Check the files.';
		} finally {
			// The close-reset already cleared `pending` for a stale flight, and by
			// then it may belong to a newer submit — only the live flight owns it.
			if (gen === submitGen) pending = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="gap-0 p-0 sm:max-w-lg">
		<Dialog.Header class="px-6 pt-6">
			<Dialog.Title class="font-display text-lg font-light tracking-wide">New project</Dialog.Title>
			<Dialog.Description>
				A project starts from a metamodel. Add a model and view to import existing data, or skip
				them to start empty.
			</Dialog.Description>
		</Dialog.Header>
		{#if skipped !== null}
			<div class="flex flex-col gap-3 px-6 py-5">
				<p class="text-sm text-foreground/90">
					Project created — {skipped.length}
					{skipped.length === 1 ? 'artifact was' : 'artifacts were'} skipped:
				</p>
				<ul class="flex flex-col gap-1 text-xs text-warning">
					{#each skipped as s (s.bundle_id)}
						<li>{s.bundle_id} — {s.reason}</li>
					{/each}
				</ul>
			</div>
			<Dialog.Footer class="border-t border-border bg-muted/30 px-6 py-4">
				<Button
					type="button"
					data-testid="wizard-open-anyway"
					onclick={() => {
						// Hygiene, not a behavior change: the parent already closes the
						// dialog synchronously on this click, so a rejecting navigation
						// has nowhere useful to surface — but left uncaught it becomes an
						// unhandled promise rejection. `Promise.resolve(...)` copes with
						// onCreated returning either `void` or a `Promise<void>`.
						if (createdId !== null) Promise.resolve(onCreated(createdId)).catch(() => {});
					}}
				>
					Open project
				</Button>
			</Dialog.Footer>
		{:else}
			<form onsubmit={onSubmit} class="flex flex-col">
				<div class="flex flex-col gap-5 px-6 py-5">
					<label class="flex flex-col gap-1.5">
						<span class="microlabel text-foreground/80">Project name</span>
						<Input name="project-name" placeholder="e.g. Smart City" bind:value={name} required />
					</label>
					<div class="flex flex-col gap-2">
						<FileSlot
							label="Metamodel"
							hint=".metamodel.yaml"
							accept=".yaml,.yml"
							required
							disabled={pending}
							testid="mm-input"
							bind:file={metamodel}
						/>
						<FileSlot
							label="Model"
							hint=".model.json"
							accept=".model.json"
							disabled={pending}
							testid="model-input"
							bind:file={model}
						/>
						<FileSlot
							label="View"
							hint=".view.json"
							accept=".view.json"
							disabled={pending}
							testid="view-input"
							bind:file={view}
						/>
						<FileSlot
							label="Artifacts"
							hint=".bundle.json"
							accept=".json"
							disabled={pending}
							testid="artifacts-input"
							bind:file={artifacts}
						/>
					</div>
					{#if error}
						<p class="text-xs text-destructive" role="alert">{error}</p>
					{/if}
				</div>
				<Dialog.Footer class="border-t border-border bg-muted/30 px-6 py-4">
					<Button type="button" variant="ghost" onclick={() => (open = false)} disabled={pending}>
						Cancel
					</Button>
					<Button type="submit" disabled={!canSubmit || pending}>
						{pending ? 'Creating…' : 'Create project'}
					</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
