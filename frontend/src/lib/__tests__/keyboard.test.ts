import { describe, it, expect } from 'vitest';
import {
	isEditableTarget,
	matchShortcut,
	shortcutWorksInInputs
} from '../keyboard';

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
		expect(matchShortcut(fakeKey({ key: 'k' }))).toBeNull();
	});

	it('matches Cmd+K to palette', () => {
		expect(matchShortcut(fakeKey({ key: 'k', meta: true }))).toEqual({ kind: 'palette' });
	});

	it('matches Ctrl+K to palette', () => {
		expect(matchShortcut(fakeKey({ key: 'k', ctrl: true }))).toEqual({ kind: 'palette' });
	});

	it('matches Cmd+S to save', () => {
		expect(matchShortcut(fakeKey({ key: 's', meta: true }))).toEqual({ kind: 'save' });
	});

	it('matches Cmd+E to validate', () => {
		expect(matchShortcut(fakeKey({ key: 'e', meta: true }))).toEqual({ kind: 'validate' });
	});

	it('matches Cmd+1/2/3 to tab switches', () => {
		expect(matchShortcut(fakeKey({ key: '1', meta: true }))).toEqual({ kind: 'tab', tab: 'detail' });
		expect(matchShortcut(fakeKey({ key: '2', meta: true }))).toEqual({ kind: 'tab', tab: 'graph' });
		expect(matchShortcut(fakeKey({ key: '3', meta: true }))).toEqual({ kind: 'tab', tab: 'issues' });
	});

	it('ignores alt-modified keys', () => {
		expect(matchShortcut(fakeKey({ key: 'k', meta: true, alt: true }))).toBeNull();
	});

	it('is case insensitive', () => {
		expect(matchShortcut(fakeKey({ key: 'K', meta: true }))).toEqual({ kind: 'palette' });
	});
});

describe('shortcutWorksInInputs', () => {
	it('returns true for palette and save', () => {
		expect(shortcutWorksInInputs({ kind: 'palette' })).toBe(true);
		expect(shortcutWorksInInputs({ kind: 'save' })).toBe(true);
	});

	it('returns false for validate and tab', () => {
		expect(shortcutWorksInInputs({ kind: 'validate' })).toBe(false);
		expect(shortcutWorksInInputs({ kind: 'tab', tab: 'detail' })).toBe(false);
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
