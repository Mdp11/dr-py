import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import {
	getExportArtifactsOpen,
	getExportArtifactsSeed,
	openArtifactTab,
	resetWorkspaceTabs,
	setExportArtifactsOpen
} from '$lib/state';
import ArtifactExportButton from '../ArtifactExportButton.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetWorkspaceTabs();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	setExportArtifactsOpen(false);
	resetWorkspaceTabs();
	host.remove();
	vi.restoreAllMocks();
});

describe('ArtifactExportButton', () => {
	it('renders for a committed artifact and seeds the export dialog', () => {
		const tabId = openArtifactTab('table', { artifactId: 'art-1', title: 'T' });
		app = mount(ArtifactExportButton, { target: host, props: { tabId } });
		flushSync();
		const button = host.querySelector<HTMLButtonElement>('[data-testid="tab-export"]');
		expect(button).not.toBeNull();
		button!.click();
		flushSync();
		expect(getExportArtifactsOpen()).toBe(true);
		expect(getExportArtifactsSeed()).toEqual(['art-1']);
	});

	it('renders nothing for a draft tab', () => {
		const tabId = openArtifactTab('table', { artifactId: null, title: 'draft' });
		app = mount(ArtifactExportButton, { target: host, props: { tabId } });
		flushSync();
		expect(host.querySelector('[data-testid="tab-export"]')).toBeNull();
	});

	// Distinct from the draft (`artifactId === null`) case above: a tab bound
	// to a not-yet-committed `create_artifact` op has a non-null but TEMP
	// artifactId — the export dialog intersects with COMMITTED headers, so
	// this staged-only artifact has nothing to export either.
	it('renders nothing for a temp-id staged-create tab', () => {
		const tabId = openArtifactTab('table', { artifactId: 'tmp_abc12345678', title: 'Staged' });
		app = mount(ArtifactExportButton, { target: host, props: { tabId } });
		flushSync();
		expect(host.querySelector('[data-testid="tab-export"]')).toBeNull();
	});
});
