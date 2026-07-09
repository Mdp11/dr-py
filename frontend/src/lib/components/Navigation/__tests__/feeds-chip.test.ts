import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChainColumn } from '$lib/navigation/tree';
import FeedsChip from '../FeedsChip.svelte';

const COLUMNS: ChainColumn[] = [
	{ index: 0, label: 'Start', sub: 'SoftwareSystem' },
	{ index: 1, label: 'SystemContainsComponent', sub: 'Component' },
	{ index: 2, label: 'DependsOn' }
];

function render(props: {
	columns: ChainColumn[];
	value: number | null;
	onPick: (v: number | null) => void;
}) {
	const c = mount(FeedsChip, { target: document.body, props });
	flushSync();
	return c;
}
function chip(): HTMLButtonElement {
	const b = document.querySelector('[data-testid="feeds-chip"]');
	if (!b) throw new Error('feeds chip not found');
	return b as HTMLButtonElement;
}
function options(): HTMLButtonElement[] {
	return [...document.querySelectorAll('[data-testid="feeds-option"]')] as HTMLButtonElement[];
}

afterEach(() => {
	document.body.innerHTML = '';
});

it('reads "last step" with the LAST column number when the value is null', () => {
	const c = render({ columns: COLUMNS, value: null, onPick: () => {} });
	try {
		expect(chip().textContent).toContain('feeds');
		expect(chip().textContent).toContain('last step');
		expect(chip().textContent).toContain('2');
	} finally {
		unmount(c);
	}
});

it('reads "the start" for value 0', () => {
	const c = render({ columns: COLUMNS, value: 0, onPick: () => {} });
	try {
		expect(chip().textContent).toContain('the start');
	} finally {
		unmount(c);
	}
});

it('reads "after <relationship>" for an intermediate column', () => {
	const c = render({ columns: COLUMNS, value: 1, onPick: () => {} });
	try {
		expect(chip().textContent).toContain('after SystemContainsComponent');
	} finally {
		unmount(c);
	}
});

it('offers one option per column and writes null for the last step', () => {
	const onPick = vi.fn();
	const c = render({ columns: COLUMNS, value: null, onPick });
	try {
		chip().click();
		flushSync();
		const opts = options();
		expect(opts).toHaveLength(3);
		expect(document.body.textContent).toContain(
			'Feed the combination with the elements reached at…'
		);
		expect(opts[0].textContent).toContain('the start');
		expect(opts[0].textContent).toContain('SoftwareSystem');
		expect(opts[2].textContent).toContain('the last step');
		expect(opts[2].textContent).toContain('default');
		opts[2].click();
		flushSync();
		expect(onPick).toHaveBeenCalledWith(null);
	} finally {
		unmount(c);
	}
});

it('writes 0 for the start and k for column k', () => {
	const onPick = vi.fn();
	const c = render({ columns: COLUMNS, value: null, onPick });
	try {
		chip().click();
		flushSync();
		options()[0].click();
		flushSync();
		expect(onPick).toHaveBeenCalledWith(0);
		chip().click();
		flushSync();
		options()[1].click();
		flushSync();
		expect(onPick).toHaveBeenCalledWith(1);
	} finally {
		unmount(c);
	}
});

it('a single-column node offers only the last-step default', () => {
	const c = render({ columns: [{ index: 0, label: 'Start' }], value: null, onPick: () => {} });
	try {
		chip().click();
		flushSync();
		expect(options()).toHaveLength(1);
		expect(options()[0].textContent).toContain('the last step');
	} finally {
		unmount(c);
	}
});
