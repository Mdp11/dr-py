import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';

import type { NavPropertyStep } from '$lib/api/types';
import type { PropertyItem } from '$lib/search/property-ops';
import PropertyStepRow from '../PropertyStepRow.svelte';

afterEach(() => {
	document.body.innerHTML = '';
});

const ITEMS: PropertyItem[] = [
	{ name: 'owner', datatype: 'Person' },
	{ name: 'label', datatype: 'string' }
];

function render(props: {
	step: NavPropertyStep;
	index: number;
	column: number;
	items: PropertyItem[];
	deadEnd: boolean;
	onChange: (index: number, next: NavPropertyStep) => void;
	onRemove: (index: number) => void;
}) {
	const c = mount(PropertyStepRow, { target: document.body, props });
	flushSync();
	return c;
}

it('renders the sentence text and a ChainBadge with the given column', () => {
	const step: NavPropertyStep = { kind: 'property', property_name: '' };
	const c = render({
		step,
		index: 0,
		column: 2,
		items: ITEMS,
		deadEnd: false,
		onChange: vi.fn(),
		onRemove: vi.fn()
	});
	try {
		expect(document.body.textContent).toContain('Go to property');
		const badge = document.querySelector('[data-testid="chain-badge"]');
		expect(badge?.textContent?.trim()).toBe('2');
	} finally {
		unmount(c);
	}
});

it('picking a property from the autocompletion calls onChange with the picked name', () => {
	const step: NavPropertyStep = { kind: 'property', property_name: '' };
	const onChange = vi.fn();
	const c = render({
		step,
		index: 3,
		column: 1,
		items: ITEMS,
		deadEnd: false,
		onChange,
		onRemove: vi.fn()
	});
	try {
		const row = document.querySelector('[data-testid="property-step"]')!;
		const trigger = [...row.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('property…')
		);
		if (!trigger) throw new Error('property picker trigger not found');
		(trigger as HTMLButtonElement).click();
		flushSync();
		const item = [...document.querySelectorAll('ul li button')].find((b) =>
			b.textContent?.includes('owner')
		);
		if (!item) throw new Error('"owner" item not found in popover');
		(item as HTMLButtonElement).click();
		flushSync();
		expect(onChange).toHaveBeenCalledWith(3, { ...step, property_name: 'owner' });
	} finally {
		unmount(c);
	}
});

it('deadEnd: true renders the dead-end notice; false does not', () => {
	const step: NavPropertyStep = { kind: 'property', property_name: 'label' };
	const cTrue = render({
		step,
		index: 0,
		column: 1,
		items: ITEMS,
		deadEnd: true,
		onChange: vi.fn(),
		onRemove: vi.fn()
	});
	try {
		expect(document.body.textContent).toContain('not an element property — navigation ends here');
	} finally {
		unmount(cTrue);
	}
	document.body.innerHTML = '';
	const cFalse = render({
		step,
		index: 0,
		column: 1,
		items: ITEMS,
		deadEnd: false,
		onChange: vi.fn(),
		onRemove: vi.fn()
	});
	try {
		expect(document.body.textContent).not.toContain('navigation ends here');
	} finally {
		unmount(cFalse);
	}
});

it('the ✕ button calls onRemove(index)', () => {
	const step: NavPropertyStep = { kind: 'property', property_name: 'owner' };
	const onRemove = vi.fn();
	const c = render({
		step,
		index: 5,
		column: 1,
		items: ITEMS,
		deadEnd: false,
		onChange: vi.fn(),
		onRemove
	});
	try {
		const removeBtn = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === '✕'
		);
		if (!removeBtn) throw new Error('✕ button not found');
		(removeBtn as HTMLButtonElement).click();
		flushSync();
		expect(onRemove).toHaveBeenCalledWith(5);
	} finally {
		unmount(c);
	}
});
