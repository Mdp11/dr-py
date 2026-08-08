import { afterEach, describe, expect, it } from 'vitest';
import {
	clearViewDiscardNotice,
	getViewDiscardNotice,
	setViewDiscardNotice
} from '../view-discard-notice.svelte';

afterEach(() => clearViewDiscardNotice());

describe('view-discard-notice store', () => {
	it('set/get/clear round-trips a message', () => {
		expect(getViewDiscardNotice()).toBeNull();
		setViewDiscardNotice('your unsaved folder changes were discarded');
		expect(getViewDiscardNotice()).toBe('your unsaved folder changes were discarded');
		clearViewDiscardNotice();
		expect(getViewDiscardNotice()).toBeNull();
	});

	it('a second set REPLACES the message rather than queuing it', () => {
		setViewDiscardNotice('first conflict');
		setViewDiscardNotice('second conflict');
		expect(getViewDiscardNotice()).toBe('second conflict');
	});
});
