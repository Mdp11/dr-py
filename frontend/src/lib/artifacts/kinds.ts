/**
 * The one client-side registry of artifact kinds: every component that
 * filters, labels, or icons artifact kinds reads from here. Mirrors the
 * backend registry in src/data_rover/api/artifact_kinds.py.
 */
import { FileCode, FolderOutput, Route, ShieldCheck, Table } from '@lucide/svelte';

export const REGISTERED_KINDS = [
	'navigation',
	'table',
	'code_snippet',
	'exporter',
	'validation_rules'
] as const;

export type ArtifactKind = (typeof REGISTERED_KINDS)[number];

export const KIND_ICONS: Record<ArtifactKind, typeof Route> = {
	navigation: Route,
	table: Table,
	code_snippet: FileCode,
	exporter: FolderOutput,
	validation_rules: ShieldCheck
};

export const KIND_LABEL: Record<ArtifactKind, string> = {
	navigation: 'Navigation',
	table: 'Table',
	code_snippet: 'Snippet',
	exporter: 'Exporter',
	validation_rules: 'Rules'
};

/** Filter for headers whose kind is registered (unregistered kinds like the
 * reserved `diagram` must never render a row). */
export const SECTION_KINDS: ReadonlySet<string> = new Set(REGISTERED_KINDS);

export function isRegisteredKind(k: string): k is ArtifactKind {
	return SECTION_KINDS.has(k);
}
