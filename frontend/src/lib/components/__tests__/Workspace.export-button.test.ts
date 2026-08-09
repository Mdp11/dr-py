import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import * as tablesApi from '$lib/api/tables';
import {
	getExportArtifactsOpen,
	getExportArtifactsSeed,
	openArtifactTab,
	resetArtifacts,
	resetWorkspaceTabs,
	setActiveTab,
	setExportArtifactsOpen,
	setProjectInfo
} from '$lib/state';
import { resetCheckout } from '$lib/state/checkout.svelte';
import Workspace from '../Workspace.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

// Mounting Workspace with the "saved" tab active renders TableView, whose
// `ensureTableDraft` effect checks out the artifact lease, fetches the
// artifact, and evaluates the table page — all real network calls without
// these mocks (`WorkspacePage.*.test.ts` mocks a whole page boot instead;
// `table-editor.test.ts` mocks these same three calls for the same reason:
// a direct TableView mount reaches past `$lib/state` into `$lib/api/*`).
beforeEach(() => {
	resetArtifacts();
	resetWorkspaceTabs();
	resetCheckout();
	setProjectInfo({ role: 'viewer', lockTtlSeconds: 300 });
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
		id: 'art1',
		kind: 'table',
		name: 'Fleet',
		artifact_rev: 1,
		updated_at: '',
		updated_by: null,
		entry_points: null,
		payload: {
			schema_version: 1,
			default_cell_mode: 'collapse',
			row_source: { kind: 'scope', types: [], criteria: [] },
			columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '' }]
		}
	});
	vi.spyOn(checkoutApi, 'acquireLocks').mockImplementation(async (req) => {
		const token = `t_${req.targets[0].resource_id}`;
		return {
			token,
			leases: req.targets.map((t) => ({
				resource_id: t.type === 'artifact' ? `art:${t.resource_id}` : t.resource_id,
				mode: t.mode,
				holder: 'me',
				token,
				intent: req.intent,
				expires_at: 1
			}))
		};
	});
	vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue({
		columns: [],
		rows: [],
		total: 0,
		truncated: false,
		offset: 0,
		model_rev: 1,
		warnings: []
	});
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Workspace, { target: host });
	flushSync();
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	setExportArtifactsOpen(false);
	resetWorkspaceTabs();
	host.remove();
	vi.restoreAllMocks();
});

describe('workspace tab export button', () => {
	it('is absent on static tabs and drafts, present on a saved-artifact tab', () => {
		expect(host.querySelector('[data-testid="tab-export"]')).toBeNull();
		const draft = openArtifactTab('table', { artifactId: null, title: 'New table' });
		setActiveTab(draft);
		flushSync();
		expect(host.querySelector('[data-testid="tab-export"]')).toBeNull();
		const saved = openArtifactTab('table', { artifactId: 'art1', title: 'Fleet' });
		setActiveTab(saved);
		flushSync();
		expect(host.querySelector('[data-testid="tab-export"]')).not.toBeNull();
	});

	// The behavior statement also excludes temp-id staged creates (a tab
	// bound to a not-yet-committed `create_artifact` op) — not covered by the
	// brief's given test above, added here since it is a distinct no-button
	// case from the draft (`artifactId === null`) one.
	it('is absent on a temp-id staged-create tab', () => {
		const staged = openArtifactTab('table', { artifactId: 'tmp_abc12345678', title: 'Staged' });
		setActiveTab(staged);
		flushSync();
		expect(host.querySelector('[data-testid="tab-export"]')).toBeNull();
	});

	it('opens the export dialog seeded with the tab artifact', () => {
		const saved = openArtifactTab('table', { artifactId: 'art1', title: 'Fleet' });
		setActiveTab(saved);
		flushSync();
		host.querySelector<HTMLButtonElement>('[data-testid="tab-export"]')!.click();
		flushSync();
		expect(getExportArtifactsOpen()).toBe(true);
		expect(getExportArtifactsSeed()).toEqual(['art1']);
	});
});
