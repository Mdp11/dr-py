import { describe, it, expect } from 'vitest';
import { isEditableTarget, matchShortcut, shortcutWorksInInputs } from '../keyboard';

function fakeKey(opts: {
	key: string;
	meta?: boolean;
	ctrl?: boolean;
	alt?: boolean;
}): KeyboardEvent {
	return new KeyboardEvent('keydown', {
		key: opts.key,
		metaKey: opts.meta ?? false,
		ctrlKey: opts.ctrl ?? false,
		altKey: opts.alt ?? false
	});
}

describe('matchShortcut', () => {
	it('returns null for plain key with no modifier', () => {
		expect(matchShortcut(fakeKey({ key: 's' }))).toBeNull();
	});

	it('matches Cmd+S to save', () => {
		expect(matchShortcut(fakeKey({ key: 's', meta: true }))).toEqual({ kind: 'save' });
	});

	it('matches Ctrl+S to save', () => {
		expect(matchShortcut(fakeKey({ key: 's', ctrl: true }))).toEqual({ kind: 'save' });
	});

	it('matches Cmd+E to validate', () => {
		expect(matchShortcut(fakeKey({ key: 'e', meta: true }))).toEqual({ kind: 'validate' });
	});

	it('ignores alt-modified keys', () => {
		expect(matchShortcut(fakeKey({ key: 's', meta: true, alt: true }))).toBeNull();
	});

	it('is case insensitive', () => {
		expect(matchShortcut(fakeKey({ key: 'S', meta: true }))).toEqual({ kind: 'save' });
	});

	it('does not match the removed shortcuts', () => {
		for (const key of ['k', '1', '2', '3']) {
			expect(matchShortcut(new KeyboardEvent('keydown', { key, metaKey: true }))).toBeNull();
		}
	});
});

describe('shortcutWorksInInputs', () => {
	it('returns true for save', () => {
		expect(shortcutWorksInInputs({ kind: 'save' })).toBe(true);
	});

	it('returns false for validate', () => {
		expect(shortcutWorksInInputs({ kind: 'validate' })).toBe(false);
	});
});

describe('isEditableTarget', () => {
	it('returns false for null', () => {
		expect(isEditableTarget(null)).toBe(false);
	});

	it('returns true for input', () => {
		const el = document.createElement('input');
		expect(isEditableTarget(el)).toBe(true);
	});

	it('returns true for textarea', () => {
		const el = document.createElement('textarea');
		expect(isEditableTarget(el)).toBe(true);
	});

	it('returns true for select', () => {
		const el = document.createElement('select');
		expect(isEditableTarget(el)).toBe(true);
	});

	it('returns true for contenteditable', () => {
		const el = document.createElement('div');
		el.contentEditable = 'true';
		expect(isEditableTarget(el)).toBe(true);
	});

	it('returns false for a button', () => {
		const el = document.createElement('button');
		expect(isEditableTarget(el)).toBe(false);
	});
});
