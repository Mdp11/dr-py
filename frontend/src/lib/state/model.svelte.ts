import type { ClientConfig } from '$lib/api/client';
import type { Element, Issue, OpsResponse, Relationship, TreeItem } from '$lib/api/types';
import { validateModel } from '../api/validation';
import type { Diff } from './diff';
import * as legacy from './model-legacy.svelte';
import { getClientConfig, getModelRev, resetSharedStore } from './model-shared.svelte';
import type { ModelOp } from './ops';
import { getStagingSide } from './replica.svelte';

/**
 * Staged-commit model store — the facade. `model-shared.svelte.ts` (re-
 * exported below) holds the counters and issue state every entity half
 * agrees on; `model-legacy.svelte.ts` is today's entity half (caches, staged
 * edits), frozen and kept as the server-mode fallback. Every entity-half
 * read/write below dispatches through {@link side} to whichever half
 * `staging` (see `lib/engine/surfaces.ts`, `getStagingSide()`) names;
 * `resetModelStore` and `validateAll` touch both halves directly, since
 * neither is a single entity half's concern.
 */

export * from './model-shared.svelte';

// Both branches are the legacy half — there is no engine-backed half to
// dispatch to yet — but the shape already reads `getStagingSide()`, so
// wiring one in touches only the `'engine'` branch.
function side(): typeof legacy {
	return getStagingSide() === 'engine' ? legacy : legacy;
}

// ---------------------------------------------------------------------------
// Entity-half dispatch
// ---------------------------------------------------------------------------

export function getCachedElements(): ReadonlyMap<string, Element> {
	return side().getCachedElements();
}

export function getMissingElementIds(): ReadonlySet<string> {
	return side().getMissingElementIds();
}

export function getCachedTreeItems(): ReadonlyMap<string, TreeItem> {
	return side().getCachedTreeItems();
}

export function getTreeElements(): Map<string, Element> {
	return side().getTreeElements();
}

export function seedTreeItems(items: readonly TreeItem[]): void {
	side().seedTreeItems(items);
}

export function dropTreeItems(ids: readonly string[]): void {
	side().dropTreeItems(ids);
}

export function getCachedRelationships(): ReadonlyMap<string, Relationship> {
	return side().getCachedRelationships();
}

export function applyDelta(d: OpsResponse): void {
	side().applyDelta(d);
}

export function emit(op: ModelOp): void {
	side().emit(op);
}

export function getStagedOps(): ModelOp[] {
	return side().getStagedOps();
}

export function getStagedOpsFor(id: string): ModelOp[] {
	return side().getStagedOpsFor(id);
}

export function getStagedNameOverride(id: string): string | undefined {
	return side().getStagedNameOverride(id);
}

export function getStagedDepth(): number {
	return side().getStagedDepth();
}

export function hasStagedOps(): boolean {
	return side().hasStagedOps();
}

export function revertStagedFor(id: string): void {
	side().revertStagedFor(id);
}

export function revertStagedForElement(id: string): void {
	side().revertStagedForElement(id);
}

export function revertAllStaged(): void {
	side().revertAllStaged();
}

export function popLastStaged(): boolean {
	return side().popLastStaged();
}

export function clearStaged(): void {
	side().clearStaged();
}

export function getStagedDiff(): Diff {
	return side().getStagedDiff();
}

export function getStagedChangeCount(): number {
	return side().getStagedChangeCount();
}

export function ensureElement(id: string): Promise<Element | null> {
	return side().ensureElement(id);
}

export function ensureElements(ids: readonly string[]): Promise<void> {
	return side().ensureElements(ids);
}

export function ensureTreeItems(ids: readonly string[]): Promise<void> {
	return side().ensureTreeItems(ids);
}

export function ensureRelationship(id: string): Promise<Relationship | null> {
	return side().ensureRelationship(id);
}

export function seedElements(els: readonly Element[]): void {
	side().seedElements(els);
}

export function seedRelationships(rels: readonly Relationship[]): void {
	side().seedRelationships(rels);
}

export function isStagedDeleted(id: string): boolean {
	return side().isStagedDeleted(id);
}

export function setModelApiConfig(cfg: ClientConfig | undefined): void {
	side().setModelApiConfig(cfg);
}

// ---------------------------------------------------------------------------
// Facade-owned: touch both halves
// ---------------------------------------------------------------------------

/**
 * Full validation run that INCLUDES staged (uncommitted) edits. When the staged
 * buffer is non-empty, the staged ops + current rev are sent to POST
 * /model/validate, which applies them against the committed model, validates,
 * rolls back, and tags each issue's origin (on_server / uncommitted / resolved).
 * With an empty buffer it is a plain committed-model validation (all on_server).
 *
 * A pure fetch: it does NOT mutate the live issue map (see `adoptIssues`/
 * `applyDelta`). The caller (`validate-action.ts`'s `runValidation`) stores
 * the origin-tagged result as the Validate OVERLAY via `setOverlay`; that
 * overlay, not this function, is what lets resolved/uncommitted issues
 * surface in the panel.
 */
export async function validateAll(): Promise<Issue[]> {
	const staged = side().getStagedOps();
	const options = staged.length > 0 ? { ops: staged, baseRev: getModelRev() } : undefined;
	return validateModel(options, getClientConfig());
}

/**
 * Drop every cache, counter, queue, and error — for tests and for replacing
 * the model (load/upload flows call this, then refreshSummary()). Resets the
 * legacy entity half and the shared half together.
 */
export function resetModelStore(): void {
	legacy.resetLegacyStore();
	resetSharedStore();
}
