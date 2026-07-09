import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { Metamodel, NavFilterStep, NavRelationshipStep, PathNavigation } from '$lib/api/types';
import {
	ensureDraft,
	getDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	setProjectInfo,
	updateDefinition
} from '$lib/state';
import { clearMetamodel, setMetamodel } from '$lib/state/metamodel.svelte';
import { newCriterion } from '$lib/search/types';
import NavigationNode from '../NavigationNode.svelte';

// Component -> {Service, Database}: Service adds `port`, Database adds
// `engine`, both inherit Component's `label`. `DependsOn` hops
// Component -> Service so relationship-step target-type scoping has
// something concrete to narrow to. Deliberately no relationship between
// Component and Database — Database's properties are never reached via a
// hop, only via the (unfiltered) start scope.
const MM: Metamodel = {
	enums: {},
	elements: [
		{
			name: 'Component',
			abstract: false,
			extends: null,
			properties: [
				{
					name: 'label',
					datatype: 'string',
					multiplicity: '1',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			],
			key: null
		},
		{
			name: 'Service',
			abstract: false,
			extends: 'Component',
			properties: [
				{
					name: 'port',
					datatype: 'int',
					multiplicity: '0..1',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			],
			key: null
		},
		{
			name: 'Database',
			abstract: false,
			extends: 'Component',
			properties: [
				{
					name: 'engine',
					datatype: 'string',
					multiplicity: '0..1',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			],
			key: null
		}
	],
	relationships: [
		{
			name: 'DependsOn',
			abstract: false,
			extends: null,
			containment: false,
			source: 'Component',
			target: 'Service',
			mappings: [{ source: 'Component', target: 'Service' }],
			source_multiplicity: '0..*',
			target_multiplicity: '0..*',
			properties: []
		}
	]
};

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	setMetamodel(MM);
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	clearMetamodel();
});

function render(tabId: string) {
	const component = mount(NavigationNode, { target: document.body, props: { tabId, path: [] } });
	flushSync();
	return component;
}

function buttonByText(text: string): HTMLButtonElement {
	const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
	if (!btn) throw new Error(`button "${text}" not found`);
	return btn as HTMLButtonElement;
}

/** The "+ condition" button inside the Nth rendered FilterStepRow (scoped by
 * `data-testid="filter-step"` — the Start scope's ScopeEditor also renders a
 * "+ condition" button, so an unscoped document-wide query would collide
 * with it). */
function conditionButtons(): HTMLButtonElement[] {
	return [...document.querySelectorAll('[data-testid="filter-step"]')].map((step) => {
		const btn = [...step.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === '+ condition'
		);
		if (!btn) throw new Error('"+ condition" button not found in filter step');
		return btn as HTMLButtonElement;
	});
}

/** Clicks the Nth filter step's property-picker trigger (scoped the same way
 * as `conditionButtons`) to open its popover, then reads the offered item
 * names from the rendered list. */
function openPropertyPickerItems(nth = 0): string[] {
	const steps = [...document.querySelectorAll('[data-testid="filter-step"]')];
	const step = steps[nth];
	if (!step) throw new Error(`filter step #${nth} not found`);
	const btn = [...step.querySelectorAll('button')].find((b) =>
		b.textContent?.includes('property…')
	);
	if (!btn) throw new Error(`property picker trigger not found in filter step #${nth}`);
	(btn as HTMLButtonElement).click();
	flushSync();
	return [...document.querySelectorAll('ul li')]
		.map((li) => li.textContent?.trim() ?? '')
		.filter((t) => t.length > 0);
}

async function seed(tabId: string, definition: PathNavigation) {
	await ensureDraft(tabId);
	updateDefinition(tabId, definition);
	flushSync();
}

function emptyStart(types: string[] = []): PathNavigation {
	return {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types, criteria: [] },
		steps: [],
		exclude_visited: true
	};
}

it('add relationship step appends a relationship item', async () => {
	const tabId = 'nav:draft:add-rel-step';
	await seed(tabId, emptyStart());
	const c = render(tabId);
	try {
		buttonByText('+ Follow a relationship').click();
		flushSync();
		const steps = (getDraft(tabId)?.definition as PathNavigation).steps;
		expect(steps.at(-1)?.kind).toBe('relationship');
	} finally {
		unmount(c);
	}
});

it('add filter step appends a filter item', async () => {
	const tabId = 'nav:draft:add-filter-step';
	await seed(tabId, emptyStart());
	const c = render(tabId);
	try {
		buttonByText('+ Keep only…').click();
		flushSync();
		const steps = (getDraft(tabId)?.definition as PathNavigation).steps;
		expect(steps.at(-1)?.kind).toBe('filter');
	} finally {
		unmount(c);
	}
});

it('filter property picker offers the union of reachable-type properties', async () => {
	const tabId = 'nav:draft:filter-union';
	const filterStep: NavFilterStep = { kind: 'filter', criteria: [] };
	await seed(tabId, { ...emptyStart(['Component']), steps: [filterStep] });
	const c = render(tabId);
	try {
		conditionButtons()[0].click();
		flushSync();
		const items = openPropertyPickerItems(0);
		// Component's own property plus BOTH subtypes' (Service, Database) —
		// the union is over every type reachable from the start scope, not
		// just one branch.
		expect(items.some((t) => t.includes('label'))).toBe(true);
		expect(items.some((t) => t.includes('port'))).toBe(true);
		expect(items.some((t) => t.includes('engine'))).toBe(true);
	} finally {
		unmount(c);
	}
});

it('reached types come from the nearest preceding relationship step target_types', async () => {
	const tabId = 'nav:draft:reached-types';
	const relStep: NavRelationshipStep = {
		kind: 'relationship',
		relationship_type: 'DependsOn',
		direction: 'out',
		target_types: ['Service'],
		children: []
	};
	const filterStep: NavFilterStep = { kind: 'filter', criteria: [] };
	await seed(tabId, { ...emptyStart(['Component']), steps: [relStep, filterStep] });
	const c = render(tabId);
	try {
		// Only the filter step (the second one) renders a "+ condition" button.
		conditionButtons()[0].click();
		flushSync();
		const items = openPropertyPickerItems(0);
		// Service's own `port` plus inherited `label`, but NOT Database's
		// `engine` — the frontier narrowed to Service via the preceding hop's
		// target_types, not the broader start-scope union.
		expect(items.some((t) => t.includes('port'))).toBe(true);
		expect(items.some((t) => t.includes('label'))).toBe(true);
		expect(items.some((t) => t.includes('engine'))).toBe(false);
	} finally {
		unmount(c);
	}
});

it("adding a condition uses newCriterion('property')", async () => {
	const tabId = 'nav:draft:new-criterion-shape';
	const filterStep: NavFilterStep = { kind: 'filter', criteria: [] };
	await seed(tabId, { ...emptyStart(), steps: [filterStep] });
	const c = render(tabId);
	try {
		conditionButtons()[0].click();
		flushSync();
		const steps = (getDraft(tabId)?.definition as PathNavigation).steps;
		const step = steps[0] as NavFilterStep;
		expect(step.criteria).toEqual([newCriterion('property')]);
	} finally {
		unmount(c);
	}
});
