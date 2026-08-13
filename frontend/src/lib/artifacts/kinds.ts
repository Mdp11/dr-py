/**
 * The one client-side registry of artifact kinds (backlog C-6): every
 * component that filters, labels, or icons artifact kinds reads from here.
 * Mirrors the backend registry in src/data_rover/api/artifact_kinds.py.
 */
import { FileCode, Route, Table } from '@lucide/svelte';

export type ArtifactKind = 'navigation' | 'table' | 'code_snippet';

export const REGISTERED_KINDS = ['navigation', 'table', 'code_snippet'] as const;

export const KIND_ICONS: Record<ArtifactKind, typeof Route> = {
	navigation: Route,
	table: Table,
	code_snippet: FileCode
};

export const KIND_LABEL: Record<ArtifactKind, string> = {
	navigation: 'Navigation',
	table: 'Table',
	code_snippet: 'Snippet'
};

/** Filter for headers whose kind is registered (unregistered kinds like the
 * reserved `diagram` must never render a row). */
export const SECTION_KINDS: ReadonlySet<string> = new Set(REGISTERED_KINDS);

export function isRegisteredKind(k: string): k is ArtifactKind {
	return SECTION_KINDS.has(k);
}
