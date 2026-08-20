import { describe, expect, it } from 'vitest';

import { FIXTURE } from './__tests__/fixtures';
import { nodeIdFor, nodeSize, buildDiagram } from './diagram-build';
import { revealTarget } from './diagram-reveal';
import { parseDraft } from './yaml-edit';

/** FIXTURE recap (see fixtures.ts): elements NamedElement (abstract), Zone,
 * Building; enum Status; relationships Observes (abstract+mapless → BOXED but
 * edgeless), Contains (plain Zone→Building edge), Monitors (boxed,
 * Building→Zone). */
const mm = parseDraft(FIXTURE).mm!;
const NONE = new Set<string>();

const POSITIONS = {
	[nodeIdFor({ kind: 'element', name: 'Zone' })]: { x: 100, y: 200 },
	[nodeIdFor({ kind: 'element', name: 'Building' })]: { x: 500, y: 50 },
	[nodeIdFor({ kind: 'relationship', name: 'Observes' })]: { x: 900, y: 900 }
};

function sizeOf(name: string, kind: 'element' | 'relationship' | 'enum') {
	const id = nodeIdFor({ kind, name });
	const spec = buildDiagram(mm).nodes.find((n) => n.id === id)!;
	return nodeSize(spec, false);
}

describe('revealTarget', () => {
	it('centers on an element box (stored position + half its footprint)', () => {
		const t = revealTarget({ kind: 'element', name: 'Zone' }, mm, POSITIONS, NONE);
		const size = sizeOf('Zone', 'element');
		expect(t).toEqual({ kind: 'center', x: 100 + size.width / 2, y: 200 + size.height / 2 });
	});

	it('centers on an enum box, defaulting an unstored position to (0,0)', () => {
		const t = revealTarget({ kind: 'enum', name: 'Status' }, mm, POSITIONS, NONE);
		const size = sizeOf('Status', 'enum');
		expect(t).toEqual({ kind: 'center', x: size.width / 2, y: size.height / 2 });
	});

	it('fits a mapped relationship to the union of all its endpoint boxes', () => {
		const t = revealTarget({ kind: 'relationship', name: 'Contains' }, mm, POSITIONS, NONE);
		expect(t.kind).toBe('bounds');
		if (t.kind !== 'bounds') return;
		const zone = sizeOf('Zone', 'element');
		// Union of Zone (100,200) and Building (500,50) boxes.
		expect(t.rect.x).toBe(100);
		expect(t.rect.y).toBe(50);
		expect(t.rect.x + t.rect.width).toBe(500 + sizeOf('Building', 'element').width);
		expect(t.rect.y + t.rect.height).toBe(200 + zone.height);
	});

	it('a mapless-but-boxed relationship fits to its own assoc box', () => {
		const t = revealTarget({ kind: 'relationship', name: 'Observes' }, mm, POSITIONS, NONE);
		expect(t.kind).toBe('bounds');
		if (t.kind !== 'bounds') return;
		expect(t.rect.x).toBe(900);
		expect(t.rect.y).toBe(900);
	});

	it('is none for a name nothing draws', () => {
		expect(revealTarget({ kind: 'element', name: 'Ghost' }, mm, POSITIONS, NONE)).toEqual({
			kind: 'none'
		});
	});
});
