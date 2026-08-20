import { beforeEach, describe, expect, it } from 'vitest';

import {
	closeMetamodelPanel,
	getMetamodelPanel,
	initMetamodelPanel,
	setMetamodelPanelCollapsed,
	toggleMetamodelPanelSection
} from '../metamodel-panel.svelte';

beforeEach(() => {
	localStorage.clear();
	closeMetamodelPanel();
});

describe('metamodel panel preferences', () => {
	it('defaults to open panel, all sections expanded', () => {
		initMetamodelPanel('p1');
		const p = getMetamodelPanel();
		expect(p.collapsed).toBe(false);
		expect(p.sections).toEqual({ elements: false, relationships: false, enums: false });
	});

	it('persists whole-panel collapse per project', () => {
		initMetamodelPanel('p1');
		setMetamodelPanelCollapsed(true);
		closeMetamodelPanel();
		initMetamodelPanel('p1');
		expect(getMetamodelPanel().collapsed).toBe(true);
		// A different project starts from its own (default) preference.
		closeMetamodelPanel();
		initMetamodelPanel('p2');
		expect(getMetamodelPanel().collapsed).toBe(false);
	});

	it('persists per-section collapse per project', () => {
		initMetamodelPanel('p1');
		toggleMetamodelPanelSection('enums');
		expect(getMetamodelPanel().sections.enums).toBe(true);
		closeMetamodelPanel();
		initMetamodelPanel('p1');
		expect(getMetamodelPanel().sections.enums).toBe(true);
		expect(getMetamodelPanel().sections.elements).toBe(false);
		toggleMetamodelPanelSection('enums');
		expect(getMetamodelPanel().sections.enums).toBe(false);
	});

	it('close resets in-memory state without touching storage', () => {
		initMetamodelPanel('p1');
		setMetamodelPanelCollapsed(true);
		closeMetamodelPanel();
		expect(getMetamodelPanel().collapsed).toBe(false);
		initMetamodelPanel('p1');
		expect(getMetamodelPanel().collapsed).toBe(true);
	});

	it('survives a corrupt sections entry', () => {
		localStorage.setItem('ui.metamodel.panelSections.p1', 'not json');
		initMetamodelPanel('p1');
		expect(getMetamodelPanel().sections).toEqual({
			elements: false,
			relationships: false,
			enums: false
		});
	});
});
