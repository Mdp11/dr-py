import { parseDocument, isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { z } from 'zod';
import { ElementTypeSchema, RelationshipTypeSchema, type Metamodel } from '$lib/api/types';

/**
 * Comment-preserving surgical edits over the metamodel YAML draft
 * (spec 2026-08-13 §4). The DRAFT STRING stays canonical: callers parse it,
 * apply one semantic command to the Document, serialize, and hand the string
 * back to `editMetamodelBuffer`. This module is pure — no state, no I/O — so
 * every command is unit-testable against fixture text.
 *
 * Byte-identity for untouched lines is NOT the `yaml` package's default — it
 * requires BOTH stringify options below, matched against how this repo's
 * metamodels are actually authored (2-space indent, unpadded flow
 * collections like `{name: x}` and `[Draft, Active]`, e.g.
 * `examples/smart-city.metamodel.yaml`):
 *   - `lineWidth: 0` disables re-wrapping long lines.
 *   - `flowCollectionPadding: false` disables the emitter's default
 *     `{ name: x }` / `[ Draft, Active ]` inner-space padding, which
 *     otherwise rewrites every flow collection on serialize even when
 *     nothing was edited. Drop either option and a no-op parse→serialize
 *     round-trip of a real metamodel file stops being byte-identical.
 * Comments survive regardless (the `yaml` Document keeps them as node
 * properties), independent of these two options.
 */

export interface DraftError {
	message: string;
	line: number | null;
}

export interface ParsedDraft {
	doc: Document;
	/** null whenever `errors` is non-empty. */
	mm: Metamodel | null;
	errors: DraftError[];
}

const STRINGIFY_OPTS = { lineWidth: 0, flowCollectionPadding: false } as const;

// Raw YAML is the AUTHOR'S shape: `source`/`target` are the single-pair
// shorthand and may be absent entirely (abstract base with no mappings). The
// API's RelationshipTypeSchema requires them because the backend mirrors
// mappings[0]; this tolerant variant normalizes the same way client-side.
// When a relationship has no mappings at all (an abstract base like
// `Observes`), the normalized `source`/`target` fall back to `''` rather
// than staying undefined, so the result still satisfies `RelationshipType`'s
// non-nullable string fields.
const RawRelationshipSchema = RelationshipTypeSchema.extend({
	source: z.string().optional(),
	target: z.string().optional()
});

const RawMetamodelSchema = z.object({
	enums: z.record(z.string(), z.array(z.string())).default({}),
	elements: z.array(ElementTypeSchema).default([]),
	relationships: z.array(RawRelationshipSchema).default([])
});

export function parseDraft(buffer: string): ParsedDraft {
	const doc = parseDocument(buffer);
	const errors: DraftError[] = doc.errors.map((e) => ({
		message: e.message,
		line: e.linePos ? e.linePos[0].line : null
	}));
	if (errors.length > 0) return { doc, mm: null, errors };
	const raw = RawMetamodelSchema.safeParse(doc.toJS() ?? {});
	if (!raw.success) {
		const first = raw.error.issues[0];
		return {
			doc,
			mm: null,
			errors: [
				{
					message: first ? `${first.path.join('.')}: ${first.message}` : 'invalid metamodel shape',
					line: null
				}
			]
		};
	}
	const mm: Metamodel = {
		enums: raw.data.enums,
		elements: raw.data.elements,
		relationships: raw.data.relationships.map((r) => {
			const mappings =
				r.mappings.length > 0
					? r.mappings
					: r.source !== undefined && r.target !== undefined
						? [{ source: r.source, target: r.target }]
						: [];
			return {
				...r,
				mappings,
				source: mappings[0]?.source ?? '',
				target: mappings[0]?.target ?? ''
			};
		})
	};
	return { doc, mm, errors: [] };
}

export function serializeDraft(doc: Document): string {
	return doc.toString(STRINGIFY_OPTS);
}

// --- shared traversal helpers (used by the command handlers, Tasks 2-4) ----

export type SectionKey = 'elements' | 'relationships';

export function section(doc: Document, key: SectionKey): YAMLSeq | null {
	const node = doc.get(key);
	return isSeq(node) ? (node as YAMLSeq) : null;
}

export function typeMap(doc: Document, key: SectionKey, name: string): YAMLMap | null {
	const seq = section(doc, key);
	if (seq === null) return null;
	for (const item of seq.items) {
		if (isMap(item) && item.get('name') === name) return item as YAMLMap;
	}
	return null;
}

/** 1-based line span of a named type's block, for lint-error attribution.
 * Offsets come from the parsed node's `range`; lines are counted in the
 * ORIGINAL buffer, so call it with the same text the doc was parsed from. */
export function lineRangeForType(
	buffer: string,
	doc: Document,
	key: SectionKey,
	name: string
): { start: number; end: number } | null {
	const map = typeMap(doc, key, name);
	if (map === null || !map.range) return null;
	const [startOff, , endOff] = map.range;
	const lineAt = (off: number): number => {
		let line = 1;
		for (let i = 0; i < off && i < buffer.length; i++) if (buffer[i] === '\n') line++;
		return line;
	};
	return { start: lineAt(startOff), end: lineAt(Math.max(startOff, endOff - 1)) };
}
