import {
	parseDocument,
	isMap,
	isSeq,
	isScalar,
	type Document,
	type Pair,
	type Scalar,
	type YAMLMap,
	type YAMLSeq
} from 'yaml';
import { z } from 'zod';
import {
	ElementTypeSchema,
	RelationshipTypeSchema,
	type Metamodel,
	type PropertyDef,
	type Mapping
} from '$lib/api/types';

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

// --- semantic edit commands (Task 2: element-type & enum; Tasks 3-4 append
// property and relationship handlers to the same switch below) -------------

export class YamlEditError extends Error {}

/** Identifies the owner of a property edit: an element or a relationship
 * type, disambiguated because both sections share the same `name` space
 * only within themselves (an element and a relationship MAY share a name). */
export type TypeRef = { kind: 'element' | 'relationship'; name: string };

export type YamlEditCommand =
	| { kind: 'addElementType'; name: string }
	| { kind: 'removeElementType'; name: string }
	| { kind: 'renameElementType'; from: string; to: string }
	| { kind: 'setElementAbstract'; name: string; value: boolean }
	| { kind: 'setElementExtends'; name: string; value: string | null }
	| { kind: 'setElementKey'; name: string; key: string[] | null }
	| { kind: 'addEnum'; name: string; literals: string[] }
	| { kind: 'renameEnum'; from: string; to: string }
	| { kind: 'setEnumLiterals'; name: string; literals: string[] }
	| { kind: 'removeEnum'; name: string }
	// Task 3 adds the property commands; Task 4 the relationship commands.
	| { kind: 'addProperty'; owner: TypeRef; prop: PropertyDef }
	| { kind: 'updateProperty'; owner: TypeRef; propName: string; prop: PropertyDef }
	| { kind: 'removeProperty'; owner: TypeRef; propName: string }
	| { kind: 'addRelationshipType'; name: string; containment: boolean; mapping: Mapping | null }
	| { kind: 'removeRelationshipType'; name: string }
	| { kind: 'renameRelationshipType'; from: string; to: string }
	| { kind: 'setRelationshipAbstract'; name: string; value: boolean }
	| { kind: 'setRelationshipContainment'; name: string; value: boolean }
	| { kind: 'setRelationshipExtends'; name: string; value: string | null }
	| { kind: 'setEndMultiplicity'; name: string; end: 'source' | 'target'; value: string }
	| { kind: 'addMapping'; name: string; mapping: Mapping }
	| { kind: 'removeMapping'; name: string; mapping: Mapping };

function mustTypeMap(doc: Document, key: SectionKey, name: string): YAMLMap {
	const m = typeMap(doc, key, name);
	if (m === null) throw new YamlEditError(`unknown ${key} type: ${name}`);
	return m;
}

function ensureSection(doc: Document, key: SectionKey): YAMLSeq {
	const existing = section(doc, key);
	if (existing !== null) return existing;
	const seq = doc.createNode([]) as YAMLSeq;
	doc.set(key, seq);
	return seq;
}

/** Build a flow-style node (`{a: 1}` / `[a, b]`) for values that should read
 * as one line, matching the authored idiom (see the module docstring). */
function flowNode(doc: Document, value: unknown): ReturnType<Document['createNode']> {
	const node = doc.createNode(value);
	if (isMap(node) || isSeq(node)) (node as YAMLMap | YAMLSeq).flow = true;
	return node;
}

function eachTypeMap(doc: Document, key: SectionKey, fn: (m: YAMLMap) => void): void {
	const seq = section(doc, key);
	if (seq === null) return;
	for (const item of seq.items) if (isMap(item)) fn(item as YAMLMap);
}

function setOrDelete(m: YAMLMap, key: string, value: string | null): void {
	if (value === null) m.delete(key);
	else m.set(key, value);
}

/** Set a boolean attr, dropping the key entirely at its schema default so the
 * YAML stays as terse as an author would write it. */
function setBoolAttr(m: YAMLMap, key: string, value: boolean, deflt: boolean): void {
	if (value === deflt) m.delete(key);
	else m.set(key, value);
}

/** Keep the `source`/`target` shorthand mirroring mappings[0] (the backend's
 * `_normalize_endpoints` invariant), and drop all endpoint keys when no
 * mappings remain. Exported for Task 4's mapping-add/remove handlers, which
 * touch `mappings` directly and must resync the shorthand the same way. */
export function syncShorthand(m: YAMLMap): void {
	const maps = m.get('mappings');
	if (isSeq(maps) && (maps as YAMLSeq).items.length > 0) {
		const first = (maps as YAMLSeq).items[0];
		if (isMap(first)) {
			if (m.has('source')) m.set('source', (first as YAMLMap).get('source'));
			if (m.has('target')) m.set('target', (first as YAMLMap).get('target'));
		}
		return;
	}
	if (m.has('mappings')) m.delete('mappings');
	m.delete('source');
	m.delete('target');
}

/** Rename every `datatype: <from>` on a type's properties to `<to>`. Shared by
 * both element-type rename (a datatype can name an element, for a reference
 * property) and enum rename (a datatype can name an enum) — the predicate,
 * iteration and mutation are identical either way, so one helper covers
 * both call sites rather than duplicating the loop per caller. */
function renameDatatypeRefs(m: YAMLMap, from: string, to: string): void {
	const props = m.get('properties');
	if (!isSeq(props)) return;
	for (const p of (props as YAMLSeq).items) {
		if (isMap(p) && (p as YAMLMap).get('datatype') === from) (p as YAMLMap).set('datatype', to);
	}
}

/** Rename cascade for an element type: `extends` pointers, relationship
 * shorthand/`mappings` endpoints, and property `datatype`s across BOTH
 * sections. This is the auto-fixed half of the rename contract (spec §3);
 * anything the cascade can't reach (e.g. a `key` entry naming a relationship
 * end that no longer exists) is left for the lint pass to surface. */
function renameElementRefs(doc: Document, from: string, to: string): void {
	eachTypeMap(doc, 'elements', (m) => {
		if (m.get('extends') === from) m.set('extends', to);
		renameDatatypeRefs(m, from, to);
	});
	eachTypeMap(doc, 'relationships', (m) => {
		renameDatatypeRefs(m, from, to);
		if (m.get('source') === from) m.set('source', to);
		if (m.get('target') === from) m.set('target', to);
		const maps = m.get('mappings');
		if (isSeq(maps)) {
			for (const it of (maps as YAMLSeq).items) {
				if (!isMap(it)) continue;
				if ((it as YAMLMap).get('source') === from) (it as YAMLMap).set('source', to);
				if ((it as YAMLMap).get('target') === from) (it as YAMLMap).set('target', to);
			}
		}
	});
}

/** Dispatches one semantic edit command onto a parsed `Document` in place.
 * Every command either mutates the AST surgically (preserving comments and
 * untouched lines on the next `serializeDraft`) or throws `YamlEditError`
 * when its target doesn't exist — there is no silent no-op path, because a
 * caller building a command from a diagram click always expects the named
 * type to be there. */
export function applyEdit(doc: Document, cmd: YamlEditCommand): void {
	switch (cmd.kind) {
		case 'addElementType': {
			ensureSection(doc, 'elements').add(doc.createNode({ name: cmd.name }));
			return;
		}
		case 'removeElementType': {
			// Use the non-creating `section()` accessor, not `ensureSection`: a
			// throw must never leave a mutation behind, and `ensureSection`
			// would otherwise plant a stray `elements: []` into a draft that
			// has no elements section at all before we ever get to the throw.
			const seq = section(doc, 'elements');
			const idx =
				seq === null
					? -1
					: seq.items.findIndex((it) => isMap(it) && (it as YAMLMap).get('name') === cmd.name);
			if (seq === null || idx < 0) throw new YamlEditError(`unknown elements type: ${cmd.name}`);
			seq.items.splice(idx, 1);
			// Cascade (spec §3): mappings touching it and extends pointing at it
			// are auto-fixed; property datatypes / keys stay for lint to flag.
			eachTypeMap(doc, 'elements', (m) => {
				if (m.get('extends') === cmd.name) m.delete('extends');
			});
			eachTypeMap(doc, 'relationships', (m) => {
				const maps = m.get('mappings');
				if (isSeq(maps)) {
					(maps as YAMLSeq).items = (maps as YAMLSeq).items.filter(
						(it) =>
							!(
								isMap(it) &&
								((it as YAMLMap).get('source') === cmd.name ||
									(it as YAMLMap).get('target') === cmd.name)
							)
					);
					syncShorthand(m);
				} else if (m.get('source') === cmd.name || m.get('target') === cmd.name) {
					m.delete('source');
					m.delete('target');
				}
			});
			return;
		}
		case 'renameElementType': {
			mustTypeMap(doc, 'elements', cmd.from).set('name', cmd.to);
			renameElementRefs(doc, cmd.from, cmd.to);
			return;
		}
		case 'setElementAbstract':
			setBoolAttr(mustTypeMap(doc, 'elements', cmd.name), 'abstract', cmd.value, false);
			return;
		case 'setElementExtends':
			setOrDelete(mustTypeMap(doc, 'elements', cmd.name), 'extends', cmd.value);
			return;
		case 'setElementKey': {
			const m = mustTypeMap(doc, 'elements', cmd.name);
			if (cmd.key === null) m.delete('key');
			else m.set('key', flowNode(doc, cmd.key));
			return;
		}
		case 'addEnum': {
			let enums = doc.get('enums');
			if (!isMap(enums)) {
				doc.set('enums', doc.createNode({}));
				enums = doc.get('enums');
			}
			(enums as YAMLMap).set(cmd.name, flowNode(doc, cmd.literals));
			return;
		}
		case 'renameEnum': {
			const enums = doc.get('enums');
			if (!isMap(enums)) throw new YamlEditError('no enums section');
			const pair = (enums as YAMLMap).items.find(
				(p: Pair) => isScalar(p.key) && (p.key as Scalar).value === cmd.from
			);
			if (pair === undefined) throw new YamlEditError(`unknown enum: ${cmd.from}`);
			// In-place scalar mutation (not delete+set) so the pair keeps its
			// comments — a `set` on the map would create a brand-new pair at
			// the end, losing the inline `# comment` the test asserts on.
			(pair.key as Scalar).value = cmd.to;
			eachTypeMap(doc, 'elements', (m) => renameDatatypeRefs(m, cmd.from, cmd.to));
			eachTypeMap(doc, 'relationships', (m) => renameDatatypeRefs(m, cmd.from, cmd.to));
			return;
		}
		case 'setEnumLiterals': {
			const enums = doc.get('enums');
			if (!isMap(enums) || !(enums as YAMLMap).has(cmd.name))
				throw new YamlEditError(`unknown enum: ${cmd.name}`);
			(enums as YAMLMap).set(cmd.name, flowNode(doc, cmd.literals));
			return;
		}
		case 'removeEnum': {
			const enums = doc.get('enums');
			if (!isMap(enums) || !(enums as YAMLMap).delete(cmd.name))
				throw new YamlEditError(`unknown enum: ${cmd.name}`);
			return;
		}
		default:
			// Property + relationship commands land in Tasks 3-4; reaching here
			// with one of them is a wiring bug, not a user error.
			throw new YamlEditError(`unhandled command: ${(cmd as { kind: string }).kind}`);
	}
}
