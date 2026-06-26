import { vi, describe, expect, it, beforeEach } from 'vitest';
vi.mock('$lib/api/client', () => ({ setActiveBaseUrl: vi.fn() }));
import { setActiveBaseUrl } from '$lib/api/client';
import { getActiveProjectId, setActiveProject, clearActiveProject } from '../active-project.svelte';

describe('active project store', () => {
	beforeEach(() => vi.clearAllMocks());

	it('stores the id and wires the base URL', () => {
		setActiveProject('proj-1');
		expect(getActiveProjectId()).toBe('proj-1');
		expect(setActiveBaseUrl).toHaveBeenCalledWith('/api/v1/projects/proj-1');
	});

	it('clears the id and nulls the base URL', () => {
		setActiveProject('proj-1');
		vi.clearAllMocks();
		clearActiveProject();
		expect(getActiveProjectId()).toBeNull();
		expect(setActiveBaseUrl).toHaveBeenCalledWith(null);
	});
});
