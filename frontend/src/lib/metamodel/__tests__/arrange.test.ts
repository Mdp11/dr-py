import { describe, expect, it } from 'vitest';
import { autoArrange, placeUnpositioned } from '../arrange';
import { buildDiagram } from '../diagram-build';
import { parseDraft } from '../yaml-edit';
import { FIXTURE } from './fixtures';

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
