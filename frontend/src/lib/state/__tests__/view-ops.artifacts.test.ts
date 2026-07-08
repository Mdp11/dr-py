import { describe, expect, it } from 'vitest';
import { moveArtifactInView, placeArtifactInFolder, removeArtifactFromView } from '../view-ops';
import type { View } from '$lib/api/types';

const REF = { id: 'a1', kind: 'navigation' };

function view(): View {
	return {
		name: 'v',
		folders: [
			{
				name: 'F',
				folders: [{ name: 'G', folders: [], elements: [], artifacts: [] }],
				elements: [],
				artifacts: []
			}
		]
	};
}

describe('artifact placement ops', () => {
	it('places into a nested folder without mutating the input', () => {
		const v = view();
		const next = placeArtifactInFolder(v, ['F', 'G'], REF);
		expect(next.folders[0].folders[0].artifacts).toEqual([REF]);
		expect(v.folders[0].folders[0].artifacts).toEqual([]);
	});

	it('is idempotent per folder but allows multi-folder placement', () => {
		let v = placeArtifactInFolder(view(), ['F'], REF);
		v = placeArtifactInFolder(v, ['F'], REF);
		expect(v.folders[0].artifacts).toEqual([REF]);
		v = placeArtifactInFolder(v, ['F', 'G'], REF);
		expect(v.folders[0].folders[0].artifacts).toEqual([REF]);
	});

	it('removeArtifactFromView drops every placement', () => {
		let v = placeArtifactInFolder(view(), ['F'], REF);
		v = placeArtifactInFolder(v, ['F', 'G'], REF);
		v = removeArtifactFromView(v, 'a1');
		expect(v.folders[0].artifacts).toEqual([]);
		expect(v.folders[0].folders[0].artifacts).toEqual([]);
	});
});

describe('moveArtifactInView', () => {
	it('moves an artifact from its source folder to a destination folder only', () => {
		let v = placeArtifactInFolder(view(), ['F'], REF);
		v = moveArtifactInView(v, ['F'], ['F', 'G'], REF);
		expect(v.folders[0].artifacts).toEqual([]);
		expect(v.folders[0].folders[0].artifacts).toEqual([REF]);
	});

	it('does not strip other placements of the same artifact', () => {
		let v = placeArtifactInFolder(view(), ['F'], REF);
		v = placeArtifactInFolder(v, ['F', 'G'], REF);
		// moving the top-level placement must not touch the nested one
		v = moveArtifactInView(v, ['F'], ['F', 'G'], REF);
		expect(v.folders[0].artifacts).toEqual([]);
		expect(v.folders[0].folders[0].artifacts).toEqual([REF]);
	});

	it('is a no-op when source and destination are the same folder', () => {
		const v = placeArtifactInFolder(view(), ['F'], REF);
		const next = moveArtifactInView(v, ['F'], ['F'], REF);
		expect(next.folders[0].artifacts).toEqual([REF]);
	});

	it('does not mutate the input view', () => {
		const v = placeArtifactInFolder(view(), ['F'], REF);
		moveArtifactInView(v, ['F'], ['F', 'G'], REF);
		expect(v.folders[0].artifacts).toEqual([REF]);
		expect(v.folders[0].folders[0].artifacts).toEqual([]);
	});
});
