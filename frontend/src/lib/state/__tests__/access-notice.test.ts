import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/errors';
import {
	clearAccessNotice,
	getAccessNotice,
	reactToBootError,
	setAccessNotice
} from '../access-notice.svelte';

afterEach(() => clearAccessNotice());

describe('access-notice store', () => {
	it('set/get/clear round-trips a message', () => {
		expect(getAccessNotice()).toBeNull();
		setAccessNotice('hello');
		expect(getAccessNotice()).toBe('hello');
		clearAccessNotice();
		expect(getAccessNotice()).toBeNull();
	});
});

describe('reactToBootError', () => {
	it('on a 403 sets the not-a-member notice, navigates to /projects, and reports a bounce', () => {
		const setNotice = vi.fn();
		const navigate = vi.fn();
		const bounced = reactToBootError(new ApiError(403, null, 'forbidden'), { setNotice, navigate });
		expect(bounced).toBe(true);
		expect(setNotice).toHaveBeenCalledTimes(1);
		expect(setNotice.mock.calls[0][0]).toMatch(/not a member/i);
		expect(navigate).toHaveBeenCalledTimes(1);
	});

	it('on a 404 (empty-but-mine project) does NOT bounce', () => {
		const setNotice = vi.fn();
		const navigate = vi.fn();
		const bounced = reactToBootError(new ApiError(404, null, 'No metamodel loaded'), {
			setNotice,
			navigate
		});
		expect(bounced).toBe(false);
		expect(setNotice).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it('on any other error does NOT bounce', () => {
		const setNotice = vi.fn();
		const navigate = vi.fn();
		expect(reactToBootError(new Error('network'), { setNotice, navigate })).toBe(false);
		expect(setNotice).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});
});
