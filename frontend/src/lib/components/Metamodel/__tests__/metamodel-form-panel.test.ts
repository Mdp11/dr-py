import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as mmApi from '$lib/api/metamodel';
import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import type { DiagramSelection } from '$lib/metamodel/diagram-build';
import { setActiveProject } from '../../../state/active-project.svelte';
import { resetCheckout, setProjectInfo } from '../../../state/checkout.svelte';
import { selectDiagramNode } from '../../../state/metamodel-diagram.svelte';
import { initMetamodelEditor, resetMetamodelEditor } from '../../../state/metamodel-editor.svelte';
import { closeMetamodelPanel, initMetamodelPanel } from '../../../state/metamodel-panel.svelte';
import MetamodelFormPanelHost from './MetamodelFormPanelHost.svelte';

beforeEach(async () => {
	localStorage.clear();
	resetCheckout();
	resetMetamodelEditor();
	closeMetamodelPanel();
	setActiveProject('p1');
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
	selectDiagramNode(null);
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: FIXTURE, source: 'stored' });
	vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });
	await initMetamodelEditor('p1');
	initMetamodelPanel('p1');
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

function sectionHeader(key: string): HTMLElement {
	const el = document.querySelector(`[data-testid="mm-section-${key}"]`);
	if (!(el instanceof HTMLElement)) throw new Error(`section ${key} not rendered`);
	return el;
}

describe('MetamodelFormPanel overview TOC', () => {
	it('renders the three sections with counts and rows for every kind', () => {
		const c = mount(MetamodelFormPanelHost, { target: document.body, props: {} });
		flushSync();
		try {
			const text = document.body.textContent ?? '';
			// FIXTURE: 3 element types, 3 relationship types, 1 enum.
			expect(sectionHeader('elements').textContent).toContain('3');
			expect(sectionHeader('relationships').textContent).toContain('3');
			expect(sectionHeader('enums').textContent).toContain('1');
			// Element types are LISTED now (previously absent from the overview).
			expect(text).toContain('NamedElement');
			expect(text).toContain('Building');
			// All relationships listed, mapless one badged.
			expect(text).toContain('Contains');
			expect(text).toContain('Observes');
			expect(text).toContain('no mappings');
			expect(text).toContain('Status');
		} finally {
			unmount(c);
		}
	});

	it('collapsing a section hides its rows and persists via the panel module', () => {
		const c = mount(MetamodelFormPanelHost, { target: document.body, props: {} });
		flushSync();
		try {
			expect(document.body.textContent).toContain('Building');
			sectionHeader('elements').click();
			flushSync();
			expect(document.body.textContent).not.toContain('Building');
			// The other sections are untouched.
			expect(document.body.textContent).toContain('Contains');
		} finally {
			unmount(c);
		}
	});

	it('clicking a row calls the reveal seam with that selection', () => {
		const picked: DiagramSelection[] = [];
		const c = mount(MetamodelFormPanelHost, {
			target: document.body,
			props: { onReveal: (sel: DiagramSelection) => picked.push(sel) }
		});
		flushSync();
		try {
			const row = [...document.querySelectorAll('button')].find(
				(b) => b.textContent?.includes('Building') && b.dataset.testid === 'mm-toc-row'
			);
			expect(row).toBeDefined();
			row!.click();
			expect(picked).toEqual([{ kind: 'element', name: 'Building' }]);
		} finally {
			unmount(c);
		}
	});
});
