import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentUserId, setCurrentUserId } from '../identity';

afterEach(() => {
	// Reset to empty between tests so state doesn't bleed across.
	setCurrentUserId('');
});

describe('getCurrentUserId / setCurrentUserId', () => {
	it('returns empty string before any user is set', () => {
		expect(getCurrentUserId()).toBe('');
	});

	it('returns the value set by setCurrentUserId', () => {
		setCurrentUserId('alice');
		expect(getCurrentUserId()).toBe('alice');
	});

	it('can be updated to a new id', () => {
		setCurrentUserId('alice');
		setCurrentUserId('bob');
		expect(getCurrentUserId()).toBe('bob');
	});
});
