import { getMetamodelLayout, putMetamodelLayout } from '$lib/api/metamodel';
import type { Metamodel } from '$lib/api/types';
import { autoArrange, placeUnpositioned } from '$lib/metamodel/arrange';
import {
	buildDiagram,
	nodeIdFor,
	type DiagramEdgeSpec,
	type DiagramNodeSpec,
	type DiagramSelection
} from '$lib/metamodel/diagram-build';
import {
	applyEdit,
	lineRangeForType,
	parseDraft,
	serializeDraft,
	type DraftError,
	type ParsedDraft,
	type SectionKey,
	type YamlEditCommand
} from '$lib/metamodel/yaml-edit';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { getRole } from './checkout.svelte';
import { editMetamodelBuffer, getMetamodelEditor } from './metamodel-editor.svelte';

/**
 * The DIAGRAM half of the metamodel tab (spec 2026-08-13 §3/§5). Its job is to
 * make a canvas gesture look exactly like a keystroke in the YAML view, so the
 * whole existing lifecycle keeps working untouched.
 *
 * **This module owns no draft state.** `applyDiagramEdit` parses the CURRENT
 * `getMetamodelEditor().buffer`, applies one semantic command to the yaml
 * `Document`, serializes, and hands the text to `editMetamodelBuffer`. The
 * editor module stays the single lifecycle owner (lease acquisition, debounced
 * lint, localStorage draft, dirty flag, preview/rebind) and is composed
 * exclusively through its existing exports — never restructured, never
 * bypassed. Going through `parseDraft → applyEdit → serializeDraft` (rather
 * than re-serializing a plain object) is also what keeps the author's comments
 * and formatting alive across a diagram edit.
 *
 * **Layout is presentation, not content** (owner-approved exception, §5): node
 * positions live in a SHARED per-project blob written by
 * `PUT /metamodel/layout` with no `mm` lease, no journal entry, and
 * last-write-wins. So the save gate is `getRole() !== 'viewer'` — editors save
 * too, unlike buffer editing which stays owner-only through the editor
 * module's own `isEditBlocked()`. A failed PUT is swallowed: a presentation
 * detail must never surface as an error over a metamodel edit.
 *
 * **Rename key-deferral** is the subtle invariant here. Node ids
 * (`el:`/`rel:`/`enum:` + type name) double as the layout blob's position
 * keys, and that blob is shared state peers read while they still render the
 * BASELINE names. A rename that exists only in this client's draft must
 * therefore move the key locally (so the canvas doesn't jump) while every PUT
 * keeps speaking the baseline name — otherwise a draft that is later discarded,
 * or that a peer never sees, scrambles their canvases. `_pendingRenames` maps
 * server key → local key (composed transitively across chained renames);
 * `serverPositions` inverts local positions through it before every PUT,
 * `localPositions` applies it forward to a freshly fetched blob, and
 * `onMetamodelRebound` — called once a rebind has actually landed, i.e. once
 * the local names ARE everyone's names — clears the map, drops the pre-rebind
 * undo history (see there) and PUTs the local keys as-is.
 *
 * The map is a property of the DRAFT, not of the session, so it persists
 * alongside it (`ui.metamodel.renames.<projectId>`) and `initMetamodelDiagram`
 * restores it. Without that, a refresh left the draft saying `District` while
 * the map was gone, so the next drag wrote `positions['el:District']` straight
 * into the SHARED blob — a draft-local key on the wire, which is exactly what
 * the deferral exists to prevent.
 *
 * The restore is SELF-VALIDATING, and that is what stands in for the hooks this
 * module does not have (`discardMetamodelDraft` is not observable from here,
 * and neither is a draft edited in another tab): an entry survives the restore
 * only while the current draft still defines the LOCAL name it describes —
 * against an incoming server-keyed blob, a deferral nothing backs can only
 * mis-key it. Every PUT re-checks the same thing, but with the position map in
 * hand it can be kinder: a dead entry is still honoured (that stale local key
 * holds the position of a box peers DO see, under its baseline name) unless a
 * live node already occupies the baseline key. That last case is name reuse —
 * rename `Zone → District`, then create a fresh `Zone` — and it is the one that
 * must never collapse two boxes onto one key last-write-wins, so both rewrite
 * directions resolve it explicitly: the deferral wins, and the reused name has
 * no server counterpart until a rebind lands.
 *
 * Reactivity note: `$state` is never written from `getMetamodelDiagramView()`
 * (that would trip `state_unsafe_mutation` mid-render), so the memoization
 * caches below are deliberately PLAIN variables rather than `$state`.
 * `_positions` is REPLACED wholesale on every change (a plain object in
 * `$state` is reactive at assignment); the two collections use
 * `SvelteSet`/`SvelteMap` and are mutated in place instead.
 */

export const LAYOUT_SAVE_DEBOUNCE_MS = 800;

/** Bounded because these are full buffer snapshots; the metamodel is tens of
 * KB, so 50 is cheap and deep enough for any realistic edit run (spec §3). */
const UNDO_MAX = 50;

type XY = { x: number; y: number };
type Positions = Record<string, XY>;

export interface MetamodelDiagramView {
	view: 'yaml' | 'diagram';
	/** Parsed from the CURRENT buffer; null whenever `parseErrors` is set. */
	mm: Metamodel | null;
	/** Non-empty → the canvas renders its syntax-error fallback, never a stale
	 * last-good diagram. */
	parseErrors: DraftError[];
	selection: DiagramSelection | null;
	/** Covers EVERY node of the current diagram: stored positions plus
	 * heuristic placement for whatever has none yet. */
	positions: Positions;
	collapsed: ReadonlySet<string>;
	canUndo: boolean;
	/** Lint errors attributed to the type block whose line range contains them
	 * — a red badge on that node. **Expect this to be EMPTY in practice**; see
	 * {@link attributeLintErrors}. Render `unattributedErrorCount` as the
	 * primary error surface and treat a per-node badge as the rare extra. */
	errorNodeIds: ReadonlySet<string>;
	/** Every lint error that could not be pinned to a drawn node — in practice
	 * all of them. This is THE error surface (a toolbar badge), so an error can
	 * never go unshown. */
	unattributedErrorCount: number;
}

/** One undoable step. The two halves are the two things a diagram gesture can
 * change: the shared BUFFER (an edit) and the LOCAL KEY SPACE (auto-arrange).
 * Positions and the deferral map travel together because a rename moves both,
 * and undoing one without the other would leave the map describing a rename
 * the buffer no longer contains. The deferral half is a plain pair list, not a
 * Map: it is dead storage until a pop, and copying it costs nothing. */
interface KeySnapshot {
	positions: Positions;
	renames: [string, string][];
}
interface UndoEntry {
	buffer: string | null;
	keys: KeySnapshot | null;
}

let _gen = 0;
let _projectId: string | null = null;
let _view = $state<'yaml' | 'diagram'>('yaml');
let _positions = $state<Positions>({});
/** Reactive collections (mutated in place rather than replaced), per the repo's
 * `svelte/prefer-svelte-reactivity` rule. `_pendingRenames` has no reader that
 * renders, but a plain Map in a `.svelte.ts` module is exactly the footgun that
 * rule exists to prevent, so it uses the same idiom. */
const _collapsed = new SvelteSet<string>();
const _pendingRenames = new SvelteMap<string, string>();
let _selection = $state<DiagramSelection | null>(null);
/** Mirrors `_undo.length > 0`; the stack itself stays non-reactive so its
 * snapshots are never wrapped in state proxies. */
let _canUndo = $state(false);
let _undo: UndoEntry[] = [];
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

// --- localStorage (view + collapse are PERSONAL, the rename deferral belongs
// to the DRAFT; positions are shared and live on the server) ----------------
// try/catch rather than a `browser` guard, matching metamodel-editor.svelte.ts.

function viewKey(projectId: string): string {
	return `ui.metamodel.view.${projectId}`;
}

function collapsedKey(projectId: string): string {
	return `ui.metamodel.collapsed.${projectId}`;
}

function renamesKey(projectId: string): string {
	return `ui.metamodel.renames.${projectId}`;
}

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* storage full/denied: the preference simply doesn't persist */
	}
}

function removeStored(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

// --- derived-from-buffer memos (plain vars: see the reactivity note above) --

let _parseFor: string | null = null;
let _parsed: ParsedDraft | null = null;

/** The view getter runs on every render pass, so the buffer is parsed at most
 * once per distinct text. The cached `doc` is READ-ONLY to every caller here —
 * the one place that mutates a Document (`applyDiagramEdit`) parses its own. */
function parseCurrent(buffer: string): ParsedDraft {
	if (_parsed === null || _parseFor !== buffer) {
		_parsed = parseDraft(buffer);
		_parseFor = buffer;
	}
	return _parsed;
}

let _builtFor: Metamodel | null = null;
let _built: { nodes: DiagramNodeSpec[]; edges: DiagramEdgeSpec[] } | null = null;

function builtDiagram(mm: Metamodel | null): {
	nodes: DiagramNodeSpec[];
	edges: DiagramEdgeSpec[];
} | null {
	if (mm === null) return null;
	if (_built === null || _builtFor !== mm) {
		_built = buildDiagram(mm);
		_builtFor = mm;
	}
	return _built;
}

let _placedFrom: { mm: Metamodel | null; positions: Positions } | null = null;
let _placed: Positions | null = null;

/** Positions handed to consumers ALWAYS cover every node: a type a peer added
 * (or a YAML edit introduced) has no stored position, and an invisible node is
 * worse than one placed next to its nearest neighbour (spec §5). The placement
 * is not written back — only a real drag or auto-arrange PUTs. */
function positionsForView(mm: Metamodel | null): Positions {
	const built = builtDiagram(mm);
	if (built === null) return _positions;
	if (_placed === null || _placedFrom?.mm !== mm || _placedFrom.positions !== _positions) {
		_placed = placeUnpositioned(built.nodes, built.edges, _positions);
		_placedFrom = { mm, positions: _positions };
	}
	return _placed;
}

interface Attribution {
	nodeIds: ReadonlySet<string>;
	unattributed: number;
}

/**
 * Attribute each lint error to the node whose YAML block encloses its line.
 * Anything without a line, or landing on something the canvas doesn't draw
 * (a boxless relationship type, an enum — `lineRangeForType` only spans the
 * two type sections), counts toward the toolbar badge instead, so no error is
 * ever silently dropped.
 *
 * **In practice that catch-all is the ONLY output**, and the reason is a
 * server contract: `POST /metamodel/lint` attaches a `line` **only** to a YAML
 * *syntax* error (off the parser's `problem_mark`); a schema error — the
 * realistic class here: dangling `extends`, duplicate names, anything that
 * clears the client's looser zod shape but fails the real loader — is
 * message-only (`api/schemas.py` `LintErrorOut`, `routes/metamodel_swap.py`).
 * So a line-bearing error implies a buffer that does not parse, which implies
 * `parsed.mm === null`, which leaves nothing drawn to badge.
 *
 * Hence the guard below, which exists to kill a MISattribution rather than to
 * enable an attribution: `_lintErrors` is not cleared on keystroke (only when
 * the next debounced lint resolves), so right after a syntax error is fixed
 * the stale line-bearing error is still in the array. If the local parse of
 * THIS buffer succeeds, that error provably describes an older one — the
 * server only emits a line for a syntax error, and the local parse just proved
 * this text has none — so its line must not be allowed to badge whichever node
 * happens to span it. The narrow cost is a lint that JS `yaml` accepts and
 * PyYAML rejects (parser-strictness divergence, e.g. duplicate keys); those
 * fall back to the toolbar badge, which is the honest place for an error the
 * canvas cannot localise.
 */
function attributeLintErrors(
	buffer: string,
	parsed: ParsedDraft,
	errors: readonly { line: number | null }[]
): Attribution {
	if (errors.length === 0) return { nodeIds: new Set<string>(), unattributed: 0 };
	if (parsed.errors.length === 0)
		return { nodeIds: new Set<string>(), unattributed: errors.length };
	const built = builtDiagram(parsed.mm);
	const drawn = new Set((built?.nodes ?? []).map((n) => n.id));
	const ranges: { start: number; end: number; id: string }[] = [];
	const collect = (section: SectionKey, name: string, id: string): void => {
		if (!drawn.has(id)) return;
		const range = lineRangeForType(buffer, parsed.doc, section, name);
		if (range !== null) ranges.push({ ...range, id });
	};
	for (const el of parsed.mm?.elements ?? []) {
		collect('elements', el.name, nodeIdFor({ kind: 'element', name: el.name }));
	}
	for (const rel of parsed.mm?.relationships ?? []) {
		collect('relationships', rel.name, nodeIdFor({ kind: 'relationship', name: rel.name }));
	}
	const hits: string[] = [];
	let unattributed = 0;
	for (const err of errors) {
		const line = err.line;
		const hit = line === null ? undefined : ranges.find((r) => line >= r.start && line <= r.end);
		if (hit === undefined) unattributed++;
		else hits.push(hit.id);
	}
	return { nodeIds: new Set(hits), unattributed };
}

let _attrFor: { buffer: string; errors: readonly unknown[] } | null = null;
let _attr: Attribution | null = null;

/** Memoized on (buffer, lint-error array identity): the view getter runs on
 * every render pass, and re-walking every type block's line range there would
 * make the canvas pay for the gutter. */
function attributionFor(
	buffer: string,
	parsed: ParsedDraft,
	errors: readonly { line: number | null }[]
): Attribution {
	if (_attr === null || _attrFor?.buffer !== buffer || _attrFor.errors !== errors) {
		_attr = attributeLintErrors(buffer, parsed, errors);
		_attrFor = { buffer, errors };
	}
	return _attr;
}

export function getMetamodelDiagramView(): MetamodelDiagramView {
	const ed = getMetamodelEditor();
	const parsed = parseCurrent(ed.buffer);
	const attribution = attributionFor(ed.buffer, parsed, ed.lintErrors);
	return {
		view: _view,
		mm: parsed.mm,
		parseErrors: parsed.errors,
		selection: _selection,
		positions: positionsForView(parsed.mm),
		collapsed: _collapsed,
		canUndo: _canUndo,
		errorNodeIds: attribution.nodeIds,
		unattributedErrorCount: attribution.unattributed
	};
}

export function setMetamodelView(v: 'yaml' | 'diagram'): void {
	_view = v;
	if (_projectId !== null) writeStored(viewKey(_projectId), v);
}

// --- shared layout blob ----------------------------------------------------

/** Editors AND owners persist positions; only viewers are shut out (spec §5 —
 * layout is presentation, so it deliberately does NOT follow the owner-only
 * gate that buffer edits use). */
function canSaveLayout(): boolean {
	return getRole() !== 'viewer';
}

function clonePositions(src: Positions): Positions {
	const out: Positions = {};
	for (const [id, p] of Object.entries(src)) out[id] = { x: p.x, y: p.y };
	return out;
}

/** The node ids the CURRENT draft actually defines, or null when it does not
 * parse (nothing can be validated against an unparseable draft, so callers
 * skip their filter rather than discarding state they cannot check). */
function liveNodeIds(mm: Metamodel | null): ReadonlySet<string> | null {
	if (mm === null) return null;
	// Built without mutation: a mutable `Set` in a `.svelte.ts` module is what
	// `svelte/prefer-svelte-reactivity` bans (see the reactivity note above).
	return new Set([
		...mm.elements.map((el) => nodeIdFor({ kind: 'element', name: el.name })),
		...mm.relationships.map((rel) => nodeIdFor({ kind: 'relationship', name: rel.name })),
		...Object.keys(mm.enums).map((name) => nodeIdFor({ kind: 'enum', name }))
	]);
}

/** The deferrals a PUT should honour, and the baseline keys they claim.
 *
 * A deferral whose LOCAL name the draft no longer defines is not automatically
 * junk: a discard, an undo outside this module, or a delete typed into the YAML
 * view leaves the position parked under a local key while the box itself is
 * still `server` for every peer, so rewriting it back is what keeps their
 * position alive. It is dropped only when something LIVE already occupies that
 * baseline key — the name-reuse case, where the real node must win. */
function liveRenames(): { toServer: Record<string, string>; servers: ReadonlySet<string> } {
	const live = liveNodeIds(parseCurrent(getMetamodelEditor().buffer).mm);
	const toServer: Record<string, string> = {};
	const servers: string[] = [];
	for (const [server, local] of _pendingRenames) {
		if (live !== null && !live.has(local) && _positions[server] !== undefined) continue;
		toServer[local] = server;
		servers.push(server);
	}
	return { toServer, servers: new Set(servers) };
}

/** Local positions expressed in the SERVER's key space: every key that a
 * draft-only rename moved is written back under the baseline name it still has
 * for everyone else. See the rename key-deferral note in the module docstring. */
function serverPositions(): Positions {
	if (_pendingRenames.size === 0) return clonePositions(_positions);
	const { toServer, servers } = liveRenames();
	const out: Positions = {};
	for (const [id, p] of Object.entries(_positions)) {
		const server = toServer[id];
		if (server !== undefined) {
			out[server] = { x: p.x, y: p.y };
			continue;
		}
		// The draft re-used a baseline name the deferral still owns (rename
		// `Zone → District`, then create a fresh `Zone`). Two local keys would
		// otherwise land on one server key, last-`Object.entries`-wins. The
		// deferral wins — it describes a box peers can actually see — and the
		// re-used name has no server counterpart until a rebind lands.
		if (servers.has(id)) continue;
		out[id] = { x: p.x, y: p.y };
	}
	return out;
}

/** The inverse: a blob fetched in the SERVER's key space, re-keyed to the
 * draft's names so a restored rename does not read as an unpositioned node and
 * jump to a heuristic slot. Same collision rule as `serverPositions` — the
 * deferral wins the contested key. Called only from `initMetamodelDiagram`,
 * immediately after `restoreRenames` has pruned the map against the draft, so
 * it needs no validity filter of its own. */
function localPositions(src: Positions): Positions {
	if (_pendingRenames.size === 0) return clonePositions(src);
	const targets = new Set(_pendingRenames.values());
	const out: Positions = {};
	for (const [id, p] of Object.entries(src)) {
		const local = _pendingRenames.get(id);
		if (local !== undefined) {
			out[local] = { x: p.x, y: p.y };
			continue;
		}
		if (targets.has(id)) continue;
		out[id] = { x: p.x, y: p.y };
	}
	return out;
}

function saveNow(): void {
	if (!canSaveLayout()) return;
	// Presentation-only and last-write-wins: a rejected PUT is not worth an
	// error surface over a metamodel edit — the next drag retries.
	void putMetamodelLayout({ positions: serverPositions() }).catch(() => {});
}

function scheduleSave(): void {
	if (!canSaveLayout()) return;
	if (_saveTimer !== null) clearTimeout(_saveTimer);
	_saveTimer = setTimeout(() => {
		_saveTimer = null;
		saveNow();
	}, LAYOUT_SAVE_DEBOUNCE_MS);
}

function flushSave(): void {
	if (_saveTimer === null) return;
	clearTimeout(_saveTimer);
	_saveTimer = null;
	saveNow();
}

// --- lifecycle -------------------------------------------------------------

/**
 * Open the canvas for a project: restore the personal view/collapse
 * preferences, fetch the shared positions, and auto-arrange a diagram nobody
 * has ever arranged.
 *
 * Call this AFTER `initMetamodelEditor` has resolved. The auto-arrange reads
 * the editor's buffer, so on an empty one it correctly finds no nodes and
 * skips — leaving a first-open diagram unarranged until the toolbar button is
 * pressed. Nothing breaks either way; the ordering is what makes the automatic
 * first arrangement happen.
 */
export async function initMetamodelDiagram(projectId: string): Promise<void> {
	// Same generation-guard idiom as `initMetamodelEditor`: everything async
	// below re-checks `_gen` so a close (or a project switch) mid-flight can
	// never adopt a layout for a surface that is gone.
	const gen = ++_gen;
	_projectId = projectId;
	_view = readStored(viewKey(projectId)) === 'diagram' ? 'diagram' : 'yaml';
	restoreCollapsed(projectId);
	_selection = null;
	_positions = {};
	_undo = [];
	_canUndo = false;
	// BEFORE the fetch: the restored map is what re-keys the incoming blob into
	// the draft's names. Reads the editor's buffer, which is why this function
	// is documented as running after `initMetamodelEditor` has resolved — a
	// draft that has not landed yet would validate every entry away.
	restoreRenames(projectId);
	try {
		const layout = await getMetamodelLayout();
		if (gen !== _gen) return;
		_positions = localPositions(layout.positions);
	} catch {
		// No stored layout / transient failure: fall through to the auto-arrange
		// below rather than showing a canvas with everything stacked at 0,0.
		if (gen !== _gen) return;
	}
	if (Object.keys(_positions).length > 0) return;
	const built = builtDiagram(parseCurrent(getMetamodelEditor().buffer).mm);
	if (built === null || built.nodes.length === 0) return;
	const arranged = await autoArrange(built.nodes, built.edges, _collapsed);
	if (gen !== _gen) return;
	_positions = arranged;
	// First open of a never-arranged diagram: persist it so peers (and the next
	// session) open on the same picture. Viewers arrange locally and save nothing.
	scheduleSave();
}

function restoreCollapsed(projectId: string): void {
	_collapsed.clear();
	const raw = readStored(collapsedKey(projectId));
	if (raw === null) return;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return;
		for (const id of parsed) if (typeof id === 'string') _collapsed.add(id);
	} catch {
		/* corrupt entry: everything simply opens expanded */
	}
}

function persistCollapsed(): void {
	if (_projectId === null) return;
	writeStored(collapsedKey(_projectId), JSON.stringify([..._collapsed]));
}

/** Mirror the deferral map next to the draft it belongs to. Called from every
 * writer of `_pendingRenames` EXCEPT `closeMetamodelDiagram`, which drops the
 * in-memory copy while the draft (and therefore the deferral) lives on. */
function persistRenames(): void {
	if (_projectId === null) return;
	if (_pendingRenames.size === 0) removeStored(renamesKey(_projectId));
	else writeStored(renamesKey(_projectId), JSON.stringify([..._pendingRenames]));
}

/** Restore the deferral map, dropping every entry the CURRENT draft no longer
 * backs — the staleness guard that stands in for the discard/other-tab hooks
 * this module has no way to observe (module docstring). The pruned map is
 * written straight back, so a dead entry is gone for good rather than
 * re-validated on every open. */
function restoreRenames(projectId: string): void {
	_pendingRenames.clear();
	const raw = readStored(renamesKey(projectId));
	if (raw === null) return;
	const live = liveNodeIds(parseCurrent(getMetamodelEditor().buffer).mm);
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return;
		for (const entry of parsed) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [server, local]: unknown[] = entry;
			if (typeof server !== 'string' || typeof local !== 'string') continue;
			if (live !== null && !live.has(local)) continue;
			_pendingRenames.set(server, local);
		}
	} catch {
		/* corrupt entry: the draft simply loses its deferrals */
	}
	persistRenames();
}

/** Tab close / unmount: flush the pending PUT before dropping the positions it
 * would have sent, then reset. The persisted view, collapse and rename-deferral
 * state survive in localStorage (the last of those belongs to the draft, which
 * also survives — `initMetamodelDiagram` restores and re-validates it); the
 * undo stack does not, since it describes a session's in-flight editing. */
export function closeMetamodelDiagram(): void {
	flushSave();
	_gen++;
	_view = 'yaml';
	_positions = {};
	_collapsed.clear();
	_selection = null;
	_undo = [];
	_canUndo = false;
	_pendingRenames.clear();
	_projectId = null;
}

// --- selection & collapse (personal state) ---------------------------------

export function selectDiagramNode(sel: DiagramSelection | null): void {
	_selection = sel;
}

export function toggleNodeCollapsed(nodeId: string): void {
	if (!_collapsed.delete(nodeId)) _collapsed.add(nodeId);
	persistCollapsed();
}

export function setAllCollapsed(collapsed: boolean): void {
	_collapsed.clear();
	if (collapsed) {
		const built = builtDiagram(parseCurrent(getMetamodelEditor().buffer).mm);
		for (const n of built?.nodes ?? []) _collapsed.add(n.id);
	}
	persistCollapsed();
}

// --- edits -----------------------------------------------------------------

function pushUndo(entry: UndoEntry): void {
	_undo.push(entry);
	if (_undo.length > UNDO_MAX) _undo.shift();
	_canUndo = true;
}

function snapshotKeys(): KeySnapshot {
	return { positions: clonePositions(_positions), renames: [..._pendingRenames] };
}

/** The node id a command's subject is keyed under, for the commands that move
 * or drop a position key. Everything else returns null and leaves the key
 * space alone. */
function keyMove(cmd: YamlEditCommand): { from: string; to: string | null } | null {
	const el = (name: string): string => nodeIdFor({ kind: 'element', name });
	const rel = (name: string): string => nodeIdFor({ kind: 'relationship', name });
	const en = (name: string): string => nodeIdFor({ kind: 'enum', name });
	switch (cmd.kind) {
		case 'renameElementType':
			return { from: el(cmd.from), to: el(cmd.to) };
		case 'renameRelationshipType':
			return { from: rel(cmd.from), to: rel(cmd.to) };
		case 'renameEnum':
			return { from: en(cmd.from), to: en(cmd.to) };
		case 'removeElementType':
			return { from: el(cmd.name), to: null };
		case 'removeRelationshipType':
			return { from: rel(cmd.name), to: null };
		case 'removeEnum':
			return { from: en(cmd.name), to: null };
		default:
			return null;
	}
}

/** Keep the canvas still across a rename (the box stays where the user put it)
 * while recording that the SHARED blob must keep using the baseline key until
 * a rebind lands. Chained renames compose: `Zone→District→Region` leaves one
 * entry `el:Zone → el:Region`, and a rename back to the baseline name drops
 * the entry entirely. */
function applyKeyMove(move: { from: string; to: string | null }): void {
	const next = { ..._positions };
	const pos = next[move.from];
	delete next[move.from];
	if (move.to !== null && pos !== undefined) next[move.to] = pos;
	_positions = next;

	if (move.to === null) {
		// Deleted: drop any deferral pointing at it. The server keeps its stale
		// key until the next successful save, which is harmless — a position for
		// a type that no longer exists is simply never read.
		for (const [server, local] of _pendingRenames) {
			if (local === move.from) _pendingRenames.delete(server);
		}
		persistRenames();
		return;
	}
	let server = move.from;
	for (const [s, local] of _pendingRenames) {
		if (local === move.from) {
			server = s;
			_pendingRenames.delete(s);
			break;
		}
	}
	if (server !== move.to) _pendingRenames.set(server, move.to);
	persistRenames();
}

/**
 * Apply one semantic command to the shared draft. Returns false — changing
 * nothing — when the surface is read-only (viewer/editor, a peer's lease, a
 * rebind in flight) or the buffer does not parse, which is exactly when the
 * canvas is showing its fallback and no command has a meaning.
 */
export function applyDiagramEdit(cmd: YamlEditCommand): boolean {
	const ed = getMetamodelEditor();
	// `readOnly` is a superset of the editor module's own edit gate, so a
	// command can never slip past a guard `editMetamodelBuffer` would enforce.
	if (ed.readOnly) return false;
	// A FRESH parse, deliberately not the `parseCurrent` memo: `applyEdit`
	// mutates the Document in place, which would leave the cache holding an
	// edited doc under the pre-edit buffer's key.
	const parsed = parseDraft(ed.buffer);
	if (parsed.errors.length > 0 || parsed.mm === null) return false;
	try {
		applyEdit(parsed.doc, cmd);
	} catch {
		// `applyEdit` mutates surgically or throws without touching the doc, so
		// a rejected command (unknown type name) leaves the draft as it was.
		return false;
	}
	const next = serializeDraft(parsed.doc);
	const move = keyMove(cmd);
	pushUndo({ buffer: ed.buffer, keys: move === null ? null : snapshotKeys() });
	if (move !== null) applyKeyMove(move);
	editMetamodelBuffer(next);
	return true;
}

export function undoDiagramEdit(): void {
	const entry = _undo.pop();
	_canUndo = _undo.length > 0;
	if (entry === undefined) return;
	if (entry.keys !== null) {
		_positions = entry.keys.positions;
		_pendingRenames.clear();
		for (const [server, local] of entry.keys.renames) _pendingRenames.set(server, local);
		persistRenames();
		scheduleSave();
	}
	// Through the same seam as any other edit: the restored text lands in the
	// shared buffer, so lint, draft mirroring and dirty all re-fire normally.
	if (entry.buffer !== null) editMetamodelBuffer(entry.buffer);
}

export function moveNode(nodeId: string, pos: XY): void {
	_positions = { ..._positions, [nodeId]: { x: pos.x, y: pos.y } };
	scheduleSave();
}

/** Re-run the layered layout over the whole diagram. Undoable because it is
 * destructive to hand-tuning (spec §5), and saved like any other position
 * change. */
export async function runAutoArrange(): Promise<void> {
	const built = builtDiagram(parseCurrent(getMetamodelEditor().buffer).mm);
	if (built === null || built.nodes.length === 0) return;
	const gen = _gen;
	const arranged = await autoArrange(built.nodes, built.edges, _collapsed);
	if (gen !== _gen) return;
	pushUndo({ buffer: null, keys: snapshotKeys() });
	_positions = arranged;
	scheduleSave();
}

/**
 * A rebind LANDED: the draft's names are now the project's names, so every
 * deferred key rewrite becomes true at once. Clears the deferral map and PUTs
 * the local keys immediately (not debounced — the window where the shared blob
 * still points at names nobody uses should be as short as possible).
 *
 * The UNDO STACK goes with it, because a rebind moves the baseline the stack's
 * snapshots were taken against. Undoing across it would restore a `keys` half
 * captured before the rename landed and then PUT it: rename `Zone → District`,
 * drag, rebind (peers now see `District` at the new spot), undo — and without
 * this the next PUT sends `el:Zone`, a name the server no longer has, which
 * strips every peer's `el:District` position and re-places the box by
 * heuristic. That is precisely the peer-canvas corruption the deferral exists
 * to prevent. Dropping the history is also what the user means: the buffer
 * halves describe pre-rebind text that has since been committed to the
 * project, and "undo" is no longer a local operation on it.
 */
export function onMetamodelRebound(): void {
	_pendingRenames.clear();
	persistRenames();
	_undo = [];
	_canUndo = false;
	if (_saveTimer !== null) {
		clearTimeout(_saveTimer);
		_saveTimer = null;
	}
	saveNow();
}
