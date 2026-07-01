import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { Element, Metamodel } from '$lib/api/types';
import { setCurrentUserId } from '$lib/api/identity';
import { setMetamodel, clearMetamodel } from '../../state/metamodel.svelte';
import { handleFeedEvent, resetRealtime } from '../../state/realtime.svelte';
import PropertyForm from '../Inspector/PropertyForm.svelte';

// Minimal metamodel: one concrete element type with a single string property so
// the form renders exactly one <input>.
const MM: Metamodel = {
	enums: {},
	elements: [
		{
			name: 'Block',
			abstract: false,
			extends: null,
			properties: [
				{
					name: 'name',
					datatype: 'string',
					multiplicity: '1',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			],
			key: null
		}
	],
	relationships: []
};

beforeEach(() => {
	resetRealtime();
	setMetamodel(MM);
	setCurrentUserId('me');
});
afterEach(() => {
	resetRealtime();
	clearMetamodel();
	setCurrentUserId('');
});

function el(id: string): Element {
	return { id, type_name: 'Block', properties: { name: 'v' }, rev: 0 };
}

function render(entity: Element) {
	const component = mount(PropertyForm, {
		target: document.body,
		props: { entity, kind: 'element' as const }
	});
	flushSync();
	return component;
}

function input(): HTMLInputElement {
	const node = document.body.querySelector('input');
	if (node === null) throw new Error('no input rendered');
	return node as HTMLInputElement;
}

// The fields sit inside a <fieldset>; `disabled` on the fieldset is what
// natively bars all descendant controls from interaction. (An <input>'s own
// `.disabled` property does NOT reflect an ancestor fieldset's disabled state,
// so we assert on the fieldset — the mechanism the browser actually enforces.)
function fieldset(): HTMLFieldSetElement {
	const node = document.body.querySelector('fieldset');
	if (node === null) throw new Error('no fieldset rendered');
	return node as HTMLFieldSetElement;
}

function lockedByPeer(resourceId: string, email?: string) {
	handleFeedEvent({
		type: 'lock',
		action: 'acquired',
		leases: [{ resource_id: resourceId, mode: 'exclusive', holder_id: 'peer', holder_email: email }]
	});
}

it('leaves the property input editable when the element is unlocked', () => {
	const c = render(el('e1'));
	try {
		expect(input()).not.toBeNull();
		expect(fieldset().disabled).toBe(false);
		expect(document.body.querySelector('[data-testid="readonly-notice"]')).toBeNull();
	} finally {
		unmount(c);
	}
});

it('disables the property fields and shows a notice when a peer holds the lock', () => {
	lockedByPeer('e1', 'peer@x.io');
	const c = render(el('e1'));
	try {
		expect(fieldset().disabled).toBe(true);
		const notice = document.body.querySelector('[data-testid="readonly-notice"]');
		expect(notice?.textContent).toContain('peer@x.io');
	} finally {
		unmount(c);
	}
});

it('does not gate editing when the lock is mine', () => {
	handleFeedEvent({
		type: 'lock',
		action: 'acquired',
		leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'me' }]
	});
	const c = render(el('e1'));
	try {
		expect(fieldset().disabled).toBe(false);
		expect(document.body.querySelector('[data-testid="readonly-notice"]')).toBeNull();
	} finally {
		unmount(c);
	}
});
