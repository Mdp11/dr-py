/**
 * `manifest.json`, the record of an exporter run a zip leads with, as
 * `api/export_manifest.py` writes it: fixed field order, no clock, so the same
 * run at the same rev writes the same bytes.
 */
import { sha256 } from '../snapshot/sha256.ts';
import { jsonText, type JsonOut } from './json.ts';
import type { EntryTransform } from './schema.ts';
import { utf8, utf8Encoder } from './utf8.ts';

/** The manifest's member name, whose stem an entry of the same name dedupes against. */
export const MANIFEST_NAME = 'manifest.json';

const MANIFEST_VERSION = 1;

/** One entry's record: its rendered name, its table and the member paths it landed at. */
export type ManifestEntry = {
	name: string;
	table_ref: string;
	table_name: string;
	format: string;
	truncated: boolean;
	degraded: boolean;
	files: string[];
	transform: string | null;
};

export type Manifest = {
	projectId: string;
	artifactId: string | null;
	artifactName: string;
	modelRev: number;
	entries: readonly ManifestEntry[];
};

const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** An inline transform's stand-in for an artifact id: `inline:` and 12 hex digits of its code's SHA-256. */
export function inlineTransformMarker(code: string): string {
	return `inline:${hex(sha256(utf8Encoder().encode(code))).slice(0, 12)}`;
}

/** An entry's transform as the manifest names it: its snippet's id, its code's marker, or `null`. */
export function manifestTransform(transform: EntryTransform | null): string | null {
	if (transform === null) return null;
	if (transform.ref !== null) return transform.ref;
	if (transform.definition === null) return null;
	return inlineTransformMarker(transform.definition.code);
}

/** The manifest's bytes: `json.dumps(indent=2, ensure_ascii=False)`, no trailing newline. */
export function renderManifest(manifest: Manifest): Uint8Array {
	const entries = manifest.entries.map(
		(e): JsonOut =>
			new Map<string, JsonOut>([
				['name', e.name],
				['table_ref', e.table_ref],
				['table_name', e.table_name],
				['format', e.format],
				['truncated', e.truncated],
				['degraded', e.degraded],
				['files', [...e.files]],
				['transform', e.transform]
			])
	);
	const doc = new Map<string, JsonOut>([
		['manifest_version', MANIFEST_VERSION],
		['project_id', manifest.projectId],
		['artifact_id', manifest.artifactId],
		['artifact_name', manifest.artifactName],
		['model_rev', manifest.modelRev],
		['truncated', manifest.entries.some((e) => e.truncated)],
		['degraded', manifest.entries.some((e) => e.degraded)],
		['entries', entries]
	]);
	return utf8(jsonText(doc, true), false);
}
