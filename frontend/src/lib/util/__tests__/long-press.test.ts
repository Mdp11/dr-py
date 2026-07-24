import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { longpress } from '../long-press';

function pointerDown(node: HTMLElement, x = 10, y = 10) {
	node.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, clientX: x, clientY: y, bubbles: true })
	);
}

describe('longpress action', () => {
	let node: HTMLButtonElement;
	let onLongPress: ReturnType<typeof vi.fn>;
	let action: ReturnType<typeof longpress>;

	beforeEach(() => {
		vi.useFakeTimers();
		node = document.createElement('button');
		document.body.appendChild(node);
		onLongPress = vi.fn();
		action = longpress(node, { onLongPress });
	});

	afterEach(() => {
		action.destroy();
		node.remove();
		vi.useRealTimers();
	});

	it('fires after 500ms hold and suppresses the following click', () => {
		const clicked = vi.fn();
		node.addEventListener('click', clicked);
		pointerDown(node);
		vi.advanceTimersByTime(500);
		expect(onLongPress).toHaveBeenCalledOnce();
		node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(clicked).not.toHaveBeenCalled();
	});

	it('a quick tap does not fire and does not suppress the click', () => {
		const clicked = vi.fn();
		node.addEventListener('click', clicked);
		pointerDown(node);
		vi.advanceTimersByTime(200);
		node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		vi.advanceTimersByTime(1000);
		node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(onLongPress).not.toHaveBeenCalled();
		expect(clicked).toHaveBeenCalledOnce();
	});

	it('moving beyond the tolerance cancels the press', () => {
		pointerDown(node, 10, 10);
		node.dispatchEvent(
			new PointerEvent('pointermove', { clientX: 30, clientY: 10, bubbles: true })
		);
		vi.advanceTimersByTime(1000);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('pointerleave cancels the press', () => {
		pointerDown(node);
		node.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
		vi.advanceTimersByTime(1000);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('contextmenu fires immediately and prevents the native menu', () => {
		const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		node.dispatchEvent(e);
		expect(onLongPress).toHaveBeenCalledOnce();
		expect(e.defaultPrevented).toBe(true);
	});

	it('non-primary buttons are ignored', () => {
		node.dispatchEvent(
			new PointerEvent('pointerdown', { button: 2, clientX: 10, clientY: 10, bubbles: true })
		);
		vi.advanceTimersByTime(1000);
		expect(onLongPress).not.toHaveBeenCalled();
	});
});
