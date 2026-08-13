import ELK from 'elkjs/lib/elk.bundled.js';
import { nodeSize, type DiagramEdgeSpec, type DiagramNodeSpec } from './diagram-build';

/** One-shot layered layout for the Auto-arrange button and first-open (spec
 * §5). elkjs runs client-side; the bundled build embeds its own worker
 * (no separate worker file to serve), so `new ELK()` here is enough. */
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
	// Coordinates are rounded before hashing into `taken` so a neighbor-relative
	// placement (which can land on fractional elk-style offsets in principle,
	// and always does for the fixed +280/+60 nudge used here) still collides
	// cleanly with a prior integer-ish stored position instead of silently
	// overlapping it by a sub-pixel amount.
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
