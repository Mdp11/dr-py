// Pure view-model helpers for SnippetDocsPanel — kept Svelte-free so the
// panel component stays a thin template (mirrors console-view.ts).

import type { FacadeDocEntry, Metamodel } from '$lib/api/types';
import { effectiveProperties } from '$lib/metamodel/helpers';

export function formatSeconds(s: number): string {
	return `${s} s`;
}

export function formatBytes(n: number): string {
	if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MiB`;
	if (n >= 1024 && n % 1024 === 0) return `${n / 1024} KiB`;
	return `${n} B`;
}

export function groupFacade(entries: FacadeDocEntry[]): {
	dr: FacadeDocEntry[];
	element: FacadeDocEntry[];
	errors: FacadeDocEntry[];
} {
	return {
		dr: entries.filter((e) => e.name.startsWith('dr.') && e.kind !== 'exception'),
		element: entries.filter((e) => e.name.startsWith('Element.')),
		errors: entries.filter((e) => e.kind === 'exception')
	};
}

export interface TypeRow {
	name: string;
	abstract: boolean;
	properties: Array<{ name: string; datatype: string; multiplicity: string }>;
}

export interface RelRow {
	name: string;
	abstract: boolean;
	source: string;
	target: string;
	containment: boolean;
}

export function elementTypeRows(mm: Metamodel | null): TypeRow[] {
	if (!mm) return [];
	return mm.elements
		.map((e) => ({
			name: e.name,
			abstract: e.abstract,
			properties: effectiveProperties(mm, e.name).map((p) => ({
				name: p.name,
				datatype: p.datatype,
				multiplicity: p.multiplicity
			}))
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function relationshipRows(mm: Metamodel | null): RelRow[] {
	if (!mm) return [];
	return mm.relationships
		.map((r) => ({
			name: r.name,
			abstract: r.abstract,
			source: r.source,
			target: r.target,
			containment: r.containment
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
