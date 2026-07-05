import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '$lib/api/artifacts';
import {
	getArtifactHeaders,
	loadArtifacts,
	removeArtifact,
	renameArtifact,
	resetArtifacts
} from '../artifacts.svelte';

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 2,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: null
};

beforeEach(() => resetArtifacts());
afterEach(() => vi.restoreAllMocks());

describe('artifacts store', () => {
	it('loads headers', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		expect(getArtifactHeaders()).toEqual([HEADER]);
	});

	it('rename uses the loaded rev and refreshes', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		const update = vi
			.spyOn(api, 'updateArtifact')
			.mockResolvedValue({ ...HEADER, name: 'N2', artifact_rev: 3, payload: {} });
		await renameArtifact('a1', 'N2');
		expect(update).toHaveBeenCalledWith('a1', { artifact_rev: 2, name: 'N2' });
		expect(getArtifactHeaders()[0].name).toBe('N2');
	});

	it('remove deletes and drops the header', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		vi.spyOn(api, 'deleteArtifact').mockResolvedValue(undefined);
		await removeArtifact('a1');
		expect(getArtifactHeaders()).toEqual([]);
	});
});
