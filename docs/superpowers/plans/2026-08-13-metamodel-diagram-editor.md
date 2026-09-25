# Metamodel Diagram Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an editable UML class-diagram view to the metamodel tab — topology edited on a Svelte Flow canvas, attributes in a selection-bound form panel — sharing the existing YAML draft/lint/preview/rebind/lease lifecycle, with comment-preserving YAML writeback and shared server-side node positions.

**Architecture:** The YAML string draft buffer stays canonical. A new pure module (`yaml-edit.ts`, built on the `yaml` npm package's Document API) applies semantic edit commands as surgical YAML mutations and writes the result back through the existing `editMetamodelBuffer` path, so lease/draft/lint/dirty all work unchanged. A pure `diagram-build.ts` derives Svelte Flow nodes/edges from the parsed metamodel; positions come from a new `metamodel_layouts` table via `GET/PUT /metamodel/layout`; elkjs provides Auto-arrange.

**Tech Stack:** SvelteKit 5 (runes), `@xyflow/svelte` (already a dep), `yaml` (new dep), `elkjs` (new dep), zod, vitest + happy-dom; FastAPI + SQLAlchemy + Alembic on the backend.

**Spec:** `docs/superpowers/specs/2026-08-13-metamodel-diagram-editor-design.md`

## Global Constraints

- Everything runs through pixi. Frontend single-file tests: `pixi run -e frontend npm --prefix frontend run test -- <path>`; full: `pixi run frontend-test`. Backend: `pixi run -e core-dev pytest <path> -v`; full: `pixi run core-test`. Lint: `pixi run dr-tidy` (ruff+mypy+pyright+prettier must all pass).
- Buffer editing is **owner-only** (existing `isEditBlocked()`); editors/viewers get a read-only canvas. `PUT /metamodel/layout` is editors+ (method-based authz handles it).
- Layout is presentation: no `mm` lease, no commit journal entry, last-write-wins.
- Comments in the YAML must survive diagram edits (`yaml` Document API round-trip; stringify with `lineWidth: 0`).
- The metamodel-editor lifecycle module (`metamodel-editor.svelte.ts`) must NOT be restructured — the diagram composes it exclusively through its existing exports (`getMetamodelEditor`, `editMetamodelBuffer`).
- Docstring density: match the repo's why-focused comment style in new modules.
- Commit after every task. Branch: `feat/metamodel-diagram-editor` (created by the worktree/execution skill).

---

### Task 1: `yaml-edit.ts` — dependencies, parse + serialize core

**Files:**
- Modify: `frontend/package.json` (add `yaml`, `elkjs` to `dependencies`)
- Create: `frontend/src/lib/metamodel/yaml-edit.ts`
- Test: `frontend/src/lib/metamodel/__tests__/yaml-edit.test.ts`

**Interfaces:**
- Produces: `parseDraft(buffer: string): ParsedDraft` where `ParsedDraft = { doc: Document; mm: Metamodel | null; errors: DraftError[] }`, `DraftError = { message: string; line: number | null }`; `serializeDraft(doc: Document): string`; `lineRangeForType(buffer: string, doc: Document, section: 'elements' | 'relationships', name: string): { start: number; end: number } | null` (1-based lines). `mm` reuses the zod `Metamodel` type from `$lib/api/types`.

- [ ] **Step 1: Install dependencies**

```bash
pixi run -e frontend npm --prefix frontend install yaml elkjs
```

Verify `frontend/package.json` now lists both under `dependencies` (they ship in the client bundle).

- [ ] **Step 2: Write the failing tests**

`frontend/src/lib/metamodel/__tests__/yaml-edit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseDraft, serializeDraft, lineRangeForType } from '../yaml-edit';

/** Shared fixture for every yaml-edit suite: comments + flow props + shorthand
 * endpoints + an abstract mapless relationship, i.e. every shape the smart-city
 * metamodel uses. Comment survival is THE contract under test. */
export const FIXTURE = `## smart-city excerpt — file comment must survive
enums:
  Status: [Draft, Active] # inline comment
elements:
  # the abstract root
  - name: NamedElement
    abstract: true
    properties:
      - {name: name, datatype: string, multiplicity: "1", max_length: 200}
    key: [name]
  - name: Zone
    extends: NamedElement
    properties:
      - {name: area, datatype: float, min: 0}
  - name: Building
    extends: NamedElement
relationships:
  - name: Observes
    abstract: true
  - name: Contains
    containment: true
    source: Zone
    target: Building
    source_multiplicity: "1"
  - name: Monitors
    extends: Observes
    source: Building
    target: Zone
    properties:
      - {name: since, datatype: date}
`;

describe('parseDraft', () => {
	it('parses the fixture into the API Metamodel shape', () => {
		const { mm, errors } = parseDraft(FIXTURE);
		expect(errors).toEqual([]);
		expect(mm).not.toBeNull();
		expect(mm!.elements.map((e) => e.name)).toEqual(['NamedElement', 'Zone', 'Building']);
		expect(mm!.enums).toEqual({ Status: ['Draft', 'Active'] });
	});

	it('normalizes shorthand endpoints into mappings', () => {
		const { mm } = parseDraft(FIXTURE);
		const contains = mm!.relationships.find((r) => r.name === 'Contains')!;
		expect(contains.mappings).toEqual([{ source: 'Zone', target: 'Building' }]);
		expect(contains.source).toBe('Zone');
	});

	it('tolerates an abstract relationship with no endpoints at all', () => {
		const { mm } = parseDraft(FIXTURE);
		const observes = mm!.relationships.find((r) => r.name === 'Observes')!;
		expect(observes.mappings).toEqual([]);
	});

	it('reports a line-anchored error for broken syntax and mm stays null', () => {
		const { mm, errors } = parseDraft('elements:\n  - name: [unclosed\n');
		expect(mm).toBeNull();
		expect(errors.length).toBeGreaterThan(0);
	});

	it('round-trips the fixture byte-identically when nothing was edited', () => {
		const { doc } = parseDraft(FIXTURE);
		expect(serializeDraft(doc)).toBe(FIXTURE);
	});
});

describe('lineRangeForType', () => {
	it('locates the Zone block', () => {
		const { doc } = parseDraft(FIXTURE);
		const range = lineRangeForType(FIXTURE, doc, 'elements', 'Zone');
		expect(range).not.toBeNull();
		expect(FIXTURE.split('\n')[range!.start - 1]).toContain('name: Zone');
	});

	it('returns null for an unknown type', () => {
		const { doc } = parseDraft(FIXTURE);
		expect(lineRangeForType(FIXTURE, doc, 'elements', 'Nope')).toBeNull();
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/yaml-edit.test.ts`
Expected: FAIL — module `../yaml-edit` not found.

- [ ] **Step 4: Implement the core**

`frontend/src/lib/metamodel/yaml-edit.ts`:

```ts
import { parseDocument, isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { z } from 'zod';
import {
	ElementTypeSchema,
	RelationshipTypeSchema,
	type Metamodel
} from '$lib/api/types';

/**
 * Comment-preserving surgical edits over the metamodel YAML draft
 * (spec 2026-08-13 §4). The DRAFT STRING stays canonical: callers parse it,
 * apply one semantic command to the Document, serialize, and hand the string
 * back to `editMetamodelBuffer`. This module is pure — no state, no I/O — so
 * every command is unit-testable against fixture text.
 *
 * Stringify uses `lineWidth: 0` (no re-wrapping): untouched lines survive
 * byte-identical for standard 2-space-indented sources, and comments survive
 * always (the `yaml` Document keeps them as node properties).
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

const STRINGIFY_OPTS = { lineWidth: 0 } as const;

// Raw YAML is the AUTHOR'S shape: `source`/`target` are the single-pair
// shorthand and may be absent entirely (abstract base with no mappings). The
// API's RelationshipTypeSchema requires them because the backend mirrors
// mappings[0]; this tolerant variant normalizes the same way client-side.
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
			errors: [{ message: first ? `${first.path.join('.')}: ${first.message}` : 'invalid metamodel shape', line: null }]
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
			return { ...r, mappings, source: mappings[0]?.source ?? '', target: mappings[0]?.target ?? '' };
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/yaml-edit.test.ts`
Expected: PASS (all). If the byte-identity test fails, diff actual vs fixture — the fixture must use 2-space indent and flow styles exactly as the emitter produces them; adjust the FIXTURE (not the assertion) until an *unedited* round-trip is stable, keeping all comments and one flow-style property line.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/metamodel/yaml-edit.ts frontend/src/lib/metamodel/__tests__/yaml-edit.test.ts
git commit -m "feat(frontend): yaml-edit core — comment-preserving metamodel draft parse/serialize"
```

---

### Task 2: `yaml-edit.ts` — element-type & enum commands with cascades

**Files:**
- Modify: `frontend/src/lib/metamodel/yaml-edit.ts`
- Test: `frontend/src/lib/metamodel/__tests__/yaml-edit-commands.test.ts`

**Interfaces:**
- Produces: `applyEdit(doc: Document, cmd: YamlEditCommand): void` (throws `YamlEditError` on a missing target) and the `YamlEditCommand` union members: `addElementType {name}`, `removeElementType {name}`, `renameElementType {from,to}`, `setElementAbstract {name,value}`, `setElementExtends {name,value: string|null}`, `setElementKey {name,key: string[]|null}`, `addEnum {name,literals}`, `renameEnum {from,to}`, `setEnumLiterals {name,literals}`, `removeEnum {name}`. Also exports `syncShorthand(m: YAMLMap): void` for Task 4.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/metamodel/__tests__/yaml-edit-commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyEdit, parseDraft, serializeDraft } from '../yaml-edit';
import { FIXTURE } from './yaml-edit.test';

function run(buffer: string, cmds: Parameters<typeof applyEdit>[1][]): string {
	const { doc, errors } = parseDraft(buffer);
	expect(errors).toEqual([]);
	for (const c of cmds) applyEdit(doc, c);
	return serializeDraft(doc);
}

describe('element type commands', () => {
	it('addElementType appends a named block and preserves every other line', () => {
		const out = run(FIXTURE, [{ kind: 'addElementType', name: 'Sensor' }]);
		expect(out).toContain('- name: Sensor');
		for (const line of FIXTURE.split('\n')) expect(out).toContain(line);
	});

	it('setElementAbstract / setElementExtends write and clear attrs', () => {
		let out = run(FIXTURE, [{ kind: 'setElementAbstract', name: 'Zone', value: true }]);
		expect(parseDraft(out).mm!.elements.find((e) => e.name === 'Zone')!.abstract).toBe(true);
		out = run(FIXTURE, [{ kind: 'setElementExtends', name: 'Zone', value: null }]);
		expect(out).not.toMatch(/name: Zone\n\s+extends:/);
	});

	it('renameElementType cascades extends, mappings, shorthand and datatypes', () => {
		const withRef = FIXTURE.replace(
			'- {name: area, datatype: float, min: 0}',
			'- {name: area, datatype: float, min: 0}\n      - {name: main_building, datatype: Building}'
		);
		const out = run(withRef, [{ kind: 'renameElementType', from: 'Building', to: 'Facility' }]);
		const mm = parseDraft(out).mm!;
		expect(mm.elements.some((e) => e.name === 'Facility')).toBe(true);
		expect(out).not.toContain('Building');
		const contains = mm.relationships.find((r) => r.name === 'Contains')!;
		expect(contains.mappings[0]).toEqual({ source: 'Zone', target: 'Facility' });
	});

	it('renameElementType keeps the # comment above the renamed block', () => {
		const out = run(FIXTURE, [{ kind: 'renameElementType', from: 'NamedElement', to: 'Root' }]);
		expect(out).toContain('# the abstract root');
	});

	it('removeElementType drops mappings touching it and clears extends to it', () => {
		const out = run(FIXTURE, [{ kind: 'removeElementType', name: 'Building' }]);
		const mm = parseDraft(out).mm!;
		expect(mm.elements.some((e) => e.name === 'Building')).toBe(false);
		const contains = mm.relationships.find((r) => r.name === 'Contains')!;
		expect(contains.mappings).toEqual([]); // its only pair touched Building
		const monitors = mm.relationships.find((r) => r.name === 'Monitors')!;
		expect(monitors.mappings).toEqual([]);
	});

	it('setElementKey writes a flow list and null removes it', () => {
		let out = run(FIXTURE, [{ kind: 'setElementKey', name: 'Zone', key: ['name', 'out:Contains'] }]);
		expect(out).toContain('key: [name, out:Contains]');
		out = run(out, [{ kind: 'setElementKey', name: 'Zone', key: null }]);
		expect(out).not.toMatch(/name: Zone[\s\S]*?key:/);
	});

	it('throws YamlEditError for an unknown target', () => {
		const { doc } = parseDraft(FIXTURE);
		expect(() => applyEdit(doc, { kind: 'setElementAbstract', name: 'Nope', value: true })).toThrow();
	});
});

describe('enum commands', () => {
	it('addEnum / setEnumLiterals / removeEnum', () => {
		let out = run(FIXTURE, [{ kind: 'addEnum', name: 'Health', literals: ['Ok', 'Bad'] }]);
		expect(parseDraft(out).mm!.enums.Health).toEqual(['Ok', 'Bad']);
		out = run(out, [{ kind: 'setEnumLiterals', name: 'Health', literals: ['Ok'] }]);
		expect(parseDraft(out).mm!.enums.Health).toEqual(['Ok']);
		out = run(out, [{ kind: 'removeEnum', name: 'Health' }]);
		expect(parseDraft(out).mm!.enums.Health).toBeUndefined();
	});

	it('renameEnum keeps the inline comment and cascades datatypes', () => {
		const withEnumProp = FIXTURE.replace(
			'- {name: area, datatype: float, min: 0}',
			'- {name: status, datatype: Status}'
		);
		const out = run(withEnumProp, [{ kind: 'renameEnum', from: 'Status', to: 'State' }]);
		expect(out).toContain('State: [Draft, Active] # inline comment');
		expect(parseDraft(out).mm!.elements.find((e) => e.name === 'Zone')!.properties[0].datatype).toBe('State');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/yaml-edit-commands.test.ts`
Expected: FAIL — `applyEdit` not exported.

- [ ] **Step 3: Implement**

Append to `frontend/src/lib/metamodel/yaml-edit.ts`:

```ts
import { isScalar, type Pair, type Scalar } from 'yaml'; // merge into the existing import

export class YamlEditError extends Error {}

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
 * mappings remain. */
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

function renameElementRefs(doc: Document, from: string, to: string): void {
	const renameDatatypes = (m: YAMLMap): void => {
		const props = m.get('properties');
		if (!isSeq(props)) return;
		for (const p of (props as YAMLSeq).items) {
			if (isMap(p) && (p as YAMLMap).get('datatype') === from) (p as YAMLMap).set('datatype', to);
		}
	};
	eachTypeMap(doc, 'elements', (m) => {
		if (m.get('extends') === from) m.set('extends', to);
		renameDatatypes(m);
	});
	eachTypeMap(doc, 'relationships', (m) => {
		renameDatatypes(m);
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

export function applyEdit(doc: Document, cmd: YamlEditCommand): void {
	switch (cmd.kind) {
		case 'addElementType': {
			ensureSection(doc, 'elements').add(doc.createNode({ name: cmd.name }));
			return;
		}
		case 'removeElementType': {
			const seq = ensureSection(doc, 'elements');
			const idx = seq.items.findIndex((it) => isMap(it) && (it as YAMLMap).get('name') === cmd.name);
			if (idx < 0) throw new YamlEditError(`unknown elements type: ${cmd.name}`);
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
							!(isMap(it) && ((it as YAMLMap).get('source') === cmd.name || (it as YAMLMap).get('target') === cmd.name))
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
			(pair.key as Scalar).value = cmd.to; // in-place: keeps the pair's comments
			eachTypeMap(doc, 'elements', (m) => renameEnumDatatype(m, cmd.from, cmd.to));
			eachTypeMap(doc, 'relationships', (m) => renameEnumDatatype(m, cmd.from, cmd.to));
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

function renameEnumDatatype(m: YAMLMap, from: string, to: string): void {
	const props = m.get('properties');
	if (!isSeq(props)) return;
	for (const p of (props as YAMLSeq).items) {
		if (isMap(p) && (p as YAMLMap).get('datatype') === from) (p as YAMLMap).set('datatype', to);
	}
}
```

Add `PropertyDef` and `Mapping` to the existing `$lib/api/types` import in the file header.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/yaml-edit-commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/metamodel/
git commit -m "feat(frontend): yaml-edit element-type and enum commands with rename/delete cascades"
```

---

### Task 3: `yaml-edit.ts` — property commands

**Files:**
- Modify: `frontend/src/lib/metamodel/yaml-edit.ts`
- Test: `frontend/src/lib/metamodel/__tests__/yaml-edit-properties.test.ts`

**Interfaces:**
- Consumes: `applyEdit`, `TypeRef`, helpers from Tasks 1-2.
- Produces: working `addProperty`/`updateProperty`/`removeProperty` command handlers. Property emission drops schema defaults (`multiplicity` omitted at `'0..1'`, null facets omitted) and writes flow-style maps matching the repo's YAML idiom.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/metamodel/__tests__/yaml-edit-properties.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyEdit, parseDraft, serializeDraft, type YamlEditCommand } from '../yaml-edit';
import { FIXTURE } from './yaml-edit.test';

function run(buffer: string, cmds: YamlEditCommand[]): string {
	const { doc } = parseDraft(buffer);
	for (const c of cmds) applyEdit(doc, c);
	return serializeDraft(doc);
}

const P = (over: Record<string, unknown> = {}) => ({
	name: 'height',
	datatype: 'float',
	multiplicity: '0..1',
	min: null,
	max: null,
	pattern: null,
	max_length: null,
	...over
});

describe('property commands', () => {
	it('addProperty writes a flow map without default-valued fields', () => {
		const out = run(FIXTURE, [
			{ kind: 'addProperty', owner: { kind: 'element', name: 'Building' }, prop: P({ min: 0 }) }
		]);
		expect(out).toContain('- {name: height, datatype: float, min: 0}');
		expect(out).not.toContain('multiplicity: 0..1'); // default omitted
	});

	it('addProperty creates the properties seq when absent', () => {
		const out = run(FIXTURE, [
			{ kind: 'addProperty', owner: { kind: 'relationship', name: 'Contains' }, prop: P() }
		]);
		const rel = parseDraft(out).mm!.relationships.find((r) => r.name === 'Contains')!;
		expect(rel.properties.map((p) => p.name)).toEqual(['height']);
	});

	it('updateProperty renames and adjusts facets in place', () => {
		const out = run(FIXTURE, [
			{
				kind: 'updateProperty',
				owner: { kind: 'element', name: 'Zone' },
				propName: 'area',
				prop: P({ name: 'surface', datatype: 'float', min: 1, max: 9000 })
			}
		]);
		const zone = parseDraft(out).mm!.elements.find((e) => e.name === 'Zone')!;
		expect(zone.properties[0]).toMatchObject({ name: 'surface', min: 1, max: 9000 });
		expect(out).toContain('# the abstract root'); // untouched comment survives
	});

	it('updateProperty deletes facets set back to null', () => {
		const out = run(FIXTURE, [
			{
				kind: 'updateProperty',
				owner: { kind: 'element', name: 'Zone' },
				propName: 'area',
				prop: P({ name: 'area', min: null })
			}
		]);
		expect(out).not.toMatch(/name: area[^}]*min/);
	});

	it('removeProperty drops only the named row', () => {
		const out = run(FIXTURE, [
			{ kind: 'removeProperty', owner: { kind: 'element', name: 'NamedElement' }, propName: 'name' }
		]);
		const root = parseDraft(out).mm!.elements.find((e) => e.name === 'NamedElement')!;
		expect(root.properties).toEqual([]);
	});

	it('unknown property throws', () => {
		const { doc } = parseDraft(FIXTURE);
		expect(() =>
			applyEdit(doc, { kind: 'removeProperty', owner: { kind: 'element', name: 'Zone' }, propName: 'nope' })
		).toThrow();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/yaml-edit-properties.test.ts`
Expected: FAIL — "unhandled command: addProperty".

- [ ] **Step 3: Implement**

Replace the `default:` arm's property placeholder by inserting these cases into `applyEdit` (before `default:`), plus the helpers below:

```ts
		case 'addProperty': {
			const m = mustTypeMap(doc, sectionOf(cmd.owner), cmd.owner.name);
			let props = m.get('properties');
			if (!isSeq(props)) {
				m.set('properties', doc.createNode([]));
				props = m.get('properties');
			}
			(props as YAMLSeq).add(propNode(doc, cmd.prop));
			return;
		}
		case 'updateProperty': {
			const row = mustPropMap(doc, cmd.owner, cmd.propName);
			row.set('name', cmd.prop.name);
			row.set('datatype', cmd.prop.datatype);
			if (cmd.prop.multiplicity === '0..1') row.delete('multiplicity');
			else row.set('multiplicity', cmd.prop.multiplicity);
			for (const [key, value] of [
				['min', cmd.prop.min],
				['max', cmd.prop.max],
				['pattern', cmd.prop.pattern],
				['max_length', cmd.prop.max_length]
			] as const) {
				if (value === null) row.delete(key);
				else row.set(key, value);
			}
			return;
		}
		case 'removeProperty': {
			const m = mustTypeMap(doc, sectionOf(cmd.owner), cmd.owner.name);
			const props = m.get('properties');
			if (!isSeq(props)) throw new YamlEditError(`no properties on ${cmd.owner.name}`);
			const idx = (props as YAMLSeq).items.findIndex(
				(it) => isMap(it) && (it as YAMLMap).get('name') === cmd.propName
			);
			if (idx < 0) throw new YamlEditError(`unknown property: ${cmd.propName}`);
			(props as YAMLSeq).items.splice(idx, 1);
			if ((props as YAMLSeq).items.length === 0) m.delete('properties');
			return;
		}
```

Helpers (module level):

```ts
function sectionOf(owner: TypeRef): SectionKey {
	return owner.kind === 'element' ? 'elements' : 'relationships';
}

function mustPropMap(doc: Document, owner: TypeRef, propName: string): YAMLMap {
	const m = mustTypeMap(doc, sectionOf(owner), owner.name);
	const props = m.get('properties');
	if (isSeq(props)) {
		for (const it of (props as YAMLSeq).items) {
			if (isMap(it) && (it as YAMLMap).get('name') === propName) return it as YAMLMap;
		}
	}
	throw new YamlEditError(`unknown property: ${propName}`);
}

/** Emit the author idiom: flow map, defaults omitted. */
function propNode(doc: Document, p: PropertyDef): YAMLMap {
	const o: Record<string, unknown> = { name: p.name, datatype: p.datatype };
	if (p.multiplicity !== '0..1') o.multiplicity = p.multiplicity;
	if (p.min !== null) o.min = p.min;
	if (p.max !== null) o.max = p.max;
	if (p.pattern !== null) o.pattern = p.pattern;
	if (p.max_length !== null) o.max_length = p.max_length;
	return flowNode(doc, o) as YAMLMap;
}
```

- [ ] **Step 4: Run tests — this file AND the previous two — to verify green**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/metamodel/
git commit -m "feat(frontend): yaml-edit property commands (flow-style, defaults omitted)"
```

---

### Task 4: `yaml-edit.ts` — relationship & mapping commands

**Files:**
- Modify: `frontend/src/lib/metamodel/yaml-edit.ts`
- Test: `frontend/src/lib/metamodel/__tests__/yaml-edit-relationships.test.ts`

**Interfaces:**
- Produces: working handlers for `addRelationshipType`, `removeRelationshipType`, `renameRelationshipType` (cascades: relationship `extends`, key DSL `out:`/`in:` entries), `setRelationshipAbstract`, `setRelationshipContainment`, `setRelationshipExtends`, `setEndMultiplicity`, `addMapping`, `removeMapping`. Endpoint policy: a single pair uses the `source`/`target` shorthand; a second mapping materializes an explicit `mappings:` flow list (shorthand kept mirroring `mappings[0]` if present); once materialized, never converted back.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/metamodel/__tests__/yaml-edit-relationships.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyEdit, parseDraft, serializeDraft, type YamlEditCommand } from '../yaml-edit';
import { FIXTURE } from './yaml-edit.test';

function run(buffer: string, cmds: YamlEditCommand[]): string {
	const { doc } = parseDraft(buffer);
	for (const c of cmds) applyEdit(doc, c);
	return serializeDraft(doc);
}

describe('relationship commands', () => {
	it('addRelationshipType with a first mapping uses the shorthand', () => {
		const out = run(FIXTURE, [
			{ kind: 'addRelationshipType', name: 'Powers', containment: false, mapping: { source: 'Zone', target: 'Building' } }
		]);
		expect(out).toMatch(/- name: Powers\n\s+source: Zone\n\s+target: Building/);
	});

	it('addRelationshipType with no mapping emits only the name (abstract-authorable)', () => {
		const out = run(FIXTURE, [{ kind: 'addRelationshipType', name: 'Feeds', containment: false, mapping: null }]);
		const rel = parseDraft(out).mm!.relationships.find((r) => r.name === 'Feeds')!;
		expect(rel.mappings).toEqual([]);
	});

	it('a second mapping materializes an explicit mappings list, shorthand mirrors first', () => {
		const out = run(FIXTURE, [
			{ kind: 'addMapping', name: 'Contains', mapping: { source: 'Zone', target: 'Zone' } }
		]);
		const rel = parseDraft(out).mm!.relationships.find((r) => r.name === 'Contains')!;
		expect(rel.mappings).toEqual([
			{ source: 'Zone', target: 'Building' },
			{ source: 'Zone', target: 'Zone' }
		]);
		expect(out).toContain('mappings:');
	});

	it('removeMapping on the shorthand-only pair drops the endpoint keys', () => {
		const out = run(FIXTURE, [
			{ kind: 'removeMapping', name: 'Monitors', mapping: { source: 'Building', target: 'Zone' } }
		]);
		const rel = parseDraft(out).mm!.relationships.find((r) => r.name === 'Monitors')!;
		expect(rel.mappings).toEqual([]);
	});

	it('renameRelationshipType cascades rel extends and key DSL entries', () => {
		const withDsl = FIXTURE.replace('key: [name]', 'key: [name, out:Monitors]');
		const out = run(withDsl, [{ kind: 'renameRelationshipType', from: 'Monitors', to: 'Watches' }]);
		expect(out).toContain('key: [name, out:Watches]');
		const child = parseDraft(out).mm!.relationships.find((r) => r.name === 'Watches')!;
		expect(child.extends).toBe('Observes');
		const renamedBase = run(out, [{ kind: 'renameRelationshipType', from: 'Observes', to: 'Sees' }]);
		expect(parseDraft(renamedBase).mm!.relationships.find((r) => r.name === 'Watches')!.extends).toBe('Sees');
	});

	it('setEndMultiplicity and containment toggles round-trip', () => {
		const out = run(FIXTURE, [
			{ kind: 'setEndMultiplicity', name: 'Contains', end: 'target', value: '1..*' },
			{ kind: 'setRelationshipContainment', name: 'Monitors', value: true }
		]);
		const mm = parseDraft(out).mm!;
		expect(mm.relationships.find((r) => r.name === 'Contains')!.target_multiplicity).toBe('1..*');
		expect(mm.relationships.find((r) => r.name === 'Monitors')!.containment).toBe(true);
	});

	it('removeRelationshipType clears key DSL references? no — leaves them for lint', () => {
		const withDsl = FIXTURE.replace('key: [name]', 'key: [name, out:Contains]');
		const out = run(withDsl, [{ kind: 'removeRelationshipType', name: 'Contains' }]);
		expect(out).toContain('out:Contains'); // deliberate: lint flags it (spec §3)
		expect(parseDraft(out).mm!.relationships.some((r) => r.name === 'Contains')).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/yaml-edit-relationships.test.ts`
Expected: FAIL — "unhandled command: addRelationshipType".

- [ ] **Step 3: Implement**

Insert into `applyEdit` (before `default:`):

```ts
		case 'addRelationshipType': {
			const o: Record<string, unknown> = { name: cmd.name };
			if (cmd.containment) o.containment = true;
			if (cmd.mapping !== null) {
				o.source = cmd.mapping.source;
				o.target = cmd.mapping.target;
			}
			ensureSection(doc, 'relationships').add(doc.createNode(o));
			return;
		}
		case 'removeRelationshipType': {
			const seq = ensureSection(doc, 'relationships');
			const idx = seq.items.findIndex((it) => isMap(it) && (it as YAMLMap).get('name') === cmd.name);
			if (idx < 0) throw new YamlEditError(`unknown relationships type: ${cmd.name}`);
			seq.items.splice(idx, 1);
			// extends pointing at it is auto-cleared; key DSL entries stay for lint.
			eachTypeMap(doc, 'relationships', (m) => {
				if (m.get('extends') === cmd.name) m.delete('extends');
			});
			return;
		}
		case 'renameRelationshipType': {
			mustTypeMap(doc, 'relationships', cmd.from).set('name', cmd.to);
			eachTypeMap(doc, 'relationships', (m) => {
				if (m.get('extends') === cmd.from) m.set('extends', cmd.to);
			});
			// key DSL: scalar entries `out:<Rel>` / `in:<Rel>` inside element keys
			eachTypeMap(doc, 'elements', (m) => {
				const key = m.get('key');
				if (!isSeq(key)) return;
				for (const entry of (key as YAMLSeq).items) {
					if (!isScalar(entry)) continue;
					const v = (entry as Scalar).value;
					if (v === `out:${cmd.from}`) (entry as Scalar).value = `out:${cmd.to}`;
					if (v === `in:${cmd.from}`) (entry as Scalar).value = `in:${cmd.to}`;
				}
			});
			return;
		}
		case 'setRelationshipAbstract':
			setBoolAttr(mustTypeMap(doc, 'relationships', cmd.name), 'abstract', cmd.value, false);
			return;
		case 'setRelationshipContainment':
			setBoolAttr(mustTypeMap(doc, 'relationships', cmd.name), 'containment', cmd.value, false);
			return;
		case 'setRelationshipExtends':
			setOrDelete(mustTypeMap(doc, 'relationships', cmd.name), 'extends', cmd.value);
			return;
		case 'setEndMultiplicity': {
			const m = mustTypeMap(doc, 'relationships', cmd.name);
			const key = cmd.end === 'source' ? 'source_multiplicity' : 'target_multiplicity';
			if (cmd.value === '0..*') m.delete(key);
			else m.set(key, cmd.value);
			return;
		}
		case 'addMapping': {
			const m = mustTypeMap(doc, 'relationships', cmd.name);
			const existing = m.get('mappings');
			if (isSeq(existing)) {
				(existing as YAMLSeq).add(flowNode(doc, cmd.mapping));
				syncShorthand(m);
			} else if (m.has('source') && m.has('target')) {
				// Second pair: materialize the explicit list, shorthand stays as
				// the first pair's mirror. Never converted back (comment safety).
				const seq = doc.createNode([
					{ source: m.get('source'), target: m.get('target') },
					cmd.mapping
				]) as YAMLSeq;
				for (const it of seq.items) if (isMap(it)) (it as YAMLMap).flow = true;
				m.set('mappings', seq);
			} else {
				m.set('source', cmd.mapping.source);
				m.set('target', cmd.mapping.target);
			}
			return;
		}
		case 'removeMapping': {
			const m = mustTypeMap(doc, 'relationships', cmd.name);
			const maps = m.get('mappings');
			if (isSeq(maps)) {
				const idx = (maps as YAMLSeq).items.findIndex(
					(it) =>
						isMap(it) &&
						(it as YAMLMap).get('source') === cmd.mapping.source &&
						(it as YAMLMap).get('target') === cmd.mapping.target
				);
				if (idx < 0) throw new YamlEditError('unknown mapping');
				(maps as YAMLSeq).items.splice(idx, 1);
				syncShorthand(m);
			} else if (m.get('source') === cmd.mapping.source && m.get('target') === cmd.mapping.target) {
				m.delete('source');
				m.delete('target');
			} else {
				throw new YamlEditError('unknown mapping');
			}
			return;
		}
```

- [ ] **Step 4: Run the full yaml-edit suite**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/`
Expected: PASS. Then delete the now-dead "Task 3 adds…" comment lines from the command union if still present.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/metamodel/
git commit -m "feat(frontend): yaml-edit relationship and mapping commands with shorthand policy"
```

---

### Task 5: Backend — `metamodel_layouts` table, migration, routes

**Files:**
- Modify: `src/data_rover/api/db_models.py` (append `MetamodelLayoutRow` after `ViewRow`)
- Modify: `src/data_rover/api/content.py` (two service functions)
- Create: `alembic/versions/0010_metamodel_layouts.py`
- Create: `src/data_rover/api/routes/metamodel_layout.py`
- Modify: `src/data_rover/api/main.py` (mount the router next to the other `metamodel` mounts)
- Test: `tests/api/test_metamodel_layout.py`

**Interfaces:**
- Produces: `GET /api/v1/projects/{project_id}/metamodel/layout` → `{"positions": {"el:Zone": {"x": 0.0, "y": 0.0}, …}}` (empty `positions` when never saved); `PUT` same path with same body → 204. Service: `content.get_metamodel_layout(db, project_id) -> dict | None`, `content.put_metamodel_layout(db, project_id, blob: dict) -> None`.

- [ ] **Step 1: Read the neighbors first**

Read `src/data_rover/api/authz.py` (confirm `require_membership` import path and that PUT is write-detected), `src/data_rover/api/content.py` (docstring style + `_utcnow` availability), and `tests/api/conftest.py:78-123` (`AUTH_HEADERS`, `seed_default_project`, `papi`).

- [ ] **Step 2: Write the failing tests**

`tests/api/test_metamodel_layout.py`:

```python
"""GET/PUT /metamodel/layout — shared canvas positions (spec 2026-08-13 §5).

Presentation-only: last-write-wins, no lease, no commit journal entry. The
authz matrix is the standard method-based one: any member reads, editors+
write, viewers 403 on PUT, non-members 403, unknown project 404.
"""

from data_rover.api import db
from data_rover.api.db_models import Membership, Role, User
from data_rover.api.tenancy import DEFAULT_PROJECT_ID  # adjust import if it lives elsewhere

from .conftest import AUTH_HEADERS, papi, seed_default_project

VIEWER_HEADERS = {"x-user-id": "viewer-user", "x-user-email": "viewer@example.com"}
STRANGER_HEADERS = {"x-user-id": "stranger", "x-user-email": "stranger@example.com"}

PAYLOAD = {"positions": {"el:Zone": {"x": 12.5, "y": -40.0}, "enum:Status": {"x": 0, "y": 0}}}


def _seed_viewer() -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, "viewer-user") is None:
            s.add(User(id="viewer-user", email="viewer@example.com"))
            s.add(
                Membership(
                    user_id="viewer-user", project_id=DEFAULT_PROJECT_ID, role=Role.viewer
                )
            )
            s.commit()
    finally:
        gen.close()


def test_get_layout_empty_before_any_save(client):
    seed_default_project()
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.json() == {"positions": {}}


def test_put_then_get_round_trips(client):
    seed_default_project()
    r = client.put(papi("/metamodel/layout"), json=PAYLOAD, headers=AUTH_HEADERS)
    assert r.status_code == 204
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.json()["positions"]["el:Zone"] == {"x": 12.5, "y": -40.0}


def test_put_overwrites_last_write_wins(client):
    seed_default_project()
    client.put(papi("/metamodel/layout"), json=PAYLOAD, headers=AUTH_HEADERS)
    second = {"positions": {"el:Zone": {"x": 1.0, "y": 2.0}}}
    client.put(papi("/metamodel/layout"), json=second, headers=AUTH_HEADERS)
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.json() == second


def test_viewer_reads_but_cannot_write(client):
    seed_default_project()
    _seed_viewer()
    assert client.get(papi("/metamodel/layout"), headers=VIEWER_HEADERS).status_code == 200
    r = client.put(papi("/metamodel/layout"), json=PAYLOAD, headers=VIEWER_HEADERS)
    assert r.status_code == 403


def test_non_member_403_unknown_project_404(client):
    seed_default_project()
    assert (
        client.get(papi("/metamodel/layout"), headers=STRANGER_HEADERS).status_code == 403
    )
    r = client.get(
        "/api/v1/projects/nope/metamodel/layout", headers=AUTH_HEADERS
    )
    assert r.status_code == 404


def test_invalid_payload_422(client):
    seed_default_project()
    r = client.put(
        papi("/metamodel/layout"),
        json={"positions": {"el:Zone": {"x": "NaN-ish"}}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422
```

Note: if `DEFAULT_PROJECT_ID` lives in a different module, take it from wherever `conftest.py` imports it.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_layout.py -v`
Expected: FAIL — 404 on the layout routes (router not mounted).

- [ ] **Step 4: Implement**

`src/data_rover/api/db_models.py` (after `ViewRow`; reuse the module's existing imports):

```python
class MetamodelLayoutRow(Base):
    """Shared diagram positions for a project's metamodel canvas (one row per
    project). Presentation only, by explicit decision (spec 2026-08-13 §5):
    last-write-wins, no lease, never journaled — a lost drag is re-dragged,
    unlike model content where a lost write is corruption."""

    __tablename__ = "metamodel_layouts"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    blob: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
```

`src/data_rover/api/content.py` (append, following the module's existing style):

```python
def get_metamodel_layout(db: Session, project_id: str) -> dict | None:
    """The stored canvas-layout blob, or None if never saved."""
    row = db.get(MetamodelLayoutRow, project_id)
    return row.blob if row is not None else None


def put_metamodel_layout(db: Session, project_id: str, blob: dict) -> None:
    """Upsert the canvas-layout blob (last-write-wins; see MetamodelLayoutRow)."""
    row = db.get(MetamodelLayoutRow, project_id)
    if row is None:
        db.add(MetamodelLayoutRow(project_id=project_id, blob=blob))
    else:
        row.blob = blob
        row.updated_at = _utcnow()
    db.commit()
```

(Import `MetamodelLayoutRow` — and `_utcnow` if content.py doesn't already have it — matching the module's existing imports.)

`alembic/versions/0010_metamodel_layouts.py` (mirrors 0009's style):

```python
"""metamodel_layouts (metamodel diagram editor)

Revision ID: 0010
Revises: 0009
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "metamodel_layouts",
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("blob", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("metamodel_layouts")
```

`src/data_rover/api/routes/metamodel_layout.py`:

```python
"""GET/PUT /metamodel/layout — shared metamodel-canvas positions.

Deliberately does NOT depend on ``get_request_session``: reading a layout
must not hydrate a cold project's model. Membership is enforced directly by
``authz.require_membership`` (method-based: any member GETs, editors+ PUT).
No lease, no journal — presentation only (spec 2026-08-13 §5/§6).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from .. import content
from ..authz import require_membership
from ..db import get_db
from ..db_models import Membership

router = APIRouter()


class LayoutPosition(BaseModel):
    x: float
    y: float


class MetamodelLayoutPayload(BaseModel):
    positions: dict[str, LayoutPosition] = Field(default_factory=dict)


@router.get("/metamodel/layout", response_model=MetamodelLayoutPayload)
def get_metamodel_layout(
    project_id: str,
    db: DbSession = Depends(get_db),
    _membership: Membership = Depends(require_membership),
) -> MetamodelLayoutPayload:
    blob = content.get_metamodel_layout(db, project_id)
    if blob is None:
        return MetamodelLayoutPayload()
    return MetamodelLayoutPayload.model_validate(blob)


@router.put("/metamodel/layout", status_code=204)
def put_metamodel_layout(
    project_id: str,
    payload: MetamodelLayoutPayload,
    db: DbSession = Depends(get_db),
    _membership: Membership = Depends(require_membership),
) -> Response:
    content.put_metamodel_layout(db, project_id, payload.model_dump())
    return Response(status_code=204)
```

`src/data_rover/api/main.py`: import `metamodel_layout` alongside the other route modules and add, next to the two existing metamodel mounts:

```python
    app.include_router(metamodel_layout.router, prefix=proj, tags=["metamodel"])
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_layout.py -v`
Expected: PASS (7 tests). If `require_membership`'s signature differs from Step 1's reading, match the real one.

- [ ] **Step 6: Lint + full backend suite**

Run: `pixi run backend-lint && pixi run core-test`
Expected: clean; no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/ alembic/versions/0010_metamodel_layouts.py tests/api/test_metamodel_layout.py
git commit -m "feat(api): metamodel_layouts table + GET/PUT /metamodel/layout (shared canvas positions)"
```

---

### Task 6: Frontend API client for the layout routes

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (schemas at the end of the metamodel section)
- Modify: `frontend/src/lib/api/metamodel.ts` (two functions)
- Test: `frontend/src/lib/api/__tests__/metamodel-layout.test.ts` (schema round-trip only; the fetch layer is covered elsewhere)

**Interfaces:**
- Produces: `MetamodelLayoutSchema` / `type MetamodelLayout = { positions: Record<string, {x: number; y: number}> }` in types.ts; `getMetamodelLayout(cfg?): Promise<MetamodelLayout>` and `putMetamodelLayout(body: MetamodelLayout, cfg?): Promise<void>` in api/metamodel.ts.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { MetamodelLayoutSchema } from '../types';

describe('MetamodelLayoutSchema', () => {
	it('parses a server payload and defaults positions', () => {
		expect(MetamodelLayoutSchema.parse({})).toEqual({ positions: {} });
		const p = MetamodelLayoutSchema.parse({ positions: { 'el:Zone': { x: 1, y: 2 } } });
		expect(p.positions['el:Zone']).toEqual({ x: 1, y: 2 });
	});
	it('rejects a non-numeric coordinate', () => {
		expect(() => MetamodelLayoutSchema.parse({ positions: { a: { x: 'no', y: 0 } } })).toThrow();
	});
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

types.ts (after the metamodel diff schemas):

```ts
export const LayoutPositionSchema = z.object({ x: z.number(), y: z.number() });
export const MetamodelLayoutSchema = z.object({
	positions: z.record(z.string(), LayoutPositionSchema).default({})
});
export type MetamodelLayout = z.infer<typeof MetamodelLayoutSchema>;
```

api/metamodel.ts:

```ts
/** Shared canvas positions (presentation-only; last-write-wins, no lease). */
export function getMetamodelLayout(cfg?: ClientConfig): Promise<MetamodelLayout> {
	return apiFetch('/metamodel/layout', { method: 'GET', schema: MetamodelLayoutSchema }, cfg);
}

export function putMetamodelLayout(body: MetamodelLayout, cfg?: ClientConfig): Promise<void> {
	return apiFetch('/metamodel/layout', { method: 'PUT', body }, cfg);
}
```

(Extend the existing type/schema imports at the top of the file.)

- [ ] **Step 3: Run + commit**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/api/__tests__/metamodel-layout.test.ts` → PASS.

```bash
git add frontend/src/lib/api/
git commit -m "feat(frontend): api client for GET/PUT /metamodel/layout"
```

---

### Task 7: `diagram-build.ts` — pure metamodel → nodes/edges builder

**Files:**
- Create: `frontend/src/lib/metamodel/diagram-build.ts`
- Test: `frontend/src/lib/metamodel/__tests__/diagram-build.test.ts`

**Interfaces:**
- Produces:

```ts
export type DiagramSelection =
	| { kind: 'element'; name: string }
	| { kind: 'relationship'; name: string }
	| { kind: 'enum'; name: string };

export function nodeIdFor(sel: DiagramSelection): string; // 'el:Zone' | 'rel:Monitors' | 'enum:Status'
export function selectionForNodeId(id: string): DiagramSelection | null;

export interface DiagramNodeSpec {
	id: string;
	type: 'elementType' | 'enumType' | 'assocClass';
	data: Record<string, unknown>; // see per-type payloads below
}
export interface DiagramEdgeSpec {
	id: string;
	source: string;
	target: string;
	type: 'generalization' | 'association';
	data: {
		relName?: string;      // association only: owning relationship type
		label?: string;        // rendered name (omitted on the box→target half)
		containment?: boolean; // diamond at the source end
		sourceMult?: string;   // shown near the source end
		targetMult?: string;   // shown near the target end
		arrow?: boolean;       // open arrowhead at the target end
	};
}
export function buildDiagram(mm: Metamodel): { nodes: DiagramNodeSpec[]; edges: DiagramEdgeSpec[] };
export function needsAssocBox(rel: RelationshipType, mm: Metamodel): boolean;
export function nodeSize(spec: DiagramNodeSpec, collapsed: boolean): { width: number; height: number };
```

Node data payloads: `elementType` → `{name, abstract, properties: PropertyDef[], keyProps: string[], extendsName: string | null}`; `enumType` → `{name, literals: string[]}`; `assocClass` → `{name, abstract, properties: PropertyDef[]}`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildDiagram, needsAssocBox, nodeIdFor } from '../diagram-build';
import { parseDraft } from '../yaml-edit';
import { FIXTURE } from './yaml-edit.test';

const mm = () => parseDraft(FIXTURE).mm!;

describe('buildDiagram', () => {
	it('emits an element node per type and an enum node per enum', () => {
		const { nodes } = buildDiagram(mm());
		expect(nodes.filter((n) => n.type === 'elementType').map((n) => n.id)).toEqual([
			'el:NamedElement',
			'el:Zone',
			'el:Building'
		]);
		expect(nodes.some((n) => n.id === 'enum:Status' && n.type === 'enumType')).toBe(true);
	});

	it('marks key properties on the node data', () => {
		const { nodes } = buildDiagram(mm());
		const root = nodes.find((n) => n.id === 'el:NamedElement')!;
		expect(root.data.keyProps).toEqual(['name']);
	});

	it('emits generalization edges for element extends', () => {
		const { edges } = buildDiagram(mm());
		expect(edges).toContainEqual(
			expect.objectContaining({ id: 'gen:el:Zone', source: 'el:Zone', target: 'el:NamedElement', type: 'generalization' })
		);
	});

	it('a plain relationship renders as one association edge per mapping', () => {
		const { edges, nodes } = buildDiagram(mm());
		const contains = edges.find((e) => e.data.relName === 'Contains')!;
		expect(contains).toMatchObject({ source: 'el:Zone', target: 'el:Building', type: 'association' });
		expect(contains.data.containment).toBe(true);
		expect(contains.data.sourceMult).toBe('1');
		expect(nodes.some((n) => n.id === 'rel:Contains')).toBe(false);
	});

	it('a relationship with properties or hierarchy gets an assoc box and two-half edges', () => {
		expect(needsAssocBox(mm().relationships.find((r) => r.name === 'Monitors')!, mm())).toBe(true);
		const { nodes, edges } = buildDiagram(mm());
		expect(nodes.some((n) => n.id === 'rel:Monitors' && n.type === 'assocClass')).toBe(true);
		const inHalf = edges.find((e) => e.id === 'assoc-in:Monitors:0')!;
		const outHalf = edges.find((e) => e.id === 'assoc-out:Monitors:0')!;
		expect(inHalf).toMatchObject({ source: 'el:Building', target: 'rel:Monitors' });
		expect(outHalf).toMatchObject({ source: 'rel:Monitors', target: 'el:Zone' });
		expect(outHalf.data.arrow).toBe(true);
	});

	it('an abstract mapless relationship renders as a floating box + rel generalization edge', () => {
		const { nodes, edges } = buildDiagram(mm());
		expect(nodes.some((n) => n.id === 'rel:Observes')).toBe(true);
		expect(edges).toContainEqual(
			expect.objectContaining({ id: 'gen:rel:Monitors', source: 'rel:Monitors', target: 'rel:Observes' })
		);
	});

	it('skips edges whose endpoint types do not exist (mid-edit dangling refs)', () => {
		const broken = { ...mm(), relationships: mm().relationships.map((r) =>
			r.name === 'Contains' ? { ...r, mappings: [{ source: 'Zone', target: 'Ghost' }] } : r
		)};
		const { edges } = buildDiagram(broken);
		expect(edges.some((e) => e.data.relName === 'Contains')).toBe(false);
	});
});

describe('nodeIdFor', () => {
	it('prefixes by kind', () => {
		expect(nodeIdFor({ kind: 'element', name: 'Zone' })).toBe('el:Zone');
		expect(nodeIdFor({ kind: 'relationship', name: 'M' })).toBe('rel:M');
		expect(nodeIdFor({ kind: 'enum', name: 'S' })).toBe('enum:S');
	});
});
```

- [ ] **Step 2: Run to verify failure, then implement**

`frontend/src/lib/metamodel/diagram-build.ts` — pure, no Svelte imports:

```ts
import type { Metamodel, PropertyDef, RelationshipType } from '$lib/api/types';

/** Metamodel → UML diagram shapes (spec §2). Pure: positions, collapse state
 * and styling are the caller's concern; this module decides only WHAT exists.
 * Association-class rule: a relationship type that carries properties, is
 * abstract, extends another, or is extended, gets a `rel:` box node and its
 * mappings render as two-half edges THROUGH the box (source→box→target) —
 * the flow-graph rendering of UML's line-tethered association class. */

// … implement exactly the Interfaces block above. Key details:
// - keyProps: the type's OWN `key` entries that name properties (skip
//   `out:`/`in:` DSL entries); effective (inherited) keys are a form-panel
//   concern, not a canvas one.
// - Edge ids: `gen:el:<child>`, `gen:rel:<child>`, `assoc:<rel>:<i>`,
//   `assoc-in:<rel>:<i>` / `assoc-out:<rel>:<i>`.
// - Association halves: in-half carries {containment, sourceMult, relName};
//   out-half carries {arrow: true, targetMult, relName}. Plain (boxless)
//   associations carry all of it plus label: rel.name on the single edge.
// - Guard every edge: emit only when both endpoint node ids exist in the
//   node set (mid-edit metamodels have dangling refs; the canvas must never
//   emit an edge Svelte Flow can't anchor).
// - nodeSize: width 240 for elementType/assocClass, 200 for enumType;
//   height 40 collapsed, else 40 + 22 * rows (properties or literals),
//   capped at 40 + 22 * 12.

export function needsAssocBox(rel: RelationshipType, mm: Metamodel): boolean {
	return (
		rel.properties.length > 0 ||
		rel.abstract ||
		rel.extends !== null ||
		mm.relationships.some((o) => o.extends === rel.name)
	);
}
```

Write the full implementation (the comment block above is the specification of it — the code itself must be complete, ~120 lines).

- [ ] **Step 3: Run tests to verify they pass, then commit**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/diagram-build.test.ts` → PASS.

```bash
git add frontend/src/lib/metamodel/
git commit -m "feat(frontend): diagram-build — pure metamodel to UML nodes/edges"
```

---

### Task 8: Auto-arrange module (elkjs) + placement heuristic

**Files:**
- Create: `frontend/src/lib/metamodel/arrange.ts`
- Test: `frontend/src/lib/metamodel/__tests__/arrange.test.ts`

**Interfaces:**
- Consumes: `DiagramNodeSpec`, `DiagramEdgeSpec`, `nodeSize` from Task 7.
- Produces: `autoArrange(nodes: DiagramNodeSpec[], edges: DiagramEdgeSpec[], collapsed: ReadonlySet<string>): Promise<Record<string, {x: number; y: number}>>` and `placeUnpositioned(nodes: DiagramNodeSpec[], edges: DiagramEdgeSpec[], positions: Record<string, {x: number; y: number}>): Record<string, {x: number; y: number}>` (returns a NEW record containing every node; already-positioned entries unchanged).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { autoArrange, placeUnpositioned } from '../arrange';
import { buildDiagram } from '../diagram-build';
import { parseDraft } from '../yaml-edit';
import { FIXTURE } from './yaml-edit.test';

const built = () => buildDiagram(parseDraft(FIXTURE).mm!);

describe('autoArrange', () => {
	it('positions every node with no overlaps at identical coordinates', async () => {
		const { nodes, edges } = built();
		const pos = await autoArrange(nodes, edges, new Set());
		expect(Object.keys(pos).sort()).toEqual(nodes.map((n) => n.id).sort());
		const coords = Object.values(pos).map((p) => `${p.x},${p.y}`);
		expect(new Set(coords).size).toBe(coords.length);
	});
});

describe('placeUnpositioned', () => {
	it('keeps existing positions and places the missing node near a connected neighbor', () => {
		const { nodes, edges } = built();
		const existing: Record<string, { x: number; y: number }> = {};
		for (const n of nodes) existing[n.id] = { x: 100, y: 100 };
		delete existing['el:Zone'];
		const out = placeUnpositioned(nodes, edges, existing);
		expect(out['el:Building']).toEqual({ x: 100, y: 100 });
		expect(out['el:Zone']).toBeDefined();
		expect(out['el:Zone']).not.toEqual({ x: 100, y: 100 }); // nudged off its neighbor
	});

	it('places a fully disconnected node without NaN', () => {
		const { nodes, edges } = built();
		const out = placeUnpositioned(nodes, edges, {});
		for (const p of Object.values(out)) {
			expect(Number.isFinite(p.x)).toBe(true);
			expect(Number.isFinite(p.y)).toBe(true);
		}
	});
});
```

- [ ] **Step 2: Run to verify failure, then implement**

```ts
import ELK from 'elkjs/lib/elk.bundled.js';
import { nodeSize, type DiagramEdgeSpec, type DiagramNodeSpec } from './diagram-build';

/** One-shot layered layout for the Auto-arrange button and first-open (spec
 * §5). elkjs runs client-side; the bundled build needs no worker. */
export async function autoArrange(
	nodes: DiagramNodeSpec[],
	edges: DiagramEdgeSpec[],
	collapsed: ReadonlySet<string>
): Promise<Record<string, { x: number; y: number }>> {
	const elk = new ELK();
	const res = await elk.layout({
		id: 'root',
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.direction': 'DOWN',
			'elk.spacing.nodeNode': '48',
			'elk.layered.spacing.nodeNodeBetweenLayers': '72'
		},
		children: nodes.map((n) => ({ id: n.id, ...nodeSize(n, collapsed.has(n.id)) })),
		edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }))
	});
	return Object.fromEntries((res.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

/** Incremental placement for nodes with no stored position: next to their
 * nearest positioned neighbor (nudged until free), else on a grid below the
 * current extent. Never moves an already-positioned node — a peer's new type
 * must not implicitly re-layout the canvas under you (spec §5). */
export function placeUnpositioned(
	nodes: DiagramNodeSpec[],
	edges: DiagramEdgeSpec[],
	positions: Record<string, { x: number; y: number }>
): Record<string, { x: number; y: number }> {
	const out: Record<string, { x: number; y: number }> = { ...positions };
	const taken = new Set(Object.values(out).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
	const claim = (x: number, y: number): { x: number; y: number } => {
		let px = x;
		while (taken.has(`${Math.round(px)},${Math.round(y)}`)) px += 260;
		taken.add(`${Math.round(px)},${Math.round(y)}`);
		return { x: px, y };
	};
	let fallbackRow = 0;
	const maxY = Object.values(out).reduce((m, p) => Math.max(m, p.y), 0);
	for (const n of nodes) {
		if (out[n.id] !== undefined) continue;
		const neighbor = edges
			.filter((e) => e.source === n.id || e.target === n.id)
			.map((e) => (e.source === n.id ? e.target : e.source))
			.find((id) => out[id] !== undefined);
		if (neighbor !== undefined) {
			out[n.id] = claim(out[neighbor].x + 280, out[neighbor].y + 60);
		} else {
			out[n.id] = claim(0, maxY + 120 + 80 * fallbackRow++);
		}
	}
	return out;
}
```

If TypeScript can't find types for `elkjs/lib/elk.bundled.js`, add a `frontend/src/lib/metamodel/elk.d.ts` with `declare module 'elkjs/lib/elk.bundled.js' { import ELK from 'elkjs'; export default ELK; }`.

- [ ] **Step 3: Run tests, then commit**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/metamodel/__tests__/arrange.test.ts` → PASS.

```bash
git add frontend/src/lib/metamodel/
git commit -m "feat(frontend): elkjs auto-arrange + incremental placement heuristic"
```

---

### Task 9: Diagram state module

**Files:**
- Create: `frontend/src/lib/state/metamodel-diagram.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (re-export the new module's public functions)
- Test: `frontend/src/lib/state/__tests__/metamodel-diagram.test.ts`

**Interfaces:**
- Consumes: `parseDraft`/`applyEdit`/`serializeDraft`/`lineRangeForType`/`YamlEditCommand` (Tasks 1-4); `getMetamodelEditor`/`editMetamodelBuffer` (existing); `getMetamodelLayout`/`putMetamodelLayout` (Task 6); `buildDiagram`/`nodeIdFor` (Task 7); `placeUnpositioned`/`autoArrange` (Task 8).
- Produces:

```ts
export const LAYOUT_SAVE_DEBOUNCE_MS = 800;
export interface MetamodelDiagramView {
	view: 'yaml' | 'diagram';
	mm: Metamodel | null;            // parsed from the CURRENT buffer
	parseErrors: DraftError[];       // non-empty → canvas shows the fallback
	selection: DiagramSelection | null;
	positions: Record<string, { x: number; y: number }>;
	collapsed: ReadonlySet<string>;
	canUndo: boolean;
	errorNodeIds: ReadonlySet<string>; // lint errors attributed to type blocks
	unattributedErrorCount: number;
}
export function getMetamodelDiagramView(): MetamodelDiagramView;
export function setMetamodelView(v: 'yaml' | 'diagram'): void;         // persists per project
export function initMetamodelDiagram(projectId: string): Promise<void>; // GET layout, restore view+collapse, parse; auto-arranges if layout empty
export function closeMetamodelDiagram(): void;                          // flush pending PUT, reset
export function selectDiagramNode(sel: DiagramSelection | null): void;
export function toggleNodeCollapsed(nodeId: string): void;
export function setAllCollapsed(collapsed: boolean): void;
export function applyDiagramEdit(cmd: YamlEditCommand): boolean;        // false when read-only or parse errors
export function undoDiagramEdit(): void;
export function moveNode(nodeId: string, pos: { x: number; y: number }): void; // + debounced PUT
export function runAutoArrange(): Promise<void>;                        // undoable, debounced PUT
export function onMetamodelRebound(): void;                             // apply pending rename key-rewrites, PUT
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/state/__tests__/metamodel-diagram.test.ts` — mirror the mocking style of the existing `metamodel-editor` tests (find them with `ls frontend/src/lib/state/__tests__/`). Mock `$lib/api/metamodel` (layout GET/PUT) with `vi.mock`; drive the editor module directly (`initMetamodelEditor` is NOT needed — set a buffer by mocking `getMetamodelEditor`'s dependencies is heavyweight, so instead mock `./metamodel-editor.svelte` exports `getMetamodelEditor` and `editMetamodelBuffer` with a tiny in-test buffer store). Cover:

```ts
// 1. applyDiagramEdit routes through editMetamodelBuffer and reparses:
//    apply addElementType 'Sensor' → buffer contains '- name: Sensor', view.mm has it.
// 2. applyDiagramEdit returns false and does nothing when readOnly.
// 3. applyDiagramEdit returns false when the buffer has parse errors.
// 4. undoDiagramEdit restores the pre-edit buffer (canUndo flips).
// 5. moveNode updates positions immediately and PUTs after
//    LAYOUT_SAVE_DEBOUNCE_MS (vi.useFakeTimers; assert the mocked
//    putMetamodelLayout got the moved position).
// 6. rename deferral: applyDiagramEdit renameElementType Zone→District moves
//    the LOCAL position key 'el:Zone'→'el:District', but the next debounced
//    PUT still sends 'el:Zone' (server keyed by baseline names);
//    onMetamodelRebound() then PUTs with 'el:District'.
// 7. viewers: initMetamodelDiagram never PUTs (mock getRole → 'viewer',
//    moveNode still moves locally but schedules no save).
```

Write these as real tests (7 `it` blocks) against the interface above.

- [ ] **Step 2: Run to verify failure, then implement**

Implementation notes that MUST hold (write them into the module docstring):

- The module owns NO draft state: `applyDiagramEdit` always parses the CURRENT `getMetamodelEditor().buffer`, applies, serializes, and calls `editMetamodelBuffer(next)`. The editor module remains the single lifecycle owner (lease, lint, draft, dirty).
- Undo stack: `{ buffer: string | null; positions: Record<string, {x,y}> | null }[]`, max 50 entries; edits push `{buffer, positions: null}`, auto-arrange pushes `{buffer: null, positions}`. `undoDiagramEdit` pops and applies whichever half is non-null (buffer via `editMetamodelBuffer`).
- Pending renames: `Map<string, string>` from server key → local key (`el:Zone` → `el:District`), composed transitively on chained renames. `saveLayout()` inverts local positions through this map before PUT; `onMetamodelRebound()` clears the map and PUTs local keys as-is. Only owner saves (`getRole() === 'owner'` guard is wrong for layout — editors+ may save; guard with `getRole() !== 'viewer'`).
- Rename commands also move the local position key immediately so the canvas doesn't jump; delete commands drop the key.
- View + collapse persistence: `ui.metamodel.view.<projectId>` (string) and `ui.metamodel.collapsed.<projectId>` (JSON array), try/catch localStorage like `metamodel-editor.svelte.ts` does.
- `initMetamodelDiagram`: GET layout → if `positions` empty AND mm parses, run `autoArrange` over the built diagram and adopt (schedule save only when role ≠ viewer). Wrap in the same `_gen` generation-guard idiom as `initMetamodelEditor`.
- Lint attribution: derive `errorNodeIds` in `getMetamodelDiagramView()` from `getMetamodelEditor().lintErrors` × `lineRangeForType` over both sections; errors with `line === null` or no matching range count into `unattributedErrorCount`.
- Positions handed to consumers must ALWAYS cover every node: run `placeUnpositioned` in the view getter over the built diagram (cheap at metamodel scale, keeps peers' new types visible).

- [ ] **Step 3: Run the new tests + the whole state suite**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/state/__tests__/` → PASS, no regressions.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/state/
git commit -m "feat(frontend): metamodel diagram state — commands, undo, shared layout, rename deferral"
```

---

### Task 10: Canvas components + view toggle in the tab

**Files:**
- Create: `frontend/src/lib/components/Metamodel/diagram/ElementTypeNode.svelte`
- Create: `frontend/src/lib/components/Metamodel/diagram/EnumTypeNode.svelte`
- Create: `frontend/src/lib/components/Metamodel/diagram/AssocClassNode.svelte`
- Create: `frontend/src/lib/components/Metamodel/diagram/AssociationEdge.svelte`
- Create: `frontend/src/lib/components/Metamodel/diagram/GeneralizationEdge.svelte`
- Create: `frontend/src/lib/components/Metamodel/MetamodelDiagram.svelte`
- Modify: `frontend/src/lib/components/Metamodel/MetamodelTab.svelte` (YAML | Diagram segmented toggle; render the diagram; call `initMetamodelDiagram`/`closeMetamodelDiagram`/`onMetamodelRebound`)
- Test: `frontend/src/lib/components/__tests__/MetamodelDiagram.test.ts`

**Interfaces:**
- Consumes: everything from Task 9's view/functions; `buildDiagram` node/edge specs.
- Produces: a rendering canvas. Node `data` passed to Svelte Flow adds `collapsed: boolean`, `hasError: boolean`, `onToggleCollapse(id)` on top of the Task 7 payloads.

**Component notes (follow GraphView.svelte for Svelte Flow idioms and the hex-token palette comment; style per the approved mockup — sage glass, hairline borders, `font-display` names, italic+dashed for abstract, gold `{id}`/`«enumeration»` accents):**

- `ElementTypeNode`: 240px card; header row (glow dot, name, collapse chevron / property-count chip); attribute compartment when expanded: `name: datatype [mult]` + gold `{id}` for `keyProps`; red border when `hasError`. `<Handle type="source" position={Position.Right}/>` + `<Handle type="target" position={Position.Left}/>`.
- `AssocClassNode`: 200px, name italic when abstract, properties list like element node, amber/gold border tint.
- `EnumTypeNode`: `«enumeration»` label over the name, literals list when expanded, gold border tint.
- `GeneralizationEdge` / `AssociationEdge`: custom edges via `BaseEdge`+`getSmoothStepPath`+`EdgeLabelRenderer` from `@xyflow/svelte`. `MetamodelDiagram` renders one `<svg><defs>` block defining markers `uml-gen` (hollow triangle, `fill: var(--background)`, stroke muted), `uml-diamond` (filled), `uml-arrow` (open arrow); edges reference them by url. Association edge renders `data.label` at the path midpoint and `sourceMult`/`targetMult` near the ends (offset 24px in from each endpoint); dashed stroke when the edge connects to a `rel:` node (the tether-through-box halves).
- `MetamodelDiagram.svelte`: toolbar (Auto-arrange, Fit view, Collapse all / Expand all, search input that pans to the first name-matching node via `useSvelteFlow().setCenter`, `+ Element type`, `+ Enum` — create buttons hidden when read-only); `<SvelteFlow {nodes} {edges} fitView colorMode="dark" nodesDraggable={!readOnly} nodesConnectable={!readOnly} onnodeclick onedgeclick onnodedragstop onconnect onpaneclick={deselect}>`; parse-error fallback: when `parseErrors` non-empty render a centered panel "The draft has syntax errors — fix them in the YAML view." with a button switching `setMetamodelView('yaml')`; keyboard: `Ctrl/Cmd+Z` on the wrapper calls `undoDiagramEdit()`. Edge click resolves `data.relName` → `selectDiagramNode({kind:'relationship', name})`. Selected relationship highlights ALL its edges (pass `selected` per edge by comparing `relName`).
- `MetamodelTab.svelte`: segmented `YAML | Diagram` control in the toolbar row (persisting via `setMetamodelView`); `{#if view === 'diagram'}<MetamodelDiagram/>{:else}<MetamodelYamlEditor …/>{/if}`; `onMount` also `void initMetamodelDiagram(pid)` and teardown calls `closeMetamodelDiagram()`; in `onRebind` success path call `onMetamodelRebound()`. The read-only notice for non-owners changes copy to "The metamodel is read-only for your role — the diagram stays browsable."

- [ ] **Step 1: Write the failing component tests**

`MetamodelDiagram.test.ts` (happy-dom; mock `$lib/state` diagram/editor getters the way existing component tests do; Svelte Flow renders in happy-dom — if it throws on ResizeObserver, stub `global.ResizeObserver` in the test setup like other canvas tests, check `frontend/src/lib/components/__tests__/` for precedent):

```ts
// 1. renders one node per element type from the mocked view (query by text:
//    'Zone', 'Building').
// 2. parseErrors non-empty → fallback panel text visible, no canvas.
// 3. read-only view → '+ Element type' button absent.
// 4. clicking a node calls selectDiagramNode with {kind:'element', name}.
// 5. MetamodelTab: toggle switches surfaces and persists (setMetamodelView
//    called; diagram visible after click).
```

Write these five as real tests.

- [ ] **Step 2: Run to verify failure, then implement the components**

- [ ] **Step 3: Run the component suite + svelte-check**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/components/__tests__/MetamodelDiagram.test.ts && pixi run frontend-check`
Expected: PASS, no new check errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/Metamodel/ frontend/src/lib/components/__tests__/
git commit -m "feat(frontend): metamodel diagram canvas — UML nodes/edges, toggle in the tab"
```

---

### Task 11: Form panel — element form + shared property editor + key builder

**Files:**
- Create: `frontend/src/lib/components/Metamodel/forms/MetamodelFormPanel.svelte` (selection dispatcher + metamodel-level default panel)
- Create: `frontend/src/lib/components/Metamodel/forms/ElementTypeForm.svelte`
- Create: `frontend/src/lib/components/Metamodel/forms/PropertyListEditor.svelte`
- Create: `frontend/src/lib/components/Metamodel/forms/KeyBuilder.svelte`
- Modify: `frontend/src/lib/components/Metamodel/MetamodelDiagram.svelte` (dock the panel right, 320px, `overflow-y-auto`)
- Test: `frontend/src/lib/components/__tests__/MetamodelForms.test.ts`

**Interfaces:**
- Consumes: `applyDiagramEdit` (every field change emits exactly one `YamlEditCommand`), `getMetamodelDiagramView` (selection + mm), `$lib/metamodel/helpers` (`elementAncestors` for the extends cycle guard, `effectiveProperties` for the key builder's property pool).
- Produces: for Task 12, the conventions — each form takes `{ mm: Metamodel, name: string, readOnly: boolean }` props and resolves its own type from `mm`; text fields commit on blur or Enter (never per keystroke — a rename per keystroke would cascade per keystroke); selects/checkboxes commit on change.

**Behavior to implement:**

- `MetamodelFormPanel`: `selection === null` → overview panel: counts, enum list (click → select), relationship types with no mappings (click → select), and `+ Relationship type` / `+ Enum` buttons (read-only-hidden). Otherwise dispatch to the per-kind form.
- `ElementTypeForm`: name input (blur/Enter → `renameElementType` + passive hint "Renaming re-types instances on rebind (shows as remove + add in Preview)"); abstract checkbox → `setElementAbstract`; extends select (options: element types minus self minus own descendants — compute descendants from `mm` by walking `extends` chains; `null` option "— none —") → `setElementExtends`; `PropertyListEditor owner={{kind:'element', name}}`; `KeyBuilder`; a Delete button that emits an `onRequestDelete(name)` callback prop — ship it DISABLED in this task (title "wired in the next task"); Task 12 adds the confirm dialog and enables it.
- `PropertyListEditor`: rows of `name — datatype — mult`, expandable to edit: name (blur), datatype `<select>` with `<optgroup>`s Primitives (`string,integer,float,boolean,date`), Enums (from `mm.enums`), Element types; multiplicity text input; min/max number inputs, pattern text, max_length int (empty string → null). Each change emits `updateProperty` with the FULL `PropertyDef`; `+ Property` emits `addProperty` with `{name: 'new_property', datatype: 'string', multiplicity: '0..1', min: null, max: null, pattern: null, max_length: null}`; row × emits `removeProperty`.
- `KeyBuilder`: shows current key entries as rows; a row is either a property select (own + inherited property names via `effectiveProperties`) or a DSL row (direction select `out|in` + relationship-type select). `+ property entry` / `+ relationship entry` / per-row × / "no key" clear-all. Every change emits one `setElementKey` with the full array; entries serialize as `name` / `out:Rel` / `in:Rel`.

- [ ] **Step 1: Write failing tests** — `MetamodelForms.test.ts`, mocking `applyDiagramEdit` via `vi.mock('$lib/state', …)` and asserting emitted commands:

```ts
// 1. ElementTypeForm rename: type in name field, blur → applyDiagramEdit
//    called with {kind:'renameElementType', from:'Zone', to:'District'}.
// 2. extends select excludes self and descendants (NamedElement's select has
//    no 'NamedElement' and no 'Zone' when editing NamedElement… wait: options
//    exclude SELF and DESCENDANTS — for 'NamedElement' that's Zone+Building).
// 3. PropertyListEditor add → addProperty command with the default PropertyDef.
// 4. PropertyListEditor datatype change → updateProperty carrying full def.
// 5. KeyBuilder adding out:-entry → setElementKey ['name','out:Contains'].
// 6. readOnly renders inputs disabled and no add/remove buttons.
```

- [ ] **Step 2: Run to verify failure, implement, run to green**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/components/__tests__/MetamodelForms.test.ts`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/Metamodel/
git commit -m "feat(frontend): metamodel form panel — element form, property editor, key builder"
```

---

### Task 12: Form panel — relationship & enum forms, delete dialog, connection popover

**Files:**
- Create: `frontend/src/lib/components/Metamodel/forms/RelationshipTypeForm.svelte`
- Create: `frontend/src/lib/components/Metamodel/forms/EnumForm.svelte`
- Create: `frontend/src/lib/components/Metamodel/forms/DeleteTypeDialog.svelte`
- Create: `frontend/src/lib/components/Metamodel/diagram/ConnectionPopover.svelte`
- Modify: `frontend/src/lib/components/Metamodel/forms/MetamodelFormPanel.svelte`, `MetamodelDiagram.svelte`, `ElementTypeForm.svelte` (wire delete + popover)
- Test: `frontend/src/lib/components/__tests__/MetamodelFormsRel.test.ts`

**Interfaces:**
- Consumes: Task 11 conventions; `needsAssocBox` irrelevant here; `applyDiagramEdit`.
- Produces: complete full-coverage editing per spec.

**Behavior:**

- `RelationshipTypeForm`: name (→ `renameRelationshipType` + same rebind hint), abstract → `setRelationshipAbstract`, containment → `setRelationshipContainment`, extends select over relationship types (minus self/descendants) → `setRelationshipExtends`, source/target multiplicity inputs (blur → `setEndMultiplicity`), mappings list: each row `source → target` with ×  (→ `removeMapping`), `+ Mapping` row = two element-type selects + confirm (→ `addMapping`), `PropertyListEditor owner={{kind:'relationship', name}}`, Delete button → dialog.
- `EnumForm`: name (→ `renameEnum`), literal rows (text inputs, blur commits the full list via `setEnumLiterals`; add/remove/reorder arrows also emit the full list), Delete → `removeEnum` behind the dialog.
- `DeleteTypeDialog` (bits-ui `Dialog` or the repo's dialog primitive — check how e.g. `ExportArtifactsDialog` builds one): props `{ sel: DiagramSelection, mm: Metamodel, onConfirm(): void }`. Consequence list computed from `mm`:
  - element: mappings that will be removed (rel name + pair), `extends` pointers cleared (child names), references LEFT dangling (element-typed properties naming it: `Type.prop`; key DSL entries unaffected by element deletes). Copy: auto-fixed section "Will be updated:", dangling section "Will be left for the linter:".
  - relationship: `extends` clears; key DSL entries left dangling (`Type.key out:Name`).
  - enum: properties whose datatype names it, left dangling.
  Confirm emits the matching remove command via `applyDiagramEdit`.
- `ConnectionPopover`: opened by `MetamodelDiagram`'s `onconnect({source, target})` when both ids are `el:` nodes (store pending pair in local state, render popover near the target node via `EdgeLabelRenderer` or fixed overlay). Three options:
  1. **New relationship type** — name input (default `Relates`), containment checkbox → `addRelationshipType {name, containment, mapping: {source, target}}`.
  2. **Add mapping to existing** — select over non-abstract relationship types → `addMapping`.
  3. **Set extends** — only offered when source ≠ target and target is not already a descendant of source (walk `extends` chains; the guard blocks cycles) → `setElementExtends {name: source, value: target}`.
  Escape/click-away cancels (no command).

- [ ] **Step 1: Write failing tests** (`MetamodelFormsRel.test.ts`):

```ts
// 1. RelationshipTypeForm: containment toggle emits setRelationshipContainment.
// 2. Mapping row × emits removeMapping with the exact pair.
// 3. EnumForm literal edit emits setEnumLiterals with the full new list.
// 4. DeleteTypeDialog for element 'Building' lists 'Contains' under
//    auto-updated and confirm emits removeElementType.
// 5. ConnectionPopover 'new relationship' flow emits addRelationshipType
//    with the drawn pair; 'set extends' option hidden when it would cycle.
```

- [ ] **Step 2: Run to verify failure, implement, run to green**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/components/__tests__/MetamodelFormsRel.test.ts`

- [ ] **Step 3: Run the full frontend suite**

Run: `pixi run frontend-test`
Expected: no regressions anywhere.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/Metamodel/
git commit -m "feat(frontend): relationship/enum forms, delete-consequence dialog, connection popover"
```

---

### Task 13: Lint badges, error surfacing, read-only polish

**Files:**
- Modify: `frontend/src/lib/components/Metamodel/diagram/ElementTypeNode.svelte`, `AssocClassNode.svelte` (render `hasError` red border + dot)
- Modify: `frontend/src/lib/components/Metamodel/MetamodelDiagram.svelte` (toolbar badge: `unattributedErrorCount + errorNodeIds.size` as "N issues", clicking switches to YAML view; wire `errorNodeIds` into node data)
- Modify: `frontend/src/lib/state/metamodel-diagram.svelte.ts` if attribution gaps surfaced
- Test: extend `frontend/src/lib/components/__tests__/MetamodelDiagram.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// 1. a mocked view with errorNodeIds {'el:Zone'} renders the Zone node with
//    the error style (data-testid="node-error" or class assertion).
// 2. toolbar badge shows the combined count and clicking it calls
//    setMetamodelView('yaml').
```

- [ ] **Step 2: Implement, run to green, commit**

Run: `pixi run -e frontend npm --prefix frontend run test -- src/lib/components/__tests__/MetamodelDiagram.test.ts`

```bash
git add frontend/src/lib/
git commit -m "feat(frontend): lint-error badges on diagram nodes + toolbar issue count"
```

---

### Task 14: Integration pass — rebind flow, docs, backlog, full verification

**Files:**
- Modify: `frontend/README.md` (extend the "Live metamodel editing" section: the two views, command→YAML writeback, layout sharing, rename deferral, owner-only editing)
- Modify: `CLAUDE.md` (in the "Live metamodel editing" section: one short paragraph — Diagram view, `yaml-edit.ts` command module, `GET/PUT /metamodel/layout` + `metamodel_layouts` table, layout is lease-free/journal-free by design)
- Modify: `BACKLOG.md` (P-9 → `in progress`→`done` with a pointer to the spec; add a `T` item for the missing e2e coverage folding into T-7)
- Test: none new — this task runs everything

- [ ] **Step 1: Manual smoke test against the real app**

```bash
# terminal 1 (needs a dev DB; DATA_ROVER_DEV_SEED with sqlite works)
pixi run backend-start
# terminal 2
pixi run frontend-start
```

In the browser: open a project (import smart-city via the wizard if none), open Edit Metamodel → toggle Diagram. Verify: nodes render with generalization triangles and the Contains diamond; drag persists across a reload; Auto-arrange works and undoes; add a type via button, draw a connection → popover → new relationship; rename Zone in the form → YAML view shows the cascade with comments intact; break the YAML by hand → Diagram shows the fallback; Preview + Rebind still work end-to-end; after rebind, reload → positions keyed by the new name survive.

- [ ] **Step 2: Full verification**

```bash
pixi run dr-tidy && pixi run dr-test
```

Expected: tidy clean; core + frontend suites fully green.

- [ ] **Step 3: Update the three docs, then commit**

```bash
git add frontend/README.md CLAUDE.md BACKLOG.md
git commit -m "docs: metamodel diagram editor — README/CLAUDE/backlog updates (P-9)"
```

---

## Self-review (done at write time)

- **Spec coverage:** §1 surface/toggle/roles → Tasks 9-10; §2 rendering → Tasks 7, 10; §3 interactions → Tasks 11-12 (+ undo in 9); §4 yaml-edit → Tasks 1-4 (fallback state in 10, lint attribution in 9/13); §5 layout/arrange/backend/rename-wrinkle → Tasks 5, 6, 8, 9; §6 semantics → inherited by construction (Task 9 guards), layout exception in Task 5; §7 testing → every task; §8 non-goals → nothing here builds them.
- **Known risk:** exact `yaml`-package node-manipulation calls (`doc.createNode` flow flags, `Pair.key` in-place rename) are the most likely place reality diverges from the plan's code — the Task 1-4 tests are authoritative; adjust implementation, not tests, if the library API differs.
- **Type consistency check:** command names, `TypeRef`, `DiagramNodeSpec`/`DiagramEdgeSpec`, view interfaces and route payloads are used with identical spellings across tasks.
