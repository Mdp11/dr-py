import { afterEach, describe, expect, it } from 'vitest';
import { resolveDevUserId } from '../identity';

const STORAGE_KEY = 'data-rover:dev-user-id';

function setUrl(search: string): void {
	// happy-dom allows navigation via history.replaceState / location assignment.
	window.history.replaceState({}, '', `/${search}`);
}

afterEach(() => {
	window.localStorage.clear();
	setUrl('');
});

describe('resolveDevUserId', () => {
	it('defaults to default-user with no query param or stored value', () => {
		expect(resolveDevUserId()).toBe('default-user');
	});

	it('uses ?user= and persists it to localStorage', () => {
		setUrl('?user=alice');
		expect(resolveDevUserId()).toBe('alice');
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe('alice');
	});

	it('falls back to the stored value when no query param is present', () => {
		window.localStorage.setItem(STORAGE_KEY, 'bob');
		expect(resolveDevUserId()).toBe('bob');
	});

	it('prefers the query param over a stored value and updates the store', () => {
		window.localStorage.setItem(STORAGE_KEY, 'bob');
		setUrl('?user=carol');
		expect(resolveDevUserId()).toBe('carol');
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe('carol');
	});
});
