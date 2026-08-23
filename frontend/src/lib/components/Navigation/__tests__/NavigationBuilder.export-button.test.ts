// The per-artifact export button must render for a VIEWER too: bundle export
// is a viewer-allowed read-only POST, and visibility is exactly one rule
// ("non-null, not a temp id" — nothing about role). This pins that
// `ArtifactExportButton` sits OUTSIDE NavigationBuilder's `{#if editable}`
// group so a future edit can't silently nest it back inside that gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import {
	ensureDraft,
	openNavigationTab,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	resetWorkspaceTabs,
	setProjectInfo
} from '$lib/state';
import NavigationBuilder from '../NavigationBuilder.svelte';

function render(tabId: string) {
	const c = mount(NavigationBuilder, { target: document.body, props: { tabId } });
	flushSync();
	return c;
}

beforeEach(() => {
	resetNavigationEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetCheckout();
	vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
		id: 'nav-1',
		kind: 'navigation',
		name: 'Fleet path',
		artifact_rev: 1,
		updated_at: '',
		updated_by: null,
		entry_points: null,
		// A pristine empty scope + no steps is NOT runnable (`isRunnable`),
		// so `ensureDraft` skips its `runPreview` call and this mount needs
		// no `/artifacts/{id}/run`-shaped mock too.
		payload: {
			kind: 'path',
			schema_version: 2,
			start: { kind: 'scope', types: [], criteria: [] },
			steps: [],
			exclude_visited: true
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
});

afterEach(() => {
	resetNavigationEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('NavigationBuilder export button', () => {
	it('renders for a viewer on a committed artifact tab (not gated behind editable)', async () => {
		setProjectInfo({ role: 'viewer', lockTtlSeconds: 300 });
		const tabId = openNavigationTab({ artifactId: 'nav-1', title: 'Fleet path' });
		await ensureDraft(tabId);

		const c = render(tabId);
		try {
			expect(document.querySelector('[data-testid="tab-export"]')).not.toBeNull();
			// The negative control on the same render: the toolbar's Save-as…
			// button IS editor-only (`{#if editable}`), so its absence for a
			// viewer proves this mount really exercised the read-only path
			// rather than one that happens to render everything regardless
			// of role.
			const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
			expect(labels).not.toContain('Save as…');
		} finally {
			unmount(c);
		}
	});

	it('still renders for an editor on a committed artifact tab', async () => {
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		const tabId = openNavigationTab({ artifactId: 'nav-1', title: 'Fleet path' });
		await ensureDraft(tabId);

		const c = render(tabId);
		try {
			expect(document.querySelector('[data-testid="tab-export"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});
});
