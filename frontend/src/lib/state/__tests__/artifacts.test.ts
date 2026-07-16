import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '$lib/api/artifacts';
import * as viewApi from '$lib/api/view';
import type { TableDefinition, View } from '$lib/api/types';
import {
	createTableArtifact,
	getArtifactHeaders,
	loadArtifacts,
	removeArtifact,
	renameArtifact,
	resetArtifacts
} from '../artifacts.svelte';
import { clearViewState, getView, pushView } from '../view.svelte';

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 2,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: null
};

const TABLE_HEADER = {
	id: 't1',
	kind: 'table',
	name: 'Buildings table',
	artifact_rev: 1,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: null
};

beforeEach(() => {
	resetArtifacts();
	clearViewState();
});
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

	it('remove scrubs every placement of the artifact from the active view', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		vi.spyOn(api, 'deleteArtifact').mockResolvedValue(undefined);
		const seedView: View = {
			name: 'v',
			folders: [
				{
					name: 'F',
					folders: [
						{
							name: 'G',
							folders: [],
							elements: [],
							artifacts: [{ id: 'a1', kind: 'navigation' }]
						}
					],
					elements: [],
					artifacts: [{ id: 'a1', kind: 'navigation' }]
				}
			],
			artifacts: []
		};
		const put = vi
			.spyOn(viewApi, 'putViewSnapshot')
			.mockImplementation(async (v) => ({ view: v, warnings: [] }));
		await pushView(seedView); // seed the "current view" the same way a load would
		await removeArtifact('a1');
		expect(put).toHaveBeenCalledTimes(2); // the seed push + the scrub push
		const pushed = getView()!;
		expect(pushed.folders[0].artifacts).toEqual([]);
		expect(pushed.folders[0].folders[0].artifacts).toEqual([]);
	});

	it('remove is a no-op push when no view is loaded', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		vi.spyOn(api, 'deleteArtifact').mockResolvedValue(undefined);
		const put = vi.spyOn(viewApi, 'putViewSnapshot');
		expect(getView()).toBeNull();
		await removeArtifact('a1');
		expect(put).not.toHaveBeenCalled();
	});

	it('createTableArtifact creates a table-kind artifact and refreshes the list', async () => {
		const payload: TableDefinition = {
			schema_version: 1,
			default_cell_mode: 'collapse',
			row_source: { kind: 'scope', types: [], criteria: [] },
			columns: [
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				}
			]
		};
		const create = vi.spyOn(api, 'createArtifact').mockResolvedValue({
			id: 't1',
			kind: 'table',
			name: 'Buildings table',
			artifact_rev: 1,
			updated_at: '2026-07-05T00:00:00Z',
			updated_by: null,
			payload: payload as unknown as Record<string, unknown>
		});
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [TABLE_HEADER] });
		const created = await createTableArtifact('Buildings table', payload);
		expect(create).toHaveBeenCalledWith({
			kind: 'table',
			name: 'Buildings table',
			payload: payload as unknown as Record<string, unknown>
		});
		expect(created.id).toBe('t1');
		expect(getArtifactHeaders()).toEqual([TABLE_HEADER]);
	});

	it('getArtifactHeaders separates table headers from navigation headers by kind', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER, TABLE_HEADER] });
		await loadArtifacts();
		const navigations = getArtifactHeaders().filter((a) => a.kind === 'navigation');
		const tables = getArtifactHeaders().filter((a) => a.kind === 'table');
		expect(navigations).toEqual([HEADER]);
		expect(tables).toEqual([TABLE_HEADER]);
	});

	it('remove is a no-op push when the loaded view has no placement of the artifact', async () => {
		vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
		await loadArtifacts();
		vi.spyOn(api, 'deleteArtifact').mockResolvedValue(undefined);
		const seedView: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: [], artifacts: [] }],
			artifacts: []
		};
		vi.spyOn(viewApi, 'putViewSnapshot').mockImplementation(async (v) => ({
			view: v,
			warnings: []
		}));
		await pushView(seedView);
		const put = vi.spyOn(viewApi, 'putViewSnapshot');
		await removeArtifact('a1');
		expect(put).not.toHaveBeenCalled();
	});
});
