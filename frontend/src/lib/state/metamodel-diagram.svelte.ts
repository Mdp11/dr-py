import { getMetamodelLayout } from '$lib/api/metamodel';
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
import { SvelteSet } from 'svelte/reactivity';
import { getRole, isCheckedOutByMe } from './checkout.svelte';
import {
	editMetamodelBuffer,
	getMetamodelEditor,
	noteMetamodelLockConflict
} from './metamodel-editor.svelte';
import { acquireMetamodelLease, getMetamodelLockHolder } from './metamodel-lease.svelte';
import {
	discardStagedNodeMoves,
	getStagedNodeMoves,
	initMetamodelStage,
	onMetamodelCommitted,
	stageNodeMove
} from './metamodel-stage.svelte';
import { METAMODEL_RESOURCE } from './ops';
import { onCommitEvent } from './realtime.svelte';

/**
 * The DIAGRAM half of the metamodel tab. Its job is to
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
 * **Layout is presentation, but it is COMMITTED content**: a drag stages a
 * `metamodel.move_node` op through `metamodel-stage.svelte.ts` and lands on
 * `POST /commits` with everything else. `GET /metamodel/layout` is the read
 * of the materialized baseline. The STAGING gate is
 * `getRole() !== 'viewer'` — editors stage too, unlike buffer editing which
 * stays owner-only through the editor module's own `isEditBlocked()` — so a
 * viewer still drags, purely locally, with nothing to commit. Staging also
 * ACQUIRES the singleton `mm` lease (the backend verifies it for the whole
 * `metamodel.*` family, not just the rebind), which is why this module
 * composes `metamodel-lease.svelte.ts` at all — see {@link stageMove} and
 * {@link maybeAcquireLayoutLease}.
 *
 * **A staged position never needs rename key-deferral**: a staged position and
 * the staged `metamodel.rebind` that renamed its node ride the SAME commit
 * batch, so the keys ever published are
 * atomically the ones the draft's own names produce. `_positions` is therefore
 * plain draft-key space from end to end — no inversion before a write, no
 * re-keying of a fetched blob, no map to persist and self-validate.
 *
 * Reactivity note: `$state` is never written from `getMetamodelDiagramView()`
 * (that would trip `state_unsafe_mutation` mid-render), so the memoization
 * caches below are deliberately PLAIN variables rather than `$state`.
 * `_positions` is REPLACED wholesale on every change (a plain object in
 * `$state` is reactive at assignment); `_collapsed` is a `SvelteSet` and is
 * mutated in place instead.
 */

/** Bounded because these are full buffer snapshots; the metamodel is tens of
 * KB, so 50 is cheap and deep enough for any realistic edit run. */
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
	 * — a red badge on that node. **Empty in every reachable state**; see
	 * {@link attributeLintErrors} for why the server contract makes it so.
	 * `unattributedErrorCount` is THE error surface; do not build (or test) a
	 * per-node badge against this set expecting it to be populated. */
	errorNodeIds: ReadonlySet<string>;
	/** Every lint error that could not be pinned to a drawn node — in practice
	 * all of them. This is THE error surface (a toolbar badge), so an error can
	 * never go unshown. */
	unattributedErrorCount: number;
}

/** One undoable step. The two halves are the two things a diagram gesture can
 * change: the shared BUFFER (an edit) and the POSITION KEY SPACE (a rename, a
 * delete, an auto-arrange). Restoring the key half also RE-STAGES the delta it
 * implies — see {@link stagePositionDelta} — so an undo moves the pending
 * commit back in step with the canvas. */
interface KeySnapshot {
	positions: Positions;
}
interface UndoEntry {
	buffer: string | null;
	keys: KeySnapshot | null;
}

let _gen = 0;
let _projectId: string | null = null;
let _view = $state<'yaml' | 'diagram'>('yaml');
let _positions = $state<Positions>({});
/** Mutated in place rather than replaced (it is rendered directly), which is
 * why it is a `SvelteSet` and not a plain `Set` — the repo's
 * `svelte/prefer-svelte-reactivity` rule. */
const _collapsed = new SvelteSet<string>();
let _selection = $state<DiagramSelection | null>(null);
/** Mirrors `_undo.length > 0`; the stack itself stays non-reactive so its
 * snapshots are never wrapped in state proxies. */
let _canUndo = $state(false);
let _undo: UndoEntry[] = [];
/** Unsubscribe for the peer-commit tap registered by
 * {@link initMetamodelDiagram}; null while the surface is closed. */
let _unsubCommitFeed: (() => void) | null = null;

// --- localStorage (view + collapse are PERSONAL; positions live in the staged
// commit batch, whose own localStorage mirror belongs to metamodel-stage) ---
// try/catch rather than a `browser` guard, matching metamodel-editor.svelte.ts.

function viewKey(projectId: string): string {
	return `ui.metamodel.view.${projectId}`;
}

function collapsedKey(projectId: string): string {
	return `ui.metamodel.collapsed.${projectId}`;
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
 * worse than one placed next to its nearest neighbour. The placement
 * is not staged — only a real drag or auto-arrange proposes a move op. */
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

// --- positions: baseline + staged overlay ----------------------------------

/** Editors AND owners stage positions; only viewers are shut out — layout is
 * presentation, so it deliberately does NOT follow the owner-only gate that
 * buffer edits use. A viewer's drags stay local to their canvas.
 *
 * The second term is the peer-lease one: `metamodel.move_node` needs the `mm`
 * lease at commit time exactly as a rebind does (`api/locking.py`'s
 * `required_locks` covers the whole family), so once a peer is known to hold
 * it there is nothing worth staging — the batch could only 409. Read from the
 * editor module rather than mirrored here so a Retry there re-enables the
 * canvas too; see {@link maybeAcquireLayoutLease}. */
function canStageLayout(): boolean {
	return getRole() !== 'viewer' && getMetamodelEditor().lockedBy === null;
}

/** True while a layout acquire is in flight. A drag burst is dozens of pointer
 * moves; this is what keeps them to ONE `/locks` call.
 *
 * Deliberately NOT reset by {@link initMetamodelDiagram} /
 * {@link closeMetamodelDiagram}: it tracks a request, not a surface, so
 * clearing it under an in-flight acquire would only add a redundant second
 * call (harmless since `acquireMetamodelLease` coalesces, but pointless).
 * Every settle path below clears it, so a closed surface leaves nothing
 * latched. */
let _acquiringLayoutLease = false;

/**
 * Ask for the `mm` lease because something is about to be staged.
 *
 * WHY: a staged move is committed content, and
 * `create_commit` hard-verifies the singleton `mm` lease for EVERY op in the
 * `metamodel.*` family. The editor's own `maybeAcquireLease` cannot cover this
 * — it is owner-gated and fires only on a buffer edit, while an EDITOR may
 * stage layout moves and never touch the YAML. Without this a drag produced an
 * op nothing held a lease for, and the next `POST /commits` 409'd the WHOLE
 * mixed batch (model + artifact + view edits included), repeatedly, because the
 * move survives in localStorage until the user finds the drawer's discard.
 *
 * FIRE-AND-FORGET, never awaited: a pointer move is synchronous and must not
 * wait on a round trip. The move is staged optimistically alongside this call
 * and un-staged below if the answer is a conflict.
 *
 * "Already held" is read from the CHECKOUT REGISTRY, not from a local flag,
 * and that is deliberate: the registry is the same source `ensureCheckout`
 * consults, so a lease surrendered underneath this module — a commit (the
 * server releases every token it is sent), a Discard-all, a tab close — re-arms
 * the acquire automatically. A cached `held` boolean would go stale at exactly
 * those three points and let the next drag stage a move with no lease behind
 * it, which is the very bug being fixed.
 */
function maybeAcquireLayoutLease(): void {
	if (_acquiringLayoutLease || isCheckedOutByMe(METAMODEL_RESOURCE)) return;
	_acquiringLayoutLease = true;
	const gen = _gen;
	void acquireMetamodelLease().then(
		(ok) => {
			_acquiringLayoutLease = false;
			if (ok || gen !== _gen) return;
			const holder = getMetamodelLockHolder();
			// A NON-conflict refusal (viewer, transient network) leaves everything
			// as it is: the next stage retries, and the server honors the lease as
			// the backstop — the same stance the editor's acquire takes.
			if (holder === null) return;
			// A peer holds it. Report it through the editor module (one holder,
			// one Retry, one "locked by" strip) and DROP the moves staged in the
			// optimistic window: they can never satisfy the commit's lock check,
			// so leaving them would poison every later batch. The canvas keeps
			// them in `_positions` — the drag stays LOCAL, exactly like the
			// editor keeping the characters typed before its own refusal — until
			// the next baseline refetch re-derives from the server.
			noteMetamodelLockConflict(holder);
			discardStagedNodeMoves();
		},
		() => {
			// `ensureCheckout` re-raises anything that is not a 409. Nothing to
			// record: the lease is simply not held, and the next stage retries.
			_acquiringLayoutLease = false;
		}
	);
}

/**
 * THE staging choke point — the only caller of `stageNodeMove` in this module,
 * which is the point of it. Four gestures stage positions ({@link moveNode},
 * {@link runAutoArrange}, {@link applyKeyMove}, {@link stagePositionDelta}) and
 * every one of them needs the same two things: the permission check and the
 * lease. Putting them at one seam means a fifth staging path cannot be added
 * that forgets the acquire, and the burst dedupe has a single home.
 */
function stageMove(node: string, pos: XY | null): void {
	if (!canStageLayout()) return;
	maybeAcquireLayoutLease();
	stageNodeMove(node, pos);
}

function clonePositions(src: Positions): Positions {
	const out: Positions = {};
	for (const [id, p] of Object.entries(src)) out[id] = { x: p.x, y: p.y };
	return out;
}

/** What the canvas should show for a freshly fetched BASELINE blob: the
 * durable positions with this session's still-uncommitted moves laid over
 * them. Every read of the baseline goes through here — an overlay-less refetch
 * would snap a staged (or staged-and-restored-from-storage) drag back to the
 * last committed spot while the op that moves it is still pending. */
function withStagedMoves(src: Positions): Positions {
	const next = clonePositions(src);
	for (const [node, pos] of getStagedNodeMoves()) {
		if (pos === null) delete next[node];
		else next[node] = { x: pos.x, y: pos.y };
	}
	return next;
}

/** Re-read the durable baseline and re-derive `_positions` from it. Swallows
 * failures: layout is presentation, and a missed refresh is re-fetched by the
 * next commit or reopen — never an error surface over a metamodel edit. */
async function refetchBaselineLayout(): Promise<void> {
	const gen = _gen;
	try {
		const layout = await getMetamodelLayout();
		if (gen !== _gen) return;
		_positions = withStagedMoves(layout.positions);
	} catch {
		/* presentation-only; the canvas keeps what it has */
	}
}

/**
 * Stage the ops that turn `from` into `to` — the minimal set, not the whole
 * map. This is the staged-commit analogue of the debounced whole-blob PUT the
 * old undo path fired: an undo that moved `_positions` back without touching
 * the staged batch would leave the pending commit publishing the positions the
 * user just undid, and the next commit-refetch would snap the canvas to them.
 *
 * A `null` for a key that was never in the baseline is a harmless no-op on the
 * server (dropping an absent layout key), which is what lets this stay a pure
 * before/after diff with no baseline knowledge of its own.
 */
function stagePositionDelta(from: Positions, to: Positions): void {
	// The early return is a cheap short-circuit only — `stageMove` re-checks the
	// same predicate, so this cannot be the path that forgets a guard.
	if (!canStageLayout()) return;
	for (const [id, p] of Object.entries(to)) {
		const prev = from[id];
		if (prev !== undefined && prev.x === p.x && prev.y === p.y) continue;
		stageMove(id, p);
	}
	for (const id of Object.keys(from)) {
		if (to[id] === undefined) stageMove(id, null);
	}
}

// --- lifecycle -------------------------------------------------------------

/**
 * Open the canvas for a project: restore the personal view/collapse
 * preferences, re-open the move stage, fetch the durable positions (with the
 * still-staged moves laid over them), and auto-arrange — locally — a diagram
 * nobody has ever arranged.
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
	// BEFORE anything reads the staged moves: this re-points the stage at this
	// project and reloads whatever a previous session left staged for it.
	initMetamodelStage(projectId);
	_view = readStored(viewKey(projectId)) === 'diagram' ? 'diagram' : 'yaml';
	restoreCollapsed(projectId);
	_selection = null;
	_positions = {};
	_undo = [];
	_canUndo = false;
	// A peer's committed move lands as a `metamodel-layout`-scoped commit event;
	// re-read the baseline so their drag shows up without a reopen. Registered
	// here (not at module scope) so the tap's lifetime is the surface's, and
	// re-registered per init — the unsubscribe below covers a re-init.
	_unsubCommitFeed?.();
	_unsubCommitFeed = onCommitEvent(({ scope }) => {
		if (scope.includes('metamodel-layout')) void refetchBaselineLayout();
	});
	try {
		const layout = await getMetamodelLayout();
		if (gen !== _gen) return;
		_positions = withStagedMoves(layout.positions);
	} catch {
		// A FAILURE ONLY: a project with no stored layout answers 200 with
		// `{positions: {}}` (routes/metamodel_layout.py), so it lands above, not
		// here. This is a 500 / network blip / backend restart, and the canvas
		// falls through to the local arrangement below.
		if (gen !== _gen) return;
	}
	if (Object.keys(_positions).length > 0) return;
	const built = builtDiagram(parseCurrent(getMetamodelEditor().buffer).mm);
	if (built === null || built.nodes.length === 0) return;
	const arranged = await autoArrange(built.nodes, built.edges, _collapsed);
	if (gen !== _gen) return;
	// LOCAL ONLY — deliberately NOT staged, unlike the toolbar's
	// `runAutoArrange`. This runs on merely OPENING a never-arranged diagram, so
	// staging it would manufacture a pending commit (and a dirty commit drawer,
	// and a held `mm` lease) out of nothing the user did. A local canvas still
	// beats stacking every box at (0,0); one deliberate drag or Auto-arrange
	// click is what turns the picture into something to commit.
	_positions = arranged;
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

/**
 * Tab close / unmount: drop the tap and reset. The persisted view and collapse
 * preferences survive in localStorage, and so — deliberately — do the STAGED
 * MOVES: they are uncommitted work, exactly like the YAML draft next door, and
 * `metamodel-editor.svelte.ts`'s close explicitly counts on them outliving the
 * tab (they are what keeps the `mm` lease from being handed back with a
 * position still pending). That is why this does NOT call
 * `closeMetamodelStage()`. The undo stack does not survive, since it describes
 * a session's in-flight editing.
 */
export function closeMetamodelDiagram(): void {
	_unsubCommitFeed?.();
	_unsubCommitFeed = null;
	_gen++;
	_view = 'yaml';
	_positions = {};
	_collapsed.clear();
	_selection = null;
	_undo = [];
	_canUndo = false;
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
	return { positions: clonePositions(_positions) };
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
 * and stage the key migration that goes with it. */
function applyKeyMove(move: { from: string; to: string | null }): void {
	const next = { ..._positions };
	const pos = next[move.from];
	delete next[move.from];
	if (move.to !== null && pos !== undefined) next[move.to] = pos;
	_positions = next;
	// The layout key migrates WITH the rename, in the SAME commit: the old key
	// is dropped and the new one claims the position, and neither is visible to
	// a peer until the `metamodel.rebind` that renames the type lands beside
	// them. A delete just drops the key. This is what makes the old rename
	// key-deferral unnecessary (module docstring). Through {@link stageMove}
	// like every other staging path — the permission check moved in there.
	stageMove(move.from, null);
	if (move.to !== null && pos !== undefined) stageMove(move.to, pos);
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

/**
 * Pop one step. Guarded on `readOnly` exactly like {@link applyDiagramEdit},
 * and for a sharper reason than symmetry: the key half below is applied
 * UNCONDITIONALLY while the buffer half goes through `editMetamodelBuffer`,
 * which silently drops the write when the editor's own `isEditBlocked()` says
 * so. Without this guard the two halves desync — reachable, because the `mm`
 * lease is acquired asynchronously on the first divergent keystroke or node
 * drag, so a diagram rename can land and only THEN lose the race to a peer. The
 * rollback would re-stage the pre-rename layout keys while the draft kept the
 * rename, so the commit would publish positions for names it never sends.
 *
 * `readOnly` and the editor's own `isEditBlocked()` are ONE predicate now (spec
 * 2026-08-16): they differed only by the rebind-in-flight flag, and a rebind is
 * an op in the commit batch rather than a flight the surface freezes for.
 */
export function undoDiagramEdit(): void {
	if (getMetamodelEditor().readOnly) return;
	const entry = _undo.pop();
	_canUndo = _undo.length > 0;
	if (entry === undefined) return;
	if (entry.keys !== null) {
		const before = _positions;
		_positions = entry.keys.positions;
		// The staged batch follows the canvas back; see stagePositionDelta.
		stagePositionDelta(before, _positions);
	}
	// Through the same seam as any other edit: the restored text lands in the
	// shared buffer, so lint, draft mirroring and dirty all re-fire normally.
	if (entry.buffer !== null) editMetamodelBuffer(entry.buffer);
}

export function moveNode(nodeId: string, pos: XY): void {
	// The canvas moves FIRST and unconditionally: a viewer's drag, and a drag
	// made while a peer holds the `mm` lease, are still local navigation.
	_positions = { ..._positions, [nodeId]: { x: pos.x, y: pos.y } };
	stageMove(nodeId, { x: pos.x, y: pos.y });
}

/** Re-run the layered layout over the whole diagram. Undoable because it is
 * destructive to hand-tuning, and staged like any other position
 * change — this is the TOOLBAR button, a deliberate gesture, unlike the
 * first-open arrange in {@link initMetamodelDiagram} which stays local. */
export async function runAutoArrange(): Promise<void> {
	const built = builtDiagram(parseCurrent(getMetamodelEditor().buffer).mm);
	if (built === null || built.nodes.length === 0) return;
	const gen = _gen;
	const arranged = await autoArrange(built.nodes, built.edges, _collapsed);
	if (gen !== _gen) return;
	pushUndo({ buffer: null, keys: snapshotKeys() });
	_positions = arranged;
	// One acquire for the whole arrangement, not one per node: the in-flight
	// flag inside {@link maybeAcquireLayoutLease} collapses the burst.
	for (const [id, p] of Object.entries(arranged)) stageMove(id, p);
}

/**
 * A rebind LANDED. Drops the UNDO STACK, because a rebind moves the baseline
 * the stack's snapshots were taken against: the buffer halves describe
 * pre-rebind text that has since been committed to the project, so "undo" is
 * no longer a local operation on it, and the key halves would re-stage
 * positions for names the draft has moved on from.
 */
export function onMetamodelRebound(): void {
	// Every other public entry here is project-guarded; this one was not.
	// Unreachable today (the tab only calls it while mounted), but keeping the
	// guard means a call after `closeMetamodelDiagram` cannot resurrect state
	// for a surface that is gone.
	if (_projectId === null) return;
	_undo = [];
	_canUndo = false;
}

/**
 * A commit carrying metamodel ops landed (`checkout.svelte.ts` fires this after
 * a successful POST /commits, having already cleared the staged moves). The
 * positions are durable now, so re-derive them from the refetched baseline —
 * which also picks up whatever the same batch's peers committed. Registered at
 * module scope through the stage module's listener seam, never a direct import
 * from checkout (see metamodel-stage's docstring on the cycle).
 */
onMetamodelCommitted(({ rebound }) => {
	if (_projectId === null) return;
	// Same reasoning as onMetamodelRebound: the rebind moved the baseline.
	if (rebound) {
		_undo = [];
		_canUndo = false;
	}
	void refetchBaselineLayout();
});
