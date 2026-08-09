import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import * as bundleApi from '$lib/api/artifact-bundle';
import * as fileSave from '$lib/util/fileSave';
import {
	loadArtifacts,
	openExportArtifacts,
	resetArtifacts,
	setExportArtifactsOpen
} from '$lib/state';
import ExportArtifactsDialog from '../ExportArtifactsDialog.svelte';

const HEADERS = [
	{
		id: 'n1',
		kind: 'navigation',
		name: 'Bus routes',
		artifact_rev: 1,
		updated_at: '',
		updated_by: null,
		entry_points: null
	},
	{
		id: 't1',
		kind: 'table',
		name: 'Fleet table',
		artifact_rev: 1,
		updated_at: '',
		updated_by: null,
		entry_points: null
	},
	{
		id: 's1',
		kind: 'code_snippet',
		name: 'helpers',
		artifact_rev: 1,
		updated_at: '',
		updated_by: null,
		entry_points: null
	}
];

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(async () => {
	vi.useFakeTimers();
	resetArtifacts();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: HEADERS });
	await loadArtifacts();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	setExportArtifactsOpen(false);
	host.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function open(seed: string[] = []) {
	app = mount(ExportArtifactsDialog, { target: host });
	openExportArtifacts(seed);
	flushSync();
}

function rowCheckbox(id: string): HTMLInputElement {
	const el = document.body.querySelector<HTMLInputElement>(
		`[data-testid="export-row-${id}"] input`
	);
	if (!el) throw new Error(`row ${id} not rendered`);
	return el;
}

describe('ExportArtifactsDialog', () => {
	it('debounces one preview per selection settle and badges dependencies', async () => {
		const preview = vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({
			artifacts: [
				{ id: 'n1', kind: 'navigation', name: 'Bus routes' },
				{ id: 's1', kind: 'code_snippet', name: 'helpers' }
			],
			dangling_refs: ['ghost']
		});
		open();
		rowCheckbox('n1').click();
		flushSync();
		expect(preview).not.toHaveBeenCalled(); // debounced
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		expect(preview).toHaveBeenCalledTimes(1);
		expect(preview).toHaveBeenCalledWith(['n1']);
		// s1 is in the closure but unchecked -> dependency badge
		expect(document.body.querySelector('[data-testid="export-row-s1"]')?.textContent).toContain(
			'dependency'
		);
		expect(document.body.textContent).toContain('1 dangling');
	});

	it('seeded open pre-checks and previews immediately', async () => {
		const preview = vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({
			artifacts: [{ id: 't1', kind: 'table', name: 'Fleet table' }],
			dangling_refs: []
		});
		open(['t1', 'not-a-real-id']);
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(rowCheckbox('t1').checked).toBe(true);
		expect(preview).toHaveBeenCalledWith(['t1']); // unknown id dropped
	});

	it('filter narrows rows but selection persists and is reported', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open(['n1']);
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		const filter = document.body.querySelector<HTMLInputElement>('[data-testid="export-filter"]')!;
		filter.value = 'fleet';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(document.body.querySelector('[data-testid="export-row-n1"]')).toBeNull();
		expect(document.body.querySelector('[data-testid="export-row-t1"]')).not.toBeNull();
		expect(document.body.textContent).toContain('+1 selected not shown');
	});

	it('exports checked roots and closes; empty selection disables the button', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		const resp = new Response('{}');
		const exp = vi.spyOn(bundleApi, 'exportBundle').mockResolvedValue(resp);
		const save = vi
			.spyOn(fileSave, 'saveResponseToFile')
			.mockResolvedValue({ filename: 'artifacts.bundle.json', handle: null });
		open();
		const btn = document.body.querySelector<HTMLButtonElement>('[data-testid="export-submit"]')!;
		expect(btn.disabled).toBe(true);
		rowCheckbox('n1').click();
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		expect(btn.disabled).toBe(false);
		btn.click();
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(exp).toHaveBeenCalledWith(['n1']);
		expect(save).toHaveBeenCalledWith(resp, 'artifacts.bundle.json');
	});
});
